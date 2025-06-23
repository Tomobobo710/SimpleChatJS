// ChatRenderer.js - Unified rendering system
// Takes block data and renders consistently for both live and loaded chats

class ChatRenderer {
    constructor(containerElement) {
        this.container = containerElement;
    }
    
    // Main render method - takes blocks and renders them to DOM
    renderTurn(turnData, shouldScroll = true) {
        const { role, blocks, debug_data, dropdownStates = {}, original_content, turn_number } = turnData;
        
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
        
        turnDiv.appendChild(contentDiv);
        
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
        this.handleTurnMeta(role, turnData.content || this.extractTextFromBlocks(blocks));
        
        return turnDiv;
    }
    
    // Create message element without appending to container (for seamless replacement)
    createTurnElement(turnData, shouldScroll = true) {
        const { role, blocks, debug_data, dropdownStates = {}, turn_number } = turnData;
        
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
        
        turnDiv.appendChild(contentDiv);
        
        // Add debug toggle and panel if debug data provided
        if (debug_data) {
            this.addDebugPanel(turnDiv, turnId, debug_data, turn_number);
        }
        
        // Handle metadata but don't scroll yet
        this.handleTurnMeta(role, turnData.content || this.extractTextFromBlocks(blocks));
        
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
        console.log(`[DEBUG-PANEL] Scheduling turn message loading for turn ${finalTurnNumber}, chatId: ${currentChatId}`);
        setTimeout(() => {
            populateTurnMessages(debugPanel, finalTurnNumber, currentChatId);
        }, 100); // Small delay to ensure DOM is ready
    } else {
        console.log(`[DEBUG-PANEL] Not loading turn messages - finalTurnNumber: ${finalTurnNumber}, turnNumber: ${turnNumber}, debugData.currentTurnNumber: ${debugData ? debugData.currentTurnNumber : 'N/A'}`);
    }
    
    return debugPanel;
}
