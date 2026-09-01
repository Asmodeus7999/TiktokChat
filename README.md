# StreamChat Overlay
## A VibeCoded Project

A real-time chat overlay for **TikTok Live** and **YouTube Live**, made for OBS. Built with **Node.js**, **Express**, and **TypeScript** (previously Python/Flask). It connects to a public stream via WebSockets to show live chat, gifts, and viewer events. No account or login needed for normal use.

## What it does

- Shows live chat from **TikTok** or **YouTube** streams in real-time
- Works out of the box with public streams — no login required
- Has a transparent, styled UI that drops straight into OBS as a Browser Source or runs as a standalone floating overlay window
- **TikTok**: shows chat, gifts (with CDN icons), follows, joins, and likes with live viewer and like counts
- **YouTube**: shows live chat and Super Chats (displayed as gifts), with a clean chat-only layout

## Getting it running

1. Grab the code:
   ```bash
   git clone https://github.com/Asmodeus7999/StreamChatOverlay.git
   cd StreamChatOverlay
   ```

2. Install Node.js dependencies:
   ```bash
   npm install
   ```

3. Run it (this will start the local server and the Electron app):
   ```bash
   npm run start
   ```

That's it — starts at `http://localhost:5000` under the hood.

## How to use it in OBS

1. Add a **Browser Source** to your scene in OBS.
2. Point it at `http://localhost:5000`.
3. Set the width/height to match your layout (400×800 is a good starting point).
4. Select your platform (**TikTok** or **YouTube**), enter your stream info, and hit **Connect to Live**.
5. The setup screen fades out and you're left with just the chat feed.

**TikTok**: Enter your `@username` (e.g. `yourname`).

**YouTube**: Paste the full stream URL (e.g. `https://www.youtube.com/watch?v=xxxxxxxxxxx`).

## Building the desktop app

Run this as a standalone floating overlay window on Windows (no browser required). Everything — including the Node backend — gets packaged into a single folder.

**1. Build the desktop app:**
```bash
npm run dist
```
This compiles the TypeScript files and runs Electron Builder. It places all the bundled files into the `release\win-unpacked\` folder.

**2. Run it:**
```bash
release\win-unpacked\StreamChat.exe
```

### Controls

The overlay starts **unlocked** — you'll see a red drag bar and dashed border so you can position and resize it.

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+F9` | Toggle lock. Locked = click-through (mouse passes through to whatever's behind it, e.g. your game), drag bar/border hidden. Unlocked = draggable/resizable. |
| `Ctrl+Alt+F7` | While locked, toggle click-through on/off without fully unlocking — lets you briefly interact with the overlay (e.g. scroll chat) then pass mouse input through again. |
| Right-click | Opens a menu with **Refresh** and **Toggle DevTools**. Only works while unlocked or briefly interactive via `Ctrl+Alt+F7`. |

## License

ISC
