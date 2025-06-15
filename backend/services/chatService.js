// Chat Service - Handle AI chat logic, streaming, and tool execution
const https = require('https');
const http = require('http');
const { log } = require('../utils/logger');
const { getCurrentSettings } = require('./settingsService');
const { executeMCPTool, getAvailableToolsForChat } = require('./mcpService');
const { addToolEvent, storeDebugData } = require('./toolEventService');

// Handle chat with potential tool calls
async function handleChatWithTools(res, messages, tools, chatId, debugData = null, responseCounter = 1, messageId = null, existingDebugData = null, conductorPhase = null, blockToolExecution = false, blockRecursiveToolResponse = false) {
    const currentSettings = getCurrentSettings();
    
    // Ensure we have a model name
    if (!currentSettings.modelName) {
        res.status(400).json({ error: 'No model specified. Please configure a model in settings.' });
        return;
    }
    
    const requestData = {
        model: currentSettings.modelName,
        messages: messages,
        stream: true,
        //think: false,
        //extra_body: {"think": false},
        //options: {"enable_thinking": false},
        ...(tools.length > 0 ? { tools } : {})
    };
    
    // Set up streaming response FIRST before any writes (only if headers not already sent)
    if (!res.headersSent) {
        const headers = {
            'Content-Type': 'text/plain',
            'Transfer-Encoding': 'chunked'
        };
        
        // Add messageId header for debug data fetching
        if (messageId) {
            headers['X-Message-Id'] = messageId;
        }
        
        res.writeHead(200, headers);
    }
    
    // Collect debug data separately - NEVER write to content stream
    let collectedDebugData = existingDebugData;
    let sequenceStep = 1;
    
    // Initialize debug data on first call, or use existing
    if (debugData && messageId && !collectedDebugData) {
        collectedDebugData = {
            messageId: messageId,
            type: 'debug',
            metadata: {
                endpoint: debugData.endpoint,
                timestamp: new Date().toISOString(),
                tools: tools,
                settings: debugData.settings
            },
            sequence: []
        };
    }
    
    // Calculate next sequence step
    if (collectedDebugData) {
        sequenceStep = collectedDebugData.sequence.length + 1;
        
        // Add this request to the sequence
        const requestStep = {
            type: 'request',
            step: sequenceStep++,
            timestamp: new Date().toISOString(),
            data: {
                request: requestData,
                responseNumber: responseCounter
            }
        };
        
        // Add conductor phase info if available
        if (conductorPhase !== null) {
            requestStep.data.conductorPhase = conductorPhase;
        }
        
        collectedDebugData.sequence.push(requestStep);
    }
    
    const url = new URL(`${currentSettings.apiUrl}/chat/completions`);
    const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(requestData)),
            ...(currentSettings.apiKey ? { 'Authorization': `Bearer ${currentSettings.apiKey}` } : {})
        }
    };

    
    let assistantMessage = '';
    let toolCalls = [];
    let currentToolCall = null;
    
    // Make request - old school style
    const httpModule = url.protocol === 'https:' ? https : http;
    const apiReq = httpModule.request(options, (apiRes) => {
        // Capture RAW HTTP response data for debug
        let rawResponseData = {
            statusCode: apiRes.statusCode,
            statusMessage: apiRes.statusMessage,
            headers: apiRes.headers,
            body: ''
        };
        
        if (apiRes.statusCode !== 200) {
            res.write(`API error: ${apiRes.statusCode} ${apiRes.statusMessage}`);
            res.end();
            return;
        }
        
        // Stream the response back
        apiRes.on('data', (chunk) => {
            // Capture raw response body for debug
            rawResponseData.body += chunk.toString();
            const chunkStr = chunk.toString();
            const lines = chunkStr.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') continue;
                    
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        
                        // Handle regular content
                        if (delta?.content) {
                            assistantMessage += delta.content;
                            res.write(delta.content);
                        }
                        
                        // Handle tool calls - send to tool events stream
                        if (delta?.tool_calls) {
                            for (const toolCall of delta.tool_calls) {
                                const index = toolCall.index;
                                
                                if (!toolCalls[index]) {
                                    toolCalls[index] = {
                                        id: toolCall.id || `call_${Date.now()}_${index}`,
                                        type: 'function',
                                        function: { name: '', arguments: '' }
                                    };
                                    
                                    // Send tool call detected event (only if tools aren't blocked)
                                    if (messageId && !blockToolExecution) {
                                        addToolEvent(messageId, {
                                            type: 'tool_call_detected',
                                            data: {
                                                id: toolCalls[index].id,
                                                index: index,
                                                name: toolCall.function?.name || '',
                                                timestamp: new Date().toISOString()
                                            }
                                        });
                                    }
                                }
                                
                                if (toolCall.function?.name) {
                                    toolCalls[index].function.name = toolCall.function.name;
                                }
                                
                                if (toolCall.function?.arguments) {
                                    toolCalls[index].function.arguments += toolCall.function.arguments;
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            }
        });
        
        apiRes.on('end', async () => {
            // If we have tool calls, check execution flags
            if (toolCalls.length > 0) {
                
                // Check if tool execution is blocked (Phase 1)
                if (blockToolExecution) {
                    log(`[TOOLS] Tool execution blocked by flag - skipping tools and ending response`);
                    
                    // Add response to debug sequence showing tools were detected but blocked
                    if (collectedDebugData) {
                        const responseStep = {
                            type: 'response',
                            step: sequenceStep++,
                            timestamp: new Date().toISOString(),
                            data: {
                                responseNumber: responseCounter,
                                content: assistantMessage,
                                tool_calls: toolCalls,
                                finish_reason: 'tool_calls_blocked',
                                response_length: assistantMessage.length,
                                has_tool_calls: true,
                                tools_blocked: true,
                                raw_http_response: rawResponseData
                            }
                        };
                        
                        if (conductorPhase !== null) {
                            responseStep.data.conductorPhase = conductorPhase;
                        }
                        
                        collectedDebugData.sequence.push(responseStep);
                        
                        // Store debug data
                        storeDebugData(messageId, collectedDebugData);
                        log(`[DEBUG-SEPARATION] Stored debug data for blocked tools message: ${messageId}`);
                    }
                    
                    // End response without executing tools
                    res.end();
                    return;
                }
                // FIRST: Add response to debug sequence (shows AI decided to call tools)
                if (collectedDebugData) {
                    const responseStep = {
                        type: 'response',
                        step: sequenceStep++,
                        timestamp: new Date().toISOString(),
                        data: {
                            responseNumber: responseCounter,
                            content: assistantMessage,
                            tool_calls: toolCalls,
                            finish_reason: 'tool_calls',
                            response_length: assistantMessage.length,
                            has_tool_calls: true,
                            // RAW HTTP RESPONSE DATA - exactly what came back from AI API
                            raw_http_response: rawResponseData
                        }
                    };
                    
                    // Add conductor phase info if available
                    if (conductorPhase !== null) {
                        responseStep.data.conductorPhase = conductorPhase;
                    }
                    
                    collectedDebugData.sequence.push(responseStep);
                }
                
                // THEN: Execute tools silently without contaminating response stream
                const toolResults = [];
                for (const toolCall of toolCalls) {
                    const toolStartTime = new Date().toISOString();
                    try {
                        const args = JSON.parse(toolCall.function.arguments || '{}');
                        
                        // Add tool execution start to debug sequence
                        if (collectedDebugData) {
                            collectedDebugData.sequence.push({
                                type: 'tool_execution',
                                step: sequenceStep++,
                                timestamp: toolStartTime,
                                data: {
                                    tool_call_id: toolCall.id,
                                    tool_name: toolCall.function.name,
                                    arguments: args,
                                    status: 'starting'
                                }
                            });
                        }
                        
                        // Send tool execution start event
                        if (messageId) {
                            addToolEvent(messageId, {
                                type: 'tool_execution_start',
                                data: {
                                    id: toolCall.id,
                                    name: toolCall.function.name,
                                    arguments: args,
                                    timestamp: toolStartTime
                                }
                            });
                        }
                        
                        const result = await executeMCPTool(toolCall.function.name, args);
                        
                        // Add tool execution result to debug sequence
                        if (collectedDebugData) {
                            collectedDebugData.sequence.push({
                                type: 'tool_result',
                                step: sequenceStep++,
                                timestamp: new Date().toISOString(),
                                data: {
                                    tool_call_id: toolCall.id,
                                    tool_name: toolCall.function.name,
                                    status: 'success',
                                    result: result,
                                    execution_time_ms: Date.now() - new Date(toolStartTime).getTime()
                                }
                            });
                        }
                        
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: result.content || 'Tool executed successfully'
                        });
                        
                        // Send tool execution success event
                        if (messageId) {
                            addToolEvent(messageId, {
                                type: 'tool_execution_complete',
                                data: {
                                    id: toolCall.id,
                                    name: toolCall.function.name,
                                    status: 'success',
                                    result: result.content || 'Tool executed successfully',
                                    execution_time_ms: Date.now() - new Date(toolStartTime).getTime(),
                                    timestamp: new Date().toISOString()
                                }
                            });
                        }
                        
                    } catch (error) {
                        const errorMsg = `Error executing ${toolCall.function.name}: ${error.message}`;
                        
                        // Add tool execution error to debug sequence
                        if (collectedDebugData) {
                            collectedDebugData.sequence.push({
                                type: 'tool_result',
                                step: sequenceStep++,
                                timestamp: new Date().toISOString(),
                                data: {
                                    tool_call_id: toolCall.id,
                                    tool_name: toolCall.function.name,
                                    status: 'error',
                                    error: errorMsg,
                                    execution_time_ms: Date.now() - new Date(toolStartTime).getTime()
                                }
                            });
                        }
                        
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: errorMsg
                        });
                        
                        // Send tool execution error event
                        if (messageId) {
                            addToolEvent(messageId, {
                                type: 'tool_execution_complete',
                                data: {
                                    id: toolCall.id,
                                    name: toolCall.function.name,
                                    status: 'error',
                                    error: errorMsg,
                                    execution_time_ms: Date.now() - new Date(toolStartTime).getTime(),
                                    timestamp: new Date().toISOString()
                                }
                            });
                        }
                    }
                }
                
                // Continue conversation with tool results (no stream contamination)
                const newMessages = [...messages];
                newMessages.push({
                    role: 'assistant',
                    content: assistantMessage,
                    tool_calls: toolCalls
                });
                newMessages.push(...toolResults);
                
                // Check if recursive call is blocked (Phase 3)
                if (blockRecursiveToolResponse) {
                    log(`[TOOLS] Recursive call blocked by flag - tools executed but no follow-up request`);
                    
                    // Store debug data and end response
                    if (collectedDebugData) {
                        storeDebugData(messageId, collectedDebugData);
                        log(`[DEBUG-SEPARATION] Stored debug data for non-recursive tools: ${messageId}`);
                    }
                    
                    res.end();
                    return;
                }
                
                // Make another API call with tool results (increment counter)
                await handleChatWithTools(res, newMessages, tools, chatId, debugData, responseCounter + 1, messageId, collectedDebugData, conductorPhase, blockToolExecution, blockRecursiveToolResponse);
                return;
            }
            
            // Add final response to sequence (no tool calls)
            if (collectedDebugData) {
                const responseStep = {
                    type: 'response',
                    step: sequenceStep++,
                    timestamp: new Date().toISOString(),
                    data: {
                        responseNumber: responseCounter,
                        content: assistantMessage,
                        tool_calls: toolCalls,
                        finish_reason: 'stop',
                        response_length: assistantMessage.length,
                        has_tool_calls: false,
                        // RAW HTTP RESPONSE DATA - exactly what came back from AI API
                        raw_http_response: rawResponseData
                    }
                };
                
                // Add conductor phase info if available
                if (conductorPhase !== null) {
                    responseStep.data.conductorPhase = conductorPhase;
                }
                
                collectedDebugData.sequence.push(responseStep);
                
                // Store debug data in our separate store
                storeDebugData(messageId, collectedDebugData);
                log(`[DEBUG-SEPARATION] Stored debug data for message: ${messageId}`);
            }
            
            res.end();
        });
    });
    
    apiReq.on('error', (error) => {
        res.write(`Connection error: ${error.message}`);
        res.end();
    });
    
    // Send request data
    apiReq.write(JSON.stringify(requestData));
    apiReq.end();
}

// Process chat request
async function processChatRequest(req, res) {
    try {
        const { message, chat_id, conductor_mode, enabled_tools, conductor_phase, message_role, block_tool_execution, block_recursive_call } = req.body;
        
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
            endpoint: `${currentSettings.apiUrl}/chat/completions`,
            settings: currentSettings,
            toolsEnabled: tools.length
        };
        
        // Generate unique message ID for debug data
        const { generateMessageId, initializeToolEvents } = require('./toolEventService');
        const messageId = generateMessageId();
        
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