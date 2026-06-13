// API layer - handles all backend communication

const API_BASE = window.location.origin;

// Turn data functions keyed on turn_id for sibling safety.
async function saveTurnData(chatId, turnId, data) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turns/${turnId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ data })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error saving turn data:", error);
        throw error;
    }
}

// Initiate a request without awaiting the response (returns controller and requestId).
// Request omits `message` — the backend builds the messages array from DB history only.
function initiateMessageRequest(
    enabledToolsData = null,
    requestId = null,
    parentTurnId = null,
    turnId = null,
    historyAnchorTurnId = null
) {
    try {
        // Require a requestId; missing requestId is a programmer error.
        if (!requestId) {
            throw new Error("initiateMessageRequest: requestId is required");
        }
        const generatedRequestId = requestId;

        const requestBody = {
            chat_id: currentChatId,
            enabled_tools: enabledToolsData,
            request_id: generatedRequestId,
            parent_turn_id: parentTurnId,
            turn_id: turnId,
            history_anchor_turn_id: historyAnchorTurnId
        };

        // Create abort controller for this request
        const abortController = new AbortController();
        currentAbortController = abortController;
        currentRequestId = generatedRequestId;

        // Log request size for debugging
        const requestBodyString = JSON.stringify(requestBody);
        const requestSizeMB = (requestBodyString.length / 1024 / 1024).toFixed(2);
        logger.debug(`[API] Request size: ${requestSizeMB}MB`);

        if (requestSizeMB > 50) {
            logger.warn(`[API] Large request detected: ${requestSizeMB}MB - this may cause "headers too big" errors`);
            showError(`Warning: Large request (${requestSizeMB}MB) may fail. Consider reducing image sizes.`);
        }

        if (requestSizeMB > 100) {
            throw new Error(`Request too large (${requestSizeMB}MB). Please reduce image sizes or remove some images.`);
        }

        // Start the request but don't await it
        const fetchPromise = fetch(`${API_BASE}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: requestBodyString,
            signal: abortController.signal
        });

        logger.debug("[API] Initiated message request with requestId:", generatedRequestId);

        // Return the information needed to track and await this request
        return {
            requestId: generatedRequestId,
            controller: abortController,
            fetchPromise: fetchPromise
        };
    } catch (error) {
        logger.error("[API] Error initiating message request:", error);
        throw error;
    }
}

// Tool state management
let cachedEnabledTools = null;

function loadEnabledTools() {
    // Return cached tools or default empty object
    return cachedEnabledTools || {};
}

async function loadEnabledToolsFromBackend() {
    try {
        const response = await fetch(`${window.location.origin}/api/enabled-tools`);
        if (response.ok) {
            cachedEnabledTools = await response.json();
            logger.info("Loaded enabled tools from file storage");
        } else {
            cachedEnabledTools = {};
        }
        return cachedEnabledTools;
    } catch (error) {
        logger.warn("Failed to load enabled tools from backend:", error);
        cachedEnabledTools = {};
        return {};
    }
}

async function saveEnabledToolsToBackend(enabledTools) {
    try {
        const response = await fetch(`${window.location.origin}/api/enabled-tools`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(enabledTools)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        logger.info("Saved enabled tools to file storage");
    } catch (error) {
        logger.warn("Failed to save enabled tools to backend:", error);
    }
}

function isToolEnabled(serverName, toolName) {
    const enabledTools = loadEnabledTools();
    const toolKey = `${serverName}.${toolName}`;
    const isEnabled = enabledTools[toolKey] === true; // Default to disabled

    return isEnabled;
}

function setToolEnabled(serverName, toolName, enabled) {
    const enabledTools = loadEnabledTools();
    const toolKey = `${serverName}.${toolName}`;

    if (enabled) {
        enabledTools[toolKey] = true; // Explicitly enable
    } else {
        delete enabledTools[toolKey]; // Remove from storage (default is disabled)
    }

    cachedEnabledTools = enabledTools;
}

function getEnabledToolsForServer(serverName, allTools) {
    return allTools.filter((tool) => isToolEnabled(serverName, tool));
}

// Stream response reader
async function* streamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            yield chunk;
        }
    } catch (error) {
        if (error.name === "AbortError") {
            logger.info("Stream aborted by user");
            throw error; // Re-throw AbortError so it reaches the chat handler
        }
        throw error; // Re-throw other errors
    } finally {
        reader.releaseLock();
        // Clean up abort controller when streaming is done
        if (currentAbortController) {
            currentAbortController = null;
        }
        if (currentRequestId) {
            currentRequestId = null;
        }
    }
}

// Parse structured SSE events from response
async function* streamSSEEvents(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete events (terminated by blank line)
            const events = buffer.split('\n\n');
            
            // Keep the last incomplete event in buffer
            buffer = events.pop() || '';

            for (const eventText of events) {
                if (!eventText.trim()) continue;
                
                const lines = eventText.split('\n');
                let eventType = null;
                let eventData = [];

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.slice(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData.push(line.slice(6));
                    }
                }

                // Yield complete event
                if (eventType && eventData.length > 0) {
                    try {
                        const jsonStr = eventData.join('\n');
                        yield {
                            type: eventType,
                            data: JSON.parse(jsonStr)
                        };
                    } catch (e) {
                        logger.error('Failed to parse SSE event:', { eventType, data: eventData.join('\n'), error: e.message });
                    }
                }
            }
        }

        // Process remaining buffer
        if (buffer.trim()) {
            const lines = buffer.split('\n');
            let eventType = null;
            let eventData = [];

            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    eventType = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                    eventData.push(line.slice(6));
                }
            }

            // Yield final event if we have one
            if (eventType && eventData.length > 0) {
                try {
                    const jsonStr = eventData.join('\n');
                    yield {
                        type: eventType,
                        data: JSON.parse(jsonStr)
                    };
                } catch (e) {
                    logger.error('Failed to parse final SSE event:', { eventType, data: eventData.join('\n'), error: e.message });
                }
            }
        }
    } catch (error) {
        if (error.name === "AbortError") {
            logger.info("Stream aborted by user");
            throw error;
        }
        throw error;
    } finally {
        reader.releaseLock();
        if (currentAbortController) {
            currentAbortController = null;
        }
        if (currentRequestId) {
            currentRequestId = null;
        }
    }
}

// Get complete chat history including error messages (for UI display)
async function getCompleteChatHistory(chatId = null) {
    try {
        const url = chatId
            ? `${API_BASE}/api/chat/${chatId}/history-complete`
            : `${API_BASE}/api/chat/${currentChatId}/history-complete`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error getting complete chat history:", error, true);
        throw error;
    }
}

// Get available MCP servers status
async function getMCPStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/mcp/status`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error getting MCP status:", error, true);
        throw error;
    }
}

// Connect to MCP servers
async function connectToMCPServers() {
    try {
        const response = await fetch(`${API_BASE}/api/mcp/connect`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error connecting to MCP servers:", error, true);
        throw error;
    }
}

// Disconnect from MCP servers
async function disconnectFromMCPServers() {
    try {
        const response = await fetch(`${API_BASE}/api/mcp/disconnect`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error disconnecting from MCP servers:", error, true);
        throw error;
    }
}

// Save settings to backend
async function saveSettingsToBackend(settings) {
    try {
        const response = await fetch(`${API_BASE}/api/settings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(settings)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error saving settings:", error, true);
        throw error;
    }
}

// Load settings from backend
async function loadSettingsFromBackend() {
    try {
        const response = await fetch(`${API_BASE}/api/settings`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.warn("Error loading settings from backend:", error, true);
        // Return local settings as fallback
        return loadSettings();
    }
}

// Create new chat
function createNewChat() {
    currentChatId = generateId();
    logger.info(`Created new chat: ${currentChatId}`);
    return currentChatId;
}
// Update chat title in database
async function updateChatTitleInDatabase(chatId, title) {
    try {
        // We'll use a PATCH request to partially update the chat record
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/title`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                title: title
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error updating chat title in database:", error, true);
        throw error;
    }
}

// Create new chat in database
async function createNewChatInDatabase(chatId, title = "New Chat", projectId = null) {
    try {
        const body = { chat_id: chatId, title: title };
        if (projectId) {
            body.project_id = projectId;
        }
        const response = await fetch(`${API_BASE}/api/chats`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error creating chat in database:", error, true);
        throw error;
    }
}

// Save complete message using unified approach
async function saveCompleteMessage(chatId, messageData, turnNumber = null, turnInfo = null) {
    try {
        const requestData = {
            chat_id: chatId,
            role: messageData.role,
            content: messageData.content,
            turn_number: turnNumber
        };

        // Add tool-specific fields if present
        if (messageData.tool_calls) requestData.tool_calls = messageData.tool_calls;
        if (messageData.tool_call_id) requestData.tool_call_id = messageData.tool_call_id;
        if (messageData.tool_name) requestData.tool_name = messageData.tool_name;
        // Add new file handling fields if present
        if (messageData.original_content !== undefined) requestData.original_content = messageData.original_content;
        if (messageData.file_metadata !== undefined) requestData.file_metadata = messageData.file_metadata;
        if (messageData.error_state) requestData.error_state = messageData.error_state;
        if (turnInfo?.turn_id) requestData.turn_id = turnInfo.turn_id;
        if (turnInfo?.parent_turn_id !== undefined) requestData.parent_turn_id = turnInfo.parent_turn_id;

        const response = await fetch(`${API_BASE}/api/message`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error saving complete message:", error, true);
        throw error;
    }
}

// MCP Config management
async function loadMCPConfig() {
    try {
        const response = await fetch(`${API_BASE}/api/mcp/config`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text(); // Return as text to preserve formatting
    } catch (error) {
        logger.error("Error loading MCP config:", error, true);
        throw error;
    }
}

async function saveMCPConfig(configText) {
    try {
        // Parse to validate JSON format
        JSON.parse(configText);

        // Send the config as a string (not parsed object)
        const response = await fetch(`${API_BASE}/api/mcp/config`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ config: configText })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error saving MCP config:", error, true);
        throw error;
    }
}

// Get current turn number for a chat
async function getCurrentTurnNumber(chatId) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/current-turn`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error getting current turn number:", error);
        throw error;
    }
}

// Load persisted branch navigation selections for a chat. Returns a
// { parentKey: selectedTurnId } map, or {} if none.
async function loadBranchSelections(chatId) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/branch-selections`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error(`Error loading branch selections for chat ${chatId}:`, error);
        throw error;
    }
}

// Save the full per-chat branch navigation map. Caller filters to
// current chat keys. Throws on failure.
async function saveBranchSelections(chatId, selections) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/branch-selections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ selections })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error(`Error saving branch selections for chat ${chatId}:`, error);
        throw error;
    }
}

