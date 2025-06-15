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
        apiUrl: 'http://localhost:11434/v1',
        apiKey: '',
        modelName: '',
        debugPanels: false,
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

// Simple markdown-like formatting
function formatMessage(text) {
    // Basic markdown support
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
}

// Smart auto-scroll tracking
let isUserAtBottom = true;

// Initialize smart scrolling on the scroll container
function initSmartScroll(container) {
    container.addEventListener('scroll', () => {
        // Check if user is at bottom (within 10px tolerance)
        const scrollPosition = container.scrollTop + container.clientHeight;
        const scrollHeight = container.scrollHeight;
        isUserAtBottom = scrollPosition >= scrollHeight - 10;
    });
}

// Smart scroll - only scrolls if user is at bottom
let scrollPending = false;
function smartScrollToBottom(element) {
    if (isUserAtBottom && !scrollPending) {
        scrollPending = true;
        requestAnimationFrame(() => {
            element.scrollTop = element.scrollHeight;
            scrollPending = false;
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

// Show/hide loading state
function setLoading(isLoading) {
    const sendBtn = document.getElementById('sendBtn');
    const messageInput = document.getElementById('messageInput');
    
    sendBtn.disabled = false; // Keep enabled so user can click to stop
    messageInput.disabled = isLoading;
    
    if (isLoading) {
        sendBtn.textContent = 'Stop';
        sendBtn.classList.add('stop-mode');
    } else {
        sendBtn.textContent = 'Send';
        sendBtn.classList.remove('stop-mode');
    }
}

// Stop current generation
// Just stop the stream - no cleanup, no debug panels
function stopStream() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
}

// Stop + cleanup + debug panels (full stop)
function stopGeneration() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        setLoading(false);
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
