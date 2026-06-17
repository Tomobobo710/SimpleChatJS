// Chat Stream Service - Streaming request orchestration, cancellation, and tool execution continuation.
// Handles the full lifecycle of an AI provider streaming response.

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { log } = require("../utils/logger");
const { getCurrentSettings } = require("./settingsService");
const { executeMCPTool, getAvailableToolsForChat, isMcpTool } = require("./mcpService");
const simpleTools = require("./simpleToolsService");
const { addToolEvent, initializeToolEvents } = require("./toolEventService");

const { saveMessage, saveTurnDebugData, getTurnDebugData } = require("./messageRepository");
const { incrementTurnNumber, getTurnInfo, getCurrentTurnNumber } = require("./turnService");
const { buildSystemMessageIfEnabled } = require("./systemPromptService");
const responseAdapterFactory = require("../adapters/ResponseAdapterFactory");
const UnifiedResponse = require("../adapters/UnifiedResponse");

async function pushTurnError(chatId, turnInfo, responsePayload, errorPayload) {
    let debug = getTurnDebugData(chatId, turnInfo.turn_id) || {};
    if (!debug.responses) debug.responses = [];
    debug.responses.push({ response: responsePayload, error: errorPayload });
    await saveTurnDebugData(chatId, turnInfo.turn_id, debug);
}

// In-flight chat requests, keyed by requestId.
const inFlightRequests = new Map();

// Debug data structure stored in turn_debug table (keyed by chat_id + turn_id):
// {
//   sequence: [ ... ],           // Request debug sequence
//   responses: [                 // Response debug entries (each may have both response + error)
//     {
//       response: { content, toolCalls, status, rawBody },
//       error: { type, message, status_code }  // Optional: only if error occurred
//     },
//     ...
//   ]
// }

// Helper: Write SSE event to response
function writeSSEEvent(res, eventType, data) {
    const jsonData = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`event: ${eventType}\ndata: ${jsonData}\n\n`);
}

// Cancel an in-flight chat request by requestId.
function cancelInFlightRequest(requestId) {
    const state = inFlightRequests.get(requestId);
    if (!state) {
        return { found: false, reason: "not_in_flight" };
    }
    if (state.saved) {
        return { found: true, reason: "already_handled" };
    }
    state.cancelledByUser = true;
    state.saved = true;
    inFlightRequests.delete(requestId);

    const streamedSoFar = state.streamedContent || "";
    const ur = state.unifiedResponse;
    const toolCalls = (ur && ur.toolCalls && ur.toolCalls.length > 0) ? ur.toolCalls : null;
    const reasoning = (ur && ur.reasoning) || null;
    const errorMessage = {
        role: "assistant",
        content: streamedSoFar,
        reasoning,
        tool_calls: toolCalls
    };
    saveMessage(state.chatId, errorMessage, state.currentTurn, "user_stopped", state.turnInfo)
        .then(async () => {
            // Append error to responses array in turn_debug (with any streamed content)
            if (state.turnInfo) {
                try {
                    await pushTurnError(state.chatId, state.turnInfo, {
                        content: streamedSoFar,
                        reasoning: reasoning || null,
                        toolCalls: toolCalls || [],
                        hasToolCalls: !!toolCalls,
                        status: null,
                        rawBody: state.rawResponseBody || ""
                    }, { type: "user_stopped", message: "Generation stopped by user." });
                } catch (debugError) {
                    log(`[CANCEL] Failed to save user_stopped debug data: ${debugError.message}`);
                }
            }
            if (streamedSoFar && streamedSoFar.trim() !== "") {
                await saveMessage(state.chatId, { role: "system", content: "Generation stopped by user." }, state.currentTurn, null, state.turnInfo);
            }
            incrementTurnNumber(state.chatId);
            log(`[CANCEL] Saved user_stopped and burned turn ${state.currentTurn} for requestId=${requestId}`);
        })
        .catch((saveError) => {
            log(`[CANCEL] Failed to save user_stopped for requestId=${requestId}: ${saveError.message}`);
        });

    // Tear down the upstream.
    if (state.apiReq) {
        try { state.apiReq.destroy(); } catch (_) {}
    } else {
        state.destroyWhenCreated = true;
    }
    return { found: true, reason: "cancelled" };
}

  // Build response debug entry for the turn_debug table.
  // This creates the structure that gets appended to the responses array.
