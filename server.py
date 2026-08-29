import os
import sys
import ctypes
import multiprocessing
import threading
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO
import pytchat
from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    ConnectEvent, CommentEvent, DisconnectEvent, 
    GiftEvent, LikeEvent, FollowEvent, JoinEvent, RoomUserSeqEvent
)
from TikTokLive.client.errors import UserOfflineError, AgeRestrictedError

# When frozen by PyInstaller (--onefile), sys.executable is the exe's real
# path and the app's files get extracted to a temp folder at runtime.
# templates/ and static/ are shipped alongside the exe (not baked into it),
# so Flask needs to be pointed at that real location explicitly -- its
# default relative lookup would otherwise search the temp extraction dir
# and raise TemplateNotFound.
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static'),
)

# By default only accept Socket.IO connections whose Origin header matches
# where this app itself is served from (localhost). This prevents an
# unrelated website open in the same browser -- or any other device on the
# network -- from connecting to this server and issuing commands
# (e.g. connect_tiktok) or reading chat data.
#
# If you need to reach this app from another device (e.g. OBS on a
# different machine), set ALLOWED_ORIGINS to a comma-separated list of the
# exact origins you trust, e.g.:
#   ALLOWED_ORIGINS="http://192.168.1.20:5000" python server.py
_default_origins = [
    "http://localhost:5000",
    "http://127.0.0.1:5000",
]
_env_origins = os.environ.get('ALLOWED_ORIGINS', '').strip()
allowed_origins = (
    [o.strip() for o in _env_origins.split(',') if o.strip()]
    if _env_origins else _default_origins
)

socketio = SocketIO(app, cors_allowed_origins=allowed_origins, async_mode='threading')

# Off by default. The sessionid/tt-target-idc login (for age-restricted
# streams) is not needed for normal use -- fetch_room_info=False means
# this app never needs an authenticated session to read public chat.
# Enabling it means a TikTok account cookie gets typed into this app and
# forwarded to a third-party sign server, so it's opt-in only.
#
# To turn it back on when you actually need it:
#   ENABLE_SESSIONID_LOGIN=true python server.py
ENABLE_SESSIONID_LOGIN = os.environ.get(
    'ENABLE_SESSIONID_LOGIN', 'false'
).strip().lower() in ('1', 'true', 'yes')

# Global state
session_lock = threading.Lock()
current_session = {'generation': 0, 'client': None,
  'username': None, 'thread': None}

import asyncio

def disconnect_all(timeout=5):
    with session_lock:
        client = current_session['client']
        thread = current_session['thread']
        current_session['client'] = None
        current_session['username'] = None
        current_session['generation'] += 1
 
    if client is not None:
        try:
            if hasattr(client, 'terminate'):
                client.terminate()
            else:
                loop = getattr(client, 'loop',
                  getattr(client, '_asyncio_loop', None))
                if loop and loop.is_running():
                    future = asyncio.run_coroutine_threadsafe(
                      client.disconnect(), loop)
                    try:
                        future.result(timeout=timeout)
                    except Exception as e:
                        print(f"Timed out: {e}")
        except Exception as e:
            print(f"Error disconnecting: {e}")
 
    if thread is not None and thread.is_alive():
        thread.join(timeout=timeout)
        if thread.is_alive():
            # It didn't stop in time -- this can happen if TikTokLive is
            # slow to close its socket. That thread's event handlers all
            # check the generation counter before emitting anything (see
            # is_current() in start_tiktok_client), so it can no longer
            # affect the browser or the active session even though the
            # OS thread/socket is still winding down in the background.
            print("Warning: thread still alive")

