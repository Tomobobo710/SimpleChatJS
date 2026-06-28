const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const path = require("path");
const setFindBar = require("find-bar");

// Set Chromium user-data-dir BEFORE app initialization
const isPackaged = app.isPackaged;
const appPath = isPackaged ? path.dirname(process.execPath) : __dirname;
const userdataPath = path.join(appPath, "userdata");
const electronDataPath = path.join(userdataPath, "electron");

// Create directories BEFORE setting user-data-dir
const fs = require("fs");
if (!fs.existsSync(userdataPath)) {
    fs.mkdirSync(userdataPath, { recursive: true });
}
if (!fs.existsSync(electronDataPath)) {
    fs.mkdirSync(electronDataPath, { recursive: true });
}

// Force Chromium to use our portable path and disable encryption features
console.log("Setting Chromium user-data-dir to:", electronDataPath);
app.commandLine.appendSwitch("user-data-dir", electronDataPath);
console.log("All command line switches:", process.argv);
app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("disable-default-apps");
app.commandLine.appendSwitch("disable-extensions");
app.commandLine.appendSwitch("disable-component-extensions-with-background-pages");

// Keep a global reference of the window object
let mainWindow;

// Setup portable paths AFTER early Chromium config
function setupPortablePaths() {
    console.log("Setting up portable paths...");
    console.log("App path:", appPath);
    console.log("Userdata path:", userdataPath);
    console.log("Electron data path:", electronDataPath);

    // Force Electron to use a subfolder for its own data
    app.setPath("userData", electronDataPath);

    // Set environment variable for the backend (main userdata folder)
    process.env.PORTABLE_USERDATA_PATH = userdataPath;

    // Create userdata directories if they don't exist
    const fs = require("fs");
    if (!fs.existsSync(userdataPath)) {
        fs.mkdirSync(userdataPath, { recursive: true });
        console.log("Created userdata directory");
    }
    if (!fs.existsSync(electronDataPath)) {
        fs.mkdirSync(electronDataPath, { recursive: true });
        console.log("Created electron data directory");
    }
}

// Start the Express server directly (no spawn)
function startServer() {
    console.log("Starting SimpleChatJS server directly...");

    try {
        // Import and start the server directly in this process
        require("./backend/server.js");
        console.log("Server started successfully");
    } catch (error) {
        console.error("Server startup error:", error);
    }
}

// Window state persistence
const WINDOW_STATE_PATH = path.join(userdataPath, "window_state.json");

function loadWindowState() {
    try {
        if (fs.existsSync(WINDOW_STATE_PATH)) {
            return JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, "utf8"));
        }
    } catch (e) {
        console.error("Failed to load window state:", e);
    }
    return null;
}

function saveWindowState() {
    if (!mainWindow) return;
    try {
        const isMaximized = mainWindow.isMaximized();
        const bounds = mainWindow.getNormalBounds();
        fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify({ ...bounds, isMaximized }), "utf8");
    } catch (e) {
        console.error("Failed to save window state:", e);
    }
}

// Create the main application window
function createWindow() {
    const savedState = loadWindowState();

    // Create the browser window
    mainWindow = new BrowserWindow({
        width: savedState ? savedState.width : 1400,
        height: savedState ? savedState.height : 900,
        x: savedState ? savedState.x : undefined,
        y: savedState ? savedState.y : undefined,
        minWidth: 200,
        minHeight: 200,
        icon: path.join(__dirname, "assets", "images", "icon", "simplechaticon512.ico"),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            spellcheck: true,
            preload: path.join(__dirname, "electron-preload.js"),
            devTools: {
                enabled: true
            }
        },
        show: false // Don't show until ready
    });

    // Persist window state on move/resize/maximize
    const saveState = () => saveWindowState();
    mainWindow.on("resize", saveState);
    mainWindow.on("move", saveState);
    mainWindow.on("maximize", saveState);
    mainWindow.on("unmaximize", saveState);

    // Wait a moment for server to start, then load the URL
    setTimeout(() => {
        mainWindow.loadURL("http://localhost:50505");
        // Maximize on first launch (no saved state), otherwise restore saved state
        if (!savedState || savedState.isMaximized) {
            mainWindow.maximize();
        }
        mainWindow.show();
        // F12 toggles DevTools in all builds
        mainWindow.webContents.on("before-input-event", (event, input) => {
            if (input.type === "keyDown" && input.key === "F12") {
                mainWindow.webContents.toggleDevTools();
                event.preventDefault();
            }
        });
        // Add find bar to this window
        setFindBar(mainWindow, { darkMode: true });
    }, 2000);

    // Handle window closed
    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    // Handle navigation - keep user in the app
    mainWindow.webContents.on("new-window", (event, navigationUrl) => {
        event.preventDefault();
        require("electron").shell.openExternal(navigationUrl);
    });

    // Enable context menu (right-click menu)
    mainWindow.webContents.on("context-menu", (event, params) => {
        // Build menu items array
        const menuItems = [];

        // Add copy menu item if there is text selection
        if (params.selectionText) {
            menuItems.push({ action: "copy", label: "Copy" });
        }

        // Add paste menu item if we're in an editable field
        if (params.isEditable) {
            if (params.selectionText) {
                menuItems.push({ action: "cut", label: "Cut" });
            }
            menuItems.push({ action: "paste", label: "Paste" });
        }

        // Add inspect element in development mode
        if (process.env.NODE_ENV === "development") {
            if (menuItems.length > 0) {
                menuItems.push({ action: "separator" });
            }
            menuItems.push({ action: "inspect", label: "Inspect Element" });
        }

        // Send context menu data to renderer if we have items
        if (menuItems.length > 0) {
            mainWindow.webContents.send("show-context-menu", {
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
            label: "SimpleChatJS",
            submenu: [
                {
                    label: "About SimpleChatJS",
                    role: "about"
                },
                { type: "separator" },
                {
                    label: "Quit",
                    accelerator: "CmdOrCtrl+Q",
                    click: () => {
                        app.quit();
                    }
                }
            ]
        },
        {
            label: "Edit",
            submenu: [
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" }
            ]
        },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// App event handlers
app.whenReady().then(() => {
    setupPortablePaths(); // Setup paths FIRST
    startServer(); // Start server directly
    createWindow(); // Create window
    Menu.setApplicationMenu(null); // Remove menu bar completely

    // Handle inspect element IPC
    ipcMain.on("inspect-element", () => {
        if (mainWindow) {
            mainWindow.webContents.toggleDevTools();
        }
    });

    // Handle folder picker IPC
    ipcMain.handle("pick-folder", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openDirectory"]
        });
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        const path = require("path");
        return {
            path: result.filePaths[0],
            name: path.basename(result.filePaths[0])
        };
    });

    // Handle home directory IPC
    ipcMain.handle("get-home-dir", () => {
        return app.getPath("home");
    });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    // Server runs in the same process, so it'll quit with the app
    // On macOS, keep app running even when all windows are closed
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", () => {
    console.log("App shutting down...");
});

// Security: Prevent new window creation
app.on("web-contents-created", (event, contents) => {
    contents.on("new-window", (event, navigationUrl) => {
        event.preventDefault();
    });
});
