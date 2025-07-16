// Main application logic - App initialization, DOM setup, and message routing

// DOM elements
let messageInput, sendBtn, turnsContainer, scrollContainer, conductorModeCheckbox;
let settingsModal, settingsBtn, newChatBtn, closeModalBtn;
let apiUrlInput, apiKeyInput, modelNameInput, modelSelectDropdown, mainModelSelect, refreshModelsBtn, saveSettingsBtn, debugPanelsInput, testConnectionBtn;
// File upload elements
let fileInput, addFileBtn, imagePreviews, documentPreviews, imageArea, toolsBtn;
// Legacy thinking variables removed
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
        // Ensure enabled tools cache is loaded before checking tool status
        await loadEnabledToolsFromBackend();
        
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
    if (sendBtn.classList.contains('btn-stop')) {
        stopGeneration();
        return;
    }
    
    const textMessage = messageInput.value; // Don't trim - preserve user's intentional whitespace
    const images = getSelectedImages();
    const documents = getSelectedDocuments();
    
    // Need either text, images, or documents
    if (!textMessage && images.length === 0 && documents.length === 0) return;
    
    // Create separated file content (no frontend concatenation)
    let messageContent;
    if (images.length > 0 || documents.length > 0) {
        // Multimodal content with separated files
        messageContent = [];
        
        // Add text part (user text only, no document content)
        if (textMessage) {
            messageContent.push({
                type: 'text',
                text: textMessage
            });
        }
        
        // Add image parts
        images.forEach(imageData => {
            messageContent.push({
                type: 'image',
                imageData: imageData.data,
                mimeType: imageData.mimeType
            });
        });
        
        // Add files as separate part (NEW STRUCTURE)
        if (documents.length > 0) {
            messageContent.push({
                type: 'files',
                files: documents.map(doc => ({
                    fileName: doc.fileName,
                    extractedText: doc.extractedText,
                    size: doc.size,
                    type: doc.type || 'application/octet-stream'
                }))
            });
        }
        
        const parts = [];
        if (textMessage) parts.push('text');
        if (documents.length > 0) parts.push(`${documents.length} file(s)`);
        if (images.length > 0) parts.push(`${images.length} image(s)`);
        logger.info(`Sending separated multimodal message: ${parts.join(' + ')}`);
    } else {
        // Text-only content
        messageContent = textMessage || '';
        logger.info('Sending text-only message');
    }
    
    const isConductorMode = conductorModeCheckbox.checked;
    
    // Clear input and files, show loading
    messageInput.value = '';
    clearSelectedImages();
    clearSelectedDocuments();
    setLoading(true);
    
    try {
        // Get clean conversation history once using our utility function
        // Use text for logging, but we'll send the full messageContent
        const logMessage = typeof messageContent === 'string' ? messageContent : textMessage || '[Images only]';
        const conversationHistory = await getCleanConversationHistory(currentChatId, logMessage);
        
        if (isConductorMode) {
            // Use conductor mode with block system
            await handleConductorChat(messageContent, conversationHistory);
        } else {
            // Simple chat mode
            await handleSimpleChat(messageContent, conversationHistory);
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
    
    // Use same field names as assistant debug data for consistency
    userDebugData.completeMessageHistory = conversationHistory || [];
    userDebugData.currentTurnNumber = userTurnNumber;
    
    // Get turn number for this user message
    const userTurnNumber = getNextTurnNumber();
    
    // Add user message to UI using unified renderer
    chatRenderer.renderTurn({
        role: 'user',
        content: message,
        debug_data: userDebugData,
        turn_number: userTurnNumber
    }, true);
    
    // Save user message and debug data separately (turn-based approach)
    try {
        // Save user message with separated file structure
        const messageForSaving = { role: 'user', content: message };
        
        // If message contains files, store original content and file metadata
        if (Array.isArray(message)) {
            const filesPart = message.find(part => part.type === 'files');
            if (filesPart && filesPart.files) {
                messageForSaving.original_content = message;
                messageForSaving.file_metadata = {
                    hasFiles: true,
                    fileCount: filesPart.files.length,
                    imageCount: message.filter(part => part.type === 'image').length,
                    files: filesPart.files
                };
            }
        }
        
        await saveCompleteMessage(currentChatId, messageForSaving, null, userTurnNumber);
        
        // Save debug data to turn-based storage
        if (userDebugData) {
            await saveTurnData(currentChatId, userTurnNumber, userDebugData);
            logger.info(`[TURN-DEBUG] Saved user debug data for turn ${userTurnNumber}`);
        }
    } catch (error) {
        logger.warn('Failed to save user message or debug data:', error);
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
            content: result.content || '',
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
                // Save assistant message without debug data (turn-based approach)
                await saveCompleteMessage(currentChatId, { role: 'assistant', content: result.content || '' }, null, assistantTurnNumber);
                
                // Save debug data to turn-based storage
                if (result.debugData) {
                    await saveTurnData(currentChatId, assistantTurnNumber, result.debugData);
                    logger.info(`[TURN-DEBUG] Saved aborted debug data for turn ${assistantTurnNumber}`);
                }
                
                updateChatPreview(currentChatId, result.content || '');
            } catch (saveError) {
                logger.warn('[CONDUCTOR] Failed to save aborted message or debug data:', saveError);
            }
            
            return; // Exit cleanly
        }
        
        // Normal completion - already handled by seamless replacement above
        
        // Save assistant message and debug data separately (turn-based approach)
        try {
            // Save assistant message without debug data
            await saveCompleteMessage(currentChatId, { role: 'assistant', content: result.content }, null, assistantTurnNumber);
            
            // Save debug data to turn-based storage
            if (result.debugData) {
                await saveTurnData(currentChatId, assistantTurnNumber, result.debugData);
                logger.info(`[TURN-DEBUG] Saved assistant debug data for turn ${assistantTurnNumber}`);
            }
            
            // Update chat preview with display content
            updateChatPreview(currentChatId, result.content);
        } catch (error) {
            logger.error('[CONDUCTOR] Failed to save messages or debug data:', error);
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
            content: `[ERROR] Conductor failed: ${error.message}`,
            debug_data: null,
            turn_number: errorTurnNumber
        }, true);
        
        try {
            // User message was already saved above, just save the error assistant message
            await saveCompleteMessage(currentChatId, { role: 'assistant', content: `Error: ${error.message}` }, null, errorTurnNumber);
        } catch (saveError) {
            logger.error('[CONDUCTOR] Failed to save error message:', saveError);
        }
    }
}