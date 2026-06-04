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

async function handleSimpleChatAbort({ userTurnNumber, message, processor }) {
    logger.info('Simple chat stopped by user');

    const stoppedDebugData = {
        sequence: [{
            type: 'user_stopped',
            step: 1,
            timestamp: new Date().toISOString(),
            data: {
                message: 'Generation stopped by user',
                partial_content: processor.getDisplayContent() || '',
            },
        }],
        metadata: {
            endpoint: 'stopped_generation',
            timestamp: new Date().toISOString(),
            partial: true,
        },
    };

    processor.finalize();

    const partialAssistantMessage = new Message({
        id: null,
        role: 'assistant',
        content: processor.getRawContent() || '',
        turn_number: 0,
        debug_data: stoppedDebugData,
        edit_count: 0,
    });
    const partialTurn = new Turn(0, [partialAssistantMessage]);
    chatRenderer.renderTurn(partialTurn.renderable(), true);

    try {
        // Phase 8 Task 22 (L19): don't bump the in-memory turn counter here.
        // The DB increments via the backend's connection-error handler when
        // it saves the partial assistant row. Bumping the in-memory counter
        // twice (once for the user at handleSimpleChat:start, once here) put
        // it 1 ahead of the DB until the next chat load. Compute the
        // assistant's number directly from the user's number.
        const assistantTurnNumber = userTurnNumber + 1;
        stoppedDebugData.currentTurnNumber = assistantTurnNumber;

        const partialContent = processor.getRawContent() || '';
        logger.info(`[FRONTEND] Stopped message rendered, backend handles saving`);

        // Aborted streams reach this point before the backend has assigned
        // a turn_id to the assistant message, so there is no turn_id to
        // key debug storage on. The backend's connection-error handler
        // creates the assistant row from whatever it has on hand; the
        // frontend's partial debug data is best-effort and is dropped here.
        stoppedDebugData.turn_id = null;
        stoppedDebugData.parent_turn_id = null;

        updateChatPreview(currentChatId, partialContent);
        updateChatTitleFromMessage(message);
    } catch (saveError) {
        logger.warn('Failed to save stopped message:', saveError);
    }
}

async function handleSimpleChatError({ error, message }) {
    logger.error('Simple chat failed:', error, true);

    const errorMessage = new Message({
        id: null,
        role: 'assistant',
        content: `[ERROR] ${error.message}`,
        turn_number: 0,
        debug_data: null,
        edit_count: 0,
        error_state: error.message,
    });
    const errorTurn = new Turn(0, [errorMessage]);
    const errorRto = errorTurn.renderable();
    chatRenderer.renderTurn(errorRto, true);
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
                // Phase 9 M11 fix: pass the active terminal as the new
                // user turn's parent_turn_id. Without this, saveCompleteMessage
                // would call the backend's getTurnInfo with both args
                // undefined and the new turn would be created at root — a
                // sibling of the chat's other user messages, breaking the
                // "fresh send continues the active branch" contract. With
                // this, parentTurnId === null only for an empty chat (first
                // message in a new chat), which is the correct root case.
                const saveResult = await saveCompleteMessage(
                    currentChatId, messageForSaving, userTurnNumber,
                    parentTurnId ? { parent_turn_id: parentTurnId } : null
                );
                // Phase 6 Task 17 (M4): a failed save is a hard error. Don't
                // return null — that lets the chat request go out with no
                // lineage anchor (H8 fallthrough). Throw so sendAndStream
                // aborts before the request, and the top-level handler in
                // main.js shows the error to the user.
                if (!saveResult || !saveResult.turn_id) {
                    throw new Error('saveCompleteMessage returned no turn_id; cannot proceed without lineage anchor');
                }
                return { turn_id: saveResult.turn_id, parent_turn_id: saveResult.parent_turn_id };
            },

            renderUserBubble: async (userTurnInfo, requestId) => {
                if (!userTurnInfo) return;

                // Phase 8 Task 28 (L20): pass turn_id and parent_turn_id
                // to the Message constructor rather than constructing first
                // and mutating in place. The Message constructor already
                // accepts these fields (message.js:10-11), so no class
                // changes needed — just pass them up front.
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

            onError: (error, processor) => {
                if (error.name === 'AbortError') {
                    handleSimpleChatAbort({ userTurnNumber, message, processor });
                } else {
                    handleSimpleChatError({ error, message });
                }
            },
        });

        logger.info('Simple chat completed successfully');
    } catch (error) {
        // onError callback already handled partial/error rendering. Re-throw
        // only if the user wants to see the error in the console.
        logger.debug('[SIMPLE-CHAT] Error caught at outer level:', error);
    }
}
