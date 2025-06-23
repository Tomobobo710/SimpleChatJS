// Main application logic - App initialization, DOM setup, and message routing

// DOM elements
let messageInput, sendBtn, turnsContainer, scrollContainer, conductorModeCheckbox;
let settingsModal, settingsBtn, newChatBtn, closeModalBtn;
let apiUrlInput, apiKeyInput, modelNameInput, modelSelectDropdown, mainModelSelect, refreshModelsBtn, saveSettingsBtn, debugPanelsInput, testConnectionBtn;
let mcpServersDiv;
let mcpConfigModal, mcpConfigBtn, closeMcpModalBtn, mcpConfigText, saveMcpConfigBtn, testMcpConfigBtn;
let chatList, chatTitle, chatInfo;

// Chat state
let chatHistories = new Map(); // Store chat histories locally
let currentTurnNumber = 0; // Track current turn number for active chat

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeElements();
    setupEventListeners();
    loadInitialSettings();
    updateMCPStatus();
    
    // Auto-connect to MCP servers at startup
    setTimeout(autoConnectMCP, 200);
    
    // Load chat list after a short delay to ensure DOM is ready
    setTimeout(loadChatList, 300);
    
    logger.info('Simple Chat initialized');
});

// Shared utility function for getting enabled tool definitions
async function getEnabledToolDefinitions() {
    let enabledToolDefinitions = [];
    try {
        const mcpStatus = await getMCPStatus();
        if (mcpStatus.connected && mcpStatus.servers) {
            mcpStatus.servers.forEach(server => {
                if (server.connected && server.tools) {
                    server.tools.forEach(toolName => {
                        if (isToolEnabled(server.name, toolName)) {
                            enabledToolDefinitions.push({
                                name: toolName,
                                server: server.name,
                                type: 'function'
                            });
                        }
                    });
                }
            });
        }
    } catch (error) {
        logger.warn('Failed to get MCP tools:', error);
    }
    return enabledToolDefinitions;
}
// Turn management functions
function getNextTurnNumber() {
    return ++currentTurnNumber;
}

function resetTurnTracking() {
    currentTurnNumber = 0;
}

async function initializeTurnTrackingForChat(chatId) {
    try {
        if (!chatId) {
            resetTurnTracking();
            return;
        }
        
        // Get the highest turn number from this chat
        const response = await getCurrentTurnNumber(chatId);
        currentTurnNumber = response.turn_number || 0;
        logger.debug(`[TURN] Initialized turn tracking for chat ${chatId}: currentTurnNumber=${currentTurnNumber}`);
    } catch (error) {
        logger.warn('[TURN] Failed to initialize turn tracking, starting from 0:', error);
        resetTurnTracking();
    }
}

// Handle sending a message
async function handleSendMessage() {
    const sendBtn = document.getElementById('sendBtn');
    
    // Check if we're in stop mode
    if (sendBtn.classList.contains('stop-mode')) {
        stopGeneration();
        return;
    }
    
    const message = messageInput.value.trim();
    if (!message) return;
    
    const isConductorMode = conductorModeCheckbox.checked;
    
    // Clear input and show loading
    messageInput.value = '';
    setLoading(true);
    
    try {
        // Get clean conversation history once using our utility function
        const conversationHistory = await getCleanConversationHistory(currentChatId, message);
        
        if (isConductorMode) {
            // Use conductor mode with block system
            await handleConductorChat(message, conversationHistory);
        } else {
            // Simple chat mode
            await handleSimpleChat(message, conversationHistory);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            logger.info('Message generation was stopped by user');
        } else {
            showError(`Failed to send message: ${error.message}`);
        }
    } finally {
        setLoading(false);
        messageInput.focus();
    }
}

