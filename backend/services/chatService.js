// Chat Service - Handle AI chat logic, streaming, and tool execution with adapters per api
const https = require('https');
const http = require('http');
const { log } = require('../utils/logger');

// Simple debug flag for adapter logs - set DEBUG=1 to enable
const DEBUG_ADAPTERS = process.env.DEBUG === '1';
const { getCurrentSettings } = require('./settingsService');
const { executeMCPTool, getAvailableToolsForChat } = require('./mcpService');
const { addToolEvent, storeDebugData } = require('./toolEventService');
// Get chat history in API format
function getChatHistoryForAPI(chat_id) {
    if (!chat_id) {
        return [];
    }
    
    const { db } = require('../config/database');
    const messages = [];
    
    try {
        // Get complete message structure from database - prefer message_data when available
        const stmt = db.prepare('SELECT role, content, message_data FROM messages WHERE chat_id = ? ORDER BY timestamp ASC');
        const historyRows = stmt.all(chat_id);
        
        // Add history to messages - require complete structure
        historyRows.forEach(row => {
            if (!row.message_data) {
                throw new Error(`Message missing complete structure (message_data). Database needs migration or data is corrupted.`);
            }
            
            try {
                const completeMessage = JSON.parse(row.message_data);
                messages.push(completeMessage);
                log(`[CHAT-HISTORY] Added complete message structure: ${completeMessage.role}`);
            } catch (parseError) {
                throw new Error(`Failed to parse message_data: ${parseError.message}`);
            }
        });
        
        log(`[CHAT-HISTORY] Retrieved ${messages.length} messages for chat ${chat_id}`);
        return messages;
        
    } catch (err) {
        log('[CHAT-HISTORY] Error getting chat history:', err);
        throw new Error(`Failed to load chat history: ${err.message}`);
    }
}
// Save complete message structure to database
async function saveCompleteMessageToDatabase(chatId, messageData, debugData = null, blocks = null) {
    const { db } = require('../config/database');
    
    try {
        // Store both the content and the complete message structure
        const content = messageData.content || '';
        const messageDataJson = JSON.stringify(messageData);
        const debugDataJson = debugData ? JSON.stringify(debugData) : null;
        const blocksJson = blocks ? JSON.stringify(blocks) : null;
        
        // Begin transaction
        db.prepare('BEGIN TRANSACTION').run();
        
        // Insert message with complete structure including blocks and debug data
        const insertStmt = db.prepare('INSERT INTO messages (chat_id, role, content, message_data, debug_data, blocks) VALUES (?, ?, ?, ?, ?, ?)');
        insertStmt.run(chatId, messageData.role, content, messageDataJson, debugDataJson, blocksJson);
        
        // Update chat timestamp
        const updateStmt = db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        updateStmt.run(chatId);
        
        // Commit transaction
        db.prepare('COMMIT').run();
        
        log(`[CHAT-SAVE] Saved complete message: ${messageData.role} with ${blocks ? blocks.length : 0} blocks`);
        
    } catch (error) {
        // Rollback on error
        try { db.prepare('ROLLBACK').run(); } catch (rollbackErr) { /* ignore */ }
        log('[CHAT-SAVE] Error saving complete message:', error);
        throw error;
    }
}

// Import adapter system
const responseAdapterFactory = require('../adapters/ResponseAdapterFactory');
const UnifiedResponse = require('../adapters/UnifiedResponse');

