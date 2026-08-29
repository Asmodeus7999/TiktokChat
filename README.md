# StreamChat Overlay
## A VibeCoded Project

A real-time chat overlay for **TikTok Live** and **YouTube Live**, made for OBS. Built with Python (Flask) and WebSockets � connects to a public stream to show live chat, gifts, and viewer events. No account or login needed for normal use.

## What it does

- Shows live chat from **TikTok** or **YouTube** streams in real-time
- Works out of the box with public streams � no login required
- Has a transparent, styled UI that drops straight into OBS as a Browser Source or runs as a standalone floating overlay window
- **TikTok**: shows chat, gifts, follows, joins, and likes with live viewer and like counts
- **YouTube**: shows live chat and Super Chats (displayed as gifts), with a clean chat-only layout
- Can optionally log in with a TikTok cookie for age-restricted (18+) TikTok streams � turned off by default

## Getting it running

1. Grab the code:
   ```bash
   git clone https://github.com/Asmodeus7999/StreamChatOverlay.git
   cd StreamChatOverlay
   ```

2. Install Python dependencies (Python 3.8+):
   ```bash
   pip install Flask flask-socketio TikTokLive pytchat
   ```

3. Run it:
   ```bash
   python server.py
   ```

That's it � starts at `http://127.0.0.1:5000`, reachable only from your own machine.

## How to use it in OBS

1. Add a **Browser Source** to your scene in OBS.
2. Point it at `http://localhost:5000`.
3. Set the width/height to match your layout (400�800 is a good starting point).
4. Select your platform (**TikTok** or **YouTube**), enter your stream info, and hit **Connect to Live**.
5. The setup screen fades out and you're left with just the chat feed.

**TikTok**: Enter your `@username` (e.g. `yourname`).

**YouTube**: Paste the full stream URL (e.g. `https://www.youtube.com/watch?v=xxxxxxxxxxx`) or just the video ID.

One small thing to know: the TikTok like counter starts at 0 and jumps to the real total as soon as the first new like comes in � that's expected, not a bug.

## Changing how it runs (optional)

Everything below is optional � the defaults are fine for normal use.

**Watching an age-restricted TikTok stream.** By default the app doesn't ask for or accept a TikTok cookie at all. If you need it, enable it with:
```bash
ENABLE_SESSIONID_LOGIN=true python server.py
```
This brings back an "Age restricted stream" option on the setup screen where you can paste in your `sessionid` and `tt-target-idc` cookies from tiktok.com. Worth knowing: those cookies get sent to a third-party signing service (`api.eulerstream.com`) to authenticate the connection. The app never saves them, but it's still your real account cookie leaving your machine � only turn this on when you actually need it.

## Building the desktop app

Run this as a standalone floating overlay window on Windows (no browser required). Everything � including a bundled Python backend � gets packaged into a single folder.

**1. Install PyInstaller:**
```bash
pip install pyinstaller
```

**2. Build the Python backend:**
```bash
pyinstaller server.spec --clean --noconfirm
```
Produces `dist\server.exe` with Python, Flask, TikTokLive, and pytchat all bundled inside. Rebuild this any time you change `server.py`.

**3. Install Electron dependencies:**
```bash
npm install
```

**4. Build the desktop app:**
```bash
npm run dist
```
Copies `dist\server.exe` plus `static/` and `templates/` into `release\win-unpacked\`, alongside the Electron shell.

**5. Run it:**
```bash
release\win-unpacked\StreamChat.exe
```

### Controls

The overlay starts **unlocked** � you'll see a red drag bar and dashed border so you can position and resize it.

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+F9` | Toggle lock. Locked = click-through (mouse passes through to whatever's behind it, e.g. your game), drag bar/border hidden. Unlocked = draggable/resizable. |
| `Ctrl+Alt+F7` | While locked, toggle click-through on/off without fully unlocking � lets you briefly interact with the overlay (e.g. scroll chat) then pass mouse input through again. |
| Right-click | Opens a menu with **Refresh** and **Toggle DevTools**. Only works while unlocked or briefly interactive via `Ctrl+Alt+F7`. |

## License

ISC
