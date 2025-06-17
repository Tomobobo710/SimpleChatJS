// Chat Service - Handle AI chat logic, streaming, and tool execution with adapters per api
const https = require('https');
const http = require('http');
const { log } = require('../utils/logger');

// Simple debug flag for adapter logs - set DEBUG=1 to enable
const DEBUG_ADAPTERS = process.env.DEBUG === '1';
const { getCurrentSettings } = require('./settingsService');
const { executeMCPTool, getAvailableToolsForChat } = require('./mcpService');
const { addToolEvent, storeDebugData } = require('./toolEventService');

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
        
        // Add request step to sequence
        collectedDebugData.sequence.push({
            type: 'request',
            step: sequenceStep++,
            timestamp: new Date().toISOString(),
            data: {
                request: requestData
            }
        });
    }
    
    // Get provider-specific URL and headers
    const targetUrl = adapter.getEndpointUrl(currentSettings);
    const headers = adapter.getHeaders(currentSettings);
    headers['Content-Length'] = Buffer.byteLength(JSON.stringify(requestData));
    
    if (DEBUG_ADAPTERS) {
        console.log(`[${adapter.providerName.toUpperCase()}-DEBUG] URL:`, targetUrl);
        console.log(`[${adapter.providerName.toUpperCase()}-DEBUG] Request Body:`, JSON.stringify(requestData, null, 2));
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
                console.log(`[${adapter.providerName.toUpperCase()}-ERROR] Status:`, apiRes.statusCode);
                console.log(`[${adapter.providerName.toUpperCase()}-ERROR] Response:`, errorData);
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
                        if (DEBUG_ADAPTERS) console.log(`[ADAPTER-TOOL-EVENT] Tool call detected:`, event.data.toolName);
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
            console.log(`[${adapter.providerName.toUpperCase()}-ADAPTER] Stream ended`);
            
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
                
                // Store debug data
                if (collectedDebugData && messageId) {
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
    
    apiReq.write(JSON.stringify(requestData));
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
                
        // Build messages for API - include chat history if available
        const messages = [];
        
        // Get chat history if chat_id exists
        if (chat_id) {
            const { db } = require('../config/database');
            const historyRows = await new Promise((resolve, reject) => {
                db.all(
                    'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY timestamp ASC',
                    [chat_id],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
                    }
                );
            });
            
            // Add history to messages
            historyRows.forEach(row => {
                messages.push({ role: row.role, content: row.content });
            });
        } else {
            // No chat_id, add the current message with specified role or default to 'user'
            const role = message_role || 'user';
            messages.push({ role: role, content: message });
            log(`[CHAT] Added message with role: ${role}`);
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
    processChatRequest
};
