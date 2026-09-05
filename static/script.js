const socket = io();

const MAX_MESSAGES = 50; // Max chat messages kept in DOM to limit memory usage

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
const platformRadios = document.getElementsByName('platform');
const identifierLabel = document.getElementById('identifier-label');
const identifierPrefix = document.getElementById('identifier-prefix');

const platformValues = {
    tiktok: '',
    youtube: ''
};
let currentPlatform = 'tiktok';

// Platform switch logic
if (platformRadios) {
    platformRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            // Save value of previous platform
            platformValues[currentPlatform] = usernameInput.value;

            const platform = e.target.value;
            currentPlatform = platform;

            if (platform === 'youtube') {
                identifierLabel.textContent = 'YouTube Video URL or ID';
                identifierPrefix.style.display = 'none';
                usernameInput.placeholder = 'https://youtube.com/watch?v=...';
                usernameInput.style.paddingLeft = '0.85rem';
                if (toggleSessionBtn) toggleSessionBtn.classList.add('hidden');
                if (sessionIdSection) sessionIdSection.classList.add('hidden');
            } else {
                identifierLabel.textContent = 'TikTok Username';
                identifierPrefix.style.display = '';
                usernameInput.placeholder = 'yourusername';
                usernameInput.style.paddingLeft = '0';
                if (toggleSessionBtn) toggleSessionBtn.classList.remove('hidden');
                // Don't auto-show sessionIdSection, let user toggle it
            }

            // Restore saved input for target platform
            usernameInput.value = platformValues[platform] || '';
        });
    });
}

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

    // Get selected platform
    let platform = 'tiktok';
    if (platformRadios) {
        platformRadios.forEach(radio => {
            if (radio.checked) platform = radio.value;
        });
    }

    const sessionid = sessionIdInput ? sessionIdInput.value.trim() : '';
    const targetIdc = getTargetIdc();

    statusMessage.textContent = '';
    statusMessage.style.color = 'var(--text-secondary)';
    connectBtn.disabled = true;
    if (platformRadios) {
        platformRadios.forEach(radio => radio.disabled = true);
    }
    connectBtnText.textContent = 'Connecting...';
    connectBtnSpinner.classList.remove('hidden');

    const statsBar = document.getElementById('stats-bar');
    const eventRow = document.getElementById('event-row');

    if (platform === 'youtube') {
        if (statsBar) statsBar.classList.add('hidden');
        if (eventRow) eventRow.classList.add('hidden');
    } else {
        if (statsBar) statsBar.classList.remove('hidden');
        if (eventRow) eventRow.classList.remove('hidden');
    }

    // Reset stats, buffers, and DOM for the new connection
    stats = { viewers: 0, likes: 0, gifts: 0, joins: 0 };
    updateStats();
    userLikesBuffer.clear();
    chatMessages.innerHTML = '';
    const likeFeed = document.getElementById('like-feed');
    const joinFeed = document.getElementById('join-feed');
    if (likeFeed) { likeFeed.innerHTML = ''; likeFeed.classList.add('collapsed'); }
    if (joinFeed) { joinFeed.innerHTML = ''; joinFeed.classList.add('collapsed'); }
    clearTimeout(eventFeedHideTimers['like-feed']);
    clearTimeout(eventFeedHideTimers['join-feed']);

    socket.emit('connect_stream', { platform, username, sessionid, targetIdc });
});

// Allow Enter key to connect
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        connectBtn.click();
    }
});

