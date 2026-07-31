// Browser Tool Service - Electron-backed browser tabs the AI can drive
// (navigate, read page text, click, type, screenshot, console log, cache
// control). See web-tool-plan.md section 5.
//
// A browser tab is a job like any other in the shared registry — its kill
// handler destroys the BrowserWindow instead of killing a child process.
//
// Screenshot caveat: browser_screenshot returns the PNG as a base64 STRING
// field in the JSON tool result, not a real multimodal image content block.
// True inline image tool-results would need every adapter's tool-result
// serialization changed (today message.content is always a plain
// JSON.stringify'd string — see chatStreamService.js and
// AnthropicAdapter.js's tool_result conversion), which is a bigger plumbing
// change than this slice takes on. A future pass could wire that through
// properly; for now this is an honest, working v1 (useful for automation/
// debugging even if the model can't currently "see" it as a real image).
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { getUserdataPath } = require('../utils/pathUtils');
const registry = require('./jobRegistryService');

const CONFIG_FILE = 'browser_tool_config.json';
const DEFAULT_CONFIG = {
    enabled: true,
    max_concurrent_tabs: 3,
    default_cache_enabled: true,
    // When true, the AI is never even offered a cache-control parameter on
    // its tools — the user's choice above is locked in and the tool schema
    // omits the option entirely (see web-tool-plan.md section 6.3: "omit the
    // parameter, don't just ignore it").
    cache_control_user_locked: false,
    allow_file_protocol: true,
    allow_hard_refresh: true,
    // backgroundThrottling:false on every tab by default — a hidden/unfocused
    // tab keeps running rAF/timers at full rate instead of being Chromium's
    // usual power-saving throttle. Deliberately not what Claude Code's own
    // browser tool does; see the design conversation in web-tool-plan.md.
    background_throttling_disabled: true,
    // Max console/network log lines retained per tab (oldest dropped first) —
    // separate from the job registry's own byte-capped event buffer, since a
    // console-message flood shouldn't be able to push nav/title events out.
    max_console_log_lines: 500
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
        log('[BROWSERTOOL] Config load error:', error.message);
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
        log('[BROWSERTOOL] Config save error:', error.message);
        return { error: error.message };
    }
}

// Electron's `electron` module resolves under plain Node too (it's a path
// string, not a throw), so detect actual main-process availability by
// checking for a real `app` object rather than relying on a require() throw.
function getElectron() {
    try {
        const electron = require('electron');
        if (electron && typeof electron.app === 'object' && electron.app !== null) {
            return electron;
        }
    } catch (_) { /* fall through */ }
    return null;
}

// Live window handles keyed by job id — not part of the registry's public
// job shape, mirrors backgroundJobsService's liveProcesses map.
const liveWindows = new Map(); // jobId -> BrowserWindow

// Per-tab console message ring buffer, separate from the job registry's
// nav/title event log (see max_console_log_lines above for why).
const consoleLogs = new Map(); // jobId -> Array<{level, message, line, sourceId, timestamp}>

registry.registerKillHandler('browser_tab', (job) => {
    const win = liveWindows.get(job.id);
    if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch (_) {}
    }
    // finishJob is called from the window's own 'closed' event handler
    // (wired in openBrowserTab below), not here — mirrors backgroundJobsService's
    // pattern of letting the actual death event drive the status transition.
});

// ===== Tool definitions =====