// Handle chat with potential tool calls
async function handleChatWithTools(res, messages, tools, chatId, debugData = null, responseCounter = 1, messageId = null, existingDebugData = null, conductorPhase = null, blockToolExecution = false, blockRecursiveToolResponse = false) {
    const currentSettings = getCurrentSettings();
    
    // Ensure we have a model name
    if (!currentSettings.modelName) {
        res.status(400).json({ error: 'No model specified. Please configure a model in settings.' });
        return;
    }
    
    // Get the appropriate adapter for current settings
    const adapter = responseAdapterFactory.getAdapter(currentSettings);
    log(`[ADAPTER] Using ${adapter.providerName} adapter`);
    
    // Set up tool event emitter for the adapter
    adapter.setToolEventEmitter((eventType, data, msgId) => {
        if (msgId) {
            addToolEvent(msgId, { type: eventType, data: data });
        }
    });
    
    // Create unified request
    const unifiedRequest = responseAdapterFactory.createUnifiedRequest(messages, tools, currentSettings.modelName);
    
    // Convert to provider-specific format
    const requestData = adapter.convertRequest(unifiedRequest);
    
    // Set up streaming response FIRST
    if (!res.headersSent) {
        const headers = {
            'Content-Type': 'text/plain',
            'Transfer-Encoding': 'chunked'
        };
        
        if (messageId) {
            headers['X-Message-Id'] = messageId;
        }
        
        res.writeHead(200, headers);
    }
    
    // Initialize debug data
    let collectedDebugData = existingDebugData;
    let sequenceStep = 1;
    
    if (debugData && messageId && !collectedDebugData) {
        collectedDebugData = {
            messageId: messageId,
            sequence: [],
            metadata: {
                endpoint: adapter.getEndpointUrl(currentSettings),
                timestamp: new Date().toISOString(),
                tools: tools.length,
                provider: adapter.providerName,
                model: currentSettings.modelName
            },
            rawData: {
                httpResponse: {
                    statusCode: null,
                    statusMessage: null,
                    headers: null
                },
                errors: []
            }
        };
        
        // Real sequential debug will be added here
    }
    
    // Get provider-specific URL and headers
    const targetUrl = adapter.getEndpointUrl(currentSettings);
    const headers = adapter.getHeaders(currentSettings);
    headers['Content-Length'] = Buffer.byteLength(JSON.stringify(requestData));
    
    if (DEBUG_ADAPTERS) {
        log(`[${adapter.providerName.toUpperCase()}-DEBUG] URL:`, targetUrl);
        log(`[${adapter.providerName.toUpperCase()}-DEBUG] Request Body:`, JSON.stringify(requestData, null, 2));
    }
    
    const url = new URL(targetUrl);
    const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: headers
    };
    
    // Create unified response object
    const unifiedResponse = new UnifiedResponse().setProvider(adapter.providerName);
    const context = adapter.createContext();
    
    // Make HTTP request
    const httpModule = url.protocol === 'https:' ? https : http;
    const apiReq = httpModule.request(options, (apiRes) => {
        // Capture debug data
        if (collectedDebugData) {
            collectedDebugData.rawData.httpResponse = {
                statusCode: apiRes.statusCode,
                statusMessage: apiRes.statusMessage,
                headers: apiRes.headers
            };
        }
        
        if (apiRes.statusCode !== 200) {
            let errorData = '';
            apiRes.on('data', (chunk) => {
                errorData += chunk.toString();
            });
            apiRes.on('end', () => {
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Status:`, apiRes.statusCode);
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Response:`, errorData);
                if (collectedDebugData) {
                    collectedDebugData.errors.push({ type: 'http_error', message: errorData });
                }
            });
            res.write(`API error: ${apiRes.statusCode} ${apiRes.statusMessage}`);
            res.end();
            return;
        }
        
        // Stream response processing
        apiRes.on('data', (chunk) => {
            try {
                // Process chunk with adapter
                const result = adapter.processChunk(chunk, unifiedResponse, context);
                
                // Handle any events generated - THIS IS CRITICAL FOR TOOL DROPDOWNS!
                for (const event of result.events) {
                    if (event.type === 'tool_call_detected' && messageId) {
                        addToolEvent(messageId, {
                            type: 'tool_call_detected',
                            data: {
                                name: event.data.toolName,
                                id: event.data.toolId
                            }
                        });
                        if (DEBUG_ADAPTERS) log(`[ADAPTER-TOOL-EVENT] Tool call detected:`, event.data.toolName);
                    }
                }
                
                // Update context
                Object.assign(context, result.context);
                
                // Stream any new content to client
                let newContent = '';
                if (unifiedResponse.content && context.lastContentLength !== unifiedResponse.content.length) {
                    newContent = unifiedResponse.content.slice(context.lastContentLength || 0);
                    if (newContent) {
                        res.write(newContent);
                        context.lastContentLength = unifiedResponse.content.length;
                        
                        // Capture the actual content being sent to frontend for debug
                        if (collectedDebugData) {
                            if (!collectedDebugData.streamedContent) {
                                collectedDebugData.streamedContent = '';
                            }
                            collectedDebugData.streamedContent += newContent;
                        }
                    }
                }
                
                // Add to debug data (accumulate response chunks)
                if (collectedDebugData) {
                    if (!collectedDebugData.rawResponseChunks) {
                        collectedDebugData.rawResponseChunks = [];
                    }
                    collectedDebugData.rawResponseChunks.push({
                        chunk: chunk.toString(),
                        timestamp: new Date().toISOString()
                    });
                }
                
            } catch (error) {
                console.error(`[${adapter.providerName.toUpperCase()}-ADAPTER] Error processing chunk:`, error);
                if (collectedDebugData) {
                    collectedDebugData.rawData.errors.push({ type: 'processing_error', message: error.message });
                }
            }
        });
        
        apiRes.on('end', async () => {
            log(`[${adapter.providerName.toUpperCase()}-ADAPTER] Stream ended`);
            
            // Add response step to debug sequence
            if (collectedDebugData) {
                const responseStep = {
                    type: 'response',
                    step: sequenceStep++,
                    timestamp: new Date().toISOString(),
                    data: {
                        raw_http_response: {
                            status: collectedDebugData.rawData.httpResponse.statusCode,
                            provider: adapter.providerName,
                            response_chunks: collectedDebugData.rawResponseChunks || []
                        },
                        content: collectedDebugData.streamedContent || 'No content streamed',
                        has_tool_calls: unifiedResponse.hasToolCalls()
                    }
                };
                collectedDebugData.sequence.push(responseStep);
            }
            
            // Capture complete HTTP response (REAL data)
            if (collectedDebugData && messageId) {
                if (!collectedDebugData.httpSequence) {
                    collectedDebugData.httpSequence = [];
                }
                
                collectedDebugData.httpSequence.push({
                    type: 'http_response',
                    sequence: collectedDebugData.httpSequence.length,
                    timestamp: new Date().toISOString(),
                    content: unifiedResponse.content || '',
                    toolCalls: unifiedResponse.toolCalls || [],
                    hasToolCalls: unifiedResponse.hasToolCalls()
                });
                
                log(`[SEQUENTIAL-DEBUG] Captured HTTP response, hasTools: ${unifiedResponse.hasToolCalls()}`);
            }
            
            // Handle tool calls if any
            if (unifiedResponse.hasToolCalls() && !blockToolExecution) {
                log(`[ADAPTER] Processing ${unifiedResponse.toolCalls.length} tool calls`);
                
                // Add tool execution steps to debug sequence
                if (collectedDebugData) {
                    for (const toolCall of unifiedResponse.toolCalls) {
                        collectedDebugData.sequence.push({
                            type: 'tool_execution',
                            step: sequenceStep++,
                            timestamp: new Date().toISOString(),
                            data: {
                                tool_name: toolCall.function.name,
                                tool_id: toolCall.id,
                                arguments: JSON.parse(toolCall.function.arguments)
                            }
                        });
                    }
                }
                
                // Execute tools and continue conversation
                await executeToolCallsAndContinue(
                    res, unifiedResponse.toolCalls, messages, tools, chatId, 
                    unifiedResponse.content, collectedDebugData, responseCounter, 
                    messageId, conductorPhase, blockRecursiveToolResponse
                );
            } else {
                // No tool calls, finish response
                res.end();
                
                // Save final assistant response to database BEFORE storing debug data
                if (chatId && unifiedResponse.content) {
                    const finalAssistantMessage = {
                        role: 'assistant',
                        content: unifiedResponse.content
                    };
                    try {
                        await saveCompleteMessageToDatabase(chatId, finalAssistantMessage, null, null);
                    } catch (error) {
                        log(`[CHAT-SAVE] Error saving final assistant response: ${error.message}`);
                    }
                }
                
                // Store debug data with complete history
                if (collectedDebugData && messageId) {
                    // Add complete chat history to debug data
                    if (chatId) {
                        try {
                            collectedDebugData.completeMessageHistory = getChatHistoryForAPI(chatId);
                        } catch (error) {
                            collectedDebugData.completeMessageHistory = { error: error.message };
                        }
                    }
                    
                    storeDebugData(messageId, collectedDebugData);
                    log(`[ADAPTER-DEBUG] Debug data stored for message:`, messageId);
                }
            }
        });
    });
    
    apiReq.on('error', (error) => {
        log(`[${adapter.providerName.toUpperCase()}] Request error:`, error);
        if (collectedDebugData) {
            collectedDebugData.rawData.errors.push({ type: 'request_error', message: error.message });
        }
        res.write(`Connection error: ${error.message}`);
        res.end();
    });
    
    // Capture ACTUAL HTTP request payload being sent
    const actualRequestPayload = JSON.stringify(requestData);
    
    // Add to sequential debug data (real HTTP request)
    if (collectedDebugData && messageId) {
        if (!collectedDebugData.httpSequence) {
            collectedDebugData.httpSequence = [];
        }
        
        const requestSequenceNumber = collectedDebugData.httpSequence.length + 1;
        
        collectedDebugData.httpSequence.push({
            type: 'http_request',
            sequence: requestSequenceNumber,
            timestamp: new Date().toISOString(),
            payload: JSON.parse(actualRequestPayload),  // Store as object for debug panel
            rawPayload: actualRequestPayload            // Store as string for exact representation
        });
        
        log(`[SEQUENTIAL-DEBUG] Captured HTTP request #${requestSequenceNumber} with ${JSON.parse(actualRequestPayload).messages.length} messages`);
    }
    
    apiReq.write(actualRequestPayload);
    apiReq.end();
}

