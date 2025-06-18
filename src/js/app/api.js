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

// Send a chat message with pre-filtered tool definitions
async function sendMessageWithTools(message, conductorMode = false, toolDefinitions = [], phaseNumber = null, messageRole = null, blockToolExecution = false, blockRecursiveToolResponse = false, messageId = null) {
    try {
        const requestBody = {
            message: message,
            chat_id: currentChatId,
            conductor_mode: conductorMode,
            enabled_tools: toolDefinitions, // Send actual tool definitions instead of enable/disable flags
            block_tool_execution: blockToolExecution,
            block_recursive_call: blockRecursiveToolResponse,
            ...(messageRole && { message_role: messageRole }), // Add message_role if provided
            ...(messageId && { message_id: messageId }) // Add pre-generated message_id if provided
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
    return enabledTools[`${serverName}.${toolName}`] !== false; // Default to enabled
}

function setToolEnabled(serverName, toolName, enabled) {
    const enabledTools = loadEnabledTools();
    const toolKey = `${serverName}.${toolName}`;
    
    if (enabled) {
        delete enabledTools[toolKey]; // Remove from storage (default is enabled)
    } else {
        enabledTools[toolKey] = false; // Explicitly disable
    }
    
    saveEnabledTools(enabledTools);
}

function getEnabledToolsForServer(serverName, allTools) {
    return allTools.filter(tool => isToolEnabled(serverName, tool));
}
// Make tool functions globally available
window.isToolEnabled = isToolEnabled;
window.setToolEnabled = setToolEnabled;
window.loadEnabledTools = loadEnabledTools;
window.loadEnabledToolsFromBackend = loadEnabledToolsFromBackend;
window.saveEnabledTools = saveEnabledTools;
window.getEnabledToolsForServer = getEnabledToolsForServer;
window.cachedEnabledTools = cachedEnabledTools;

// Make chat functions globally available
window.updateChatTitleInDatabase = updateChatTitleInDatabase;

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
async function saveCompleteMessage(chatId, messageData, debugData = null, blocks = null) {
    try {
        const requestData = {
            chat_id: chatId,
            role: messageData.role,
            content: messageData.content,
            debug_data: debugData,
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