function buildMessageDebugData({ requestId, chatId, turnId, parentTurnId, currentTurn, targetUrl, requestData, apiRes, unifiedResponse, rawResponseBody }) {
    const data = {
        requestId,
        turnId,
        parentTurnId,
        currentTurnNumber: currentTurn
    };

    if (targetUrl) {
        data.request = { url: targetUrl, body: requestData };
    }

    if (unifiedResponse) {
        data.response = {
            content: unifiedResponse.content || "",
            toolCalls: unifiedResponse.toolCalls || [],
            reasoning: unifiedResponse.reasoning || "",
            hasToolCalls: unifiedResponse.hasToolCalls(),
            status: apiRes ? apiRes.statusCode : null,
            rawBody: rawResponseBody || ""
        };
    }

    return data;
}

// Handle chat with potential tool calls
async function handleChatWithTools(
    req,
    res,
    messages,
    tools,
    chatId,
    debugData = null,
    responseCounter = 1,
    requestId = null,
    existingDebugData = null,
    parentTurnId = null,
    requestTurnId = null
) {
    const currentSettings = getCurrentSettings();

    if (!currentSettings.modelName) {
        res.status(400).json({ error: "No model specified. Please configure a model in settings." });
        return;
    }

    // Get the appropriate adapter for current settings
    const adapter = responseAdapterFactory.getAdapter(currentSettings);
    log(`[ADAPTER] Using ${adapter.providerName} adapter`);

    adapter.setToolEventEmitter((eventType, data, reqId) => {
        if (reqId) {
            addToolEvent(reqId, { type: eventType, data: data });
        }
    });

    // Generate turn info for this conversation turn
    let turnInfo;
    if (responseCounter > 1 && requestTurnId) {
        turnInfo = getTurnInfo(parentTurnId, requestTurnId);
    } else if (requestTurnId) {
        turnInfo = getTurnInfo(requestTurnId);
    } else {
        turnInfo = getTurnInfo(null);
    }

    // Create unified request
    const unifiedRequest = responseAdapterFactory.createUnifiedRequest(messages, tools, currentSettings.modelName);

    // Convert to provider-specific format (settings injected for thinking, etc.)
    const requestData = adapter.convertRequest(unifiedRequest, currentSettings);

    // Build the 3-step request sequence for the request debug panel
    const requestSequence = [
        {
            type: 'user_http_request',
            step: 1,
            timestamp: new Date().toISOString(),
            data: {
                requestBody: req.body || {}
            }
        },
        {
            type: 'unified_request',
            step: 2,
            timestamp: new Date().toISOString(),
            data: {
                requestBody: unifiedRequest
            }
        },
        {
            type: 'ai_http_request',
            step: 3,
            timestamp: new Date().toISOString(),
            data: {
                requestBody: requestData
            }
        }
    ];

    if (requestId) {
        addToolEvent(requestId, {
            type: "request_debug",
            data: { sequence: requestSequence }
        });
    }

    // Set up streaming response headers FIRST.
    if (!res.headersSent) {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Transfer-Encoding", "chunked");

        if (requestId) {
            res.setHeader("X-Request-Id", requestId);
        }

        // Response turn identifiers in response headers
        if (turnInfo?.turn_id) {
            res.setHeader("X-Response-Turn-Id", turnInfo.turn_id);
        }
        if (turnInfo?.parent_turn_id) {
            res.setHeader("X-Response-Parent-Turn-Id", turnInfo.parent_turn_id);
        }
    }

    // Initialize turn number
    let currentTurn;
    if (debugData && debugData.currentTurn) {
        currentTurn = debugData.currentTurn;
    } else {
        currentTurn = chatId ? getCurrentTurnNumber(chatId) + 1 : 1;
    }

    // Get provider-specific URL and headers
    const targetUrl = adapter.getEndpointUrl(currentSettings);
    const headers = adapter.getHeaders(currentSettings);
    headers["Content-Length"] = Buffer.byteLength(JSON.stringify(requestData));

    const DEBUG_ADAPTERS = process.env.DEBUG === "1";
    if (DEBUG_ADAPTERS) {
        log(`[${adapter.providerName.toUpperCase()}-DEBUG] URL:`, targetUrl);
        log(`[${adapter.providerName.toUpperCase()}-DEBUG] Request Body:`, JSON.stringify(requestData, null, 2));
    }

    // Store the request sequence in the turn's debug data
    if (chatId && requestTurnId) {
        try {
            let userDebugData = getTurnDebugData(chatId, requestTurnId);
            if (!userDebugData) {
                userDebugData = {};
            }
            userDebugData.sequence = requestSequence;
            saveTurnDebugData(chatId, requestTurnId, userDebugData);
        } catch (error) {
            log("[DEBUG-STORE] ERROR:", error.message);
        }
    }

    // The request is fully built and persisted, but we have not yet contacted
    // the AI provider — this is the "request is complete, response has not
    // begun" point. Push the request's debug data on the request-scoped event
    // channel so the frontend can render the request's debug panel immediately,
    // decoupled from the response. Events are buffered, so this is safe whether
    // or not the frontend's listener has connected yet.
    log("[ACTUAL-REQUEST] Sending to API:", JSON.stringify(requestData, null, 2));

    const url = new URL(targetUrl);
    const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: headers
    };

    // Create unified response object
    const unifiedResponse = new UnifiedResponse().setProvider(adapter.providerName);

    // Build thinking config for adapters that need it during streaming
    const thinkingConfig = {
        anthropic: { enabled: currentSettings.enableThinkingAnthropic === true, budget: currentSettings.thinkingBudgetAnthropic },
        google: { enabled: currentSettings.enableThinkingGoogle !== false, budget: currentSettings.thinkingBudgetGoogle }
    };
    const context = adapter.createContext(currentSettings.modelName, thinkingConfig[adapter.providerName]);

    // Make HTTP request
    const httpModule = url.protocol === "https:" ? https : http;

    // Track streamed content for error handling
    let streamedContent = "";
    // Track raw response body for debug
    let rawResponseBody = "";

    // Register the in-flight state
    const inFlightState = {
        apiReq: null,
        chatId,
        currentTurn,
        turnInfo,
        unifiedResponse,
        cancelledByUser: false,
        saved: false,
        destroyWhenCreated: false,
        streamedContent: "",
        rawResponseBody: ""
    };
    if (requestId) {
        inFlightRequests.set(requestId, inFlightState);
    }

    res.on("close", () => {
        if (res.writableEnded) return;
        if (inFlightState.saved) return;
        inFlightState.saved = true;
        if (requestId) inFlightRequests.delete(requestId);
        if (inFlightState.apiReq) {
            try { inFlightState.apiReq.destroy(); } catch (_) {}
        }
        const streamedSoFar = inFlightState.streamedContent || "";
        const toolCalls = (unifiedResponse && unifiedResponse.toolCalls && unifiedResponse.toolCalls.length > 0) ? unifiedResponse.toolCalls : null;
        const reasoning = (unifiedResponse && unifiedResponse.reasoning) || null;
        const errorMessage = {
            role: "assistant",
            content: streamedSoFar,
            reasoning,
            tool_calls: toolCalls
        };
        saveMessage(chatId, errorMessage, currentTurn, "connection_error", turnInfo)
            .then(async () => {
                // Append error to responses array in turn_debug
                if (turnInfo) {
                    try {
                        await pushTurnError(chatId, turnInfo, {
                            content: streamedSoFar,
                            toolCalls: toolCalls || [],
                            hasToolCalls: !!toolCalls,
                            status: null,
                            rawBody: inFlightState.rawResponseBody || ""
                        }, { type: "connection_error", message: "Client disconnected" });
                    } catch (debugError) {
                        log(`[ERROR-HANDLING] Failed to save connection error debug data: ${debugError.message}`);
                    }
                }
                if (streamedSoFar && streamedSoFar.trim() !== "") {
                    await saveMessage(chatId, { role: "system", content: "Connection error while receiving response." }, currentTurn, null, turnInfo);
                }
                incrementTurnNumber(chatId);
                log(`[ERROR-HANDLING] Saved connection error and burned turn ${currentTurn}`);
            })
            .catch((saveError) => {
                log(`[ERROR-HANDLING] Failed to save connection error: ${saveError.message}`);
            });
    });

    const apiReq = httpModule.request(options, (apiRes) => {
        inFlightState.apiReq = apiReq;
        if (inFlightState.destroyWhenCreated) {
            apiReq.destroy();
        }

        if (apiRes.statusCode !== 200) {
            let errorData = "";
            apiRes.on("data", (chunk) => {
                errorData += chunk.toString();
            });
            apiRes.on("end", () => {
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Status:`, apiRes.statusCode);
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Response:`, errorData);

                // Parse and show the actual API error message to the user
                let userErrorMessage = `API error: ${apiRes.statusCode} ${apiRes.statusMessage}`;
                try {
                    const errorObj = JSON.parse(errorData);
                    if (errorObj.error && errorObj.error.message) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorObj.error.message}`;
                    } else if (errorObj.message) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorObj.message}`;
                    } else if (errorObj.detail) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorObj.detail}`;
                    }
                } catch (parseError) {
                    if (errorData && errorData.length < 500) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorData.trim()}`;
                    }
                }

                // Save error message and burn the turn.
                if (chatId && currentTurn) {
                    const toolCalls = (unifiedResponse && unifiedResponse.toolCalls && unifiedResponse.toolCalls.length > 0) ? unifiedResponse.toolCalls : null;
                    const reasoning = (unifiedResponse && unifiedResponse.reasoning) || null;
                    const errorMessage = {
                        role: "assistant",
                        content: "",
                        reasoning,
                        tool_calls: toolCalls
                    };
                    saveMessage(chatId, errorMessage, currentTurn, "api_error", turnInfo)
                        .then(async () => {
                            // Append error to responses array in turn_debug
                            if (turnInfo) {
                                try {
                                    await pushTurnError(chatId, turnInfo, {
                                        content: "",
                                        toolCalls: toolCalls || [],
                                        hasToolCalls: !!toolCalls,
                                        status: apiRes.statusCode,
                                        rawBody: errorData
                                    }, {
                                        type: "api_error",
                                        status_code: apiRes.statusCode,
                                        status_message: apiRes.statusMessage,
                                        message: userErrorMessage
                                    });
                                } catch (debugError) {
                                    log(`[ERROR-HANDLING] Failed to save error debug data: ${debugError.message}`);
                                }
                            }
                            incrementTurnNumber(chatId);
                            log(`[ERROR-HANDLING] Saved API error message and burned turn ${currentTurn}`);
                        })
                        .catch((saveError) => {
                            log(`[ERROR-HANDLING] Failed to save error message: ${saveError.message}`);
                        });
                }

                if (!res.headersSent) {
                    res.setHeader("X-Stream-Error", "api_error");
                }
                res.write(userErrorMessage);
                res.end();
            });
            return;
        }

        // Stream response processing
        apiRes.on("data", (chunk) => {
            try {
                const result = adapter.processChunk(chunk, unifiedResponse, context);

                for (const event of result.events) {
                    if (event.type === "tool_call_detected" && DEBUG_ADAPTERS) {
                        log(`[ADAPTER-TOOL-EVENT] Tool call detected:`, event.data.toolName);
                    }
                    if (requestId) {
                        if (event.type === "tool_call_detected") {
                            addToolEvent(requestId, {
                                type: "tool_call_detected",
                                data: { name: event.data.toolName, id: event.data.toolId }
                            });
                        }
                        if (event.type === "tool_call_arguments_delta") {
                            addToolEvent(requestId, {
                                type: "tool_call_arguments_delta",
                                data: { id: event.data.toolId, name: event.data.toolName, arguments: event.data.arguments }
                            });
                        }
                    }
                }

                Object.assign(context, result.context);

                // Track reasoning phase - emit events when reasoning content appears/disappears
                const hasReasoningNow = unifiedResponse.reasoning.length > (context.prevReasoningLength || 0);
                
                if (hasReasoningNow && !context.inReasoningPhase) {
                    // Entering reasoning phase
                    const blockId = `reasoning_${Date.now()}`;
                    writeSSEEvent(res, 'reasoning_start', { blockId });
                    context.reasoningBlockId = blockId;
                    context.inReasoningPhase = true;
                }

                if (hasReasoningNow) {
                    // Emit delta for new reasoning content
                    const delta = unifiedResponse.reasoning.slice(context.prevReasoningLength || 0);
                    if (delta) {
                        writeSSEEvent(res, 'reasoning_delta', {
                            blockId: context.reasoningBlockId,
                            text: delta
                        });
                        context.prevReasoningLength = unifiedResponse.reasoning.length;
                    }
                } else if (context.inReasoningPhase && !hasReasoningNow) {
                    // Exiting reasoning phase (content appeared, no more reasoning)
                    if (unifiedResponse.content.length > 0) {
                        writeSSEEvent(res, 'reasoning_end', { blockId: context.reasoningBlockId });
                        context.inReasoningPhase = false;
                    }
                }

                // Emit content deltas
                if (unifiedResponse.content && context.lastContentLength !== unifiedResponse.content.length) {
                    const newContent = unifiedResponse.content.slice(context.lastContentLength || 0);
                    if (newContent) {
                        writeSSEEvent(res, 'content_delta', { text: newContent });
                        context.lastContentLength = unifiedResponse.content.length;
                        streamedContent += newContent;
                        inFlightState.streamedContent = streamedContent;
                    }
                }

                // Accumulate raw response body for debug
                rawResponseBody += chunk.toString();
                inFlightState.rawResponseBody = rawResponseBody;
            } catch (error) {
                console.error(`[${adapter.providerName.toUpperCase()}-ADAPTER] Error processing chunk:`, error);
            }
        });

        apiRes.on("end", async () => {
            log(`[${adapter.providerName.toUpperCase()}-ADAPTER] Stream ended`);

            if (inFlightState.saved) {
                if (requestId) inFlightRequests.delete(requestId);
                return;
            }
            inFlightState.saved = true;
            if (requestId) inFlightRequests.delete(requestId);

             // Handle tool calls if any
            if (unifiedResponse.hasToolCalls()) {
                log(`[ADAPTER] Processing ${unifiedResponse.toolCalls.length} tool calls`);

                await executeToolCallsAndContinue(
                    req,
                    res,
                    unifiedResponse.toolCalls,
                    messages,
                    tools,
                    chatId,
                    unifiedResponse.content,
                    unifiedResponse.reasoning,
                    currentTurn,
                    requestId,
                    turnInfo,
                    targetUrl,
                    requestData,
                    apiRes,
                    rawResponseBody
                );
            } else {
                // Increment turn number now that conversation is complete
                if (chatId) {
                    incrementTurnNumber(chatId);
                }

                // Save final assistant response to history
                if (chatId && unifiedResponse.content) {
                    log(`[CHAT-SAVE] reasoning content: "${unifiedResponse.reasoning.substring(0, 100)}..."`);
                    log(`[CHAT-SAVE] Content length: ${unifiedResponse.content.length}`);
                    log(`[CHAT-SAVE] Content preview: "${unifiedResponse.content.substring(0, 200)}..."`);
                    log(`[CHAT-SAVE] Turn number: ${currentTurn}`);

                    const finalResponseMessage = {
                        role: "assistant",
                        content: unifiedResponse.content,
                        reasoning: unifiedResponse.reasoning || null
                    };
                    try {
                        const finalMsgId = await saveMessage(chatId, finalResponseMessage, currentTurn, null, turnInfo);
                        log(`[CHAT-SAVE] Successfully saved final response to history`);

                        // Build and store debug data for the final response
                        const debugPayload = buildMessageDebugData({
                            requestId,
                            chatId,
                            turnId: turnInfo?.turn_id,
                            parentTurnId: turnInfo?.parent_turn_id,
                            currentTurn,
                            targetUrl,
                            requestData,
                            apiRes,
                            unifiedResponse,
                            rawResponseBody
                        });

                        if (turnInfo) {
                            try {
                                // Get existing turn debug data
                                let existingDebug = getTurnDebugData(chatId, turnInfo.turn_id) || {};
                                
                                // Append response to array (wrap in object for consistency)
                                if (!existingDebug.responses) {
                                    existingDebug.responses = [];
                                }
                                existingDebug.responses.push({
                                    response: debugPayload.response,
                                    turnId: debugPayload.turnId,
                                    parentTurnId: debugPayload.parentTurnId,
                                    currentTurnNumber: debugPayload.currentTurnNumber
                                });
                                
                                await saveTurnDebugData(chatId, turnInfo.turn_id, existingDebug);
                                log(`[ADAPTER-DEBUG] Debug data stored for turn_id=${turnInfo.turn_id}`);
                            } catch (error) {
                                log(`[ADAPTER-DEBUG] Failed to store debug data: ${error.message}`);
                            }
                        }
                    } catch (error) {
                        log(`[CHAT-SAVE] Error saving final response: ${error.message}`);
                    }
                } else {
                    log(
                        `[CHAT-SAVE] NOT saving final response - chatId: ${chatId}, content length: ${unifiedResponse.content ? unifiedResponse.content.length : "null"}`
                    );
                }

                // Finish any active reasoning phase
                if (context.inReasoningPhase) {
                    writeSSEEvent(res, 'reasoning_end', { blockId: context.reasoningBlockId });
                }

                // Emit done event with complete response
                writeSSEEvent(res, 'done', unifiedResponse.toJSON());

                // Finish response
                res.end();
            }
        });
    });

    apiReq.on("error", (error) => {
        log(`[${adapter.providerName.toUpperCase()}] Request error:`, error);

        if (inFlightState.saved) {
            return;
        }
        inFlightState.saved = true;
        if (requestId) inFlightRequests.delete(requestId);

        if (chatId && currentTurn) {
            const streamedSoFar = inFlightState.streamedContent || "";
            const toolCalls = (unifiedResponse && unifiedResponse.toolCalls && unifiedResponse.toolCalls.length > 0) ? unifiedResponse.toolCalls : null;
            const reasoning = (unifiedResponse && unifiedResponse.reasoning) || null;
            const errorMessage = {
                role: "assistant",
                content: streamedSoFar,
                reasoning,
                tool_calls: toolCalls
            };
            saveMessage(chatId, errorMessage, currentTurn, "connection_error", turnInfo)
                .then(async () => {
                    // Append error to responses array in turn_debug
                    if (turnInfo) {
                        try {
                            const streamedSoFar = inFlightState.streamedContent || "";
                            await pushTurnError(chatId, turnInfo, {
                                content: streamedSoFar,
                                toolCalls: toolCalls || [],
                                hasToolCalls: !!toolCalls,
                                status: null,
                                rawBody: inFlightState.rawResponseBody || ""
                            }, { type: "connection_error", message: error.message });
                        } catch (debugError) {
                            log(`[ERROR-HANDLING] Failed to save connection error debug data: ${debugError.message}`);
                        }
                    }
                    if (streamedSoFar && streamedSoFar.trim() !== "") {
                        await saveMessage(chatId, { role: "system", content: "Connection error while receiving response." }, currentTurn, null, turnInfo);
                    }
                    incrementTurnNumber(chatId);
                    log(`[ERROR-HANDLING] Saved connection error and burned turn ${currentTurn}`);
                })
                .catch((saveError) => {
                    log(`[ERROR-HANDLING] Failed to save connection error: ${saveError.message}`);
                });
        }

        if (!res.headersSent) {
            res.setHeader("X-Stream-Error", "connection_error");
        }
        res.write(`Connection error: ${error.message}`);
        res.end();
    });

    const actualRequestPayload = JSON.stringify(requestData);
    apiReq.write(actualRequestPayload);
    apiReq.end();
}

