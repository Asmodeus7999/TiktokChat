# TikTok Live Chat Overlay

A simple real-time chat overlay for TikTok Live, made for OBS. It's built with Python (Flask) and WebSockets, and just connects to a public TikTok stream to show chat, gifts, likes, and viewer count — no TikTok account or login needed for normal use.

## What it does

- Shows live chat, gifts, follows, joins, and likes as they happen
- Works out of the box with public streams, no login required
- Has a transparent, styled UI that's made to be dropped straight into OBS as a Browser Source
- Can optionally log in with a TikTok cookie if you need to watch an age-restricted (18+) stream — this is turned off unless you ask for it, more on that below

## Getting it running

1. Grab the code:
   ```bash
   git clone [https://github.com/yourusername/tiktok-chat-overlay.git](https://github.com/yourusername/tiktok-chat-overlay.git)
   cd tiktok-chat-overlay
   ```

2. Install what it needs (Python 3.8+):
   ```bash
   pip install Flask flask-socketio TikTokLive
   ```

3. Run it:
   ```bash
   python server.py
   ```

That's it — it'll start at `http://127.0.0.1:5000`, reachable only from your own machine. You don't need to set anything else unless you want to change how it behaves, which is what the next section covers.

## How to show it on your screen 

1. Add a **Browser Source** to your scene or Docks (maybe need to change the css transparent background) in OBS. Or you can use     [Transparent Twitch Chat Overlay](https://github.com/baffler/Transparent-Twitch-Chat-Overlay).
2. Point it at `http://localhost:5000`.
3. Set the width/height to whatever fits your layout (400×800 works well as a starting point).
4. Click into the source, type your `@username`, hit Connect. The setup screen fades out and you're left with just the chat feed.

One small thing to know: since it connects anonymously, the like counter starts at 0 and jumps to the real total as soon as the first new like comes in — that's expected, not a bug.

## Changing how it runs (optional)

Everything below is optional — the defaults are the settings you'd want for normal use, so skip this unless you have a specific reason to change something.

**Watching an age-restricted stream.** By default the app doesn't ask for or accept a TikTok cookie at all — it's simply not there. If you actually run into a stream that needs it, turn it on with:
```bash
ENABLE_SESSIONID_LOGIN=true python server.py
```
That brings back an "Age restricted stream" option on the setup screen where you can paste in your `sessionid` and `tt-target-idc` cookies from tiktok.com. Worth knowing before you do: pasting those in means your TikTok session gets sent to a third-party service (`api.eulerstream.com`) so it can authenticate the connection for you. The app itself never saves it anywhere, but it's still your real account cookie leaving your machine, so only turn this on when you actually need it, and only if you're OK trusting that service.

## Building the desktop app

If you'd rather run this as a standalone Windows app (a floating overlay window) instead of a browser tab, there's an Electron wrapper included. This packages everything — including a bundled Python backend — into a folder that runs with no Python or dependencies required on the machine that runs it.

**1. Install Python dependencies and PyInstaller:**
```bash
pip install -r requirements.txt
```

**2. Build the Python backend into a standalone exe:**
```bash
pyinstaller server.spec
```
This produces `dist\server.exe`, a single file with Python, Flask, and TikTokLive all bundled in. You'll need to rebuild this any time you change `server.py`.

**3. Install Electron and electron-builder:**
```bash
npm install --save-dev electron electron-builder
```

**4. Build the desktop app:**
```bash
npm run dist
```
This copies `dist\server.exe` plus `static/` and `templates/` into `release\win-unpacked\`, alongside the Electron shell. No installer is produced — just a runnable folder.

**5. Run it:**
```bash
release\win-unpacked\TiktokChat.exe
```

### Controls
 
The overlay starts **unlocked** — you'll see a red drag bar and dashed border, and can click through it normally to move or resize it into position.
 
| Shortcut | Action |
|---|---|
| `Ctrl+Alt+F9` | Toggle lock. Locked = click-through (mouse passes through to whatever's behind it, e.g. your game or stream), drag bar/border hidden. Unlocked = draggable/resizable again. |
| `Ctrl+Alt+F7` | While locked, toggle click-through on/off without fully unlocking — lets you briefly interact with the overlay (e.g. scroll chat) then pass mouse input through again. |
| Right-click | Opens a small menu with **Refresh** (reload the page, useful if the connection drops) and **Toggle DevTools** (for troubleshooting). |
 
One thing to know: right-click only works while the overlay is **unlocked**, or briefly interactive via `Ctrl+Alt+F7`. When it's locked and click-through, all mouse input — including right-clicks — passes straight through to whatever's underneath, so the menu won't appear until you unlock it.