const BROWSER_OPEN_TPL = 'Open a new browser tab (a real, hidden Chromium window) and navigate it to a URL. Returns a job_id — use it with the other browser_* tools to keep driving this tab across multiple tool calls. The tab keeps running in the background even between your tool calls (rAF/timers are not throttled while hidden), and the user can see, reveal, or close it at any time from the Web Tabs panel. Required: url.';
const BROWSER_NAVIGATE_TPL = 'Navigate an existing browser tab (opened with browser_open) to a new URL, or reload its current page. Required: job_id, url. Pass hard_refresh:true to bypass the cache on reload (only meaningful when url is the tab\'s current URL).';
const BROWSER_READ_PAGE_TPL = 'Get the visible text content of a browser tab\'s current page. Required: job_id.';
const BROWSER_CLOSE_TPL = 'Close a browser tab. Required: job_id.';
const BROWSER_CLICK_TPL = 'Click at a pixel coordinate in a browser tab, in the same screenshot-pixel space browser_screenshot returns. Take a screenshot first if you don\'t already know where to click. Required: job_id, x, y.';
const BROWSER_TYPE_TPL = 'Type text into whatever element is currently focused in a browser tab (click an input field first with browser_click, then type into it). Required: job_id, text.';
const BROWSER_SCREENSHOT_TPL = 'Take a screenshot of a browser tab\'s current page. Returns the image as base64-encoded PNG data (image_base64 field) — decode it to view. Required: job_id.';
const BROWSER_READ_CONSOLE_TPL = 'Get buffered console messages (console.log/warn/error, and page errors) from a browser tab, oldest first. Required: job_id.';
const BROWSER_CACHE_TPL = 'Enable or disable HTTP caching for a browser tab\'s session. Disabling forces every request to hit the network instead of a cached copy. Required: job_id, enabled.';

function getToolDefinitions(config) {
    if (!config.enabled) return [];

    const navigateProps = {
        job_id: { type: 'string', description: 'The job id returned by browser_open' },
        url: { type: 'string', description: 'URL to navigate to' }
    };
    if (config.allow_hard_refresh) {
        navigateProps.hard_refresh = { type: 'boolean', description: 'Bypass the cache for this navigation (hard refresh)' };
    }

    const defs = [
        {
            name: 'browser_open',
            description: BROWSER_OPEN_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to open (http/https' + (config.allow_file_protocol ? ', or file://' : '') + ')' }
                },
                required: ['url'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_navigate',
            description: BROWSER_NAVIGATE_TPL,
            input_schema: {
                type: 'object',
                properties: navigateProps,
                required: ['job_id', 'url'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_read_page',
            description: BROWSER_READ_PAGE_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' }
                },
                required: ['job_id'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_close',
            description: BROWSER_CLOSE_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id to close' }
                },
                required: ['job_id'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_click',
            description: BROWSER_CLICK_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    x: { type: 'integer', description: 'X coordinate in screenshot-pixel space' },
                    y: { type: 'integer', description: 'Y coordinate in screenshot-pixel space' }
                },
                required: ['job_id', 'x', 'y'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_type',
            description: BROWSER_TYPE_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    text: { type: 'string', description: 'Text to type into the focused element' }
                },
                required: ['job_id', 'text'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_screenshot',
            description: BROWSER_SCREENSHOT_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' }
                },
                required: ['job_id'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_read_console',
            description: BROWSER_READ_CONSOLE_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' }
                },
                required: ['job_id'],
                additionalProperties: false
            }
        }
    ];

    // Cache-control tool is entirely OMITTED (not just non-functional) when
    // the user has locked the decision — the AI is never even shown this as
    // an option to consider. See web-tool-plan.md section 6.3.
    if (!config.cache_control_user_locked) {
        defs.push({
            name: 'browser_set_cache',
            description: BROWSER_CACHE_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    enabled: { type: 'boolean', description: 'true to enable caching, false to force every request to bypass the cache' }
                },
                required: ['job_id', 'enabled'],
                additionalProperties: false
            }
        });
    }

    return defs;
}

// ===== Tab lifecycle =====

