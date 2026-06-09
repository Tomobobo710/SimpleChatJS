// sendAndStream - unified orchestration for send / retry / edit-retry
//
// All three flows (normal send, assistant retry, edit-and-retry) funnel
// through sendAndStream. The variations between them are passed in as
// arguments and callbacks, not duplicated in the call sites.

function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Remove DOM turns whose data-turn-number is >= the given threshold.
function truncateTurnsInContainer(container, fromTurnNumber) {
    if (fromTurnNumber == null || !container) return;
    const allTurns = container.querySelectorAll(".turn");
    for (let i = allTurns.length - 1; i >= 0; i--) {
        const turn = allTurns[i];
        if (parseInt(turn.dataset.turnNumber) >= fromTurnNumber) {
            turn.remove();
        }
    }
}

// Stream the response turn, render the turn with the right turn
// info, and save debug data. Returns the saved response turn info.
// On error, calls onError(error, processor, requestTurnInfo, savedResponseTurn)
// before re-throwing. savedResponseTurn is passed for backend errors
// (so the handler knows the backend already saved the error message and
// doesn't need to re-save).
async function streamAndRenderResponse({
    fetchPromise,
    requestId,
    requestTurnInfo,
    container,
    requestTurnNumber,
    inputMethod,
    onError = null
}) {
    const processor = new StreamingMessageProcessor();
    const tempContainer = document.createElement("div");
    tempContainer.style.width = "100%";
    tempContainer.style.boxSizing = "border-box";
    const liveRenderer = new ChatRenderer(tempContainer);

    const responseTurnDiv = document.createElement("div");
    responseTurnDiv.className = "turn assistant-turn";
    responseTurnDiv.innerHTML = "";
    container.appendChild(responseTurnDiv);
    responseTurnDiv.appendChild(tempContainer);

    let toolEventSource = null;
    try {
        toolEventSource = new EventSource(`${window.location.origin}/api/tools/${requestId}`);
        toolEventSource.onmessage = (event) => {
            try {
                const toolEvent = JSON.parse(event.data);
                processor.handleToolEvent(toolEvent);
                updateLiveRendering(processor, liveRenderer, tempContainer);
            } catch (parseError) {
                logger.warn("Failed to parse tool event:", parseError);
            }
        };
        toolEventSource.onerror = () => {
            // Errors are normal at stream end; logged at higher verbosity if needed
        };
    } catch (error) {
        logger.warn("Failed to connect to tool events:", error);
    }

    let savedResponseTurn = null;
    let errorAlreadyHandled = false;

    async function drainBodyForError(response) {
        let text = "";
        try {
            text = await response.text();
        } catch (_) {}
        if (!text) return "";
        try {
            const json = JSON.parse(text);
            return json.error || json.message || text;
        } catch (_) {
            return text;
        }
    }

    function fireError(err) {
        errorAlreadyHandled = true;
        if (toolEventSource) {
            toolEventSource.close();
        }
        tempContainer.remove();
        responseTurnDiv.remove();
        if (onError) {
            try {
                onError(err, processor, requestTurnInfo, savedResponseTurn);
            } catch (handlerError) {
                logger.error("onError handler threw:", handlerError);
            }
        }
    }

    try {
        const response = await fetchPromise;

        if (!response.ok) {
            const errorText = await drainBodyForError(response);
            const err = new Error(errorText || `HTTP ${response.status}`);
            err.streamErrorType = "api_error";
            err.errorText = errorText || `HTTP ${response.status}`;
            err.httpStatus = response.status;
            fireError(err);
            throw err;
        }

        const responseTurnId = response.headers.get("X-Response-Turn-Id");
        const responseParentTurnId = response.headers.get("X-Response-Parent-Turn-Id");
        if (!responseTurnId || !responseParentTurnId) {
            const errorText = await drainBodyForError(response);
            const err = new Error(errorText || "Backend did not emit required response-turn headers");
            err.streamErrorType = "api_error";
            err.errorText = errorText || "Backend did not emit required response-turn headers";
            fireError(err);
            throw err;
        }
        savedResponseTurn = {
            turn_id: responseTurnId,
            parent_turn_id: responseParentTurnId
        };

        const streamErrorType = response.headers.get("X-Stream-Error");
        if (streamErrorType) {
            const errorText = await drainBodyForError(response);
            const streamError = new Error(errorText || `Backend stream error: ${streamErrorType}`);
            streamError.streamErrorType = streamErrorType;
            streamError.errorText = errorText;
            fireError(streamError);
            throw streamError;
        }

        for await (const chunk of streamResponse(response)) {
            processor.addChunk(chunk);
            updateLiveRendering(processor, liveRenderer, tempContainer);
            if (typeof smartScrollToBottom === "function") {
                smartScrollToBottom(scrollContainer);
            }
        }

        if (toolEventSource) {
            toolEventSource.close();
        }

        processor.finalize();

        // Fetch all debug data for messages in this turn from the DB
        let debugDataAll = null;
        try {
            const turnId = savedResponseTurn?.turn_id || null;
            if (turnId) {
                const turnDebugResponse = await fetch(`${window.location.origin}/api/debug/turn/${currentChatId}/${turnId}`);
                if (turnDebugResponse.ok) {
                    debugDataAll = await turnDebugResponse.json();
                }
            }
        } catch (error) {
            logger.warn("Failed to fetch turn debug data:", error);
        }

        const dropdownStates = {};
        const streamingDropdowns = tempContainer.querySelectorAll(".streaming-dropdown");
        let thinkingIndex = 0;
        let toolIndex = 0;
        streamingDropdowns.forEach((streamingDropdown) => {
            const instance = streamingDropdown._streamingDropdownInstance;
            if (instance) {
                let stateKey;
                if (instance.type === "thinking") {
                    stateKey = "thinking_" + thinkingIndex;
                    thinkingIndex++;
                } else if (instance.type === "tool") {
                    stateKey = "tool_" + toolIndex;
                    toolIndex++;
                }
                if (stateKey) {
                    dropdownStates[stateKey] = !instance.isCollapsed;
                }
            }
        });

        tempContainer.remove();
        responseTurnDiv.remove();

        const responseTurnNumber = requestTurnNumber + 1;
        // Set currentTurnNumber on all entries
        if (debugDataAll && Array.isArray(debugDataAll)) {
            for (const d of debugDataAll) {
                d.currentTurnNumber = responseTurnNumber;
            }
        }

        const rto = RenderableTurnObject.fromStreamingProcessor({
            processor,
            turnNumber: responseTurnNumber,
            turnId: savedResponseTurn?.turn_id || null,
            parentTurnId: savedResponseTurn?.parent_turn_id || null,
            debugDataAll,
            dropdownStates
        });

        chatRenderer.renderTurn(rto, true);

        return { savedResponseTurn, debugDataAll, processor };
    } catch (error) {
        if (!errorAlreadyHandled) {
            if (toolEventSource) {
                toolEventSource.close();
            }
            tempContainer.remove();
            responseTurnDiv.remove();
            if (onError) {
                try {
                    onError(error, processor, requestTurnInfo, savedResponseTurn);
                } catch (handlerError) {
                    logger.error("onError handler threw:", handlerError);
                }
            }
        }
        throw error;
    }
}

