// Simple Chat Mode - Direct streaming chat without conductor complexity

async function handleSimpleChat(messageContent, conversationHistory) {
    // These variables will be used across both user and assistant phases
    let requestId, requestInfo;
    
    // Handle both string messages and multimodal content
    const isMultimodal = Array.isArray(messageContent);
    const textContent = isMultimodal 
        ? messageContent.find(part => part.type === 'text')?.text || '[Images only]'
        : messageContent;
    const imageCount = isMultimodal 
        ? messageContent.filter(part => part.type === 'image').length 
        : 0;
    
    logger.info(`Starting simple chat - ${isMultimodal ? 'multimodal' : 'text-only'} message${imageCount > 0 ? ` with ${imageCount} image(s)` : ''}`);
    
    // Get enabled tools that will be sent to AI (do this ONCE)
    const settings = loadSettings();
    const enabledToolDefinitions = await getEnabledToolDefinitions();
    
    // Generate requestId upfront - will be used for both user and assistant
    requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    logger.debug('[SIMPLE-CHAT] Generated requestId:', requestId);
    
    // Get turn number for this user message (frontend manages turns now)
    const userTurnNumber = getNextTurnNumber();
    window.currentUserTurnNumber = userTurnNumber; // Store for backend to use
    
    // Add user message to UI using global chatRenderer (same as saved chats)
    chatRenderer.renderTurn({
        role: 'user',
        content: messageContent, // Pass full content (string or multimodal array)
        turn_number: userTurnNumber
    }, true);
    
    // Save user message to database
    try {
        await saveCompleteMessage(currentChatId, { role: 'user', content: messageContent }, null, userTurnNumber);
    } catch (error) {
        logger.warn('Failed to save user message:', error);
    }
    
    // Prepare debug data with the correct turn number
    const userDebugData = {
        sequence: [
            {
                type: 'user_input',
                step: 1,
                data: {
                    userQuery: {
                        message: textContent,
                        content: messageContent, // Full content for debugging
                        chat_id: currentChatId,
                        conductor_mode: false,
                        timestamp: new Date().toISOString(),
                        message_length: textContent.length,
                        is_multimodal: isMultimodal,
                        image_count: imageCount,
                        turn_number: userTurnNumber // Include turn number
                    },
                    tools: {
                        total: enabledToolDefinitions.length,
                        definitions: enabledToolDefinitions
                    },
                    context: {
                        input_method: 'manual',
                        conductor_mode: false,
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
        },
        currentTurnNumber: userTurnNumber // Add turn number at top level
    };    
    
    // Use same field names as assistant debug data for consistency
    userDebugData.completeMessageHistory = conversationHistory || [];
    userDebugData.conversationHistory = conversationHistory || [];  // Keep for debug panel compatibility
    userDebugData.currentTurnNumber = userTurnNumber;
    
    // USER TURN MAKES THE HTTP REQUEST
    requestInfo = initiateMessageRequest(messageContent, false, enabledToolDefinitions, null, null, false, false, requestId);
    // Save user debug data BEFORE making request so backend can find it
    try {
        await saveTurnData(currentChatId, userTurnNumber, userDebugData);
        logger.info(`[TURN-DEBUG] Saved user debug data for turn ${userTurnNumber}`);
    } catch (error) {
        logger.warn('Failed to save user turn debug data:', error);
    }
    
    logger.info('[USER-TURN] Making HTTP request with requestId:', requestId);
    
    // Capture the ACTUAL request we're making
    userDebugData.actualHttpRequest = {
        url: `${window.location.origin}/api/chat`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: {
            message: messageContent,
            chat_id: currentChatId,
            conductor_mode: false,
            enabled_tools: enabledToolDefinitions,
            request_id: requestId,
            user_turn_number: userTurnNumber
        }
    };
    
    // Show immediate debug data (will be updated with actual request later)
    try {
        await saveTurnData(currentChatId, userTurnNumber, userDebugData);
    } catch (error) {
        logger.info('[FRONTEND] Failed to save initial debug data:', error);
    }
    
    // Await the response in the user turn
    const response = await requestInfo.fetchPromise;
    
    // Get the ACTUAL AI request from response headers
    const actualRequestHeader = response.headers.get('X-Actual-Request');
    if (actualRequestHeader) {
        try {
            const actualRequest = JSON.parse(decodeURIComponent(actualRequestHeader));
            userDebugData.actualHttpRequest.body = actualRequest;
            
            // Update debug data with the real AI request
            await saveTurnData(currentChatId, userTurnNumber, userDebugData);
            
            // Refresh the user debug panel to show the actual request
            const userTurn = document.querySelector(`[data-turn-number="${userTurnNumber}"].user-turn`);
            if (userTurn) {
                const debugPanel = userTurn.querySelector('.debug-panel-container');
                if (debugPanel) {
                    // Force refresh the debug panel content
                    debugPanel.remove();
                    const debugToggle = userTurn.querySelector('.debug-toggle');
                    if (debugToggle) {
                        debugToggle.click(); // This will recreate the panel with fresh data
                    }
                }
            }
        } catch (error) {
            console.error('[FRONTEND] Failed to parse actual request header:', error);
        }
    }
    
    logger.info('[USER-TURN] HTTP request complete, creating assistant turn');
    
    // USER TURN CREATES THE ASSISTANT TURN AND PROCESSES RESPONSE
    const assistantTurnNumber = getNextTurnNumber();
    
    // Create assistant turn container
    const assistantTurnDiv = document.createElement('div');
    assistantTurnDiv.className = 'turn assistant-turn';
    assistantTurnDiv.dataset.turnNumber = assistantTurnNumber;
    turnsContainer.appendChild(assistantTurnDiv);
    
    // Process the response and populate assistant turn
    const processor = new StreamingMessageProcessor();
    const tempContainer = document.createElement('div');
    assistantTurnDiv.appendChild(tempContainer);
    const liveRenderer = new ChatRenderer(tempContainer);
    
    // Stream the response
    for await (const chunk of streamResponse(response)) {
        processor.addChunk(chunk);
        updateLiveRendering(processor, liveRenderer, tempContainer);
        smartScrollToBottom(scrollContainer);
    }
    
    processor.finalize();
    
    // Get assistant debug data
    let assistantDebugData = null;
    try {
        const debugResponse = await fetch(`${window.location.origin}/api/debug/${requestId}`);
        if (debugResponse.ok) {
            assistantDebugData = await debugResponse.json();
            if (assistantDebugData) {
                assistantDebugData.currentTurnNumber = assistantTurnNumber;
                
                // Add the current assistant message to debug data
                // (we can't query database yet since we haven't saved it)
                const currentAssistantMessage = {
                    role: 'assistant',
                    content: processor.getRawContent() || '',
                    turn_number: assistantTurnNumber
                };
                
                assistantDebugData.currentTurnMessages = [currentAssistantMessage];
                
                // Get complete history (without current message since it's not saved yet)
                try {
                    const history = await getChatHistory(currentChatId);
                    assistantDebugData.completeMessageHistory = [...(history.messages || []), currentAssistantMessage];
                } catch (error) {
                    console.warn('Failed to get chat history for assistant debug:', error);
                    assistantDebugData.completeMessageHistory = [currentAssistantMessage];
                }
            }
        }
    } catch (error) {
        console.warn('Failed to fetch assistant debug data:', error);
    }
    
    // Render final assistant turn
    tempContainer.remove();
    assistantTurnDiv.remove();
    
    chatRenderer.renderTurn({
        role: 'assistant',
        blocks: processor.getBlocks(),
        content: processor.getRawContent() || '',
        turn_number: assistantTurnNumber,
        debug_data: assistantDebugData
    }, true);
    
    // Save assistant message and debug data
    try {
        await saveCompleteMessage(currentChatId, { 
            role: 'assistant', 
            content: processor.getRawContent() || '' 
        }, null, assistantTurnNumber);
        
        // Save assistant debug data to turn-based storage
        if (assistantDebugData) {
            await saveTurnData(currentChatId, assistantTurnNumber, assistantDebugData);
            logger.info(`[ASSISTANT-DEBUG] Saved debug data for turn ${assistantTurnNumber}`);
        }
        
    } catch (error) {
        logger.warn('Failed to save assistant message or debug data:', error);
    }
    
    logger.info('[USER-TURN] Completed - created and populated assistant turn');
    
    // Add API request info to debug data
    userDebugData.sequence.push({
        type: 'ai_http_request',
        step: userDebugData.sequence.length + 1,
        timestamp: new Date().toISOString(),
        data: {
            requestId: requestId,
            endpoint: 'chat',
            message: textContent,
            content: messageContent, // Full content for debugging
            is_multimodal: isMultimodal,
            tools_enabled: enabledToolDefinitions.length,
            turn_number: userTurnNumber // Include turn number here too
        }
    });
    userDebugData.apiRequest = {
        url: `${window.location.origin}/api/chat`,
        method: 'POST',
        requestId: requestId,
        timestamp: new Date().toISOString()
    };
        
    // Update user turn with debug data - find the last user message and update it
    const userMessages = turnsContainer.querySelectorAll('.turn.user-turn, .message.user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    if (lastUserMessage) {
        // Add debug panel to existing user message
        const messageId = lastUserMessage.dataset.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        lastUserMessage.dataset.messageId = messageId;
        
        // Remove existing debug panel if any
        const existingDebug = lastUserMessage.querySelector('.debug-panel-container');
        const existingToggle = lastUserMessage.querySelector('.debug-toggle');
        if (existingDebug) existingDebug.remove();
        if (existingToggle) existingToggle.remove();
        
        // Add debug panel using the same method as ChatRenderer
        lastUserMessage.classList.add('has-debug');
        
        const debugToggle = document.createElement('button');
        debugToggle.className = 'debug-toggle';
        debugToggle.dataset.messageId = messageId;
        debugToggle.innerHTML = '+';
        debugToggle.title = 'Show debug info';
        
        const settings = loadSettings();
        if (!settings.debugPanels) {
            debugToggle.style.display = 'none';
        }
        
        debugToggle.addEventListener('click', () => {
            const debugPanel = lastUserMessage.querySelector('.debug-panel-container');
            if (debugPanel) {
                const isHidden = debugPanel.style.display === 'none';
                debugPanel.style.display = isHidden ? 'block' : 'none';
                debugToggle.innerHTML = isHidden ? '−' : '+';
                debugToggle.classList.toggle('active', isHidden);
            }
        });
        
        lastUserMessage.appendChild(debugToggle);
        
        // Create debug panel
        const debugPanel = createDebugPanel(lastUserMessage, messageId, userDebugData, userTurnNumber);
        lastUserMessage.appendChild(debugPanel);
    }
}
