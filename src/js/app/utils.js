// Simple utilities

// Generate unique IDs
function generateId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Current chat ID (global state - keeping it simple)
let currentChatId = null;

// Settings management - file-based storage
let cachedSettings = null;

// Make settings functions globally accessible  
window.cachedSettings = () => cachedSettings;
window.setCachedSettings = (settings) => { cachedSettings = settings; };

function loadSettings() {
    // Return cached settings if available, otherwise defaults
    return window.cachedSettings() || {
        apiUrl: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        modelName: '',
        debugPanels: false,
        showSystemBlocks: true,
        logLevel: 'INFO'
    };
}

function saveSettings(settings) {
    // Update cache immediately
    const currentSettings = window.cachedSettings() || {};
    window.setCachedSettings({ ...currentSettings, ...settings });
    
    fetch(`${window.location.origin}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    }).catch(error => console.warn('Failed to save settings:', error));
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Simple markdown-like formatting with whitespace preservation
function formatMessage(text) {
    // Basic markdown support with proper whitespace handling
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // Handle code blocks (triple backticks) first - preserve whitespace inside
        .replace(/```(\w+)?\n?([\s\S]*?)```/g, function(match, lang, code) {
            // Remove the language identifier and any leading newline
            const cleanCode = code.replace(/^\n/, ''); // Remove leading newline after language
            const langLabel = lang ? `<div class="code-lang">${lang}</div>` : '';
            
            // Use SimpleSyntax for highlighting
            const highlightedCode = window.SimpleSyntax ? SimpleSyntax.highlight(cleanCode, lang) : escapeHtml(cleanCode);
            return `${langLabel}<pre><code class="language-${lang}">${highlightedCode}</code></pre>`;
        })
        // Handle inline code - preserve spaces
        .replace(/`(.*?)`/g, '<code>$1</code>')
        // Replace newlines with <br>
        .replace(/\n/g, '<br>')
        // Preserve multiple spaces (convert to non-breaking spaces)
        .replace(/ {2,}/g, function(match) {
            return '&nbsp;'.repeat(match.length);
        })
        // Preserve leading spaces on lines (common in code)
        .replace(/(^|<br>)( +)/g, function(match, lineStart, spaces) {
            return lineStart + '&nbsp;'.repeat(spaces.length);
        });
}

// Smart auto-scroll tracking
let isUserAtBottom = true;

// Initialize smart scrolling on the scroll container
function initSmartScroll(container) {
    // Direction-aware bottom tracking. We must NOT infer "user scrolled away" from a
    // plain position check: while content streams, our own auto-scroll defers to rAF,
    // and by the time that scroll event fires more content has been appended, so
    // scrollTop+clientHeight momentarily trails scrollHeight — a position check would
    // read that as "not at bottom" and wrongly pause the follow (the second streaming
    // dropdown getting cut off). Growth never moves scrollTop UP, so we only disarm
    // when the user actually scrolls up; reaching the bottom re-arms. A shrink guard
    // keeps a collapsing dropdown (browser clamps scrollTop down) from disarming us.
    let lastScrollTop = container.scrollTop;
    let lastScrollHeight = container.scrollHeight;
    container.addEventListener('scroll', () => {
        const st = container.scrollTop;
        const sh = container.scrollHeight;
        const atBottom = st + container.clientHeight >= sh - 10;
        const shrank = sh < lastScrollHeight - 1;
        if (!shrank && st < lastScrollTop - 2) {
            isUserAtBottom = false;   // genuine upward scroll → pause follow
        } else if (atBottom) {
            isUserAtBottom = true;    // back at the bottom → resume follow
        }
        lastScrollTop = st;
        lastScrollHeight = sh;
    });

    // Auto-follow ANY growth of the content — not just main-stream SSE events. Tool
    // dropdowns stream over a separate channel and other render paths mutate the DOM
    // without calling the scroll helpers; observing the content's size catches them
    // all in one place. Gated on isUserAtBottom so scrolling up to read keeps it paused.
    //
    // Scroll SYNCHRONOUSLY here (not via smartScrollToBottom's rAF): a ResizeObserver
    // callback runs after layout but before paint, so adjusting scrollTop now lands in
    // the same frame the content grew — no visible jump. Deferring to rAF paints the
    // grown content at the old position for one frame, then snaps down: that's the
    // jitter. RO already coalesces multiple mutations per frame, so no throttle needed.
    const content = container.querySelector('.messages') || container.firstElementChild;
    if (content && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
            if (isUserAtBottom) container.scrollTop = container.scrollHeight;
        });
        observer.observe(content);
    }
}

// Smart scroll - only scrolls if user is at bottom
let scrollPending = false;
function smartScrollToBottom(element) {
    if (isUserAtBottom && !scrollPending) {
        scrollPending = true;
        requestAnimationFrame(() => {
            // finally so a throw can't strand scrollPending=true and kill all
            // future auto-scrolls for the session.
            try { element.scrollTop = element.scrollHeight; }
            finally { scrollPending = false; }
        });
    }
}

// Immediate scroll for non-streaming contexts
function smartScrollToBottomImmediate(element) {
    if (isUserAtBottom) {
        element.scrollTop = element.scrollHeight;
    }
}

// Force scroll to bottom (always scrolls and resets state)
function scrollToBottom(element) {
    element.scrollTop = element.scrollHeight;
    isUserAtBottom = true; // Reset since we're forcing to bottom
}

// Global abort controller for stopping generation
let currentAbortController = null;
let currentRequestId = null;

// Tell the backend to stop the in-flight chat request for this requestId.
// The backend marks it user_stopped, destroys the upstream AI provider
// request, and persists the partial content. We await this before
// aborting the fetch so the cancel flag is set before the close handler
// fires on the backend.
async function cancelRequest(requestId) {
    if (!requestId) return;
    try {
        await fetch(`${window.location.origin}/api/chat/cancel/${encodeURIComponent(requestId)}`, {
            method: "POST"
        });
    } catch (error) {
        logger.warn("Failed to cancel request:", error);
    }
}

// Drive the send button's three states: Send / Stop / Steer.
//   - not streaming            → Send  (normal submit)
//   - streaming, empty input   → Stop  (cancel the viewed chat's stream)
//   - streaming, has content   → Steer (queue the typed message)
// The message input is NEVER disabled by streaming state — the user must always
// be able to type (and steer) while a response is in flight.
function setLoading(isStreaming, hasContent = false) {
    const sendBtn = document.getElementById('sendBtn');

    sendBtn.disabled = false; // Keep enabled so the user can click to stop/steer

    sendBtn.classList.remove('btn-stop', 'btn-steer');
    if (isStreaming && hasContent) {
        sendBtn.textContent = 'Steer';
        sendBtn.classList.add('btn-steer');
    } else if (isStreaming) {
        sendBtn.textContent = 'Stop';
        sendBtn.classList.add('btn-stop');
    } else {
        sendBtn.textContent = 'Send';
    }
}

// True when the message input holds any text, image, or document content.
// Used to decide between the Stop and Steer button states while streaming.
function messageInputHasContent() {
    const input = document.getElementById('messageInput');
    const hasText = !!(input && input.value.length > 0);
    const hasImages = typeof getSelectedImages === 'function' && getSelectedImages().length > 0;
    const hasDocs = typeof getSelectedDocuments === 'function' && getSelectedDocuments().length > 0;
    return hasText || hasImages || hasDocs;
}

// Stop current generation
// Just stop the stream - no cleanup, no debug panels
function stopStream() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
}

// Stop the in-flight response for the chat the user is currently viewing.
// Each chat tracks its own stream in activeStreamState, so stopping cancels
// only that chat's request and leaves other concurrent streams running.
// The button/indicator are refreshed by the stream's own abort handling.
async function stopGeneration() {
    const stopped = await streamManager.stopChatStream(currentChatId);
    if (stopped) {
        logger.info('Generation stopped by user');
        showNotification('Generation stopped', 'info');
    }
}

// Notification system (doesn't add to chat)
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Auto-remove after 3 seconds
    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Simple error display
function showError(message) {
    logger.error(message, null, true); // Send to server
    showNotification(message, 'error');
}

// Success message
function showSuccess(message) {
    logger.info(message, null, false); // Don't spam server with success messages
    showNotification(message, 'success');
}

// Warning message
function showWarning(message) {
    logger.warn(message, null, false); // Don't spam server with warnings
    showNotification(message, 'warning');
}

// Get clean conversation history for debug panel
// =====================================
// MASTER IMAGE SIZE CONTROL
// Change this one number to adjust all image limits!
const MAX_BASE64_KB = 100;
// =====================================

// Image resizing utility to prevent API errors from oversized images
function resizeImage(file, width, height, quality, targetKB) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Failed to generate WebP blob'));
                    }
                },
                'image/webp', // Here’s the magic: using WebP
                quality       // Compression quality from your loop
            );
        };

        img.onerror = () => reject(new Error('Failed to load image for resizing'));
        img.src = URL.createObjectURL(file);
    });
}

// Helper function to convert blob to base64 with size validation
function blobToBase64(blob, maxBase64KB = MAX_BASE64_KB) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            // Remove the data:image/...;base64, prefix
            const base64 = result.split(',')[1];
            
            // Check base64 size (each char = 1 byte)
            const base64SizeKB = base64.length / 1024;
            
            if (base64SizeKB > maxBase64KB) {
                reject(new Error(`Base64 too large: ${base64SizeKB.toFixed(1)}KB > ${maxBase64KB}KB`));
            } else {
                resolve(base64);
            }
        };
        reader.readAsDataURL(blob);
    });
}
