const { contextBridge, ipcRenderer, webFrame } = require('electron');
const { dialog } = require('electron');

// Ctrl+mousewheel zoom. Chromium's native ctrl+wheel zoom is suppressed under
// Electron, so we drive the zoom factor ourselves — mirroring the View menu's
// zoomIn/zoomOut/resetZoom roles. wheel listeners are passive by default, so we
// must register non-passive to be allowed to preventDefault (stops the page from
// scrolling while zooming). Clamped so the UI can't be zoomed into uselessness.
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3.0;
window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, webFrame.getZoomFactor() + dir * ZOOM_STEP));
    webFrame.setZoomFactor(next);
}, { passive: false });

// Expose context menu API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
    onShowContextMenu: (callback) => {
        ipcRenderer.on('show-context-menu', (event, data) => callback(data));
    },
    executeContextAction: (action) => {
        if (action === 'copy') {
            document.execCommand('copy');
        } else if (action === 'cut') {
            document.execCommand('cut');
        } else if (action === 'paste') {
            document.execCommand('paste');
        } else if (action === 'inspect') {
            ipcRenderer.send('inspect-element');
        }
    },
    pickFolder: () => {
        return ipcRenderer.invoke('pick-folder');
    },
    getHomeDir: () => {
        return ipcRenderer.invoke('get-home-dir');
    }
});