// Handle conductor chat using blocks
async function handleConductorChat(message, conversationHistory) {
    logger.info('[CONDUCTOR] Starting conductor mode with blocks');
    
    // Get settings and tools for debug data
    const settings = loadSettings();
    const enabledToolDefinitions = await getEnabledToolDefinitions();
    
    // Create user debug data using sequence format
    const userDebugData = {
        sequence: [
            {
                type: 'user_input',
                step: 1,
                data: {
                    userQuery: {
                        message: message,
                        chat_id: currentChatId,
                        conductor_mode: true,
                        timestamp: new Date().toISOString(),
                        message_length: message.length
                    },
                    tools: {
                        total: enabledToolDefinitions.length,
                        definitions: enabledToolDefinitions
                    },
                    context: {
                        input_method: 'manual',
                        conductor_mode: true,
                        current_chat: currentChatId
                    }
                },
                timestamp: new Date().toISOString()
            }
        ],
        metadata: {
            endpoint: 'user_input',
            timestamp: new Date().toISOString(),
            tools: enabledToolDefinitions.length
        }
    };    
    // Use the conversation history passed from main.js
    userDebugData.conversationHistory = conversationHistory;
    
    // Get turn number for this user message
    const userTurnNumber = getNextTurnNumber();
    
    // Add user message to UI using unified renderer
    const userBlocks = [{ type: 'chat', content: message, metadata: {} }];
    chatRenderer.renderTurn({
        role: 'user',
        blocks: userBlocks,
        debug_data: userDebugData,
        content: message,
        turn_number: userTurnNumber
    }, true);
    
    // Save user message with blocks FIRST (same sequence as simple chat)
    try {
        await saveCompleteMessage(currentChatId, { role: 'user', content: message }, userTurnNumber, userDebugData, userBlocks);
    } catch (error) {
        logger.warn('Failed to save user message:', error);
    }
    
    // Create assistant message div (same pattern as simple chat)
    const assistantMessageDiv = document.createElement('div');
    assistantMessageDiv.className = 'message assistant';
    assistantMessageDiv.innerHTML = '';
    turnsContainer.appendChild(assistantMessageDiv);
    
    try {
        // Initialize conductor
        const conductor = new Conductor();
        
        // Run conductor and get result
        const result = await conductor.runConductor(message, assistantMessageDiv);
        
        // Get turn number and inject it into debug data BEFORE creating final message data
        const assistantTurnNumber = getNextTurnNumber();
        if (result.debugData) {
            result.debugData.currentTurnNumber = assistantTurnNumber;
        }
        
        // Prepare final content BEFORE removing temp elements (seamless transition)
        const finalMessageData = {
            role: 'assistant',
            blocks: result.blocks || [],
            debug_data: result.debugData,
            dropdownStates: result.dropdownStates || {},
            isPartial: result.wasAborted,
            turn_number: assistantTurnNumber
        };
        
        // Create final content off-screen (no flicker!)
        const finalContent = chatRenderer.createTurnElement(finalMessageData, false);
        
        // Seamless replacement: swap content atomically
        const parent = assistantMessageDiv.parentNode;
        parent.replaceChild(finalContent, assistantMessageDiv);
        
        // NOW clean up the temp container from conductor
        if (conductor.tempContainer && conductor.tempContainer.parentNode) {
            conductor.tempContainer.remove();
        }
        
        // Handle scrolling after replacement
        smartScrollToBottom(scrollContainer);
        
        // Check if conductor was aborted (for saving logic)
        if (result.wasAborted) {
            logger.info('[CONDUCTOR] Handling aborted conductor result');
            
            // Save whatever content the AI actually generated (even if empty)
            try {
                await saveCompleteMessage(currentChatId, { role: 'assistant', content: result.content || '' }, assistantTurnNumber, result.debugData, result.blocks || []);
                updateChatPreview(currentChatId, result.content || '');
            } catch (saveError) {
                logger.warn('[CONDUCTOR] Failed to save aborted message:', saveError);
            }
            
            return; // Exit cleanly
        }
        
        // Normal completion - already handled by seamless replacement above
        
        // Save assistant message with both raw content and blocks (same as simple chat)
        try {
            await saveCompleteMessage(currentChatId, { role: 'assistant', content: result.content }, assistantTurnNumber, result.debugData, result.blocks || []);
            // Update chat preview with display content
            updateChatPreview(currentChatId, result.content);
        } catch (error) {
            logger.error('[CONDUCTOR] Failed to save messages:', error);
        }
        
        logger.info('[CONDUCTOR] Conductor session completed successfully');
        
    } catch (error) {        
        // Handle other errors
        logger.error('[CONDUCTOR] Conductor failed:', error, true);
        
        // Show error in UI using ChatRenderer (unified with simple chat)
        assistantMessageDiv.remove();
        const errorTurnNumber = getNextTurnNumber();
        
        chatRenderer.renderTurn({
            role: 'assistant',
            blocks: [{
                type: 'chat',
                content: `[ERROR] Conductor failed: ${error.message}`,
                metadata: {}
            }],
            debug_data: null,
            turn_number: errorTurnNumber
        }, true);
        
        try {
            // User message was already saved above, just save the error assistant message
            await saveCompleteMessage(currentChatId, { role: 'assistant', content: `Error: ${error.message}` }, errorTurnNumber, null, []);
        } catch (saveError) {
            logger.error('[CONDUCTOR] Failed to save error message:', saveError);
        }
    }
}