// Socket Events
socket.on('status', (data) => {
    if (platformRadios) {
        platformRadios.forEach(radio => radio.disabled = false);
    }
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

let userLikesBuffer = new Map();
const MAX_LIKE_BUFFER_FRONTEND = 3000;

// Auto-fade the like/join feed columns independently, each after a few
// seconds of no activity in that specific column.
const EVENT_FEED_HIDE_DELAY = 4000; // ms
const eventFeedHideTimers = {}; // keyed by element id: 'like-feed' | 'join-feed'

function showEventFeed(feedId) {
    const feedEl = document.getElementById(feedId);
    if (!feedEl) return;

    feedEl.classList.remove('collapsed');

    clearTimeout(eventFeedHideTimers[feedId]);
    eventFeedHideTimers[feedId] = setTimeout(() => {
        feedEl.classList.add('collapsed');
    }, EVENT_FEED_HIDE_DELAY);
}

// Add message to DOM
function addMessage(data) {

    // Common logic for stats updates and content generation
    let contentHtml = '';
    const userColor = stringToColor(data.nickname);

    // Check if it's an event for the new side feed
    const isEventFeed = (data.type === 'like' || data.type === 'join');

    if (data.type === 'like') {
        // Always use the stream's total likes if available (most accurate)
        if (data.totalLikes != null) {
            stats.likes = data.totalLikes;
        } else {
            stats.likes += data.likeCount || 1;
        }
        updateStats();

        // Track cumulative likes per user and show at milestones: 1, 10, 25, 50
        const LIKE_MILESTONES = [1, 10, 25, 50];
        const prev = userLikesBuffer.get(data.nickname) || 0;
        const next = prev + (data.likeCount || 1);

        // Purge buffer if it gets too large (popular stream with many unique viewers)
        if (userLikesBuffer.size >= MAX_LIKE_BUFFER_FRONTEND) {
            userLikesBuffer.clear();
        }
        userLikesBuffer.set(data.nickname, next);

        // Find if we crossed any milestone between prev and next
        const crossed = LIKE_MILESTONES.filter(m => prev < m && next >= m);
        if (crossed.length === 0) {
            return; // No milestone crossed yet
        }
        // Show the highest milestone crossed
        const milestone = crossed[crossed.length - 1];
        const likeText = milestone === 1 ? 'a like' : `${milestone} likes`;
        contentHtml = `<span class="comment" style="color: #ff3c64; font-style: italic;">Sent ${likeText}! ❤️</span>`;
    } else if (data.type === 'join') {
        stats.joins += 1;
        updateStats();
        contentHtml = `<span class="comment" style="color: #a0a0b0; font-style: italic;">Joined the live 🚪</span>`;
    } else if (data.type === 'follow') {
        const followIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2be07a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:4px;"><path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="8" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>`;
        contentHtml = `<span class="comment" style="color: #2be07a; font-style: italic;">${followIcon}Started following!</span>`;
    } else if (data.type === 'chat') {
        if (data.commentParts && Array.isArray(data.commentParts) && data.commentParts.length > 0) {
            const partsHtml = data.commentParts.map(part => {
                if (part.emoteUrl && isSafeImageUrl(part.emoteUrl)) {
                    return `<img src="${part.emoteUrl}" class="chat-emote" alt="${escapeHtml(part.alt || '')}" title="${escapeHtml(part.alt || '')}">`;
                } else if (part.text) {
                    return escapeHtml(part.text);
                }
                return '';
            }).join('');
            contentHtml = `<span class="comment">${partsHtml}</span>`;
        } else {
            contentHtml = `<span class="comment">${escapeHtml(data.comment)}</span>`;
        }
    } else if (data.type === 'gift') {
        stats.gifts += parseInt(data.repeatCount) || 1;
        updateStats();
        if (chatContainer && !chatContainer.classList.contains('hidden')) {
            playGiftSound();
        }
        const giftIconHtml = (data.giftIconUrl && isSafeImageUrl(data.giftIconUrl))
            ? `<img src="${data.giftIconUrl}" class="gift-icon" onerror="this.style.display='none'">`
            : '<span class="gift-icon-emoji">🎁</span>';
        contentHtml = `<span class="comment" style="color: #ff0050; font-weight: bold;">Sent ${data.repeatCount}x ${escapeHtml(data.giftName)}!</span>`;
        // Store for appending after element is built
        data._giftIconHtml = giftIconHtml;
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
        showEventFeed(targetId);
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

    // Append gift icon to the right side for gift messages
    if (data._giftIconHtml) {
        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'gift-icon-wrapper';
        iconWrapper.innerHTML = data._giftIconHtml;
        msgDiv.appendChild(iconWrapper);
    }

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