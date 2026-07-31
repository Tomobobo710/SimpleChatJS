// Job routes - list/inspect/kill long-running jobs (background shell jobs,
// browser tabs, etc.) and stream their live output over SSE.
const express = require('express');
const {
    getJob,
    listJobs,
    countRunningElsewhere,
    killJob,
    removeJob,
    handleJobEventsStream
} = require('../services/jobRegistryService');
const { log } = require('../utils/logger');
const backgroundJobsService = require('../services/backgroundJobsService');
const browserToolService = require('../services/browserToolService');

const router = express.Router();

// Background jobs config (enabled, max_concurrent_jobs, max_runtime_sec,
// output_buffer_kb) — Settings > Tools. Same thin load/save pattern as
// /api/simple-tools/config in mcp.js.
router.get('/background-jobs/config', (req, res) => {
    res.json(backgroundJobsService.loadConfig());
});

router.post('/background-jobs/config', (req, res) => {
    const result = backgroundJobsService.saveConfig(req.body);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// Browser tool config (enabled, max_concurrent_tabs, default_cache_enabled,
// cache_control_user_locked, allow_file_protocol, allow_hard_refresh,
// background_throttling_disabled, max_console_log_lines) — Settings > Tools.
router.get('/browser-tool/config', (req, res) => {
    res.json(browserToolService.loadConfig());
});

router.post('/browser-tool/config', (req, res) => {
    const result = browserToolService.saveConfig(req.body);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// List jobs, optionally filtered. Query params: chat_id, type, status.
// Also returns other_running_count: jobs running outside chat_id, so the
// panel can show "N other jobs running elsewhere" without fetching everything.
router.get('/jobs', (req, res) => {
    const { chat_id, type, status } = req.query;
    try {
        const filter = {};
        if (chat_id) filter.chatId = chat_id;
        if (type) filter.type = type;
        if (status) filter.status = status;
        const result = listJobs(filter);
        const otherRunningCount = chat_id ? countRunningElsewhere(chat_id) : 0;
        res.json({ jobs: result, other_running_count: otherRunningCount });
    } catch (err) {
        log('[JOBS] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: `Job not found: ${req.params.jobId}` });
    res.json({ job });
});

// Kill a job. Body: { killed_by: 'ai' | 'user' } — defaults to 'user' since
// the panel is the primary caller; the AI-facing job_kill tool passes 'ai'
// explicitly.
router.post('/jobs/:jobId/kill', async (req, res) => {
    try {
        const killedBy = req.body?.killed_by === 'ai' ? 'ai' : 'user';
        const job = await killJob(req.params.jobId, killedBy);
        res.json({ success: true, job });
    } catch (err) {
        log('[JOBS] Kill error:', err);
        res.status(400).json({ error: err.message });
    }
});

// Manual clear of a finished job from the registry. Refuses to remove a
// still-running job (kill it first).
router.delete('/jobs/:jobId', (req, res) => {
    try {
        removeJob(req.params.jobId);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Live output stream for a single job (replays buffered events, then
// subscribes for more until the job finishes).
router.get('/jobs/:jobId/events', handleJobEventsStream);

// ===== browser_tab-specific panel actions =====
// User-facing (not AI tool) actions: reveal/hide a tab's window, and grab a
// thumbnail. Meaningful only for type:'browser_tab' jobs — 400s otherwise.

router.post('/jobs/:jobId/reveal', (req, res) => {
    try {
        const result = browserToolService.revealTab(req.params.jobId);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/jobs/:jobId/hide', (req, res) => {
    try {
        const result = browserToolService.hideTab(req.params.jobId);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/jobs/:jobId/thumbnail', async (req, res) => {
    try {
        const shot = await browserToolService.captureThumbnail(req.params.jobId);
        res.json({ success: true, image_base64: shot.base64, mime_type: shot.mimeType });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
