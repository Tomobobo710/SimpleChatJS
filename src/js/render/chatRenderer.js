// ChatRenderer.js

class ChatRenderer {
    constructor(containerElement) {
        this.container = containerElement;
    }

    // Main render method - handles only blocks - no more content parsing
    renderTurn(turnData, shouldScroll = true, branchMap = null) {
        try {
            const {
                id,
                role,
                blocks,
                content,
                debugData,
                responseDebugData,
                turnMessages,
                dropdownStates = {},
                originalContent,
                turnNumber,
                turnId,
                parentTurnId,
                editCount,
                activeEditVersion = 0,
                editedAt
            } = turnData;

            // Validate required data
            if (!role || turnNumber === undefined) {
                console.error("[RENDER-ERROR] Missing required turn data:", { role, turnNumber, turnData });
                return null;
            }

// Handle blocks: Required for assistant messages, optional for user messages
            let finalBlocks;
            if (!blocks) {
                if (role === "assistant") {
                    // Auto-generate blocks for assistant messages when missing
                    console.warn("[AUTO-BLOCKS] Creating blocks for assistant message from content");
                    finalBlocks = this.createBlocksFromContent(content);
                } else {
                    // User messages can render without blocks
                    finalBlocks = [{ type: "chat", content: content || "", metadata: {} }];
                }
            } else {
                finalBlocks = blocks;
            }

            const turnDiv = document.createElement("div");
            const domId = `turn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // Use the new turn-based class names
            if (role === "user") {
                turnDiv.className = "turn request-turn";
            } else if (role === "assistant") {
                turnDiv.className = "turn response-turn";
            } else {
                turnDiv.className = `turn ${role}-turn`; // Fallback for other roles
            }

            if (id) {
                turnDiv.dataset.messageId = id;
            }
            if (turnNumber) {
                turnDiv.dataset.turnNumber = turnNumber;
            }
            if (turnId) {
                turnDiv.dataset.turnId = turnId;
            }
            // Always write data-parent-turn-id; empty string is the sentinel for
            // "root". Readers convert with `|| null`.
            turnDiv.dataset.parentTurnId = parentTurnId || "";

            // Create content container
            const contentDiv = document.createElement("div");
            contentDiv.className = "turn-content";

            // Always render blocks - no conditionals needed
            let thinkingIndex = 0;
            let toolIndex = 0;

            finalBlocks.forEach((blockData) => {
                let stateKey;
                let isOpen = false;

                if (blockData.type === "thinking") {
                    stateKey = "thinking_" + thinkingIndex;
                    thinkingIndex++;
                } else if (blockData.type === "tool") {
                    stateKey = "tool_" + toolIndex;
                    toolIndex++;
                }

                if (stateKey) {
                    isOpen = dropdownStates[stateKey] || false;
                }

                const blockElement = this.renderBlock(blockData, isOpen);
                contentDiv.appendChild(blockElement);
            });

            turnDiv.appendChild(contentDiv);

            // Add message actions bar (passing turn_id and parent_turn_id from RTO)
            this.addMessageActions(turnDiv, role, turnNumber, id, turnId, parentTurnId, branchMap);

            // Add debug toggle and panel if debug data provided
            if (debugData || responseDebugData) {
                this.addDebugPanel(turnDiv, domId, { ...debugData, responseDebugData, turnMessages }, turnNumber);
            }

            // Edit badge: edit_count is incremented only by in-place edits
            // (the PATCH path), never by edit-retry carry-forward. The
            // badge therefore reflects "this row was directly edited N
            // times" and persists across reloads/branch switches because
            // it's read from the DB on every render.
            if (editCount > 0) {
                // Find the message ID from turnMessages (contains all message data including id)
                // For turns with tool calls, there may be multiple messages - find the one that was edited
                const editedMessage = turnMessages && Array.isArray(turnMessages) 
                    ? turnMessages.find(m => m.id && m.editCount > 0) 
                    : null;
                const messageId = editedMessage?.id;
                this.addEditIndicator(turnDiv, editCount, activeEditVersion, messageId);
            }

            this.container.appendChild(turnDiv);

            // Handle scrolling
            if (shouldScroll) {
                smartScrollToBottom(scrollContainer);
            }

            // Update chat preview and handle title generation
            this.handleTurnMeta(
                role,
                finalBlocks
                    .filter((b) => b.type === "chat")
                    .map((b) => b.content)
                    .join(" ")
            );

            return turnDiv;
        } catch (error) {
            console.error("[RENDER-ERROR] Error rendering turn:", error, turnData);

            // Create a simple error message instead of crashing
            const errorDiv = document.createElement("div");
            errorDiv.className = "turn response-turn error";
            errorDiv.innerHTML = `
                <div class="turn-content">
                    <div class="error-message">Error rendering message: ${error.message}</div>
                </div>
            `;
            return errorDiv;
        }
    }

    // Render individual block based on type
    renderBlock(blockData, isOpen = false) {
        const { type, content, metadata = {} } = blockData;

        switch (type) {
            case "thinking":
                return this.renderThinkingBlock(content, metadata, isOpen);
            case "tool":
                return this.renderToolBlock(content, metadata, isOpen);
            case "codeblock":
                return this.renderCodeBlock(content, metadata);
            case "phase_marker":
                return this.renderPhaseMarkerBlock(content, metadata);
            case "error":
                return this.renderErrorBlock(content, metadata);

            case "chat":
            default:
                return this.renderChatBlock(content);
        }
    }

    // Render thinking block as dropdown
    renderThinkingBlock(content, metadata, isOpen = false) {
        const dropdownId = `thinking-${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Use title from metadata if available (Gemini), otherwise use default
        const title = metadata.title || "Thinking Process";
        const dropdown = new StreamingDropdown(dropdownId, title, "thinking", !isOpen);
        dropdown.setContent(content);
        return dropdown.element;
    }

    // Render tool block as dropdown
    renderToolBlock(content, metadata, isOpen = false) {
        const dropdownId = `tool-${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Extract tool name from metadata or content
        let toolName = metadata?.toolName;
        if (!toolName) {
            const toolMatch = content.match(/^\[(\w+)\]:/m);
            if (toolMatch) {
                toolName = toolMatch[1];
            }
        }

        // Create title with just the tool name (no "Tool:" prefix)
        const title = toolName || "unknown_tool";

        // Format the content with Arguments and Result sections
        const formattedContent = formatToolContent(content, toolName, metadata?.toolArgs);

        const dropdown = new StreamingDropdown(dropdownId, title, "tool", !isOpen);
        dropdown.setContent(formattedContent);
        return dropdown.element;
    }

    // Render live streaming code block
    renderCodeBlock(content, metadata) {
        const div = document.createElement("div");
        div.className = "live-code-block";

        // Add language label if present
        if (metadata.language) {
            const langLabel = document.createElement("div");
            langLabel.className = "code-lang";
            langLabel.textContent = metadata.language;
            div.appendChild(langLabel);
        }

        // Create the code element
        const pre = document.createElement("pre");
        const code = document.createElement("code");

        // Add language class and streaming indicator
        let codeClass = "";
        if (metadata.language) {
            codeClass = `language-${metadata.language}`;
        }

        if (metadata.isStreaming) {
            code.className = `streaming-code ${codeClass}`.trim();
            // For streaming, escape HTML and add cursor
            code.innerHTML = escapeHtml(content) + '<span class="code-cursor">|</span>';
        } else {
            code.className = codeClass;
            // For final content, use SimpleSyntax highlighting
            code.innerHTML = window.SimpleSyntax
                ? SimpleSyntax.highlight(content, metadata.language)
                : escapeHtml(content);
        }

        pre.appendChild(code);
        div.appendChild(pre);

        // Add copy button
        const copyBtn = document.createElement("button");
        copyBtn.className = "code-copy-btn";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", () => {
            this.copyCodeToClipboard(content);
        });
        div.appendChild(copyBtn);

        return div;
    }

    // Render error block as dropdown with debug information
    renderErrorBlock(content, metadata, isOpen = false) {
        const dropdownId = `error-${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const errorType = metadata?.error_type || "unknown_error";
        const title = `Error: ${errorType.replace("_", " ").toUpperCase()}`;

        // Create error dropdown with red styling
        const dropdown = new StreamingDropdown(dropdownId, title, "error", !isOpen);

        // Format error content with debug information
        let errorContent = `**Error Message:**\n${content}\n\n`;

        if (metadata?.debug_data) {
            errorContent += `**Debug Information:**\n\`\`\`json\n${JSON.stringify(metadata.debug_data, null, 2)}\n\`\`\``;
        }

        dropdown.setContent(errorContent);

        // Add error-specific styling
        dropdown.element.classList.add("error-dropdown");
        dropdown.element.style.borderLeft = "4px solid #ff4444";

        // Style the dropdown toggle (header) - use correct selector and add null check
        const dropdownToggle = dropdown.element.querySelector(".dropdown-toggle");
        if (dropdownToggle) {
            dropdownToggle.style.backgroundColor = "#4a1a1a"; // Dark red background
            dropdownToggle.style.color = "#ff9999"; // Light red text
            dropdownToggle.style.borderLeft = "3px solid #cc0000";
        }

        return dropdown.element;
    }

    // Copy code content to clipboard, stripping markdown backticks
    copyCodeToClipboard(content) {
        // Remove leading/trailing backticks and language identifier
        let cleanContent = content;

        // Remove opening backticks and language (e.g., "```python\n")
        cleanContent = cleanContent.replace(/^```[a-zA-Z]*\n?/, "");

        // Remove closing backticks
        cleanContent = cleanContent.replace(/\n?```$/, "");

        // Copy to clipboard
        navigator.clipboard
            .writeText(cleanContent)
            .then(() => {
                // Provide visual feedback
                const copyBtns = document.querySelectorAll(".code-copy-btn");
                copyBtns.forEach((btn) => {
                    if (btn.textContent === "Copy") {
                        const originalText = btn.textContent;
                        btn.textContent = "Copied!";
                        setTimeout(() => {
                            btn.textContent = originalText;
                        }, 1000);
                    }
                });
            })
            .catch((err) => {
                console.error("Failed to copy code:", err);
            });
    }

    // Render regular chat content

    showFileContentModal(metadata) {
        // Create modal
        const modal = document.createElement("div");
        modal.className = "file-content-modal";
        modal.innerHTML = `
            <div class="modal-overlay">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>${metadata.fileName}</h3>
                        <button class="modal-close">×</button>
                    </div>
                    <div class="modal-body">
                        <pre class="file-content">${escapeHtml(metadata.extractedText || "No content available")}</pre>
                    </div>
                </div>
            </div>
        `;

        // Add to body
        document.body.appendChild(modal);

        // Close handlers
        const closeBtn = modal.querySelector(".modal-close");
        const overlay = modal.querySelector(".modal-overlay");

        const closeModal = () => {
            document.body.removeChild(modal);
        };

        closeBtn.addEventListener("click", closeModal);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeModal();
        });

        // ESC key to close
        const escHandler = (e) => {
            if (e.key === "Escape") {
                closeModal();
                document.removeEventListener("keydown", escHandler);
            }
        };
        document.addEventListener("keydown", escHandler);
    }

    renderChatBlock(content) {
        const div = document.createElement("div");
        div.className = "chat-block";

        // Handle cases where content might be JSON stringified
        let processedContent = content;
        if (typeof content === "string" && content.startsWith("[")) {
            try {
                processedContent = JSON.parse(content);
            } catch (e) {
                processedContent = content;
            }
        }

        // Strip trailing newlines from chat content so they don't render as empty <br>s
        const stripTrailingNewlines = (str) => typeof str === 'string' ? str.replace(/\n+$/, '') : str;

        // Handle multimodal content (array) or simple text content (string)
        if (Array.isArray(processedContent)) {
            processedContent.forEach((part) => {
                switch (part.type) {
                    case "text":
                        if (part.text !== undefined && part.text !== null && part.text !== "") {
                            const textDiv = document.createElement("div");
                            textDiv.className = "content-part text-part";
                            textDiv.innerHTML = formatMessage(escapeHtml(stripTrailingNewlines(part.text)));
                            div.appendChild(textDiv);
                        }
                        break;

                    case "image":
                        const imageDiv = document.createElement("div");
                        imageDiv.className = "content-part image-part";

                        const img = document.createElement("img");
                        img.src = `data:${part.mimeType};base64,${part.imageData}`;
                        img.className = "message-image";
                        img.loading = "lazy";
                        img.onclick = () => this.openImageModal(img.src);

                        imageDiv.appendChild(img);
                        div.appendChild(imageDiv);
                        break;

                    case "files":
                        if (part.files && Array.isArray(part.files) && part.files.length > 0) {
                            const filesDiv = document.createElement("div");
                            filesDiv.className = "content-part files-part";

                            part.files.forEach((file) => {
                                const filePreview = document.createElement("div");
                                filePreview.className = "file-attachment";

                                const icon = document.createElement("span");
                                icon.className = "file-icon";
                                icon.textContent = getFileIcon(file.fileName);

                                const info = document.createElement("div");
                                info.className = "file-info";

                                const name = document.createElement("div");
                                name.className = "file-name";
                                name.textContent = file.fileName;
                                name.title = file.fileName;

                                const size = document.createElement("div");
                                size.className = "file-size";
                                size.textContent = `${(file.size / 1024).toFixed(1)}KB`;

                                info.appendChild(name);
                                info.appendChild(size);

                                filePreview.appendChild(icon);
                                filePreview.appendChild(info);

                                // Add click handler to show file content
                                filePreview.style.cursor = "pointer";
                                filePreview.addEventListener("click", () => {
                                    this.showFileContentModal({
                                        fileName: file.fileName,
                                        extractedText: file.extractedText,
                                        size: file.size,
                                        type: file.type
                                    });
                                });

                                filesDiv.appendChild(filePreview);
                            });

                            div.appendChild(filesDiv);
                        }
                        break;

                    default:
                        console.warn("Unknown content part type:", part.type);
                        break;
                }
            });
        } else {
            // Simple text content (backward compatible)
            div.innerHTML = formatMessage(escapeHtml(stripTrailingNewlines(String(processedContent || ""))));
        }

        return div;
    }

    // Open image in modal for full view
    openImageModal(imageSrc) {
        // Create modal if it doesn't exist
        let modal = document.getElementById("imageModal");
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "imageModal";
            modal.className = "image-modal hidden";

            const img = document.createElement("img");
            img.id = "modalImage";
            modal.appendChild(img);

            // Close modal on click
            modal.addEventListener("click", () => {
                modal.classList.add("hidden");
            });

            // Close modal on Escape key
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && !modal.classList.contains("hidden")) {
                    modal.classList.add("hidden");
                }
            });

            document.body.appendChild(modal);
        }

        // Set image and show modal
        const modalImg = document.getElementById("modalImage");
        modalImg.src = imageSrc;
        modal.classList.remove("hidden");
    }

    // Simple phase marker rendering - no more complexity!
    renderPhaseMarkerBlock(content, metadata) {
        const settings = loadSettings();

        const div = document.createElement("div");
        div.className = "phase-marker";
        div.innerHTML = `
            <div class="phase-marker-content">
                <span class="phase-text">${escapeHtml(content)}</span>
            </div>
        `;

        return div;
    }

    // Add debug panel to message
    addDebugPanel(turnDiv, messageId, debugData, turnNumber = null) {
        const settings = loadSettings();
        turnDiv.classList.add("has-debug");

        const debugToggle = document.createElement("button");
        debugToggle.className = "debug-toggle";
        debugToggle.dataset.messageId = messageId;
        debugToggle.innerHTML = "+";
        debugToggle.title = "Show debug info";

        if (!settings.debugPanels) {
            debugToggle.style.display = "none";
        }

        // Add click handler to toggle debug panel
        debugToggle.addEventListener("click", () => {
            const debugPanel = turnDiv.querySelector(".debug-panel-container");
            if (debugPanel) {
                const isHidden = debugPanel.style.display === "none";
                debugPanel.style.display = isHidden ? "block" : "none";
                debugToggle.innerHTML = isHidden ? "−" : "+";
                debugToggle.classList.toggle("active", isHidden);
            }
        });

        turnDiv.appendChild(debugToggle);

        // Add turn ID and message ID to debug data
        if (!debugData) {
            debugData = {};
        }

        // Get the turn element that contains this message
        const turnElement = turnDiv.closest(".turn");
        if (turnElement) {
            debugData.turnId = turnElement.dataset.turnId || "unknown";
        }

        // Add message ID
        debugData.messageId = messageId || "unknown";

        // Add turn number if provided
        if (turnNumber !== null && turnNumber !== undefined) {
            debugData.currentTurnNumber = turnNumber;
        }

        const debugPanel = createDebugPanel(turnDiv, messageId, debugData, turnNumber);
        turnDiv.appendChild(debugPanel);
    }

    // Add message actions bar to turn
    addMessageActions(turnDiv, role, turnNumber = null, messageId = null, turnId = null, parentTurnId = null, branchMap = null) {
        const actionsContainer = document.createElement("div");
        actionsContainer.className = "message-actions";
        if (messageId) {
            actionsContainer.dataset.messageId = messageId;
        }

        // Action buttons container
        const actionButtons = document.createElement("div");
        actionButtons.className = "action-buttons";

        // Edit button
        const editBtn = document.createElement("button");
        editBtn.className = "action-btn edit-btn";
        editBtn.title = "Edit message";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => this.handleEditMessage(turnId, role, turnNumber, messageId));

        // Edit and retry button (for user messages)
        const editRetryBtn = document.createElement("button");
        editRetryBtn.className = "action-btn edit-retry-btn";
        editRetryBtn.title = "Edit your message and regenerate conversation from this point";
        editRetryBtn.textContent = "Edit & Retry";
        editRetryBtn.addEventListener("click", () => this.handleEditAndRetry(turnId, role, turnNumber, messageId));

        // Retry button (for assistant messages)
        const retryBtn = document.createElement("button");
        retryBtn.className = "action-btn retry-btn";
        retryBtn.title = "Generate a different response to the same prompt";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", () => this.handleRetryMessage(turnId, role, turnNumber, messageId));

        // Add buttons to container
        actionButtons.appendChild(editBtn);

        // Only show "Edit & Retry" for user messages (lets them rephrase and regenerate)
        if (role === "user") {
            actionButtons.appendChild(editRetryBtn);
        }

        // Only show "Retry" for assistant messages (regenerate response)
        if (role === "assistant") {
            actionButtons.appendChild(retryBtn);
        }

        // Assemble the actions container - add action buttons first (left side)
        actionsContainer.appendChild(actionButtons);

        // Add branch navigation to both user and assistant turns (both can be branched)
        if ((role === "user" || role === "assistant") && turnNumber) {
            // Branch navigation container
            const branchNav = document.createElement("div");
            branchNav.className = "branch-nav";
            branchNav.style.display = "none"; // Will be shown when this turn has branches

            // Previous branch button
            const prevBtn = document.createElement("button");
            prevBtn.className = "nav-btn branch-prev";
            prevBtn.innerHTML = "<";
            prevBtn.title = "Previous branch";
            prevBtn.addEventListener("click", () => this.navigateBranch("prev", branchNav));

            // Branch indicator
            const branchIndicator = document.createElement("span");
            branchIndicator.className = "branch-indicator";
            branchIndicator.textContent = "1/1";

            // Next branch button
            const nextBtn = document.createElement("button");
            nextBtn.className = "nav-btn branch-next";
            nextBtn.innerHTML = ">";
            nextBtn.title = "Next branch";
            nextBtn.addEventListener("click", () => this.navigateBranch("next", branchNav));

            branchNav.appendChild(prevBtn);
            branchNav.appendChild(branchIndicator);
            branchNav.appendChild(nextBtn);

            // Check if this turn should show branch navigation
            this.updateBranchNavigation(branchNav, turnNumber, { turnId, parentTurnId, role }, branchMap).catch((error) => {
                console.error("[BRANCH-NAV] Error loading branch info:", error);
                // Hide navigation on error
                branchNav.style.display = "none";
            });

            // Add branch nav to actions container after action buttons
            actionsContainer.appendChild(branchNav);
        }

        // Insert before debug toggle if it exists, otherwise just append
        const debugToggle = turnDiv.querySelector(".debug-toggle");
        if (debugToggle) {
            turnDiv.insertBefore(actionsContainer, debugToggle);
        } else {
            turnDiv.appendChild(actionsContainer);
        }
    }

    // Handle turn-level editing - show all messages in the turn
    async handleEditMessage(turnId, role, turnNumber, messageId) {
        if (!turnNumber) {
            showError("Cannot edit: Turn number not available");
            return;
        }

        const turnDiv = document.querySelector(`[data-turn-id="${turnId}"]`);
        if (!turnDiv) {
            showError("Cannot edit: Turn element not found");
            return;
        }

        // Check if already in edit mode
        if (turnDiv.classList.contains("editing")) {
            return;
        }

        try {
            // Get all messages for this turn
            const response = await getTurnMessages(currentChatId, turnNumber);

            if (!response || !response.messages) {
                showError("Cannot edit: Invalid response from server");
                console.error("[EDIT] Invalid response:", response);
                return;
            }

            // Filter to the active leaf's messages only — siblings share
            // turn_number, so the unfiltered list contains all siblings.
            const turnMessages = response.messages.filter((m) => m.turn_id === turnId);

            if (!Array.isArray(turnMessages) || turnMessages.length === 0) {
                showError("Cannot edit: No messages found for this turn");
                return;
            }

            // Enter message-based edit mode
            this.enterMessageEditMode(turnDiv, turnMessages, turnNumber);
        } catch (error) {
            console.error("[EDIT] Error getting turn messages:", error);
            showError(`Error loading turn for editing: ${error.message}`);
        }
    }

    async handleEditAndRetry(turnId, role, turnNumber, messageId) {
        // Only allow edit & retry for user messages
        if (role !== "user") {
            return;
        }

        if (!turnNumber) {
            return;
        }

        // Set a flag that this turn should retry after editing
        const turnDiv = document.querySelector(`[data-turn-id="${turnId}"]`);
        if (turnDiv) {
            turnDiv.dataset.shouldRetryAfterEdit = "true";
            turnDiv.dataset.editRetryTurnNumber = turnNumber;
            if (turnId) {
                turnDiv.dataset.editRetryTurnId = turnId;
            }
        }

        // Call the regular edit function - it will use the proper modal
        await this.handleEditMessage(turnId, role, turnNumber, messageId);
    }

    async handleRetryMessage(turnId, role, turnNumber, messageId) {
        if (role !== "assistant") return;
        if (!turnNumber) return;

        const turnDiv = document.querySelector(`[data-turn-id="${turnId}"]`);
        if (turnDiv) {
            const retryBtn = turnDiv.querySelector(".retry-btn");
            if (retryBtn) { retryBtn.textContent = "Retrying..."; retryBtn.disabled = true; }
        }

        try {
            const history = await getChatHistory(currentChatId);
            const allMessages = history.messages || [];
            const retriedResponseTurn = allMessages.find((msg) => msg.role === "assistant" && msg.turn_id === turnId);
            if (!retriedResponseTurn?.parent_turn_id) {
                console.error("[RETRY] Could not find retried response turn", { turnId, retriedResponseTurn });
                return;
            }
            const parentTurnId = retriedResponseTurn.parent_turn_id;

            const turnRequest = new TurnRequest({
                message: null,
                parentTurnId,
                turnId: parentTurnId,
                requestTurnNumber: turnNumber,
                requestOrigin: "retry",
                truncateFromTurnNumber: turnNumber,
                truncateContainer: this.container,
                chatId: currentChatId,
            });
            await turnRequest.execute();
        } catch (error) {
            console.error("[RETRY] Error:", error);
        } finally {
            if (turnDiv) {
                const retryBtn = turnDiv.querySelector(".retry-btn");
                if (retryBtn) { retryBtn.textContent = "Retry"; retryBtn.disabled = false; }
            }
        }
    }

    // Enter edit mode for a message
    enterEditMode(turnDiv, chatBlock, messageData, messageId) {
        // Mark as editing
        turnDiv.classList.add("editing");

        // Store original content
        const originalHtml = chatBlock.innerHTML;

        // Create edit container
        const editContainer = document.createElement("div");
        editContainer.className = "edit-container";

        // Create textarea with current content
        const textarea = document.createElement("textarea");
        textarea.className = "edit-textarea";
        textarea.value = messageData.content;
        textarea.rows = Math.max(3, messageData.content.split("\n").length + 1);

        // Create edit controls
        const editControls = document.createElement("div");
        editControls.className = "edit-controls";

        const saveBtn = document.createElement("button");
        saveBtn.className = "btn btn-success edit-btn-save";
        saveBtn.textContent = "Save";

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn btn-danger edit-btn-cancel";
        cancelBtn.textContent = "Cancel";

        // Add event handlers
        saveBtn.addEventListener("click", () => {
            this.saveEdit(turnDiv, chatBlock, textarea.value, messageId, originalHtml);
        });

        cancelBtn.addEventListener("click", () => {
            this.cancelEdit(turnDiv, chatBlock, originalHtml);
        });

        // Handle Escape key to cancel
        textarea.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                this.cancelEdit(turnDiv, chatBlock, originalHtml);
            }
            // Ctrl+Enter to save
            if (e.key === "Enter" && e.ctrlKey) {
                this.saveEdit(turnDiv, chatBlock, textarea.value, messageId, originalHtml);
            }
        });

        // Assemble edit UI
        editControls.appendChild(saveBtn);
        editControls.appendChild(cancelBtn);
        editContainer.appendChild(textarea);
        editContainer.appendChild(editControls);

        // Replace chat block content with edit UI
        chatBlock.innerHTML = "";
        chatBlock.appendChild(editContainer);

        // Focus the textarea
        textarea.focus();
        textarea.select();
    }

    // Save the edited message
    async saveEdit(turnDiv, chatBlock, newContent, messageId, originalHtml) {
        if (!newContent.trim()) {
            showError("Message cannot be empty");
            return;
        }

        try {
            // Show loading state
            const saveBtn = turnDiv.querySelector(".edit-btn-save");
            const originalSaveText = saveBtn.textContent;
            saveBtn.textContent = "Saving...";
            saveBtn.disabled = true;

            // Call API to update message
            const result = await editMessage(messageId, newContent.trim());

            // Update the UI with new content
            chatBlock.innerHTML = formatMessage(escapeHtml(newContent.trim()));

            // Exit edit mode
            turnDiv.classList.remove("editing");

            // Show edit indicator if this was edited
            if (result.edit_count > 0) {
                this.addEditIndicator(turnDiv, result.edit_count, result.active_edit_version, messageId);
            }
        } catch (error) {
            console.error("[EDIT] Error saving message:", error);
            showError(`Error saving message: ${error.message}`);

            // Restore original content on error
            chatBlock.innerHTML = originalHtml;
            turnDiv.classList.remove("editing");
        }
    }

    // Cancel editing and restore original content
    cancelEdit(turnDiv, chatBlock, originalHtml) {
        chatBlock.innerHTML = originalHtml;
        turnDiv.classList.remove("editing");
    }

    // Add visual indicator that message was edited with version navigation
    addEditIndicator(turnDiv, editCount, activeEditVersion = 0, messageId = null) {
        // Remove existing indicator
        const existing = turnDiv.querySelector(".edit-version-indicator");
        if (existing) {
            existing.remove();
        }

        // Don't show anything if no edits
        if (!editCount || editCount === 0) {
            return;
        }

        // Get messageId if not provided
        if (!messageId) {
            const messageElement = turnDiv.querySelector('[data-message-id]');
            messageId = messageElement ? messageElement.dataset.messageId : null;
        }
        
        if (!messageId) {
            console.warn("[EDIT-INDICATOR] Could not find messageId for turn");
            return;
        }

        // Create version indicator container
        const indicator = document.createElement("div");
        indicator.className = "edit-version-indicator";

        // Determine what to display
        let label;
        let showPrev = false;
        let showNext = false;

        if (activeEditVersion === 0) {
            // Viewing original
            label = "Original";
            showPrev = false;
            showNext = editCount > 0;
        } else if (activeEditVersion === editCount) {
            // Viewing latest edit
            label = `Edit ${activeEditVersion}`;
            showPrev = true;
            showNext = false;
        } else {
            // Viewing middle edit
            label = `Edit ${activeEditVersion}`;
            showPrev = true;
            showNext = true;
        }

        // Build indicator HTML
        let html = '';
        
        if (showPrev) {
            html += `<button class="edit-nav-btn edit-nav-prev" data-message-id="${messageId}" data-target-version="${activeEditVersion - 1}" title="Previous version">←</button>`;
        }

        html += `<span class="edit-version-label">${label}</span>`;

        if (showNext) {
            html += `<button class="edit-nav-btn edit-nav-next" data-message-id="${messageId}" data-target-version="${activeEditVersion + 1}" title="Next version">→</button>`;
        }

        indicator.innerHTML = html;

        // Add event listeners to buttons
        indicator.querySelectorAll('.edit-nav-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const btnMessageId = btn.dataset.messageId;
                const targetVersion = parseInt(btn.dataset.targetVersion, 10);
                await this.switchMessageVersion(btnMessageId, targetVersion);
            });
        });

        indicator.title = "Edit version navigation";

        // Insert after the turn content
        const turnContent = turnDiv.querySelector(".turn-content");
        if (turnContent) {
            turnContent.appendChild(indicator);
        }
    }

    // Switch message to different edit version
    async switchMessageVersion(messageId, targetVersion) {
        try {
            logger.info(`[VERSION-SWITCH-START] Attempting to switch message ${messageId} to version ${targetVersion}`);
            
            // Find the turn that contains this message
            const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
            if (!messageDiv) {
                throw new Error("Message element not found");
            }
            
            const turnDiv = messageDiv.closest('[data-turn-id]');
            if (!turnDiv) {
                throw new Error("Turn element not found");
            }
            
            const turnId = turnDiv.dataset.turnId;
            logger.info(`[VERSION-SWITCH] Found turnId: ${turnId}`);
            
            const response = await fetch(`/api/message/${turnId}/switch-version`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetVersion, isTurnId: true })
            });

            logger.info(`[VERSION-SWITCH] Response status: ${response.status}`);

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`[VERSION-SWITCH] HTTP ${response.status}: ${errorText}`, true);
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const result = await response.json();
            logger.info(`[VERSION-SWITCH] Server response: `, result);

            logger.info(`[VERSION-SWITCH] Switched turn ${turnId} to version ${targetVersion}`);
            
            // Reload entire chat to show the new version
            await loadChatHistory(currentChatId);
        } catch (error) {
            logger.error(`[VERSION-SWITCH] Error: ${error.message}`, true);
            showError(`Error switching version: ${error.message}`);
        }
    }

    // Find message ID for a turn by looking it up in the database
    async findMessageIdForTurn(turnNumber, role) {
        try {
            // Use global variables
            const apiBase = window.location.origin;
            const chatId = currentChatId; // Global variable from utils.js

            if (!chatId) {
                console.error("[EDIT] No current chat ID available");
                return null;
            }

            // Get current chat history to find the message (exclude errors)
            const response = await fetch(`${apiBase}/api/chat/${chatId}/history-complete?includeErrors=false`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const history = await response.json();

            // Find message with matching turn number and role
            const message = history.messages.find((msg) => msg.turn_number === turnNumber && msg.role === role);

            return message ? message.id : null;
        } catch (error) {
            console.error("[EDIT] Error finding message ID:", error);
            return null;
        }
    }

    // Legacy function - removed, use enterMessageEditMode instead
    enterTurnEditMode() {
        throw new Error("This function has been replaced by enterMessageEditMode");
    }

    // ===== UTILITY METHODS =====

    // Utility function to safely extract text content from multimodal or string content
    getTextContent(content) {
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            // Extract text from multimodal array
            const textPart = content.find((part) => part.type === "text");
            return textPart ? textPart.text : "[Images only]";
        }
        return String(content || "");
    }

    // Create blocks from content (for assistant messages that don't have blocks)
    createBlocksFromContent(content) {
        if (!content) {
            return [{ type: "chat", content: "", metadata: {} }];
        }

        // If content is already a string, create a simple chat block
        if (typeof content === "string") {
            return [{ type: "chat", content: content, metadata: {} }];
        }

        // If content is an array (multimodal), convert to appropriate blocks
        if (Array.isArray(content)) {
            const blocks = [];

            content.forEach((part) => {
                if (part.type === "text" && part.text) {
                    blocks.push({ type: "chat", content: part.text, metadata: {} });
                } else if (part.type === "image") {
                    // Create an image block
                    blocks.push({
                        type: "image",
                        content: `![Image](data:${part.mimeType};base64,${part.imageData})`,
                        metadata: {
                            mimeType: part.mimeType,
                            imageData: part.imageData
                        }
                    });
                }
            });

            // If no blocks were created, add an empty chat block
            if (blocks.length === 0) {
                blocks.push({ type: "chat", content: "", metadata: {} });
            }

            return blocks;
        }

        // Fallback for unexpected content types
        return [{ type: "chat", content: String(content), metadata: {} }];
    }

    // ===== EDIT SYSTEM =====

    // Remove an image from the edit modal
    removeImageFromEdit(messageContainer, imageIndex) {
        if (!messageContainer._originalContent || !Array.isArray(messageContainer._originalContent)) {
            console.warn(
                "[IMAGE-REMOVE] Cannot remove image - content is not multimodal",
                messageContainer._originalContent
            );
            return;
        }

        // Remove the image from the original content array
        let imageCount = 0;
        messageContainer._originalContent = messageContainer._originalContent.filter((part) => {
            if (part.type === "image") {
                if (imageCount === imageIndex) {
                    imageCount++;
                    return false; // Remove this image
                }
                imageCount++;
            }
            return true; // Keep text parts and other images
        });

        // Update the hasImages flag
        const remainingImages = messageContainer._originalContent.filter((part) => part.type === "image");
        messageContainer._hasImages = remainingImages.length > 0;

        // Update the textarea placeholder
        const textarea = messageContainer.querySelector(".message-content-textarea");
        if (textarea) {
            textarea.placeholder =
                remainingImages.length > 0 ? "Edit text content (images shown above)" : "Enter message content";
        }

        // Regenerate the images display
        this.updateImagesDisplay(messageContainer);

        console.log(`[IMAGE-REMOVE] Removed image ${imageIndex}, ${remainingImages.length} images remaining`);
    }

    // Handle file selection in edit modal
    handleEditImageSelect(event, messageContainer) {
        const files = Array.from(event.target.files);
        this.handleEditImageFiles(files, messageContainer, "file");
        // Clear the input so the same file can be selected again
        event.target.value = "";
    }

    // Handle image files in edit modal (similar to main handleImageFiles)
    handleEditImageFiles(files, messageContainer, source = "file") {
        const imageFiles = files.filter((file) => file.type.startsWith("image/"));

        if (imageFiles.length === 0) {
            console.warn("[EDIT-IMAGES] No valid image files selected");
            return;
        }

        if (source === "paste" || source === "clipboard") {
            const textarea = messageContainer.querySelector(".message-content-textarea");
            if (textarea) {
                const originalPlaceholder = textarea.placeholder;
                textarea.placeholder = `✓ Pasted ${imageFiles.length} image${imageFiles.length > 1 ? "s" : ""}`;
                setTimeout(() => {
                    textarea.placeholder = originalPlaceholder;
                }, 2000);
            }
        }

        let processedCount = 0;

        imageFiles.forEach(async (file) => {
            try {
                // Use shared image processing logic
                const processedImage = await processImageFile(file);

                // Convert to edit modal format
                const imageData = {
                    type: "image",
                    imageData: processedImage.data, // Convert 'data' to 'imageData'
                    mimeType: processedImage.mimeType,
                    name: processedImage.name,
                    size: processedImage.size
                };

                if (!Array.isArray(messageContainer._originalContent)) {
                    const currentText = messageContainer.querySelector(".message-content-textarea").value;
                    messageContainer._originalContent = [{ type: "text", text: currentText }];
                    console.warn("[EDIT-IMAGES] Had to convert _originalContent to array format");
                }

                messageContainer._originalContent.push(imageData);
                messageContainer._hasImages = true;

                const textarea = messageContainer.querySelector(".message-content-textarea");
                if (textarea) {
                    textarea.placeholder = "Edit text content (images shown above)";
                }

                processedCount++;
                if (processedCount === imageFiles.length) {
                    this.updateImagesDisplay(messageContainer);
                }

                console.log(
                    `[EDIT-IMAGES] Added image: ${processedImage.name} (${(processedImage.originalSize / 1024).toFixed(1)}KB → ${(processedImage.size / 1024).toFixed(1)}KB)`
                );
            } catch (error) {
                console.error(`[EDIT-IMAGES] Error processing image ${file.name}:`, error);
            }
        });
    }

    // Setup drag & drop for edit modal message container
    setupEditDragAndDrop(messageContainer) {
        // Drag & drop support
        messageContainer.addEventListener("dragover", (e) => {
            e.preventDefault();
            messageContainer.classList.add("drag-over");
        });

        messageContainer.addEventListener("dragleave", (e) => {
            e.preventDefault();
            // Only remove drag-over if we're actually leaving the container
            if (!messageContainer.contains(e.relatedTarget)) {
                messageContainer.classList.remove("drag-over");
            }
        });

        messageContainer.addEventListener("drop", (e) => {
            e.preventDefault();
            messageContainer.classList.remove("drag-over");
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
                this.handleEditFiles(files, messageContainer, "drop");
            }
        });

        // Clipboard paste support
        const textarea = messageContainer.querySelector(".message-content-textarea");
        if (textarea) {
            textarea.addEventListener("paste", (e) => {
                this.handleEditClipboardPaste(e, messageContainer);
            });
        }
    }

    // Handle clipboard paste in edit modal
    handleEditClipboardPaste(event, messageContainer) {
        const clipboardData = event.clipboardData || window.clipboardData;
        const items = clipboardData.items;

        let hasFiles = false;
        const pastedFiles = [];

        // Check for file items in clipboard
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === "file") {
                hasFiles = true;
                const file = item.getAsFile();
                if (file) {
                    pastedFiles.push(file);
                }
            }
        }

        // If we found files, prevent default paste and handle them
        if (hasFiles && pastedFiles.length > 0) {
            event.preventDefault();
            this.handleEditFiles(pastedFiles, messageContainer, "paste");
            console.log(`[EDIT-FILES] Pasted ${pastedFiles.length} file(s) from clipboard`);
        }
    }

    // Handle file selection in edit modal (images + documents)
    handleEditFileSelect(event, messageContainer) {
        const files = Array.from(event.target.files);
        this.handleEditFiles(files, messageContainer, "file");
        // Clear the input so the same file can be selected again
        event.target.value = "";
    }

    // Handle all file types in edit modal
    handleEditFiles(files, messageContainer, source = "file") {
        const imageFiles = files.filter((file) => file.type.startsWith("image/"));
        const documentFiles = files.filter((file) => !file.type.startsWith("image/"));

        // Process images (existing logic)
        if (imageFiles.length > 0) {
            this.handleEditImageFiles(imageFiles, messageContainer, source);
        }

        // Process documents (new logic)
        if (documentFiles.length > 0) {
            this.handleEditDocumentFiles(documentFiles, messageContainer, source);
        }
    }

    // Handle document files in edit modal
    async handleEditDocumentFiles(files, messageContainer, source = "file") {
        if (files.length === 0) {
            console.warn("[EDIT-DOCUMENTS] No document files selected");
            return;
        }

        const textarea = messageContainer.querySelector(".message-content-textarea");
        if (!textarea) {
            console.error("[EDIT-DOCUMENTS] No textarea found in message container");
            return;
        }

        // Show processing feedback
        const originalPlaceholder = textarea.placeholder;
        textarea.placeholder = `Processing ${files.length} document${files.length > 1 ? "s" : ""}...`;

        try {
            // Upload documents to server for processing
            const result = await processDocumentFiles(files);

            // Initialize documents array if it doesn't exist
            if (!messageContainer._editDocuments) {
                messageContainer._editDocuments = [];
            }

            // Add processed documents to the container's document list (like main chat)
            for (const docData of result.results) {
                messageContainer._editDocuments.push(docData);
                console.log(
                    `[EDIT-DOCUMENTS] Added document: ${docData.fileName} (${(docData.size / 1024).toFixed(1)}KB)`
                );
            }

            // Handle errors
            for (const error of result.errors || []) {
                console.error(`[EDIT-DOCUMENTS] Error processing: ${error.fileName} - ${error.error}`);
            }

            // Update the documents display (like images)
            this.updateEditDocumentsDisplay(messageContainer);

            // Show completion feedback
            if (result.failed > 0) {
                textarea.placeholder = `✓ Processed ${result.processed}/${files.length} documents (${result.failed} failed)`;
            } else {
                textarea.placeholder = `✓ Processed ${result.processed} document${result.processed > 1 ? "s" : ""}`;
            }
        } catch (error) {
            console.error("[EDIT-DOCUMENTS] Error uploading documents:", error);
            textarea.placeholder = `Error: ${error.message}`;
        }

        // Reset placeholder after delay
        setTimeout(() => {
            textarea.placeholder = originalPlaceholder;
        }, 3000);
    }

    // Update the documents display in edit modal
    updateEditDocumentsDisplay(messageContainer) {
        let documentsContainer = messageContainer.querySelector(".edit-documents-container");

        const documents = messageContainer._editDocuments || [];

        if (documents.length === 0) {
            // Remove container if no documents
            if (documentsContainer) {
                documentsContainer.remove();
            }
            return;
        }

        // Create container if it doesn't exist
        if (!documentsContainer) {
            documentsContainer = document.createElement("div");
            documentsContainer.className = "edit-documents-container";

            const documentsHeader = document.createElement("div");
            documentsHeader.className = "edit-documents-header";
            documentsHeader.textContent = "Documents:";

            const documentsGrid = document.createElement("div");
            documentsGrid.className = "edit-documents-grid";

            documentsContainer.appendChild(documentsHeader);
            documentsContainer.appendChild(documentsGrid);

            // Insert before textarea
            const textarea = messageContainer.querySelector(".message-content-textarea");
            messageContainer.insertBefore(documentsContainer, textarea);
        }

        // Update documents grid
        const documentsGrid = documentsContainer.querySelector(".edit-documents-grid");
        documentsGrid.innerHTML = "";

        documents.forEach((docData, index) => {
            const docPreview = document.createElement("div");
            docPreview.className = "edit-document-preview";

            const icon = document.createElement("span");
            icon.className = "doc-icon";
            icon.textContent = getFileIcon(docData.fileName);

            const info = document.createElement("div");
            info.className = "doc-info";

            const name = document.createElement("div");
            name.className = "doc-name";
            name.textContent = docData.fileName;
            name.title = docData.fileName;

            const size = document.createElement("div");
            size.className = "doc-size";
            size.textContent = `${(docData.size / 1024).toFixed(1)}KB`;

            info.appendChild(name);
            info.appendChild(size);

            const removeBtn = document.createElement("button");
            removeBtn.className = "remove-btn";
            removeBtn.innerHTML = "×";
            removeBtn.title = "Remove document";
            removeBtn.onclick = () => this.removeEditDocument(messageContainer, index);

            docPreview.appendChild(icon);
            docPreview.appendChild(info);
            docPreview.appendChild(removeBtn);
            documentsGrid.appendChild(docPreview);
        });
    }

    // Remove a document from edit modal
    removeEditDocument(messageContainer, index) {
        if (!messageContainer._editDocuments) return;

        messageContainer._editDocuments.splice(index, 1);
        this.updateEditDocumentsDisplay(messageContainer);
        console.log(`[EDIT-DOCUMENTS] Removed document at index ${index}`);
    }

    // Update the images display in edit modal
    updateImagesDisplay(messageContainer) {
        let imagesContainer = messageContainer.querySelector(".edit-images-container");

        // Defensive check for _originalContent
        const remainingImages =
            messageContainer._originalContent && Array.isArray(messageContainer._originalContent)
                ? messageContainer._originalContent.filter((part) => part.type === "image")
                : [];

        if (remainingImages.length === 0) {
            // No images left - remove the entire images container if it exists
            if (imagesContainer) {
                imagesContainer.remove();
            }
            return;
        }

        // Create images container if it doesn't exist
        if (!imagesContainer) {
            imagesContainer = document.createElement("div");
            imagesContainer.className = "edit-images-container";

            const imagesHeader = document.createElement("div");
            imagesHeader.className = "edit-images-header";
            imagesContainer.appendChild(imagesHeader);

            const imagesGrid = document.createElement("div");
            imagesGrid.className = "edit-images-grid";
            imagesContainer.appendChild(imagesGrid);

            // Insert before the textarea (images show above text)
            const textarea = messageContainer.querySelector(".message-content-textarea");
            if (textarea) {
                messageContainer.insertBefore(imagesContainer, textarea);
            } else {
                // Fallback: insert at the top
                messageContainer.insertBefore(imagesContainer, messageContainer.firstChild);
            }
        }

        // Update the header and regenerate the grid
        const header = imagesContainer.querySelector(".edit-images-header");
        if (header) {
            header.innerHTML = `<strong>Images (${remainingImages.length}):</strong>`;
        }

        const grid = imagesContainer.querySelector(".edit-images-grid");
        if (grid) {
            grid.innerHTML = ""; // Clear existing previews

            // Regenerate image previews with new indices
            remainingImages.forEach((imageData, idx) => {
                const imagePreview = document.createElement("div");
                imagePreview.className = "edit-image-preview";
                imagePreview.dataset.imageIndex = idx;

                const img = document.createElement("img");
                img.src = `data:${imageData.mimeType};base64,${imageData.imageData}`;
                img.style.maxWidth = "150px";
                img.style.maxHeight = "150px";
                img.style.border = "1px solid #666";
                img.style.borderRadius = "4px";

                // Add remove button
                const removeBtn = document.createElement("button");
                removeBtn.className = "edit-image-remove";
                removeBtn.innerHTML = '<span class="x-icon"></span>';
                removeBtn.title = "Remove this image";
                removeBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.removeImageFromEdit(messageContainer, idx);
                });

                imagePreview.appendChild(img);
                imagePreview.appendChild(removeBtn);
                grid.appendChild(imagePreview);
            });
        }
    }

    enterMessageEditMode(turnDiv, messages, turnNumber) {
        turnDiv.classList.add("editing");

        // Store original child elements
        const originalElements = Array.from(turnDiv.children);
        turnDiv._originalElements = originalElements;

        // Create edit container
        const editContainer = document.createElement("div");
        editContainer.className = "message-edit-container";

        // Add header
        const header = document.createElement("div");
        header.className = "edit-header";
        header.innerHTML = `<h3>Edit Turn ${turnNumber} Messages</h3>`;
        editContainer.appendChild(header);

        // Create edit form for each message
        const editForm = document.createElement("div");
        editForm.className = "edit-form";

        messages.forEach((message, index) => {
            const messageContainer = document.createElement("div");
            messageContainer.className = "editable-message";
            messageContainer.dataset.messageId = message.id;

            // Message header
            const messageHeader = document.createElement("div");
            messageHeader.className = "message-header";
            messageHeader.innerHTML = `<strong>${message.role}</strong> (ID: ${message.id})`;
            messageContainer.appendChild(messageHeader);

            // Handle multimodal content properly - parse JSON strings if needed
            let textContent = "";
            let images = [];
            let files = []; // Extract files from separated structure
            let parsedContent = message.content;
            let reasoningContent = message.reasoning || ""; // Get reasoning if present

            // Check if we have original_content with separated files
            if (message.original_content) {
                parsedContent = message.original_content;
                console.log(`[EDIT] Using original_content for message ${message.id}:`, parsedContent);
            }

            // Parse JSON string if content is a string that looks like JSON
            if (typeof message.content === "string" && message.content.startsWith("[")) {
                try {
                    parsedContent = JSON.parse(message.content);
                } catch (e) {
                    // If parsing fails, treat as regular text
                    parsedContent = message.content;
                }
            }

            if (Array.isArray(parsedContent)) {
                // Multimodal content - extract text, images, and files
                const textPart = parsedContent.find((part) => part.type === "text");
                textContent = textPart ? textPart.text : "";
                images = parsedContent.filter((part) => part.type === "image");

                // Extract files from separated structure
                const filesPart = parsedContent.find((part) => part.type === "files");
                if (filesPart && filesPart.files && Array.isArray(filesPart.files)) {
                    files = filesPart.files;
                    console.log(`[EDIT] Extracted ${files.length} file(s) from message ${message.id}`);
                }
            } else {
                // Regular text content
                textContent = parsedContent || "";
            }

            // Images will be shown via updateImagesDisplay after drag/drop setup

            // Add reasoning textarea if reasoning exists
            if (reasoningContent && reasoningContent.trim()) {
                const reasoningSection = document.createElement("div");
                reasoningSection.className = "edit-content-section";

                const reasoningLabel = document.createElement("label");
                reasoningLabel.className = "edit-content-label";
                reasoningLabel.textContent = "Reasoning:";
                reasoningSection.appendChild(reasoningLabel);

                const reasoningTextarea = document.createElement("textarea");
                reasoningTextarea.className = "message-reasoning-textarea";
                reasoningTextarea.value = reasoningContent;
                reasoningTextarea.rows = Math.max(3, reasoningContent.split("\n").length + 1);
                reasoningTextarea.placeholder = "Edit reasoning content";
                reasoningSection.appendChild(reasoningTextarea);

                messageContainer.appendChild(reasoningSection);
            }

            // Content section
            const contentSection = document.createElement("div");
            contentSection.className = "edit-content-section";

            const contentLabel = document.createElement("label");
            contentLabel.className = "edit-content-label";
            // For tool messages, show the linked tool call ID
            if (message.role === "tool") {
                contentLabel.textContent = `TOOL RESULT: ${message.tool_call_id}`;
            } else {
                contentLabel.textContent = "Content:";
            }
            contentSection.appendChild(contentLabel);

            const textarea = document.createElement("textarea");
            textarea.className = "message-content-textarea";
            textarea.value = textContent;
            textarea.rows = Math.max(3, textContent.split("\n").length + 1);
            // Update placeholder to reflect both images and files
            const attachmentInfo = [];
            if (images.length > 0) attachmentInfo.push(`${images.length} image(s)`);
            if (files.length > 0) attachmentInfo.push(`${files.length} file(s)`);

            textarea.placeholder =
                attachmentInfo.length > 0
                    ? `Edit text content (${attachmentInfo.join(" and ")} shown above)`
                    : "Enter message content";
            contentSection.appendChild(textarea);

            // Add image controls (file input + paperclip button + drag/drop area) at the bottom
            const imageControlsContainer = document.createElement("div");
            imageControlsContainer.className = "edit-image-controls";

            // Hidden file input
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = "*";
            fileInput.multiple = true;
            fileInput.style.display = "none";
            fileInput.addEventListener("change", (e) => {
                this.handleEditFileSelect(e, messageContainer);
            });

            // Paperclip button
            const addImageBtn = document.createElement("button");
            addImageBtn.type = "button";
            addImageBtn.className = "btn edit-add-image-btn";
            addImageBtn.innerHTML = "Add Files";
            addImageBtn.title = "Add files & images";
            addImageBtn.addEventListener("click", () => {
                fileInput.click();
            });

            imageControlsContainer.appendChild(fileInput);
            imageControlsContainer.appendChild(addImageBtn);
            contentSection.appendChild(imageControlsContainer);

            messageContainer.appendChild(contentSection);

            // Add tool calls section if message has tool calls (AFTER content)
            if (message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                // Create a container for all tool calls
                const allToolCallsContainer = document.createElement("div");
                allToolCallsContainer.className = "edit-tool-calls-container";

                for (let i = 0; i < message.tool_calls.length; i++) {
                    const toolCall = message.tool_calls[i];
                    const toolCallSection = document.createElement("div");
                    toolCallSection.className = "edit-content-section edit-tool-call-section";
                    toolCallSection.dataset.toolCallIndex = i;
                    toolCallSection.dataset.toolCallId = toolCall.id || "unknown";

                    // Header with ID and type dropdown
                    const toolCallHeader = document.createElement("div");
                    toolCallHeader.className = "edit-tool-call-header-row";

                    const toolCallIdLabel = document.createElement("label");
                    toolCallIdLabel.className = "edit-content-label";
                    toolCallIdLabel.textContent = `Tool Call: ${toolCall.id || "unknown"}`;
                    toolCallHeader.appendChild(toolCallIdLabel);

                    // Type dropdown
                    const typeDropdownContainer = document.createElement("div");
                    typeDropdownContainer.className = "edit-tool-call-type-dropdown";

                    const typeLabel = document.createElement("span");
                    typeLabel.className = "edit-tool-call-type-label";
                    typeLabel.textContent = "Type:";
                    typeDropdownContainer.appendChild(typeLabel);

                    const typeSelect = document.createElement("select");
                    typeSelect.className = "edit-tool-call-type-select";
                    typeSelect.dataset.toolCallType = "type";
                    const functionOption = document.createElement("option");
                    functionOption.value = "function";
                    functionOption.textContent = "function";
                    functionOption.selected = (toolCall.type === "function");
                    typeSelect.appendChild(functionOption);
                    typeDropdownContainer.appendChild(typeSelect);

                    toolCallHeader.appendChild(typeDropdownContainer);
                    toolCallSection.appendChild(toolCallHeader);

                    // Textarea for function object only
                    const functionObj = {
                        name: toolCall.function?.name || "",
                        arguments: toolCall.function?.arguments || ""
                    };
                    const functionJsonText = JSON.stringify(functionObj, null, 2);

                    const functionLabel = document.createElement("label");
                    functionLabel.className = "edit-content-label";
                    functionLabel.textContent = "Function:";
                    toolCallSection.appendChild(functionLabel);

                    const functionTextarea = document.createElement("textarea");
                    functionTextarea.className = "message-tool-call-function-textarea";
                    functionTextarea.value = functionJsonText;
                    functionTextarea.rows = Math.max(3, functionJsonText.split("\n").length + 1);
                    functionTextarea.placeholder = "Edit function (JSON format)";
                    toolCallSection.appendChild(functionTextarea);

                    allToolCallsContainer.appendChild(toolCallSection);
                }

                messageContainer.appendChild(allToolCallsContainer);
            }

            // Store original content structure for reconstruction
            // Ensure _originalContent is always an array for consistent handling
            if (Array.isArray(parsedContent)) {
                messageContainer._originalContent = parsedContent;
            } else {
                // Convert string content to array format
                messageContainer._originalContent = [{ type: "text", text: parsedContent || "" }];
            }
            messageContainer._hasImages = images.length > 0;
            messageContainer._hasFiles = files.length > 0;

            // Initialize files for edit modal
            if (!messageContainer._editDocuments) {
                messageContainer._editDocuments = [];
            }
            // Add extracted files to edit documents
            messageContainer._editDocuments.push(...files);

            console.log(`[EDIT-INIT] Initialized ${message.role} message:`, {
                originalFormat: typeof message.content,
                parsedFormat: typeof parsedContent,
                finalFormat: Array.isArray(messageContainer._originalContent)
                    ? "array"
                    : typeof messageContainer._originalContent,
                hasImages: messageContainer._hasImages,
                hasFiles: messageContainer._hasFiles,
                imageCount: images.length,
                fileCount: files.length
            });

            // Add drag & drop support to this message container
            this.setupEditDragAndDrop(messageContainer);

            // Display any existing images and files
            this.updateImagesDisplay(messageContainer);
            this.updateEditDocumentsDisplay(messageContainer); // Display extracted files

            editForm.appendChild(messageContainer);
        });

        editContainer.appendChild(editForm);

        // Add buttons
        const buttonContainer = document.createElement("div");
        buttonContainer.className = "edit-buttons";

        const saveBtn = document.createElement("button");
        saveBtn.className = "btn btn-success edit-btn-save";
        saveBtn.textContent = "Save All Messages";
        saveBtn.addEventListener("click", () => {
            this.saveAllMessages(turnDiv, editContainer, turnNumber);
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn btn-danger edit-btn-cancel";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => {
            this.cancelMessageEdit(turnDiv);
        });

        buttonContainer.appendChild(saveBtn);
        buttonContainer.appendChild(cancelBtn);
        editContainer.appendChild(buttonContainer);

        // Clear and add edit interface
        turnDiv.innerHTML = "";
        turnDiv.appendChild(editContainer);
    }

    // Save all edited messages
    async saveAllMessages(turnDiv, editContainer, turnNumber) {
        const messageContainers = editContainer.querySelectorAll(".editable-message");
        const saveBtn = editContainer.querySelector(".edit-btn-save");

        try {
            saveBtn.textContent = "Saving...";
            saveBtn.disabled = true;

            // Check if this is an "Edit & Retry" - if so, do not PATCH the
            // originals; the carry-forward in exitMessageEditMode is the edit.
            const isEditRetry = turnDiv.dataset.shouldRetryAfterEdit === "true";

            if (!isEditRetry) {
                // Collect ALL message edits into a single array and send one
                // PATCH — one user action, one version entry.
                const allEdits = [];

                for (const container of messageContainers) {
                    const messageId = parseInt(container.dataset.messageId, 10);
                    const textarea = container.querySelector(".message-content-textarea");
                    const reasoningTextarea = container.querySelector(".message-reasoning-textarea");
                    const newTextContent = textarea ? textarea.value : "";
                    const newReasoningContent = reasoningTextarea ? reasoningTextarea.value : null;

                    // Parse tool calls from individual sections
                    let newToolCalls = null;
                    const toolCallSections = container.querySelectorAll(".edit-tool-call-section");
                    if (toolCallSections.length > 0) {
                        newToolCalls = [];
                        for (const section of toolCallSections) {
                            const toolCallId = section.dataset.toolCallId;
                            const typeSelect = section.querySelector(".edit-tool-call-type-select");
                            const functionTextarea = section.querySelector(".message-tool-call-function-textarea");

                            const toolCallType = typeSelect?.value || "function";
                            let functionObj;
                            try {
                                functionObj = JSON.parse(functionTextarea.value);
                            } catch (e) {
                                console.error("[EDIT-SAVE] Error parsing tool call function JSON:", e);
                                showError(`Invalid tool call function JSON: ${e.message}`);
                                throw e;
                            }

                            newToolCalls.push({
                                id: toolCallId,
                                type: toolCallType,
                                function: functionObj
                            });
                        }
                    }

                    // Reconstruct content
                    let finalContent;
                    if (Array.isArray(container._originalContent)) {
                        const reconstructedArray = [];
                        if (newTextContent) {
                            reconstructedArray.push({ type: "text", text: newTextContent });
                        }
                        const images = container._originalContent.filter((part) => part.type === "image");
                        reconstructedArray.push(...images);
                        if (container._editDocuments && container._editDocuments.length > 0) {
                            reconstructedArray.push({
                                type: "files",
                                files: container._editDocuments
                            });
                        }
                        const hasMultipleTypes =
                            reconstructedArray.length > 1 ||
                            reconstructedArray.some((part) => part.type !== "text");
                        finalContent = hasMultipleTypes ? reconstructedArray : newTextContent;
                    } else {
                        finalContent = newTextContent;
                    }

                    const edit = { id: messageId, content: finalContent };
                    if (newReasoningContent !== null) {
                        edit.reasoning = newReasoningContent;
                    }
                    if (newToolCalls) {
                        edit.tool_calls = newToolCalls;
                    }
                    allEdits.push(edit);
                }

                // Use the first message's ID — any message in the turn works,
                // the backend only uses it to look up the turn_id.
                if (allEdits.length > 0) {
                    await editMessage(allEdits[0].id, allEdits);
                }
            }

            // Exit edit mode. For edit-retry this carries the messages forward
            // into a new turn_id; for plain edit it just closes the editor.
            // The edit indicator is drawn by renderTurn from the DB's
            // edit_count, so reload/branch switch persist it.
            await this.exitMessageEditMode(turnDiv, turnNumber, isEditRetry);
        } catch (error) {
            console.error("[EDIT] Error saving messages:", error);
            showError(`Error saving messages: ${error.message}`);

            saveBtn.textContent = "Save All Messages";
            saveBtn.disabled = false;
        }
    }

    // Cancel message editing
    cancelMessageEdit(turnDiv) {
        // Restore original elements
        turnDiv.innerHTML = "";
        if (turnDiv._originalElements) {
            turnDiv._originalElements.forEach((element) => {
                turnDiv.appendChild(element);
            });
            delete turnDiv._originalElements;
        }
        turnDiv.classList.remove("editing");
    }

    // Exit edit mode and reload the turn with updated content
    async exitMessageEditMode(turnDiv, turnNumber, isEditRetry = false) {
        try {
            // Check if this was an Edit & Retry
            const shouldRetry = isEditRetry === true;
            const retryTurnNumber = shouldRetry ? parseInt(turnDiv.dataset.editRetryTurnNumber) : null;
            const retryTurnId = shouldRetry ? (turnDiv.dataset.editRetryTurnId || null) : null;

            turnDiv.classList.remove("editing");

            if (shouldRetry && retryTurnNumber) {
                // Clear the retry flags
                delete turnDiv.dataset.shouldRetryAfterEdit;
                delete turnDiv.dataset.editRetryTurnNumber;
                delete turnDiv.dataset.editRetryTurnId;

                // The modal is the source of truth. Collect every container's
                // content + role and carry all of them forward to the new
                // turn_id as sibling rows. No "first" / no role assumption.
                const messageContainers = turnDiv.querySelectorAll(".editable-message");
                const carriedForward = [];
                for (const container of messageContainers) {
                    const textarea = container.querySelector(".message-content-textarea");
                    if (!textarea) continue;
                    const messageId = container.dataset.messageId
                        ? parseInt(container.dataset.messageId, 10)
                        : null;
                    const role =
                        container._role ||
                        container.querySelector(".message-header strong")?.textContent ||
                        "user";
                    const newTextContent = textarea.value;

                    // Reconstruct content with separated structure (like main chat)
                    let content;
                    if (Array.isArray(container._originalContent)) {
                        const reconstructedArray = [];
                        if (newTextContent) {
                            reconstructedArray.push({ type: "text", text: newTextContent });
                        }
                        const images = container._originalContent.filter((part) => part.type === "image");
                        reconstructedArray.push(...images);
                        if (container._editDocuments && container._editDocuments.length > 0) {
                            reconstructedArray.push({
                                type: "files",
                                files: container._editDocuments
                            });
                        }
                        const hasMultipleTypes =
                            reconstructedArray.length > 1 ||
                            reconstructedArray.some((part) => part.type !== "text");
                        content = hasMultipleTypes ? reconstructedArray : newTextContent;
                    } else {
                        content = newTextContent;
                    }
                    carriedForward.push({ messageId, role, content });
                }

                if (carriedForward.length === 0) {
                    console.error("[EDIT-RETRY] No message containers found in UI");
                    return;
                }

                // Get the parent_turn_id from history for the new lineage
                const history = await getChatHistory(currentChatId);
                const requestMsg = (history.messages || []).find(
                    (m) => m.role === "user" && m.turn_number === retryTurnNumber && m.turn_id === retryTurnId
                );
                const originalParentTurnId = requestMsg?.parent_turn_id || null;

                const turnRequest = new TurnRequest({
                    message: null,
                    parentTurnId: originalParentTurnId,
                    turnId: retryTurnId,
                    requestTurnNumber: retryTurnNumber,
                    requestOrigin: "edit_retry",
                    truncateFromTurnNumber: retryTurnNumber,
                    truncateContainer: this.container,
                    chatId: currentChatId,
                    carriedForward: carriedForward,
                    originalParentTurnId: originalParentTurnId,
                });
                await turnRequest.execute();
            } else {
                // Regular edit — reload chat. The render path reads
                // edit_count from the DB and adds the edit indicator on
                // the freshly-rendered turn, so no explicit addEditIndicator
                // call is needed here.
                await loadChatHistory(currentChatId);
            }
        } catch (error) {
            console.error("[EDIT] Error in exitMessageEditMode:", error);
            // Surface save failures to the user.
            showError(`Edit & retry failed: ${error.message}`);
        }
    }

    // Handle message metadata (preview, title generation)
    handleTurnMeta(role, content) {
        if (role === "user" || role === "assistant") {
            updateChatPreview(currentChatId, content);

            // Auto-generate chat title from first user message
            if (role === "user") {
                const chatItem = document.querySelector(`[data-chat-id="${currentChatId}"]`);
                if (chatItem) {
                    const currentTitle = chatItem.querySelector(".chat-item-title").textContent;
                    if (currentTitle === "New Chat") {
                        const textContent = this.getTextContent(content);
                        const newTitle = textContent.substring(0, 30) + (textContent.length > 30 ? "..." : "");
                        updateChatTitle(newTitle);
                    }
                }
            }
        }
    }

    // Extract plain text from blocks for preview/title generation
    extractTextFromBlocks(blocks) {
        if (!blocks) return "";
        return blocks
            .filter((block) => block.type === "chat")
            .map((block) => block.content)
            .join(" ");
    }

    // ===== BRANCH NAVIGATION SYSTEM =====
    // Update branch navigation
    async updateBranchNavigation(branchNavElement, turnNumber, turnData = null, branchMap = null) {
        if (!currentChatId || !turnNumber) {
            branchNavElement.style.display = "none";
            return;
        }

        try {
            const parentTurnId = turnData?.parentTurnId;
            const role = turnData?.role;
            const currentTurnId = turnData?.turnId;

            if (parentTurnId === undefined || !role) {
                branchNavElement.style.display = "none";
                return false;
            }

            let sortedSiblings;

            if (branchMap && currentTurnId) {
                if (branchMap.has(currentTurnId)) {
                    const info = branchMap.get(currentTurnId);
                    sortedSiblings = info.siblings.map((id) => [id, [{ turn_id: id }]]);
                } else {
                    branchNavElement.style.display = "none";
                    return false;
                }
            } else {
                const history = await getChatHistory(currentChatId);
                if (!history?.messages) {
                    branchNavElement.style.display = "none";
                    return false;
                }

                const siblingTurns = new Map();
                for (const msg of history.messages) {
                    if (msg.role === "system") continue;
                    if (msg.parent_turn_id === parentTurnId) {
                        const key = `${msg.turn_number || 0}::${msg.turn_id || "unknown"}`;
                        if (!siblingTurns.has(key)) {
                            siblingTurns.set(key, []);
                        }
                        siblingTurns.get(key).push(msg);
                    }
                }

                sortedSiblings = Array.from(siblingTurns.entries()).sort(([a], [b]) => {
                    const [aTurn] = a.split("::");
                    const [bTurn] = b.split("::");
                    return parseInt(aTurn) - parseInt(bTurn);
                });
            }

            if (sortedSiblings.length <= 1) {
                branchNavElement.style.display = "none";
                return false;
            }

            // Find current sibling index
            let currentIndex = -1;
            for (let i = 0; i < sortedSiblings.length; i++) {
                const [, msgs] = sortedSiblings[i];
                if (msgs[0]?.turn_id === currentTurnId) {
                    currentIndex = i;
                    break;
                }
            }

            if (currentIndex === -1) {
                currentIndex = 0;
            }

            // Update navigation elements
            const prevBtn = branchNavElement.querySelector(".branch-prev");
            const nextBtn = branchNavElement.querySelector(".branch-next");
            const indicator = branchNavElement.querySelector(".branch-indicator");

            prevBtn.disabled = currentIndex <= 0;
            nextBtn.disabled = currentIndex >= sortedSiblings.length - 1;
            indicator.textContent = `${currentIndex + 1}/${sortedSiblings.length}`;

            // Store sibling data for navigation
            branchNavElement._siblings = sortedSiblings;
            branchNavElement._currentIndex = currentIndex;
            branchNavElement._turnNumber = turnNumber;

            // Show navigation
            branchNavElement.style.display = "flex";
            branchNavElement.style.alignItems = "center";
            branchNavElement.style.gap = "6px";
            branchNavElement.style.marginLeft = "10px";

            return true;
        } catch (error) {
            console.error(`[BRANCH-NAV] Error updating navigation:`, error);
            branchNavElement.style.display = "none";
            return false;
        }
    }

    // Navigate to previous/next sibling turn
    async navigateBranch(direction, branchNavElement = null) {
        let targetBranchNav = branchNavElement;

        // Fallback to finding any branch nav element if none provided
        if (!targetBranchNav) {
            const branchNavElements = document.querySelectorAll(".branch-nav");
            for (const nav of branchNavElements) {
                if (nav._siblings && nav._currentIndex !== undefined) {
                    targetBranchNav = nav;
                    break;
                }
            }
        }

        if (!targetBranchNav || !targetBranchNav._siblings) {
            console.error("[BRANCH-NAV] No sibling data found for navigation");
            return;
        }

        const siblings = targetBranchNav._siblings;
        const currentIndex = targetBranchNav._currentIndex;

        let newIndex;
        if (direction === "prev") {
            newIndex = Math.max(0, currentIndex - 1);
        } else if (direction === "next") {
            newIndex = Math.min(siblings.length - 1, currentIndex + 1);
        } else {
            return;
        }

        if (newIndex === currentIndex) {
            return;
        }

        const targetSibling = siblings[newIndex];
        const targetTurnId = targetSibling[1][0]?.turn_id;

        // Get the parent_turn_id from the turn element
        const turnElement = targetBranchNav.closest(".turn");
        const parentTurnId = turnElement?.dataset?.parentTurnId;

        // Update the nav element state
        targetBranchNav._currentIndex = newIndex;
        const indicator = targetBranchNav.querySelector(".branch-indicator");
        indicator.textContent = `${newIndex + 1}/${siblings.length}`;
        targetBranchNav.querySelector(".branch-prev").disabled = newIndex <= 0;
        targetBranchNav.querySelector(".branch-next").disabled = newIndex >= siblings.length - 1;

        // Update per-chat sibling selection. Key matches the scoped read format.
        const parentKey = parentTurnId || "root";
        selectedSiblings[`${currentChatId}::${parentKey}`] = targetTurnId;

        // Persist the selection to the DB so it survives reloads.
        // Errors throw.
        const scopedMap = Object.fromEntries(
            Object.entries(selectedSiblings).filter(([k]) => k.startsWith(`${currentChatId}::`))
        );
        await saveBranchSelections(currentChatId, scopedMap);

        // Re-render the chat history with the new sibling selected
        await loadChatHistory(currentChatId);

        // Scroll to the selected turn. The await on loadChatHistory
        // guarantees the DOM is ready.
        const targetTurn = document.querySelector(`[data-turn-id="${targetTurnId}"]`);
        if (targetTurn) {
            targetTurn.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }
}

