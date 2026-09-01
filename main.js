const { app, BrowserWindow, globalShortcut, Menu, dialog, screen } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let win;
let isLocked = false;
let isClickThrough = false;
let isQuitting = false;
let backendProcess = null;

// Prevents launching a second copy of the app. Without this, a double
// double-click (or a stray leftover instance from a crash) would spawn a
// second server.exe trying to bind the same port 5000 -- the second one
// fails, and you're left with two overlay windows or a broken one with no
// clear reason why.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        // Someone tried to launch a second instance -- bring the existing
        // window to the front instead of doing nothing (or worse, silently
        // failing).
        if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
    });
}

// Writes to a file since GUI-subsystem Electron apps don't print console.log
// to a terminal. Off by default -- only errors get logged so this doesn't
// grow forever during normal use. To re-enable full step-by-step tracing
// later (e.g. debugging a new issue), create an empty file named
// "enable-debug" next to main.js (or in resources/ when packaged).
const LOG_PATH = path.join(app.getPath('userData'), 'debug.log');
const VERBOSE = fs.existsSync(path.join(app.isPackaged ? process.resourcesPath : __dirname, 'enable-debug'));

// Remembers window position/size across launches so the user doesn't have
// to drag/resize it every time.
const BOUNDS_PATH = path.join(app.getPath('userData'), 'window-bounds.json');
const DEFAULT_BOUNDS = { width: 400, height: 800 }; // no x/y -- let Electron center it the first time ever

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
        // No saved bounds yet (first ever launch) or file is corrupt -- fall back to default
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

// Loads saved bounds and checks the saved x/y is still within some
// currently connected display -- e.g. if the window was last on a second
// monitor that's since been unplugged, restoring that x/y would put the
// window off-screen and unreachable. Falls back to just width/height
// (Electron centers it) if the saved position is no longer valid.
function getValidatedWindowBounds() {
    const bounds = loadWindowBounds();
    if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
        return bounds; // no saved position (first launch) -- nothing to validate
    }

    const displays = screen.getAllDisplays();
    const fitsOnSomeDisplay = displays.some(({ workArea }) => {
        // Require at least a corner of the window to be visible on this display
        return (
            bounds.x < workArea.x + workArea.width &&
            bounds.x + bounds.width > workArea.x &&
            bounds.y < workArea.y + workArea.height &&
            bounds.y + bounds.height > workArea.y
        );
    });

    if (fitsOnSomeDisplay) return bounds;

    logVerbose('Saved window position is off-screen (display changed) -- falling back to centered default.');
    return { width: bounds.width, height: bounds.height };
}

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

// Restricts a process to specific CPU cores. mask is a bitmask:
// core 0 = 1, core 1 = 2, core 2 = 4, core 3 = 8, etc.
// Cores 0, 1, 2 and 3 => 1 + 2 + 4 + 8 = 15
const CPU_AFFINITY_MASK = 15;

function setProcessAffinity(pid, mask) {
    try {
        execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessorAffinity = [IntPtr]${mask}"`);
        logVerbose(`Set CPU affinity for PID ${pid} to mask ${mask}`);
    } catch (err) {
        logVerbose(`Failed to set CPU affinity for PID ${pid} (expected for short-lived child processes)`);
    }
}

// Electron spawns several child processes under the same exe (GPU process,
// renderer(s), utility/network process, etc.) -- each is its own PID and
// does NOT inherit affinity from the parent. Setting this on process.pid
// alone only covers the main/browser process. This walks the whole
// descendant tree of a given root PID and applies affinity to every
// process found. (Priority is intentionally NOT touched here -- Electron
// runs at whatever priority Windows assigns by default, and server.exe
// manages its own priority independently in server.py.)
function getChildPids(pid) {
    try {
        const out = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId"`
        ).toString();
        return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number);
    } catch (err) {
        logError(`Failed to enumerate children of PID ${pid}: ${err.message}`);
        return [];
    }
}

function applyAffinityToTree(rootPid) {
    const seen = new Set();
    const queue = [rootPid];
    while (queue.length) {
        const pid = queue.shift();
        if (seen.has(pid)) continue;
        seen.add(pid);
        setProcessAffinity(pid, CPU_AFFINITY_MASK);
        for (const childPid of getChildPids(pid)) {
            queue.push(childPid);
        }
    }
    logVerbose(`Applied affinity to process tree rooted at ${rootPid}: [${[...seen].join(', ')}]`);
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

function createWindow() {
    const bounds = getValidatedWindowBounds();

    win = new BrowserWindow({
        ...bounds, // spreads width, height, and x/y if we have a saved position
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: true,
        webPreferences: { contextIsolation: true }
    });

    // Save whenever the user finishes dragging or resizing, and once more
    // on close as a safety net in case the last change didn't get caught.
    win.on('moved', saveWindowBounds);
    win.on('resized', saveWindowBounds);
    win.on('close', saveWindowBounds);

    // If the Chromium renderer crashes (GPU driver issue, OOM, etc.) the
    // window would otherwise just sit there blank forever with no way to
    // recover short of a full app relaunch. Recreate it automatically.
    win.webContents.on('render-process-gone', (event, details) => {
        logError(`Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
        if (isQuitting) return;
        const oldWin = win;
        win = null;
        try {
            if (oldWin && !oldWin.isDestroyed()) oldWin.destroy();
        } catch (e) {
            // Ignore -- already gone
        }
        logVerbose('Recreating window after renderer crash...');
        createWindow();
    });

    // Renderer went unresponsive (hung script, deadlock, etc.). Don't
    // auto-kill it -- it may recover -- but log it so it's visible in
    // debug.log if the user reports the app "freezing".
    win.on('unresponsive', () => {
        logError('Window became unresponsive.');
    });
    win.on('responsive', () => {
        logVerbose('Window recovered from being unresponsive.');
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

        // Page has finished loading. Affinity is already active (set at
        // spawn time). Priority is intentionally left at whatever Windows
        // assigns by default for the Electron process -- no explicit
        // priority call here anymore. server.py still manages its own
        // priority independently (BelowNormal, set at its own startup).
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

// Limit overlay to 30 FPS to save resources for the game
app.commandLine.appendSwitch('limit-fps', '30');

app.whenReady().then(() => {
    if (!gotSingleInstanceLock) return; // second instance -- already quitting

    // Affinity applied immediately for the Electron main process -- hard
    // constraint we always want active. Priority is intentionally left
    // untouched -- Electron runs at whatever priority Windows assigns by
    // default.
    applyAffinityToTree(process.pid);

    launchNodeBackend();

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
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});