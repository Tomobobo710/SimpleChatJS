// ChatRenderer.js - Unified rendering system
// Takes block data and renders consistently for both live and loaded chats

class ChatRenderer {
    constructor(containerElement) {
        this.container = containerElement;
    }
    
    // Main render method - takes blocks and renders them to DOM
    renderMessage(messageData, shouldScroll = true) {
        const { role, blocks, debug_data, dropdownStates = {} } = messageData;
        
        const messageDiv = document.createElement('div');
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        messageDiv.className = `message ${role}`;
        messageDiv.dataset.messageId = messageId;
        
        // Create content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        // Render each block
        if (blocks && blocks.length > 0) {
            let thinkingIndex = 0;
            let toolIndex = 0;
            
            blocks.forEach((blockData) => {
                let stateKey;
                let isOpen = false;
                
                if (blockData.type === 'thinking') {
                    stateKey = 'thinking_' + thinkingIndex;
                    thinkingIndex++;
                } else if (blockData.type === 'tool') {
                    stateKey = 'tool_' + toolIndex;
                    toolIndex++;
                }
                
                if (stateKey) {
                    isOpen = dropdownStates[stateKey] || false;
                }
                
                const blockElement = this.renderBlock(blockData, isOpen);
                contentDiv.appendChild(blockElement);
            });
        }
        
        messageDiv.appendChild(contentDiv);
        
        // Add debug toggle and panel if debug data provided
        if (debug_data) {
            this.addDebugPanel(messageDiv, messageId, debug_data);
        }
        
        this.container.appendChild(messageDiv);
        
        // Handle scrolling
        if (shouldScroll) {
            smartScrollToBottom(scrollContainer);
        }
        
        // Update chat preview and handle title generation
        this.handleMessageMeta(role, messageData.content || this.extractTextFromBlocks(blocks));
        
        return messageDiv;
    }
    
    // Create message element without appending to container (for seamless replacement)
    createMessageElement(messageData, shouldScroll = true) {
        const { role, blocks, debug_data, dropdownStates = {} } = messageData;
        
        const messageDiv = document.createElement('div');
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        messageDiv.className = `message ${role}`;
        messageDiv.dataset.messageId = messageId;
        
        // Create content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        // Render each block
        if (blocks && blocks.length > 0) {
            let thinkingIndex = 0;
            let toolIndex = 0;
            
            blocks.forEach((blockData) => {
                let stateKey;
                let isOpen = false;
                
                if (blockData.type === 'thinking') {
                    stateKey = 'thinking_' + thinkingIndex;
                    thinkingIndex++;
                } else if (blockData.type === 'tool') {
                    stateKey = 'tool_' + toolIndex;
                    toolIndex++;
                }
                
                if (stateKey) {
                    isOpen = dropdownStates[stateKey] || false;
                }
                
                const blockElement = this.renderBlock(blockData, isOpen);
                contentDiv.appendChild(blockElement);
            });
        }
        
        messageDiv.appendChild(contentDiv);
        
        // Add debug toggle and panel if debug data provided
        if (debug_data) {
            this.addDebugPanel(messageDiv, messageId, debug_data);
        }
        
        // Handle metadata but don't scroll yet
        this.handleMessageMeta(role, messageData.content || this.extractTextFromBlocks(blocks));
        
        return messageDiv;
    }
    
    // Render individual block based on type
    renderBlock(blockData, isOpen = false) {
        const { type, content, metadata = {} } = blockData;
        
        switch (type) {
            case 'thinking':
                return this.renderThinkingBlock(content, metadata, isOpen);
            case 'tool':
                return this.renderToolBlock(content, metadata, isOpen);
            case 'phase_marker':
                return this.renderPhaseMarkerBlock(content, metadata);
            case 'chat':
            default:
                return this.renderChatBlock(content);
        }
    }
    
    // Render thinking block as dropdown
    renderThinkingBlock(content, metadata, isOpen = false) {
        const dropdownId = `thinking-${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const dropdown = new StreamingDropdown(dropdownId, 'Thinking Process', 'thinking', !isOpen);
        dropdown.setContent(content);
        return dropdown.element;
    }
    
    // Render tool block as dropdown
    renderToolBlock(content, metadata, isOpen = false) {
        const dropdownId = `tool-${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Extract tool name from metadata or content
        let toolName = metadata?.toolName;
        if (!toolName) {
            const toolMatch = content.match(/^\[(\w+)\]:/m);
            if (toolMatch) {
                toolName = toolMatch[1];
            }
        }
        
        // Create title with just the tool name (no "Tool:" prefix)
        const title = toolName || 'unknown_tool';
        
        // Format the content with Arguments and Result sections
        const formattedContent = formatToolContent(content, toolName, metadata?.toolArgs);
        
        const dropdown = new StreamingDropdown(dropdownId, title, 'tool', !isOpen);
        dropdown.setContent(formattedContent);
        return dropdown.element;
    }
    
    // Render regular chat content
    renderChatBlock(content) {
        const div = document.createElement('div');
        div.className = 'chat-block';
        div.innerHTML = formatMessage(escapeHtml(content));
        return div;
    }
    
    // Simple phase marker rendering - no more complexity!
    renderPhaseMarkerBlock(content, metadata) {
        const settings = loadSettings();
        
        const div = document.createElement('div');
        div.className = 'conductor-phase-marker';
        div.innerHTML = `
            <div class="phase-marker-content">
                <span class="phase-text">${escapeHtml(content)}</span>
            </div>
        `;
        
        // Apply visibility setting
        if (!settings.showPhaseMarkers) {
            div.style.display = 'none';
        }
        
        return div;
    }
    
    // Add debug panel to message
    addDebugPanel(messageDiv, messageId, debugData) {
        const settings = loadSettings();
        messageDiv.classList.add('has-debug');
        
        const debugToggle = document.createElement('button');
        debugToggle.className = 'debug-toggle';
        debugToggle.dataset.messageId = messageId;
        debugToggle.innerHTML = '+';
        debugToggle.title = 'Show debug info';
        
        if (!settings.debugPanels) {
            debugToggle.style.display = 'none';
        }
        
        messageDiv.appendChild(debugToggle);
        
        const debugPanel = createDebugPanel(messageId, debugData);
        messageDiv.appendChild(debugPanel);
    }
    
    // Handle message metadata (preview, title generation)
    handleMessageMeta(role, content) {
        if (role === 'user' || role === 'assistant') {
            updateChatPreview(currentChatId, content);
            
            // Auto-generate chat title from first user message
            if (role === 'user') {
                const chatItem = document.querySelector(`[data-chat-id="${currentChatId}"]`);
                if (chatItem) {
                    const currentTitle = chatItem.querySelector('.chat-item-title').textContent;
                    if (currentTitle === 'New Chat') {
                        const newTitle = content.substring(0, 30) + (content.length > 30 ? '...' : '');
                        updateChatTitle(newTitle);
                    }
                }
            }
        }
    }
    
    // Extract plain text from blocks for preview/title generation
    extractTextFromBlocks(blocks) {
        if (!blocks) return '';
        return blocks.filter(block => block.type === 'chat')
                    .map(block => block.content)
                    .join(' ');
    }
}

// Global renderer instance
let chatRenderer = null;

// Initialize renderer when DOM is ready
function initializeChatRenderer() {
    const messagesContainer = document.getElementById('messages');
    if (messagesContainer) {
        chatRenderer = new ChatRenderer(messagesContainer);
        logger.info('[RENDERER] ChatRenderer initialized');
    }
}

// Ensure renderer is initialized
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeChatRenderer);
} else {
    initializeChatRenderer();
}