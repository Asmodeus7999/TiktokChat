import os
import ctypes
import multiprocessing
import threading
from flask import Flask, render_template, request
from flask_socketio import SocketIO
from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    ConnectEvent, CommentEvent, DisconnectEvent, 
    GiftEvent, LikeEvent, FollowEvent, JoinEvent, RoomUserSeqEvent
)
from TikTokLive.client.errors import UserOfflineError, AgeRestrictedError
app = Flask(__name__)

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

@app.route('/')
def index():
    return render_template('index.html', enable_sessionid_login=ENABLE_SESSIONID_LOGIN)

@socketio.on('connect_tiktok')
def handle_connect(data):
    username = data.get('username')

    # Ignore any sessionid/targetIdc the client sends unless the feature
    # is explicitly turned on server-side. This isn't just a UI hint --
    # it means this app can't be made to accept/forward a TikTok cookie
    # at all while the flag is off, even by someone bypassing the UI.
    if ENABLE_SESSIONID_LOGIN:
        sessionid = data.get('sessionid', '').strip() or None
        tt_target_idc = data.get('targetIdc', '').strip() or None
    else:
        sessionid = None
        tt_target_idc = None

    if not username:
        return
    username = username.lstrip('@')
 
    with session_lock:
        already_connected = (
          current_session['username'] == username
          and current_session['client'] is not None
          and getattr(current_session['client'],
            'connected', False))
 
    if already_connected:
        socketio.emit('status', {'connected': True, 'username': username})
        return
 
    disconnect_all()
 
    with session_lock:
        generation = current_session['generation']
 
    print(f"Connecting to {username}...")
 
    client_thread = threading.Thread(
      target=start_tiktok_client,
      args=(username, generation, sessionid, tt_target_idc))
    client_thread.daemon = True
    client_thread.start()

@socketio.on('disconnect')
def handle_disconnect():
    print("Browser disconnected. Stopping TikTok clients...")
    disconnect_all()

def optimize_process_impact():
    """Lowers priority and disables Core 0 natively using Windows API."""
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
        
        # 2. Prevent using Core 0 by applying a CPU bitmask
        core_count = multiprocessing.cpu_count()
        if core_count > 1:
            # Create a bitmask for all available cores (e.g., 4 cores = 1111 in binary)
            affinity_mask = (1 << core_count) - 1
            # Remove Core 0 (Bit 0) from the mask (e.g., 1111 becomes 1110)
            affinity_mask &= ~1 
            
            # Apply the new affinity mask
            kernel32.SetProcessAffinityMask(process_handle, affinity_mask)
            print("Process affinity applied: Core 0 is now disabled for this server.")
            
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
    socketio.run(app, host=host, port=port)