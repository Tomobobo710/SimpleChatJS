// Browser Tool Service - Electron-backed browser tabs the AI can drive
// (navigate, read page text, click, type, screenshot, console log, cache
// control). See web-tool-plan.md section 5.
//
// A browser tab is a job like any other in the shared registry — its kill
// handler destroys the BrowserWindow instead of killing a child process.
//
// browser_screenshot's tool result still carries the image as a base64
// string field (useful for automation/debugging and for the Web Tabs panel's
// thumbnail), but the model actually SEES the screenshot via a separate
// mechanism: chatStreamService.js pushes a synthetic role:'user' message
// with a real {type:'image',...} content part right after the tool result,
// reusing the exact same multimodal path a human's uploaded image goes
// through (main.js's buildMessageContentFromInput) — no adapter-specific
// tool-result plumbing needed, since every adapter already knows how to
// convert that content shape correctly.
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { getUserdataPath } = require('../utils/pathUtils');
const registry = require('./jobRegistryService');

// Sane hard bounds regardless of what's requested — prevents a 0x0 or
// absurdly huge window from a malformed AI-supplied value or a mistyped
// user setting. Used by both getToolDefinitions (schema description) and
// openBrowserTab (actual clamping).
const MIN_TAB_DIMENSION_PX = 200;
const MAX_TAB_DIMENSION_PX = 4000;

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
    max_console_log_lines: 500,
    // Screenshot compression. Two INDEPENDENT knobs, not one:
    //   - max_long_edge_px caps PIXEL DIMENSIONS, which is what actually
    //     drives vision-model token/patch cost (Anthropic's docs recommend
    //     <=1568px on the long edge; other providers have their own similar
    //     sweet spots). This must be applied BEFORE any byte-size compression,
    //     and independent of devicePixelRatio — capturePage() returns a bitmap
    //     at DEVICE-pixel resolution (CSS size x scale factor), so on a
    //     150%/200%-scaled display the raw capture is already 1.5-2x the
    //     window's own CSS width before any of this runs.
    //   - max_base64_kb caps BYTE SIZE (JPEG quality/further scale, applied
    //     to whatever the long-edge cap already produced) — this bounds
    //     request/storage size, but has only a loose relationship to token
    //     cost, since a blocky low-quality JPEG at a given resolution costs
    //     the same vision-model tokens as a crisp one at that resolution.
    screenshot_max_long_edge_px: 1568,
    screenshot_max_base64_kb: 75,
    // The tab window's real page size (CSS pixels) — set via setContentSize
    // after creation so it's honored exactly regardless of the display's own
    // resolution (a plain constructor width/height can be silently shrunk by
    // the OS on a small/short screen, even for a window that's never shown).
    // This is the coordinate space browser_click's x/y live in and the
    // width/height every browser_* tool result reports — NOT the screenshot
    // image's own pixel size, which is separately controlled by
    // screenshot_max_long_edge_px above.
    tab_width_px: 1280,
    tab_height_px: 720,
    // When true, the AI is never offered a way to change tab dimensions —
    // browser_open's width/height parameters are omitted from its schema
    // entirely, same "omit, don't just ignore" pattern as
    // cache_control_user_locked above.
    tab_dimensions_user_locked: false
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
        win._simplechatAllowClose = true; // real kill, not the OS window's X button — let 'close' through
        try { win.destroy(); } catch (_) {}
    }
    // finishJob is called from the window's own 'closed' event handler
    // (wired in openBrowserTab below), not here — mirrors backgroundJobsService's
    // pattern of letting the actual death event drive the status transition.
});

// ===== Tool definitions =====