def start_tiktok_client(username, generation, sessionid=None, tt_target_idc=None):
    try:
        # Initialize the client with the given username
        client = TikTokLiveClient(unique_id=username)
        # For age-restricted streams, set the session cookies on the client's
        # web/http layer. This is the API the current TikTokLive version expects
        # (passing cookies via web_kwargs is no longer supported and raises a
        # TypeError, which used to crash silently in this background thread).
        if sessionid:
            if not tt_target_idc:
                raise ValueError(
                    "A Target IDC is required alongside the Session ID. "
                    "Grab the 'tt-target-idc' cookie from tiktok.com (same place you got sessionid) "
                    "and paste it into the Target IDC field."
                )

            # TikTokLive deliberately refuses to send a sessionid to the sign
            # server unless this host is explicitly whitelisted, because the
            # sign server (a third party by default) receives your sessionid
            # to sign WebSocket requests. Only do this if you trust the sign
            # server and understand a leaked sessionid grants account access.
            os.environ['WHITELIST_AUTHENTICATED_SESSION_ID_HOST'] = 'api.eulerstream.com'
            print(
                "WARNING: sending your TikTok sessionid to the sign server (api.eulerstream.com) "
                "to authenticate this connection. Only proceed if you trust that service."
            )
            client.web.set_session(session_id=sessionid, tt_target_idc=tt_target_idc)
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = f"{type(e).__name__}: {str(e)}"
        print(f"Error: {error_msg}")
        socketio.emit('status', {'connected': False, 'error': error_msg})
        return
    with session_lock:
        if current_session['generation'] != generation:
            return
        current_session['client'] = client
        current_session['username'] = username
        current_session['thread'] = threading.current_thread()

    def is_current():
        # True only while this thread's connection is still the active
        # one. If a previous connect/disconnect cycle left this thread
        # running longer than expected (e.g. TikTokLive was slow to
        # actually close the socket), this stops it from emitting stale
        # messages into whatever stream is now connected, and avoids
        # wasted work/socketio traffic from a connection nobody's using
        # anymore.
        with session_lock:
            return current_session['generation'] == generation

    @client.on(ConnectEvent)
    async def on_connect(event: ConnectEvent):
        if not is_current():
            return
        print(f"Connected to @{event.unique_id} (Room ID: {client.room_id})")
        socketio.emit('status', {'connected': True, 'username': event.unique_id})

    def get_avatar_url(user):
        # avatar_thumb is an ImageModel with a url_list attribute
        for field in ('avatar_large', 'avatar_medium', 'avatar_thumb', 'avatar_jpg'):
            try:
                model = getattr(user, field, None)
                if model is None:
                    continue
                # It's an ImageModel object — grab the first URL from url_list
                url_list = getattr(model, 'url_list', None)
                if url_list and len(url_list) > 0:
                    return url_list[0]
                # Fallback: maybe it's a plain string
                if isinstance(model, str) and model.startswith('http'):
                    return model
            except Exception:
                continue
        return None

    @client.on(CommentEvent)
    async def on_comment(event: CommentEvent):
        if not is_current():
            return
        message = {
            'type': 'chat',
            'nickname': getattr(event.user, 'nickname', 'User'),
            'comment': event.comment,
            'profilePictureUrl': get_avatar_url(event.user)
        }
        socketio.emit('chatMessage', message)

    @client.on(GiftEvent)
    async def on_gift(event: GiftEvent):
        if not is_current():
            return
        # Gifts can be streakable. We usually only want to alert when it's fully sent, but TikTokLive triggers on each streak or end of streak.
        message = {
            'type': 'gift',
            'nickname': getattr(event.user, 'nickname', 'User'),
            'giftName': event.gift.info.name if hasattr(event.gift, 'info') else 'a gift',
            'repeatCount': event.gift.count if hasattr(event.gift, 'count') else 1,
            'profilePictureUrl': get_avatar_url(event.user)
        }
        socketio.emit('chatMessage', message)

    @client.on(LikeEvent)
    async def on_like(event: LikeEvent):
        if not is_current():
            return
        # 'total' = total likes for the entire live, 'count' = likes in this batch
        total = getattr(event, 'total', None)
        count = getattr(event, 'count', 1)
        message = {
            'type': 'like',
            'nickname': getattr(event.user, 'nickname', 'User'),
            'likeCount': count,
            'totalLikes': total,
            'profilePictureUrl': get_avatar_url(event.user)
        }
        socketio.emit('chatMessage', message)

    @client.on(FollowEvent)
    async def on_follow(event: FollowEvent):
        if not is_current():
            return
        message = {
            'type': 'follow',
            'nickname': getattr(event.user, 'nickname', 'User'),
            'profilePictureUrl': get_avatar_url(event.user)
        }
        socketio.emit('chatMessage', message)

    @client.on(JoinEvent)
    async def on_join(event: JoinEvent):
        if not is_current():
            return
        message = {
            'type': 'join',
            'nickname': getattr(event.user, 'nickname', 'User'),
            'profilePictureUrl': get_avatar_url(event.user)
        }
        socketio.emit('chatMessage', message)

    @client.on(RoomUserSeqEvent)
    async def on_viewer_count(event: RoomUserSeqEvent):
        if not is_current():
            return
        socketio.emit('viewerCount', {'viewers': getattr(event, 'total', getattr(event, 'viewer_count', 0))})

    @client.on(DisconnectEvent)
    async def on_disconnect(event: DisconnectEvent):
        if not is_current():
            return
        print("Disconnected")
        socketio.emit('status', {'connected': False})

