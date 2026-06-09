// Simple Chat Mode - Direct streaming chat

async function attachRequestDebugPanel(requestTurnNumber, requestDebugData) {
    const requestMessages = turnsContainer.querySelectorAll('.turn.request-turn, .message.user');
    const lastRequestMessage = requestMessages[requestMessages.length - 1];
    if (!lastRequestMessage) return;

    const messageId = lastRequestMessage.dataset.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    lastRequestMessage.dataset.messageId = messageId;

    const existingDebug = lastRequestMessage.querySelector('.debug-panel-container');
    const existingToggle = lastRequestMessage.querySelector('.debug-toggle');
    if (existingDebug) existingDebug.remove();
    if (existingToggle) existingToggle.remove();

    lastRequestMessage.classList.add('has-debug');

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
        const debugPanel = lastRequestMessage.querySelector('.debug-panel-container');
        if (debugPanel) {
            const isHidden = debugPanel.style.display === 'none';
            debugPanel.style.display = isHidden ? 'block' : 'none';
            debugToggle.innerHTML = isHidden ? '−' : '+';
            debugToggle.classList.toggle('active', isHidden);
        }
    });

    lastRequestMessage.appendChild(debugToggle);

    const debugPanel = createDebugPanel(lastRequestMessage, messageId, requestDebugData, requestTurnNumber);
    lastRequestMessage.appendChild(debugPanel);
}



function updateChatTitleFromMessage(message) {
    const currentTitle = document.getElementById('chatTitle').textContent;
    if (currentTitle === 'New Chat' || currentTitle === 'Chat') {
        const titleFromMessage = getTextContent(message);
        const shortTitle = titleFromMessage.length > 30 ? titleFromMessage.substring(0, 30) + '...' : titleFromMessage;
        updateChatTitle(shortTitle);
    }
}

// Render-only error handler for the simple-chat flow. The backend owns
// the save for all error types (response row + optional system message),
// so this function just renders the in-memory state (partial streamed
// content + an error block + a system message when partial content
// exists) so the user sees something while the request wraps up. The
// saved rows on the backend are the source of truth on reload.
//
//   errorType          - "user_stopped" | "api_error" | "connection_error" | "processing_error"
//   processor          - the streaming processor (may be null/undefined for
//                        non-stream errors). Provides the partial content
//                        for the user-stop and mid-stream connection_error
//                        cases.
//   requestTurnInfo    - the request's saved turn info (used as parent for
//                        the response turn).
//   savedResponseTurn  - {turn_id, parent_turn_id} from the response
//                        headers, when available. For api/connection/
//                        processing errors this is what the backend saved
//                        under. For user_stopped this is null (headers
//                        weren't read).
//   requestTurnNumber  - turn number of the request turn.
//   message            - the original request message (for chat preview/title
//                        updates).
//   errorText          - the actual error text. Stored in debug_data and
//                        shown in the dropdown.
async function handleSimpleChatError({ errorType, processor, requestTurnInfo, savedResponseTurn, requestTurnNumber, message, errorText = "" }) {
    const resolvedErrorText = errorText
        || (errorType === "user_stopped" ? "Generation stopped by user." : "")
        || `Error: ${errorType}`;

    logger.error(`Simple chat failed (${errorType}): ${resolvedErrorText}`);

    const partialContent = (processor && typeof processor.getRawContent === "function")
        ? (processor.getRawContent() || "")
        : "";
    const responseTurnNumber = requestTurnNumber + 1;

    if (processor && typeof processor.finalize === "function") {
        processor.finalize();
    }

    const debugData = { error: { type: errorType, message: resolvedErrorText } };

    const errorMessage = new Message({
        id: null,
        role: "assistant",
        content: partialContent,
        turn_number: responseTurnNumber,
        turn_id: savedResponseTurn?.turn_id || null,
        parent_turn_id: savedResponseTurn?.parent_turn_id || null,
        error_state: errorType,
        debug_data: debugData,
        edit_count: 0,
    });

    const turnMessages = [errorMessage];
    if (partialContent.trim() !== "") {
        const systemMessage = new Message({
            id: null,
            role: "system",
            content: defaultErrorBlockContent(errorType),
            turn_number: responseTurnNumber,
            turn_id: savedResponseTurn?.turn_id || null,
            parent_turn_id: savedResponseTurn?.parent_turn_id || null,
            error_state: null,
            debug_data: null,
            edit_count: 0,
        });
        turnMessages.push(systemMessage);
    }

    const errorTurn = new Turn(
        responseTurnNumber,
        turnMessages,
        savedResponseTurn?.turn_id || null,
        savedResponseTurn?.parent_turn_id || null
    );
    chatRenderer.renderTurn(errorTurn.renderable(), true);

    updateChatPreview(currentChatId, partialContent);
    updateChatTitleFromMessage(message);
}

