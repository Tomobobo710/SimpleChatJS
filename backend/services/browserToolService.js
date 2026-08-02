// Browser Tool Service - Electron-backed browser tabs the AI can drive
// (navigate, read page text, click, type, screenshot, console log, cache
// control). See web-tool-plan.md section 5.
//
// A browser tab is a job like any other in the shared registry — its kill
// handler destroys the BrowserWindow instead of killing a child process.
//
// browser_screenshot's tool result carries ONLY metadata + the job_id — the
// screenshot bytes themselves stay internal (see lastScreenshots) and never
// ride the tool result, where every adapter would treat them as text tokens.
// The model actually SEES the screenshot via a separate mechanism:
// chatStreamService.js pushes a synthetic role:'user' message with a real
// {type:'image',...} content part right after the tool result (bytes pulled
// from getLastScreenshot), reusing the exact same multimodal path a human's
// uploaded image goes through (main.js's buildMessageContentFromInput) — no
// adapter-specific tool-result plumbing needed, since every adapter already
// knows how to convert that content shape correctly. The Web Tabs panel's
// thumbnail route (routes/jobs.js) is the one place base64 goes to a client.
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
    // javascript:/data: URLs, plus browser_execute_js (arbitrary JS execution
    // in the tab's page context). This is genuinely more permissive than a
    // typical sandboxed browser-automation tool — the audience here is
    // developers automating their OWN app in their OWN local browser, and
    // that's a deliberate design choice, not an oversight. Defaults to
    // allowed; still user-toggleable (and lockable) in Settings > Tools for
    // anyone who wants the tighter posture instead.
    allow_js_execution: true,
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

// Per-tab network request log, captured via Chrome DevTools Protocol
// (webContents.debugger) rather than Electron's webRequest API — webRequest
// gives headers/status/timing but NOT response bodies; CDP's Network domain
// (the same protocol Playwright/Puppeteer/real DevTools use) gives both, via
// Network.getResponseBody keyed by requestId once a response finishes.
// Entries: { requestId, url, method, status, mimeType, requestHeaders,
//            responseHeaders, timestamp, finished, bodyAvailable }
const networkLogs = new Map(); // jobId -> Array<entry>
const networkRequestIndex = new Map(); // jobId -> Map<cdpRequestId, entry> (for O(1) update on responseReceived/loadingFinished)

// Last DOM snapshot per tab, for browser_diff_dom — a Map keyed by a stable
// per-element key (see SNAPSHOT_SCRIPT), not an array, so diffing is a plain
// key-set comparison rather than an index-alignment problem (elements
// reordering in the DOM shouldn't read as every element "changing").
// jobId -> Map<elementKey, { tag, role, text, attrs, box }>
const domSnapshots = new Map();

