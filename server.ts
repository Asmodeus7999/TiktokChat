import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';

export function startServer(baseDir: string) {
    const app = express();
    const server = createServer(app);
    
    // Setup origins
    const defaultOrigins = [
        "http://localhost:5000",
        "http://127.0.0.1:5000",
    ];
    const envOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : defaultOrigins;
    
    const io = new Server(server, {
        cors: {
            origin: envOrigins
        }
    });

    // Serve static files
    app.use('/static', express.static(path.join(baseDir, 'static')));

    // Serve index
    app.get('/', (req, res) => {
        res.sendFile(path.join(baseDir, 'templates', 'index.html'));
    });

    let currentSession: {
        client: any;
        type: 'tiktok' | 'youtube' | null;
        username: string | null;
        generation: number;
    } = {
        client: null,
        type: null,
        username: null,
        generation: 0
    };

    function disconnectAll() {
        if (currentSession.client) {
            try {
                if (currentSession.type === 'tiktok') {
                    currentSession.client.removeAllListeners();
                    currentSession.client.disconnect();
                } else if (currentSession.type === 'youtube') {
                    currentSession.client.removeAllListeners();
                    currentSession.client.stop();
                }
            } catch (e) {
                console.error("Error disconnecting client", e);
            }
        }
        currentSession.client = null;
        currentSession.type = null;
        currentSession.username = null;
        currentSession.generation += 1;
    }



    function startTiktokClient(username: string, generation: number) {
        try {
            const { TikTokLiveConnection } = require('tiktok-live-connector');
            const tiktokLiveConnection = new TikTokLiveConnection(username, {});
            
            currentSession.client = tiktokLiveConnection;
            currentSession.type = 'tiktok';
            currentSession.username = username;

            const isCurrent = () => currentSession.generation === generation;

            tiktokLiveConnection.on('connected', (state: any) => {
                if (!isCurrent()) return;
                console.log(`Connected to @${username}`);
                io.emit('status', { connected: true, username: username });
            });

            tiktokLiveConnection.on('chat', (data: any) => {
                if (!isCurrent()) return;
                io.emit('chatMessage', {
                    type: 'chat',
                    nickname: data.nickname || data.user?.nickname || data.user?.uniqueId || 'User',
                    comment: data.content || data.comment || '',
                    profilePictureUrl: data.profilePictureUrl || data.user?.profilePictureUrl || (data.user?.avatarThumb?.urlList && data.user.avatarThumb.urlList[0]) || ''
                });
            });

            tiktokLiveConnection.on('gift', (data: any) => {
                if (!isCurrent()) return;
                // Gift type 1 = combo/streak gift (e.g. roses sent in rapid succession)
                // TikTok fires the event on every tap AND again when the streak ends (repeatEnd=true)
                // We only want to show it once — at the end of the streak
                const giftType = data.gift?.type ?? data.gift?.info?.type;
                if (giftType === 1 && !data.repeatEnd) {
                    return; // Streak still in progress, skip until repeatEnd
                }
                io.emit('chatMessage', {
                    type: 'gift',
                    nickname: data.nickname || data.user?.nickname || data.user?.uniqueId || 'User',
                    giftName: data.giftName || data.gift?.name || 'a gift',
                    repeatCount: data.repeatCount || data.gift?.count || 1,
                    giftIconUrl: data.gift?.image?.urlList?.[0] || data.gift?.icon?.urlList?.[0] || '',
                    profilePictureUrl: data.profilePictureUrl || data.user?.profilePictureUrl || (data.user?.avatarThumb?.urlList && data.user.avatarThumb.urlList[0]) || ''
                });
            });

            tiktokLiveConnection.on('like', (data: any) => {
                if (!isCurrent()) return;
                io.emit('chatMessage', {
                    type: 'like',
                    nickname: data.nickname || data.user?.nickname || data.user?.uniqueId || 'User',
                    likeCount: data.likeCount || data.count || 1,
                    totalLikes: data.totalLikeCount || data.total || 0,
                    profilePictureUrl: data.profilePictureUrl || data.user?.profilePictureUrl || (data.user?.avatarThumb?.urlList && data.user.avatarThumb.urlList[0]) || ''
                });
            });

            tiktokLiveConnection.on('follow', (data: any) => {
                if (!isCurrent()) return;
                io.emit('chatMessage', {
                    type: 'follow',
                    nickname: data.nickname || data.user?.nickname || data.user?.uniqueId || 'User',
                    profilePictureUrl: data.profilePictureUrl || data.user?.profilePictureUrl || (data.user?.avatarThumb?.urlList && data.user.avatarThumb.urlList[0]) || ''
                });
            });

            tiktokLiveConnection.on('member', (data: any) => {
                if (!isCurrent()) return;
                io.emit('chatMessage', {
                    type: 'join',
                    nickname: data.nickname || data.user?.nickname || data.user?.uniqueId || 'User',
                    profilePictureUrl: data.profilePictureUrl || data.user?.profilePictureUrl || (data.user?.avatarThumb?.urlList && data.user.avatarThumb.urlList[0]) || ''
                });
            });

            tiktokLiveConnection.on('roomUser', (data: any) => {
                if (!isCurrent()) return;
                io.emit('viewerCount', { viewers: data.total || data.viewerCount || 0 });
            });

            tiktokLiveConnection.on('disconnected', () => {
                if (!isCurrent()) return;
                console.log("Disconnected");
                io.emit('status', { connected: false });
            });

            tiktokLiveConnection.on('error', (err) => {
                if (!isCurrent()) return;
                console.error("TikTok Error:", err);
                io.emit('status', { connected: false, error: err.message || String(err) });
            });

            tiktokLiveConnection.connect().catch(err => {
                if (!isCurrent()) return;
                console.error("TikTok Connect Error:", err);
                io.emit('status', { connected: false, error: err.message || String(err) });
            });

        } catch (e: any) {
            console.error("Error starting tiktok client", e);
            io.emit('status', { connected: false, error: e.message || String(e) });
        }
    }

    function startYoutubeClient(videoId: string, generation: number) {
        try {
            let id = videoId;
            const match = videoId.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/|\/shorts\/)([^&?]+)/);
            if (match) {
                id = match[1];
            }

            const { LiveChat } = require('youtube-chat');
            const liveChat = new LiveChat({ liveId: id });
            
            currentSession.client = liveChat;
            currentSession.type = 'youtube';
            currentSession.username = id;

            const isCurrent = () => currentSession.generation === generation;

            liveChat.on('start', (liveId) => {
                if (!isCurrent()) return;
                console.log(`Connected to YouTube Live (Video ID: ${id})`);
                io.emit('status', { connected: true, username: id });
            });

            liveChat.on('chat', (chatItem) => {
                if (!isCurrent()) return;
                
                // parse message text & emotes
                let rawText = '';
                const commentParts: Array<{ text?: string; emoteUrl?: string; alt?: string }> = [];
                if (chatItem.message) {
                    for (const run of chatItem.message) {
                        const r = run as any;
                        if (r.url) {
                            const altText = r.alt || r.emojiText || '';
                            commentParts.push({ emoteUrl: r.url, alt: altText });
                            rawText += altText;
                        } else if (r.text) {
                            commentParts.push({ text: r.text });
                            rawText += r.text;
                        } else if (r.emojiText) {
                            commentParts.push({ text: r.emojiText });
                            rawText += r.emojiText;
                        }
                    }
                }

                if (chatItem.superchat) {
                    io.emit('chatMessage', {
                        type: 'gift',
                        nickname: chatItem.author.name,
                        giftName: `SuperChat ${chatItem.superchat.amount}`,
                        repeatCount: 1,
                        profilePictureUrl: chatItem.author.thumbnail ? chatItem.author.thumbnail.url : ''
                    });
                } else {
                    io.emit('chatMessage', {
                        type: 'chat',
                        nickname: chatItem.author.name,
                        comment: rawText,
                        commentParts: commentParts,
                        profilePictureUrl: chatItem.author.thumbnail ? chatItem.author.thumbnail.url : ''
                    });
                }
            });

            liveChat.on('end', () => {
                if (!isCurrent()) return;
                console.log("YouTube Live disconnected.");
                io.emit('status', { connected: false });
            });

            liveChat.on('error', (err) => {
                if (!isCurrent()) return;
                console.error("YouTube Error:", err);
                io.emit('status', { connected: false, error: (err as any).message || String(err) });
            });

            const attemptStart = async (retries = 3) => {
                for (let i = 0; i < retries; i++) {
                    if (!isCurrent()) return false;
                    try {
                        const ok = await liveChat.start();
                        if (ok) return true;
                    } catch (e) {
                        console.error(`YouTube LiveChat start attempt ${i + 1} failed:`, e);
                    }
                    if (i < retries - 1) {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
                return false;
            };

            attemptStart().then(ok => {
                if (!ok && isCurrent()) {
                    console.error('YouTube LiveChat failed to start after retries');
                    io.emit('status', { connected: false, error: 'Failed to connect to YouTube Live. Is the stream live? (Try connecting again)' });
                }
            }).catch((e: any) => {
                if (!isCurrent()) return;
                console.error('YouTube LiveChat unexpected error:', e);
                io.emit('status', { connected: false, error: e.message || String(e) });
            });

        } catch (e: any) {
            console.error("Error starting youtube client", e);
            io.emit('status', { connected: false, error: e.message || String(e) });
        }
    }

    let idleTimeout: NodeJS.Timeout | null = null;
    const IDLE_TIMEOUT_MS = 10000;

    io.on('connection', (socket) => {
        if (idleTimeout) {
            clearTimeout(idleTimeout);
            idleTimeout = null;
        }

        socket.on('connect_stream', (data) => {
            const platform = data.platform || 'tiktok';
            let identifier = data.username || data.videoId;

            if (!identifier) return;

            if (platform === 'tiktok') {
                identifier = identifier.replace(/^@/, '');
            }

            const alreadyConnected = (currentSession.username === identifier && currentSession.client != null);
            if (alreadyConnected) {
                socket.emit('status', { connected: true, username: identifier });
                return;
            }

            disconnectAll();
            
            const generation = currentSession.generation;
            console.log(`Connecting to ${platform} (${identifier})...`);

            if (platform === 'tiktok') {
                startTiktokClient(identifier, generation);
            } else {
                startYoutubeClient(identifier, generation);
            }
        });

        socket.on('disconnect', () => {
            console.log("Browser disconnected.");
            
            const clients = io.engine.clientsCount;
            if (clients === 0) {
                console.log(`No clients connected. Starting ${IDLE_TIMEOUT_MS}ms idle timeout...`);
                idleTimeout = setTimeout(() => {
                    console.log("Idle timeout reached. Disconnecting stream client.");
                    disconnectAll();
                }, IDLE_TIMEOUT_MS);
            }
        });
    });

    const host = process.env.HOST || '127.0.0.1';
    const port = parseInt(process.env.PORT || '5000');

    server.listen(port, host, () => {
        console.log(`Server running at http://${host}:${port}`);
    });
}
