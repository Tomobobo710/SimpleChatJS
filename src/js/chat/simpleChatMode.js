// Simple Chat Mode - Direct streaming chat

async function attachUserDebugPanel(userTurnNumber, userDebugData) {
    const userMessages = turnsContainer.querySelectorAll('.turn.user-turn, .message.user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    if (!lastUserMessage) return;

    const messageId = lastUserMessage.dataset.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    lastUserMessage.dataset.messageId = messageId;

    const existingDebug = lastUserMessage.querySelector('.debug-panel-container');
    const existingToggle = lastUserMessage.querySelector('.debug-toggle');
    if (existingDebug) existingDebug.remove();
    if (existingToggle) existingToggle.remove();

    lastUserMessage.classList.add('has-debug');

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
        const debugPanel = lastUserMessage.querySelector('.debug-panel-container');
        if (debugPanel) {
            const isHidden = debugPanel.style.display === 'none';
            debugPanel.style.display = isHidden ? 'block' : 'none';
            debugToggle.innerHTML = isHidden ? '−' : '+';
            debugToggle.classList.toggle('active', isHidden);
        }
    });

    lastUserMessage.appendChild(debugToggle);

    const debugPanel = createDebugPanel(lastUserMessage, messageId, userDebugData, userTurnNumber);
    lastUserMessage.appendChild(debugPanel);
}

function buildUserDebugData({ message, userTurnNumber, requestId, conversationHistory, inputMethod, enabledToolsFlags }) {
    return {
        sequence: [
            {
                type: 'user_input',
                step: 1,
                data: {
                    userQuery: {
                        message: message,
                        chat_id: currentChatId,
                        timestamp: new Date().toISOString(),
                        message_length: message.length,
                        turn_number: userTurnNumber,
                    },
                    tools: {
                        total: Object.keys(enabledToolsFlags).length,
                        flags: enabledToolsFlags,
                    },
                    context: {
                        input_method: inputMethod,
                        current_chat: currentChatId,
                    },
                },
                timestamp: new Date().toISOString(),
            },
        ],
        metadata: {
            endpoint: 'user_input',
            timestamp: new Date().toISOString(),
            tools: Object.keys(enabledToolsFlags).length,
        },
        currentTurnNumber: userTurnNumber,
        completeMessageHistory: conversationHistory || [],
        conversationHistory: conversationHistory || [],
    };
}

function addApiRequestToDebugData(userDebugData, { requestId, message, userTurnNumber, enabledToolsFlags }) {
    userDebugData.sequence.push({
        type: 'ai_http_request',
        step: userDebugData.sequence.length + 1,
        timestamp: new Date().toISOString(),
        data: {
            requestId: requestId,
            endpoint: 'chat',
            message: message,
            tools_enabled: Object.keys(enabledToolsFlags).length,
            turn_number: userTurnNumber,
        },
    });
    userDebugData.apiRequest = {
        url: `${window.location.origin}/api/chat`,
        method: 'POST',
        requestId: requestId,
        timestamp: new Date().toISOString(),
    };
}

function updateChatTitleFromMessage(message) {
    const currentTitle = document.getElementById('chatTitle').textContent;
    if (currentTitle === 'New Chat' || currentTitle === 'Chat') {
        const titleFromMessage = getTextContent(message);
        const shortTitle = titleFromMessage.length > 30 ? titleFromMessage.substring(0, 30) + '...' : titleFromMessage;
        updateChatTitle(shortTitle);
    }
}

