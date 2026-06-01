const { contextBridge, ipcRenderer } = require('electron');
const { dialog } = require('electron');

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
    }
});
