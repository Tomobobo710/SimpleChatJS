// Checkpoint routes - config, per-chat list, restore, diff.
const express = require('express');
const checkpointService = require('../services/checkpointService');
const checkpointRepository = require('../services/checkpointRepository');
const projectService = require('../services/projectService');
const { log } = require('../utils/logger');

const router = express.Router();

// Checkpoint config (enabled, excludePatterns) — Settings. gitAvailable is a
// derived read-only status (not part of the saved config) so the Settings UI
// can warn when git isn't on PATH instead of checkpoints silently failing
// every turn with no explanation.
router.get('/checkpoint-config', (req, res) => {
    res.json({
        ...checkpointService.loadConfig(),
        gitAvailable: checkpointService.isGitAvailable()
    });
});

router.post('/checkpoint-config', (req, res) => {
    const result = checkpointService.saveConfig(req.body);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// List checkpoints for a chat, newest first.
router.get('/chat/:chatId/checkpoints', (req, res) => {
    try {
        const rows = checkpointRepository.listForChat(req.params.chatId);
        res.json({ checkpoints: rows });
    } catch (err) {
        log('[CHECKPOINT-ROUTE] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Restore the project directory to a checkpoint's commit. Optional
// { branch: true } is accepted but filesystem-restore only for now — the
// caller (frontend) is responsible for starting a new message from the
// current point in the chat to produce a "branch" effect.
router.post('/chat/:chatId/checkpoints/:id/restore', async (req, res) => {
    const { chatId, id } = req.params;
    try {
        const row = checkpointRepository.getById(id);
        if (!row || row.chat_id !== chatId) {
            return res.status(404).json({ error: 'Checkpoint not found' });
        }
        if (row.status !== 'done' || !row.commit_hash) {
            return res.status(400).json({ error: 'Checkpoint is not restorable (not done, or has no commit)' });
        }

        const projectPath = projectService.getProjectPathForChat(chatId);
        if (!projectPath) {
            return res.status(400).json({ error: 'Chat is not project-scoped' });
        }

        await checkpointService.restoreCheckpoint(chatId, projectPath, row.commit_hash);
        res.json({ success: true, commit_hash: row.commit_hash });
    } catch (err) {
        log('[CHECKPOINT-ROUTE] Restore error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Diff a checkpoint against the next checkpoint (or current working tree if
// `to` is omitted). Query params: from (defaults to this checkpoint), to.
router.get('/chat/:chatId/checkpoints/:id/diff', async (req, res) => {
    const { chatId, id } = req.params;
    try {
        const row = checkpointRepository.getById(id);
        if (!row || row.chat_id !== chatId) {
            return res.status(404).json({ error: 'Checkpoint not found' });
        }
        const projectPath = projectService.getProjectPathForChat(chatId);
        if (!projectPath) {
            return res.status(400).json({ error: 'Chat is not project-scoped' });
        }

        const to = req.query.to || undefined;
        const changes = await checkpointService.getDiff(chatId, projectPath, { from: row.commit_hash, to });
        res.json({ changes });
    } catch (err) {
        log('[CHECKPOINT-ROUTE] Diff error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
