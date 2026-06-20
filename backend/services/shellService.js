// Shell Service - Detect available shells and provide shell-specific execution args.
// Used by simpleToolsService for shell-aware tool execution and by the shell
// config UI for detection/display.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { log } = require('../utils/logger');

const isWindows = process.platform === 'win32';

// Priority order per platform. First found wins.
const WINDOWS_PRIORITY = ['bash', 'pwsh', 'powershell', 'cmd'];
const UNIX_PRIORITY = ['bash', 'zsh', 'sh'];

// Simple which() — checks if a binary exists in PATH (with .exe resolution on Windows).
// Returns the resolved path if found, null otherwise.
function which(binaryName) {
    try {
        if (isWindows) {
            // where returns each match on its own line.
            const out = execSync(`where ${binaryName}`, {
                encoding: 'utf8',
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            const first = out.split(/\r?\n/)[0];
            return first && fs.existsSync(first) ? first : null;
        }
        const out = execSync(`command -v ${binaryName}`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        return out && fs.existsSync(out) ? out : null;
    } catch (_) {
        return null;
    }
}

// Resolve the Git Bash binary by locating git, then probing for bash.exe
// relative to the git install root. Returns { path, name } or null.
function detectGitBash() {
    const gitPath = which('git');
    if (!gitPath) return null;

    // git typically lives at <root>/cmd/git.exe or <root>/bin/git.exe.
    // bash.exe lives at <root>/bin/bash.exe.
    const candidates = [
        path.join(path.dirname(gitPath), '..', 'bin', 'bash.exe'),
        path.join(path.dirname(gitPath), '..', '..', 'bin', 'bash.exe'),
        path.join(path.dirname(gitPath), 'bash.exe')
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return { path: candidate, name: 'bash' };
        }
    }
    return null;
}

// Build the prioritized list of all available shells on Windows.
// Returns Array<{ path: string, name: string, acceptable: boolean }>
function listShellsWindows() {
    const shells = [];

    const gitBash = detectGitBash();
    if (gitBash) shells.push({ ...gitBash, acceptable: true });

    // PowerShell 7+
    const pwsh = which('pwsh');
    if (pwsh) shells.push({ path: pwsh, name: 'pwsh', acceptable: true });

    // Windows PowerShell 5.1
    const powershell = which('powershell');
    if (powershell) shells.push({ path: powershell, name: 'powershell', acceptable: true });

    // cmd
    const comspec = process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
    if (fs.existsSync(comspec)) {
        shells.push({ path: comspec, name: 'cmd', acceptable: true });
    }

    return shells;
}

// Build the prioritized list of all available shells on Unix/macOS.
// Returns Array<{ path: string, name: string, acceptable: boolean }>
function listShellsUnix() {
    const shells = [];
    const seen = new Set();
    const add = (binPath, name) => {
        if (!binPath || seen.has(binPath)) return;
        if (!fs.existsSync(binPath)) return;
        seen.add(binPath);
        shells.push({ path: binPath, name, acceptable: true });
    };

    // $SHELL env var first
    if (process.env.SHELL) {
        const name = path.basename(process.env.SHELL);
        add(process.env.SHELL, name);
    }

    // /etc/shells
    try {
        if (fs.existsSync('/etc/shells')) {
            const lines = fs.readFileSync('/etc/shells', 'utf8').split(/\r?\n/);
            for (const line of lines) {
                const candidate = line.trim();
                if (!candidate || candidate.startsWith('#')) continue;
                add(candidate, path.basename(candidate));
            }
        }
    } catch (_) { /* ignore */ }

    // Fallbacks
    for (const name of UNIX_PRIORITY) {
        if (shells.some(s => s.name === name)) continue;
        const resolved = which(name);
        add(resolved, name);
    }

    return shells;
}

// List all detected shells (for UI display).
function listShells() {
    return isWindows ? listShellsWindows() : listShellsUnix();
}

// Get the preferred shell binary for use with SimpleTools.
// If configShell is 'auto' or undefined, uses auto-detection (first in priority).
// If configShell is a specific binary name, returns that shell (resolves path).
// Returns { path: string, name: string }
function getPreferredShell(configShell) {
    const shells = listShells();

    if (configShell && configShell !== 'auto') {
        const match = shells.find(s => s.name === configShell);
        if (match) return { path: match.path, name: match.name };
        // Configured shell not found — fall through to auto-detect and log.
        log(`[SHELL] Configured shell '${configShell}' not found, falling back to auto-detect`);
    }

    if (shells.length > 0) return { path: shells[0].path, name: shells[0].name };

    // Absolute last resort
    const fallback = isWindows
        ? { path: process.env.COMSPEC || 'cmd.exe', name: 'cmd' }
        : { path: '/bin/sh', name: 'sh' };
    return fallback;
}

// Get the default shell from settings, falling back to auto-detect if no shell is configured.
// Used at init time to populate settings.shell if it's missing.
function getDefaultShell(settings) {
    const shell = settings && settings.shell;
    if (shell && shell !== 'auto') {
        return shell;
    }
    return getPreferredShell('auto').name;
}

// Get the shell-specific args for running a command.
// Returns { shell: string, args: string[] }
function getShellArgs(shellInfo, command) {
    const name = shellInfo && shellInfo.name ? shellInfo.name : 'cmd';
    const shellPath = shellInfo && shellInfo.path ? shellInfo.path : name;

    switch (name) {
        case 'bash':
        case 'sh':
        case 'zsh':
        case 'ksh':
        case 'dash':
            return { shell: shellPath, args: ['-l', '-c', command] };
        case 'pwsh':
        case 'powershell':
            return { shell: shellPath, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
        case 'cmd':
        default:
            return { shell: shellPath, args: ['/C', command] };
    }
}

module.exports = {
    which,
    listShells,
    getPreferredShell,
    getDefaultShell,
    getShellArgs
};
