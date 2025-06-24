// Chat Service - Handle AI chat logic, streaming, and tool execution with adapters per api
const https = require('https');
const http = require('http');
const { log } = require('../utils/logger');

// Simple debug flag for adapter logs - set DEBUG=1 to enable
const DEBUG_ADAPTERS = process.env.DEBUG === '1';
const { getCurrentSettings } = require('./settingsService');
const { executeMCPTool, getAvailableToolsForChat } = require('./mcpService');
const { addToolEvent, storeDebugData } = require('./toolEventService');

// Update debug data for the most recent message of a specific role in a turn
async function updateMessageDebugData(chatId, role, turnNumber, debugData) {
    const { db } = require('../config/database');
    
    try {
        const debugDataJson = debugData ? JSON.stringify(debugData) : null;
        
        // Update the most recent message of the specified role in the specified turn
        const updateStmt = db.prepare(
            'UPDATE messages SET debug_data = ? WHERE chat_id = ? AND role = ? AND turn_number = ? AND id = (SELECT MAX(id) FROM messages WHERE chat_id = ? AND role = ? AND turn_number = ?)'
        );
        const result = updateStmt.run(debugDataJson, chatId, role, turnNumber, chatId, role, turnNumber);
        
        if (result.changes > 0) {
            log(`[CHAT-UPDATE] Updated debug data for ${role} message in turn ${turnNumber}`);
        } else {
            log(`[CHAT-UPDATE] No message found to update for ${role} in turn ${turnNumber}`);
        }
        
    } catch (err) {
        log('[CHAT-UPDATE] Error updating message debug data:', err);
        throw err;
    }
}

// Turn-based debug data functions
async function saveTurnDebugData(chatId, turnNumber, debugData) {
    const { db } = require('../config/database');
    
    try {
        const debugDataJson = JSON.stringify(debugData);
        
        // Use INSERT OR REPLACE to handle both new and updated debug data
        const stmt = db.prepare(
            'INSERT OR REPLACE INTO turn_debug_data (chat_id, turn_number, debug_data) VALUES (?, ?, ?)'
        );
        const result = stmt.run(chatId, turnNumber, debugDataJson);
        
        log(`[TURN-DEBUG] Saved debug data for turn ${turnNumber} in chat ${chatId}`);
        return result;
        
    } catch (err) {
        log('[TURN-DEBUG] Error saving turn debug data:', err);
        throw err;
    }
}

function getTurnDebugData(chatId, turnNumber) {
    const { db } = require('../config/database');
    
    try {
        const stmt = db.prepare('SELECT debug_data FROM turn_debug_data WHERE chat_id = ? AND turn_number = ?');
        const result = stmt.get(chatId, turnNumber);
        
        if (result) {
            const debugData = JSON.parse(result.debug_data);
            log(`[TURN-DEBUG] Retrieved debug data for turn ${turnNumber} in chat ${chatId}`);
            return debugData;
        } else {
            log(`[TURN-DEBUG] No debug data found for turn ${turnNumber} in chat ${chatId}`);
            return null;
        }
        
    } catch (err) {
        log('[TURN-DEBUG] Error getting turn debug data:', err);
        return null;
    }
}

function getAllTurnDebugData(chatId) {
    const { db } = require('../config/database');
    
    try {
        const stmt = db.prepare('SELECT turn_number, debug_data FROM turn_debug_data WHERE chat_id = ? ORDER BY turn_number ASC');
        const rows = stmt.all(chatId);
        
        const turnDebugMap = {};
        rows.forEach(row => {
            try {
                turnDebugMap[row.turn_number] = JSON.parse(row.debug_data);
            } catch (parseError) {
                log(`[TURN-DEBUG] Error parsing debug data for turn ${row.turn_number}:`, parseError);
            }
        });
        
        log(`[TURN-DEBUG] Retrieved debug data for ${rows.length} turns in chat ${chatId}`);
        return turnDebugMap;
        
    } catch (err) {
        log('[TURN-DEBUG] Error getting all turn debug data:', err);
        return {};
    }
}

// Get current turn number for a chat
function getCurrentTurnNumber(chat_id) {
    if (!chat_id) {
        return 0; // Default to turn 0
    }
    
    const { db } = require('../config/database');
    
    try {
        const stmt = db.prepare('SELECT turn_number FROM chats WHERE id = ?');
        const result = stmt.get(chat_id);
        const currentTurn = result ? (result.turn_number || 0) : 0;
        log(`[CURRENT-TURN] Chat ${chat_id}: current turn = ${currentTurn}`);
        return currentTurn;
    } catch (err) {
        log('[CHAT-TURN] Error getting current turn:', err);
        return 0; // Default to turn 0 on error
    }
}