// Global renderer instance
let chatRenderer = null;

// Initialize renderer when DOM is ready
function initializeChatRenderer() {
    const turnsContainer = document.getElementById("messages");
    if (turnsContainer) {
        chatRenderer = new ChatRenderer(turnsContainer);
        logger.info("[RENDERER] ChatRenderer initialized");
    }
}

// Ensure renderer is initialized
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeChatRenderer);
} else {
    initializeChatRenderer();
}

// Create debug panel DOM element using sequential debug system
function createDebugPanel(turnDiv, messageId, debugData, turnNumber = null) {
    const debugPanel = document.createElement("div");
    debugPanel.className = "debug-panel-container";
    debugPanel.dataset.messageId = messageId;
    debugPanel.style.display = "none"; // Initially hidden
    debugPanel.style.width = "100%";
    debugPanel.style.boxSizing = "border-box";

    // Inject correct turn number and turn ID from frontend
    if (turnNumber !== null && debugData) {
        debugData.currentTurnNumber = turnNumber;
    }

    // Add turn ID and message ID to debug data
    if (!debugData) {
        debugData = {};
    }
    debugData.turnId = turnDiv.closest(".turn")?.dataset.turnId || "unknown";
    debugData.messageId = messageId || "unknown";

    // Use the new sequential debug panel
    debugPanel.innerHTML = createDebugPanelContent(debugData);

    // Force width on all debug dropdowns synchronously.
    const dropdowns = debugPanel.querySelectorAll(".debug-dropdown");
    dropdowns.forEach((dropdown) => {
        dropdown.style.width = "100%";
        dropdown.style.boxSizing = "border-box";

        const content = dropdown.querySelector(".debug-dropdown-content");
        if (content) {
            content.style.width = "100%";
            content.style.boxSizing = "border-box";

            const pre = content.querySelector("pre");
            if (pre) {
                pre.style.width = "100%";
                pre.style.boxSizing = "border-box";
            }
        }
    });

    return debugPanel;
}
