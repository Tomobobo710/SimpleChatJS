// Simple Chat Mode - Direct streaming chat without conductor complexity

async function handleSimpleChat(message, conversationHistory) {
    // These variables will be used across both user and assistant phases
    let requestId, requestInfo;
    logger.info('Starting simple chat');
    
    // Get enabled tools flags for filtering (do this ONCE)
    const settings = loadSettings();
    await loadEnabledToolsFromBackend(); // Ensure cache is loaded
    const enabledToolsFlags = loadEnabledTools(); // Get flags like {"server.tool": false}
    
    // Generate requestId upfront - will be used for both user and assistant
    requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    logger.debug('[SIMPLE-CHAT] Generated requestId:', requestId);
    
    // Get turn number for this user message (frontend manages turns now)
    const userTurnNumber = getNextTurnNumber();
    
    // Add user message to UI using global chatRenderer (same as saved chats)
    chatRenderer.renderTurn({
        role: 'user',
        content: message,
        turn_number: userTurnNumber
    }, true);
    
    // Save user message to database
    try {
        await saveCompleteMessage(currentChatId, { role: 'user', content: message }, null, userTurnNumber);
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
                        message: message,
                        chat_id: currentChatId,
                        conductor_mode: false,
                        timestamp: new Date().toISOString(),
                        message_length: message.length,
                        turn_number: userTurnNumber // Include turn number
                    },
                    tools: {
                        total: Object.keys(enabledToolsFlags).length,
                        flags: enabledToolsFlags
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
            tools: Object.keys(enabledToolsFlags).length
        },
        currentTurnNumber: userTurnNumber // Add turn number at top level
    };    
    
    // Use same field names as assistant debug data for consistency
    userDebugData.completeMessageHistory = conversationHistory || [];
    userDebugData.conversationHistory = conversationHistory || [];  // Keep for debug panel compatibility
    userDebugData.currentTurnNumber = userTurnNumber;
    
    // INITIATE the API request here (but don't await the response)
    requestInfo = initiateMessageRequest(message, false, enabledToolsFlags, null, null, false, false, requestId);
    logger.info('[SIMPLE-CHAT] Initiated API request with requestId:', requestId);
    
    // Add API request info to debug data
    userDebugData.sequence.push({
        type: 'ai_http_request',
        step: userDebugData.sequence.length + 1,
        timestamp: new Date().toISOString(),
        data: {
            requestId: requestId,
            endpoint: 'chat',
            message: message,
            tools_enabled: Object.keys(enabledToolsFlags).length,
            turn_number: userTurnNumber // Include turn number here too
        }
    });
    userDebugData.apiRequest = {
        url: `${window.location.origin}/api/chat`,
        method: 'POST',
        requestId: requestId,
        timestamp: new Date().toISOString()
    };
    
    // Save user debug data to turn-based storage
    try {
        await saveTurnData(currentChatId, userTurnNumber, userDebugData);
        logger.info(`[TURN-DEBUG] Saved user debug data for turn ${userTurnNumber}`);
    } catch (error) {
        logger.warn('Failed to save user turn debug data:', error);
    }
    
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
    
    // Prepare for assistant response
    const assistantTurnDiv = document.createElement('div');
    assistantTurnDiv.className = 'turn assistant-turn';
    assistantTurnDiv.innerHTML = '';
    turnsContainer.appendChild(assistantTurnDiv);
    
    // Removed fullResponse accumulation to prevent concatenation
    let debugData = null;
    let toolEventSource = null; // Declare outside try block so catch can access it
    let wasAborted = false; // Track if we aborted
    
    // Create the streaming processor (no rendering - just creates blocks)
    const processor = new StreamingMessageProcessor();
    
    // Create a temporary container for real-time rendering during streaming
    const tempContainer = document.createElement('div');
    tempContainer.style.width = '100%';
    tempContainer.style.boxSizing = 'border-box';
    assistantTurnDiv.appendChild(tempContainer);
    const liveRenderer = new ChatRenderer(tempContainer);
    
    try {
        // Connect to tool events stream for the requestId that was generated in the user bubble phase
        // requestId and requestInfo are now already available from the user bubble phase
        logger.debug('[SIMPLE-CHAT] Connecting to SSE:', `${window.location.origin}/api/tools/${requestId}`);
        toolEventSource = new EventSource(`${window.location.origin}/api/tools/${requestId}`);
        toolEventSource.onmessage = (event) => {
            const toolEvent = JSON.parse(event.data);
            logger.debug('[SIMPLE-CHAT] Received tool event:', toolEvent.type, toolEvent.data);
            handleToolEvent(toolEvent, processor, liveRenderer, tempContainer);
        };
        toolEventSource.onerror = (error) => {
            logger.error('[SIMPLE-CHAT] SSE error:', error);
        };
        
        // Now AWAIT the response from the request that was already initiated in the user bubble phase
        logger.debug('[SIMPLE-CHAT] Awaiting response for requestId:', requestId);
        const response = await requestInfo.fetchPromise;
        
        // Stream the response cleanly - no debug parsing needed!
        for await (const chunk of streamResponse(response)) {
            // Don't accumulate fullResponse to avoid concatenation across tool calls
            processor.addChunk(chunk);
            // Update live rendering
            updateLiveRendering(processor, liveRenderer, tempContainer);
            
            // Smart scroll during streaming (throttled for UI responsiveness)
            smartScrollToBottom(scrollContainer);
        }
        
        // Close tool events stream when done
        if (toolEventSource) {
            toolEventSource.close();
        }
        
        // After streaming completes, fetch debug data separately
        let debugData = null;
        
        logger.info('[DEBUG-SEPARATION] Using pre-generated request ID:', requestId);
        
        if (requestId) {
            try {
                const debugResponse = await fetch(`${window.location.origin}/api/debug/${requestId}`);
                if (debugResponse.ok) {
                    const rawDebugData = await debugResponse.json();
                    
                    // Use sequential debug data directly
                    if (rawDebugData.sequence) {
                        debugData = rawDebugData;
                    } 
                } else {
                    logger.warn('No debug data available for request:', requestId);
                }
            } catch (error) {
                logger.warn('Failed to fetch debug data:', error);
            }
        }
        
        // Finalize the processor to handle any remaining content
        processor.finalize();
        
        // Capture dropdown states before removing temp container
        const dropdownStates = {};
        const streamingDropdowns = tempContainer.querySelectorAll('.streaming-dropdown');
        let thinkingIndex = 0;
        let toolIndex = 0;
        
        streamingDropdowns.forEach(streamingDropdown => {
            const instance = streamingDropdown._streamingDropdownInstance;
            if (instance) {
                let stateKey;
                if (instance.type === 'thinking') {
                    stateKey = 'thinking_' + thinkingIndex;
                    thinkingIndex++;
                } else if (instance.type === 'tool') {
                    stateKey = 'tool_' + toolIndex;
                    toolIndex++;
                }
                if (stateKey) {
                    dropdownStates[stateKey] = !instance.isCollapsed;
                }
            }
        });
        
        // Remove temp content and re-render using the SAME method as live renderer
        tempContainer.remove();
        assistantTurnDiv.remove();
        
        const assistantTurnNumber = getNextTurnNumber();
        if (debugData) {
            debugData.currentTurnNumber = assistantTurnNumber;
        }
        
        // Get the blocks that were created during live rendering - these have tool structure
        const finalBlocks = processor.getBlocks();
        
        // Re-render the SAME WAY as live renderer - pass blocks AND content
        const renderedTurn = chatRenderer.renderTurn({
            role: 'assistant',
            blocks: finalBlocks,  // Use blocks like live renderer  
            content: processor.getRawContent() || '', // Also pass content for saving
            debug_data: debugData,
            dropdownStates: dropdownStates,
            turn_number: assistantTurnNumber
        }, true); // Enable scrolling
        
        // Save assistant message and debug data separately
        try {
            const fullContent = processor.getRawContent() || '';
            
            // For now, skip frontend saving entirely - let backend handle everything during tool execution
            // TODO: Determine if frontend should save non-tool messages
            logger.info(`[FRONTEND] Message rendered, backend handles saving`);
            
            // Save debug data to turn-based storage
            if (debugData) {
                await saveTurnData(currentChatId, assistantTurnNumber, debugData);
                logger.info(`[TURN-DEBUG] Saved assistant debug data for turn ${assistantTurnNumber}`);
            }
            
            updateChatPreview(currentChatId, processor.getDisplayContent()); // Use display content for preview
        } catch (error) {
            logger.error('Failed to save assistant message or debug data:', error);
        }
        
        logger.info('Simple chat completed successfully');
        
    } catch (error) {
        // Handle AbortError separately
        if (error.name === 'AbortError') {
            logger.info('Simple chat stopped by user');
            
            // Close tool events stream if it exists
            if (toolEventSource) {
                toolEventSource.close();
            }
            
            // Clean up temp container tracking
            delete tempContainer._renderedBlocks;
            delete tempContainer._blockElements;
            
            // Remove temp elements
            tempContainer.remove();
            assistantTurnDiv.remove();
            
            // Simple debug data for stopped request
            const stoppedDebugData = {
                sequence: [{
                    type: 'user_stopped',
                    step: 1,
                    timestamp: new Date().toISOString(),
                    data: {
                        message: 'Generation stopped by user',
                        partial_content: processor.getDisplayContent() || ''
                    }
                }],
                metadata: {
                    endpoint: 'stopped_generation',
                    timestamp: new Date().toISOString(),
                    partial: true
                }
            };
            
            // Finalize processor and render with debug panel using global chatRenderer
            processor.finalize();
            
            // Render the partial message using global chatRenderer
            chatRenderer.renderTurn({
                role: 'assistant',
                content: processor.getRawContent() || '',
                debug_data: stoppedDebugData,
                dropdownStates: {},
                isPartial: true
            }, true);
            
            // Save whatever content the AI actually generated (even if empty)
            try {
                const assistantTurnNumber = getNextTurnNumber();
                
                // Inject turn number into debug data for proper debug panel display
                if (stoppedDebugData) {
                    stoppedDebugData.currentTurnNumber = assistantTurnNumber;
                }
                
                const partialContent = processor.getRawContent() || '';
                
                // For stopped messages, let backend handle saving
                logger.info(`[FRONTEND] Stopped message rendered, backend handles saving`);
                
                // Save debug data to turn-based storage
                if (stoppedDebugData) {
                    await saveTurnData(currentChatId, assistantTurnNumber, stoppedDebugData);
                    logger.info(`[TURN-DEBUG] Saved stopped debug data for turn ${assistantTurnNumber}`);
                }
                
                updateChatPreview(currentChatId, processor.getDisplayContent()); // Use display content for preview
            } catch (saveError) {
                logger.warn('Failed to save stopped message:', saveError);
            }
            
            return;
        }
        
        // Handle other errors
        logger.error('Simple chat failed:', error, true);
        assistantTurnDiv.remove();
        
        // Show error using global chatRenderer
        chatRenderer.renderTurn({
            role: 'assistant',
            content: `[ERROR] ${error.message}`,
            debug_data: debugData
        }, true);
    }
}
