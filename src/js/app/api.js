// API layer - handles all backend communication

const API_BASE = window.location.origin;

// Turn data functions (keyed on turn_id after the M6 fix — sibling-safe).
// Debug data is stored on the message row identified by turn_id; the
// backend no longer keys on turn_number because two siblings can share
// one turn_number after retry/edit-retry.
async function saveTurnData(chatId, turnId, data) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turns/${turnId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ data })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        logger.error('Error saving turn data:', error);
        throw error;
    }
}

// Initiate a request without awaiting the response (returns controller and requestId).
// Note (M7): the request body intentionally omits `message`. The LLM-bound
// messages array is built exclusively from DB history on the backend; the
// user-supplied `message` field had no effect on what the model saw, and
// keeping it would only create an avenue for stale or attacker-controlled
// input to reach the model.
function initiateMessageRequest(enabledToolsData = null, requestId = null, parentTurnId = null, turnId = null, lineageAnchorTurnId = null) {
    try {
        // Phase 8 Task 24: require a requestId. The helper lives in
        // sendAndStream.js:generateRequestId(); callers should always pass
        // one. A missing requestId is a programmer error — throw rather
        // than silently synthesize a fresh one (no silent fallbacks).
        if (!requestId) {
            throw new Error('initiateMessageRequest: requestId is required');
        }
        const generatedRequestId = requestId;

        const requestBody = {
            chat_id: currentChatId,
            enabled_tools: enabledToolsData,
            request_id: generatedRequestId,
            parent_turn_id: parentTurnId,
            turn_id: turnId,
            lineage_anchor_turn_id: lineageAnchorTurnId
        };

        // Create abort controller for this request
        const abortController = new AbortController();
        currentAbortController = abortController;

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
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: requestBodyString,
            signal: abortController.signal
        });

        logger.debug('[API] Initiated message request with requestId:', generatedRequestId);

        // Return the information needed to track and await this request
        return {
            requestId: generatedRequestId,
            controller: abortController,
            fetchPromise: fetchPromise
        };
    } catch (error) {
        logger.error('[API] Error initiating message request:', error);
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
            logger.info('Loaded enabled tools from file storage');
        } else {
            cachedEnabledTools = {};
        }
        return cachedEnabledTools;
    } catch (error) {
        logger.warn('Failed to load enabled tools from backend:', error);
        cachedEnabledTools = {};
        return {};
    }
}

function saveEnabledTools(enabledTools) {
    cachedEnabledTools = enabledTools;
    // Save to backend file storage
    fetch(`${window.location.origin}/api/enabled-tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enabledTools)
    }).then(() => {
        logger.info('Saved enabled tools to file storage');
    }).catch(error => {
        logger.warn('Failed to save enabled tools to backend:', error);
    });
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
    
    saveEnabledTools(enabledTools);
}

function getEnabledToolsForServer(serverName, allTools) {
    return allTools.filter(tool => isToolEnabled(serverName, tool));
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
        if (error.name === 'AbortError') {
            logger.info('Stream aborted by user');
            throw error; // Re-throw AbortError so it reaches the chat handler
        }
        throw error; // Re-throw other errors
    } finally {
        reader.releaseLock();
        // Clean up abort controller when streaming is done
        if (currentAbortController) {
            currentAbortController = null;
        }
    }
}

// Get chat history
async function getChatHistory(chatId = null) {
    try {
        const url = chatId ? `${API_BASE}/api/chat/${chatId}/history` : `${API_BASE}/api/chat/${currentChatId}/history`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error getting chat history:', error, true);
        throw error;
    }
}

// Get complete chat history including error messages (for UI display)
async function getCompleteChatHistory(chatId = null) {
    try {
        const url = chatId ? `${API_BASE}/api/chat/${chatId}/history-complete` : `${API_BASE}/api/chat/${currentChatId}/history-complete`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error getting complete chat history:', error, true);
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
        logger.error('Error getting MCP status:', error, true);
        throw error;
    }
}

// Connect to MCP servers
async function connectToMCPServers() {
    try {
        const response = await fetch(`${API_BASE}/api/mcp/connect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error connecting to MCP servers:', error, true);
        throw error;
    }
}

// Disconnect from MCP servers
async function disconnectFromMCPServers() {
    try {
        const response = await fetch(`${API_BASE}/api/mcp/disconnect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error disconnecting from MCP servers:', error, true);
        throw error;
    }
}

// Save settings to backend
async function saveSettingsToBackend(settings) {
    try {
        const response = await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(settings)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error saving settings:', error, true);
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
        logger.warn('Error loading settings from backend:', error, true);
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
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
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
        logger.error('Error updating chat title in database:', error, true);
        throw error;
    }
}

// Create new chat in database
async function createNewChatInDatabase(chatId, title = 'New Chat', projectId = null) {
    try {
        const body = { chat_id: chatId, title: title };
        if (projectId) {
            body.project_id = projectId;
        }
        const response = await fetch(`${API_BASE}/api/chats`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error creating chat in database:', error, true);
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
        if (turnInfo?.turn_id) requestData.turn_id = turnInfo.turn_id;
        if (turnInfo?.parent_turn_id !== undefined) requestData.parent_turn_id = turnInfo.parent_turn_id;
        
        const response = await fetch(`${API_BASE}/api/message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error saving complete message:', error, true);
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
        logger.error('Error loading MCP config:', error, true);
        throw error;
    }
}

async function saveMCPConfig(configText) {
    try {
        // Parse to validate JSON format
        JSON.parse(configText);
        
        // Send the config as a string (not parsed object)
        const response = await fetch(`${API_BASE}/api/mcp/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ config: configText })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error saving MCP config:', error, true);
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
        logger.error('Error getting current turn number:', error);
        throw error;
    }
}

// Load persisted branch navigation selections for a chat. Returns a
// { parentKey: selectedTurnId } object map (parentKey is 'root' or a
// turn_id). Empty object for a chat that has no persisted selections
// — the caller should treat that as "no overrides" and let the walk
// fall back to the last-sibling default.
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

// Save the full per-chat branch navigation map. The caller is
// responsible for filtering the in-memory map down to just the
// current chat's keys before sending. Replaces all rows for the chat
// on the server side. Throws on failure — the in-memory state remains
// correct for the current session but the next reload would lose the
// pick; the loud throw makes that visible.
async function saveBranchSelections(chatId, selections) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/branch-selections`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selections }),
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
        logger.error('Error getting turn messages:', error);
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
            const filesPart = newContent.find(part => part.type === 'files');
            if (filesPart && filesPart.files) {
                requestData.file_metadata = {
                    hasFiles: true,
                    fileCount: filesPart.files.length,
                    imageCount: newContent.filter(part => part.type === 'image').length,
                    files: filesPart.files
                };
            }
        }
        
        const response = await fetch(`${API_BASE}/api/message/${messageId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error editing message:', error);
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
        logger.error('Error getting message:', error);
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
        logger.error('Error loading projects:', error);
        throw error;
    }
}

// Create a new project
async function createProject(name, path) {
    try {
        const response = await fetch(`${API_BASE}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, path })
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        logger.error('Error creating project:', error);
        throw error;
    }
}

// Delete a project
async function deleteProject(projectId) {
    try {
        const response = await fetch(`${API_BASE}/api/projects/${projectId}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        logger.error('Error deleting project:', error);
        throw error;
    }
}