# Start the client
    try:
        client.run(fetch_room_info=False)
    except UserOfflineError:
        # Expected/routine outcome, not a bug -- skip the traceback noise.
        error_msg = f"@{username} is offline"
        print(error_msg)
        socketio.emit('status', {
            'connected': False,
            'error': error_msg,
            'errorType': 'UserOfflineError'
        })
    except AgeRestrictedError:
        # Also expected/routine -- happens when no sessionid was supplied
        # for a stream that requires one. Not a stale cookie, not a bug.
        error_msg = f"@{username} is age-restricted. Add your sessionid cookie to view it."
        print(error_msg)
        socketio.emit('status', {
            'connected': False,
            'error': error_msg,
            'errorType': 'AgeRestrictedError'
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = f"{type(e).__name__}: {str(e)}"
        print(f"Error: {error_msg}")
        socketio.emit('status', {
            'connected': False,
            'error': error_msg,
            'errorType': type(e).__name__
        })
    finally:
        with session_lock:
            if current_session.get('client') is client:
                current_session['client'] = None
                current_session['username'] = None
                current_session['thread'] = None

def start_youtube_client(video_id, generation):
    try:
        import re
        # Extract video ID from URL if user passed a URL
        if "youtube.com" in video_id or "youtu.be" in video_id:
            match = re.search(r'(?:v=|youtu\.be/|/v/|/embed/|/shorts/)([^&?]+)', video_id)
            if match:
                video_id = match.group(1)
        
        chat = pytchat.create(video_id=video_id, interruptable=False)
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = f"{type(e).__name__}: {str(e)}"
        print(f"Error: {error_msg}")
        socketio.emit('status', {'connected': False, 'error': error_msg})
        return
        
    with session_lock:
        if current_session['generation'] != generation:
            chat.terminate()
            return
        current_session['client'] = chat
        current_session['username'] = video_id
        current_session['thread'] = threading.current_thread()
        
    def is_current():
        with session_lock:
            return current_session['generation'] == generation

    print(f"Connected to YouTube Live (Video ID: {video_id})")
    socketio.emit('status', {'connected': True, 'username': video_id})
    
    try:
        while chat.is_alive() and is_current():
            for c in chat.get().sync_items():
                if not is_current():
                    break
                
                # Check for Super Chat
                if c.amountValue > 0:
                    message = {
                        'type': 'gift',
                        'nickname': c.author.name,
                        'giftName': f"SuperChat {c.amountString}",
                        'repeatCount': 1,
                        'profilePictureUrl': c.author.imageUrl
                    }
                else:
                    message = {
                        'type': 'chat',
                        'nickname': c.author.name,
                        'comment': c.message,
                        'profilePictureUrl': c.author.imageUrl
                    }
                socketio.emit('chatMessage', message)
                
            import time
            time.sleep(1) # sleep briefly to prevent tight loop
            
        if is_current():
            print("YouTube Live disconnected.")
            socketio.emit('status', {'connected': False})
            
    except Exception as e:
        import traceback
        traceback.print_exc()
        error_msg = f"{type(e).__name__}: {str(e)}"
        print(f"Error: {error_msg}")
        if is_current():
            socketio.emit('status', {'connected': False, 'error': error_msg})
    finally:
        chat.terminate()
        with session_lock:
            if current_session.get('client') is chat:
                current_session['client'] = None
                current_session['username'] = None
                current_session['thread'] = None

@app.route('/')
def index():
    return render_template('index.html', enable_sessionid_login=ENABLE_SESSIONID_LOGIN)

@socketio.on('connect_stream')
def handle_connect_stream(data):
    platform = data.get('platform', 'tiktok')
    identifier = data.get('username') or data.get('videoId')
    
    if platform == 'tiktok':
        if ENABLE_SESSIONID_LOGIN:
            sessionid = data.get('sessionid', '').strip() or None
            tt_target_idc = data.get('targetIdc', '').strip() or None
        else:
            sessionid = None
            tt_target_idc = None
            
    if not identifier:
        return
        
    if platform == 'tiktok':
        identifier = identifier.lstrip('@')
        
    with session_lock:
        client = current_session['client']
        is_connected = False
        if client is not None:
            if hasattr(client, 'is_alive'):
                is_connected = client.is_alive()
            else:
                is_connected = getattr(client, 'connected', False)
                
        already_connected = (
          current_session['username'] == identifier
          and is_connected
        )
          
    if already_connected:
        socketio.emit('status', {'connected': True, 'username': identifier})
        return
        
    disconnect_all()
    
    with session_lock:
        generation = current_session['generation']
        
    print(f"Connecting to {platform} ({identifier})...")
    
    if platform == 'tiktok':
        client_thread = threading.Thread(
          target=start_tiktok_client,
          args=(identifier, generation, sessionid, tt_target_idc))
    else:
        client_thread = threading.Thread(
          target=start_youtube_client,
          args=(identifier, generation))
          
    client_thread.daemon = True
    client_thread.start()

@socketio.on('disconnect')
def handle_disconnect():
    print("Browser disconnected. Stopping TikTok clients...")
    disconnect_all()

def optimize_process_impact():
    """Lowers this process's scheduling priority to BelowNormal using the
    Windows API. CPU affinity is intentionally NOT set here -- main.js
    sets affinity for this process (and the Electron process) right after
    spawning it, so this only owns priority to avoid the two fighting
    over the same setting."""
    if os.name != 'nt':
        print("Notice: OS is not Windows. Skipping hardware optimizations.")
        return

    try:
        kernel32 = ctypes.windll.kernel32
        process_handle = kernel32.GetCurrentProcess()
        
        # 1. Set to Below Normal Priority (0x00004000)
        BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
        kernel32.SetPriorityClass(process_handle, BELOW_NORMAL_PRIORITY_CLASS)
        print("Process priority set to BELOW_NORMAL to reduce game stutters.")
        
        # 2. CPU affinity is intentionally NOT set here anymore.
        # main.js now sets affinity for this process (and the Electron
        # process) right after spawning it, so setting it here too would
        # just race with that and get overwritten anyway.
        
    except Exception as e:
        print(f"Notice: Could not apply hardware optimizations: {e}")

if __name__ == '__main__':
    optimize_process_impact()

    # Bind to localhost only by default. This app accepts a TikTok
    # "sessionid" cookie (full account access) over plain HTTP/WebSocket
    # with no encryption -- binding to 0.0.0.0 would broadcast that cookie
    # in plaintext to anyone on the same network who can sniff traffic.
    #
    # Only change HOST if you specifically need another device (e.g. a
    # separate OBS machine) to reach this server, understand the traffic
    # is unencrypted, and are on a network you trust:
    #   HOST=0.0.0.0 python server.py
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', 5000))

    if host not in ('127.0.0.1', 'localhost'):
        print(
            f"WARNING: binding to {host}, which exposes this server beyond "
            "this machine. Traffic (including your TikTok sessionid, if "
            "you enter one) is NOT encrypted. Only do this on a network "
            "you trust, or put a TLS reverse proxy in front of it."
        )

    print(f"Server running at http://{host}:{port}")
    # This app runs as a local, single-user overlay tool (bound to
    # 127.0.0.1 by default) rather than a public production deployment,
    # so Werkzeug's dev-server safety guard doesn't apply here -- newer
    # flask-socketio versions hard-crash on startup without this flag.
    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)

@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Gracefully disconnects TikTok client and stops the server."""
    print("Received shutdown request from Electron. Closing connections...")

    # 1. Stop the TikTokLive client gracefully if it's running
    try:
        disconnect_all()
        print("TikTok WebSocket connection closed cleanly.")
    except Exception as e:
        print(f"Error stopping client: {e}")
            
    # 2. Schedule process exit so Flask can send the response first
    def stop_server():
        import time
        time.sleep(0.5)
        os._exit(0)
        
    threading.Thread(target=stop_server).start()
    return jsonify({"status": "shutting down"}), 200