// Execute tool calls and continue conversation
async function executeToolCallsAndContinue(
    req,
    res,
    toolCalls,
    messages,
    tools,
    chatId,
    assistantMessage,
    reasoning,
    currentTurn,
    requestId,
    turnInfo = null,
    targetUrl = null,
    requestData = null,
    apiRes = null,
    rawResponseBody = ""
) {
    // Add assistant message with tool calls to conversation
    const assistantMessageWithTools = {
        role: "assistant",
        content: assistantMessage || "",
        tool_calls: toolCalls,
        reasoning: reasoning || null
    };
    log(`[CHAT-SAVE] Saving tool message with reasoning: "${reasoning ? reasoning.substring(0, 100) : 'null'}..."`);
    messages.push(assistantMessageWithTools);

    // Save assistant message with tool calls FIRST (before tool results)
    if (chatId) {
        await saveMessage(chatId, assistantMessageWithTools, currentTurn, null, turnInfo);
        log(`[CHAT-SAVE] Saved response message with ${toolCalls.length} tool calls`);
    }

    // Execute each tool call and collect results
    const toolResults = [];
    for (const toolCall of toolCalls) {
        log(`[TOOL-EXECUTION] Executing tool: ${toolCall.function.name}`);

        if (requestId) {
            addToolEvent(requestId, {
                type: "tool_execution_start",
                data: { name: toolCall.function.name, id: toolCall.id, arguments: JSON.parse(toolCall.function.arguments) }
            });
        }

        try {
            const toolArgs = JSON.parse(toolCall.function.arguments);

            let toolResult;
            if (isMcpTool(toolCall.function.name)) {
                toolResult = await executeMCPTool(toolCall.function.name, toolArgs);
            } else {
                toolResult = await simpleTools.executeSimpleTool(toolCall.function.name, toolArgs);
            }

            const toolMessage = {
                role: "tool",
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,
                content: JSON.stringify(toolResult)
            };
            messages.push(toolMessage);

            // Save tool message to database
            if (chatId) {
                await saveMessage(chatId, toolMessage, currentTurn, null, turnInfo);
                log(`[CHAT-SAVE] Saved tool response for ${toolCall.function.name}`);
            }

            toolResults.push({
                toolId: toolCall.id,
                toolName: toolCall.function.name,
                status: "success",
                result: toolResult
            });

            if (requestId) {
                addToolEvent(requestId, {
                    type: "tool_execution_complete",
                    data: { name: toolCall.function.name, id: toolCall.id, status: "success", result: toolResult }
                });
            }

        } catch (error) {
            log(`[TOOL-EXECUTION] Error executing tool ${toolCall.function.name}:`, error);

            const errorMessage = {
                role: "tool",
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,
                content: JSON.stringify({ error: error.message })
            };
            messages.push(errorMessage);

            // Save tool error message to database
            if (chatId) {
                await saveMessage(chatId, errorMessage, currentTurn, null, turnInfo);
                log(`[CHAT-SAVE] Saved tool error for ${toolCall.function.name}`);
            }

            toolResults.push({
                toolId: toolCall.id,
                toolName: toolCall.function.name,
                status: "error",
                error: error.message
            });

            if (requestId) {
                addToolEvent(requestId, {
                    type: "tool_execution_complete",
                    data: { name: toolCall.function.name, id: toolCall.id, status: "error", error: error.message }
                });
            }

        }
    }

    // Tool results are saved — now handle debug data if needed
    if (chatId && targetUrl) {
        const debugPayload = buildMessageDebugData({
            requestId,
            chatId,
            turnId: turnInfo?.turn_id,
            parentTurnId: turnInfo?.parent_turn_id,
            currentTurn,
            targetUrl,
            requestData,
            apiRes,
            unifiedResponse: { content: assistantMessage || "", toolCalls, hasToolCalls: () => true, reasoning: reasoning || "" },
            rawResponseBody
        });

        // Attach tool results to debug data
        if (toolResults.length > 0) {
            debugPayload.toolResults = toolResults;
        }

        if (turnInfo) {
            try {
                // Get existing turn debug data
                let existingDebug = getTurnDebugData(chatId, turnInfo.turn_id) || {};
                
                // Append response to array (wrap in object for consistency)
                if (!existingDebug.responses) {
                    existingDebug.responses = [];
                }
                existingDebug.responses.push({
                    response: debugPayload.response,
                    turnId: debugPayload.turnId,
                    parentTurnId: debugPayload.parentTurnId,
                    currentTurnNumber: debugPayload.currentTurnNumber
                });
                if (debugPayload.toolResults) {
                    existingDebug.toolResults = debugPayload.toolResults;
                }
                
                await saveTurnDebugData(chatId, turnInfo.turn_id, existingDebug);
                log(`[ADAPTER-DEBUG] Debug data stored for turn_id=${turnInfo.turn_id}`);
            } catch (error) {
                log(`[ADAPTER-DEBUG] Failed to store debug data: ${error.message}`);
            }
        }
    }

    // Continue conversation with tool results — same turn as the tool-call response
    await handleChatWithTools(
        req,
        res,
        messages,
        tools,
        chatId,
        null,  // debugData — tool calls don't need it
        2,     // responseCounter — reuse original turn_id via getTurnInfo(parent, request)
        requestId,
        null,  // existingDebugData
        turnInfo?.parent_turn_id,
        turnInfo?.turn_id
    );
}

