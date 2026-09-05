const { app, BrowserWindow, globalShortcut, Menu, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let win;
let tray = null;
let isLocked = false;
let isClickThrough = false;
let isQuitting = false;

// Prevents launching a second copy of the app.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
    });
}

const LOG_PATH = path.join(app.getPath('userData'), 'debug.log');
const VERBOSE = fs.existsSync(path.join(app.isPackaged ? process.resourcesPath : __dirname, 'enable-debug'));

const BOUNDS_PATH = path.join(app.getPath('userData'), 'window-bounds.json');
const DEFAULT_BOUNDS = { width: 400, height: 800 };

function loadWindowBounds() {
    try {
        const raw = fs.readFileSync(BOUNDS_PATH, 'utf-8');
        const bounds = JSON.parse(raw);
        if (
            typeof bounds.width === 'number' &&
            typeof bounds.height === 'number' &&
            bounds.width > 0 && bounds.height > 0
        ) {
            return bounds;
        }
    } catch (e) {
        // No saved bounds
    }
    return DEFAULT_BOUNDS;
}

function saveWindowBounds() {
    if (!win || win.isDestroyed()) return;
    try {
        fs.writeFileSync(BOUNDS_PATH, JSON.stringify(win.getBounds()));
    } catch (err) {
        logError(`Failed to save window bounds: ${err.message}`);
    }
}

function getValidatedWindowBounds() {
    const bounds = loadWindowBounds();
    if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
        return bounds;
    }

    const displays = screen.getAllDisplays();
    const fitsOnSomeDisplay = displays.some(({ workArea }) => {
        return (
            bounds.x < workArea.x + workArea.width &&
            bounds.x + bounds.width > workArea.x &&
            bounds.y < workArea.y + workArea.height &&
            bounds.y + bounds.height > workArea.y
        );
    });

    if (fitsOnSomeDisplay) return bounds;

    logVerbose('Saved window position is off-screen -- falling back to centered default.');
    return { width: bounds.width, height: bounds.height };
}

function logError(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_PATH, line);
    } catch (e) {
    }
}
function logVerbose(msg) {
    if (VERBOSE) logError(msg);
}

