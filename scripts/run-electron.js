#!/usr/bin/env node
// Thin wrapper around `electron .` that adds `--no-sandbox` when the
// postinstall hook has determined the SUID helper is unusable in this
// environment (typical for containers / sandboxes without CAP_SETUID).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const noSandboxFlag = path.join(__dirname, '..', '.electron-no-sandbox');
const args = ['.'];
if (fs.existsSync(noSandboxFlag)) {
  args.push('--no-sandbox');
}

const electronBin = require('electron');
const child = spawn(electronBin, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});