function incrementTurnNumber(chat_id) {
    if (!chat_id) {
        return;
    }
    
    const { db } = require('../config/database');
    
    try {
        const stmt = db.prepare('UPDATE chats SET turn_number = turn_number + 1 WHERE id = ?');
        const result = stmt.run(chat_id);
        
        if (result.changes > 0) {
            const newTurn = getCurrentTurnNumber(chat_id);
            log(`[INCREMENT-TURN] Chat ${chat_id}: incremented to turn ${newTurn}`);
        } else {
            log(`[INCREMENT-TURN] Chat ${chat_id}: no chat found to increment`);
        }
    } catch (err) {
        log('[INCREMENT-TURN] Error incrementing turn:', err);
    }
}

function getChatHistoryForAPI(chat_id) {
    if (!chat_id) {
        return [];
    }
    
    const { db } = require('../config/database');
    const messages = [];
    
    try {
        // Get message data directly from columns including tool data
        const stmt = db.prepare('SELECT role, content, turn_number, tool_calls, tool_call_id, tool_name FROM messages WHERE chat_id = ? ORDER BY timestamp ASC');
        const historyRows = stmt.all(chat_id);
        
        // Build messages from direct columns
        historyRows.forEach(row => {
            const message = {
                role: row.role,
                content: row.content,
                turn_number: row.turn_number
            };
            
            // Add tool data if present
            if (row.tool_calls) {
                try {
                    message.tool_calls = JSON.parse(row.tool_calls);
                } catch (e) {
                    log(`[CHAT-HISTORY] Error parsing tool_calls: ${e.message}`);
                }
            }
            if (row.tool_call_id) {
                message.tool_call_id = row.tool_call_id;
            }
            if (row.tool_name) {
                message.tool_name = row.tool_name;
            }
            
            messages.push(message);
            log(`[CHAT-HISTORY] Added message: ${message.role} ${message.tool_calls ? '(with tools)' : ''}`);
        });
        
        log(`[CHAT-HISTORY] Retrieved ${messages.length} messages for chat ${chat_id}`);
        return messages;
        
    } catch (err) {
        log('[CHAT-HISTORY] Error getting chat history:', err);
        throw new Error(`Failed to load chat history: ${err.message}`);
    }
}
// Save complete message structure to database
async function saveCompleteMessageToDatabase(chatId, messageData, blocks = null, turnNumber = null) {
    const { db } = require('../config/database');
    
    try {
        // Store message data directly in columns
        const content = messageData.content || '';
        const role = messageData.role;
        const blocksJson = blocks ? JSON.stringify(blocks) : null;
        const toolCallsJson = messageData.tool_calls ? JSON.stringify(messageData.tool_calls) : null;
        const toolCallId = messageData.tool_call_id || null;
        const toolName = messageData.tool_name || null;
        
        // Begin transaction
        db.prepare('BEGIN TRANSACTION').run();
        
        // Frontend determines turn numbers - backend just stores what it's told
        let assignedTurnNumber = turnNumber || 0;
        log(`[CHAT-SAVE] Storing message with turn ${assignedTurnNumber} (role: ${role}) in chat ${chatId}`);

        // Insert message with direct columns including tool data
        const insertStmt = db.prepare('INSERT INTO messages (chat_id, role, content, blocks, turn_number, tool_calls, tool_call_id, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        insertStmt.run(chatId, role, content, blocksJson, assignedTurnNumber, toolCallsJson, toolCallId, toolName);
        
        // Update chat timestamp
        const updateStmt = db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        updateStmt.run(chatId);
        
        // Commit transaction
        db.prepare('COMMIT').run();
        
        log(`[CHAT-SAVE] Saved complete message: ${role} in turn ${assignedTurnNumber} with ${blocks ? blocks.length : 0} blocks`);
        return assignedTurnNumber; // Return the assigned turn number
        
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
async function handleChatWithTools(res, messages, tools, chatId, debugData = null, responseCounter = 1, requestId = null, existingDebugData = null, conductorPhase = null, blockToolExecution = false, blockRecursiveToolResponse = false) {
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
    adapter.setToolEventEmitter((eventType, data, reqId) => {
        if (reqId) {
            addToolEvent(reqId, { type: eventType, data: data });
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
        
        if (requestId) {
            headers['X-Request-Id'] = requestId;
        }
        
        res.writeHead(200, headers);
    }
    
    // Initialize debug data and turn number
    let collectedDebugData = existingDebugData;
    
    // Calculate the turn number ONCE for this entire conversation (to prevent turn increment on recursive calls)
    let currentTurn;
    if (collectedDebugData && collectedDebugData.currentTurn) {
        // Reuse existing turn from recursive calls
        currentTurn = collectedDebugData.currentTurn;
    } else {
        // Get current turn (will be incremented when conversation is complete)
        currentTurn = chatId ? getCurrentTurnNumber(chatId) + 1 : 1;
    }
    
    // Calculate next sequence step from existing debug data to maintain sequential order across recursive calls
    let sequenceStep = 1;
    if (collectedDebugData) {
        const sequenceCount = (collectedDebugData.sequence && Array.isArray(collectedDebugData.sequence)) ? collectedDebugData.sequence.length : 0;
        const httpSequenceCount = (collectedDebugData.httpSequence && Array.isArray(collectedDebugData.httpSequence)) ? collectedDebugData.httpSequence.length : 0;
        sequenceStep = sequenceCount + httpSequenceCount + 1;
    }
    
    if (debugData && requestId && !collectedDebugData) {
        collectedDebugData = {
            requestId: requestId,
            currentTurn: currentTurn,
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
    } else if (collectedDebugData && !collectedDebugData.currentTurn) {
        // Store turn number in existing debug data if not already set
        collectedDebugData.currentTurn = currentTurn;
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
                    if (event.type === 'tool_call_detected' && requestId) {
                        addToolEvent(requestId, {
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
            if (collectedDebugData && requestId) {
                if (!collectedDebugData.httpSequence) {
                    collectedDebugData.httpSequence = [];
                }
                
                collectedDebugData.httpSequence.push({
                    type: 'http_response',
                    sequence: sequenceStep++,
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
                    requestId, conductorPhase, blockRecursiveToolResponse
                );
            } else {
                // No tool calls, finish response
                res.end();
                
                // Increment turn number now that conversation is complete
                if (chatId) {
                    incrementTurnNumber(chatId);
                }
                
                // Save final assistant response to history before ending
                // Save in both conductor mode and simple chat mode
                if (chatId && unifiedResponse.content) {
                    const finalAssistantMessage = {
                        role: 'assistant',
                        content: unifiedResponse.content
                    };
                    try {
                        await saveCompleteMessageToDatabase(chatId, finalAssistantMessage, null, currentTurn);
                        log(`[CHAT-SAVE] Saved final assistant response to history`);
                    } catch (error) {
                        log(`[CHAT-SAVE] Error saving final assistant response: ${error.message}`);
                    }
                }
                
                // Store debug data with complete history
                if (collectedDebugData && requestId) {
                    // Add complete chat history to debug data
                    if (chatId) {
                        try {
                            // Get the complete history
                            collectedDebugData.completeMessageHistory = getChatHistoryForAPI(chatId);
                            
                            // Get the current turn number for debug panel consistency
                            // This ensures "Messages In This Turn" works when reloading saved chats
                            collectedDebugData.currentTurnNumber = getCurrentTurnNumber(chatId);
                            collectedDebugData.currentTurnMessages = null; // Will be fetched by frontend as needed
                        } catch (error) {
                            collectedDebugData.completeMessageHistory = { error: error.message };
                            collectedDebugData.currentTurnMessages = { error: error.message };
                            collectedDebugData.currentTurnNumber = null;
                        }
                    }
                    
                    storeDebugData(requestId, collectedDebugData);
                    log(`[ADAPTER-DEBUG] Debug data stored for request:`, requestId);
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
    if (collectedDebugData && requestId) {
        if (!collectedDebugData.httpSequence) {
            collectedDebugData.httpSequence = [];
        }
        
        // Only add HTTP request to debug data if it's not the first request
        // The first request is initiated in the user bubble phase and already logged there
        if (collectedDebugData.httpSequence.length > 0 || responseCounter > 1) {
            const requestSequenceNumber = sequenceStep++;
            
            collectedDebugData.httpSequence.push({
                type: 'http_request',
                sequence: requestSequenceNumber,
                timestamp: new Date().toISOString(),
                payload: JSON.parse(actualRequestPayload),  // Store as object for debug panel
                rawPayload: actualRequestPayload            // Store as string for exact representation
            });
            

        } else {
            log(`[SEQUENTIAL-DEBUG] Skipping first HTTP request debug - already captured in user phase`);
        }
    }
    
    apiReq.write(actualRequestPayload);
    apiReq.end();
}

// Execute tool calls and continue conversation
async function executeToolCallsAndContinue(res, toolCalls, messages, tools, chatId, assistantMessage, debugData, responseCounter, requestId, conductorPhase, blockRecursiveToolResponse) {
    // Get the turn number from debug data (calculated once at conversation start)
    const currentTurn = debugData && debugData.currentTurn ? debugData.currentTurn : 1;
    
    // Add assistant message with tool calls to conversation
    const assistantMessageWithTools = {
        role: 'assistant',
        content: assistantMessage || '',
        tool_calls: toolCalls
    };
    messages.push(assistantMessageWithTools);
    
    // Save assistant message with tool calls to database
    if (chatId) {
        await saveCompleteMessageToDatabase(chatId, assistantMessageWithTools, null, currentTurn);
        log(`[CHAT-SAVE] Saved assistant message with ${toolCalls.length} tool calls`);
    }
    
    // Execute each tool call
    for (const toolCall of toolCalls) {
        log(`[TOOL-EXECUTION] Executing tool: ${toolCall.function.name}`);
        
        if (requestId) {
            addToolEvent(requestId, {
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
                await saveCompleteMessageToDatabase(chatId, toolMessage, null, currentTurn);
                log(`[CHAT-SAVE] Saved tool response for ${toolCall.function.name}`);
            }
            
            if (requestId) {
                addToolEvent(requestId, {
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
                // Calculate next sequence step from existing debug data
                const sequenceCount = debugData.sequence.length;
                const httpSequenceCount = debugData.httpSequence ? debugData.httpSequence.length : 0;
                const nextStep = sequenceCount + httpSequenceCount + 1;
                
                debugData.sequence.push({
                    type: 'tool_result',
                    step: nextStep,
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
                await saveCompleteMessageToDatabase(chatId, errorMessage, null, currentTurn);
                log(`[CHAT-SAVE] Saved tool error for ${toolCall.function.name}`);
            }
            
            if (requestId) {
                addToolEvent(requestId, {
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
                // Calculate next sequence step from existing debug data
                const sequenceCount = debugData.sequence.length;
                const httpSequenceCount = debugData.httpSequence ? debugData.httpSequence.length : 0;
                const nextStep = sequenceCount + httpSequenceCount + 1;
                
                debugData.sequence.push({
                    type: 'tool_result',
                    step: nextStep,
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
    
    // Continue conversation with tool results
    await handleChatWithTools(res, messages, tools, chatId, debugData, responseCounter + 1, requestId, debugData, conductorPhase);
}

// Process chat request (entry point from routes)
async function processChatRequest(req, res) {
    try {
        const { message, chat_id, conductor_mode, enabled_tools, conductor_phase, message_role, block_tool_execution, block_recursive_call, request_id } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
                
        // Build messages for API - get chat history first
        const messages = getChatHistoryForAPI(chat_id);

        // Log what's in history
        log(`[CHAT-DEBUG] Current history count: ${messages.length}`);
        
        // Check if the user's message is already in history (it should be)
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage || lastMessage.role !== (message_role || 'user') || lastMessage.content !== message) {
            // Only add if not already there (unlikely with our new architecture, but a safeguard)
            log(`[CHAT-DEBUG] User message not found in history, adding it now`);
            const role = message_role || 'user';
            const newMessage = { role: role, content: message };
            messages.push(newMessage);
        } else {
            log(`[CHAT-DEBUG] User message already in history, not adding again`);
        }
        
        // Check if we have any messages at all
        if (messages.length === 0) {
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
        
        // Use provided request ID or generate unique request ID for debug data
        const { generateRequestId, initializeToolEvents } = require('./toolEventService');
        const requestId = request_id || generateRequestId();
        
        log(`[CHAT] Using request ID: ${requestId} (provided: ${!!request_id})`);
        
        // Initialize tool events for this request
        initializeToolEvents(requestId);
        
        await handleChatWithTools(res, messages, tools, chat_id, debugData, 1, requestId, null, conductor_phase, block_tool_execution, block_recursive_call);
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
    updateMessageDebugData,
    getChatHistoryForAPI,
    getCurrentTurnNumber,
    incrementTurnNumber,
    // Turn-based debug data functions
    saveTurnDebugData,
    getTurnDebugData,
    getAllTurnDebugData
};