// Top-level unified helper. All three flows call this with the variations
// passed in as arguments / callbacks.
async function sendAndStream({
    requestTurnNumber,
    parentTurnId = null,
    turnId = null,

    // Optional: persist the request message. Returns { turn_id, parent_turn_id } | null.
    saveRequestMessage = null,

    // Optional: render the request turn. Receives the request turn info and the requestId.
    renderRequestTurn = null,

    // Optional: remove DOM turns with turnNumber >= this value before initiating.
    truncateFromTurnNumber = null,
    truncateContainer = null,

    // Optional: hook called after the response is rendered, with its turn info.
    onResponseRendered = null,

    // Optional: hook called when the stream errors out (after cleanup). Receives
    // the error, the streaming processor (so callers can render a partial
    // message on AbortError), and the requestTurnInfo if the request message was saved.
    onError = null,

    inputMethod = "manual"
}) {
    // Generate requestId early so request-side callbacks can include it in debug data.
    const requestId = generateRequestId();

    let requestTurnInfo = null;

    if (saveRequestMessage) {
        // Throw on failed request save — a hard error that aborts the request.
        requestTurnInfo = await saveRequestMessage(requestId);
    }

    // Truncate BEFORE rendering the new request turn so the new turn (which
    // shares the same turn_number as the truncated turns) is not removed.
    if (truncateFromTurnNumber != null) {
        truncateTurnsInContainer(truncateContainer, truncateFromTurnNumber);
    }

    if (renderRequestTurn) {
        try {
            await renderRequestTurn(requestTurnInfo, requestId);
        } catch (error) {
            logger.warn(`[${inputMethod.toUpperCase()}] Failed to render request turn:`, error);
        }
    }

    await loadEnabledToolsFromBackend();
    const enabledToolsFlags = loadEnabledTools();

    // For flows that saved a request message, derive the request's turn
    // identifiers from the saved request turn. Retry flows (no save) pass
    // parentTurnId/turnId explicitly and requestTurnInfo is null.
    // The request turn's turn_id is used as the history lineage anchor (where the
    // edited message was saved). The parent_turn_id is used for structural
    // lineage of the new response turn.
    const effectiveParentTurnId = requestTurnInfo ? requestTurnInfo.parent_turn_id : parentTurnId;
    const effectiveTurnId = requestTurnInfo ? requestTurnInfo.turn_id : turnId;
    const effectiveHistoryAnchor = requestTurnInfo ? requestTurnInfo.turn_id : parentTurnId;

    const requestInfo = initiateMessageRequest(
        enabledToolsFlags,
        requestId,
        effectiveParentTurnId,
        effectiveTurnId,
        effectiveHistoryAnchor
    );

    // For pure retry (no request save), requestTurnInfo is still needed for the
    // response lookup; the retry caller passes the parent turn id via
    // turnId, so synthesize a requestTurnInfo.
    const effectiveRequestTurnInfo =
        requestTurnInfo || (inputMethod === "retry" && turnId ? { turn_id: turnId, parent_turn_id: parentTurnId } : null);

    const container = truncateContainer || turnsContainer;
   const { savedResponseTurn, debugDataAll, processor } = await streamAndRenderResponse({
        fetchPromise: requestInfo.fetchPromise,
        requestId,
        requestTurnInfo: effectiveRequestTurnInfo,
        container,
        requestTurnNumber,
        inputMethod,
        onError
    });

    const responseTurnInfo = savedResponseTurn
        ? { turn_id: savedResponseTurn.turn_id, parent_turn_id: savedResponseTurn.parent_turn_id }
        : null;

    if (onResponseRendered) {
        try {
            await onResponseRendered({
                requestTurnInfo,
                responseTurnInfo,
                requestId,
                debugDataAll,
                processor
            });
        } catch (error) {
            logger.warn(`[${inputMethod.toUpperCase()}] onResponseRendered failed:`, error);
        }
    }

    // No post-render branch-nav sweep needed — renderTurn updates
    // branch-nav per-turn.

    return { requestTurnInfo, responseTurnInfo, requestId };
}
