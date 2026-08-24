const socket = io();

const MAX_MESSAGES = 200; // Max chat messages kept in DOM to limit memory usage

// --- Gift Sound (Web Audio API, no files needed) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playGiftSound() {
    // A pleasant two-tone ascending chime
    const notes = [880, 1100]; // A5 → C#6
    notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = audioCtx.currentTime + i * 0.15;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.4, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        osc.start(t);
        osc.stop(t + 0.5);
    });
}

// UI Elements
const setupContainer = document.getElementById('setup-container');
const chatContainer = document.getElementById('chat-container');
const chatMessages = document.getElementById('chat-messages');
const usernameInput = document.getElementById('username-input');
const connectBtn = document.getElementById('connect-btn');
const connectBtnText = document.getElementById('connect-btn-text');
const connectBtnSpinner = document.getElementById('connect-btn-spinner');
const statusMessage = document.getElementById('status-message');
const toggleSessionBtn = document.getElementById('toggle-session-btn');
const sessionIdSection = document.getElementById('session-id-section');
const sessionIdInput = document.getElementById('session-id-input');
const targetIdcSelect = document.getElementById('target-idc-select');
const targetIdcCustom = document.getElementById('target-idc-custom');
const toggleSessionVis = document.getElementById('toggle-session-vis');

// Toggle age-restricted section (elements only exist when the
// sessionid login feature is enabled server-side; guard against
// their absence so the rest of the page still works when it's off)
if (toggleSessionBtn && sessionIdSection) {
    toggleSessionBtn.addEventListener('click', () => {
        const isHidden = sessionIdSection.classList.toggle('hidden');
        toggleSessionBtn.classList.toggle('active', !isHidden);
        toggleSessionBtn.setAttribute('aria-expanded', String(!isHidden));
    });
}

// Show/hide custom IDC input based on select
if (targetIdcSelect && targetIdcCustom) {
    targetIdcSelect.addEventListener('change', () => {
        if (targetIdcSelect.value === 'custom') {
            targetIdcCustom.classList.remove('hidden');
            targetIdcCustom.focus();
        } else {
            targetIdcCustom.classList.add('hidden');
        }
    });
}

// Toggle session ID visibility
if (toggleSessionVis && sessionIdInput) {
    toggleSessionVis.addEventListener('click', () => {
        const isPassword = sessionIdInput.type === 'password';
        sessionIdInput.type = isPassword ? 'text' : 'password';
        toggleSessionVis.textContent = isPassword ? '🙈' : '👁';
    });
}

// Helper: get the effective target-idc value
function getTargetIdc() {
    if (!targetIdcSelect) return '';
    if (targetIdcSelect.value === 'custom') {
        return targetIdcCustom ? targetIdcCustom.value.trim() : '';
    }
    return targetIdcSelect.value.trim();
}

// Vibrant colors for usernames
const colors = [
    '#ff0050', '#00f2fe', '#4facfe', '#00f2fe', '#43e97b',
    '#38f9d7', '#fa709a', '#fee140', '#ff0844', '#f5576c'
];

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

// Connect to TikTok Live
connectBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    if (!username) return;

    const sessionid = sessionIdInput ? sessionIdInput.value.trim() : '';
    const targetIdc = getTargetIdc();

    statusMessage.textContent = 'Connecting...';
    statusMessage.style.color = 'var(--text-secondary)';
    connectBtn.disabled = true;
    connectBtnText.textContent = 'Connecting...';
    connectBtnSpinner.classList.remove('hidden');

    // Reset stats, buffers, and DOM for the new connection
    stats = { viewers: 0, likes: 0, gifts: 0, joins: 0 };
    updateStats();
    userLikesBuffer = {};
    chatMessages.innerHTML = '';
    const likeFeed = document.getElementById('like-feed');
    const joinFeed = document.getElementById('join-feed');
    if (likeFeed) likeFeed.innerHTML = '';
    if (joinFeed) joinFeed.innerHTML = '';

    socket.emit('connect_tiktok', { username, sessionid, targetIdc });
});

// Allow Enter key to connect
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        connectBtn.click();
    }
});

// Socket Events
socket.on('status', (data) => {
    if (data.connected) {
        setupContainer.classList.add('hidden');
        chatContainer.classList.remove('hidden');
    } else {
        setupContainer.classList.remove('hidden');
        chatContainer.classList.add('hidden');
        connectBtn.disabled = false;
        connectBtnText.textContent = 'Connect to Live';
        connectBtnSpinner.classList.add('hidden');
        statusMessage.style.color = '#ff0050';
        if (data.error) {
            // Use the real error type from the server instead of guessing
            // from the message text (a substring match on "session" used
            // to catch AgeRestrictedError's "Pass sessionid..." wording
            // even when no cookie had been entered at all).
            if (data.errorType === 'AgeRestrictedError') {
                statusMessage.textContent = '🔞 Age restricted stream — open "Age restricted stream" below and add your sessionid cookie';
            } else if (data.errorType === 'UserOfflineError') {
                statusMessage.textContent = `❌ @${usernameInput.value.trim()} is offline`;
            } else {
                // Only 401/403/auth-type failures on a REQUEST THAT ACTUALLY
                // SENT a sessionid count as a stale/expired cookie.
                const sentSessionId = sessionIdInput && sessionIdInput.value.trim().length > 0;
                const err = data.error.toLowerCase();
                const looksLikeAuthFailure = err.includes('401') || err.includes('403') || err.includes('auth');
                if (sentSessionId && looksLikeAuthFailure) {
                    statusMessage.textContent = '❌ Session expired — please update your sessionid cookie';
                } else {
                    statusMessage.textContent = `❌ ${data.error}`;
                }
            }
        } else {
            statusMessage.textContent = 'Disconnected';
        }
    }
});

