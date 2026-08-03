const { app, BrowserWindow, Menu, shell, ipcMain, dialog, globalShortcut } = require("electron");
app.commandLine.appendSwitch('force-device-scale-factor', '1');
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

// Promise resolving to the port the backend actually bound to.
// Set by startServer(), awaited by createWindow() before loading the URL.
let serverReady;

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

// Start the Express server directly (no spawn).
// Returns a promise resolving to the actual bound port.
function startServer() {
    console.log("Starting SimpleChatJS server directly...");

    try {
        // Import and start the server directly in this process.
        // server.js exports the startup promise, which resolves with the bound port.
        return require("./backend/server.js");
    } catch (error) {
        console.error("Server startup error:", error);
        return Promise.reject(error);
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

    // Wait for the server to actually bind, then load its real port.
    // No more blind setTimeout / hardcoded port — serverReady resolves with
    // the port that bound (which may differ from the preferred one).
    serverReady.then((port) => {
        mainWindow.loadURL(`http://localhost:${port}`);
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
        // Scale DevTools to match the DPI zoom factor — DevTools is a separate
        // webContents that webFrame.setZoomFactor (in the preload) can't reach.
        mainWindow.webContents.on("devtools-opened", () => {
            const dt = mainWindow.webContents.devToolsWebContents;
            if (!dt) return;
            try {
                const si = require("systeminformation");
                si.graphics().then((data) => {
                    const display = data.displays.find((d) => d.main) || data.displays[0];
                    const scale = display ? (display.resolutionX / display.currentResX) : 1;
                    dt.setZoomFactor(Number.isFinite(scale) && scale > 0 ? scale : 1);
                }).catch(() => {});
            } catch (_) {}
        });
        // Add find bar to this window
        setFindBar(mainWindow, { darkMode: true });

        // The find-bar library registers ESC as a global shortcut that
        // intercepts Escape at the OS level — no keydown event ever reaches
        // the renderer. Override it so Escape stops AI generation when the
        // find bar isn't visible, and still hides the find bar when it is.
        // Our 'focus' listener is registered after setFindBar's, so it runs
        // second and replaces the find-bar's ESC registration each time.
        const overrideEscShortcut = () => {
            globalShortcut.unregister('ESC');
            globalShortcut.register('ESC', () => {
                const findBar = mainWindow.getChildWindows().find(w => w._isFindBar && w.isVisible());
                if (findBar) {
                    findBar.hide();
                    mainWindow.webContents.stopFindInPage('clearSelection');
                } else {
                    mainWindow.webContents.send('escape-pressed');
                }
            });
        };
        mainWindow.on('focus', overrideEscShortcut);
        if (mainWindow.isFocused()) overrideEscShortcut();
    }).catch((err) => {
        console.error("Server failed to start, cannot load window:", err);
    });

    // Handle window closed - clean up all jobs and browser tabs so the
    // process can actually exit. Without this, hidden browser tab windows
    // keep window-all-closed from ever firing, and spawned child processes
    // keep the Node event loop alive - the user has to Ctrl+C to quit.
    mainWindow.on("closed", async () => {
        mainWindow = null;
        const { killAllJobs } = require("./backend/services/jobRegistryService");
        const browserToolService = require("./backend/services/browserToolService");
        // Destroy browser tab windows first (synchronous, immediate), then
        // kill remaining jobs (shell child processes). Await killAllJobs so
        // every kill signal is actually sent before app.quit() - the kill
        // handlers are synchronous under the hood (child.kill / win.destroy)
        // so this resolves near-instantly with no hang risk.
        browserToolService.destroyAllTabs();
        await killAllJobs();
        app.quit();
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

        // Spell check suggestions (Chromium selects the misspelled word on
        // right-click, so the textarea selection brackets it — the preload
        // replaces that selection with the chosen suggestion).
        if (params.misspelledWord) {
            const suggestions = params.dictionarySuggestions || [];
            for (const suggestion of suggestions) {
                menuItems.push({ action: "replace-word", label: suggestion, suggestion });
            }
            if (suggestions.length > 0) {
                menuItems.push({ action: "separator" });
            }
            menuItems.push({ action: "add-to-dictionary", label: "Add to Dictionary", word: params.misspelledWord });
            menuItems.push({ action: "separator" });
        }

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
                { label: "Reset Zoom", click: () => mainWindow.webContents.send("zoom-reset") },
                { label: "Zoom In", click: () => mainWindow.webContents.send("zoom-in") },
                { label: "Zoom Out", click: () => mainWindow.webContents.send("zoom-out") },
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
    serverReady = startServer(); // Start server directly; resolves with bound port
    createWindow(); // Create window (awaits serverReady before loading URL)
    Menu.setApplicationMenu(null); // Remove menu bar completely

    // Handle inspect element IPC
    ipcMain.on("inspect-element", () => {
        if (mainWindow) {
            mainWindow.webContents.toggleDevTools();
        }
    });

    // Handle add-to-dictionary IPC (persists across restarts via the session's
    // custom dictionary file in the Electron user-data directory).
    ipcMain.on("add-to-dictionary", (event, word) => {
        if (mainWindow && word) {
            mainWindow.webContents.session.addWordToUserDictionary(word);
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

    // Handle Windows DPI IPC (reads native resolution from OS via systeminformation)
    ipcMain.handle("get-windows-dpi", () => {
        try {
            const si = require("systeminformation");
            return new Promise((resolve) => {
                si.graphics().then((data) => {
                    const display = data.displays.find((d) => d.main);
                    if (!display) return resolve({ dpi: 96, scale: 1 });
                    const scale = display.resolutionX / display.currentResX;
                    const dpi = Math.round(scale * 96);
                    resolve({ dpi, scale });
                }).catch(() => resolve({ dpi: 96, scale: 1 }));
            });
        } catch (e) {
            console.error("[MAIN] Failed to get Windows DPI:", e.message);
            return Promise.resolve({ dpi: 96, scale: 1 });
        }
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
