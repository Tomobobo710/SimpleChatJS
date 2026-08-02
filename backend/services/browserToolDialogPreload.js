// Preload script for browser_tool tabs ONLY (not the main app window — see
// electron-preload.js for that).
//
// WHY THIS EXISTS: a hidden (show:false) BrowserWindow's native
// alert/confirm/prompt dialogs still render as a REAL OS-level modal dialog
// (confirmed by hands-on testing against the actual app, even though the
// parent BrowserWindow itself is never shown) — an unannounced popup during
// an AI-driven session, and until dismissed it hangs that tab's renderer
// with no event or signal the app can observe.
//
// FIX: override alert/confirm/prompt before any page script can call the
// real ones. IMPORTANT: with contextIsolation:true, a preload script's own
// top-level `window` is a SEPARATE isolated-world global from the page's
// real `window` — assigning `window.alert = ...` here does NOT touch the
// page's alert at all (that was tried first and confirmed, via testing, to
// NOT prevent the popup). webFrame.executeJavaScript runs in the MAIN world
// (the page's actual world), which is what's needed to really replace the
// page's alert/confirm/prompt.
const { webFrame } = require('electron');

const INJECT_SCRIPT = `
(function() {
    if (window.__simplechatDialogLog) return; // already installed (e.g. re-injected on same document)
    const log = [];
    const MAX_ENTRIES = 50;
    function record(type, message, response) {
        log.push({ type: type, message: String(message), response: response, timestamp: new Date().toISOString() });
        if (log.length > MAX_ENTRIES) log.shift();
    }
    window.alert = function(message) {
        record('alert', message, undefined);
        return undefined;
    };
    window.confirm = function(message) {
        record('confirm', message, false);
        return false;
    };
    window.prompt = function(message, defaultValue) {
        record('prompt', message, null);
        return null;
    };
    window.__simplechatDialogLog = log;
})();
`;

// Runs as early as preload itself does (before the page's own scripts parse
// and run), in the main world, so the overrides are in place before any page
// script has a chance to call the real native alert/confirm/prompt.
webFrame.executeJavaScript(INJECT_SCRIPT);
