const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

// Set Chromium user-data-dir BEFORE app initialization
const isPackaged = app.isPackaged;
const appPath = isPackaged ? path.dirname(process.execPath) : __dirname;
const userdataPath = path.join(appPath, 'userdata');
const electronDataPath = path.join(userdataPath, 'electron');

// Create directories BEFORE setting user-data-dir
const fs = require('fs');
if (!fs.existsSync(userdataPath)) {
    fs.mkdirSync(userdataPath, { recursive: true });
}
if (!fs.existsSync(electronDataPath)) {
    fs.mkdirSync(electronDataPath, { recursive: true });
}

// Force Chromium to use our portable path and disable encryption features
console.log('Setting Chromium user-data-dir to:', electronDataPath);
app.commandLine.appendSwitch('user-data-dir', electronDataPath);
console.log('All command line switches:', process.argv);
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-component-extensions-with-background-pages');

// Keep a global reference of the window object
let mainWindow;

// Setup portable paths AFTER early Chromium config
function setupPortablePaths() {
    console.log('Setting up portable paths...');
    console.log('App path:', appPath);
    console.log('Userdata path:', userdataPath);
    console.log('Electron data path:', electronDataPath);
    
    // Force Electron to use a subfolder for its own data
    app.setPath('userData', electronDataPath);
    
    // Set environment variable for the backend (main userdata folder)
    process.env.PORTABLE_USERDATA_PATH = userdataPath;
    
    // Create userdata directories if they don't exist
    const fs = require('fs');
    if (!fs.existsSync(userdataPath)) {
        fs.mkdirSync(userdataPath, { recursive: true });
        console.log('Created userdata directory');
    }
    if (!fs.existsSync(electronDataPath)) {
        fs.mkdirSync(electronDataPath, { recursive: true });
        console.log('Created electron data directory');
    }
}

// Start the Express server directly (no spawn)
function startServer() {
    console.log('Starting SimpleChatJS server directly...');
    
    try {
        // Import and start the server directly in this process
        require('./backend/server.js');
        console.log('Server started successfully');
    } catch (error) {
        console.error('Server startup error:', error);
    }
}

// Create the main application window
function createWindow() {
    // Create the browser window
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        icon: path.join(__dirname, 'simplechatjs.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            spellcheck: true,
            preload: path.join(__dirname, 'electron-preload.js')
        },
        show: false // Don't show until ready
    });
    
    // Wait a moment for server to start, then load the URL
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:50505');
        mainWindow.show();
    }, 2000);
    
    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
    
    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    
    // Handle navigation - keep user in the app
    mainWindow.webContents.on('new-window', (event, navigationUrl) => {
        event.preventDefault();
        require('electron').shell.openExternal(navigationUrl);
    });
    
    // Enable context menu (right-click menu)
    mainWindow.webContents.on('context-menu', (event, params) => {
        // Build menu items array
        const menuItems = [];
        
        // Add copy menu item if there is text selection
        if (params.selectionText) {
            menuItems.push({ action: 'copy', label: 'Copy' });
        }
        
        // Add paste menu item if we're in an editable field
        if (params.isEditable) {
            if (params.selectionText) {
                menuItems.push({ action: 'cut', label: 'Cut' });
            }
            menuItems.push({ action: 'paste', label: 'Paste' });
        }
        
        // Add inspect element in development mode
        if (process.argv.includes('--dev')) {
            if (menuItems.length > 0) {
                menuItems.push({ action: 'separator' });
            }
            menuItems.push({ action: 'inspect', label: 'Inspect Element' });
        }
        
        // Send context menu data to renderer if we have items
        if (menuItems.length > 0) {
            mainWindow.webContents.send('show-context-menu', {
                x: params.x,
                y: params.y,
                items: menuItems
            });
        }
    });

}

// Remove default menu bar
function createMenu() {
    const template = [
        {
            label: 'SimpleChatJS',
            submenu: [
                {
                    label: 'About SimpleChatJS',
                    role: 'about'
                },
                { type: 'separator' },
                {
                    label: 'Quit',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        }
    ];
    
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// App event handlers
app.whenReady().then(() => {
    setupPortablePaths();  // Setup paths FIRST
    startServer();         // Start server directly
    createWindow();        // Create window
    Menu.setApplicationMenu(null); // Remove menu bar completely
    
    // Handle inspect element IPC
    ipcMain.on('inspect-element', () => {
        if (mainWindow) {
            mainWindow.webContents.toggleDevTools();
        }
    });
    
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Server runs in the same process, so it'll quit with the app
    // On macOS, keep app running even when all windows are closed
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    // Server runs in the same process, so no cleanup needed
    console.log('App shutting down...');
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
    contents.on('new-window', (event, navigationUrl) => {
        event.preventDefault();
    });
});