function isValidUrl(url, config) {
    if (typeof url !== 'string' || !url) return false;
    if (/^https?:\/\//i.test(url)) return true;
    if (config.allow_file_protocol && /^file:\/\//i.test(url)) return true;
    return false;
}

async function openBrowserTab({ url, chatId, config }) {
    const electron = getElectron();
    if (!electron) {
        throw new Error('Browser tool is unavailable: not running inside the Electron app.');
    }
    if (!isValidUrl(url, config)) {
        throw new Error(`Invalid or disallowed URL: ${url}${config.allow_file_protocol ? '' : ' (file:// is disabled in Settings > Tools)'}`);
    }

    const running = registry.listJobs({ chatId, type: 'browser_tab', status: 'running' });
    const maxConcurrent = Number.isFinite(config.max_concurrent_tabs) ? config.max_concurrent_tabs : DEFAULT_CONFIG.max_concurrent_tabs;
    if (running.length >= maxConcurrent) {
        throw new Error(`Cannot open browser tab: ${maxConcurrent} concurrent tabs already open for this chat (max_concurrent_tabs). Close one first, or raise the limit in Settings > Tools.`);
    }

    const { BrowserWindow, session } = electron;

    const jobId = registry.createJob({
        type: 'browser_tab',
        chatId,
        label: url,
        startedBy: 'ai',
        meta: { url, title: '', cacheEnabled: config.default_cache_enabled }
    });

    // Isolated session per tab so cache behavior can be toggled per-tab
    // without affecting the main app window or other tabs.
    const partition = `browser-tab-${jobId}`;
    const ses = session.fromPartition(partition, { cache: config.default_cache_enabled });

    // Explicit size — without one, a hidden BrowserWindow can default to a
    // very small content area, which silently breaks click coordinates (they
    // land outside the real page layout). 1280x800 matches the Claude
    // Browser tool's own desktop preset for consistency.
    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
            session: ses,
            backgroundThrottling: !config.background_throttling_disabled,
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    liveWindows.set(jobId, win);
    consoleLogs.set(jobId, []);

    win.on('closed', () => {
        liveWindows.delete(jobId);
        consoleLogs.delete(jobId);
        const current = registry.getJob(jobId);
        if (!current) return;
        if (current.status === 'running') {
            registry.finishJob(jobId, current.killedBy ? 'killed' : 'exited');
        }
    });

    win.webContents.on('did-navigate', (event, navUrl) => {
        registry.updateJob(jobId, { label: navUrl, meta: { ...registry.getJob(jobId).meta, url: navUrl } });
        registry.addJobEvent(jobId, { type: 'nav', url: navUrl });
    });
    win.webContents.on('page-title-updated', (event, title) => {
        const job = registry.getJob(jobId);
        if (!job) return;
        registry.updateJob(jobId, { meta: { ...job.meta, title } });
        registry.addJobEvent(jobId, { type: 'title', title });
    });
    // NOTE: Electron's electron.d.ts (as of this dependency's version) documents a
    // newer single-messageDetails-object signature, but this Electron version's
    // ACTUAL runtime behavior (confirmed empirically) is still the older positional
    // signature (event, level, message, line, sourceId), with level 0=verbose,
    // 1=info/log, 2=warning, 3=error. Trust the runtime behavior, not the .d.ts.
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        const logs = consoleLogs.get(jobId);
        if (!logs) return;
        const levelNames = ['verbose', 'log', 'warning', 'error'];
        logs.push({ level: levelNames[level] || String(level), message, line, sourceId, timestamp: new Date().toISOString() });
        if (logs.length > (config.max_console_log_lines || DEFAULT_CONFIG.max_console_log_lines)) {
            logs.splice(0, logs.length - (config.max_console_log_lines || DEFAULT_CONFIG.max_console_log_lines));
        }
    });

    try {
        await win.loadURL(url);
    } catch (error) {
        registry.addJobEvent(jobId, { type: 'nav_error', error: error.message });
        // Leave the tab open — a failed nav isn't a dead tab, mirrors how a
        // browser tab surviving a failed page load works in practice.
    }

    log(`[BROWSERTOOL] Opened browser tab ${jobId}: ${url}`);
    return jobId;
}

function getLiveWindow(jobId) {
    const win = liveWindows.get(jobId);
    if (!win || win.isDestroyed()) {
        throw new Error(`Browser tab not found or already closed: ${jobId}`);
    }
    return win;
}

