// Chat Stream Service - Streaming request orchestration, cancellation, and tool execution continuation.
// Handles the full lifecycle of an AI provider streaming response.

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { log } = require("../utils/logger");
const { getCurrentSettings } = require("./settingsService");
const { executeMCPTool, getAvailableToolsForChat } = require("./mcpService");
const { addToolEvent, storeDebugData } = require("./toolEventService");
const { saveMessage, saveTurnDebugData, getTurnDebugData } = require("./messageRepository");
const { incrementTurnNumber, getTurnInfo, getCurrentTurnNumber } = require("./turnService");
const { buildSystemMessageIfEnabled } = require("./systemPromptService");
const responseAdapterFactory = require("../adapters/ResponseAdapterFactory");
const UnifiedResponse = require("../adapters/UnifiedResponse");

// In-flight chat requests, keyed by requestId.
const inFlightRequests = new Map();

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

    const streamedSoFar = (state.collectedDebugData && state.collectedDebugData.streamedContent) || "";
    const errorMessage = {
        role: "assistant",
        content: streamedSoFar,
        debug_data: {
            error: { type: "user_stopped", message: "Generation stopped by user." }
        }
    };
    saveMessage(state.chatId, errorMessage, state.currentTurn, "user_stopped", state.turnInfo)
        .then(async () => {
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

    // Set up tool event emitter for the adapter
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

    // Initialize debug data and turn number
    let collectedDebugData = existingDebugData;

    // Use the user turn number provided by frontend
    let currentTurn;
    if (collectedDebugData && collectedDebugData.currentTurn) {
        currentTurn = collectedDebugData.currentTurn;
    } else {
        currentTurn = chatId ? getCurrentTurnNumber(chatId) + 1 : 1;
    }

    // Calculate next sequence step from existing debug data
    let sequenceStep = 1;
    if (collectedDebugData) {
        const sequenceCount =
            collectedDebugData.sequence && Array.isArray(collectedDebugData.sequence)
                ? collectedDebugData.sequence.length
                : 0;
        const httpSequenceCount =
            collectedDebugData.httpSequence && Array.isArray(collectedDebugData.httpSequence)
                ? collectedDebugData.httpSequence.length
                : 0;
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
        collectedDebugData.currentTurn = currentTurn;
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

    // Store the REAL request data in the user's debug data
    if (chatId && currentTurn) {
        try {
            const userDebugData = getTurnDebugData(chatId, currentTurn);

            if (userDebugData) {
                userDebugData.actualHttpRequest = {
                    url: targetUrl,
                    method: "POST",
                    headers: { ...headers },
                    body: requestData
                };

                saveTurnDebugData(chatId, currentTurn, userDebugData);
            } else {
                log("[DEBUG-STORE] FAIL - No user debug data found");
            }
        } catch (error) {
            log("[DEBUG-STORE] ERROR:", error.message);
        }
    } else {
        log("[DEBUG-STORE] SKIP - Missing chatId or currentTurn");
    }

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

    // Register the in-flight state
    const inFlightState = {
        apiReq: null,
        chatId,
        currentTurn,
        turnInfo,
        collectedDebugData,
        cancelledByUser: false,
        saved: false,
        destroyWhenCreated: false
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
        const streamedSoFar = (collectedDebugData && collectedDebugData.streamedContent) || "";
        const errorMessage = {
            role: "assistant",
            content: streamedSoFar,
            debug_data: {
                ...(collectedDebugData || {}),
                error: { type: "connection_error", message: "Client disconnected" }
            }
        };
        saveMessage(chatId, errorMessage, currentTurn, "connection_error", turnInfo)
            .then(async () => {
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
        // Capture debug data
        if (collectedDebugData && collectedDebugData.rawData) {
            collectedDebugData.rawData.httpResponse = {
                statusCode: apiRes.statusCode,
                statusMessage: apiRes.statusMessage,
                headers: apiRes.headers
            };
        }

        if (apiRes.statusCode !== 200) {
            let errorData = "";
            apiRes.on("data", (chunk) => {
                errorData += chunk.toString();
            });
            apiRes.on("end", () => {
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Status:`, apiRes.statusCode);
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Response:`, errorData);
                if (collectedDebugData && collectedDebugData.rawData && collectedDebugData.rawData.errors) {
                    collectedDebugData.rawData.errors.push({ type: "http_error", message: errorData });
                }

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
                    const errorMessage = {
                        role: "assistant",
                        content: "",
                        debug_data: {
                            ...(collectedDebugData || {}),
                            error: {
                                type: "api_error",
                                status_code: apiRes.statusCode,
                                status_message: apiRes.statusMessage,
                                user_message: userErrorMessage,
                                raw_response: errorData
                            }
                        }
                    };
                    saveMessage(chatId, errorMessage, currentTurn, "api_error", turnInfo)
                        .then(() => {
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
                    if (event.type === "tool_call_detected" && requestId) {
                        addToolEvent(requestId, {
                            type: "tool_call_detected",
                            data: {
                                name: event.data.toolName,
                                id: event.data.toolId
                            }
                        });
                        if (DEBUG_ADAPTERS) log(`[ADAPTER-TOOL-EVENT] Tool call detected:`, event.data.toolName);
                    }
                }

                Object.assign(context, result.context);

                // Stream any new content to client
                let newContent = "";
                if (unifiedResponse.content && context.lastContentLength !== unifiedResponse.content.length) {
                    newContent = unifiedResponse.content.slice(context.lastContentLength || 0);
                    if (newContent) {
                        res.write(newContent);
                        context.lastContentLength = unifiedResponse.content.length;

                        if (collectedDebugData) {
                            if (!collectedDebugData.streamedContent) {
                                collectedDebugData.streamedContent = "";
                            }
                            collectedDebugData.streamedContent += newContent;
                        }
                    }
                }

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
                if (collectedDebugData && collectedDebugData.rawData && collectedDebugData.rawData.errors) {
                    collectedDebugData.rawData.errors.push({ type: "processing_error", message: error.message });
                }
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

            // Add response step to debug sequence
            if (collectedDebugData && collectedDebugData.sequence) {
                const responseStep = {
                    type: "response",
                    step: sequenceStep++,
                    timestamp: new Date().toISOString(),
                    data: {
                        raw_http_response: {
                            status: collectedDebugData.rawData.httpResponse.statusCode,
                            provider: adapter.providerName,
                            response_chunks: collectedDebugData.rawResponseChunks || []
                        },
                        content: collectedDebugData.streamedContent || "No content streamed",
                        has_tool_calls: unifiedResponse.hasToolCalls()
                    }
                };
                collectedDebugData.sequence.push(responseStep);
            }

            // Capture complete HTTP response
            if (collectedDebugData && requestId) {
                if (!collectedDebugData.httpSequence) {
                    collectedDebugData.httpSequence = [];
                }

                collectedDebugData.httpSequence.push({
                    type: "http_response",
                    sequence: sequenceStep++,
                    timestamp: new Date().toISOString(),
                    content: unifiedResponse.content || "",
                    toolCalls: unifiedResponse.toolCalls || [],
                    hasToolCalls: unifiedResponse.hasToolCalls()
                });

                log(`[SEQUENTIAL-DEBUG] Captured HTTP response, hasTools: ${unifiedResponse.hasToolCalls()}`);
            }

            // Handle tool calls if any
            if (unifiedResponse.hasToolCalls()) {
                log(`[ADAPTER] Processing ${unifiedResponse.toolCalls.length} tool calls`);

                if (collectedDebugData && collectedDebugData.sequence) {
                    for (const toolCall of unifiedResponse.toolCalls) {
                        collectedDebugData.sequence.push({
                            type: "tool_execution",
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

                await executeToolCallsAndContinue(
                    req,
                    res,
                    unifiedResponse.toolCalls,
                    messages,
                    tools,
                    chatId,
                    unifiedResponse.content,
                    collectedDebugData,
                    responseCounter,
                    requestId,
                    turnInfo
                );
            } else {
                // No tool calls, finish response
                res.end();

                // Increment turn number now that conversation is complete
                if (chatId) {
                    incrementTurnNumber(chatId);
                }

                // Save final assistant response to history
                if (chatId && unifiedResponse.content) {
                    log(`[CHAT-SAVE] About to save final assistant response:`);
                    log(`[CHAT-SAVE] Content length: ${unifiedResponse.content.length}`);
                    log(`[CHAT-SAVE] Content preview: "${unifiedResponse.content.substring(0, 200)}..."`);
                    log(`[CHAT-SAVE] Turn number: ${currentTurn}`);

                    const finalResponseMessage = {
                        role: "assistant",
                        content: unifiedResponse.content
                    };
                    try {
                        await saveMessage(chatId, finalResponseMessage, currentTurn, null, turnInfo);
                        log(`[CHAT-SAVE] Successfully saved final response to history`);
                    } catch (error) {
                        log(`[CHAT-SAVE] Error saving final response: ${error.message}`);
                    }
                } else {
                    log(
                        `[CHAT-SAVE] NOT saving final response - chatId: ${chatId}, content length: ${unifiedResponse.content ? unifiedResponse.content.length : "null"}`
                    );
                }

                // Store debug data with complete history
                if (collectedDebugData && requestId) {
                    if (chatId) {
                        try {
                            const { getChatHistoryForAPI } = require('./messageRepository');
                            collectedDebugData.completeMessageHistory = getChatHistoryForAPI(chatId);
                            const { getCurrentTurnNumber } = require('./turnService');
                            collectedDebugData.currentTurnNumber = getCurrentTurnNumber(chatId);
                            collectedDebugData.currentTurnMessages = null;
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

    apiReq.on("error", (error) => {
        log(`[${adapter.providerName.toUpperCase()}] Request error:`, error);
        if (collectedDebugData && collectedDebugData.rawData && collectedDebugData.rawData.errors) {
            collectedDebugData.rawData.errors.push({ type: "request_error", message: error.message });
        }

        if (inFlightState.saved) {
            return;
        }
        inFlightState.saved = true;
        if (requestId) inFlightRequests.delete(requestId);

        if (chatId && currentTurn) {
            const streamedSoFar = (collectedDebugData && collectedDebugData.streamedContent) || "";
            const errorMessage = {
                role: "assistant",
                content: streamedSoFar,
                debug_data: {
                    ...(collectedDebugData || {}),
                    error: { type: "connection_error", message: error.message }
                }
            };
            saveMessage(chatId, errorMessage, currentTurn, "connection_error", turnInfo)
                .then(async () => {
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

    // Capture ACTUAL HTTP request payload being sent
    const actualRequestPayload = JSON.stringify(requestData);

    // Add to sequential debug data
    if (collectedDebugData && requestId) {
        if (!collectedDebugData.httpSequence) {
            collectedDebugData.httpSequence = [];
        }

        if (collectedDebugData.httpSequence.length > 0 || responseCounter > 1) {
            const requestSequenceNumber = sequenceStep++;

            collectedDebugData.httpSequence.push({
                type: "http_request",
                sequence: requestSequenceNumber,
                timestamp: new Date().toISOString(),
                payload: JSON.parse(actualRequestPayload),
                rawPayload: actualRequestPayload
            });
        } else {
            log(`[SEQUENTIAL-DEBUG] Skipping first HTTP request debug - already captured in user phase`);
        }
    }

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
    debugData,
    responseCounter,
    requestId,
    turnInfo = null
) {
    const currentTurn = debugData && debugData.currentTurn ? debugData.currentTurn : 1;

    // Add assistant message with tool calls to conversation
    const assistantMessageWithTools = {
        role: "assistant",
        content: assistantMessage || "",
        tool_calls: toolCalls
    };
    messages.push(assistantMessageWithTools);

    // Save assistant message with tool calls to database
    if (chatId) {
        await saveMessage(chatId, assistantMessageWithTools, currentTurn, null, turnInfo);
        log(`[CHAT-SAVE] Saved response message with ${toolCalls.length} tool calls`);
    }

    // Execute each tool call
    for (const toolCall of toolCalls) {
        log(`[TOOL-EXECUTION] Executing tool: ${toolCall.function.name}`);

        if (requestId) {
            addToolEvent(requestId, {
                type: "tool_execution_start",
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

            if (requestId) {
                addToolEvent(requestId, {
                    type: "tool_execution_complete",
                    data: {
                        name: toolCall.function.name,
                        id: toolCall.id,
                        status: "success",
                        result: toolResult
                    }
                });
            }

            // Add tool result to debug sequence
            if (debugData && debugData.sequence) {
                const sequenceCount = debugData.sequence.length;
                const httpSequenceCount = debugData.httpSequence ? debugData.httpSequence.length : 0;
                const nextStep = sequenceCount + httpSequenceCount + 1;

                debugData.sequence.push({
                    type: "tool_result",
                    step: nextStep,
                    timestamp: new Date().toISOString(),
                    data: {
                        tool_name: toolCall.function.name,
                        tool_id: toolCall.id,
                        status: "success",
                        result: toolResult
                    }
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

            if (requestId) {
                addToolEvent(requestId, {
                    type: "tool_execution_complete",
                    data: {
                        name: toolCall.function.name,
                        id: toolCall.id,
                        status: "error",
                        error: error.message
                    }
                });
            }

            // Add tool error to debug sequence
            if (debugData && debugData.sequence) {
                const sequenceCount = debugData.sequence.length;
                const httpSequenceCount = debugData.httpSequence ? debugData.httpSequence.length : 0;
                const nextStep = sequenceCount + httpSequenceCount + 1;

                debugData.sequence.push({
                    type: "tool_result",
                    step: nextStep,
                    timestamp: new Date().toISOString(),
                    data: {
                        tool_name: toolCall.function.name,
                        tool_id: toolCall.id,
                        status: "error",
                        error: error.message
                    }
                });
            }
        }
    }

    // Continue conversation with tool results
    await handleChatWithTools(
        req,
        res,
        messages,
        tools,
        chatId,
        debugData,
        responseCounter + 1,
        requestId,
        debugData,
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

        const currentSettings = getCurrentSettings();
        const debugData = {
            requestStart: Date.now(),
            endpoint: "will_be_set_by_adapter",
            settings: currentSettings,
            toolsEnabled: tools.length
        };

        const { generateRequestId, initializeToolEvents } = require("./toolEventService");
        const requestId = request_id || generateRequestId();

        log(`[CHAT] Using request ID: ${requestId} (provided: ${!!request_id})`);

        initializeToolEvents(requestId);

        await handleChatWithTools(
            req,
            res,
            messages,
            tools,
            chat_id,
            debugData,
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
                content: "",
                debug_data: {
                    error: {
                        type: "processing_error",
                        message: error.message,
                        stack: error.stack
                    }
                }
            };
            saveMessage(chat_id, errorMessage, currentTurn, "processing_error", turnInfo)
                .then(() => {
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