// Last screenshot bytes per tab. The base64 stays behind the curtains here —
// it never rides the tool result (where every adapter treats content as text:
// a ~75KB blob would tokenize as tens of thousands of junk tokens for an image
// the model can't decode as text). The tool result carries only metadata; the
// chat layer pulls the bytes from this cache when it builds the model's
// synthetic image message. Cleared when the tab closes.
// jobId -> { base64, mimeType }
const lastScreenshots = new Map();

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
const BROWSER_SCREENSHOT_TPL = 'Take a screenshot of a browser tab\'s current page. The screenshot is delivered to you as an image message you can see (returns width/height, which are the REAL page dimensions to use for browser_click coordinates — NOT the pixel size of the image file, which may be compressed/shrunk — plus the tab\'s current url/title). Required: job_id.';
const BROWSER_READ_CONSOLE_TPL = 'Get buffered console messages (console.log/warn/error, and page errors) from a browser tab, oldest first. Required: job_id.';
const BROWSER_READ_NETWORK_TPL = 'List network requests made by a browser tab, oldest first — URL, method, status, mimeType, headers, and whether a response body is available to fetch. Use browser_get_response_body with a request\'s requestId to get its actual response content (not included here — call it separately to avoid flooding this list with large payloads). Required: job_id.';
const BROWSER_GET_RESPONSE_BODY_TPL = 'Fetch the response body for one network request previously seen via browser_read_network. Returns { body, base64Encoded } — base64Encoded is true for binary responses (images, etc), false for text (JSON, HTML, etc — body is the raw text). Works reliably for XHR/fetch/API/asset requests. The TOP-LEVEL PAGE NAVIGATION request (the initial page load itself) usually has no body available here — use browser_read_page to get that page\'s rendered content instead. Required: job_id, request_id.';
const BROWSER_CACHE_TPL = 'Enable or disable HTTP caching for a browser tab\'s session. Disabling forces every request to hit the network instead of a cached copy. Required: job_id, enabled.';
const BROWSER_EXECUTE_JS_TPL = 'Run arbitrary JavaScript in a browser tab\'s page context and get the result back. This is a full escape hatch — read/write any DOM state, call page functions, wait on conditions, extract structured data, dispatch events, anything the page\'s own JS could do. Runs in the SAME isolated context as the page itself (not Node/Electron internals). code is evaluated as an expression — the last expression\'s value is returned as result (wrap in an IIFE for multi-statement code, e.g. "(function(){ ...; return x; })()"). Returns { success, result } on success or { success: false, error } if the code throws. Required: job_id, code.';
const BROWSER_DOUBLE_CLICK_TPL = 'Double-click at a coordinate in a browser tab. Same coordinate space as browser_click (real page pixels — see browser_click for details). For text selection, list reordering, or anything that specifically needs a double-click rather than two separate clicks. Required: job_id, x, y.';
const BROWSER_HOVER_TPL = 'Move the mouse to a coordinate in a browser tab WITHOUT clicking — triggers hover-only behavior (tooltips, CSS :hover styling, hover-activated menus) that click/type can never reach. Same coordinate space as browser_click. Required: job_id, x, y.';
const BROWSER_KEY_TPL = 'Press a single named key in a browser tab — Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, Home, End, PageUp/PageDown, or a printable character. For modifier combos (Ctrl+A, Cmd+C, etc), pass modifiers: e.g. modifiers:["control"], key:"a". Use this for keys/combos that aren\'t printable text (browser_type is for typing regular text into a focused field). Required: job_id, key.';
const BROWSER_DRAG_TPL = 'Drag from one coordinate to another in a browser tab (mouse down, move, mouse up) — for drag-and-drop, sliders, resizable elements, or reordering. Same coordinate space as browser_click for both start and end points. Required: job_id, start_x, start_y, end_x, end_y.';
const BROWSER_SCROLL_TPL = 'Scroll a browser tab\'s page so the given real-page Y coordinate is at the top of the viewport. Use this to bring content below the fold into view before screenshotting or clicking it. For scrolling a specific element into view precisely, browser_execute_js with element.scrollIntoView() is more exact if you know a CSS selector. Required: job_id, y.';
const BROWSER_ZOOM_SCREENSHOT_TPL = 'Take a screenshot of just a SUB-REGION of a browser tab\'s page, at full native resolution (not shrunk by the max-resolution setting that applies to full-page browser_screenshot calls) — use this to read small text or fine detail that\'s illegible in a full-page screenshot. The screenshot is delivered to you as an image message you can see (returns the actual width/height of the captured image). x/y/width/height define the region in real page coordinates (same space as browser_click). Required: job_id, x, y, width, height.';
const BROWSER_DIFF_DOM_TPL = 'See what changed in a browser tab\'s visible elements (links, buttons, inputs, headings, and any element with its own text — list items, paragraphs, table cells, status/toast messages, etc) since the last time you called browser_diff_dom on this tab — a cheap, non-visual alternative to comparing screenshots or full browser_read_page dumps. Returns { added, removed, changed }, each a list of elements with a stable key, tag, text, disabled state, and bounding box. The FIRST call on a tab (or the first call after a full navigation) reports everything currently visible as "added", since there is no prior snapshot yet to compare against — call it once right after browser_open/browser_navigate to establish a baseline, then again after an action (click, type, etc) to see what it caused. Required: job_id.';
const BROWSER_READ_ELEMENT_TPL = 'Read one specific element from a browser tab by CSS selector, without dumping the whole page — text content, a capped snippet of its inner HTML, all its attributes, visibility, and bounding box. result is null if no element matches the selector (not an error — useful for polling "has this error message appeared yet"). Cheaper and more precise than browser_read_page when you already know what you\'re looking for. Required: job_id, selector.';
const BROWSER_QUERY_SELECTOR_ALL_TPL = 'Find ALL elements matching a CSS selector in a browser tab — for "how many, and roughly what are they" questions (e.g. "are there any .error messages, and how many"), unlike browser_read_element which only ever returns the FIRST match. Returns total_count (always exact) and matches, a brief summary (tag, short text, visibility, bounding box — no full HTML/attrs) for up to the first 50 matches; if total_count is greater than matches.length, results were truncated — narrow the selector to see the rest. Use browser_read_element on a more specific selector afterward to get full detail on any one match. Required: job_id, selector.';
const BROWSER_READ_DIALOGS_TPL = 'List any window.alert/confirm/prompt calls a browser tab\'s page has made, oldest first. These native dialogs are intercepted automatically (they never actually block or hang the tab) — alert() logs its message and returns immediately, confirm() logs its message and returns false (as if dismissed), prompt() logs its message and returns null (as if cancelled). Check this after an action if you suspect the page tried to show one of these, since there is no visual sign of it otherwise. Required: job_id.';

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
        },
        {
            name: 'browser_read_network',
            description: BROWSER_READ_NETWORK_TPL,
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
            name: 'browser_get_response_body',
            description: BROWSER_GET_RESPONSE_BODY_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    request_id: { type: 'string', description: 'A requestId from browser_read_network' }
                },
                required: ['job_id', 'request_id'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_double_click',
            description: BROWSER_DOUBLE_CLICK_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    x: { type: 'integer', description: 'X coordinate in real page pixels (see browser_click)' },
                    y: { type: 'integer', description: 'Y coordinate in real page pixels (see browser_click)' }
                },
                required: ['job_id', 'x', 'y'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_hover',
            description: BROWSER_HOVER_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    x: { type: 'integer', description: 'X coordinate in real page pixels (see browser_click)' },
                    y: { type: 'integer', description: 'Y coordinate in real page pixels (see browser_click)' }
                },
                required: ['job_id', 'x', 'y'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_key',
            description: BROWSER_KEY_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    key: { type: 'string', description: 'Key name (Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown) or a single printable character' },
                    modifiers: { type: 'array', items: { type: 'string', enum: ['control', 'shift', 'alt', 'meta'] }, description: 'Optional modifier keys held during the press' }
                },
                required: ['job_id', 'key'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_drag',
            description: BROWSER_DRAG_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    start_x: { type: 'integer', description: 'Drag start X, real page pixels' },
                    start_y: { type: 'integer', description: 'Drag start Y, real page pixels' },
                    end_x: { type: 'integer', description: 'Drag end X, real page pixels' },
                    end_y: { type: 'integer', description: 'Drag end Y, real page pixels' }
                },
                required: ['job_id', 'start_x', 'start_y', 'end_x', 'end_y'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_scroll',
            description: BROWSER_SCROLL_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    y: { type: 'integer', description: 'Real-page Y coordinate to scroll to (becomes the top of the viewport)' }
                },
                required: ['job_id', 'y'],
                additionalProperties: false
            }
        },
        {
            name: 'browser_zoom_screenshot',
            description: BROWSER_ZOOM_SCREENSHOT_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    x: { type: 'integer', description: 'Region left edge, real page pixels' },
                    y: { type: 'integer', description: 'Region top edge, real page pixels' },
                    width: { type: 'integer', description: 'Region width, real page pixels' },
                    height: { type: 'integer', description: 'Region height, real page pixels' }
                },
                required: ['job_id', 'x', 'y', 'width', 'height'],
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

    // browser_execute_js is omitted from the schema entirely when
    // allow_js_execution is off — same "omit, don't just ignore" pattern as
    // the other gated tools above.
    if (config.allow_js_execution) {
        defs.push({
            name: 'browser_execute_js',
            description: BROWSER_EXECUTE_JS_TPL,
            input_schema: {
                type: 'object',
                properties: {
                    job_id: { type: 'string', description: 'The job id returned by browser_open' },
                    code: { type: 'string', description: 'JavaScript to evaluate in the page. Last expression\'s value is returned.' }
                },
                required: ['job_id', 'code'],
                additionalProperties: false
            }
        });
    }

    defs.push({
        name: 'browser_diff_dom',
        description: BROWSER_DIFF_DOM_TPL,
        input_schema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'The job id returned by browser_open' }
            },
            required: ['job_id'],
            additionalProperties: false
        }
    });

    defs.push({
        name: 'browser_read_element',
        description: BROWSER_READ_ELEMENT_TPL,
        input_schema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'The job id returned by browser_open' },
                selector: { type: 'string', description: 'CSS selector, e.g. "#error-message" or ".modal button.primary"' }
            },
            required: ['job_id', 'selector'],
            additionalProperties: false
        }
    });

    defs.push({
        name: 'browser_query_selector_all',
        description: BROWSER_QUERY_SELECTOR_ALL_TPL,
        input_schema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'The job id returned by browser_open' },
                selector: { type: 'string', description: 'CSS selector, e.g. ".error" or "a[href]"' }
            },
            required: ['job_id', 'selector'],
            additionalProperties: false
        }
    });

    defs.push({
        name: 'browser_read_dialogs',
        description: BROWSER_READ_DIALOGS_TPL,
        input_schema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'The job id returned by browser_open' }
            },
            required: ['job_id'],
            additionalProperties: false
        }
    });

    return defs;
}