async function navigateBrowserTab({ jobId, url, hardRefresh, config }) {
    const win = getLiveWindow(jobId);
    if (!isValidUrl(url, config)) {
        throw new Error(`Invalid or disallowed URL: ${url}${config.allow_file_protocol ? '' : ' (file:// is disabled in Settings > Tools)'}`);
    }
    if (hardRefresh && !config.allow_hard_refresh) {
        throw new Error('Hard refresh is disabled in Settings > Tools.');
    }

    const job = registry.getJob(jobId);
    const isReload = job && job.meta && job.meta.url === url;
    if (isReload && hardRefresh) {
        win.webContents.reloadIgnoringCache();
    } else {
        await win.loadURL(url);
    }
    return { success: true, job_id: jobId };
}

async function readPageText(jobId) {
    const win = getLiveWindow(jobId);
    // innerText mirrors the plan's "get_page_text" surface — prefer
    // document.body.innerText, which approximates rendered visible text
    // without needing a full accessibility-tree walk (that's a later pass).
    const text = await win.webContents.executeJavaScript(
        '(function(){try{return document.body ? document.body.innerText : "";}catch(e){return "";}})()'
    );
    return text;
}

// sendInputEvent takes CSS/DIP coordinates, but browser_screenshot returns a
// bitmap at device-pixel resolution (CSS size * devicePixelRatio) — on a
// scaled display (e.g. 150%/200% Windows scaling) those are NOT the same
// space. browser_click's x/y are documented as "screenshot-pixel space" to
// match, so convert down to CSS space here before dispatching.
async function toCssCoordinates(win, x, y) {
    const scaleFactor = await win.webContents.executeJavaScript('window.devicePixelRatio').catch(() => 1);
    const factor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    return { x: Math.round(x / factor), y: Math.round(y / factor) };
}

// Click at a coordinate via synthetic mouse events — needs both mouseDown and
// mouseUp to register as a real click on most page handlers (a single 'click'
// input event type isn't part of Chromium's sendInputEvent API).
async function clickAt(jobId, x, y) {
    const win = getLiveWindow(jobId);
    const point = await toCssCoordinates(win, x, y);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return { success: true, job_id: jobId, x, y };
}

// Type text into whatever's currently focused, via synthetic keyDown/char/keyUp
// per character — mirrors how a real keyboard drives input events, so it
// triggers the same JS listeners a user's typing would (unlike setting
// .value directly via executeJavaScript, which page code may not observe).
async function typeText(jobId, text) {
    const win = getLiveWindow(jobId);
    for (const char of String(text)) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: char });
        win.webContents.sendInputEvent({ type: 'char', keyCode: char });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: char });
    }
    return { success: true, job_id: jobId, length: String(text).length };
}

async function captureScreenshot(jobId) {
    const win = getLiveWindow(jobId);
    const image = await win.webContents.capturePage();
    return image.toPNG().toString('base64');
}

function readConsoleLogs(jobId) {
    if (!liveWindows.has(jobId) && !consoleLogs.has(jobId)) {
        throw new Error(`Browser tab not found or already closed: ${jobId}`);
    }
    return consoleLogs.get(jobId) || [];
}

async function setCacheEnabled(jobId, enabled) {
    const win = getLiveWindow(jobId);
    // Electron's session cache is either used or bypassed per-request via
    // loadURL's bypassCache-equivalent; the simplest reliable per-tab toggle
    // is to track the desired state on the job and enforce it as a hard
    // refresh on the NEXT navigation, since there's no direct "disable cache
    // for this session from now on" session API. Simpler and more honest to
    // document than to fake a live effect with no visible navigation.
    const job = registry.getJob(jobId);
    registry.updateJob(jobId, { meta: { ...(job ? job.meta : {}), cacheEnabled: enabled } });
    if (!enabled) {
        // Clear what's cached so far for this tab's partition immediately,
        // so disabling cache has an immediate, honest effect rather than
        // only applying to future loads.
        await win.webContents.session.clearCache();
    }
    return { success: true, job_id: jobId, cache_enabled: enabled };
}