// Execute tool calls and continue conversation
async function executeToolCallsAndContinue(res, toolCalls, messages, tools, chatId, assistantMessage, debugData, responseCounter, messageId, conductorPhase, blockRecursiveToolResponse) {
    // Add assistant message with tool calls to conversation
    const assistantMessageWithTools = {
        role: 'assistant',
        content: assistantMessage || '',
        tool_calls: toolCalls
    };
    messages.push(assistantMessageWithTools);
    
    // Save assistant message with tool calls to database
    if (chatId) {
        await saveCompleteMessageToDatabase(chatId, assistantMessageWithTools, null, null);
        log(`[CHAT-SAVE] Saved assistant message with ${toolCalls.length} tool calls`);
    }
    
    // Execute each tool call
    for (const toolCall of toolCalls) {
        log(`[TOOL-EXECUTION] Executing tool: ${toolCall.function.name}`);
        
        if (messageId) {
            addToolEvent(messageId, {
                type: 'tool_execution_start',
                data: {
                    name: toolCall.function.name, 
                    id: toolCall.id,
                    arguments: JSON.parse(toolCall.function.arguments)
                }
            });
        }
        
        try {
            const toolArgs = JSON.parse(toolCall.function.arguments);
            const toolResult = await executeMCPTool(toolCall.function.name, toolArgs);
            
            const toolMessage = {
                role: 'tool',
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,  // Add tool name for Gemini conversion
                content: JSON.stringify(toolResult)
            };
            messages.push(toolMessage);
            
            // Save tool message to database
            if (chatId) {
                await saveCompleteMessageToDatabase(chatId, toolMessage, null, null);
                log(`[CHAT-SAVE] Saved tool response for ${toolCall.function.name}`);
            }
            
            if (messageId) {
                addToolEvent(messageId, {
                    type: 'tool_execution_complete',
                    data: {
                        name: toolCall.function.name, 
                        id: toolCall.id,
                        status: 'success',
                        result: toolResult 
                    }
                });
            }
            
            // Add tool result to debug sequence
            if (debugData && debugData.sequence) {
                debugData.sequence.push({
                    type: 'tool_result',
                    step: debugData.sequence.length + 1,
                    timestamp: new Date().toISOString(),
                    data: {
                        tool_name: toolCall.function.name,
                        tool_id: toolCall.id,
                        status: 'success',
                        result: toolResult
                    }
                });
            }
            
        } catch (error) {
            log(`[TOOL-EXECUTION] Error executing tool ${toolCall.function.name}:`, error);
            
            const errorMessage = {
                role: 'tool',
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,  // Add tool name for Gemini conversion
                content: JSON.stringify({ error: error.message })
            };
            messages.push(errorMessage);
            
            // Save tool error message to database
            if (chatId) {
                await saveCompleteMessageToDatabase(chatId, errorMessage, null, null);
                log(`[CHAT-SAVE] Saved tool error for ${toolCall.function.name}`);
            }
            
            if (messageId) {
                addToolEvent(messageId, {
                    type: 'tool_execution_complete',
                    data: {
                        name: toolCall.function.name, 
                        id: toolCall.id,
                        status: 'error',
                        error: error.message 
                    }
                });
            }
            
            // Add tool error to debug sequence
            if (debugData && debugData.sequence) {
                debugData.sequence.push({
                    type: 'tool_result',
                    step: debugData.sequence.length + 1,
                    timestamp: new Date().toISOString(),
                    data: {
                        tool_name: toolCall.function.name,
                        tool_id: toolCall.id,
                        status: 'error',
                        error: error.message
                    }
                });
            }
        }
    }
    
    // Continue conversation with tool results (unless blocked)
    if (!blockRecursiveToolResponse) {
        await handleChatWithTools(res, messages, tools, chatId, debugData, responseCounter + 1, messageId, debugData, conductorPhase, false, true);
    } else {
        res.end();
        if (debugData && messageId) {
            storeDebugData(messageId, debugData);
        }
    }
}