async function handleSimpleChat(message, conversationHistory, parentTurnId = null) {
    logger.info('Starting simple chat');

    const requestTurnNumber = getNextTurnNumber();
    const inputMethod = 'manual';
    let savedRequestDebugData = null;

    try {
        await sendAndStream({
            requestTurnNumber,
            parentTurnId,
            turnId: null,
            inputMethod,

            saveRequestMessage: async () => {
                const messageForSaving = { role: 'user', content: message };
                if (Array.isArray(message)) {
                    const filesPart = message.find(part => part.type === 'files');
                    if (filesPart && filesPart.files) {
                        messageForSaving.original_content = message;
                        messageForSaving.file_metadata = {
                            hasFiles: true,
                            fileCount: filesPart.files.length,
                            imageCount: message.filter(part => part.type === 'image').length,
                            files: filesPart.files,
                        };
                    }
                }
                // Pass the active terminal as parent_turn_id so the new turn
                // continues the current branch (null only for a fresh chat).
                const saveResult = await saveCompleteMessage(
                    currentChatId, messageForSaving, requestTurnNumber,
                    parentTurnId ? { parent_turn_id: parentTurnId } : null
                );
                // A failed save is a hard error — throw to abort before the request.
                if (!saveResult || !saveResult.turn_id) {
                    throw new Error('saveCompleteMessage returned no turn_id; cannot proceed without lineage anchor');
                }
                return { turn_id: saveResult.turn_id, parent_turn_id: saveResult.parent_turn_id };
            },

            renderRequestTurn: async (requestTurnInfo, requestId) => {
                if (!requestTurnInfo) return;

                // Pass turn_id and parent_turn_id to the Message constructor up front.
                const requestMessage = new Message({
                    id: null,
                    role: 'user',
                    content: message,
                    turn_number: requestTurnNumber,
                    turn_id: requestTurnInfo.turn_id,
                    parent_turn_id: requestTurnInfo.parent_turn_id,
                    edit_count: 0,
                });

                const requestTurn = new Turn(requestTurnNumber, [requestMessage], requestTurnInfo.turn_id, requestTurnInfo.parent_turn_id);
                const rto = requestTurn.renderable();
                chatRenderer.renderTurn(rto, true);

                // Extract turnMessages from RTO for the debug panel
                const turnMessages = rto.turnMessages || [{ role: 'user', content: message }];

                // Store requestId and turnMessages so onResponseRendered can fetch the debug data later
                savedRequestDebugData = { _requestId: requestId, _turnId: requestTurnInfo.turn_id, _turnMessages: turnMessages };
            },

            onResponseRendered: async ({ processor, debugDataAll }) => {
                const responseContent = processor.getRawContent() || '';
                updateChatPreview(currentChatId, responseContent);
                updateChatTitleFromMessage(message);

                // Fetch request debug data now that backend has finished processing
                try {
                    const turnId = savedRequestDebugData?._turnId;
                    const turnMessages = savedRequestDebugData?._turnMessages;
                    if (turnId) {
                        const debugResponse = await fetch(`${window.location.origin}/api/debug/turn/${currentChatId}/${turnId}`);
                        if (debugResponse.ok) {
                            const allDebugData = await debugResponse.json();
                            const requestEntry = allDebugData.find(d => d.sequence);
                            if (requestEntry) {
                                requestEntry.turnMessages = turnMessages;
                                savedRequestDebugData = requestEntry;
                                // Re-attach the debug panel with proper data
                                attachRequestDebugPanel(requestTurnNumber, userEntry);
                            }
                        }
                    }
                } catch (error) {
                    logger.warn('Failed to fetch request debug data:', error);
                }
            },

            onError: (error, processor, requestTurnInfo, savedResponseTurn) => {
                const errorType = error.name === 'AbortError'
                    ? 'user_stopped'
                    : (error.streamErrorType || 'api_error');
                const errorText = error.errorText
                    || (error.name === 'AbortError' ? 'Generation stopped by user.' : '')
                    || error.message
                    || '';
                handleSimpleChatError({
                    errorType,
                    processor,
                    requestTurnInfo,
                    savedResponseTurn,
                    requestTurnNumber,
                    message,
                    errorText
                });
            },
        });

        logger.info('Simple chat completed successfully');
    } catch (error) {
        // onError callback already handled partial/error rendering. Re-throw
        // only if the user wants to see the error in the console.
        logger.debug('[SIMPLE-CHAT] Error caught at outer level:', error);
    }
}