// Get messages for a specific turn
async function getTurnMessages(chatId, turnNumber) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turn/${turnNumber}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error getting turn messages:", error);
        throw error;
    }
}
// Edit message content
async function editMessage(messageId, newContent) {
    try {
        // Build request data exactly like saveCompleteMessage
        const requestData = {
            content: newContent
        };

        // Add file handling fields if content is multimodal (like saveCompleteMessage does)
        if (Array.isArray(newContent)) {
            requestData.original_content = newContent;

            // Extract file metadata
            const filesPart = newContent.find((part) => part.type === "files");
            if (filesPart && filesPart.files) {
                requestData.file_metadata = {
                    hasFiles: true,
                    fileCount: filesPart.files.length,
                    imageCount: newContent.filter((part) => part.type === "image").length,
                    files: filesPart.files
                };
            }
        }

        const response = await fetch(`${API_BASE}/api/message/${messageId}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error editing message:", error);
        throw error;
    }
}

// Get message by ID
async function getMessage(messageId) {
    try {
        const response = await fetch(`${API_BASE}/api/message/${messageId}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error("Error getting message:", error);
        throw error;
    }
}

// ===== PROJECT API =====

// Load all projects
async function loadProjects() {
    try {
        const response = await fetch(`${API_BASE}/api/projects`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        logger.error("Error loading projects:", error);
        throw error;
    }
}

// Create a new project
async function createProject(name, path) {
    try {
        const response = await fetch(`${API_BASE}/api/projects`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, path })
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        logger.error("Error creating project:", error);
        throw error;
    }
}

// Delete a project
async function deleteProject(projectId) {
    try {
        const response = await fetch(`${API_BASE}/api/projects/${projectId}`, {
            method: "DELETE"
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        logger.error("Error deleting project:", error);
        throw error;
    }
}