process.on('uncaughtException', (err) => {
    logError(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});

function getBackendDir() {
    return __dirname;
}

function launchNodeBackend() {
    logVerbose("Starting backend server natively...");
    const backendDir = getBackendDir();
    try {
        const { startServer } = require(path.join(backendDir, 'dist-ts', 'server.js'));
        startServer(backendDir);
    } catch (err) {
        logError(`Failed to start native node server: ${err.message}`);
    }
}

function applyLockState() {
    if (!win || win.isDestroyed()) return;

    if (isLocked) {
        isClickThrough = true;
        win.setIgnoreMouseEvents(true, { forward: true });
        win.webContents.executeJavaScript(`
            (function() {
                const bar = document.getElementById('overlay-drag-bar');
                if (bar) bar.style.display = 'none';
                const border = document.getElementById('overlay-border');
                if (border) border.style.display = 'none';
                document.body.style.paddingTop = '0px';
            })();
        `).catch(err => logError(`Lock JS error: ${err.message}`));
    } else {
        isClickThrough = false;
        // On Windows, explicitly reset mouse ignore and restore window focus
        win.setIgnoreMouseEvents(false);
        win.setAlwaysOnTop(true, 'screen-saver');
        win.show();
        win.focus();
        win.webContents.executeJavaScript(`
            (function() {
                const bar = document.getElementById('overlay-drag-bar');
                if (bar) bar.style.display = 'flex';
                const border = document.getElementById('overlay-border');
                if (border) border.style.display = 'block';
                document.body.style.paddingTop = '30px';
            })();
        `).catch(err => logError(`Unlock JS error: ${err.message}`));
    }

    updateTrayMenu();
}

function createWindow() {
    const bounds = getValidatedWindowBounds();

    win = new BrowserWindow({
        ...bounds,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: true,
        webPreferences: { contextIsolation: true }
    });

    win.on('moved', saveWindowBounds);
    win.on('resized', saveWindowBounds);
    win.on('close', saveWindowBounds);

    win.webContents.on('render-process-gone', (event, details) => {
        logError(`Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
        if (isQuitting) return;
        const oldWin = win;
        win = null;
        try {
            if (oldWin && !oldWin.isDestroyed()) oldWin.destroy();
        } catch (e) {
        }
        logVerbose('Recreating window after renderer crash...');
        createWindow();
    });

    win.on('unresponsive', () => {
        logError('Window became unresponsive.');
    });
    win.on('responsive', () => {
        logVerbose('Window recovered from being unresponsive.');
    });

    win.webContents.on('did-fail-load', (e, code, desc, url) => {
        if (url.startsWith('http://127.0.0.1:5000') || url.startsWith('http://localhost:5000')) {
            setTimeout(() => {
                if (win && !win.isDestroyed()) win.loadURL('http://127.0.0.1:5000');
            }, 500);
        }
    });

    win.loadURL('http://127.0.0.1:5000');
    win.setAlwaysOnTop(true, 'screen-saver');

    win.webContents.on('context-menu', () => {
        const contextMenu = Menu.buildFromTemplate([
            {
                label: isLocked ? 'Unlock Overlay (Ctrl+Alt+L)' : 'Lock Overlay (Ctrl+Alt+L)',
                click: () => toggleMasterLock(),
            },
            {
                label: 'Refresh',
                click: () => win.loadURL('http://127.0.0.1:5000'),
            },
            {
                label: 'Toggle DevTools',
                click: () => win.webContents.toggleDevTools(),
            },
        ]);
        contextMenu.popup({ window: win });
    });

    win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(`
            if (!document.getElementById('overlay-drag-bar')) {
                const bar = document.createElement('div');
                bar.id = 'overlay-drag-bar';
                bar.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 30px; background: rgba(255, 0, 0, 0.8); color: white; display: flex; justify-content: center; align-items: center; font-weight: bold; font-family: sans-serif; z-index: 999999; -webkit-app-region: drag;';
                bar.innerText = 'UNLOCKED - DRAG TO MOVE (Edges to Resize)';
                document.body.appendChild(bar);
                
                const border = document.createElement('div');
                border.id = 'overlay-border';
                border.style.cssText = 'position: fixed; top: 30px; left: 0; width: 100%; height: calc(100% - 30px); border: 3px dashed red; box-sizing: border-box; z-index: 999998; pointer-events: none;';
                document.body.appendChild(border);
            }
        `).then(() => {
            applyLockState();
        }).catch(err => logError(`did-finish-load error: ${err.message}`));
    });
}

function toggleMasterLock() {
    isLocked = !isLocked;
    applyLockState();
}

function toggleInteraction() {
    if (!isLocked) return;
    isClickThrough = !isClickThrough;

    if (isClickThrough) {
        win.setIgnoreMouseEvents(true, { forward: true });
    } else {
        win.setIgnoreMouseEvents(false);
        win.focus();
    }
    updateTrayMenu();
}

function setupTray() {
    const iconPath = path.join(__dirname, 'static', 'app-icon.ico');
    const fallbackPath = path.join(__dirname, 'build', 'icon.ico');
    let trayIcon;

    if (fs.existsSync(iconPath)) {
        trayIcon = nativeImage.createFromPath(iconPath);
    } else if (fs.existsSync(fallbackPath)) {
        trayIcon = nativeImage.createFromPath(fallbackPath);
    } else {
        trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('StreamChat Overlay');
    tray.on('click', () => {
        if (tray) tray.popUpContextMenu();
    });
    updateTrayMenu();
}

function updateTrayMenu() {
    if (!tray) return;

    const contextMenu = Menu.buildFromTemplate([
        {
            label: isLocked ? '🔒 Overlay: LOCKED (Click to Unlock)' : '🔓 Overlay: UNLOCKED (Click to Lock)',
            click: () => toggleMasterLock()
        },
        {
            label: 'Hotkey: Ctrl+Alt+L',
            enabled: false
        },
        { type: 'separator' },
        {
            label: isClickThrough ? '🖱️ Mouse: Click-Through ON' : '🖱️ Mouse: Click-Through OFF',
            click: () => toggleInteraction(),
            enabled: isLocked
        },
        {
            label: 'Refresh Overlay',
            click: () => {
                if (win && !win.isDestroyed()) win.loadURL('http://127.0.0.1:5000');
            }
        },
        { type: 'separator' },
        {
            label: 'Exit StreamChat',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
}

app.commandLine.appendSwitch('limit-fps', '30');
app.disableHardwareAcceleration();

app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('media-cache-size', '1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('no-first-run');

app.whenReady().then(() => {
    if (!gotSingleInstanceLock) return;

    launchNodeBackend();
    createWindow();
    setupTray();

    const lockShortcuts = ['CommandOrControl+Alt+L'];
    lockShortcuts.forEach(sc => {
        const ok = globalShortcut.register(sc, toggleMasterLock);
        if (ok) logVerbose(`Registered lock shortcut: ${sc}`);
        else logError(`Failed to register lock shortcut: ${sc}`);
    });

    const interactShortcuts = ['CommandOrControl+Alt+I'];
    interactShortcuts.forEach(sc => {
        const ok = globalShortcut.register(sc, toggleInteraction);
        if (ok) logVerbose(`Registered interact shortcut: ${sc}`);
        else logError(`Failed to register interact shortcut: ${sc}`);
    });
});

app.on('window-all-closed', () => {
    logVerbose("All windows closed -- quitting app.");
    app.quit();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});