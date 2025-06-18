// Simple Chat Mode - Direct streaming chat without conductor complexity

async function handleSimpleChat(message) {
    logger.info('Starting simple chat');
    
    // Get enabled tools that will be sent to AI (do this ONCE)
    const settings = loadSettings();
    const enabledToolDefinitions = await getEnabledToolDefinitions();
    
    // Always prepare debug data for user message using sequence format (regardless of setting)
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
                        message_length: message.length
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
        }
    };
    
    // Add user message to UI using unified renderer
    const userBlocks = [{ type: 'chat', content: message, metadata: {} }];
    chatRenderer.renderMessage({
        role: 'user',
        blocks: userBlocks,
        debug_data: userDebugData,
        content: message
    }, true);
    
    // Save user message with blocks
    try {
        await saveCompleteMessage(currentChatId, { role: 'user', content: message }, userDebugData, userBlocks);
    } catch (error) {
        logger.warn('Failed to save user message:', error);
    }
    
    // Prepare for assistant response
    const assistantMessageDiv = document.createElement('div');
    assistantMessageDiv.className = 'message assistant';
    assistantMessageDiv.innerHTML = '';
    messagesContainer.appendChild(assistantMessageDiv);
    
    let fullResponse = '';
    let debugData = null;
    let toolEventSource = null; // Declare outside try block so catch can access it
    let wasAborted = false; // Track if we aborted
    
    // Create the streaming processor (no rendering - just creates blocks)
    const processor = new StreamingMessageProcessor();
    
    // Create a temporary container for real-time rendering during streaming
    const tempContainer = document.createElement('div');
    assistantMessageDiv.appendChild(tempContainer);
    const liveRenderer = new ChatRenderer(tempContainer);
    
    try {
        // Generate messageId upfront and connect to tool events BEFORE making the request
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        logger.debug('[SIMPLE-CHAT] Generated messageId:', messageId);
        
        // Connect to tool events stream immediately
        logger.debug('[SIMPLE-CHAT] Connecting to SSE:', `${window.location.origin}/api/tools/${messageId}`);
        toolEventSource = new EventSource(`${window.location.origin}/api/tools/${messageId}`);
        toolEventSource.onmessage = (event) => {
            const toolEvent = JSON.parse(event.data);
            logger.debug('[SIMPLE-CHAT] Received tool event:', toolEvent.type, toolEvent.data);
            handleToolEvent(toolEvent, processor, liveRenderer, tempContainer);
        };
        toolEventSource.onerror = (error) => {
            logger.error('[SIMPLE-CHAT] SSE error:', error);
        };
        
        // Now make the request with the pre-generated messageId
        logger.debug('[SIMPLE-CHAT] Making request with messageId:', messageId);
        const response = await sendMessageWithTools(message, false, enabledToolDefinitions, null, null, false, false, messageId);
        
        // Stream the response cleanly - no debug parsing needed!
        for await (const chunk of streamResponse(response)) {
            fullResponse += chunk;
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
        
        logger.info('[DEBUG-SEPARATION] Using pre-generated message ID:', messageId);
        
        if (messageId) {
            try {
                const debugResponse = await fetch(`${window.location.origin}/api/debug/${messageId}`);
                if (debugResponse.ok) {
                    const rawDebugData = await debugResponse.json();
                    
                    // Use sequential debug data directly
                    if (rawDebugData.sequence) {
                        debugData = rawDebugData;
                    } 
                } else {
                    logger.warn('No debug data available for message:', messageId);
                }
            } catch (error) {
                logger.warn('Failed to fetch debug data:', error);
            }
        }
        
        // Finalize the processor to handle any remaining content
        const finalBlocks = processor.finalize();
        
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
        
        // Clean up temp container tracking before removal
        delete tempContainer._renderedBlocks;
        delete tempContainer._blockElements;
        
        // Replace temp container with final rendered content
        tempContainer.remove();
        
        // Remove the temporary assistant message div and use ChatRenderer
        assistantMessageDiv.remove();
        
        chatRenderer.renderMessage({
            role: 'assistant',
            blocks: finalBlocks,
            debug_data: debugData,
            dropdownStates: dropdownStates
        }, true); // Enable scrolling
        
        // Save assistant message with both raw content and blocks
        try {
            await saveCompleteMessage(currentChatId, { role: 'assistant', content: fullResponse }, debugData, finalBlocks);
            // Update chat preview with display content (clean text)
            const displayContent = processor.getDisplayContent() || fullResponse;
            updateChatPreview(currentChatId, displayContent);
        } catch (error) {
            logger.warn('Failed to save assistant message:', error);
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
            assistantMessageDiv.remove();
            
            // Simple debug data for stopped request
            const stoppedDebugData = {
                sequence: [{
                    type: 'user_stopped',
                    step: 1,
                    timestamp: new Date().toISOString(),
                    data: {
                        message: 'Generation stopped by user',
                        partial_content: fullResponse
                    }
                }],
                metadata: {
                    endpoint: 'stopped_generation',
                    timestamp: new Date().toISOString(),
                    partial: true
                }
            };
            
            // Get blocks and render with debug panel - simple
            const partialBlocks = processor.finalize();
            chatRenderer.renderMessage({
                role: 'assistant',
                blocks: partialBlocks,
                debug_data: stoppedDebugData,
                dropdownStates: {},
                isPartial: true
            }, true);
            
            // Save whatever content the AI actually generated (even if empty)
            try {
                await saveCompleteMessage(currentChatId, { role: 'assistant', content: fullResponse || '' }, stoppedDebugData, partialBlocks);
                updateChatPreview(currentChatId, fullResponse || '');
            } catch (saveError) {
                logger.warn('Failed to save stopped message:', saveError);
            }
            
            return;
        }
        
        // Handle other errors
        logger.error('Simple chat failed:', error, true);
        assistantMessageDiv.remove();
        // Show error using unified renderer
        chatRenderer.renderMessage({
            role: 'assistant',
            blocks: [{ type: 'chat', content: `[ERROR] ${error.message}`, metadata: {} }],
            debug_data: debugData,
            content: `[ERROR] ${error.message}`
        }, true);
    }
}