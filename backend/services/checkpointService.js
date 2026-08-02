// Checkpoint Service - shadow git snapshots of a project-scoped chat's working
// directory, taken at the REQUEST and RESPONSE turn barriers. The shadow repo
// lives entirely in userdata/ (never inside the tracked project) and points
// core.worktree at the project dir, so it tracks the real files without ever
// touching the project's own .git (if any).
//
// One shadow repo per chat: userdata/checkpoints/<chatId>/.git. Chats persist
// and get revisited, so this is scoped to chat, not to a single request.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const simpleGit = require('simple-git');
const { log } = require('../utils/logger');
const { getUserdataPath } = require('../utils/pathUtils');

// Cached git-availability check. simple-git does NOT detect a missing git
// binary itself — it just rejects with a raw `spawn git ENOENT` the first
// time a command actually runs. Checking once up front means a machine
// without git gets ONE clear status instead of a silent 'error' row on every
// single turn forever. Cached for the process lifetime (git isn't going to
// appear/disappear mid-session); a restart re-checks.
let gitAvailableCache = null;

function isGitAvailable() {
    if (gitAvailableCache !== null) return gitAvailableCache;
    try {
        execSync('git --version', { stdio: ['pipe', 'pipe', 'pipe'] });
        gitAvailableCache = true;
    } catch (error) {
        gitAvailableCache = false;
        log(`[CHECKPOINT] git not found on PATH — checkpoints disabled: ${error.message}`);
    }
    return gitAvailableCache;
}

const CONFIG_FILE = 'checkpoint_config.json';
const DEFAULT_CONFIG = {
    enabled: false,
    warningAccepted: false,
    excludePatterns: [
        'node_modules/',
        '.git/',
        'dist/',
        'build/',
        '.venv/',
        '__pycache__/',
        'target/',
        '*.log'
    ]
};

function getConfigPath() {
    return getUserdataPath(CONFIG_FILE);
}

function loadConfig() {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        log('[CHECKPOINT] Config load error:', error.message);
    }
    const config = { ...DEFAULT_CONFIG };
    saveConfig(config);
    return config;
}