// Global stat counters
let stats = {
    viewers: 0,
    likes: 0,
    gifts: 0,
    joins: 0
};

function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n;
}

function updateStats() {
    document.getElementById('viewer-count').textContent = formatNum(stats.viewers);
    document.getElementById('like-count').textContent = formatNum(stats.likes);
    document.getElementById('gift-count').textContent = formatNum(stats.gifts);
    document.getElementById('join-count').textContent = formatNum(stats.joins);
}

// Seed initial stats from room info on connect
socket.on('initialStats', (data) => {
    if (data.totalLikes) stats.likes = data.totalLikes;
    updateStats();
});

socket.on('viewerCount', (data) => {
    stats.viewers = data.viewers;
    updateStats();
});

socket.on('chatMessage', (data) => {
    addMessage(data);
});

let userLikesBuffer = {};

// Add message to DOM
function addMessage(data) {

    // Common logic for stats updates and content generation
    let contentHtml = '';
    const userColor = stringToColor(data.nickname);

    // Check if it's an event for the new side feed
    const isEventFeed = (data.type === 'like' || data.type === 'join' || data.type === 'follow');

    if (data.type === 'like') {
        // Always use the stream's total likes if available (most accurate)
        if (data.totalLikes != null) {
            stats.likes = data.totalLikes;
        } else {
            stats.likes += data.likeCount || 1;
        }
        updateStats();

        // Buffer likes per user
        userLikesBuffer[data.nickname] = (userLikesBuffer[data.nickname] || 0) + (data.likeCount || 1);

        // Only show in feed every 15 likes
        if (userLikesBuffer[data.nickname] >= 15) {
            const displayLikes = Math.floor(userLikesBuffer[data.nickname] / 15) * 15;
            userLikesBuffer[data.nickname] %= 15; // keep the remainder
            contentHtml = `<span class="comment" style="color: #ff3c64; font-style: italic;">Sent ${displayLikes} likes! ❤️</span>`;
        } else {
            return; // Stats updated, but don't show notification yet
        }
    } else if (data.type === 'join') {
        stats.joins += 1;
        updateStats();
        contentHtml = `<span class="comment" style="color: #a0a0b0; font-style: italic;">Joined the live 🚪</span>`;
    } else if (data.type === 'follow') {
        contentHtml = `<span class="comment" style="color: #2be07a; font-style: italic;">Started following! ➕</span>`;
    } else if (data.type === 'chat') {
        contentHtml = `<span class="comment">${escapeHtml(data.comment)}</span>`;
    } else if (data.type === 'gift') {
        stats.gifts += parseInt(data.repeatCount) || 1;
        updateStats();
        playGiftSound();
        contentHtml = `<span class="comment" style="color: #ff0050; font-weight: bold;">Sent ${data.repeatCount}x ${escapeHtml(data.giftName)}! 🎁</span>`;
    }


    if (isEventFeed) {
        // Replace the content of the target event feed
        const targetId = data.type === 'like' ? 'like-feed' : 'join-feed';
        const eventFeed = document.getElementById(targetId);
        if (eventFeed) {
            eventFeed.innerHTML = `
                <div class="event-box ${data.type}" style="width: 100%; height: 100%;">
                    <div class="message-content">
                        <span class="nickname" style="color: ${userColor}">${escapeHtml(data.nickname)}</span>
                        ${contentHtml}
                    </div>
                </div>
            `;
        }
        return; // Don't add to main chat
    }

    // Default avatar if none provided (only needed for main chat)
    const DEFAULT_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2ZmZmZmZiI+PHBhdGggZD0iTTEyIDJjNS41MjMgMCAxMCA0LjQ3NyAxMCAxMHMtNC40NzcgMTAtMTAgMTBTMiAxNy41MjMgMiAxMnM0LjQ3Ny0xMCAxMC0xMHptMCAxOGM0LjQxMSAwIDgtMy41ODkgOC04czgtOC04IDgtMy41ODkgOC04IDgtOCA4LTggOCAzLjU4OSA4IDh6bTAtMTRjMi4yMSAwIDQgMS43OSA0IDRzLTEuNzkgNC00IDQtNC0xLjc5LTQtNCAxLjc5LTQgNC00eiIvPjwvc3ZnPg==';
    const avatarUrl = isSafeImageUrl(data.profilePictureUrl) ? data.profilePictureUrl : DEFAULT_AVATAR;

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${data.type}`;

    // Build the avatar <img> via DOM APIs (not string interpolation) so a
    // malicious profilePictureUrl containing quotes/markup can never break
    // out of an HTML attribute -- setting .src assigns it as a URL value,
    // it can't be parsed as markup.
    const avatarImg = document.createElement('img');
    avatarImg.src = avatarUrl;
    avatarImg.className = 'avatar';
    avatarImg.alt = 'avatar';
    avatarImg.onerror = function () {
        this.onerror = null;
        this.src = DEFAULT_AVATAR;
    };

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = `
        <span class="nickname" style="color: ${userColor}">${escapeHtml(data.nickname)}</span>
        ${contentHtml}
    `;

    msgDiv.appendChild(avatarImg);
    msgDiv.appendChild(contentDiv);

    chatMessages.prepend(msgDiv);

    // Keep only last MAX_MESSAGES messages to prevent memory growth
    while (chatMessages.children.length > MAX_MESSAGES) {
        chatMessages.removeChild(chatMessages.lastChild);
    }

    // Auto scroll to newest
    chatMessages.scrollTop = 0;
}

// Only allow http(s) and data: image URLs for avatars -- blocks javascript:
// and other schemes from ever being assigned as a src.
function isSafeImageUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    return /^(https?:|data:image\/)/i.test(url.trim());
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}