// Process chat request (entry point from routes)
async function processChatRequest(req, res) {
    try {
        const { message, chat_id, conductor_mode, enabled_tools, conductor_phase, message_role, block_tool_execution, block_recursive_call, message_id } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
                
        // Build messages for API - get chat history first
        const messages = getChatHistoryForAPI(chat_id);
        
        // Add the new message if provided
        if (message) {
            const role = message_role || 'user';
            const newMessage = { role: role, content: message };
            
            // Check if this message is already the last one in history (avoid duplication)
            const lastMessage = messages[messages.length - 1];
            const isDuplicate = lastMessage && 
                               lastMessage.role === newMessage.role && 
                               lastMessage.content === newMessage.content;
            
            if (!isDuplicate) {
                messages.push(newMessage);
                log(`[CHAT] Added new message with role: ${role}`);
            } else {
                log(`[CHAT] Skipped duplicate message with role: ${role}`);
            }
        } else if (messages.length === 0) {
            // No chat_id and no message - this shouldn't happen but handle gracefully
            throw new Error('No message provided and no chat history available');
        }
        
        // Get available tools
        const tools = getAvailableToolsForChat(enabled_tools);
        
        // Call the AI API with tools and capture debug data
        const currentSettings = getCurrentSettings();
        const debugData = {
            requestStart: Date.now(),
            endpoint: 'will_be_set_by_adapter',
            settings: currentSettings,
            toolsEnabled: tools.length
        };
        
        // Use provided message ID or generate unique message ID for debug data
        const { generateMessageId, initializeToolEvents } = require('./toolEventService');
        const messageId = message_id || generateMessageId();
        
        log(`[CHAT] Using message ID: ${messageId} (provided: ${!!message_id})`);
        
        // Initialize tool events for this message
        initializeToolEvents(messageId);
        
        await handleChatWithTools(res, messages, tools, chat_id, debugData, 1, messageId, null, conductor_phase, block_tool_execution, block_recursive_call);
        // Response is handled in handleChatWithTools via streaming
        
    } catch (error) {
        log('[CHAT] Error:', error);
        // Only send error response if headers haven't been sent yet
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            // If streaming has started, we can't send JSON, so just end the stream
            res.write(`\n[ERROR] ${error.message}`);
            res.end();
        }
    }
}

module.exports = {
    handleChatWithTools,
    processChatRequest,
    saveCompleteMessageToDatabase,
    getChatHistoryForAPI
};
