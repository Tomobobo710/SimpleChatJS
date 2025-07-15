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
        sendBtn.classList.add('btn-stop');
    } else {
        sendBtn.textContent = 'Send';
        sendBtn.classList.remove('btn-stop');
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

// Get clean conversation history for debug panel
async function getCleanConversationHistory(chatId, message) {
    try {
        const response = await fetch(`${window.location.origin}/api/chat/${chatId}/api-history`);
        if (response.ok) {
            const apiHistory = await response.json();
            // Add the new user message to show complete conversation state
            return [...apiHistory, { role: 'user', content: message }];
        } else {
            // Fallback to just the user message
            return [{ role: 'user', content: message }];
        }
    } catch (error) {
        logger.warn('Failed to get clean conversation history for user debug data:', error);
        return [{ role: 'user', content: message }];
    }
}

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