function saveConfig(config) {
    try {
        const configPath = getConfigPath();
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        return { success: true };
    } catch (error) {
        log('[CHECKPOINT] Config save error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Environment variables stripped before passing env to simple-git, so
 * inherited git env vars can never redirect checkpoint operations at an
 * unintended repository or execute arbitrary editors/hooks. Ported from
 * Zoo-Code's ShadowCheckpointService.
 */
const BLOCKED_ENV_KEYS_LOWER = new Set([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_TEMPLATE_DIR',
    'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND',
    'GIT_PAGER', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'PREFIX', 'EDITOR',
    'PAGER', 'SSH_ASKPASS'
].map((k) => k.toLowerCase()));

function createSanitizedGit(baseDir) {
    const sanitizedEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (BLOCKED_ENV_KEYS_LOWER.has(key.toLowerCase())) continue;
        if (value !== undefined) sanitizedEnv[key] = value;
    }

    const git = simpleGit({
        baseDir,
        config: [],
        unsafe: { allowUnsafeTemplateDir: true }
    });
    git.env(sanitizedEnv);
    return git;
}

function getShadowDir(chatId) {
    return getUserdataPath(path.join('checkpoints', chatId));
}

// Per-chat operation queue so concurrent REQUEST/RESPONSE checkpoints for the
// same chat (or an in-flight restore) never race on the same working tree.
const chatQueues = new Map(); // chatId -> Promise chain

function enqueue(chatId, fn) {
    const prev = chatQueues.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn); // run fn regardless of prior chain outcome
    // Keep the chain alive even if fn rejects, but don't let unhandled
    // rejections propagate through the map's stored promise.
    chatQueues.set(chatId, next.catch(() => {}));
    return next;
}

// Live git handles + init state per chat, so we don't re-init on every call.
const gitHandles = new Map(); // chatId -> { git, dotGitDir, worktree }

function writeExcludeFile(dotGitDir, config) {
    const infoDir = path.join(dotGitDir, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    const patterns = (config.excludePatterns || DEFAULT_CONFIG.excludePatterns).join('\n');
    fs.writeFileSync(path.join(infoDir, 'exclude'), patterns, 'utf8');
}

async function initShadowRepo(chatId, projectDir) {
    const cached = gitHandles.get(chatId);
    if (cached && cached.worktree === projectDir) {
        return cached.git;
    }

    const shadowDir = getShadowDir(chatId);
    const dotGitDir = path.join(shadowDir, '.git');
    fs.mkdirSync(shadowDir, { recursive: true });

    const git = createSanitizedGit(shadowDir);
    const config = loadConfig();

    if (fs.existsSync(dotGitDir)) {
        const worktreeCfg = (await git.getConfig('core.worktree')).value;
        const worktreeTrimmed = worktreeCfg ? worktreeCfg.trim() : '';

        if (!worktreeTrimmed) {
            throw new Error('Checkpoint shadow repo missing core.worktree config');
        }
        if (path.resolve(worktreeTrimmed) !== path.resolve(projectDir)) {
            throw new Error(
                `Checkpoint shadow repo worktree mismatch: ${worktreeTrimmed} !== ${projectDir}`
            );
        }
        writeExcludeFile(dotGitDir, config);
        log(`[CHECKPOINT] Reusing shadow repo for chat ${chatId} at ${shadowDir}`);
    } else {
        log(`[CHECKPOINT] Creating shadow repo for chat ${chatId} at ${shadowDir}`);
        await git.init({ '--template': '' });
        await git.addConfig('core.worktree', projectDir);
        await git.addConfig('commit.gpgSign', 'false');
        await git.addConfig('user.name', 'SimpleChatJS');
        await git.addConfig('user.email', 'noreply@simplechatjs.local');
        writeExcludeFile(dotGitDir, config);
        await stageAll(git);
        await git.commit('Initial checkpoint', { '--allow-empty': null });
    }

    gitHandles.set(chatId, { git, dotGitDir, worktree: projectDir });
    return git;
}

async function stageAll(git) {
    try {
        await git.add(['.', '--ignore-errors']);
    } catch (error) {
        log(`[CHECKPOINT] stageAll failed: ${error.message}`);
    }
}

// Stage everything and commit. Always stages the FULL live working tree (not
// a diff against an expected prior state) so any out-of-band edit the user
// made between checkpoints is captured automatically - no special-casing
// needed. Returns { commit } or null if there was nothing to commit.
//
// First-turn rule: if nothing changed but the shadow repo only has its
// initial commit, this is the first turn in the chat — always create an empty
// commit so the user has a restorable baseline of their project at the point
// the chat started. Checked via rev-list count (not the DB) so it's race-free on the
// serial queue.
function createCheckpoint(chatId, projectDir, message) {
    return enqueue(chatId, async () => {
        const git = await initShadowRepo(chatId, projectDir);
        await stageAll(git);
        const result = await git.commit(message);
        if (result.commit) {
            return { commit: result.commit };
        }

        // Nothing changed. Is this the first real checkpoint? If the repo
        // only has the initial commit, yes — make an empty commit so the
        // baseline is restorable.
        const count = parseInt(await git.raw(['rev-list', '--count', 'HEAD']), 10);
        if (count <= 1) {
            const empty = await git.commit(message, { '--allow-empty': null });
            return { commit: empty.commit };
        }

        return null;
    });
}

function restoreCheckpoint(chatId, projectDir, commitHash) {
    return enqueue(chatId, async () => {
        const git = await initShadowRepo(chatId, projectDir);
        await git.clean('f', ['-d', '-f']);
        await git.reset(['--hard', commitHash]);
        return { restored: commitHash };
    });
}

function getDiff(chatId, projectDir, { from, to } = {}) {
    return enqueue(chatId, async () => {
        const git = await initShadowRepo(chatId, projectDir);
        const results = [];

        let fromHash = from;
        if (!fromHash) {
            fromHash = (await git.raw(['rev-list', '--max-parents=0', 'HEAD'])).trim();
        }

        await stageAll(git);
        const { files } = to
            ? await git.diffSummary([`${fromHash}..${to}`])
            : await git.diffSummary([fromHash]);

        for (const file of files) {
            const relPath = file.file;
            const absPath = path.join(projectDir, relPath);
            const before = await git.show([`${fromHash}:${relPath}`]).catch(() => '');
            const after = to
                ? await git.show([`${to}:${relPath}`]).catch(() => '')
                : await fs.promises.readFile(absPath, 'utf8').catch(() => '');
            results.push({ paths: { relative: relPath, absolute: absPath }, content: { before, after } });
        }

        return results;
    });
}

// Orchestrates a single checkpoint: insert pending DB row immediately (so the
// UI has something to show), then run the git commit in the background and
// update the row to done/error/removed(no-op). Callers should NOT await this
// for the purpose of blocking the request/response - it's fire-and-forget by
// design, matching "async, could take time" requirement. Returns the pending
// row id synchronously via the returned promise's resolved value only for
// tests/verification; call sites should just call and ignore the promise.
async function maybeCreateCheckpoint(chatId, projectDir, { turnId, kind, message }) {
    const config = loadConfig();
    if (!config.enabled) return null;
    if (!isGitAvailable()) return null;

    const repo = require('./checkpointRepository');
    const rowId = repo.insertPending(chatId, turnId, kind);

    try {
        const result = await createCheckpoint(chatId, projectDir, message);
        if (result && result.commit) {
            repo.markDone(rowId, result.commit);
        } else {
            repo.markNoOp(rowId);
        }
        return rowId;
    } catch (error) {
        log(`[CHECKPOINT] Failed to create ${kind} checkpoint for chat ${chatId}: ${error.message}`);
        repo.markError(rowId, error.message);
        return rowId;
    }
}

function deleteChatCheckpoints(chatId) {
    gitHandles.delete(chatId);
    chatQueues.delete(chatId);
    require('./checkpointRepository').deleteForChat(chatId);
    const shadowDir = getShadowDir(chatId);
    try {
        if (fs.existsSync(shadowDir)) {
            // Windows can briefly hold a file handle open right after a git
            // process exits, causing EBUSY/EPERM on an immediate rmdir.
            // maxRetries/retryDelay (built into fs.rmSync) ride that out.
            fs.rmSync(shadowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            log(`[CHECKPOINT] Deleted shadow repo for chat ${chatId}`);
        }
    } catch (error) {
        log(`[CHECKPOINT] Failed to delete shadow repo for chat ${chatId}: ${error.message}`);
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    createCheckpoint,
    maybeCreateCheckpoint,
    restoreCheckpoint,
    getDiff,
    deleteChatCheckpoints,
    isGitAvailable
};