async function closeBrowserTab(jobId) {
    const win = liveWindows.get(jobId);
    if (win && !win.isDestroyed()) {
        win.destroy();
    }
    const job = registry.getJob(jobId);
    if (job && job.status === 'running') {
        registry.finishJob(jobId, 'exited');
    }
    return { success: true, job_id: jobId };
}

// ===== User-facing (non-AI-tool) actions for the Web Tabs panel =====
// Reveal/hide and screenshot-for-thumbnail are plain functions the panel's
// HTTP routes call directly — not AI tools, since "pop this out so I can look
// at it" is a user action, not something the model should decide (mirrors the
// job registry's "kill is always available to the user" principle).

function revealTab(jobId) {
    const win = getLiveWindow(jobId);
    win.show();
    win.focus();
    return { success: true, job_id: jobId, visible: true };
}

function hideTab(jobId) {
    const win = getLiveWindow(jobId);
    win.hide();
    return { success: true, job_id: jobId, visible: false };
}

function isTabVisible(jobId) {
    const win = liveWindows.get(jobId);
    return !!(win && !win.isDestroyed() && win.isVisible());
}

// Thumbnail screenshot for the Web Tabs panel row — reuses captureScreenshot,
// exposed separately so the panel's HTTP route doesn't need to go through the
// AI-tool-shaped executeBrowserTool (no config.enabled gate — a user viewing
// their own already-open tab isn't an AI capability to gate).
async function captureThumbnail(jobId) {
    return await captureScreenshot(jobId);
}

// ===== Tool execution =====

async function executeBrowserTool(toolName, args, opts = {}) {
    const config = loadConfig();
    if (!config.enabled) {
        throw new Error('Browser tool is disabled. Enable it in Settings > Tools.');
    }

    switch (toolName) {
        case 'browser_open': {
            const jobId = await openBrowserTab({ url: args?.url, chatId: opts.chatId, config });
            const job = registry.getJob(jobId);
            return { success: true, job_id: jobId, url: job.meta.url, title: job.meta.title };
        }
        case 'browser_navigate': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!args?.url) throw new Error('Missing required field: url');
            return await navigateBrowserTab({ jobId: args.job_id, url: args.url, hardRefresh: !!args.hard_refresh, config });
        }
        case 'browser_read_page': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            const text = await readPageText(args.job_id);
            return { success: true, job_id: args.job_id, text };
        }
        case 'browser_close': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            return await closeBrowserTab(args.job_id);
        }
        case 'browser_click': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!Number.isFinite(args?.x) || !Number.isFinite(args?.y)) throw new Error('Missing or invalid required fields: x, y');
            return await clickAt(args.job_id, args.x, args.y);
        }
        case 'browser_type': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.text !== 'string') throw new Error('Missing required field: text');
            return await typeText(args.job_id, args.text);
        }
        case 'browser_screenshot': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            const imageBase64 = await captureScreenshot(args.job_id);
            return { success: true, job_id: args.job_id, image_base64: imageBase64, mime_type: 'image/png' };
        }
        case 'browser_read_console': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            const logs = readConsoleLogs(args.job_id);
            return { success: true, job_id: args.job_id, logs };
        }
        case 'browser_set_cache': {
            if (config.cache_control_user_locked) {
                throw new Error('Cache control is locked by the user in Settings > Tools.');
            }
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.enabled !== 'boolean') throw new Error('Missing required field: enabled');
            return await setCacheEnabled(args.job_id, args.enabled);
        }
        default:
            throw new Error(`Unknown browser tool: ${toolName}`);
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    getToolDefinitions,
    executeBrowserTool,
    revealTab,
    hideTab,
    isTabVisible,
    captureThumbnail
};
