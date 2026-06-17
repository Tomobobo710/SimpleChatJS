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
    testConnectionBtn;
// File upload elements
let fileInput, addFileBtn, imagePreviews, documentPreviews, imageArea;
// Legacy thinking variables removed
let mcpServersDiv;
let mcpConfigModal, mcpConfigBtn, closeMcpModalBtn, mcpConfigText, saveMcpConfigBtn, testMcpConfigBtn;
let chatList, chatTitle, chatInfo;

// Chat state
let chatHistories = new Map(); // Store chat histories locally
let currentTurnNumber = 0; // Track current turn number for active chat

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
// Turn management functions
function getNextTurnNumber() {
    return ++currentTurnNumber;
}

function resetTurnTracking() {
    currentTurnNumber = 0;
}

async function initializeTurnTrackingForChat(chatId) {
    try {
        if (!chatId) {
            resetTurnTracking();
            return;
        }

        // Get the highest turn number from this chat
        const response = await getCurrentTurnNumber(chatId);
        currentTurnNumber = response.turn_number || 0;
        logger.debug(`[TURN] Initialized turn tracking for chat ${chatId}: currentTurnNumber=${currentTurnNumber}`);
    } catch (error) {
        logger.warn("[TURN] Failed to initialize turn tracking, starting from 0:", error);
        resetTurnTracking();
    }
}

// Handle sending a message
async function handleSendMessage() {
    const sendBtn = document.getElementById("sendBtn");

    // Check if we're in stop mode
    if (sendBtn.classList.contains("btn-stop")) {
        stopGeneration();
        return;
    }

    const textMessage = messageInput.value; // Don't trim - preserve user's intentional whitespace
    const images = getSelectedImages();
    const documents = getSelectedDocuments();

    // Need either text, images, or documents
    if (!textMessage && images.length === 0 && documents.length === 0) return;

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
        logger.info(`Sending separated multimodal message: ${parts.join(" + ")}`);
    } else {
        // Text-only content
        messageContent = textMessage || "";
        logger.info("Sending text-only message");
    }

    // Clear input and files, show loading
    messageInput.value = "";
    clearSelectedImages();
    clearSelectedDocuments();
    setLoading(true);

    try {
        // Resolve the active terminal turn so the new message continues
        // the current branch (null for a fresh chat).
        const parentTurnId = await getActiveTerminalTurnId(currentChatId);

        const requestTurnNumber = getNextTurnNumber();

        await sendAndStream({
            requestTurnNumber,
            parentTurnId,
            turnId: null,
            inputMethod: "manual",

            saveRequestMessage: async () => {
                const messageForSaving = { role: "user", content: messageContent };
                if (Array.isArray(messageContent)) {
                    const filesPart = messageContent.find((part) => part.type === "files");
                    if (filesPart && filesPart.files) {
                        messageForSaving.original_content = messageContent;
                        messageForSaving.file_metadata = {
                            hasFiles: true,
                            fileCount: filesPart.files.length,
                            imageCount: messageContent.filter((part) => part.type === "image").length,
                            files: filesPart.files,
                        };
                    }
                }
                const saveResult = await saveCompleteMessage(
                    currentChatId, messageForSaving, requestTurnNumber,
                    parentTurnId ? { parent_turn_id: parentTurnId } : null
                );
                if (!saveResult || !saveResult.turn_id) {
                    throw new Error("saveCompleteMessage returned no turn_id; cannot proceed without lineage anchor");
                }
                return { turn_id: saveResult.turn_id, parent_turn_id: saveResult.parent_turn_id };
            },

            renderRequestTurn: async (requestTurnInfo, requestId) => {
                if (!requestTurnInfo) return;

                const requestMessage = new Message({
                    id: null,
                    role: "user",
                    content: messageContent,
                    turn_number: requestTurnNumber,
                    turn_id: requestTurnInfo.turn_id,
                    parent_turn_id: requestTurnInfo.parent_turn_id,
                    edit_count: 0,
                });

                const requestTurn = new Turn(requestTurnNumber, [requestMessage], requestTurnInfo.turn_id, requestTurnInfo.parent_turn_id);
                const rto = requestTurn.renderable();
                chatRenderer.renderTurn(rto, true);

                const turnMessages = rto.turnMessages || [{ role: "user", content: messageContent }];
                listenForRequestDebug(requestId, requestTurnNumber, turnMessages);
            },

            onResponseRendered: async ({ processor }) => {
                const responseContent = processor.getRawContent() || "";
                updateChatPreview(currentChatId, responseContent);
                updateChatTitleFromMessage(messageContent);
            },

            onError: (error, processor, requestTurnInfo, savedResponseTurn) => {
                const errorType = error.name === "AbortError"
                    ? "user_stopped"
                    : (error.streamErrorType || "api_error");
                const errorText = error.errorText
                    || (error.name === "AbortError" ? "Generation stopped by user." : "")
                    || error.message
                    || "";
                handleSimpleChatError({
                    errorType,
                    processor,
                    requestTurnInfo,
                    savedResponseTurn,
                    requestTurnNumber,
                    message: messageContent,
                    errorText,
                    responseDebugData: error.responseDebugData,
                });
            },
        });
    } catch (error) {
        if (error.name === "AbortError") {
            logger.info("Message generation was stopped by user");
        } else {
            showError(`Failed to send message: ${error.message}`);
        }
    } finally {
        // Recompute the button from the viewed chat's stream state instead of
        // forcing "Send": other chats may still be streaming, and if this send
        // failed before a stream started this resets to "Send".
        refreshSendButton();
        messageInput.focus();
    }
}