// ===== Tab lifecycle =====

function isValidUrl(url, config) {
    if (typeof url !== 'string' || !url) return false;
    if (/^https?:\/\//i.test(url)) return true;
    if (config.allow_file_protocol && /^file:\/\//i.test(url)) return true;
    // javascript:/data: URLs are a real code-execution/arbitrary-content
    // vector — gated behind allow_js_execution, same category of capability
    // as browser_execute_js below, not blanket-allowed just because
    // allow_file_protocol is on.
    if (config.allow_js_execution && /^(javascript|data):/i.test(url)) return true;
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
            nodeIntegration: false,
            // Overrides window.alert/confirm/prompt before any page script
            // can call the real ones — see browserToolDialogPreload.js for
            // why: a hidden window's native JS dialogs don't just fail, they
            // silently hang that tab's renderer forever with no event fired.
            preload: path.join(__dirname, 'browserToolDialogPreload.js')
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
    networkLogs.set(jobId, []);
    networkRequestIndex.set(jobId, new Map());
    attachNetworkLogging(jobId, win, config);

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
        networkLogs.delete(jobId);
        networkRequestIndex.delete(jobId);
        domSnapshots.delete(jobId);
        lastScreenshots.delete(jobId);
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
    // A navigation invalidates any prior DOM snapshot — the old element keys
    // no longer refer to anything meaningful, so the next browser_diff_dom
    // call should treat the new page's elements as a fresh baseline ("added"),
    // not diff them against the previous page's unrelated DOM.
    domSnapshots.delete(jobId);
    return { success: true, job_id: jobId };
}

// Max requests retained per tab (oldest dropped first) — same "don't grow
// unbounded" principle as consoleLogs' max_console_log_lines, separate cap
// since network entries are a different shape/size.
const MAX_NETWORK_ENTRIES = 500;
// Total cached response-body bytes retained per tab. Bodies are fetched
// eagerly (see attachNetworkLogging's loadingFinished handler) since CDP
// tends to drop them shortly after — but a long-lived tab loading many
// large assets could otherwise pin unbounded memory just from cached bodies.
// Oldest cached bodies (by request order) are evicted first once over budget
// — the ENTRY stays in the log either way, only its cachedBody is dropped.
const MAX_CACHED_BODY_BYTES_PER_TAB = 10 * 1024 * 1024;

function trimCachedNetworkBodies(jobId) {
    const logs = networkLogs.get(jobId);
    if (!logs) return;
    let total = 0;
    for (const entry of logs) {
        if (entry.cachedBody) total += entry.cachedBody.length;
    }
    let i = 0;
    while (total > MAX_CACHED_BODY_BYTES_PER_TAB && i < logs.length) {
        const entry = logs[i];
        if (entry.cachedBody) {
            total -= entry.cachedBody.length;
            entry.cachedBody = null;
            entry.cachedBodyBase64Encoded = null;
            entry.bodyAvailable = false;
            entry.bodyEvicted = true; // distinguishes "was here, got evicted" from "never captured"
        }
        i++;
    }
}

// Attaches Chrome DevTools Protocol network monitoring to a tab via
// webContents.debugger — the same protocol real automation tools
// (Playwright/Puppeteer) and actual Chrome DevTools use, which is why it can
// capture response BODIES (Network.getResponseBody), unlike Electron's
// webRequest API which only sees headers/status/timing. Attaching the
// debugger has no visible effect on the tab (no DevTools window opens) — CDP
// works fully headless/attached-only.
function attachNetworkLogging(jobId, win, config) {
    const dbg = win.webContents.debugger;
    try {
        dbg.attach('1.3');
    } catch (error) {
        log(`[BROWSERTOOL] Failed to attach debugger for network logging on ${jobId}: ${error.message}`);
        return;
    }

    // maxResourceBufferSize/maxTotalBufferSize are NOT optional in practice —
    // without them CDP's response-body buffer defaults too small (or
    // effectively off) and Network.getResponseBody fails with "No resource
    // with given identifier found" for essentially every request, regardless
    // of timing. 10MB/50MB gives real pages real headroom; individual large
    // responses beyond that just won't have a cached body (bodyAvailable
    // stays false), which is an acceptable, honest limit.
    dbg.sendCommand('Network.enable', {
        maxResourceBufferSize: 10 * 1024 * 1024,
        maxTotalBufferSize: 50 * 1024 * 1024
    }).catch((error) => {
        log(`[BROWSERTOOL] Network.enable failed for ${jobId}: ${error.message}`);
    });

    dbg.on('message', (event, method, params) => {
        const logs = networkLogs.get(jobId);
        const index = networkRequestIndex.get(jobId);
        if (!logs || !index) return; // tab closed mid-flight

        if (method === 'Network.requestWillBeSent') {
            const entry = {
                requestId: params.requestId,
                url: params.request.url,
                method: params.request.method,
                requestHeaders: params.request.headers,
                status: null,
                mimeType: null,
                responseHeaders: null,
                timestamp: new Date().toISOString(),
                finished: false,
                bodyAvailable: false
            };
            logs.push(entry);
            index.set(params.requestId, entry);
            if (logs.length > MAX_NETWORK_ENTRIES) {
                const dropped = logs.shift();
                if (dropped) index.delete(dropped.requestId);
            }
        } else if (method === 'Network.responseReceived') {
            const entry = index.get(params.requestId);
            if (entry) {
                entry.status = params.response.status;
                entry.mimeType = params.response.mimeType;
                entry.responseHeaders = params.response.headers;
            }
        } else if (method === 'Network.loadingFinished') {
            const entry = index.get(params.requestId);
            if (entry) {
                entry.finished = true;
                // Fetched EAGERLY here (cached on the entry) rather than lazily
                // when the model calls browser_get_response_body — CDP tends to
                // drop resources from its cache quickly. CONFIRMED EMPIRICALLY:
                // the TOP-LEVEL PAGE NAVIGATION request consistently fails here
                // with "No resource with given identifier found" (its body is
                // consumed by the renderer's own document pipeline in a way that
                // races CDP's capture for that specific request type), while
                // XHR/fetch/asset SUBRESOURCE requests capture reliably. This
                // isn't a timing/buffer-size bug — Network.enable's buffer size
                // params were tried and didn't change this. Documented in
                // BROWSER_GET_RESPONSE_BODY_TPL rather than "fixed" further,
                // since the practical gap is small: the main document's content
                // is already available via browser_read_page.
                dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
                    .then((result) => {
                        entry.cachedBody = result.body;
                        entry.cachedBodyBase64Encoded = result.base64Encoded;
                        entry.bodyAvailable = true;
                        trimCachedNetworkBodies(jobId);
                    })
                    .catch((error) => {
                        // Expected for the top-level navigation request (see
                        // comment above) — logged at low noise since it's the
                        // common case, not an error to chase.
                        log(`[BROWSERTOOL] No response body available for ${params.requestId} (${params.type || 'request'}): ${error.message}`);
                        entry.bodyAvailable = false;
                    });
            }
        } else if (method === 'Network.loadingFailed') {
            const entry = index.get(params.requestId);
            if (entry) {
                entry.finished = true;
                entry.error = params.errorText;
            }
        }
    });

    dbg.on('detach', (event, reason) => {
        log(`[BROWSERTOOL] Debugger detached for ${jobId}: ${reason}`);
    });
}

// Fetch a specific response body by requestId (via CDP), for a request
// already seen in networkLogs with bodyAvailable:true. Bodies aren't
// captured proactively for every request (would be expensive for a
// long-lived tab with hundreds of requests) — fetched on demand instead.
async function getNetworkResponseBody(jobId, requestId) {
    // Ensure the job/tab genuinely exists (throws a clear error otherwise) —
    // the body itself is served entirely from the cache populated eagerly
    // in attachNetworkLogging, NOT re-fetched from CDP here. Re-querying
    // Network.getResponseBody lazily (on the model's own timing) was the
    // original approach and reliably failed with "No resource with given
    // identifier found" — CDP drops resources from its cache quickly, often
    // before the model's next tool call. Eagerly caching at loadingFinished
    // time and serving from that cache here is the reliable approach.
    getLiveWindow(jobId);
    const index = networkRequestIndex.get(jobId);
    const entry = index && index.get(requestId);
    if (!entry) {
        throw new Error(`No network request found with id: ${requestId}`);
    }
    if (entry.bodyEvicted) {
        throw new Error(`Response body for request ${requestId} was evicted to stay under the per-tab memory budget (many/large responses since it was captured).`);
    }
    if (!entry.bodyAvailable || entry.cachedBody === undefined) {
        throw new Error(`Response body not available for request ${requestId} (finished=${entry.finished}) — some resources (redirects, cancelled requests) never have a body.`);
    }
    return { body: entry.cachedBody, base64Encoded: !!entry.cachedBodyBase64Encoded };
}

// Shared traversal helper, inlined into every script below that queries the
// DOM (readPageText, diff_dom's SNAPSHOT_SCRIPT, read_element,
// query_selector_all) — NOT used by browser_execute_js, which is the
// model's own raw escape hatch and stays exactly document.querySelector,
// unmodified, on purpose.
//
// Reaches into:
//  - SAME-ORIGIN iframes (iframe.contentDocument) — recursively, so an
//    iframe inside an iframe is still found. A cross-origin iframe's
//    contentDocument throws/returns null when accessed from here (browser
//    same-origin policy — no plain-JS trick gets around that, would need
//    Chrome DevTools Protocol frame-scoped execution, not attempted here).
//  - OPEN shadow roots (element.shadowRoot) — recursively, so nested
//    web components are all found. CLOSED shadow roots
//    (attachShadow({mode:'closed'})) are deliberately unreachable, by
//    design, even to real browser DevTools without CDP — not a bug here.
//
// Returns an array of "root" objects (Document or ShadowRoot), each with
// its own querySelectorAll — callers flatMap their query across all of them
// instead of calling document.querySelectorAll once.
const ROOTS_HELPER_SRC = `
    function __simplechatGetAllRoots(root, seen) {
        seen = seen || new Set();
        if (seen.has(root)) return [];
        seen.add(root);
        const roots = [root];
        // Any element in this root that might host more roots (iframes = new
        // Document, elements with .shadowRoot = new ShadowRoot).
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (el.tagName === 'IFRAME') {
                let innerDoc = null;
                try { innerDoc = el.contentDocument; } catch (e) { innerDoc = null; }
                if (innerDoc) {
                    roots.push.apply(roots, __simplechatGetAllRoots(innerDoc, seen));
                }
            }
            if (el.shadowRoot) {
                roots.push.apply(roots, __simplechatGetAllRoots(el.shadowRoot, seen));
            }
        }
        return roots;
    }
`;

async function readPageText(jobId) {
    const win = getLiveWindow(jobId);
    // innerText mirrors the plan's "get_page_text" surface — prefer
    // document.body.innerText, which approximates rendered visible text
    // without needing a full accessibility-tree walk (that's a later pass).
    // Same-origin iframes' body text is appended after the top document's,
    // each labeled, so nested content (e.g. an embedded checkout form) is
    // still readable as text even though it's a separate document.
    const script = `
        ${ROOTS_HELPER_SRC}
        (function() {
            try {
                const roots = __simplechatGetAllRoots(document);
                const parts = [];
                roots.forEach(function(root) {
                    const body = root.body || (root.host && root.host.ownerDocument === document ? root : null);
                    const el = root.body || root; // ShadowRoot has no .body, read it directly
                    if (!el) return;
                    const text = (el.innerText !== undefined ? el.innerText : el.textContent || '').trim();
                    if (text) parts.push(text);
                });
                return parts.join('\\n\\n');
            } catch (e) { return ''; }
        })()
    `;
    const text = await win.webContents.executeJavaScript(script);
    return text;
}

// In-page snapshot script shared by browser_diff_dom and browser_read_element.
// Scoped to VISIBLE, INTERACTIVE-OR-TEXTUAL elements only (buttons, links,
// inputs, headings, and leaf text nodes) — not a full DOM dump — so a
// snapshot stays small (typically dozens, not thousands, of entries) and a
// diff stays readable. Each element gets a best-effort stable key: id if
// present, else tag+role+a position-independent path-ish fingerprint (tag
// chain + nth-of-type), so the SAME element keeps the SAME key across two
// snapshots even if unrelated siblings were added/removed — that's what
// makes "added/removed/changed" meaningful instead of everything after an
// insertion point reading as "changed".
const SNAPSHOT_SCRIPT = `
${ROOTS_HELPER_SRC}
(function() {
    function isVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return false;
        return true;
    }
    function keyFor(el) {
        if (el.id) return 'id:' + el.id;
        let path = [];
        let node = el;
        while (node && node.nodeType === 1 && path.length < 6) {
            const parent = node.parentElement;
            let idx = 0;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
                idx = siblings.indexOf(node);
            }
            path.unshift(node.tagName.toLowerCase() + ':' + idx);
            node = parent;
        }
        return 'path:' + path.join('>');
    }
    function shortText(el) {
        const t = (el.innerText || el.value || el.placeholder || '').trim().replace(/\\s+/g, ' ');
        return t.length > 120 ? t.slice(0, 120) + '\\u2026' : t;
    }
    const INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,summary,label,[onclick]';
    const TEXT_BLOCK_SELECTOR = 'li,p,td,th,dt,dd,span,div,section,article,figcaption';
    const out = {};
    const roots = __simplechatGetAllRoots(document);
    roots.forEach(function(root) {
        root.querySelectorAll(INTERACTIVE_SELECTOR).forEach(function(el) {
            if (!isVisible(el)) return;
            const r = el.getBoundingClientRect();
            out[keyFor(el)] = {
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || null,
                text: shortText(el),
                disabled: !!el.disabled,
                box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
            };
        });
        // Second pass: plain text-bearing block/list/table-row elements (li, p,
        // td, div, span, etc) that carry their OWN direct text (not just text
        // inherited from a descendant already captured above) — this is what
        // catches dynamically-appearing content that isn't itself a button/link,
        // e.g. a new list item, a toast/error message, a status line. Excludes
        // elements that only wrap other captured elements (would be pure noise:
        // every ancestor of a button re-reporting the button's own text as its own).
        root.querySelectorAll(TEXT_BLOCK_SELECTOR).forEach(function(el) {
            const key = keyFor(el);
            if (out[key]) return; // already captured by the interactive pass
            if (!isVisible(el)) return;
            const ownText = Array.from(el.childNodes)
                .filter(function(n) { return n.nodeType === 3; })
                .map(function(n) { return n.textContent; })
                .join(' ').trim().replace(/\\s+/g, ' ');
            if (!ownText) return; // no direct text of its own — just a layout wrapper, skip
            const r = el.getBoundingClientRect();
            out[key] = {
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || null,
                text: ownText.length > 120 ? ownText.slice(0, 120) + '\\u2026' : ownText,
                disabled: false,
                box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
            };
        });
    });
    return out;
})()
`;

async function snapshotDom(jobId) {
    const win = getLiveWindow(jobId);
    return await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
}

// Diffs the tab's current visible/interactive element set against the last
// snapshot taken for this tab (or "everything is new" on the first call),
// then stores the new snapshot as the baseline for next time. This lets the
// model check "what changed since my last action" in a few dozen tokens
// instead of re-reading the whole page and diffing it mentally.
async function diffDom(jobId) {
    const current = await snapshotDom(jobId);
    const previous = domSnapshots.get(jobId) || {};
    const added = [];
    const removed = [];
    const changed = [];
    for (const key of Object.keys(current)) {
        if (!(key in previous)) {
            added.push({ key, ...current[key] });
        } else {
            const before = previous[key];
            const after = current[key];
            if (before.text !== after.text || before.disabled !== after.disabled ||
                before.box.x !== after.box.x || before.box.y !== after.box.y ||
                before.box.width !== after.box.width || before.box.height !== after.box.height) {
                changed.push({ key, before: { text: before.text, disabled: before.disabled, box: before.box }, after: { text: after.text, disabled: after.disabled, box: after.box } });
            }
        }
    }
    for (const key of Object.keys(previous)) {
        if (!(key in current)) removed.push({ key, ...previous[key] });
    }
    domSnapshots.set(jobId, current);
    return { added, removed, changed };
}

// Reads one element via CSS selector — the element-scoped counterpart to
// browser_read_page's whole-page innerText dump. Returns null result when no
// match, rather than throwing, since "not present (yet)" is an expected,
// common outcome (e.g. polling for a validation message) not an error.
async function readElement(jobId, selector) {
    const win = getLiveWindow(jobId);
    const script = `
        ${ROOTS_HELPER_SRC}
        (function() {
            const roots = __simplechatGetAllRoots(document);
            let el = null;
            for (let i = 0; i < roots.length && !el; i++) {
                el = roots[i].querySelector(${JSON.stringify(selector)});
            }
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            return {
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.value || '').trim(),
                html: el.innerHTML.length > 2000 ? el.innerHTML.slice(0, 2000) + '\\u2026' : el.innerHTML,
                attrs: Array.from(el.attributes).reduce(function(acc, a) { acc[a.name] = a.value; return acc; }, {}),
                visible: visible,
                box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
            };
        })()
    `;
    return await win.webContents.executeJavaScript(script);
}

// Max elements summarized per browser_query_selector_all call — count is
// always exact (querySelectorAll's real length), but the summary LIST is
// capped so a selector that matches thousands of elements (e.g. "div")
// can't flood the result. total_count vs matches.length tells the model
// whether it was truncated.
const MAX_QUERY_ALL_RESULTS = 50;

// The "how many, and roughly what are they" counterpart to browser_read_element
// (which only ever returns the FIRST match, like querySelector itself). Scans
// ALL matches for an exact count, but only summarizes up to
// MAX_QUERY_ALL_RESULTS of them in detail — deliberately terse per-element
// (no full HTML/attrs, unlike read_element) since the point is a cheap
// existence/count/overview scan, not a deep read of any one of them.
async function querySelectorAll(jobId, selector) {
    const win = getLiveWindow(jobId);
    const script = `
        ${ROOTS_HELPER_SRC}
        (function() {
            const roots = __simplechatGetAllRoots(document);
            const all = [];
            roots.forEach(function(root) {
                root.querySelectorAll(${JSON.stringify(selector)}).forEach(function(el) { all.push(el); });
            });
            const cap = ${MAX_QUERY_ALL_RESULTS};
            const matches = [];
            for (let i = 0; i < all.length && matches.length < cap; i++) {
                const el = all[i];
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                const text = (el.innerText || el.value || el.placeholder || '').trim().replace(/\\s+/g, ' ');
                matches.push({
                    tag: el.tagName.toLowerCase(),
                    text: text.length > 120 ? text.slice(0, 120) + '\\u2026' : text,
                    visible: visible,
                    box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
                });
            }
            return { total_count: all.length, matches: matches };
        })()
    `;
    return await win.webContents.executeJavaScript(script);
}

// Runs arbitrary JS in the tab's page context and returns its result. Real,
// unrestricted code execution — the deliberate, more-capable counterpart to
// the narrow single-purpose tools above (readPageText, clickAt, etc). Gated
// by allow_js_execution (see isValidUrl's comment for the same gate on
// javascript:/data: URLs — same category of capability, same toggle).
//
// executeJavaScript already runs in an isolated context per Electron's
// contextIsolation:true (set at window creation) — this does NOT reach into
// Node/Electron internals, only the tab's own web page, same sandbox a
// browser devtools console would have.
//
// The model's code is wrapped in an inner try/catch that we control, rather
// than relying on executeJavaScript's own promise rejection — Electron's
// rejection for a thrown error in the target script is lossy (observed: a
// generic "Script failed to execute... check the renderer console" message,
// with the real Error's text discarded), which is useless for a model trying
// to see what actually went wrong and fix its own code.
async function executeJsInTab(jobId, code) {
    const win = getLiveWindow(jobId);
    const wrapped = `
        (function() {
            try {
                const __result = (function() { return (${code}); })();
                return { __ok: true, __value: __result };
            } catch (__err) {
                return { __ok: false, __error: (__err && __err.message) ? __err.message : String(__err) };
            }
        })()
    `;
    try {
        const outcome = await win.webContents.executeJavaScript(wrapped, true);
        if (outcome && outcome.__ok) {
            return { success: true, result: outcome.__value };
        }
        return { success: false, error: (outcome && outcome.__error) || 'Unknown error executing script' };
    } catch (error) {
        // A SYNTAX error (not a thrown runtime error — those are caught above)
        // still escapes as a real rejection here, e.g. malformed code that
        // never even starts running.
        return { success: false, error: error && error.message ? error.message : String(error) };
    }
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

// Double-click — same mouseDown/mouseUp pattern as clickAt but clickCount:2,
// which is what tells the page's own click handlers/OS text selection this
// is a double-click rather than two separate single clicks. Coordinates are
// real page coordinates, same convention as clickAt (see toCssCoordinates).
async function doubleClickAt(jobId, x, y) {
    const win = getLiveWindow(jobId);
    const point = toCssCoordinates(x, y);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 2 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 2 });
    return { success: true, job_id: jobId, x, y };
}

// Move the mouse to a coordinate WITHOUT clicking — triggers hover-only page
// behavior (CSS :hover, JS mouseenter/mouseover listeners, tooltips, hover
// menus) that click/type alone can never reach.
async function hoverAt(jobId, x, y) {
    const win = getLiveWindow(jobId);
    const point = toCssCoordinates(x, y);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    return { success: true, job_id: jobId, x, y };
}

// Press-and-release a single named key (Enter, Tab, Escape, ArrowDown, etc —
// Chromium's own key-name strings, same vocabulary sendInputEvent already
// accepts for keyCode) or a modifier combo (e.g. modifiers:['control'] with
// key:'a' for Ctrl+A). Distinct from typeText, which sends printable
// characters one at a time — this is for keys with no printable character
// (navigation, submission) or modifier combinations typeText can't express.
async function pressKey(jobId, key, modifiers) {
    const win = getLiveWindow(jobId);
    const opts = { type: 'keyDown', keyCode: key };
    if (Array.isArray(modifiers) && modifiers.length > 0) opts.modifiers = modifiers;
    win.webContents.sendInputEvent(opts);
    win.webContents.sendInputEvent({ ...opts, type: 'keyUp' });
    return { success: true, job_id: jobId, key, modifiers: modifiers || [] };
}

// Drag from one real-page coordinate to another — mouseDown at the start,
// a few intermediate mouseMove events (some drag targets/sliders only
// activate on movement, not a single jump), then mouseUp at the end.
async function dragMouse(jobId, startX, startY, endX, endY) {
    const win = getLiveWindow(jobId);
    const start = toCssCoordinates(startX, startY);
    const end = toCssCoordinates(endX, endY);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: start.x, y: start.y, button: 'left', clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
        const x = Math.round(start.x + (end.x - start.x) * (i / steps));
        const y = Math.round(start.y + (end.y - start.y) * (i / steps));
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' });
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: end.x, y: end.y, button: 'left', clickCount: 1 });
    return { success: true, job_id: jobId, start_x: startX, start_y: startY, end_x: endX, end_y: endY };
}

