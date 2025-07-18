// ChatRenderer.js

class ChatRenderer {
    constructor(containerElement) {
        this.container = containerElement;
    }
    
    // Main render method - handles only blocks - no more content parsing
    renderTurn(turnData, shouldScroll = true) {
        const {
            id,
            role,
            blocks,
            content,
            debug_data,
            dropdownStates = {},
            original_content,
            turn_number,
            edit_count,
            edited_at
        } = turnData;
        
        // Check if this turn already exists in DOM
        const existingTurns = document.querySelectorAll(`[data-turn-number="${turn_number}"]`);
        if (existingTurns.length > 0 && role === "assistant") {
            console.warn(
                `[DUPLICATE-GUARD] Turn ${turn_number} already exists in DOM! Found ${existingTurns.length} existing turns - SKIPPING RENDER`
            );
            return existingTurns[0]; // Return existing turn instead of creating duplicate
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
        const turnId = `turn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Use the new turn-based class names
        if (role === "user") {
            turnDiv.className = "turn user-turn";
        } else if (role === "assistant") {
            turnDiv.className = "turn assistant-turn";
        } else {
            turnDiv.className = `turn ${role}-turn`; // Fallback for other roles
        }
        
        turnDiv.dataset.turnId = turnId;
        if (id) {
            turnDiv.dataset.messageId = id;
        }
        if (turn_number) {
            turnDiv.dataset.turnNumber = turn_number;
        }
        
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
        
        // Add message actions bar
        this.addMessageActions(turnDiv, role, turnId, turn_number, id);
        
        // Add debug toggle and panel if debug data provided
        if (debug_data) {
            this.addDebugPanel(turnDiv, turnId, debug_data, turn_number);
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
    }
    
    // Create message element without appending to container (for seamless replacement)
    createTurnElement(turnData, shouldScroll = true) {
        const { id, role, blocks, content, debug_data, dropdownStates = {}, turn_number } = turnData;
        
        // If blocks aren't provided, we have a broken pipeline
        let finalBlocks;
        if (!blocks) {
            console.error("[BROKEN-RENDER] No blocks provided for element creation:", turnData);
            throw new Error("Blocks are required for element creation - 3rd rendering path has been removed");
        } else {
            finalBlocks = blocks;
        }
        
        const turnDiv = document.createElement("div");
        const turnId = `turn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Use the new turn-based class names
        if (role === "user") {
            turnDiv.className = "turn user-turn";
        } else if (role === "assistant") {
            turnDiv.className = "turn assistant-turn";
        } else {
            turnDiv.className = `turn ${role}-turn`; // Fallback for other roles
        }
        
        turnDiv.dataset.turnId = turnId;
        if (turn_number) {
            turnDiv.dataset.turnNumber = turn_number;
        }
        
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
        
        // Add message actions bar
        this.addMessageActions(turnDiv, role, turnId, turn_number, id);
        
        // Add debug toggle and panel if debug data provided
        if (debug_data) {
            this.addDebugPanel(turnDiv, turnId, debug_data, turn_number);
        }
        
        // Handle metadata but don't scroll yet
        this.handleTurnMeta(
            role,
            finalBlocks
                .filter((b) => b.type === "chat")
                .map((b) => b.content)
                .join(" ")
        );
        
        return turnDiv;
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
            code.innerHTML = window.SimpleSyntax ? SimpleSyntax.highlight(content, metadata.language) : escapeHtml(content);
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
    
    // Copy code content to clipboard, stripping markdown backticks
    copyCodeToClipboard(content) {
        // Remove leading/trailing backticks and language identifier
        let cleanContent = content;
        
        // Remove opening backticks and language (e.g., "```python\n")
        cleanContent = cleanContent.replace(/^```[a-zA-Z]*\n?/, '');
        
        // Remove closing backticks
        cleanContent = cleanContent.replace(/\n?```$/, '');
        
        // Copy to clipboard
        navigator.clipboard.writeText(cleanContent).then(() => {
            // Provide visual feedback
            const copyBtns = document.querySelectorAll('.code-copy-btn');
            copyBtns.forEach(btn => {
                if (btn.textContent === 'Copy') {
                    const originalText = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(() => {
                        btn.textContent = originalText;
                    }, 1000);
                }
            });
        }).catch(err => {
            console.error('Failed to copy code:', err);
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
        if (typeof content === 'string' && content.startsWith('[')) {
            try {
                processedContent = JSON.parse(content);
            } catch (e) {
                // If parsing fails, treat as regular text
                processedContent = content;
            }
        }
        
        // Handle multimodal content (array) or simple text content (string)
        if (Array.isArray(processedContent)) {
            // Multimodal content - render each part
            processedContent.forEach(part => {
                switch (part.type) {
                    case 'text':
                        if (part.text !== undefined && part.text !== null && part.text !== '') {
                            const textDiv = document.createElement('div');
                            textDiv.className = 'content-part text-part';
                            textDiv.innerHTML = formatMessage(escapeHtml(part.text));
                            div.appendChild(textDiv);
                        }
                        break;
                    
                    case 'image':
                        const imageDiv = document.createElement('div');
                        imageDiv.className = 'content-part image-part';
                        
                        const img = document.createElement('img');
                        img.src = `data:${part.mimeType};base64,${part.imageData}`;
                        img.className = 'message-image';
                        img.loading = 'lazy';
                        img.onclick = () => this.openImageModal(img.src);
                        
                        imageDiv.appendChild(img);
                        div.appendChild(imageDiv);
                        break;
                    
                    case 'files':
                        if (part.files && Array.isArray(part.files) && part.files.length > 0) {
                            const filesDiv = document.createElement('div');
                            filesDiv.className = 'content-part files-part';
                            
                            part.files.forEach(file => {
                                const filePreview = document.createElement('div');
                                filePreview.className = 'file-attachment';
                                
                                const icon = document.createElement('span');
                                icon.className = 'file-icon';
                                icon.textContent = getFileIcon(file.fileName);
                                
                                const info = document.createElement('div');
                                info.className = 'file-info';
                                
                                const name = document.createElement('div');
                                name.className = 'file-name';
                                name.textContent = file.fileName;
                                name.title = file.fileName;
                                
                                const size = document.createElement('div');
                                size.className = 'file-size';
                                size.textContent = `${(file.size / 1024).toFixed(1)}KB`;
                                
                                info.appendChild(name);
                                info.appendChild(size);
                                
                                filePreview.appendChild(icon);
                                filePreview.appendChild(info);
                                
                                // Add click handler to show file content
                                filePreview.style.cursor = 'pointer';
                                filePreview.addEventListener('click', () => {
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
                        console.warn('Unknown content part type:', part.type);
                        break;
                }
            });
        } else {
            // Simple text content (backward compatible)
            div.innerHTML = formatMessage(escapeHtml(String(processedContent || '')));
        }
        
        return div;
    }
    
    // Open image in modal for full view
    openImageModal(imageSrc) {
        // Create modal if it doesn't exist
        let modal = document.getElementById('imageModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'imageModal';
            modal.className = 'image-modal hidden';
            
            const img = document.createElement('img');
            img.id = 'modalImage';
            modal.appendChild(img);
            
            // Close modal on click
            modal.addEventListener('click', () => {
                modal.classList.add('hidden');
            });
            
            // Close modal on Escape key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
                    modal.classList.add('hidden');
                }
            });
            
            document.body.appendChild(modal);
        }
        
        // Set image and show modal
        const modalImg = document.getElementById('modalImage');
        modalImg.src = imageSrc;
        modal.classList.remove('hidden');
    }
    
    // Simple phase marker rendering - no more complexity!
    renderPhaseMarkerBlock(content, metadata) {
        const settings = loadSettings();
        
        const div = document.createElement("div");
        div.className = "conductor-phase-marker";
        div.innerHTML = `
            <div class="phase-marker-content">
                <span class="phase-text">${escapeHtml(content)}</span>
            </div>
        `;
        
        // Apply visibility setting
        if (!settings.showPhaseMarkers) {
            div.style.display = "none";
        }
        
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
    addMessageActions(turnDiv, role, turnId, turnNumber = null, messageId = null) {
        const actionsContainer = document.createElement("div");
        actionsContainer.className = "message-actions";
        actionsContainer.dataset.turnId = turnId;
        actionsContainer.dataset.role = role;
        actionsContainer.dataset.turnNumber = turnNumber;
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
            this.updateBranchNavigation(branchNav, turnNumber).catch((error) => {
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
            
            const turnMessages = response.messages;
            
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
        }
        
        // Call the regular edit function - it will use the proper modal
        await this.handleEditMessage(turnId, role, turnNumber, messageId);
    }
    
    async handleRetryMessage(turnId, role, turnNumber, messageId) {
        // Only allow retry for assistant messages
        if (role !== "assistant") {
            return;
        }
        
        if (!turnNumber) {
            console.error("[RETRY] Cannot retry: Turn number not available");
            return;
        }
        
        try {
            // Show loading state
            const turnDiv = document.querySelector(`[data-turn-id="${turnId}"]`);
            if (turnDiv) {
                const retryBtn = turnDiv.querySelector(".retry-btn");
                if (retryBtn) {
                    retryBtn.textContent = "Retrying...";
                    retryBtn.disabled = true;
                }
            }
            
            // 1. Create new branch with truncated history (backend handles this)
            const branchInfo = await retryTurn(currentChatId, turnNumber);
            
            // 2. Get the chat history to find the last user message (before truncation)
            const history = await getChatHistory(currentChatId);
            const allMessages = history.messages || [];
            
            // Find the last user message in the truncated history
            const userMessages = allMessages.filter((msg) => msg.role === "user");
            if (userMessages.length === 0) {
                console.error("[RETRY] No user messages found in truncated history");
                return;
            }
            
            const lastUserMessage = userMessages[userMessages.length - 1];
            
            // 3. Truncate UI to show only messages up to the last user message
            // Remove all turns after the user turn we're retrying from
            const allTurns = this.container.querySelectorAll(".turn");
            let foundRetryPoint = false;
            
            for (let i = allTurns.length - 1; i >= 0; i--) {
                const turn = allTurns[i];
                const turnTurnNumber = parseInt(turn.dataset.turnNumber);
                
                if (turnTurnNumber >= turnNumber) {
                    turn.remove();
                    foundRetryPoint = true;
                }
            }
            
            if (!foundRetryPoint) {
                console.warn(`[RETRY] Could not find turn ${turnNumber} to truncate from`);
            }
            
            // 4. Generate assistant response using the same pattern as simpleChatMode
            const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            await loadEnabledToolsFromBackend(); // Ensure cache is loaded
            const enabledToolsFlags = loadEnabledTools(); // Get flags like {"server.tool": false}
            
            const requestInfo = initiateMessageRequest(
                lastUserMessage.content,
                false,
                enabledToolsFlags,
                null,
                null,
                false,
                false,
                requestId
            );
            const response = await requestInfo.fetchPromise;
            
            // 5. Process the streaming response like normal chat
            await this.processRetryResponse(response, currentChatId, turnNumber, requestId);
            
            // 6. Update branch navigation for all turns after retry
            // Give a small delay to ensure the DOM has been updated
            setTimeout(async () => {
                await this.refreshBranchNavigation();
            }, 100); // Shorter delay since we're not reloading everything
        } catch (error) {
            console.error("[RETRY] Error:", error);
        } finally {
            // Restore button state
            const turnDiv = document.querySelector(`[data-turn-id="${turnId}"]`);
            if (turnDiv) {
                const retryBtn = turnDiv.querySelector(".retry-btn");
                if (retryBtn) {
                    retryBtn.textContent = "Retry";
                    retryBtn.disabled = false;
                }
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
            if (result.edit_count > 1) {
                this.addEditIndicator(turnDiv, result.edit_count);
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
    
    // Add visual indicator that message was edited
    addEditIndicator(turnDiv, editCount) {
        // Remove existing indicator
        const existing = turnDiv.querySelector(".edit-indicator");
        if (existing) {
            existing.remove();
        }
        
        // Add new indicator
        const indicator = document.createElement("span");
        indicator.className = "edit-indicator";
        indicator.textContent = `(edited ${editCount}x)`;
        indicator.title = "This message has been edited";
        
        // Insert after the turn content
        const turnContent = turnDiv.querySelector(".turn-content");
        if (turnContent) {
            turnContent.appendChild(indicator);
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
            
            // Get current chat history to find the message
            const response = await fetch(`${apiBase}/api/chat/${chatId}/history`);
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
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            // Extract text from multimodal array
            const textPart = content.find(part => part.type === 'text');
            return textPart ? textPart.text : '[Images only]';
        }
        return String(content || '');
    }
    
    // Create blocks from content (for assistant messages that don't have blocks)
    createBlocksFromContent(content) {
        if (!content) {
            return [{ type: "chat", content: "", metadata: {} }];
        }
        
        // If content is already a string, create a simple chat block
        if (typeof content === 'string') {
            return [{ type: "chat", content: content, metadata: {} }];
        }
        
        // If content is an array (multimodal), convert to appropriate blocks
        if (Array.isArray(content)) {
            const blocks = [];
            
            content.forEach(part => {
                if (part.type === 'text' && part.text) {
                    blocks.push({ type: "chat", content: part.text, metadata: {} });
                } else if (part.type === 'image') {
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
            console.warn('[IMAGE-REMOVE] Cannot remove image - content is not multimodal', messageContainer._originalContent);
            return;
        }
        
        // Remove the image from the original content array
        let imageCount = 0;
        messageContainer._originalContent = messageContainer._originalContent.filter(part => {
            if (part.type === 'image') {
                if (imageCount === imageIndex) {
                    imageCount++;
                    return false; // Remove this image
                }
                imageCount++;
            }
            return true; // Keep text parts and other images
        });
        
        // Update the hasImages flag
        const remainingImages = messageContainer._originalContent.filter(part => part.type === 'image');
        messageContainer._hasImages = remainingImages.length > 0;
        
        // Update the textarea placeholder
        const textarea = messageContainer.querySelector('.message-content-textarea');
        if (textarea) {
            textarea.placeholder = remainingImages.length > 0 ? 
                "Edit text content (images shown above)" : 
                "Enter message content";
        }
        
        // Regenerate the images display
        this.updateImagesDisplay(messageContainer);
        
        console.log(`[IMAGE-REMOVE] Removed image ${imageIndex}, ${remainingImages.length} images remaining`);
    }
    
    // Handle file selection in edit modal
    handleEditImageSelect(event, messageContainer) {
        const files = Array.from(event.target.files);
        this.handleEditImageFiles(files, messageContainer, 'file');
        // Clear the input so the same file can be selected again
        event.target.value = '';
    }
    
    // Handle image files in edit modal (similar to main handleImageFiles)
    handleEditImageFiles(files, messageContainer, source = 'file') {
    const imageFiles = files.filter(file => file.type.startsWith('image/'));

    if (imageFiles.length === 0) {
        console.warn('[EDIT-IMAGES] No valid image files selected');
        return;
    }

    if (source === 'paste' || source === 'clipboard') {
        const textarea = messageContainer.querySelector('.message-content-textarea');
        if (textarea) {
            const originalPlaceholder = textarea.placeholder;
            textarea.placeholder = `✓ Pasted ${imageFiles.length} image${imageFiles.length > 1 ? 's' : ''}`;
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
                type: 'image',
                imageData: processedImage.data, // Convert 'data' to 'imageData'
                mimeType: processedImage.mimeType,
                name: processedImage.name,
                size: processedImage.size
            };

            if (!Array.isArray(messageContainer._originalContent)) {
                const currentText = messageContainer.querySelector('.message-content-textarea').value;
                messageContainer._originalContent = [
                    { type: 'text', text: currentText }
                ];
                console.warn('[EDIT-IMAGES] Had to convert _originalContent to array format');
            }

            messageContainer._originalContent.push(imageData);
            messageContainer._hasImages = true;

            const textarea = messageContainer.querySelector('.message-content-textarea');
            if (textarea) {
                textarea.placeholder = "Edit text content (images shown above)";
            }

            processedCount++;
            if (processedCount === imageFiles.length) {
                this.updateImagesDisplay(messageContainer);
            }

            console.log(`[EDIT-IMAGES] Added image: ${processedImage.name} (${(processedImage.originalSize / 1024).toFixed(1)}KB → ${(processedImage.size / 1024).toFixed(1)}KB)`);

        } catch (error) {
            console.error(`[EDIT-IMAGES] Error processing image ${file.name}:`, error);
        }
    });
}
    
    // Setup drag & drop for edit modal message container
    setupEditDragAndDrop(messageContainer) {
        // Drag & drop support
        messageContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            messageContainer.classList.add('drag-over');
        });
        
        messageContainer.addEventListener('dragleave', (e) => {
            e.preventDefault();
            // Only remove drag-over if we're actually leaving the container
            if (!messageContainer.contains(e.relatedTarget)) {
                messageContainer.classList.remove('drag-over');
            }
        });
        
        messageContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            messageContainer.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
                this.handleEditFiles(files, messageContainer, 'drop');
            }
        });
        
        // Clipboard paste support
        const textarea = messageContainer.querySelector('.message-content-textarea');
        if (textarea) {
            textarea.addEventListener('paste', (e) => {
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
            if (item.kind === 'file') {
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
            this.handleEditFiles(pastedFiles, messageContainer, 'paste');
            console.log(`[EDIT-FILES] Pasted ${pastedFiles.length} file(s) from clipboard`);
        }
    }
    
    // Handle file selection in edit modal (images + documents)
    handleEditFileSelect(event, messageContainer) {
        const files = Array.from(event.target.files);
        this.handleEditFiles(files, messageContainer, 'file');
        // Clear the input so the same file can be selected again
        event.target.value = '';
    }
    
    // Handle all file types in edit modal
    handleEditFiles(files, messageContainer, source = 'file') {
        const imageFiles = files.filter(file => file.type.startsWith('image/'));
        const documentFiles = files.filter(file => !file.type.startsWith('image/'));
        
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
    async handleEditDocumentFiles(files, messageContainer, source = 'file') {
        if (files.length === 0) {
            console.warn('[EDIT-DOCUMENTS] No document files selected');
            return;
        }
        
        const textarea = messageContainer.querySelector('.message-content-textarea');
        if (!textarea) {
            console.error('[EDIT-DOCUMENTS] No textarea found in message container');
            return;
        }
        
        // Show processing feedback
        const originalPlaceholder = textarea.placeholder;
        textarea.placeholder = `Processing ${files.length} document${files.length > 1 ? 's' : ''}...`;
        
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
                console.log(`[EDIT-DOCUMENTS] Added document: ${docData.fileName} (${(docData.size / 1024).toFixed(1)}KB)`);
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
                textarea.placeholder = `✓ Processed ${result.processed} document${result.processed > 1 ? 's' : ''}`;
            }
            
        } catch (error) {
            console.error('[EDIT-DOCUMENTS] Error uploading documents:', error);
            textarea.placeholder = `Error: ${error.message}`;
        }
        
        // Reset placeholder after delay
        setTimeout(() => {
            textarea.placeholder = originalPlaceholder;
        }, 3000);
    }
    
    // Update the documents display in edit modal
    updateEditDocumentsDisplay(messageContainer) {
        let documentsContainer = messageContainer.querySelector('.edit-documents-container');
        
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
            const textarea = messageContainer.querySelector('.message-content-textarea');
            messageContainer.insertBefore(documentsContainer, textarea);
        }
        
        // Update documents grid
        const documentsGrid = documentsContainer.querySelector('.edit-documents-grid');
        documentsGrid.innerHTML = '';
        
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
            removeBtn.innerHTML = '×';
            removeBtn.title = 'Remove document';
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
        let imagesContainer = messageContainer.querySelector('.edit-images-container');
        
        // Defensive check for _originalContent
        const remainingImages = (messageContainer._originalContent && Array.isArray(messageContainer._originalContent)) ? 
            messageContainer._originalContent.filter(part => part.type === 'image') : [];
            
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
            const textarea = messageContainer.querySelector('.message-content-textarea');
            if (textarea) {
                messageContainer.insertBefore(imagesContainer, textarea);
            } else {
                // Fallback: insert at the top
                messageContainer.insertBefore(imagesContainer, messageContainer.firstChild);
            }
        }
        
        // Update the header and regenerate the grid
        const header = imagesContainer.querySelector('.edit-images-header');
        if (header) {
            header.innerHTML = `<strong>Images (${remainingImages.length}):</strong>`;
        }
        
        const grid = imagesContainer.querySelector('.edit-images-grid');
        if (grid) {
            grid.innerHTML = ''; // Clear existing previews
            
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
            
            // Check if we have original_content with separated files
            if (message.original_content) {
                parsedContent = message.original_content;
                console.log(`[EDIT] Using original_content for message ${message.id}:`, parsedContent);
            }
            
            // Parse JSON string if content is a string that looks like JSON
            if (typeof message.content === 'string' && message.content.startsWith('[')) {
                try {
                    parsedContent = JSON.parse(message.content);
                } catch (e) {
                    // If parsing fails, treat as regular text
                    parsedContent = message.content;
                }
            }
            
            if (Array.isArray(parsedContent)) {
                // Multimodal content - extract text, images, and files
                const textPart = parsedContent.find(part => part.type === 'text');
                textContent = textPart ? textPart.text : "";
                images = parsedContent.filter(part => part.type === 'image');
                
                // Extract files from separated structure
                const filesPart = parsedContent.find(part => part.type === 'files');
                if (filesPart && filesPart.files && Array.isArray(filesPart.files)) {
                    files = filesPart.files;
                    console.log(`[EDIT] Extracted ${files.length} file(s) from message ${message.id}`);
                }
            } else {
                // Regular text content
                textContent = parsedContent || "";
            }
            
            // Images will be shown via updateImagesDisplay after drag/drop setup
            
            // Textarea for text content
            const textarea = document.createElement("textarea");
            textarea.className = "message-content-textarea";
            textarea.value = textContent;
            textarea.rows = Math.max(3, textContent.split("\n").length + 1);
            // Update placeholder to reflect both images and files
            const attachmentInfo = [];
            if (images.length > 0) attachmentInfo.push(`${images.length} image(s)`);
            if (files.length > 0) attachmentInfo.push(`${files.length} file(s)`);
            
            textarea.placeholder = attachmentInfo.length > 0 
                ? `Edit text content (${attachmentInfo.join(' and ')} shown above)` 
                : "Enter message content";
            messageContainer.appendChild(textarea);
            
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
            addImageBtn.innerHTML = 'Add Files';
            addImageBtn.title = "Add files & images";
            addImageBtn.addEventListener("click", () => {
                fileInput.click();
            });
            
            imageControlsContainer.appendChild(fileInput);
            imageControlsContainer.appendChild(addImageBtn);
            messageContainer.appendChild(imageControlsContainer);
            
            // Store original content structure for reconstruction
            // Ensure _originalContent is always an array for consistent handling
            if (Array.isArray(parsedContent)) {
                messageContainer._originalContent = parsedContent;
            } else {
                // Convert string content to array format
                messageContainer._originalContent = [{ type: 'text', text: parsedContent || '' }];
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
                finalFormat: Array.isArray(messageContainer._originalContent) ? 'array' : typeof messageContainer._originalContent,
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
            
            // Check if this is an "Edit & Retry" - if so, skip saving edits to preserve original branch
            const isEditRetry = turnDiv.dataset.shouldRetryAfterEdit === "true";
            
            if (!isEditRetry) {
                // Save each message (normal edit without retry)
                const savePromises = Array.from(messageContainers).map(async (container) => {
                    const messageId = container.dataset.messageId;
                    const textarea = container.querySelector(".message-content-textarea");
                    const newTextContent = textarea.value;
                    
                    if (messageId && newTextContent !== undefined) {
                        // Reconstruct content properly - _originalContent is always an array now
                        let finalContent;
                        
                        if (Array.isArray(container._originalContent)) {
                            // Reconstruct content with text, images, AND files
                            const reconstructedArray = [];
                            
                            // Add text part
                            if (newTextContent) {
                                reconstructedArray.push({ type: 'text', text: newTextContent });
                            }
                            
                            // Add existing images (unchanged)
                            const images = container._originalContent.filter(part => part.type === 'image');
                            reconstructedArray.push(...images);
                            
                            // Add files from edit documents
                            if (container._editDocuments && container._editDocuments.length > 0) {
                                reconstructedArray.push({
                                    type: 'files',
                                    files: container._editDocuments
                                });
                            }
                            
                            // Determine if we need multimodal format
                            const hasMultipleTypes = reconstructedArray.length > 1 || 
                                                      reconstructedArray.some(part => part.type !== 'text');
                            
                            if (hasMultipleTypes) {
                                finalContent = reconstructedArray;
                            } else {
                                finalContent = newTextContent; // Text-only, send as string
                            }
                        } else {
                            // Fallback for old format
                            finalContent = newTextContent;
                        }
                        
                        console.log(`[EDIT-SAVE] Saving message ${messageId}:`, {
                            textContent: newTextContent,
                            hasFiles: container._editDocuments?.length > 0,
                            fileCount: container._editDocuments?.length || 0,
                            finalContent: typeof finalContent === 'string' ? 'string' : 'multimodal'
                        });
                        
                        return editMessage(messageId, finalContent);
                    }
                });
                
                await Promise.all(savePromises.filter(Boolean));
            }
            
            // Exit edit mode and reload
            await this.exitMessageEditMode(turnDiv, turnNumber);
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
    async exitMessageEditMode(turnDiv, turnNumber) {
        try {
            // Check if this was an Edit & Retry
            const shouldRetry = turnDiv.dataset.shouldRetryAfterEdit === "true";
            const retryTurnNumber = parseInt(turnDiv.dataset.editRetryTurnNumber);
            
            turnDiv.classList.remove("editing");
            
            if (shouldRetry && retryTurnNumber) {
                // Clear the retry flags
                delete turnDiv.dataset.shouldRetryAfterEdit;
                delete turnDiv.dataset.editRetryTurnNumber;
                
                // Wait a moment to ensure edit save completes
                await new Promise((resolve) => setTimeout(resolve, 100));
                
                // Get the edited content from UI (since we skipped saving to preserve original branch)
                const messageContainers = turnDiv.querySelectorAll("[data-message-id]");
                let editedContent = null;
                
                // Find the user message textarea with edited content and reconstruct properly
                for (const container of messageContainers) {
                    const textarea = container.querySelector(".message-content-textarea");
                    if (textarea) {
                        const newTextContent = textarea.value;
                        
                        // Reconstruct content with separated structure (like main chat)
                        if (Array.isArray(container._originalContent)) {
                            const reconstructedArray = [];
                            
                            // Add text part
                            if (newTextContent) {
                                reconstructedArray.push({ type: 'text', text: newTextContent });
                            }
                            
                            // Add existing images (unchanged)
                            const images = container._originalContent.filter(part => part.type === 'image');
                            reconstructedArray.push(...images);
                            
                            // Add files from edit documents (separated structure)
                            if (container._editDocuments && container._editDocuments.length > 0) {
                                reconstructedArray.push({
                                    type: 'files',
                                    files: container._editDocuments
                                });
                            }
                            
                            // Determine if we need multimodal format
                            const hasMultipleTypes = reconstructedArray.length > 1 || 
                                                      reconstructedArray.some(part => part.type !== 'text');
                            
                            if (hasMultipleTypes) {
                                editedContent = reconstructedArray;
                            } else {
                                editedContent = newTextContent; // Text-only, send as string
                            }
                        } else {
                            // Fallback for old format
                            editedContent = newTextContent;
                        }
                        break;
                    }
                }
                
                if (!editedContent) {
                    console.error("[EDIT-RETRY] Could not find edited content in UI");
                    return;
                }
                
                // Now create branch at this user turn
                const branchInfo = await retryTurn(currentChatId, retryTurnNumber);
                
                // CRITICAL: Save the edited user message to the new branch (so it persists on reload)
                // The original branch keeps the original message unchanged
                // Convert multimodal arrays to JSON strings for database storage
                const contentForSave = Array.isArray(editedContent) ? JSON.stringify(editedContent) : editedContent;
                
                await saveCompleteMessage(
                    currentChatId,
                    { role: "user", content: contentForSave },
                    null,
                    retryTurnNumber
                );
                
                // Truncate UI - remove all turns after the edited turn (keep existing turns up to edit point)
                const allTurns = this.container.querySelectorAll(".turn");
                
                for (let i = allTurns.length - 1; i >= 0; i--) {
                    const turn = allTurns[i];
                    const turnTurnNumber = parseInt(turn.dataset.turnNumber);
                    const role = turn.classList.contains("user-turn") ? "user" : "assistant";
                    
                    if (turnTurnNumber >= retryTurnNumber) {
                        turn.remove();
                    }
                }
                
                // Generate new requestId for this retried request
                const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                await loadEnabledToolsFromBackend(); // Ensure cache is loaded
                const enabledToolsFlags = loadEnabledTools(); // Get flags like {"server.tool": false}
                
                // Construct user debug data for the new user turn
                const userDebugData = {
                    sequence: [
                        {
                            type: "user_input",
                            step: 1,
                            data: {
                                userQuery: {
                                    message: editedContent,
                                    chat_id: currentChatId,
                                    conductor_mode: false, // Assuming simple chat mode for retry
                                    timestamp: new Date().toISOString(),
                                    message_length: Array.isArray(editedContent) ? JSON.stringify(editedContent).length : editedContent.length,
                                    turn_number: retryTurnNumber,
                                    is_multimodal: Array.isArray(editedContent)
                                },
                                tools: {
                                    total: Object.keys(enabledToolsFlags).length,
                                    flags: enabledToolsFlags
                                },
                                context: {
                                    input_method: "edit_retry",
                                    conductor_mode: false,
                                    current_chat: currentChatId
                                }
                            },
                            timestamp: new Date().toISOString()
                        }
                    ],
                    metadata: {
                        endpoint: "user_input_retry",
                        timestamp: new Date().toISOString(),
                        tools: Object.keys(enabledToolsFlags).length
                    },
                    currentTurnNumber: retryTurnNumber
                };
                
                // Add API request info to debug data
                userDebugData.sequence.push({
                    type: "ai_http_request",
                    step: userDebugData.sequence.length + 1,
                    timestamp: new Date().toISOString(),
                    data: {
                        requestId: requestId,
                        endpoint: "chat",
                        message: editedContent,
                        tools_enabled: Object.keys(enabledToolsFlags).length,
                        turn_number: retryTurnNumber
                    }
                });
                userDebugData.apiRequest = {
                    url: `${window.location.origin}/api/chat`,
                    method: "POST",
                    requestId: requestId,
                    timestamp: new Date().toISOString()
                };
                
                // Save the newly generated user debug data to turn-based storage
                try {
                    await saveTurnData(currentChatId, retryTurnNumber, userDebugData);
                    logger.info(`[EDIT-RETRY] Saved new user debug data for turn ${retryTurnNumber}`);
                } catch (error) {
                    logger.warn("[EDIT-RETRY] Failed to save new user turn debug data:", error);
                }
                
                // Manually create the edited user bubble (like simpleChatMode does)
                this.renderTurn(
                    {
                        role: "user",
                        content: editedContent,
                        turn_number: retryTurnNumber,
                        debug_data: userDebugData // Pass the newly generated debug data
                    },
                    true
                );
                
                // Generate assistant response to the edited user message
                // Send the proper content format to the AI (multimodal array or text string)
                const requestInfo = initiateMessageRequest(
                    editedContent, // This is now properly reconstructed (array for multimodal, string for text)
                    false,
                    enabledToolsFlags,
                    null,
                    null,
                    false,
                    false,
                    requestId
                );
                const response = await requestInfo.fetchPromise;
                
                // Process the streaming response
                await this.processRetryResponse(response, currentChatId, retryTurnNumber + 1, requestId);
                
                // Update branch navigation
                setTimeout(async () => {
                    await this.refreshBranchNavigation();
                }, 100);
            } else {
                // Regular edit - reload chat and refresh branch navigation
                await loadChatHistory(currentChatId);
                
                // Refresh branch navigation in case the edit created new branches
                setTimeout(async () => {
                    await this.refreshBranchNavigation();
                }, 100);
            }
        } catch (error) {
            console.error("[EDIT] Error in exitMessageEditMode:", error);
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
    // Update brnch navigation
    async updateBranchNavigation(branchNavElement, turnNumber) {
        if (!currentChatId || !turnNumber) {
            branchNavElement.style.display = "none";
            return;
        }
        
        try {
            const branchInfo = await getChatBranches(currentChatId);
            const { branches, activeBranch, totalBranches } = branchInfo;
            
            if (!branches || branches.length <= 1) {
                branchNavElement.style.display = "none";
                return false;
            }
            
            // Only show navigation on actual branch points (where branches diverge)
            const isBranchPoint = branches.some((branch) => branch.branch_point_turn === turnNumber);
            
            if (!isBranchPoint) {
                // This turn is not a branch connection point - hide navigation
                branchNavElement.style.display = "none";
                return false;
            }
            
            // Build hierarchical branch tree
            const branchTree = this.buildBranchTree(branches);
            
            // Find all branches that contain this turn, considering hierarchy
            const turnBranches = this.findBranchesForTurn(branches, branchTree, turnNumber, activeBranch);
            
            if (turnBranches.length <= 1) {
                // No alternative versions of this turn exist
                branchNavElement.style.display = "none";
                return false;
            }
            
            // Sort branches by hierarchy (ancestor -> descendant)
            const sortedBranches = this.sortBranchesByHierarchy(turnBranches, branchTree);
            
            // Find which branch in the original split is the ancestor of the current active branch
            // This preserves the original branching relationships regardless of current branch
            let currentBranchIndex = -1;
            
            // If active branch is directly in the turn branches, use it
            currentBranchIndex = sortedBranches.findIndex((b) => b.is_active);
            
            if (currentBranchIndex === -1) {
                // Active branch not in turn branches - find which turn branch is its ancestor
                const ancestorBranch = this.findAncestorInBranches(activeBranch, sortedBranches, branchTree);
                if (ancestorBranch) {
                    currentBranchIndex = sortedBranches.findIndex((b) => b.id === ancestorBranch.id);
                } else {
                    // Fallback to first branch if no ancestor found
                    currentBranchIndex = 0;
                    console.warn(
                        `[BRANCH-NAV] Turn ${turnNumber}: Could not find ancestor, defaulting to first branch`
                    );
                }
            }
            
            if (currentBranchIndex === -1 || sortedBranches.length === 0) {
                branchNavElement.style.display = "none";
                return false;
            }
            
            // Update navigation elements
            const prevBtn = branchNavElement.querySelector(".branch-prev");
            const nextBtn = branchNavElement.querySelector(".branch-next");
            const indicator = branchNavElement.querySelector(".branch-indicator");
            
            // Enable/disable buttons
            prevBtn.disabled = currentBranchIndex <= 0;
            nextBtn.disabled = currentBranchIndex >= sortedBranches.length - 1;
            
            // Update indicator with branch names, showing original split relationship
            const currentBranch = sortedBranches[currentBranchIndex];
            indicator.textContent = `${currentBranch.branch_name} (${currentBranchIndex + 1}/${sortedBranches.length})`;
            indicator.title = `Turn ${turnNumber} original split: ${sortedBranches.map((b) => b.branch_name).join(" ↔ ")} (preserved regardless of current branch)`;
            
            // Store branch data for navigation
            branchNavElement._turnBranches = sortedBranches;
            branchNavElement._currentIndex = currentBranchIndex;
            branchNavElement._turnNumber = turnNumber;
            
            // Show navigation
            branchNavElement.style.display = "flex";
            branchNavElement.style.alignItems = "center";
            branchNavElement.style.gap = "6px";
            branchNavElement.style.marginLeft = "10px";
            
            return true;
        } catch (error) {
            console.error(`[BRANCH-NAV] Error getting branches:`, error);
            branchNavElement.style.display = "none";
            return false;
        }
    }
    
    // Build hierarchical branch tree from parent-child relationships
    buildBranchTree(branches) {
        const tree = new Map();
        
        // Initialize tree with all branches
        branches.forEach((branch) => {
            tree.set(branch.id, {
                ...branch,
                children: [],
                depth: 0
            });
        });
        
        // Build parent-child relationships and calculate depths
        branches.forEach((branch) => {
            if (branch.parent_branch_id) {
                const parent = tree.get(branch.parent_branch_id);
                const child = tree.get(branch.id);
                if (parent && child) {
                    parent.children.push(child);
                    child.depth = parent.depth + 1;
                }
            }
        });
        
        return tree;
    }
    
    // Find branches that are relevant at a specific branch point
    findBranchesForTurn(branches, branchTree, turnNumber, activeBranch) {
        if (!activeBranch) return [];
        
        // Get active lineage
        const activeLineage = this.getBranchLineage(branchTree.get(activeBranch.id), branchTree);
        const activeLineageIds = new Set(activeLineage.map((b) => b.id));
        
        const result = [];
        
        // Find all branches that branch at this exact turn
        const branchesAtThisTurn = branches.filter((branch) => branch.branch_point_turn === turnNumber);
        
        if (branchesAtThisTurn.length === 0) {
            return [];
        }
        
        // KEY FIX: Only show navigation if the active branch was directly involved in this split
        // Check if active branch exists at this turn (created at or before this turn)
        const activeBranchTurn = activeBranch.branch_point_turn;
        if (activeBranchTurn && activeBranchTurn < turnNumber) {
            return [];
        }
        
        // Filter branches to only those relevant to active lineage
        const relevantBranchesAtThisTurn = branchesAtThisTurn.filter((branch) => {
            const branchInLineage = activeLineageIds.has(branch.id);
            const parentInLineage = activeLineageIds.has(branch.parent_branch_id);
            
            return branchInLineage || parentInLineage;
        });
        
        if (relevantBranchesAtThisTurn.length === 0) {
            return [];
        }
        
        // ADDITIONAL CHECK: Active branch must be directly involved
        const activeBranchDirectlyInvolved =
            relevantBranchesAtThisTurn.some((b) => b.id === activeBranch.id) || // Active branch splits here
            relevantBranchesAtThisTurn.some((b) => b.parent_branch_id === activeBranch.id); // Active branch is parent
        
        if (!activeBranchDirectlyInvolved) {
            return [];
        }
        
        // Find the parent branch for this turn (use first relevant branch)
        const firstRelevantBranch = relevantBranchesAtThisTurn[0];
        let parentBranch = null;
        
        if (firstRelevantBranch.parent_branch_id) {
            parentBranch = branches.find((b) => b.id === firstRelevantBranch.parent_branch_id);
            
            // Only include parent if it's also in active lineage
            const parentInLineage = parentBranch && activeLineageIds.has(parentBranch.id);
            
            if (parentInLineage) {
                result.push(parentBranch);
            }
        }
        
        // Add all relevant branches that actually split at this turn
        relevantBranchesAtThisTurn.forEach((branch) => {
            const alreadyInResult = result.find((b) => b.id === branch.id);
            
            if (!alreadyInResult) {
                result.push(branch);
            }
        });
        
        return result;
    }

    // Find which branch in a list is an ancestor of the given branch
    findAncestorInBranches(targetBranch, candidateBranches, branchTree) {
        if (!targetBranch || !candidateBranches || candidateBranches.length === 0) {
            return null;
        }

        // Get the complete ancestry of the target branch
        const targetBranchNode = branchTree.get(targetBranch.id);
        if (!targetBranchNode) {
            return null;
        }
        
        const ancestryChain = this.getBranchLineage(targetBranchNode, branchTree);
        
        // Find the first ancestor that exists in the candidate branches
        // (working backwards from the target branch to root)
        for (let i = ancestryChain.length - 1; i >= 0; i--) {
            const ancestor = ancestryChain[i];
            const found = candidateBranches.find((candidate) => candidate.id === ancestor.id);
            if (found) {
                return found;
            }
        }
        
        return null;
    }

    // Get the complete lineage (ancestry path) of a branch
    getBranchLineage(branch, branchTree) {
        const lineage = [];
        let current = branch;
        
        // Walk up the ancestry chain
        while (current) {
            lineage.unshift(current); // Add to beginning to maintain order
            if (current.parent_branch_id) {
                current = branchTree.get(current.parent_branch_id);
            } else {
                break;
            }
        }
        
        return lineage;
    }

    // Get all descendants of a branch
    getBranchDescendants(branch, branchTree) {
        const descendants = [];
        
        function collectDescendants(node) {
            node.children.forEach((child) => {
                descendants.push(child);
                collectDescendants(child);
            });
        }
        
        collectDescendants(branch);
        return descendants;
    }

    // Check if a branch contains a specific turn
    branchHasTurn(branch, turnNumber) {
        // A branch contains a turn if:
        // 1. It's the main branch (has all turns before any branch point)
        // 2. For other branches:
        //    - Turns BEFORE the branch point come from the parent branch
        //    - Turns AT OR AFTER the branch point are the branch's own versions
        
        if (!branch.branch_point_turn || branch.branch_point_turn === null) {
            // Main branch - contains all turns that exist
            return true;
        }
        
        // For branches with a branch point:
        // - They inherit all turns from parent up to (but not including) the branch point
        // - They have their own versions from the branch point onwards
        // So they contain ALL turns, but different versions depending on the turn number
        return true;
        
        // Future enhancement: Could check actual message existence in database
        // const hasMessageQuery = `SELECT COUNT(*) as count FROM branch_messages
        //                          WHERE branch_id = ? AND turn_number = ?`;
        // return count > 0;
    }

    // Sort branches by hierarchy (ancestor first, then descendants)
    sortBranchesByHierarchy(branches, branchTree) {
        return branches.sort((a, b) => {
            const nodeA = branchTree.get(a.id);
            const nodeB = branchTree.get(b.id);
            
            if (!nodeA || !nodeB) return 0;
            
            // Sort by depth first (ancestors before descendants)
            if (nodeA.depth !== nodeB.depth) {
                return nodeA.depth - nodeB.depth;
            }
            
            // Same depth - sort by creation time
            return new Date(a.created_at) - new Date(b.created_at);
        });
    }

    // Navigate to previous/next branch
    async navigateBranch(direction, branchNavElement = null) {
        let targetBranchNav = branchNavElement;
        
        // Fallback to finding any branch nav element if none provided (for backward compatibility)
        if (!targetBranchNav) {
            const branchNavElements = document.querySelectorAll(".branch-nav");
            for (const nav of branchNavElements) {
                if (nav._turnBranches && nav._currentIndex !== undefined) {
                    targetBranchNav = nav;
                    break;
                }
            }
        }
        
        if (!targetBranchNav || !targetBranchNav._turnBranches) {
            console.error("[BRANCH-NAV] No branch data found for navigation");
            return;
        }
        
        const turnBranches = targetBranchNav._turnBranches;
        const currentIndex = targetBranchNav._currentIndex;
        const turnNumber = targetBranchNav._turnNumber;
        
        let newIndex;
        if (direction === "prev") {
            newIndex = Math.max(0, currentIndex - 1);
        } else if (direction === "next") {
            newIndex = Math.min(turnBranches.length - 1, currentIndex + 1);
        } else {
            return;
        }
        
        if (newIndex === currentIndex) {
            return; // No change needed
        }
        
        const currentBranch = turnBranches[currentIndex];
        const targetBranch = turnBranches[newIndex];
        
        await this.switchBranch(targetBranch.id);
    }

    // Switch to a different branch
    async switchBranch(branchId) {
        if (!branchId || !currentChatId) return;
        
        try {
            // Activate the new branch
            await activateChatBranch(currentChatId, parseInt(branchId));
            
            // Reload the chat to show the new branch (this will trigger debug panel updates)
            await loadChatHistory(currentChatId);
            
            // Refresh branch navigation for all turns after switching
            setTimeout(async () => {
                await this.refreshBranchNavigation();
            }, 100);
        } catch (error) {
            console.error("[BRANCH-NAV] Error switching branch:", error);
        }
    }
    
    // Process streaming response for retry (without creating new user message)
    async processRetryResponse(response, chatId, turnNumber, requestId) {
        try {
            const processor = new StreamingMessageProcessor();
            const tempContainer = document.createElement("div");
            const liveRenderer = new ChatRenderer(tempContainer);
            
            // Set up tool event source for live rendering using provided requestId
            let toolEventSource = null;
            try {
                const eventSourceUrl = `${window.location.origin}/api/tools/${requestId}`;
                toolEventSource = new EventSource(eventSourceUrl);
                
                toolEventSource.onmessage = function (event) {
                    try {
                        const eventData = JSON.parse(event.data);
                        handleToolEvent(eventData, processor, liveRenderer, tempContainer);
                    } catch (parseError) {
                        console.warn("Failed to parse tool event:", parseError);
                    }
                };
            } catch (error) {
                logger.warn("Failed to connect to tool events:", error);
            }
            
            // Create assistant turn div manually (like simpleChatMode does)
            const assistantTurnDiv = document.createElement("div");
            assistantTurnDiv.className = "turn assistant-turn";
            assistantTurnDiv.innerHTML = "";
            this.container.appendChild(assistantTurnDiv);
            
            // Add temp container for live rendering
            assistantTurnDiv.appendChild(tempContainer);
            
            // Process streaming response
            for await (const chunk of streamResponse(response)) {
                processor.addChunk(chunk);
                updateLiveRendering(processor, liveRenderer, tempContainer);
                smartScrollToBottom(scrollContainer);
            }
            
            // Close tool events stream
            if (toolEventSource) {
                toolEventSource.close();
            }
            
            // Finalize the processor
            processor.finalize();
            
            // Get debug data
            let debugData = null;
            if (requestId) {
                try {
                    const debugResponse = await fetch(`${window.location.origin}/api/debug/${requestId}`);
                    if (debugResponse.ok) {
                        debugData = await debugResponse.json();
                    }
                } catch (error) {
                    logger.warn("Failed to fetch debug data:", error);
                }
            }
            
            // Get dropdown states before removing temp container
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
            
            // Remove temp content and re-render
            tempContainer.remove();
            assistantTurnDiv.remove();
            
            if (debugData) {
                debugData.currentTurnNumber = turnNumber;
            }
            
            // Get final blocks and re-render
            const finalBlocks = processor.getBlocks();
            
            const renderedTurn = this.renderTurn(
                {
                    role: "assistant",
                    blocks: finalBlocks,
                    content: processor.getRawContent() || "",
                    debug_data: debugData,
                    dropdownStates: dropdownStates,
                    turn_number: turnNumber
                },
                true
            );
            
            // Save debug data
            if (debugData) {
                await saveTurnData(chatId, turnNumber, debugData);
                logger.info(`[RETRY] Saved debug data for turn ${turnNumber}`);
            }
            
            logger.info("[RETRY] Assistant response completed successfully");
        } catch (error) {
            logger.error("[RETRY] Error processing response:", error);
            throw error;
        }
    }
    
    // Refresh branch navigation for all turns
    async refreshBranchNavigation() {
        try {
            // Get branch navigations for both user and assistant turns
            const allTurns = document.querySelectorAll(".user-turn, .assistant-turn");
            
            for (const turn of allTurns) {
                const branchNav = turn.querySelector(".branch-nav");
                const turnNumber = parseInt(turn.dataset.turnNumber);
                
                if (branchNav && turnNumber) {
                    await this.updateBranchNavigation(branchNav, turnNumber);
                }
            }
        } catch (error) {
            console.error("[BRANCH-NAV] Error refreshing branch navigation:", error);
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
    
    // Force width on all debug dropdowns
    setTimeout(() => {
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
    }, 0);
    
    return debugPanel;
}