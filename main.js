const { app, BrowserWindow, globalShortcut, Menu, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let win;
let isLocked = false;
let isClickThrough = false;
let isQuitting = false;
let backendProcess = null;

// Writes to a file since GUI-subsystem Electron apps don't print console.log
// to a terminal. Off by default -- only errors get logged so this doesn't
// grow forever during normal use. To re-enable full step-by-step tracing
// later (e.g. debugging a new issue), create an empty file named
// "enable-debug" next to main.js (or in resources/ when packaged).
const LOG_PATH = path.join(app.getPath('userData'), 'debug.log');
const VERBOSE = fs.existsSync(path.join(app.isPackaged ? process.resourcesPath : __dirname, 'enable-debug'));

function logError(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_PATH, line);
    } catch (e) {
        // Ignore if userData dir isn't ready yet
    }
}
function logVerbose(msg) {
    if (VERBOSE) logError(msg);
}

process.on('uncaughtException', (err) => {
    logError(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});

function getBackendDir() {
    return app.isPackaged
        ? process.resourcesPath
        : __dirname;
}

function launchPythonBackend() {
    logVerbose("Starting backend server...");
    const backendDir = getBackendDir();
    const exePath = path.join(backendDir, 'server.exe');
    logVerbose(`Packaged: ${app.isPackaged}, exePath: ${exePath}`);

    if (!fs.existsSync(exePath)) {
        logError(`Backend exe not found at: ${exePath}`);
        dialog.showErrorBox(
            "Backend Not Found",
            `Could not find server.exe at:\n${exePath}\n\nMake sure server.exe is placed next to main.js (in dev) or was bundled correctly (in the packaged app).`
        );
        return;
    }
    logVerbose("server.exe found on disk, spawning...");

    try {
        backendProcess = spawn(exePath, [], {
            cwd: backendDir,
            windowsHide: true, // no visible console window
        });
        logVerbose(`spawn() called, pid: ${backendProcess.pid}`);
    } catch (err) {
        logError(`EXCEPTION during spawn(): ${err.message}`);
        return;
    }

    backendProcess.stdout.on('data', (data) => logVerbose(`[backend stdout] ${data}`));
    backendProcess.stderr.on('data', (data) => logError(`[backend stderr] ${data}`));
    backendProcess.on('error', (err) => logError(`SPAWN ERROR EVENT: ${err.message}`));
    backendProcess.on('exit', (code, signal) => {
        if (code !== 0) {
            logError(`Backend process exited abnormally. code=${code} signal=${signal}`);
        } else {
            logVerbose(`Backend process exited. code=${code} signal=${signal}`);
        }
        backendProcess = null;
    });
}

function killPythonBackend() {
    console.log("Stopping backend process...");
    if (backendProcess && backendProcess.pid) {
        try {
            // /T kills the process tree in case server.exe spawned children
            execSync(`taskkill /PID ${backendProcess.pid} /F /T`);
        } catch (e) {
            // Ignore if already closed
        }
        backendProcess = null;
    }
}

function createWindow() {
    win = new BrowserWindow({
        width: 400,
        height: 800,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: true,
        webPreferences: { contextIsolation: true }
    });

    win.loadURL('http://localhost:5000');
    win.setAlwaysOnTop(true, 'screen-saver');

    // No frame/menu bar means no built-in way to reload -- add a right-click
    // context menu as the only way to trigger it.
    win.webContents.on('context-menu', () => {
        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Refresh',
                click: () => win.loadURL('http://localhost:5000'),
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
                border.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: 3px dashed red; box-sizing: border-box; z-index: 999998; pointer-events: none;';
                document.body.appendChild(border);
            }
        `);
    });
}

function toggleMasterLock() {
    isLocked = !isLocked;

    if (isLocked) {
        isClickThrough = true;
        win.setIgnoreMouseEvents(true, { forward: true });
        win.webContents.executeJavaScript(`
            document.getElementById('overlay-drag-bar').style.display = 'none';
            document.getElementById('overlay-border').style.display = 'none';
        `);
    } else {
        isClickThrough = false;
        win.setIgnoreMouseEvents(false);
        win.webContents.executeJavaScript(`
            document.getElementById('overlay-drag-bar').style.display = 'flex';
            document.getElementById('overlay-border').style.display = 'block';
        `);
    }
}

function toggleInteraction() {
    if (!isLocked) return;
    isClickThrough = !isClickThrough;

    if (isClickThrough) {
        win.setIgnoreMouseEvents(true, { forward: true });
    } else {
        win.setIgnoreMouseEvents(false);
    }
}

app.whenReady().then(() => {
    launchPythonBackend();

    setTimeout(() => {
        createWindow();
        globalShortcut.register('CommandOrControl+Alt+F9', toggleMasterLock);
        globalShortcut.register('CommandOrControl+Alt+F7', toggleInteraction);
    }, 1500);
});

// Without this, Electron's default behavior on Windows/Linux is to quit
// the whole app the instant all windows close -- which would trigger the
// will-quit handler below and kill the backend prematurely if the window
// ever closes/crashes unexpectedly.
app.on('window-all-closed', () => {
    logVerbose("All windows closed -- quitting app.");
    app.quit();
});

// 🚨 GRACEFUL SHUTDOWN HANDLER
app.on('will-quit', async (e) => {
    if (!isQuitting) {
        // Pause exit to complete asynchronous cleanup
        e.preventDefault();
        isQuitting = true;
        globalShortcut.unregisterAll();

        console.log("Sending Ctrl+C equivalent shutdown signal to Python...");
        try {
            // Trigger the graceful shutdown endpoint in Flask
            await fetch('http://localhost:5000/shutdown', { method: 'POST' });
            console.log("Python acknowledged shutdown.");
        } catch (err) {
            console.log("Python server already stopped or unreachable.");
        }

        // Wait 500ms for TikTokLive WebSocket close handshake to finish
        setTimeout(() => {
            killPythonBackend();
            app.quit();
        }, 500);
    }
});