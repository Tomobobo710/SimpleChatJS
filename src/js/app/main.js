// Main application logic - App initialization, DOM setup, and message routing

// DOM elements
let messageInput, sendBtn, turnsContainer, scrollContainer;
let settingsModal, settingsBtn, newChatBtn, bottomBarPlusBtn, bottomBarBackBtn, settingsBtnInput, closeModalBtn;
let apiUrlInput,
    apiKeyInput,
    modelNameInput,
    modelSelectDropdown,
    mainModelSelect,
    refreshModelsBtn,
    saveSettingsBtn,
    debugPanelsInput,
    systemBlocksInput,
    testConnectionBtn;
// File upload elements
let fileInput, addFileBtn, imagePreviews, documentPreviews, imageArea;
// Legacy thinking variables removed
let mcpServersDiv;
let mcpConfigModal, mcpConfigBtn, closeMcpModalBtn, mcpConfigText, saveMcpConfigBtn, testMcpConfigBtn;
let chatList, chatTitle, chatInfo;

// Chat state
let chatHistories = new Map(); // Store chat histories locally

// Initialize the application
document.addEventListener("DOMContentLoaded", function () {
    initializeElements();
    setupEventListeners();
    loadInitialSettings();
    updateMCPStatus();

    // Auto-connect to MCP servers at startup
    setTimeout(autoConnectMCP, 200);

    // Initialize bottom bar state
    window.updateBottomBar();

    // Load chat list after a short delay to ensure DOM is ready
    setTimeout(loadChatList, 300);

    logger.info("Simple Chat initialized");
});

// Shared utility function for getting enabled tool definitions
async function getEnabledToolDefinitions() {
    let enabledToolDefinitions = [];
    try {
        // Ensure enabled tools cache is loaded before checking tool status
        await loadEnabledToolsFromBackend();

        const mcpStatus = await getMCPStatus();
        if (mcpStatus.connected && mcpStatus.servers) {
            mcpStatus.servers.forEach((server) => {
                if (server.connected && server.tools) {
                    server.tools.forEach((toolName) => {
                        if (isToolEnabled(server.name, toolName)) {
                            enabledToolDefinitions.push({
                                name: toolName,
                                server: server.name,
                                type: "function"
                            });
                        }
                    });
                }
            });
        }
    } catch (error) {
        logger.warn("Failed to get MCP tools:", error);
    }

    return enabledToolDefinitions;
}
// Build a message-content payload from the current input (text + files).
// Returns null when there's nothing to send. Shared by send and steer.
function buildMessageContentFromInput() {
    const textMessage = messageInput.value; // Don't trim - preserve user's intentional whitespace
    const images = getSelectedImages();
    const documents = getSelectedDocuments();

    // Need either text, images, or documents
    if (!textMessage && images.length === 0 && documents.length === 0) return null;

    // Create separated file content (no frontend concatenation)
    let messageContent;
    if (images.length > 0 || documents.length > 0) {
        // Multimodal content with separated files
        messageContent = [];

        // Add text part (user text only, no document content)
        if (textMessage) {
            messageContent.push({
                type: "text",
                text: textMessage
            });
        }

        // Add image parts
        images.forEach((imageData) => {
            messageContent.push({
                type: "image",
                imageData: imageData.data,
                mimeType: imageData.mimeType
            });
        });

        // Add files as separate part (NEW STRUCTURE)
        if (documents.length > 0) {
            messageContent.push({
                type: "files",
                files: documents.map((doc) => ({
                    fileName: doc.fileName,
                    extractedText: doc.extractedText,
                    size: doc.size,
                    type: doc.type || "application/octet-stream"
                }))
            });
        }

        const parts = [];
        if (textMessage) parts.push("text");
        if (documents.length > 0) parts.push(`${documents.length} file(s)`);
        if (images.length > 0) parts.push(`${images.length} image(s)`);
        logger.info(`Built separated multimodal message: ${parts.join(" + ")}`);
    } else {
        // Text-only content
        messageContent = textMessage || "";
        logger.info("Built text-only message");
    }

    return messageContent;
}

