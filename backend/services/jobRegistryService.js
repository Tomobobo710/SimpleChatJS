// Job Registry Service - Shared foundation for long-running processes that
// outlive a single tool-call/response cycle (background shell jobs, browser
// tabs, and any future job type). See web-tool-plan.md for the design.
//
// A job's lifetime is tied to its owning process/window dying, NOT a TTL —
// unlike toolEventService's request-scoped event log, a job stays listed and
// inspectable until it's actually killed/exited (or the app restarts, which
// clears the whole in-memory registry). Each job type registers a kill
// handler; the registry itself is agnostic to what a job actually is.
const { log } = require('../utils/logger');

const jobs = new Map(); // jobId -> Job
const killHandlers = new Map(); // type -> (job) => Promise<void>|void

function generateJobId() {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Register how to kill a given job type. Called once per type at service
// init (e.g. backgroundJobsService registers 'shell', browserToolService
// registers 'browser_tab').
function registerKillHandler(type, handler) {
    killHandlers.set(type, handler);
}

// Default cap on bytes retained in a job's live event buffer, used when the
// caller doesn't pass one (e.g. browser_tab jobs, which have no equivalent
// setting yet). backgroundJobsService passes its configured
// output_buffer_kb for shell jobs.
const DEFAULT_EVENT_BUFFER_BYTES = 512 * 1024;

// Create a new job. meta is type-specific (e.g. { command } for shell,
// { url, title } for browser_tab). eventBufferBytes caps how much event data
// (JSON-stringified) is kept in the live buffer — oldest events are dropped
// first once exceeded. Returns the job id.
function createJob({ type, chatId, label, startedBy, meta = {}, eventBufferBytes }) {
    if (!type) throw new Error('createJob: type is required');
    if (!chatId) throw new Error('createJob: chatId is required (jobs are per-chat)');

    const id = generateJobId();
    const job = {
        id,
        type,
        chatId,
        label: label || type,
        status: 'running', // 'running' | 'exited' | 'killed' | 'error'
        startedBy: startedBy === 'user' ? 'user' : 'ai',
        killedBy: null,
        createdAt: new Date().toISOString(),
        endedAt: null,
        meta,
        events: [],
        eventBytes: 0, // running total of JSON.stringify(event).length for events currently buffered
        eventBufferBytes: Number.isFinite(eventBufferBytes) && eventBufferBytes > 0 ? eventBufferBytes : DEFAULT_EVENT_BUFFER_BYTES,
        listeners: new Set()
    };
    jobs.set(id, job);
    log(`[JOBS] Created job ${id} (type=${type}, chatId=${chatId}, startedBy=${job.startedBy})`);
    return id;
}

function toPublicJob(job) {
    // Omit internal event/listener/buffer-accounting plumbing from anything
    // handed to a tool result or an API response.
    const { events, listeners, eventBytes, eventBufferBytes, ...pub } = job;
    return pub;
}

function getJob(id) {
    const job = jobs.get(id);
    return job ? toPublicJob(job) : null;
}

// Raw buffered events for a job (e.g. for a polling tool like job_output).
// Returns [] if the job doesn't exist.
function getJobEvents(id) {
    const job = jobs.get(id);
    return job ? job.events : [];
}

// filter: { chatId?, type?, status? }. All fields optional; omitted fields
// are not filtered on.
function listJobs(filter = {}) {
    const out = [];
    for (const job of jobs.values()) {
        if (filter.chatId && job.chatId !== filter.chatId) continue;
        if (filter.type && job.type !== filter.type) continue;
        if (filter.status && job.status !== filter.status) continue;
        out.push(toPublicJob(job));
    }
    return out;
}

// Count of running jobs NOT in the given chat — feeds the "N other jobs
// running elsewhere" indicator described in web-tool-plan.md section 8.
function countRunningElsewhere(chatId) {
    let count = 0;
    for (const job of jobs.values()) {
        if (job.status === 'running' && job.chatId !== chatId) count++;
    }
    return count;
}

function updateJob(id, patch) {
    const job = jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    return toPublicJob(job);
}

// Append a chunk of output/event data to a job's live event log and push it
// to any subscribed SSE listeners. event is an arbitrary JSON-serializable
// object (e.g. { stream: 'stdout', text } for shell, { type: 'nav', url }
// for browser tabs).
//
// The buffer is capped in BYTES (job.eventBufferBytes — from
// output_buffer_kb in Settings > Tools for shell jobs), not event count: a
// chatty process emitting many tiny events shouldn't be capped the same as
// one emitting a few huge ones. Oldest events are dropped first once
// exceeded; callers relying on "since" offsets (job_output) will just see a
// gap, which is preferable to unbounded memory growth for a job that
// outlives many polls.
function addJobEvent(id, event) {
    const job = jobs.get(id);
    if (!job) return;
    const size = JSON.stringify(event).length;
    job.events.push(event);
    job.eventBytes += size;
    while (job.eventBytes > job.eventBufferBytes && job.events.length > 1) {
        const dropped = job.events.shift();
        job.eventBytes -= JSON.stringify(dropped).length;
    }
    job.listeners.forEach(listener => {
        try {
            listener.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (e) {
            job.listeners.delete(listener);
        }
    });
}

// Mark a job finished. status must be 'exited' | 'killed' | 'error'.
// Closes out any live SSE listeners so clients know to stop expecting more.
function finishJob(id, status, extra = {}) {
    const job = jobs.get(id);
    if (!job) return;
    job.status = status;
    job.endedAt = new Date().toISOString();
    Object.assign(job.meta, extra);
    addJobEvent(id, { type: 'job_finished', status, endedAt: job.endedAt });
    job.listeners.forEach(l => { try { l.end(); } catch (_) {} });
    job.listeners.clear();
    log(`[JOBS] Job ${id} finished with status=${status}`);
}

// Kill a job by id. killedBy is 'ai' | 'user' — always recorded regardless
// of who's asking, so the UI/tooling can always show who ended it.
async function killJob(id, killedBy = 'user') {
    const job = jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (job.status !== 'running') {
        return toPublicJob(job); // already finished, nothing to do
    }
    const handler = killHandlers.get(job.type);
    if (!handler) throw new Error(`No kill handler registered for job type: ${job.type}`);

    job.killedBy = killedBy;
    await handler(job);
    // Handlers are expected to call finishJob themselves once the underlying
    // process/window actually dies (e.g. on the child's 'close' event), so
    // status reflects reality rather than intent. If a handler didn't do
    // that (e.g. it was already gone), make sure we don't leave it dangling.
    const current = jobs.get(id);
    if (current && current.status === 'running') {
        finishJob(id, 'killed');
    }
    return toPublicJob(jobs.get(id));
}

// Remove a job from the registry entirely (manual "clear finished jobs" —
// user-triggered only, never automatic/TTL-based per the design doc).
function removeJob(id) {
    const job = jobs.get(id);
    if (!job) return false;
    if (job.status === 'running') {
        throw new Error(`Cannot remove a running job: ${id}`);
    }
    jobs.delete(id);
    return true;
}

// ===== SSE streaming (mirrors toolEventService.js's pattern, but scoped to
// a job's full lifetime rather than a single request) =====
function handleJobEventsStream(req, res) {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);

    if (!job) {
        res.status(404).json({ error: `Job not found: ${jobId}` });
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', data: { jobId, timestamp: new Date().toISOString() } })}\n\n`);

    // Replay everything so far, then subscribe for live updates.
    job.events.forEach(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    if (job.status === 'running') {
        job.listeners.add(res);
        req.on('close', () => {
            job.listeners.delete(res);
        });
    } else {
        // Already finished — nothing more will ever come, close immediately
        // after replay so the client doesn't hang open an EventSource forever.
        res.end();
    }
}

module.exports = {
    registerKillHandler,
    createJob,
    getJob,
    getJobEvents,
    listJobs,
    countRunningElsewhere,
    updateJob,
    addJobEvent,
    finishJob,
    killJob,
    removeJob,
    handleJobEventsStream
};