// Scroll the page so a given real-page Y coordinate is at the top of the
// viewport — the closest tab-level equivalent to "scroll this into view"
// without needing a DOM element reference (which the model doesn't have —
// it only ever has pixel coordinates, per this tool's whole design). For
// scrolling to a specific known ELEMENT, browser_execute_js with
// element.scrollIntoView() remains the more precise option.
async function scrollToY(jobId, y) {
    const win = getLiveWindow(jobId);
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${Number(y)})`);
    return { success: true, job_id: jobId, y };
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

// Screenshot of just a sub-region of the page, at full native resolution
// (only the byte-size ladder applies, NOT the long-edge cap — the whole
// point is fidelity for a small area, e.g. reading fine print or a small
// icon, without the resolution cap that's tuned for full-page screenshots
// crushing it down). x/y/width/height are real page coordinates, same
// convention as browser_click. Reuses the tab's own coordinate space — no
// separate scaling concept from the rest of the tool surface.
async function captureZoomedScreenshot(jobId, x, y, width, height) {
    const win = getLiveWindow(jobId);
    const config = loadConfig();
    const image = await win.webContents.capturePage({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
    });
    // Byte-size compression still applies (a zoomed capture of a busy area
    // could still be large), but no long-edge cap — see comment above.
    const result = compressToByteTarget(image, config.screenshot_max_base64_kb);
    return { base64: result.base64, mimeType: 'image/jpeg', width: result.width, height: result.height };
}

function readConsoleLogs(jobId) {
    if (!liveWindows.has(jobId) && !consoleLogs.has(jobId)) {
        throw new Error(`Browser tab not found or already closed: ${jobId}`);
    }
    return consoleLogs.get(jobId) || [];
}

// Reads the alert/confirm/prompt call log stashed by
// browserToolDialogPreload.js's overrides. A tab that never called any of
// these has an empty log — that's a normal, common outcome, not an error.
async function readDialogs(jobId) {
    const win = getLiveWindow(jobId);
    const entries = await win.webContents.executeJavaScript('window.__simplechatDialogLog || []').catch(() => []);
    return entries;
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

// Read the most recent screenshot bytes captured for a tab. This is the ONLY
// channel the base64 travels on — the chat layer calls it to build the model's
// synthetic image message after a browser_screenshot/browser_zoom_screenshot
// tool call, instead of the bytes riding the tool result itself.
function getLastScreenshot(jobId) {
    const shot = lastScreenshots.get(jobId);
    return shot ? { base64: shot.base64, mimeType: shot.mimeType } : null;
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
            // Bytes stay internal (see lastScreenshots); the model gets only the
            // reference + metadata. The synthetic image message the chat layer
            // pushes reads the bytes back out of the cache via getLastScreenshot.
            lastScreenshots.set(args.job_id, { base64: shot.base64, mimeType: shot.mimeType });
            return {
                success: true,
                job_id: args.job_id,
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
        case 'browser_read_network': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!liveWindows.has(args.job_id)) throw new Error(`Browser tab not found or already closed: ${args.job_id}`);
            const rawRequests = networkLogs.get(args.job_id) || [];
            // Strip cachedBody/cachedBodyBase64Encoded — the list is meant to
            // stay small/scannable; full body content is fetched separately
            // via browser_get_response_body, deliberately, so it's never
            // silently dumped into a request the model didn't ask for.
            const requests = rawRequests.map(({ cachedBody, cachedBodyBase64Encoded, ...rest }) => rest);
            return { success: true, job_id: args.job_id, requests };
        }
        case 'browser_get_response_body': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!args?.request_id) throw new Error('Missing required field: request_id');
            const body = await getNetworkResponseBody(args.job_id, args.request_id);
            return { success: true, job_id: args.job_id, request_id: args.request_id, ...body };
        }
        case 'browser_double_click': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!Number.isFinite(args?.x) || !Number.isFinite(args?.y)) throw new Error('Missing or invalid required fields: x, y');
            return await doubleClickAt(args.job_id, args.x, args.y);
        }
        case 'browser_hover': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!Number.isFinite(args?.x) || !Number.isFinite(args?.y)) throw new Error('Missing or invalid required fields: x, y');
            return await hoverAt(args.job_id, args.x, args.y);
        }
        case 'browser_key': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.key !== 'string' || !args.key) throw new Error('Missing required field: key');
            return await pressKey(args.job_id, args.key, args.modifiers);
        }
        case 'browser_drag': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!Number.isFinite(args?.start_x) || !Number.isFinite(args?.start_y) || !Number.isFinite(args?.end_x) || !Number.isFinite(args?.end_y)) {
                throw new Error('Missing or invalid required fields: start_x, start_y, end_x, end_y');
            }
            return await dragMouse(args.job_id, args.start_x, args.start_y, args.end_x, args.end_y);
        }
        case 'browser_scroll': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!Number.isFinite(args?.y)) throw new Error('Missing or invalid required field: y');
            return await scrollToY(args.job_id, args.y);
        }
        case 'browser_zoom_screenshot': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (!Number.isFinite(args?.x) || !Number.isFinite(args?.y) || !Number.isFinite(args?.width) || !Number.isFinite(args?.height)) {
                throw new Error('Missing or invalid required fields: x, y, width, height');
            }
            const zoomShot = await captureZoomedScreenshot(args.job_id, args.x, args.y, args.width, args.height);
            lastScreenshots.set(args.job_id, { base64: zoomShot.base64, mimeType: zoomShot.mimeType });
            return { success: true, job_id: args.job_id, width: zoomShot.width, height: zoomShot.height };
        }
        case 'browser_set_cache': {
            if (config.cache_control_user_locked) {
                throw new Error('Cache control is locked by the user in Settings > Tools.');
            }
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.enabled !== 'boolean') throw new Error('Missing required field: enabled');
            return await setCacheEnabled(args.job_id, args.enabled);
        }
        case 'browser_execute_js': {
            if (!config.allow_js_execution) {
                throw new Error('JS execution is disabled in Settings > Tools.');
            }
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.code !== 'string') throw new Error('Missing required field: code');
            return await executeJsInTab(args.job_id, args.code);
        }
        case 'browser_diff_dom': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            const diff = await diffDom(args.job_id);
            return { success: true, job_id: args.job_id, ...diff };
        }
        case 'browser_read_element': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.selector !== 'string' || !args.selector) throw new Error('Missing required field: selector');
            const element = await readElement(args.job_id, args.selector);
            return { success: true, job_id: args.job_id, selector: args.selector, element };
        }
        case 'browser_query_selector_all': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            if (typeof args?.selector !== 'string' || !args.selector) throw new Error('Missing required field: selector');
            const result = await querySelectorAll(args.job_id, args.selector);
            return { success: true, job_id: args.job_id, selector: args.selector, ...result };
        }
        case 'browser_read_dialogs': {
            if (!args?.job_id) throw new Error('Missing required field: job_id');
            const dialogs = await readDialogs(args.job_id);
            return { success: true, job_id: args.job_id, dialogs };
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
    captureThumbnail,
    getLastScreenshot
};
