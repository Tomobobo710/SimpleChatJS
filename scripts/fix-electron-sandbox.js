#!/usr/bin/env node
// Fix Linux Chrome SUID sandbox helper after `npm install`, and decide
// whether Electron needs the `--no-sandbox` workaround in this environment.
//
// Electron aborts on launch unless node_modules/electron/dist/chrome-sandbox
// is owned by root with mode 4755. In containerized/sandboxed environments
// (no real root, no CAP_SETUID, user namespaces restricted) that state is
// unreachable, so we set a flag file that the `dev` script reads.
//
// Writes:
//   .electron-no-sandbox     -> present if --no-sandbox is required here
//   .electron-sandbox-ready  -> present if the SUID helper is correctly set
//
// Exit 0 either way — this is a best-effort postinstall hook.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const helperPath = path.join(
  projectRoot,
  'node_modules',
  'electron',
  'dist',
  'chrome-sandbox'
);
const noSandboxFlag = path.join(projectRoot, '.electron-no-sandbox');
const readyFlag = path.join(projectRoot, '.electron-sandbox-ready');

const isLinux = process.platform === 'linux' || process.platform === 'freebsd';

function clearFlags() {
  for (const f of [noSandboxFlag, readyFlag]) {
    try { fs.unlinkSync(f); } catch (_) { /* not present */ }
  }
}

if (!isLinux) {
  clearFlags();
  process.exit(0);
}

if (!fs.existsSync(helperPath)) {
  clearFlags();
  process.exit(0);
}

// --- 1. Try to make the helper usable as a real SUID binary -----------
const stat = fs.statSync(helperPath);
const mode = stat.mode & 0o7777;

let suidOk = false;

// Set SUID bit if missing (harmless if file isn't root-owned).
try { fs.chmodSync(helperPath, 0o4755); } catch (_) { /* ignore */ }

// Probe whether root ownership is actually achievable here. We do this by
// attempting `chown root:root` via the same exec mechanism npm uses; if
// CAP_SETUID is unavailable (e.g. inside a user namespace), it'll fail.
try {
  execFileSync('chown', ['root:root', helperPath], { stdio: 'ignore' });
  const after = fs.statSync(helperPath);
  if (after.uid === 0 && (after.mode & 0o4000) !== 0) {
    suidOk = true;
  }
} catch (_) {
  suidOk = false;
}

clearFlags();

if (suidOk) {
  fs.writeFileSync(readyFlag, '');
  process.exit(0);
}

// --- 2. SUID helper is not usable; signal that --no-sandbox is needed ---
fs.writeFileSync(noSandboxFlag, '');

console.log(
  '\n[fix-electron-sandbox] chrome-sandbox cannot be configured as SUID root\n' +
  'in this environment (no real root, or CAP_SETUID unavailable).\n' +
  '`npm run dev` will automatically pass --no-sandbox in this case.\n' +
  'On a normal Linux desktop this message means you need to run:\n' +
  '    sudo chown root:root ' + helperPath + '\n' +
  'and re-run `npm install`.\n'
);

process.exit(0);