// Unified error handler for the simple-chat flow. All error sources
// (user-stop, api_error, connection_error, processing_error) funnel
// through here. The data shape and the render path are the same.
//
//   errorType          - "user_stopped" | "api_error" | "connection_error" | "processing_error"
//   processor          - the streaming processor (may be null/undefined for
//                        non-stream errors). Provides the partial content
//                        for the user-stop and mid-stream connection_error
//                        cases.
//   userTurnInfo       - the user's saved turn info (used as parent for
//                        the assistant turn when we have to save here).
//   savedAssistantTurn - {turn_id, parent_turn_id} from the response
//                        headers. For backend errors this is the turn the
//                        backend already saved under. For user-stop this is
//                        the turn the backend WOULD have used, but didn't
//                        actually save (because we aborted before it could).
//   shouldSave         - true if the frontend must save the error message
//                        (user-stop). false if the backend already saved
//                        (api/connection/processing errors).
//   userTurnNumber     - turn number of the user turn.
//   message            - the original user message (for chat preview/title
//                        updates).
//   errorText          - the actual error text (from response body, abort
//                        reason, JS error message, etc.). Stored in
//                        debug_data and shown in the dropdown.
async function handleSimpleChatError({ errorType, processor, userTurnInfo, savedAssistantTurn, shouldSave = false, userTurnNumber, message, errorText = "" }) {
    const resolvedErrorText = errorText
        || (errorType === "user_stopped" ? "Generation stopped by user." : "")
        || `Error: ${errorType}`;

    logger.error(`Simple chat failed (${errorType}): ${resolvedErrorText}`);

    const partialContent = (processor && typeof processor.getRawContent === "function")
        ? (processor.getRawContent() || "")
        : "";
    const assistantTurnNumber = userTurnNumber + 1;

    if (processor && typeof processor.finalize === "function") {
        processor.finalize();
    }

    const debugData = { error: { type: errorType, message: resolvedErrorText } };

    const willSave = shouldSave || !savedAssistantTurn;
    let finalTurnInfo = savedAssistantTurn;
    if (willSave) {
        if (!shouldSave) {
            logger.warn(`No savedAssistantTurn for ${errorType}; falling back to local save`);
        }
        const newTurnId = (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        finalTurnInfo = {
            turn_id: newTurnId,
            parent_turn_id: userTurnInfo?.turn_id || null
        };
        try {
            const saved = await saveCompleteMessage(
                currentChatId,
                { role: "assistant", content: partialContent, error_state: errorType, debug_data: debugData },
                assistantTurnNumber,
                finalTurnInfo
            );
            if (saved) {
                finalTurnInfo = { turn_id: saved.turn_id, parent_turn_id: saved.parent_turn_id };
            }
        } catch (saveError) {
            logger.warn(`Failed to save ${errorType} message:`, saveError);
        }
    }

    const errorMessage = new Message({
        id: null,
        role: "assistant",
        content: partialContent,
        turn_number: assistantTurnNumber,
        turn_id: finalTurnInfo.turn_id,
        parent_turn_id: finalTurnInfo.parent_turn_id,
        error_state: errorType,
        debug_data: debugData,
        edit_count: 0,
    });
    const errorTurn = new Turn(
        assistantTurnNumber,
        [errorMessage],
        finalTurnInfo.turn_id,
        finalTurnInfo.parent_turn_id
    );
    chatRenderer.renderTurn(errorTurn.renderable(), true);

    updateChatPreview(currentChatId, partialContent);
    updateChatTitleFromMessage(message);
}

async function handleSimpleChat(message, conversationHistory, parentTurnId = null) {
    logger.info('Starting simple chat');

    const userTurnNumber = getNextTurnNumber();
    const inputMethod = 'manual';
    let savedUserDebugData = null;

    try {
        await sendAndStream({
            userTurnNumber,
            parentTurnId,
            turnId: null,
            lineageAnchorTurnId: null,
            inputMethod,

            saveUserMessage: async () => {
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
                    currentChatId, messageForSaving, userTurnNumber,
                    parentTurnId ? { parent_turn_id: parentTurnId } : null
                );
                // A failed save is a hard error — throw to abort before the request.
                if (!saveResult || !saveResult.turn_id) {
                    throw new Error('saveCompleteMessage returned no turn_id; cannot proceed without lineage anchor');
                }
                return { turn_id: saveResult.turn_id, parent_turn_id: saveResult.parent_turn_id };
            },

            renderUserBubble: async (userTurnInfo, requestId) => {
                if (!userTurnInfo) return;

                // Pass turn_id and parent_turn_id to the Message constructor up front.
                const userMessage = new Message({
                    id: null,
                    role: 'user',
                    content: message,
                    turn_number: userTurnNumber,
                    turn_id: userTurnInfo.turn_id,
                    parent_turn_id: userTurnInfo.parent_turn_id,
                    edit_count: 0,
                });

                const userTurn = new Turn(userTurnNumber, [userMessage], userTurnInfo.turn_id, userTurnInfo.parent_turn_id);
                chatRenderer.renderTurn(userTurn.renderable(), true);

                const enabledToolsFlags = loadEnabledTools();
                const userDebugData = buildUserDebugData({
                    message,
                    userTurnNumber,
                    requestId,
                    conversationHistory,
                    inputMethod,
                    enabledToolsFlags,
                });
                addApiRequestToDebugData(userDebugData, { requestId, message, userTurnNumber, enabledToolsFlags });
                savedUserDebugData = userDebugData;

                try {
                    await saveTurnData(currentChatId, userTurnInfo.turn_id, userDebugData);
                    logger.info(`[TURN-DEBUG] Saved user debug data for turn_id=${userTurnInfo.turn_id}`);
                } catch (error) {
                    logger.warn('Failed to save user turn debug data:', error);
                }

                attachUserDebugPanel(userTurnNumber, userDebugData);
            },

            onAssistantRendered: async ({ processor }) => {
                const assistantContent = processor.getRawContent() || '';
                updateChatPreview(currentChatId, assistantContent);
                updateChatTitleFromMessage(message);
            },

            onError: (error, processor, userTurnInfo, savedAssistantTurn) => {
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
                    userTurnInfo,
                    savedAssistantTurn,
                    shouldSave: errorType === 'user_stopped',
                    userTurnNumber,
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
