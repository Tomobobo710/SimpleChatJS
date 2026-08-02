const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ── DPI scaling via zoom factor ──────────────────────────────────────
// deviceScaleFactor is forced to 1 (electron-main.js) so window sizes
// are real pixels. We compensate by setting the Chromium zoom factor to
// the OS DPI scale — this scales EVERYTHING in the page, including
// native decorations CSS can't touch (spellcheck underline, scrollbars,
// selection highlight).
let dpiScale = 1;
let userZoom = 1.0; // user multiplier on top of DPI base (1.0 = default)

function applyZoom() {
    webFrame.setZoomFactor(dpiScale * userZoom);
}

(async () => {
    try {
        const dpiInfo = await ipcRenderer.invoke('get-windows-dpi');
        dpiScale = dpiInfo.scale;
    } catch (e) {
        dpiScale = 1;
    }
    applyZoom();
})();

// Ctrl+mousewheel zoom. Chromium's native ctrl+wheel zoom is suppressed under
// Electron, so we drive the zoom factor ourselves. The user zoom multiplier
// adjusts on top of the DPI base. wheel listeners are passive by default, so we
// must register non-passive to be allowed to preventDefault (stops the page from
// scrolling while zooming). Clamped so the UI can't be zoomed into uselessness.
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3.0;
window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    userZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, userZoom + dir * ZOOM_STEP));
    applyZoom();
}, { passive: false });

// View menu zoom — the built-in resetZoom/zoomIn/zoomOut roles reset to
// 1.0 which would undo the DPI base, so we handle them ourselves via IPC.
ipcRenderer.on('zoom-in', () => {
    userZoom = Math.min(ZOOM_MAX, userZoom + ZOOM_STEP);
    applyZoom();
});
ipcRenderer.on('zoom-out', () => {
    userZoom = Math.max(ZOOM_MIN, userZoom - ZOOM_STEP);
    applyZoom();
});
ipcRenderer.on('zoom-reset', () => {
    userZoom = 1.0;
    applyZoom();
});

// Expose context menu API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
    onShowContextMenu: (callback) => {
        ipcRenderer.on('show-context-menu', (event, data) => callback(data));
    },
    executeContextAction: (action, data) => {
        if (action === 'copy') {
            document.execCommand('copy');
        } else if (action === 'cut') {
            document.execCommand('cut');
        } else if (action === 'paste') {
            document.execCommand('paste');
        } else if (action === 'inspect') {
            ipcRenderer.send('inspect-element');
        } else if (action === 'add-to-dictionary') {
            if (data && data.word) {
                ipcRenderer.send('add-to-dictionary', data.word);
            }
        }
    },
    pickFolder: () => {
        return ipcRenderer.invoke('pick-folder');
    },
    getHomeDir: () => {
        return ipcRenderer.invoke('get-home-dir');
    },
    onEscapePressed: (callback) => {
        ipcRenderer.on('escape-pressed', () => callback());
    },
    getWindowsDPI: () => {
        return ipcRenderer.invoke('get-windows-dpi');
    }
});
