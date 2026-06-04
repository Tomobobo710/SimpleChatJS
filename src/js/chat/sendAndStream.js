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
    const allTurns = container.querySelectorAll('.turn');
    for (let i = allTurns.length - 1; i >= 0; i--) {
        const turn = allTurns[i];
        if (parseInt(turn.dataset.turnNumber) >= fromTurnNumber) {
            turn.remove();
        }
    }
}

// Stream the assistant response, render the bubble with the right turn
// info, and save debug data. Returns the saved assistant's turn info.
// On error, calls onError(error, processor) before re-throwing.
async function streamAndRenderAssistant({
    fetchPromise,
    requestId,
    userTurnInfo,
    container,
    userTurnNumber,
    inputMethod,
    onError = null,
}) {
    const processor = new StreamingMessageProcessor();
    const tempContainer = document.createElement('div');
    tempContainer.style.width = '100%';
    tempContainer.style.boxSizing = 'border-box';
    const liveRenderer = new ChatRenderer(tempContainer);

    const assistantTurnDiv = document.createElement('div');
    assistantTurnDiv.className = 'turn assistant-turn';
    assistantTurnDiv.innerHTML = '';
    container.appendChild(assistantTurnDiv);
    assistantTurnDiv.appendChild(tempContainer);

    let toolEventSource = null;
    try {
        toolEventSource = new EventSource(`${window.location.origin}/api/tools/${requestId}`);
        toolEventSource.onmessage = (event) => {
            try {
                const toolEvent = JSON.parse(event.data);
                processor.handleToolEvent(toolEvent);
                updateLiveRendering(processor, liveRenderer, tempContainer);
            } catch (parseError) {
                logger.warn('Failed to parse tool event:', parseError);
            }
        };
        toolEventSource.onerror = () => {
            // Errors are normal at stream end; logged at higher verbosity if needed
        };
    } catch (error) {
        logger.warn('Failed to connect to tool events:', error);
    }

    try {
        const response = await fetchPromise;

        for await (const chunk of streamResponse(response)) {
            processor.addChunk(chunk);
            updateLiveRendering(processor, liveRenderer, tempContainer);
            if (typeof smartScrollToBottom === 'function') {
                smartScrollToBottom(scrollContainer);
            }
        }

        if (toolEventSource) {
            toolEventSource.close();
        }

        processor.finalize();

        let debugData = null;
        try {
            const debugResponse = await fetch(`${window.location.origin}/api/debug/${requestId}`);
            if (debugResponse.ok) {
                const rawDebugData = await debugResponse.json();
                if (rawDebugData.sequence) {
                    debugData = rawDebugData;
                }
            }
        } catch (error) {
            logger.warn('Failed to fetch debug data:', error);
        }

        const dropdownStates = {};
        const streamingDropdowns = tempContainer.querySelectorAll('.streaming-dropdown');
        let thinkingIndex = 0;
        let toolIndex = 0;
        streamingDropdowns.forEach((streamingDropdown) => {
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

        tempContainer.remove();
        assistantTurnDiv.remove();

        // Look up the just-saved assistant. Use parent_turn_id (stable across
        // turn-number drift); fall back to turn_number if userTurnInfo missing.
        let savedAssistantTurn = null;
        try {
            const history = await getCompleteChatHistory(currentChatId);
            const allMessages = history.messages || [];
            let assistantTurns;
            if (userTurnInfo?.turn_id) {
                assistantTurns = allMessages.filter((msg) =>
                    msg.role === 'assistant' && msg.parent_turn_id === userTurnInfo.turn_id && msg.turn_id
                );
            } else {
                assistantTurns = allMessages.filter((msg) =>
                    msg.role === 'assistant' && msg.turn_number === userTurnNumber && msg.turn_id
                );
            }
            savedAssistantTurn = assistantTurns[assistantTurns.length - 1] || null;
        } catch (error) {
            logger.warn(`[${inputMethod.toUpperCase()}] Failed to load saved assistant turn metadata:`, error);
        }

        const assistantTurnNumber = userTurnNumber + 1;
        if (debugData) {
            debugData.currentTurnNumber = assistantTurnNumber;
        }

        const rto = RenderableTurnObject.fromStreamingProcessor({
            processor,
            turnNumber: assistantTurnNumber,
            turnId: savedAssistantTurn?.turn_id || null,
            parentTurnId: savedAssistantTurn?.parent_turn_id || null,
            debugData,
            dropdownStates,
        });

        chatRenderer.renderTurn(rto, true);

        if (debugData) {
            try {
                debugData.turn_id = savedAssistantTurn?.turn_id || null;
                debugData.parent_turn_id = savedAssistantTurn?.parent_turn_id || null;
                await saveTurnData(currentChatId, savedAssistantTurn?.turn_id, debugData);
                logger.info(`[${inputMethod.toUpperCase()}] Saved assistant debug data for turn_id=${savedAssistantTurn?.turn_id}`);
            } catch (error) {
                logger.warn(`[${inputMethod.toUpperCase()}] Failed to save assistant debug data:`, error);
            }
        }

        return { savedAssistantTurn, debugData, processor };
    } catch (error) {
        if (toolEventSource) {
            toolEventSource.close();
        }
        tempContainer.remove();
        assistantTurnDiv.remove();
        if (onError) {
            try { onError(error, processor); } catch (_) { /* swallow */ }
        }
        throw error;
    }
}

// Top-level unified helper. All three flows call this with the variations
// passed in as arguments / callbacks.
async function sendAndStream({
    userTurnNumber,
    parentTurnId = null,
    turnId = null,
    retriedTurnId = null,

    // Optional: persist the user message. Returns { turn_id, parent_turn_id } | null.
    saveUserMessage = null,

    // Optional: render the user bubble. Receives the user turn info and the requestId.
    renderUserBubble = null,

    // Optional: remove DOM turns with turnNumber >= this value before initiating.
    truncateFromTurnNumber = null,
    truncateContainer = null,

    // Optional: hook called after the assistant is rendered, with its turn info.
    onAssistantRendered = null,

    // Optional: hook called when the stream errors out (after cleanup). Receives
    // the error and the streaming processor (so callers can render a partial
    // message on AbortError).
    onError = null,

    inputMethod = 'manual',
}) {
    // Generate requestId early so user-side callbacks can include it in debug data.
    const requestId = generateRequestId();

    let userTurnInfo = null;

    if (saveUserMessage) {
        try {
            userTurnInfo = await saveUserMessage(requestId);
        } catch (error) {
            logger.warn(`[${inputMethod.toUpperCase()}] Failed to save user message:`, error);
        }
    }

    // Truncate BEFORE rendering the new user bubble so the new bubble (which
    // shares the same turn_number as the truncated turns) is not removed.
    if (truncateFromTurnNumber != null) {
        truncateTurnsInContainer(truncateContainer, truncateFromTurnNumber);
    }

    if (renderUserBubble) {
        try {
            await renderUserBubble(userTurnInfo, requestId);
        } catch (error) {
            logger.warn(`[${inputMethod.toUpperCase()}] Failed to render user bubble:`, error);
        }
    }

    await loadEnabledToolsFromBackend();
    const enabledToolsFlags = loadEnabledTools();

    // For flows that saved a user message, derive the request's turn
    // identifiers from the saved user turn. Retry flows (no save) pass
    // parentTurnId/turnId/retriedTurnId explicitly and userTurnInfo is null.
    const effectiveParentTurnId = userTurnInfo ? userTurnInfo.parent_turn_id : parentTurnId;
    const effectiveTurnId = userTurnInfo ? userTurnInfo.turn_id : turnId;
    const effectiveRetriedTurnId = userTurnInfo ? userTurnInfo.turn_id : retriedTurnId;

    const requestInfo = initiateMessageRequest(
        enabledToolsFlags, requestId,
        effectiveParentTurnId, effectiveTurnId, effectiveRetriedTurnId
    );

    // For pure retry (no user save), userTurnInfo is still needed for the
    // assistant lookup; the retry caller passes the parent user turn id via
    // turnId, so synthesize a userTurnInfo.
    const effectiveUserTurnInfo = userTurnInfo || (
        inputMethod === 'retry' && turnId
            ? { turn_id: turnId, parent_turn_id: parentTurnId }
            : null
    );

    const container = truncateContainer || turnsContainer;
    const { savedAssistantTurn, debugData, processor } = await streamAndRenderAssistant({
        fetchPromise: requestInfo.fetchPromise,
        requestId,
        userTurnInfo: effectiveUserTurnInfo,
        container,
        userTurnNumber,
        inputMethod,
        onError,
    });

    const assistantTurnInfo = savedAssistantTurn
        ? { turn_id: savedAssistantTurn.turn_id, parent_turn_id: savedAssistantTurn.parent_turn_id }
        : null;

    if (onAssistantRendered) {
        try {
            await onAssistantRendered({
                userTurnInfo,
                assistantTurnInfo,
                requestId,
                debugData,
                processor,
            });
        } catch (error) {
            logger.warn(`[${inputMethod.toUpperCase()}] onAssistantRendered failed:`, error);
        }
    }

    if (typeof chatRenderer !== 'undefined' && chatRenderer && chatRenderer.refreshBranchNavigation) {
        setTimeout(async () => {
            await chatRenderer.refreshBranchNavigation();
        }, 100);
    }

    return { userTurnInfo, assistantTurnInfo, requestId };
}
