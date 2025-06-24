// ChatRenderer.js

class ChatRenderer {
    constructor(containerElement) {
        this.container = containerElement;
    }
    
    // Main render method - handles only blocks - no more content parsing
    renderTurn(turnData, shouldScroll = true) {
        const { id, role, blocks, content, debug_data, dropdownStates = {}, original_content, turn_number, edit_count, edited_at } = turnData;
        
        // Handle blocks: Required for assistant messages, optional for user messages
        let finalBlocks;
        if (!blocks) {
            if (role === 'assistant') {
                console.error('[BROKEN-RENDER] No blocks provided for assistant message:', turnData);
                throw new Error('Blocks are required for assistant messages');
            } else {
                // User messages can render without blocks
                finalBlocks = [{ type: 'chat', content: content || '', metadata: {} }];
            }
        } else {
            finalBlocks = blocks;
        }
        
        const turnDiv = document.createElement('div');
        const turnId = `turn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Use the new turn-based class names
        if (role === 'user') {
            turnDiv.className = 'turn user-turn';
        } else if (role === 'assistant') {
            turnDiv.className = 'turn assistant-turn';
        } else {
            turnDiv.className = `turn ${role}-turn`; // Fallback for other roles
        }
        
        turnDiv.dataset.turnId = turnId;
        if (id) {
            turnDiv.dataset.messageId = id;
        }
        if (id) {
            turnDiv.dataset.messageId = id;
        }
        
        // Create content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'turn-content';
        
        // Always render blocks - no conditionals needed
        let thinkingIndex = 0;
        let toolIndex = 0;
        
        finalBlocks.forEach((blockData) => {
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
        
        turnDiv.appendChild(contentDiv);
        
        // Add message actions bar
        this.addMessageActions(turnDiv, role, turnId, turn_number, id);
        
        // Add debug toggle and panel if debug data provided
        if (debug_data) {
            this.addDebugPanel(turnDiv, turnId, debug_data, turn_number);
        }
        
        this.container.appendChild(turnDiv);
        
        // Handle scrolling
        if (shouldScroll) {
            smartScrollToBottom(scrollContainer);
        }
        
        // Update chat preview and handle title generation
        this.handleTurnMeta(role, finalBlocks.filter(b => b.type === 'chat').map(b => b.content).join(' '));
        
        return turnDiv;
    }
    
    // Create message element without appending to container (for seamless replacement)
    createTurnElement(turnData, shouldScroll = true) {
        const { id, role, blocks, content, debug_data, dropdownStates = {}, turn_number } = turnData;
        
        // REMOVING third rendering path: No more ContentParser fallback
        // If blocks aren't provided, we have a broken pipeline
        let finalBlocks;
        if (!blocks) {
            console.error('[BROKEN-RENDER] No blocks provided for element creation:', turnData);
            throw new Error('Blocks are required for element creation - 3rd rendering path has been removed');
        } else {
            finalBlocks = blocks;
        }
        
        const turnDiv = document.createElement('div');
        const turnId = `turn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Use the new turn-based class names
        if (role === 'user') {
            turnDiv.className = 'turn user-turn';
        } else if (role === 'assistant') {
            turnDiv.className = 'turn assistant-turn';
        } else {
            turnDiv.className = `turn ${role}-turn`; // Fallback for other roles
        }
        
        turnDiv.dataset.turnId = turnId;
        
        // Create content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'turn-content';
        
        // Always render blocks - no conditionals needed
        let thinkingIndex = 0;
        let toolIndex = 0;
        
        finalBlocks.forEach((blockData) => {
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
        
        turnDiv.appendChild(contentDiv);
        
        // Add message actions bar
        this.addMessageActions(turnDiv, role, turnId, turn_number, id);
        
        // Add debug toggle and panel if debug data provided
        if (debug_data) {
            this.addDebugPanel(turnDiv, turnId, debug_data, turn_number);
        }
        
        // Handle metadata but don't scroll yet
        this.handleTurnMeta(role, finalBlocks.filter(b => b.type === 'chat').map(b => b.content).join(' '));
        
        return turnDiv;
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
    addDebugPanel(messageDiv, messageId, debugData, turnNumber = null) {
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
        
        const debugPanel = createDebugPanel(messageId, debugData, turnNumber);
        messageDiv.appendChild(debugPanel);
    }
    
    // Add message actions bar to turn
    addMessageActions(turnDiv, role, turnId, turnNumber = null, messageId = null) {
        const actionsContainer = document.createElement('div');
        actionsContainer.className = 'message-actions';
        actionsContainer.dataset.turnId = turnId;
        actionsContainer.dataset.role = role;
        actionsContainer.dataset.turnNumber = turnNumber;
        if (messageId) {
            actionsContainer.dataset.messageId = messageId;
        }
        
        // Action buttons container
        const actionButtons = document.createElement('div');
        actionButtons.className = 'action-buttons';
        
        // Edit button
        const editBtn = document.createElement('button');
        editBtn.className = 'action-btn edit-btn';
        editBtn.title = 'Edit message';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => this.handleEditMessage(turnId, role, turnNumber, messageId));
        
        // Edit and retry button
        const editRetryBtn = document.createElement('button');
        editRetryBtn.className = 'action-btn edit-retry-btn';
        editRetryBtn.title = 'Edit and regenerate';
        editRetryBtn.textContent = 'Edit & Retry';
        editRetryBtn.addEventListener('click', () => this.handleEditAndRetry(turnId, role, turnNumber, messageId));
        
        // Retry button (only show for assistant messages)
        const retryBtn = document.createElement('button');
        retryBtn.className = 'action-btn retry-btn';
        retryBtn.title = 'Regenerate response';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => this.handleRetryMessage(turnId, role, turnNumber, messageId));
        
        // Add buttons to container
        actionButtons.appendChild(editBtn);
        actionButtons.appendChild(editRetryBtn);
        
        // Only show retry for assistant messages
        if (role === 'assistant') {
            actionButtons.appendChild(retryBtn);
        }
        
        // Version navigation container (hidden for now)
        const versionNav = document.createElement('div');
        versionNav.className = 'version-nav';
        versionNav.style.display = 'none';
        versionNav.innerHTML = `
            <button class="nav-btn prev-btn" title="Previous version">&lt;</button>
            <span class="version-indicator">1/1</span>
            <button class="nav-btn next-btn" title="Next version">&gt;</button>
        `;
        
        // Assemble the actions container
        actionsContainer.appendChild(actionButtons);
        actionsContainer.appendChild(versionNav);
        
        // Insert before debug toggle if it exists, otherwise just append
        const debugToggle = turnDiv.querySelector('.debug-toggle');
        if (debugToggle) {
            turnDiv.insertBefore(actionsContainer, debugToggle);
        } else {
            turnDiv.appendChild(actionsContainer);
        }
    }
    
    // Handle turn-level editing - show all messages in the turn
    async handleEditMessage(turnId, role, turnNumber, messageId) {
        console.log(`[EDIT] Edit turn - turnId: ${turnId}, role: ${role}, turnNumber: ${turnNumber}`);
        
        if (!turnNumber) {
            alert('Cannot edit: Turn number not available');
            return;
        }
        
        const turnDiv = document.querySelector(`[data-turn-id="${turnId}"]`);
        if (!turnDiv) {
            alert('Cannot edit: Turn element not found');
            return;
        }
        
        // Check if already in edit mode
        if (turnDiv.classList.contains('editing')) {
            return;
        }
        
        try {
            // Get all messages for this turn
            const response = await getTurnMessages(currentChatId, turnNumber);
            
            if (!response || !response.messages) {
                alert('Cannot edit: Invalid response from server');
                console.error('[EDIT] Invalid response:', response);
                return;
            }
            
            const turnMessages = response.messages;
            
            if (!Array.isArray(turnMessages) || turnMessages.length === 0) {
                alert('Cannot edit: No messages found for this turn');
                console.log(`[EDIT] No messages found for turn ${turnNumber}`);
                return;
            }
            
            console.log(`[EDIT] Got ${turnMessages.length} messages for turn ${turnNumber}`);
            
            // Enter message-based edit mode
            this.enterMessageEditMode(turnDiv, turnMessages, turnNumber);
            
        } catch (error) {
            console.error('[EDIT] Error getting turn messages:', error);
            alert(`Error loading turn for editing: ${error.message}`);
        }
    }
    
    async handleEditAndRetry(turnId, role, turnNumber, messageId) {
        console.log(`[EDIT-RETRY] Edit and retry - turnId: ${turnId}, role: ${role}, turnNumber: ${turnNumber}, messageId: ${messageId}`);
        // TODO: Implement edit and retry functionality
        alert('Edit & Retry functionality coming soon!');
    }
    
    async handleRetryMessage(turnId, role, turnNumber, messageId) {
        console.log(`[RETRY] Retry message - turnId: ${turnId}, role: ${role}, turnNumber: ${turnNumber}, messageId: ${messageId}`);
        // TODO: Implement retry functionality
        alert('Retry functionality coming soon!');
    }
    
    // Enter edit mode for a message
    enterEditMode(turnDiv, chatBlock, messageData, messageId) {
        // Mark as editing
        turnDiv.classList.add('editing');
        
        // Store original content
        const originalHtml = chatBlock.innerHTML;
        
        // Create edit container
        const editContainer = document.createElement('div');
        editContainer.className = 'edit-container';
        
        // Create textarea with current content
        const textarea = document.createElement('textarea');
        textarea.className = 'edit-textarea';
        textarea.value = messageData.content;
        textarea.rows = Math.max(3, messageData.content.split('\n').length + 1);
        
        // Create edit controls
        const editControls = document.createElement('div');
        editControls.className = 'edit-controls';
        
        const saveBtn = document.createElement('button');
        saveBtn.className = 'edit-btn-save';
        saveBtn.textContent = 'Save';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'edit-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        
        // Add event handlers
        saveBtn.addEventListener('click', () => {
            this.saveEdit(turnDiv, chatBlock, textarea.value, messageId, originalHtml);
        });
        
        cancelBtn.addEventListener('click', () => {
            this.cancelEdit(turnDiv, chatBlock, originalHtml);
        });
        
        // Handle Escape key to cancel
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.cancelEdit(turnDiv, chatBlock, originalHtml);
            }
            // Ctrl+Enter to save
            if (e.key === 'Enter' && e.ctrlKey) {
                this.saveEdit(turnDiv, chatBlock, textarea.value, messageId, originalHtml);
            }
        });
        
        // Assemble edit UI
        editControls.appendChild(saveBtn);
        editControls.appendChild(cancelBtn);
        editContainer.appendChild(textarea);
        editContainer.appendChild(editControls);
        
        // Replace chat block content with edit UI
        chatBlock.innerHTML = '';
        chatBlock.appendChild(editContainer);
        
        // Focus the textarea
        textarea.focus();
        textarea.select();
    }
    
    // Save the edited message
    async saveEdit(turnDiv, chatBlock, newContent, messageId, originalHtml) {
        if (!newContent.trim()) {
            alert('Message cannot be empty');
            return;
        }
        
        try {
            // Show loading state
            const saveBtn = turnDiv.querySelector('.edit-btn-save');
            const originalSaveText = saveBtn.textContent;
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;
            
            // Call API to update message
            const result = await editMessage(messageId, newContent.trim());
            
            // Update the UI with new content
            chatBlock.innerHTML = formatMessage(escapeHtml(newContent.trim()));
            
            // Exit edit mode
            turnDiv.classList.remove('editing');
            
            console.log('[EDIT] Message saved successfully:', result);
            
            // Show edit indicator if this was edited
            if (result.edit_count > 1) {
                this.addEditIndicator(turnDiv, result.edit_count);
            }
            
        } catch (error) {
            console.error('[EDIT] Error saving message:', error);
            alert(`Error saving message: ${error.message}`);
            
            // Restore original content on error
            chatBlock.innerHTML = originalHtml;
            turnDiv.classList.remove('editing');
        }
    }
    
    // Cancel editing and restore original content
    cancelEdit(turnDiv, chatBlock, originalHtml) {
        chatBlock.innerHTML = originalHtml;
        turnDiv.classList.remove('editing');
    }
    
    // Add visual indicator that message was edited
    addEditIndicator(turnDiv, editCount) {
        // Remove existing indicator
        const existing = turnDiv.querySelector('.edit-indicator');
        if (existing) {
            existing.remove();
        }
        
        // Add new indicator
        const indicator = document.createElement('span');
        indicator.className = 'edit-indicator';
        indicator.textContent = `(edited ${editCount}x)`;
        indicator.title = 'This message has been edited';
        
        // Insert after the turn content
        const turnContent = turnDiv.querySelector('.turn-content');
        if (turnContent) {
            turnContent.appendChild(indicator);
        }
    }
    
    // Find message ID for a turn by looking it up in the database
    async findMessageIdForTurn(turnNumber, role) {
        try {
            // Use global variables
            const apiBase = window.location.origin;
            const chatId = currentChatId; // Global variable from utils.js
            
            if (!chatId) {
                console.error('[EDIT] No current chat ID available');
                return null;
            }
            
            // Get current chat history to find the message
            const response = await fetch(`${apiBase}/api/chat/${chatId}/history`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const history = await response.json();
            
            // Find message with matching turn number and role
            const message = history.messages.find(msg => 
                msg.turn_number === turnNumber && msg.role === role
            );
            
            console.log(`[EDIT] Found message ID ${message?.id} for turn ${turnNumber}, role ${role}`);
            return message ? message.id : null;
            
        } catch (error) {
            console.error('[EDIT] Error finding message ID:', error);
            return null;
        }
    }
    
    // Legacy function - removed, use enterMessageEditMode instead
    enterTurnEditMode() {
        throw new Error('This function has been replaced by enterMessageEditMode');
    }
    
    // ===== NEW MESSAGE-BASED EDIT SYSTEM =====
    enterMessageEditMode(turnDiv, messages, turnNumber) {
        turnDiv.classList.add('editing');
        
        // Store original content
        const originalHtml = turnDiv.innerHTML;
        
        // Create edit container
        const editContainer = document.createElement('div');
        editContainer.className = 'message-edit-container';
        
        // Add header
        const header = document.createElement('div');
        header.className = 'edit-header';
        header.innerHTML = `<h3>Edit Turn ${turnNumber} Messages</h3>`;
        editContainer.appendChild(header);
        
        // Create edit form for each message
        const editForm = document.createElement('div');
        editForm.className = 'edit-form';
        
        messages.forEach((message, index) => {
            const messageContainer = document.createElement('div');
            messageContainer.className = 'editable-message';
            messageContainer.dataset.messageId = message.id;
            
            // Message header
            const messageHeader = document.createElement('div');
            messageHeader.className = 'message-header';
            messageHeader.innerHTML = `<strong>${message.role}</strong> (ID: ${message.id})`;
            messageContainer.appendChild(messageHeader);
            
            // Textarea for raw content
            const textarea = document.createElement('textarea');
            textarea.className = 'message-content-textarea';
            textarea.value = message.content || '';
            textarea.rows = Math.max(3, (message.content || '').split('\n').length + 1);
            messageContainer.appendChild(textarea);
            
            editForm.appendChild(messageContainer);
        });
        
        editContainer.appendChild(editForm);
        
        // Add buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'edit-buttons';
        
        const saveBtn = document.createElement('button');
        saveBtn.className = 'edit-btn-save';
        saveBtn.textContent = 'Save All Messages';
        saveBtn.addEventListener('click', () => {
            this.saveAllMessages(turnDiv, editContainer, turnNumber, originalHtml);
        });
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'edit-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            this.cancelMessageEdit(turnDiv, originalHtml);
        });
        
        buttonContainer.appendChild(saveBtn);
        buttonContainer.appendChild(cancelBtn);
        editContainer.appendChild(buttonContainer);
        
        // Replace turn content with edit interface
        turnDiv.innerHTML = '';
        turnDiv.appendChild(editContainer);
    }
    
    // Save all edited messages
    async saveAllMessages(turnDiv, editContainer, turnNumber, originalHtml) {
        const messageContainers = editContainer.querySelectorAll('.editable-message');
        const saveBtn = editContainer.querySelector('.edit-btn-save');
        
        try {
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;
            
            // Save each message
            const savePromises = Array.from(messageContainers).map(async (container) => {
                const messageId = container.dataset.messageId;
                const textarea = container.querySelector('.message-content-textarea');
                const newContent = textarea.value;
                
                console.log(`[EDIT] Saving message ${messageId} with content:`, newContent);
                
                if (messageId && newContent !== undefined) {
                    return editMessage(messageId, newContent);
                }
            });
            
            await Promise.all(savePromises.filter(Boolean));
            
            // Exit edit mode and reload
            await this.exitMessageEditMode(turnDiv, turnNumber);
            
        } catch (error) {
            console.error('[EDIT] Error saving messages:', error);
            alert(`Error saving messages: ${error.message}`);
            
            saveBtn.textContent = 'Save All Messages';
            saveBtn.disabled = false;
        }
    }
    
    // Cancel message editing
    cancelMessageEdit(turnDiv, originalHtml) {
        turnDiv.innerHTML = originalHtml;
        turnDiv.classList.remove('editing');
    }
    
    // Exit edit mode and reload the turn with updated content
    async exitMessageEditMode(turnDiv, turnNumber) {
        try {
            console.log(`[EDIT] Exiting edit mode for turn ${turnNumber}`);
            
            turnDiv.classList.remove('editing');
            
            // Reload the entire chat to show changes
            console.log(`[EDIT] Reloading chat to show changes...`);
            await loadChatHistory(currentChatId);
            
        } catch (error) {
            console.error('[EDIT] Error in exitMessageEditMode:', error);
        }
    }
    
    // Handle message metadata (preview, title generation)
    handleTurnMeta(role, content) {
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
    const turnsContainer = document.getElementById('messages');
    if (turnsContainer) {
        chatRenderer = new ChatRenderer(turnsContainer);
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
function createDebugPanel(messageId, debugData, turnNumber = null) {
    const debugPanel = document.createElement('div');
    debugPanel.className = 'debug-panel-container';
    debugPanel.dataset.messageId = messageId;
    debugPanel.style.display = 'none'; // Initially hidden
    debugPanel.style.width = '100%';
    debugPanel.style.boxSizing = 'border-box';
    
    // Inject correct turn number from frontend since backend no longer provides it
    if (turnNumber !== null && debugData) {
        debugData.currentTurnNumber = turnNumber;
        // Note: currentTurnMessages will still be null from backend
        // but we show complete history instead
    }
    
    // Use the new sequential debug panel
    debugPanel.innerHTML = createDebugPanelContent(debugData);
    
    // Force width on all debug dropdowns
    setTimeout(() => {
        const dropdowns = debugPanel.querySelectorAll('.debug-dropdown');
        dropdowns.forEach(dropdown => {
            dropdown.style.width = '100%';
            dropdown.style.boxSizing = 'border-box';
            
            const content = dropdown.querySelector('.debug-dropdown-content');
            if (content) {
                content.style.width = '100%';
                content.style.boxSizing = 'border-box';
                
                const pre = content.querySelector('pre');
                if (pre) {
                    pre.style.width = '100%';
                    pre.style.boxSizing = 'border-box';
                }
            }
        });
    }, 0);
    
    // Load turn messages if turn number is available
    // Check for turn number after we've potentially updated debugData.currentTurnNumber
    const finalTurnNumber = (debugData && debugData.currentTurnNumber) || turnNumber;
    if (finalTurnNumber !== null && finalTurnNumber !== undefined) {
        console.log(`[DEBUG-PANEL] Turn message loading for turn ${finalTurnNumber}, chatId: ${currentChatId}`);
    } else {
        console.log(`[DEBUG-PANEL] Not loading turn messages - finalTurnNumber: ${finalTurnNumber}, turnNumber: ${turnNumber}, debugData.currentTurnNumber: ${debugData ? debugData.currentTurnNumber : 'N/A'}`);
    }
    
    return debugPanel;
}