const BROWSER_OPEN_TPL = 'Open a new browser tab (a real, hidden Chromium window) and navigate it to a URL. Returns a job_id — use it with the other browser_* tools to keep driving this tab across multiple tool calls. Also returns width/height: the page\'s real pixel size, which is the coordinate space browser_click uses (see browser_click). The tab keeps running in the background even between your tool calls (rAF/timers are not throttled while hidden), and the user can see, reveal, or close it at any time from the Web Tabs panel. Required: url.';
const BROWSER_NAVIGATE_TPL = 'Navigate an existing browser tab (opened with browser_open) to a new URL, or reload its current page. Returns width/height (see browser_click) alongside the navigation result. Required: job_id, url. Pass hard_refresh:true to bypass the cache on reload (only meaningful when url is the tab\'s current URL).';
const BROWSER_READ_PAGE_TPL = 'Get the visible text content of a browser tab\'s current page. Required: job_id.';
const BROWSER_CLOSE_TPL = 'Close a browser tab. Required: job_id.';
const BROWSER_CLICK_TPL = 'Click at a coordinate in a browser tab. IMPORTANT: x/y are coordinates on the REAL PAGE (the width/height browser_screenshot reports), NOT pixel positions counted in the screenshot image file. The screenshot image may be compressed/shrunk for file size, but it always shows the FULL page — so estimate the click position as a fraction of the image (e.g. "about 1/3 across, 1/2 down") and apply that same fraction to the real width/height to get x/y, rather than counting literal pixels in the (possibly downscaled) image. Take a screenshot first if you don\'t already know where to click. Required: job_id, x, y.';
const BROWSER_TYPE_TPL = 'Type text into whatever element is currently focused in a browser tab (click an input field first with browser_click, then type into it). Required: job_id, text.';
const BROWSER_SCREENSHOT_TPL = 'Take a screenshot of a browser tab\'s current page. Returns image_base64 (JPEG data, may be compressed/shrunk for file size — always shows the FULL page regardless), width/height (the REAL page dimensions to use for browser_click coordinates — NOT the pixel size of the image file, which may be smaller), and the tab\'s current url/title. Required: job_id.';
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

    // Tab dimensions are entirely omitted from the schema when locked — not
    // just ignored — same "omit, don't just ignore" pattern as
    // cache_control_user_locked (see web-tool-plan.md section 6.3): the AI
    // is never even offered the option to consider.
    const openProps = {
        url: { type: 'string', description: 'URL to open (http/https' + (config.allow_file_protocol ? ', or file://' : '') + ')' }
    };
    if (!config.tab_dimensions_user_locked) {
        openProps.width = { type: 'integer', description: `Optional. Tab width in pixels (default ${config.tab_width_px || DEFAULT_CONFIG.tab_width_px}). Clamped to ${MIN_TAB_DIMENSION_PX}-${MAX_TAB_DIMENSION_PX}.` };
        openProps.height = { type: 'integer', description: `Optional. Tab height in pixels (default ${config.tab_height_px || DEFAULT_CONFIG.tab_height_px}). Clamped to ${MIN_TAB_DIMENSION_PX}-${MAX_TAB_DIMENSION_PX}.` };
    }

    const defs = [
        {
            name: 'browser_open',
            description: BROWSER_OPEN_TPL,
            input_schema: {
                type: 'object',
                properties: openProps,
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

function clampTabDimension(value, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.round(Math.min(MAX_TAB_DIMENSION_PX, Math.max(MIN_TAB_DIMENSION_PX, value)));
}

async function openBrowserTab({ url, chatId, config, requestedWidth, requestedHeight }) {
    const electron = getElectron();
    if (!electron) {
        throw new Error('Browser tool is unavailable: not running inside the Electron app.');
    }
    if (!isValidUrl(url, config)) {
        throw new Error(`Invalid or disallowed URL: ${url}${config.allow_file_protocol ? '' : ' (file:// is disabled in Settings > Tools)'}`);
    }

    // AI-requested dimensions are ignored entirely when locked — this branch
    // shouldn't normally be reached since the schema omits the parameters
    // when locked (see getToolDefinitions), but enforced here too as defense
    // in depth against a client that sends them anyway.
    const useRequestedSize = !config.tab_dimensions_user_locked;
    const tabWidth = clampTabDimension(useRequestedSize ? requestedWidth : undefined, config.tab_width_px || DEFAULT_CONFIG.tab_width_px);
    const tabHeight = clampTabDimension(useRequestedSize ? requestedHeight : undefined, config.tab_height_px || DEFAULT_CONFIG.tab_height_px);

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
        meta: { url, title: '', cacheEnabled: config.default_cache_enabled, visible: false }
    });

    // Isolated session per tab so cache behavior can be toggled per-tab
    // without affecting the main app window or other tabs.
    const partition = `browser-tab-${jobId}`;
    const ses = session.fromPartition(partition, { cache: config.default_cache_enabled });

    // Explicit size — without one, a hidden BrowserWindow can default to a
    // very small content area, which silently breaks click coordinates (they
    // land outside the real page layout). tabWidth/tabHeight come from
    // Settings > Tools (tab_width_px/tab_height_px) by default, or from an
    // AI-supplied browser_open width/height when the user hasn't locked that.
    const win = new BrowserWindow({
        show: false,
        width: tabWidth,
        height: tabHeight,
        // Without this, width/height size the WINDOW FRAME (including title
        // bar/borders on platforms that have one), not the page content area
        // — so the actual page ends up smaller than requested (observed
        // ~1268x686 for a 1280x720 request, without this flag). useContentSize
        // makes width/height mean the content area directly, so the page
        // really is tabWidth x tabHeight, matching what's documented to the
        // model and what window creation actually asked for.
        useContentSize: true,
        webPreferences: {
            session: ses,
            backgroundThrottling: !config.background_throttling_disabled,
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    // The constructor's width/height can still be silently clamped by the OS
    // if the primary display's work area is smaller than requested (observed:
    // a 720px-tall display shrank an 800px-tall request to ~686px, even for
    // this NEVER-SHOWN window) — useContentSize alone doesn't prevent that,
    // it only fixes what width/height MEAN, not whether they're honored.
    // setContentSize, called explicitly after creation, is NOT subject to
    // that clamp and reliably forces the true requested size regardless of
    // the display. Without this, the "real page size" we report to the model
    // (see captureScreenshot) would be a smaller-than-requested, display-
    // dependent number instead of the true tabWidth x tabHeight.
    win.setContentSize(tabWidth, tabHeight);
    liveWindows.set(jobId, win);
    consoleLogs.set(jobId, []);

    // The user clicking the OS window's own close button (X) should behave
    // like the panel's "Hide" button, not "Close" — the tab (and the AI's
    // job) keeps running, just hidden again. 'close' fires BEFORE
    // destruction and is cancelable; 'closed' (below) fires after and is
    // the REAL teardown, reached only via explicit destroy() (panel Close /
    // job_kill / registry kill handler), never by the window's X button.
    win.on('close', (event) => {
        if (win._simplechatAllowClose) return; // real close in progress (see closeBrowserTab/kill handler)
        event.preventDefault();
        win.hide();
        setTabVisibleMeta(jobId, false);
    });

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

// Real page size (CSS pixels — the same space browser_click's x/y are in).
// Attached to every tool result that touches a live tab (open/navigate/
// click), not just browser_screenshot, so the model always knows the
// coordinate space it should be reasoning in even if it hasn't screenshotted
// yet — it should never have to guess or assume a size.
async function getPageSize(jobId) {
    try {
        const win = getLiveWindow(jobId);
        const width = await win.webContents.executeJavaScript('window.innerWidth').catch(() => null);
        const height = await win.webContents.executeJavaScript('window.innerHeight').catch(() => null);
        return { width: Number.isFinite(width) ? width : null, height: Number.isFinite(height) ? height : null };
    } catch (e) {
        return { width: null, height: null };
    }
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

// NO SCALING, ON PURPOSE. browser_click's x/y ARE real page coordinates
// (CSS pixels — same space as the browser tab's fixed 1280x720 window size),
// full stop. The model is told this directly in browser_screenshot's
// description ("this image is a scaled-down view of a 1280x720 page — give
// coordinates in that 1280x720 space, not in the image file's own pixel
// count"), so there is nothing to convert here: sendInputEvent already wants
// CSS pixels, and that's what we're handing it, unmodified.
//
// This used to scale x/y by the ratio between the screenshot's compressed
// size and the live CSS size (screenshot pixel space -> page pixel space).
// That was CORRECT arithmetic, but it made the system's actual behavior
// depend on: the model estimating coordinates in a small, non-fixed image
// size that changes with compression settings; a live re-query of
// window.innerWidth/innerHeight at click time; and a remembered screenshot
// size from a prior tool call — three moving, sometimes-stale numbers for
// every single click. Telling the model the FIXED real page size up front
// and having it reason in that space directly removes all three.
function toCssCoordinates(x, y) {
    return { x: Math.round(x), y: Math.round(y) };
}

// Click at a coordinate via synthetic mouse events — needs both mouseDown and
// mouseUp to register as a real click on most page handlers (a single 'click'
// input event type isn't part of Chromium's sendInputEvent API).
async function clickAt(jobId, x, y) {
    const win = getLiveWindow(jobId);
    const point = toCssCoordinates(x, y);
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

// Two-stage screenshot compression: cap PIXEL DIMENSIONS first (what
// actually drives vision-model token/patch cost), then run a progressive
// scale/quality ladder to hit a BYTE-SIZE target (bounds request/storage
// size — a much weaker relationship to token cost, since a low-quality JPEG
// costs the same tokens as a crisp one at the same resolution). Both knobs
// are user-configurable (Settings > Tools > Browser Tool). See
// web-tool-plan.md and the design discussion for why these are separate.
//
// capturePage() returns a bitmap at DEVICE-pixel resolution (CSS window size
// x devicePixelRatio) — on a 150%/200%-scaled display the raw capture is
// already 1.5-2x the window's own configured CSS width, so the long-edge cap
// below is essential even at a fixed window size; it's not redundant with
// openBrowserTab's width/height.
const SCREENSHOT_QUALITIES = Array.from({ length: 7 }, (_, i) => 70 - i * 10); // 70..10, toJPEG wants 0-100
const SCREENSHOT_SCALES = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];

// Stage 1: resize down to maxLongEdgePx if the captured image exceeds it.
// Never upscales — a smaller-than-cap screenshot is left alone.
function capLongEdge(image, maxLongEdgePx) {
    const { width, height } = image.getSize();
    const longEdge = Math.max(width, height);
    if (!Number.isFinite(maxLongEdgePx) || maxLongEdgePx <= 0 || longEdge <= maxLongEdgePx) {
        return image;
    }
    const capScale = maxLongEdgePx / longEdge;
    return image.resize({ width: Math.round(width * capScale), height: Math.round(height * capScale) });
}

// Stage 2: progressive scale/quality ladder against the (already long-edge-
// capped) image to hit a byte-size target, same spirit as
// imageProcessing.js's browser-side compressor (canvas.toBlob there,
// nativeImage here — no DOM in the Electron main process).
// Returns { base64, width, height } — the REAL dimensions of the image that
// base64 actually encodes, not the pre-compression source size. Callers need
// this both to tell the model what it's looking at (see captureScreenshot)
// and to convert the model's click coordinates back to real page coordinates
// (see clickAt) — coordinates the model gives us are always relative to
// THIS image, not the raw capture or any intermediate resize.
function compressToByteTarget(image, maxBase64Kb) {
    const targetKb = Number.isFinite(maxBase64Kb) && maxBase64Kb > 0 ? maxBase64Kb : 75;
    const { width, height } = image.getSize();
    for (const scale of SCREENSHOT_SCALES) {
        const scaled = scale === 1.0 ? image : image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
        const scaledSize = scaled.getSize();
        for (const quality of SCREENSHOT_QUALITIES) {
            const buf = scaled.toJPEG(quality);
            const base64 = buf.toString('base64');
            if (base64.length / 1024 <= targetKb) {
                return { base64, width: scaledSize.width, height: scaledSize.height };
            }
        }
    }
    // Every rung failed to hit the target (e.g. a tiny/already-simple image
    // that still won't compress further) — fall back to the smallest/lowest
    // quality attempt rather than erroring, same spirit as the browser-side
    // compressor throwing only when NOTHING produced output at all.
    const smallestW = Math.round(width * SCREENSHOT_SCALES[SCREENSHOT_SCALES.length - 1]);
    const smallestH = Math.round(height * SCREENSHOT_SCALES[SCREENSHOT_SCALES.length - 1]);
    const smallest = image.resize({ width: smallestW, height: smallestH });
    const base64 = smallest.toJPEG(SCREENSHOT_QUALITIES[SCREENSHOT_QUALITIES.length - 1]).toString('base64');
    return { base64, width: smallestW, height: smallestH };
}

// Returns { base64, width, height } of the FINAL compressed image (the one
// that actually gets sent to the model) — see compressToByteTarget's comment
// for why every dimension here matters and isn't just cosmetic.
function compressNativeImage(image, config) {
    const longEdgeCapped = capLongEdge(image, config.screenshot_max_long_edge_px);
    return compressToByteTarget(longEdgeCapped, config.screenshot_max_base64_kb);
}

async function captureScreenshot(jobId) {
    const win = getLiveWindow(jobId);
    const config = loadConfig();
    const image = await win.webContents.capturePage();
    const result = compressNativeImage(image, config);
    // width/height reported here are the REAL PAGE size (CSS pixels), NOT the
    // (possibly much smaller, compression-dependent) size of the JPEG bytes
    // in image_base64. browser_click's x/y are documented as being in THIS
    // space — see toCssCoordinates's comment for why: it removes the need for
    // any backend-side coordinate scaling at click time.
    const cssWidth = await win.webContents.executeJavaScript('window.innerWidth').catch(() => null);
    const cssHeight = await win.webContents.executeJavaScript('window.innerHeight').catch(() => null);
    return {
        base64: result.base64,
        mimeType: 'image/jpeg',
        width: Number.isFinite(cssWidth) ? cssWidth : result.width,
        height: Number.isFinite(cssHeight) ? cssHeight : result.height
    };
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
        win._simplechatAllowClose = true; // real close, not the OS window's X button
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

// meta.visible is mirrored into the job registry (not just tracked on the
// live window) so the panel's poll of /api/jobs picks up visibility changes
// it didn't itself cause — e.g. the user clicking the OS window's own close
// button, which now hides rather than kills (see the 'close' handler above).
// Without this the Reveal/Hide button's label would go stale after that.
function setTabVisibleMeta(jobId, visible) {
    const job = registry.getJob(jobId);
    if (!job) return;
    registry.updateJob(jobId, { meta: { ...job.meta, visible } });
}

function revealTab(jobId) {
    const win = getLiveWindow(jobId);
    win.show();
    win.focus();
    setTabVisibleMeta(jobId, true);
    return { success: true, job_id: jobId, visible: true };
}

function hideTab(jobId) {
    const win = getLiveWindow(jobId);
    win.hide();
    setTabVisibleMeta(jobId, false);
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
    return await captureScreenshot(jobId); // { base64, mimeType }
}

// ===== Tool execution =====

async function executeBrowserTool(toolName, args, opts = {}) {
    const config = loadConfig();
    if (!config.enabled) {
        throw new Error('Browser tool is disabled. Enable it in Settings > Tools.');
    }

    switch (toolName) {
        case 'browser_open': {
            const jobId = await openBrowserTab({ url: args?.url, chatId: opts.chatId, config, requestedWidth: args?.width, requestedHeight: args?.height });
            const job = registry.getJob(jobId);
            const size = await getPageSize(jobId);
            return { success: true, job_id: jobId, url: job.meta.url, title: job.meta.title, width: size.width, height: size.height };
        }
        case 'browser_navigate': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!args?.url) throw new Error('Missing required field: url');
            const navResult = await navigateBrowserTab({ jobId: args.job_id, url: args.url, hardRefresh: !!args.hard_refresh, config });
            const size = await getPageSize(args.job_id);
            return { ...navResult, width: size.width, height: size.height };
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
            const clickResult = await clickAt(args.job_id, args.x, args.y);
            const size = await getPageSize(args.job_id);
            return { ...clickResult, width: size.width, height: size.height };
        }
        case 'browser_type': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.text !== 'string') throw new Error('Missing required field: text');
            return await typeText(args.job_id, args.text);
        }
        case 'browser_screenshot': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            const shot = await captureScreenshot(args.job_id);
            const job = registry.getJob(args.job_id);
            return {
                success: true,
                job_id: args.job_id,
                image_base64: shot.base64,
                mime_type: shot.mimeType,
                // The model shouldn't have to guess these from pixels — we
                // already know them. width/height are the REAL dimensions of
                // this exact image (post-compression) — browser_click's x/y
                // are relative to these numbers, not the raw capture size.
                width: shot.width,
                height: shot.height,
                url: (job && job.meta && job.meta.url) || null,
                title: (job && job.meta && job.meta.title) || null
            };
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
