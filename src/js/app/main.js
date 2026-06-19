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
// Handle sending a message
async function onSubmitRequest() {
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
        const parentTurnId = await getActiveTerminalTurnId(currentChatId);

        let messages = [{ role: "user", content: messageContent }];

        // If this chat has no messages yet, inject the system prompt
        // as the first message in the request turn.
        try {
            const history = await getChatHistory(currentChatId);
            if (!history || !history.messages || history.messages.length === 0) {
                const settings = window.cachedSettings();
                if (settings && settings.enableSystemPrompt && settings.systemPrompt?.trim()) {
                    messages.unshift({ role: "system", content: settings.systemPrompt.trim() });
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
