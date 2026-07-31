// Background Jobs Service - shell_run's `background: true` mode, plus the
// job_list / job_output / job_kill tools that let the AI inspect and manage
// jobs it started. See web-tool-plan.md section 4/4b.
//
// A background job is a 'shell' job in the shared job registry
// (jobRegistryService.js). Its lifetime is tied to the underlying child
// process, not a timeout — the whole point of background mode is that it
// keeps running after the tool call that started it has already returned.
const { spawn } = require('child_process');
const os = require('os');
const { log } = require('../utils/logger');
const shellService = require('./shellService');
const registry = require('./jobRegistryService');

// Config lives alongside simple_tools_config.json's pattern but in its own
// file, since this is a distinct service (see web-tool-plan.md section 8:
// "split into dedicated service files").
const fs = require('fs');
const path = require('path');
const { getUserdataPath } = require('../utils/pathUtils');

const CONFIG_FILE = 'background_jobs_config.json';
const DEFAULT_CONFIG = {
    enabled: true,
    max_concurrent_jobs: 5,
    max_runtime_sec: 0, // 0 = no limit
    output_buffer_kb: 512
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
        log('[BGJOBS] Config load error:', error.message);
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
        log('[BGJOBS] Config save error:', error.message);
        return { error: error.message };
    }
}

// Live process handles keyed by job id — NOT part of the registry's public
// job shape (registry only knows type/status/meta), but this service owns
// the mapping so it can kill the right child.
const liveProcesses = new Map(); // jobId -> ChildProcess

registry.registerKillHandler('shell', (job) => {
    const child = liveProcesses.get(job.id);
    if (child) {
        try { child.kill(); } catch (_) {}
    }
    // finishJob is called from the child's own 'close' handler (started in
    // startBackgroundShell below), not here — status should reflect the
    // process actually dying, not the kill request being issued.
});

// ===== Tool definitions =====

const JOB_LIST_TPL = 'List background shell jobs for the current chat. Returns each job\'s id, status (running/exited/killed/error), the command, and exit info if finished. Use this to check on jobs you started with shell_run background:true.';
const JOB_OUTPUT_TPL = 'Fetch buffered output for a background job by id. Pass "since" (the offset returned by a previous call) to only get new output since the last check, instead of the whole buffer again. Required: job_id.';
const JOB_KILL_TPL = 'Kill a running background job by id. No-op if the job has already finished. Required: job_id.';

function getToolDefinitions(config) {
    if (!config.enabled) return [];
    return [
        {
            name: 'job_list',
            description: JOB_LIST_TPL,
            input_schema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: 'job_output',
            description: JOB_OUTPUT_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned when the background job was started' },
                    since: { type: 'integer', description: 'Optional. Only return output events after this index (from a previous job_output call).' }
                },
                required: ['job_id'],
                additionalProperties: false
            }
        },
        {
            name: 'job_kill',
            description: JOB_KILL_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id to kill' }
                },
                required: ['job_id'],
                additionalProperties: false
            }
        }
    ];
}

// ===== shell_run background:true execution =====

function startBackgroundShell({ command, chatId, cwd, shellInfo, config }) {
    const running = registry.listJobs({ chatId, type: 'shell', status: 'running' });
    const maxConcurrent = Number.isFinite(config.max_concurrent_jobs) ? config.max_concurrent_jobs : DEFAULT_CONFIG.max_concurrent_jobs;
    if (running.length >= maxConcurrent) {
        throw new Error(`Cannot start background job: ${maxConcurrent} concurrent background jobs already running for this chat (max_concurrent_jobs). Kill one first, or raise the limit in Settings > Tools.`);
    }

    const shellArgs = shellService.getShellArgs(shellInfo, command);
    const resolvedCwd = cwd || os.homedir();

    const outputBufferKb = Number.isFinite(config.output_buffer_kb) ? config.output_buffer_kb : DEFAULT_CONFIG.output_buffer_kb;
    const jobId = registry.createJob({
        type: 'shell',
        chatId,
        label: command,
        startedBy: 'ai',
        meta: { command, cwd: resolvedCwd, exit_code: null },
        eventBufferBytes: outputBufferKb * 1000
    });

    let child;
    try {
        child = spawn(shellArgs.shell, shellArgs.args, { windowsHide: true, cwd: resolvedCwd });
    } catch (error) {
        registry.finishJob(jobId, 'error', { error: error.message });
        throw error;
    }
    liveProcesses.set(jobId, child);

    const maxRuntimeSec = Number.isFinite(config.max_runtime_sec) ? config.max_runtime_sec : 0;
    let runtimeTimer = null;
    if (maxRuntimeSec > 0) {
        runtimeTimer = setTimeout(() => {
            try { child.kill(); } catch (_) {}
        }, maxRuntimeSec * 1000);
    }

    if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            registry.addJobEvent(jobId, { type: 'chunk', stream: 'stdout', text: chunk });
        });
    }
    if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            registry.addJobEvent(jobId, { type: 'chunk', stream: 'stderr', text: chunk });
        });
    }

    let spawnError = null;
    child.on('error', (err) => { spawnError = err; });

    child.on('close', (code) => {
        if (runtimeTimer) clearTimeout(runtimeTimer);
        liveProcesses.delete(jobId);
        const current = registry.getJob(jobId);
        if (!current) return; // removed from registry already, nothing to update
        if (current.killedBy) {
            registry.finishJob(jobId, 'killed', { exit_code: code });
        } else if (spawnError) {
            registry.finishJob(jobId, 'error', { error: spawnError.message, exit_code: code });
        } else {
            registry.finishJob(jobId, 'exited', { exit_code: code });
        }
    });

    log(`[BGJOBS] Started background job ${jobId}: ${command}`);
    return jobId;
}

// ===== Tool execution =====

async function executeBackgroundJobTool(toolName, args, opts = {}) {
    const config = loadConfig();
    if (!config.enabled) {
        throw new Error(`Background jobs are disabled. Enable them in Settings > Tools.`);
    }

    switch (toolName) {
        case 'job_list': {
            const jobs = registry.listJobs({ chatId: opts.chatId });
            return { success: true, jobs };
        }
        case 'job_output': {
            const jobId = args?.job_id;
            if (!jobId) throw new Error('Missing required field: job_id');
            const job = registry.getJob(jobId);
            if (!job) throw new Error(`Job not found: ${jobId}`);
            const events = registry.getJobEvents ? registry.getJobEvents(jobId) : [];
            const since = Number.isInteger(args?.since) ? args.since : 0;
            const newEvents = events.slice(since);
            return {
                success: true,
                job_id: jobId,
                status: job.status,
                events: newEvents,
                next_since: events.length
            };
        }
        case 'job_kill': {
            const jobId = args?.job_id;
            if (!jobId) throw new Error('Missing required field: job_id');
            const job = await registry.killJob(jobId, 'ai');
            return { success: true, job };
        }
        default:
            throw new Error(`Unknown background job tool: ${toolName}`);
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    getToolDefinitions,
    executeBackgroundJobTool,
    startBackgroundShell
};