// Handle sending a message
async function onSubmitRequest() {
    const messageContent = buildMessageContentFromInput();
    if (messageContent === null) return;

    // Clear input and files, show loading
    messageInput.value = "";
    clearSelectedImages();
    clearSelectedDocuments();
    setLoading(true);

    try {
        const parentTurnId = await getActiveTerminalTurnId(currentChatId);

        let messages = [{ role: "user", content: messageContent }];

        // If this chat has no messages yet, inject the system prompt
        // as the first message in the request turn.
        try {
            const history = await getChatHistory(currentChatId);
            if (!history || !history.messages || history.messages.length === 0) {
                const settings = window.cachedSettings();
                if (settings && settings.enableSystemPrompt && settings.systemPrompt?.trim()) {
                    // Build the env context string from toggles and append it
                    // to the system prompt content.
                    const envToggles = settings.envToggles || {};
                    const contextParts = [];
                    if (envToggles.platform) {
                        contextParts.push(`Platform: ${window.electronAPI?.getPlatform?.() || 'win32'}`);
                    }
                    if (envToggles.cwd) {
                        // Priority: project path > user defaultCwd > home dir fallback
                        let cwd = null;
                        try {
                            const projectPath = await getChatProjectPath(currentChatId);
                            if (projectPath) {
                                cwd = projectPath;
                            }
                        } catch (_) { /* ignore */ }
                        if (!cwd) {
                            cwd = settings.defaultCwd || (await window.electronAPI?.getHomeDir?.());
                        }
                        contextParts.push(`Working directory: ${cwd}`);
                    }
                    if (envToggles.shell && settings.shell) {
                        contextParts.push(`Shell: ${settings.shell}`);
                    }
                    if (envToggles.date) {
                        contextParts.push(`Date: ${new Date().toDateString()}`);
                    }
                    const contextText = contextParts.join('\n');
                    const systemContent = settings.systemPrompt.trim() + (contextText ? '\n\n' + contextText : '');
                    messages.unshift({ role: "system", content: systemContent });
                }
            }
        } catch (_) {
            // If we can't check history, proceed without injecting — safer to
            // skip the system prompt than to block the user's message.
        }

        const turnRequest = new TurnRequest({
            messages,
            parentTurnId,
            turnId: null,
            requestOrigin: "send",
            chatId: currentChatId,
        });
        await turnRequest.execute();
    } catch (error) {
        logger.error("Unexpected error in message submission:", error);
        showError(`Failed to send message: ${error.message}`);
    } finally {
        streamManager.refreshSendButton();
        messageInput.focus();
    }
}

// Queue a steer for the currently-viewed chat. The steer is persisted (backend
// mints its turn_id) and rendered as a request turn, then picked up at the next
// stream break (see TurnRequest._maybeContinueSteering) which fires a single
// continuation request — no reparenting needed.
//
// Saves are serialized per chat via streamManager.steerChain so that each steer's
// save runs only after the previous steer's save has returned its backend-minted
// turn_id; the next steer reads that as its parent. This keeps the backend as the
// sole turn_id authority while still chaining rapid steers correctly.
async function enqueueSteer() {
    const messageContent = buildMessageContentFromInput();
    if (messageContent === null) return;

    const chatId = currentChatId;

    // Clear input immediately so the user can type the next steer.
    messageInput.value = "";
    clearSelectedImages();
    clearSelectedDocuments();
    streamManager.refreshSendButton();
    messageInput.focus();

    // Ask the in-flight response to end at its next message boundary (tool-round
    // boundary) so this steer becomes the next request, rather than waiting for
    // the whole agentic run to finish. Fire-and-forget.
    const stream = streamManager.getStream(chatId);
    if (stream && stream.requestId) {
        requestSteerBreak(stream.requestId);
    }

    // Chain this steer's save after the previous one for this chat.
    const prev = streamManager.steerChain.get(chatId) || Promise.resolve();
    const thisSave = prev.then(() => saveSteer(chatId, messageContent));
    // `.catch` keeps the chain alive if a save fails (so later steers still run).
    streamManager.steerChain.set(chatId, thisSave.catch(() => {}));

    try {
        await thisSave;
    } catch (error) {
        logger.error("[STEER] Failed to enqueue steer:", error);
        showError(`Failed to steer: ${error.message}`);
    } finally {
        streamManager.refreshSendButton();
    }
}

// Persist + render one steer. Runs serialized (see enqueueSteer): the previous
// steer in this chat has already saved, so its turn_id is available as this
// steer's parent. The backend mints this steer's turn_id.
async function saveSteer(chatId, messageContent) {
    // Parent: the previous queued steer (already saved — serialized), or for the
    // first steer the in-flight response's own announced turn_id (from the
    // X-Response-Turn-Id header). The request never carries a response id.
    const queue = streamManager.steeringQueue.get(chatId) || [];
    let parentTurnId;
    if (queue.length) {
        parentTurnId = queue[queue.length - 1].turnId;
    } else {
        const stream = streamManager.getStream(chatId);
        if (stream && stream.responseTurnId) {
            parentTurnId = stream.responseTurnId;
        } else if (stream && stream.responseTurnIdPromise) {
            // Header not landed yet (sub-ms; paste-and-fire) — await the
            // announcement rather than minting an id on the request side.
            parentTurnId = await stream.responseTurnIdPromise;
        } else {
            // No live stream (extreme drain-window edge): fall back to the chat's
            // current active leaf so the steer still attaches to the conversation.
            parentTurnId = await getActiveTerminalTurnId(chatId);
        }
    }

    const messages = [{ role: "user", content: messageContent }];
    const turnRequest = new TurnRequest({
        messages,
        parentTurnId,
        turnId: null,            // backend mints the turn_id
        requestOrigin: "steer",
        chatId,
    });
    const saved = await turnRequest.saveAndRender();
    if (!saved || !saved.turn_id) {
        throw new Error("steer save returned no turn_id");
    }

    // Record the (now-saved) steer for the drain, and hide its Edit & Retry while
    // queued (there's no response to that steer yet to regenerate).
    streamManager.enqueueSteer(chatId, {
        turnId: saved.turn_id,
        parentTurnId: saved.parent_turn_id,
        content: messageContent,
    });
    const steerEl = turnsContainer.querySelector(`.request-turn[data-turn-id="${saved.turn_id}"]`);
    if (steerEl) steerEl.classList.add("steer-pending");

    logger.info(`[STEER] Queued steer for chat ${chatId} (turn ${saved.turn_id})`);
}