// Process chat request (entry point from routes)
async function processChatRequest(req, res) {
    const { db } = require("../config/database");
    const { chat_id, enabled_tools, request_id, parent_turn_id, turn_id, history_anchor_turn_id } = req.body || {};
    try {

        // Build messages for API from chat history.
        // `history_anchor_turn_id` (set by frontend for retry/edit-retry) filters
        // history to that turn's lineage. For normal chat it's null — full history.
        log(`[CHAT] Request body: parent_turn_id=${parent_turn_id}, history_anchor_turn_id=${history_anchor_turn_id}`);
        let historyMaxTurnId = null;
        if (history_anchor_turn_id) {
            const anchorMsg = db
                .prepare("SELECT turn_id FROM messages WHERE chat_id = ? AND turn_id = ? LIMIT 1")
                .get(chat_id, history_anchor_turn_id);
            if (anchorMsg) {
                historyMaxTurnId = history_anchor_turn_id;
                log(
                    `[CHAT] Filtering history to selected turn lineage (maxTurnId=${historyMaxTurnId})`
                );
            }
        }

        const { getChatHistoryForAPI } = require('./messageRepository');
        const messages = getChatHistoryForAPI(chat_id, historyMaxTurnId);

        log(`[CHAT-DEBUG] Current history count: ${messages.length}`);

        if (messages.length === 0) {
            throw new Error("No chat history available for this chat");
        }

        const tools = getAvailableToolsForChat(enabled_tools);

        // Merge SimpleTools definitions
        const simpleConfig = simpleTools.loadConfig();
        const simpleDefs = simpleTools.getToolDefinitions();
        for (const def of simpleDefs) {
            if (simpleTools.isToolEnabled(def.name, simpleConfig)) {
                tools.push({
                    type: 'function',
                    function: {
                        name: def.name,
                        description: def.description,
                        parameters: def.input_schema
                    }
                });
            }
        }

        const requestId = request_id || 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        log(`[CHAT] Using request ID: ${requestId} (provided: ${!!request_id})`);
        initializeToolEvents(requestId);

        await handleChatWithTools(
            req,
            res,
            messages,
            tools,
            chat_id,
            null,  // debugData — no longer accumulates state
            1,
            requestId,
            null,
            parent_turn_id,
            turn_id
        );
    } catch (error) {
        log("[CHAT] Error:", error);

        const turnInfo = getTurnInfo(parent_turn_id, turn_id);
        if (chat_id) {
            const currentTurn = getCurrentTurnNumber(chat_id) + 1;
            const errorMessage = {
                role: "assistant",
                content: ""
            };
            saveMessage(chat_id, errorMessage, currentTurn, "processing_error", turnInfo)
                .then(async () => {
                    // Append error to responses array in turn_debug
                    if (turnInfo) {
                        try {
                            await pushTurnError(chat_id, turnInfo, {
                                content: "",
                                toolCalls: [],
                                hasToolCalls: false,
                                status: null,
                                rawBody: ""
                            }, { type: "processing_error", message: error.message });
                        } catch (debugError) {
                            log(`[ERROR-HANDLING] Failed to save processing error debug data: ${debugError.message}`);
                        }
                    }
                    incrementTurnNumber(chat_id);
                    log(`[ERROR-HANDLING] Saved processing error and burned turn ${currentTurn}`);
                })
                .catch((saveError) => {
                    log(`[ERROR-HANDLING] Failed to save processing error: ${saveError.message}`);
                });
        }

        if (!res.headersSent) {
            res.setHeader("X-Stream-Error", "processing_error");
            if (turnInfo?.turn_id) res.setHeader("X-Response-Turn-Id", turnInfo.turn_id);
            if (turnInfo?.parent_turn_id) res.setHeader("X-Response-Parent-Turn-Id", turnInfo.parent_turn_id);
            res.status(500).json({ error: error.message });
        } else {
            res.write(`\n[ERROR] ${error.message}`);
            res.end();
        }
    }
}

module.exports = {
    handleChatWithTools,
    cancelInFlightRequest,
    executeToolCallsAndContinue,
    processChatRequest
};
