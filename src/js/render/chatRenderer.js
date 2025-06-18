// ChatRenderer.js - Unified rendering system
// Takes block data and renders consistently for both live and loaded chats

class ChatRenderer {
    constructor(containerElement) {
        this.container = containerElement;
    }
    
    // Main render method - takes blocks and renders them to DOM
    renderMessage(messageData, shouldScroll = true) {
        const { role, blocks, debug_data, dropdownStates = {}, original_content } = messageData;
        
        const messageDiv = document.createElement('div');
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        messageDiv.className = `message ${role}`;
        messageDiv.dataset.messageId = messageId;
        
        // Store original message content for potential edits
        if (messageData.content) {
            messageDiv.dataset.originalContent = messageData.content;
        } else if (blocks && blocks.length > 0) {
            messageDiv.dataset.originalContent = this.extractTextFromBlocks(blocks);
        }
        
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
        
        // Add edit button for user and assistant messages
        if (role === 'user' || role === 'assistant') {
            this.addEditButton(messageDiv, messageId, currentChatId);
            
            // Create edit form (initially hidden)
            this.addEditForm(messageDiv, messageData.content || this.extractTextFromBlocks(blocks));
        }
        
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
        
        // Store original message content for potential edits
        if (messageData.content) {
            messageDiv.dataset.originalContent = messageData.content;
        } else if (blocks && blocks.length > 0) {
            messageDiv.dataset.originalContent = this.extractTextFromBlocks(blocks);
        }
        
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
        
        // Add edit button for user and assistant messages
        if (role === 'user' || role === 'assistant') {
            this.addEditButton(messageDiv, messageId, currentChatId);
            
            // Create edit form (initially hidden)
            this.addEditForm(messageDiv, messageData.content || this.extractTextFromBlocks(blocks));
        }
        
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
        
        // Add click handler to toggle debug panel
        debugToggle.addEventListener('click', () => {
            const debugPanel = messageDiv.querySelector('.debug-panel-container');
            if (debugPanel) {
                const isHidden = debugPanel.style.display === 'none';
                debugPanel.style.display = isHidden ? 'block' : 'none';
                debugToggle.innerHTML = isHidden ? '−' : '+';
                debugToggle.classList.toggle('active', isHidden);
            }
        });
        
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
    
    // Add edit button to message
    addEditButton(messageDiv, messageId, chatId) {
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-message-btn';
        editBtn.dataset.messageId = messageId;
        editBtn.innerHTML = 'Edit';
        editBtn.title = 'Edit message';
        
        editBtn.addEventListener('click', () => {
            // Toggle edit mode
            messageDiv.classList.add('editing');
            
            // Focus the textarea
            const textarea = messageDiv.querySelector('.message-edit-textarea');
            if (textarea) {
                textarea.focus();
            }
        });
        
        messageDiv.appendChild(editBtn);
    }
    
    // Add edit form to message
    addEditForm(messageDiv, content) {
        const editForm = document.createElement('div');
        editForm.className = 'message-edit-form';
        
        // Get the full raw content of all blocks, including thinking and tool calls
        let fullContent = content || '';
        
        // If this is an assistant message, try to get all the content including thinking and tool calls
        if (messageDiv.classList.contains('assistant')) {
            // Extract all visible text from the message
            fullContent = this.extractAllContentFromMessage(messageDiv);
        }
        
        const textarea = document.createElement('textarea');
        textarea.className = 'message-edit-textarea';
        textarea.value = fullContent;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-edit-actions';
        
        const saveBtn = document.createElement('button');
        saveBtn.className = 'edit-save-btn';
        saveBtn.innerHTML = 'Save';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'edit-cancel-btn';
        cancelBtn.innerHTML = 'Cancel';
        
        actionsDiv.appendChild(cancelBtn);
        actionsDiv.appendChild(saveBtn);
        
        editForm.appendChild(textarea);
        editForm.appendChild(actionsDiv);
        
        // Event listeners
        saveBtn.addEventListener('click', () => {
            this.saveEditedMessage(messageDiv, textarea.value);
        });
        
        cancelBtn.addEventListener('click', () => {
            // Exit edit mode without saving
            messageDiv.classList.remove('editing');
        });
        
        // Allow Ctrl+Enter or Command+Enter to save
        textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this.saveEditedMessage(messageDiv, textarea.value);
            }
            // Escape key to cancel
            if (e.key === 'Escape') {
                e.preventDefault();
                messageDiv.classList.remove('editing');
            }
        });
        
        messageDiv.appendChild(editForm);
    }
    
    // Extract all content from a message including thinking and tool calls
    extractAllContentFromMessage(messageDiv) {
        let content = '';
        
        // Get content from chat blocks
        const chatBlocks = messageDiv.querySelectorAll('.chat-block');
        chatBlocks.forEach(block => {
            content += block.textContent + '\n\n';
        });
        
        // Get content from thinking blocks
        const thinkingBlocks = messageDiv.querySelectorAll('.thinking-dropdown');
        thinkingBlocks.forEach(block => {
            const title = block.querySelector('.dropdown-title');
            const innerContent = block.querySelector('.dropdown-inner');
            if (title && innerContent) {
                content += `[Thinking: ${title.textContent}]\n${innerContent.textContent}\n\n`;
            }
        });
        
        // Get content from tool blocks
        const toolBlocks = messageDiv.querySelectorAll('.tool-dropdown');
        toolBlocks.forEach(block => {
            const title = block.querySelector('.dropdown-title');
            const innerContent = block.querySelector('.dropdown-inner');
            if (title && innerContent) {
                content += `[Tool: ${title.textContent}]\n${innerContent.textContent}\n\n`;
            }
        });
        
        return content.trim();
    }
    
    // Save edited message content
    async saveEditedMessage(messageDiv, newContent) {
        try {
            const role = messageDiv.classList.contains('user') ? 'user' : 'assistant';
            const messageId = messageDiv.dataset.messageId;
            
            // Exit edit mode
            messageDiv.classList.remove('editing');
            
            // Store the original content in the dataset
            messageDiv.dataset.originalContent = newContent;
            
            // Update the message in the database
            const chatId = currentChatId;
            if (chatId) {
                try {
                    // Find the position of this message in the conversation
                    const allMessages = Array.from(document.querySelectorAll('.message'));
                    const messageIndex = allMessages.indexOf(messageDiv);
                    
                    // Get all messages from the chat history
                    const messagesData = await getChatHistory(chatId);
                    if (messagesData && messagesData.messages && messagesData.messages[messageIndex]) {
                        // Get the original message
                        const updatedMessage = messagesData.messages[messageIndex];
                        
                        // For assistant messages with complex structure (thinking blocks, tool calls):
                        // Replace the entire message with the new content as a single block
                        updatedMessage.content = newContent;
                        
                        // For assistant messages, replace the blocks with a single chat block
                        if (role === 'assistant') {
                            updatedMessage.blocks = [{
                                type: 'chat',
                                content: newContent
                            }];
                        }
                        
                        // Save the updated message
                        await updateMessageInDatabase(chatId, messageIndex, updatedMessage);
                        
                        // Update chat preview if needed
                        updateChatPreview(chatId, newContent);
                        
                        logger.info(`Message edited successfully: ${role} message at index ${messageIndex}`);
                        
                        // Reload the chat to display the edited message
                        await loadChatHistory(chatId);
                    }
                } catch (error) {
                    logger.error('Error updating message in database:', error);
                    showError('Failed to save edited message');
                }
            }
        } catch (error) {
            logger.error('Error saving edited message:', error);
            showError('Failed to save edited message');
        }
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
// Create debug panel DOM element using sequential debug system
function createDebugPanel(messageId, debugData) {
    const debugPanel = document.createElement('div');
    debugPanel.className = 'debug-panel-container';
    debugPanel.dataset.messageId = messageId;
    debugPanel.style.display = 'none'; // Initially hidden
    
    // Use the new sequential debug panel
    debugPanel.innerHTML = createDebugPanelContent(debugData);
    
    return debugPanel;
}