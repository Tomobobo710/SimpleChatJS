// API layer - handles all backend communication

const API_BASE = window.location.origin;

// Send a chat message
async function sendMessage(message, conductorMode = false) {
    try {
        // Get enabled tools for filtering
        const enabledTools = loadEnabledTools();
        
        const response = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: message,
                chat_id: currentChatId,
                conductor_mode: conductorMode,
                enabled_tools: enabledTools
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response;
    } catch (error) {
        logger.error('Error sending message:', error, true);
        throw error;
    }
}

// Update debug data for a message
async function updateMessageDebugData(chatId, role, turnNumber, debugData) {
    try {
        const response = await fetch(`${API_BASE}/api/message/debug`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chat_id: chatId,
                role: role,
                turn_number: turnNumber,
                debug_data: debugData
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error updating message debug data:', error);
        throw error;
    }
}

// Turn data functions (clean RESTful API)
async function saveTurnData(chatId, turnNumber, data) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turns/${turnNumber}`, {
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

async function getTurnData(chatId, turnNumber) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turns/${turnNumber}`);
        
        if (!response.ok) {
            if (response.status === 404) {
                return null; // No data for this turn
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error getting turn data:', error);
        throw error;
    }
}

// Initiate a request without awaiting the response (returns controller and requestId)
function initiateMessageRequest(message, conductorMode = false, enabledToolsData = null, phaseNumber = null, messageRole = null, blockToolExecution = false, blockRecursiveToolResponse = false, requestId = null) {
    try {
        // Generate requestId if not provided
        const generatedRequestId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const requestBody = {
            message: message,
            chat_id: currentChatId,
            conductor_mode: conductorMode,
            enabled_tools: enabledToolsData,
            block_tool_execution: blockToolExecution,
            block_recursive_call: blockRecursiveToolResponse,
            ...(messageRole && { message_role: messageRole }),
            request_id: generatedRequestId // Always include the requestId
        };
        
        // Add phase number for conductor mode
        if (phaseNumber !== null) {
            requestBody.conductor_phase = phaseNumber;
        }
        
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

async function sendMessageWithTools(message, conductorMode = false, toolDefinitions = [], phaseNumber = null, messageRole = null, blockToolExecution = false, blockRecursiveToolResponse = false, requestId = null) {
    try {
        const requestBody = {
            message: message,
            chat_id: currentChatId,
            conductor_mode: conductorMode,
            enabled_tools: toolDefinitions, // Send actual tool definitions instead of enable/disable flags
            block_tool_execution: blockToolExecution,
            block_recursive_call: blockRecursiveToolResponse,
            ...(messageRole && { message_role: messageRole }), // Add message_role if provided
            ...(requestId && { request_id: requestId }) // Add pre-generated request_id if provided
        };
        
        // Add phase number for conductor mode
        if (phaseNumber !== null) {
            requestBody.conductor_phase = phaseNumber;
        }
        
        // Create abort controller for this request
        currentAbortController = new AbortController();
        
        const response = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: currentAbortController.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response;
    } catch (error) {
        logger.error('Error sending message:', error, true);
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
async function createNewChatInDatabase(chatId, title = 'New Chat') {
    try {
        const response = await fetch(`${API_BASE}/api/chats`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chat_id: chatId,
                title: title
            })
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
async function saveCompleteMessage(chatId, messageData, blocks = null, turnNumber = null) {
    try {
        const requestData = {
            chat_id: chatId,
            role: messageData.role,
            content: messageData.content,
            turn_number: turnNumber,
            blocks: blocks
        };
        
        // Add tool-specific fields if present
        if (messageData.tool_calls) requestData.tool_calls = messageData.tool_calls;
        if (messageData.tool_call_id) requestData.tool_call_id = messageData.tool_call_id;
        if (messageData.tool_name) requestData.tool_name = messageData.tool_name;
        
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
        const response = await fetch(`${API_BASE}/api/message/${messageId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: newContent })
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

// ===== CHAT BRANCHING API =====

// Retry a turn (create new version)
async function retryTurn(chatId, turnNumber) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turn/${turnNumber}/retry`, {
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
        logger.error('Error retrying turn:', error);
        throw error;
    }
}

// Get all versions for a turn
async function getTurnVersions(chatId, turnNumber) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turn/${turnNumber}/versions`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error getting turn versions:', error);
        throw error;
    }
}

// Activate a specific version
async function activateTurnVersion(chatId, turnNumber, versionNumber) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/turn/${turnNumber}/version/${versionNumber}/activate`, {
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
        logger.error('Error activating turn version:', error);
        throw error;
    }
}

// Get all branches for a chat
async function getChatBranches(chatId) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/branches`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        logger.error('Error getting chat branches:', error);
        throw error;
    }
}

// Switch to a specific branch
async function activateChatBranch(chatId, branchId) {
    try {
        const response = await fetch(`${API_BASE}/api/chat/${chatId}/branch/${branchId}/activate`, {
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
        logger.error('Error activating branch:', error);
        throw error;
    }
}