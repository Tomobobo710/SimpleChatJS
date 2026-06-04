// Chat Service - Handle AI chat logic, streaming, and tool execution with adapters per api
// ===== NEW FILE HANDLING FUNCTIONS =====

/**
 * Extract file content from multimodal message content
 * @param {Array|string} content - Message content (array for multimodal, string for text-only)
 * @returns {Object} - { textContent, files, images, hasFiles }
 */
function extractFilesFromContent(content) {
    // Initialize return object
    const result = {
        textContent: '',
        files: [],
        images: [],
        hasFiles: false
    };
    
    if (typeof content === 'string') {
        // Simple text content, no files
        result.textContent = content;
        return result;
    }
    
    if (!Array.isArray(content)) {
        // Unknown content type, treat as text
        result.textContent = String(content || '');
        return result;
    }
    
    // Process multimodal array content
    content.forEach(part => {
        if (part.type === 'text') {
            result.textContent = part.text || '';
        } else if (part.type === 'image') {
            result.images.push(part);
        } else if (part.type === 'files' && part.files && Array.isArray(part.files)) {
            // New file structure
            result.files = part.files;
            result.hasFiles = true;
        }
    });
    
    return result;
}

/**
 * Concatenate file content to text content for AI processing
 * @param {string} textContent - Original user text
 * @param {Array} files - Array of file objects with extractedText
 * @returns {string} - Concatenated content ready for AI
 */
function concatenateFileContent(textContent, files) {
    let finalText = textContent || '';
    
    if (files && Array.isArray(files) && files.length > 0) {
        files.forEach(file => {
            if (file.extractedText) {
                finalText += `\n\n\`\`\`userdocument\nFile: ${file.fileName}\n${file.extractedText}\n\`\`\``;
            }
        });
        
        log(`[FILE-PROCESSING] Concatenated ${files.length} file(s) to message content`);
    }
    
    return finalText;
}

/**
 * Create multimodal content with separated files for storage
 * This preserves the original structure while also providing concatenated content for AI
 * @param {string} userText - User's actual text input
 * @param {Array} files - File objects array
 * @param {Array} images - Image objects array
 * @returns {Object} - { originalContent, concatenatedContent }
 */
function createSeparatedFileContent(userText, files, images) {
    const hasFiles = files && files.length > 0;
    const hasImages = images && images.length > 0;
    
    let originalContent, concatenatedContent;
    
    if (hasFiles || hasImages) {
        // Create multimodal array preserving file structure
        originalContent = [];
        
        // Add text part
        if (userText || hasFiles) {
            originalContent.push({
                type: 'text',
                text: userText || ''
            });
        }
        
        // Add images
        if (hasImages) {
            originalContent.push(...images);
        }
        
        // Add files as separate part
        if (hasFiles) {
            originalContent.push({
                type: 'files',
                files: files
            });
        }
        
        // Create concatenated version for AI
        concatenatedContent = concatenateFileContent(userText, files);
        
    } else {
        // Simple text content
        originalContent = userText || '';
        concatenatedContent = userText || '';
    }
    
    return { originalContent, concatenatedContent };
}

/**
 * Process message content for AI consumption
 * Extracts files and creates concatenated content while preserving original structure
 * @param {Array|string} messageContent - Original message content from frontend
 * @returns {Object} - { aiContent, originalContent, fileMetadata }
 */
function processMessageForAI(messageContent) {
    const extracted = extractFilesFromContent(messageContent);
    const { textContent, files, images, hasFiles } = extracted;
    
    let aiContent;
    
    if (hasFiles || images.length > 0) {
        // Create multimodal content for AI with concatenated text
        aiContent = [];
        
        // Add concatenated text (user text + file contents)
        const concatenatedText = concatenateFileContent(textContent, files);
        if (concatenatedText) {
            aiContent.push({
                type: 'text',
                text: concatenatedText
            });
        }
        
        // Add images (unchanged)
        if (images.length > 0) {
            aiContent.push(...images);
        }
    } else {
        // Simple text content
        aiContent = textContent;
    }
    
    return {
        aiContent,
        originalContent: messageContent,
        fileMetadata: {
            hasFiles,
            fileCount: files.length,
            imageCount: images.length,
            files: files
        }
    };
}
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { log } = require('../utils/logger');

// Simple debug flag for adapter logs - set DEBUG=1 to enable
const DEBUG_ADAPTERS = process.env.DEBUG === '1';
const { getCurrentSettings } = require('./settingsService');
const { executeMCPTool, getAvailableToolsForChat } = require('./mcpService');
const { addToolEvent, storeDebugData } = require('./toolEventService');

// Turn-based debug data functions (keyed on turn_id to be sibling-safe —
// M6). Two sibling turns can share a turn_number, so keying debug storage
// on turn_id ensures each lineage's debug data is independent.
async function saveTurnDebugData(chatId, turnId, debugData) {
    const { db } = require('../config/database');

    try {
        if (!turnId) {
            // Aborted streams reach saveTurnDebugData before the assistant
            // message has a turn_id assigned by the backend. Skip rather
            // than insert a placeholder row (the previous version of this
            // function did `INSERT … VALUES (?, ?, 'user', '', …)`, which
            // created ghost user rows and clobbered sibling debug data).
            log(`[TURN-DEBUG] Skipping debug save for chat ${chatId}: no turn_id yet (aborted stream?)`);
            return null;
        }

        const debugDataJson = JSON.stringify(debugData);

        // Update the existing message row. The caller is responsible for
        // ensuring the row exists (it does — frontend saves the user row
        // before sending, and the assistant row is created by handleChatWithTools
        // before streamAndRenderAssistant fires saveTurnDebugData).
        const updateStmt = db.prepare(`
            UPDATE messages
            SET debug_data = ?
            WHERE chat_id = ? AND turn_id = ?
        `);
        const result = updateStmt.run(debugDataJson, chatId, turnId);

        if (result.changes === 0) {
            log(`[TURN-DEBUG] No message found for chat=${chatId} turn_id=${turnId}; debug data not saved`);
        } else {
            log(`[TURN-DEBUG] Saved debug data for turn_id=${turnId} in chat ${chatId}`);
        }
        return result;
    } catch (err) {
        log('[TURN-DEBUG] Error saving turn debug data:', err);
        throw err;
    }
}

function getTurnDebugData(chatId, turnId) {
    const { db } = require('../config/database');

    try {
        const stmt = db.prepare(`
            SELECT debug_data
            FROM messages
            WHERE chat_id = ? AND turn_id = ? AND debug_data IS NOT NULL
            LIMIT 1
        `);
        const result = stmt.get(chatId, turnId);

        if (result && result.debug_data) {
            const debugData = JSON.parse(result.debug_data);
            log(`[TURN-DEBUG] Retrieved debug data for turn_id=${turnId} in chat ${chatId}`);
            return debugData;
        } else {
            log(`[TURN-DEBUG] No debug data found for turn_id=${turnId} in chat ${chatId}`);
            return null;
        }
    } catch (err) {
        log('[TURN-DEBUG] Error getting turn debug data:', err);
        return null;
    }
}

// Branch navigation selections: persisted per-chat, keyed by parent_key
// ('root' or a turn_id). The frontend's selectedSiblings map is scoped
// to chatId, but the DB stores one row per (chat_id, parent_key) which
// is the natural shape for the underlying query. Used so a user's
// explicit prev/next picks survive page reloads and app restarts.

// Replace all branch selections for a chat. The frontend sends the full
// current set of selections for this chat (filtered from its in-memory
// map) so the DB stays consistent even if the user clicks before the
// next load sees them.
function saveBranchSelections(chatId, selections) {
    const { db } = require('../config/database');
    if (!chatId) {
        throw new Error('saveBranchSelections: chatId is required');
    }
    if (selections && typeof selections !== 'object') {
        throw new Error(`saveBranchSelections: selections must be an object map, got ${typeof selections}`);
    }
    const map = selections || {};

    try {
        const upsert = db.prepare(`
            INSERT INTO chat_branch_selections (chat_id, parent_key, selected_turn_id)
            VALUES (?, ?, ?)
            ON CONFLICT(chat_id, parent_key) DO UPDATE SET selected_turn_id = excluded.selected_turn_id
        `);
        const remove = db.prepare(`
            DELETE FROM chat_branch_selections
            WHERE chat_id = ? AND parent_key NOT IN (${Object.keys(map).length ? Object.keys(map).map(() => '?').join(',') : 'NULL'})
        `);

        const tx = db.transaction(() => {
            for (const [parentKey, selectedTurnId] of Object.entries(map)) {
                if (typeof selectedTurnId !== 'string' || !selectedTurnId) {
                    throw new Error(`saveBranchSelections: invalid selected_turn_id for parent_key="${parentKey}"`);
                }
                upsert.run(chatId, parentKey, selectedTurnId);
            }
            // Remove rows for parent_keys no longer in the map so the DB
            // doesn't accumulate stale entries (e.g. parent_key was a
            // turn_id that has since been deleted/edited).
            if (Object.keys(map).length > 0) {
                remove.run(chatId, ...Object.keys(map));
            } else {
                remove.run(chatId);
            }
        });
        tx();
        log(`[BRANCH-SEL] Saved ${Object.keys(map).length} selection(s) for chat ${chatId}`);
        return { count: Object.keys(map).length };
    } catch (err) {
        log(`[BRANCH-SEL] Error saving selections for chat ${chatId}:`, err.message);
        throw err;
    }
}

// Return all branch selections for a chat as a { parentKey: turnId } map.
// Returns {} for an unknown chat; throws on actual DB errors.
function loadBranchSelections(chatId) {
    const { db } = require('../config/database');
    if (!chatId) {
        throw new Error('loadBranchSelections: chatId is required');
    }
    try {
        const rows = db.prepare(`
            SELECT parent_key, selected_turn_id
            FROM chat_branch_selections
            WHERE chat_id = ?
        `).all(chatId);
        const result = {};
        for (const row of rows) {
            result[row.parent_key] = row.selected_turn_id;
        }
        log(`[BRANCH-SEL] Loaded ${rows.length} selection(s) for chat ${chatId}`);
        return result;
    } catch (err) {
        log(`[BRANCH-SEL] Error loading selections for chat ${chatId}:`, err.message);
        throw err;
    }
}

// Delete all branch selections for a chat. Used by the chat-delete route
// in its transaction; the FK relationship in messages has no CASCADE, so
// we match that pattern explicitly here.
function deleteBranchSelections(chatId) {
    const { db } = require('../config/database');
    if (!chatId) {
        throw new Error('deleteBranchSelections: chatId is required');
    }
    try {
        const result = db.prepare(`
            DELETE FROM chat_branch_selections WHERE chat_id = ?
        `).run(chatId);
        log(`[BRANCH-SEL] Deleted ${result.changes} selection(s) for chat ${chatId}`);
        return result;
    } catch (err) {
        log(`[BRANCH-SEL] Error deleting selections for chat ${chatId}:`, err.message);
        throw err;
    }
}

// Get current turn number for a chat
function getCurrentTurnNumber(chat_id) {
    if (!chat_id) {
        return 0; // Default to turn 0
    }
    
    const { db } = require('../config/database');
    
    try {
        const stmt = db.prepare('SELECT turn_number FROM chats WHERE id = ?');
        const result = stmt.get(chat_id);
        const currentTurn = result ? (result.turn_number || 0) : 0;
        log(`[CURRENT-TURN] Chat ${chat_id}: current turn = ${currentTurn}`);
        return currentTurn;
    } catch (err) {
        log('[CHAT-TURN] Error getting current turn:', err);
        return 0; // Default to turn 0 on error
    }
}

function getTurnInfo(parentTurnId = null, turnId = null) {
    const resolvedTurnId = turnId || crypto.randomUUID();
    const resolvedParentTurnId = parentTurnId || null;
    
    log(`[TURN-INFO] turn_id=${resolvedTurnId}, parent_turn_id=${resolvedParentTurnId}`);
    
    return { turn_id: resolvedTurnId, parent_turn_id: resolvedParentTurnId };
}

function incrementTurnNumber(chat_id) {
    if (!chat_id) {
        return;
    }
    
    const { db } = require('../config/database');
    
    try {
        const stmt = db.prepare('UPDATE chats SET turn_number = turn_number + 1 WHERE id = ?');
        const result = stmt.run(chat_id);
        
        if (result.changes > 0) {
            const newTurn = getCurrentTurnNumber(chat_id);
            log(`[INCREMENT-TURN] Chat ${chat_id}: incremented to turn ${newTurn}`);
        } else {
            log(`[INCREMENT-TURN] Chat ${chat_id}: no chat found to increment`);
        }
    } catch (err) {
        log('[INCREMENT-TURN] Error incrementing turn:', err);
    }
}

// Walk the parent_turn_id chain from a given turn_id up to the root.
// Returns an array of turn_ids in the ancestor chain (including the starting turn_id).
function getAncestorTurnIds(chat_id, startTurnId) {
    const { db } = require('../config/database');
    const ancestors = [];
    let currentId = startTurnId;
    
    while (currentId) {
        ancestors.push(currentId);
        const row = db.prepare(
            'SELECT parent_turn_id FROM messages WHERE chat_id = ? AND turn_id = ? LIMIT 1'
        ).get(chat_id, currentId);
        currentId = row ? row.parent_turn_id : null;
    }
    
    return ancestors;
}

// Get chat history for API (filtered for AI consumption)
function getChatHistoryForAPI(chat_id, maxTurnId = null) {
    if (!chat_id) {
        return [];
    }
    
    const { db } = require('../config/database');
    const messages = [];
    
    try {
        log(`[CHAT-HISTORY] Getting complete history for chat ${chat_id}`);
        
        // Get all messages for the chat, filter out errors for AI consumption
        let messagesStmt;
        let chatMessages;
        if (maxTurnId) {
            // Lineage filtering: include only exact turn_ids in the selected ancestry path.
            const ancestorIds = getAncestorTurnIds(chat_id, maxTurnId);
            log(`[CHAT-HISTORY] Lineage filter: ancestor turn_ids = ${ancestorIds.join(', ')}`);
            const turnIdPlaceholders = ancestorIds.map(() => '?').join(',');
            
            messagesStmt = db.prepare(`
                SELECT role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, original_content, file_metadata
                FROM messages
                WHERE chat_id = ? AND error_state IS NULL AND turn_id IN (${turnIdPlaceholders})
                ORDER BY timestamp ASC
            `);
            chatMessages = messagesStmt.all(chat_id, ...ancestorIds);
        } else {
            messagesStmt = db.prepare(`
                SELECT role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, original_content, file_metadata
                FROM messages
                WHERE chat_id = ? AND error_state IS NULL
                ORDER BY timestamp ASC
            `);
            chatMessages = messagesStmt.all(chat_id);
        }
        
        log(`[CHAT-HISTORY] Retrieved ${chatMessages.length} successful messages (errors filtered out)`);
        
        chatMessages.forEach(row => {
            // Process saved messages to ensure AI gets correct content
            let finalContent = row.content;
            
            // If this message has original content and file metadata, we need to process it for AI
            if (row.original_content && row.file_metadata) {
                try {
                    const originalContent = typeof row.original_content === 'string' && row.original_content.startsWith('[') 
                        ? JSON.parse(row.original_content)
                        : row.original_content;
                    const fileMetadata = JSON.parse(row.file_metadata);
                    
                    // If there are files, re-process for AI to get concatenated content
                    if (fileMetadata.hasFiles) {
                        const processedMessage = processMessageForAI(originalContent);
                        finalContent = processedMessage.aiContent;
                        log(`[CHAT-HISTORY] Reprocessed message with ${fileMetadata.fileCount} file(s) for AI`);
                    }
                } catch (e) {
                    log(`[CHAT-HISTORY] Error processing file metadata: ${e.message}`);
                    // Fall back to stored content
                }
            }
            
            // Parse content - handle both string and JSON (multimodal) content
            let parsedContent = finalContent;
            if (typeof finalContent === 'string' && finalContent.startsWith('[')) {
                try {
                    // Try to parse as JSON array (multimodal content)
                    parsedContent = JSON.parse(finalContent);
                } catch (e) {
                    // If parsing fails, keep as string
                    parsedContent = finalContent;
                }
            }
            
            const message = {
                role: row.role,
                content: parsedContent,
                turn_number: row.turn_number,
                turn_id: row.turn_id,
                parent_turn_id: row.parent_turn_id
            };
            
            // Add tool data if present
            if (row.tool_calls) {
                try {
                    message.tool_calls = JSON.parse(row.tool_calls);
                } catch (e) {
                    log(`[CHAT-HISTORY] Error parsing tool_calls: ${e.message}`);
                }
            }
            if (row.tool_call_id) {
                message.tool_call_id = row.tool_call_id;
            }
            if (row.tool_name) {
                message.tool_name = row.tool_name;
            }
            
            messages.push(message);
        });
        
        log(`[CHAT-HISTORY] Retrieved ${messages.length} messages from chat ${chat_id}`);
        return messages;
        
    } catch (err) {
        log('[CHAT-HISTORY] Error getting chat history:', err);
        throw new Error(`Failed to load chat history: ${err.message}`);
    }
}
// Save complete message structure to database
async function saveCompleteMessageToDatabase(chatId, messageData, turnNumber = null, errorState = null, turnInfo = null) {
    return await saveMessage(chatId, messageData, turnNumber, errorState, turnInfo);
}

// Save message to chat (no branch concept)
async function saveMessage(chatId, messageData, turnNumber = null, errorState = null, turnInfo = null) {
    const { db } = require('../config/database');
    
    try {
        // Prepare message data
        const content = Array.isArray(messageData.content) 
            ? JSON.stringify(messageData.content)
            : messageData.content || '';
        const role = messageData.role || 'user';
        const toolCalls = messageData.tool_calls ? JSON.stringify(messageData.tool_calls) : null;
        const toolCallId = messageData.tool_call_id || null;
        const toolName = messageData.tool_name || null;
        const debugData = messageData.debug_data ? JSON.stringify(messageData.debug_data) : null;
        
        // Handle original content and file metadata
        const originalContent = messageData.originalContent 
            ? (Array.isArray(messageData.originalContent) 
                ? JSON.stringify(messageData.originalContent) 
                : messageData.originalContent)
            : null;
        const fileMetadata = messageData.fileMetadata ? JSON.stringify(messageData.fileMetadata) : null;
        
        // Use turn number or get next
        let finalTurnNumber = turnNumber;
        if (finalTurnNumber === null) {
            finalTurnNumber = getCurrentTurnNumber(chatId);
        }
        
        // Extract turn info
        const turnId = turnInfo?.turn_id || null;
        const parentTurnId = turnInfo?.parent_turn_id || null;
        
        // Insert message with turn info
        const insertStmt = db.prepare(`
            INSERT INTO messages 
            (chat_id, role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, debug_data, original_content, file_metadata, error_state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const result = insertStmt.run(
            chatId, role, content, finalTurnNumber, turnId, parentTurnId,
            toolCalls, toolCallId, toolName, debugData, originalContent, fileMetadata, errorState
        );
        
        // Update chat's updated_at timestamp
        const updateChatStmt = db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        updateChatStmt.run(chatId);
        
        log(`[SAVE] Saved ${role} message to chat ${chatId} (turn ${finalTurnNumber}, turn_id=${turnId}, parent_turn_id=${parentTurnId})`);
        return result.lastInsertRowid;
        
    } catch (error) {
        log('[SAVE] Error saving message:', error);
        throw error;
    }
}

// Import adapter system
const responseAdapterFactory = require('../adapters/ResponseAdapterFactory');
const UnifiedResponse = require('../adapters/UnifiedResponse');

// Handle chat with potential tool calls
async function handleChatWithTools(res, messages, tools, chatId, debugData = null, responseCounter = 1, requestId = null, existingDebugData = null, parentTurnId = null, userTurnId = null) {
    const currentSettings = getCurrentSettings();
    
    // Ensure we have a model name
    if (!currentSettings.modelName) {
        res.status(400).json({ error: 'No model specified. Please configure a model in settings.' });
        return;
    }
    
    // Get the appropriate adapter for current settings
    const adapter = responseAdapterFactory.getAdapter(currentSettings);
    log(`[ADAPTER] Using ${adapter.providerName} adapter`);
    
    // Set up tool event emitter for the adapter
    adapter.setToolEventEmitter((eventType, data, reqId) => {
        if (reqId) {
            addToolEvent(reqId, { type: eventType, data: data });
        }
    });
    
    // Generate turn info for this conversation turn
    // userTurnId = the turn_id of the message that triggered this (user's turn_id for first call, assistant's for tool call chain)
    // parentTurnId = the parent_turn_id to use (from frontend for first call, from previous turn for recursive calls)
    let turnInfo;
    if (userTurnId) {
        // Reuse the parent_turn_id from the previous turn, generate new turn_id
        turnInfo = getTurnInfo(userTurnId);
    } else {
        // First call - generate both turn_id and parent_turn_id
        turnInfo = getTurnInfo(null);
    }
    
    // Create unified request
    const unifiedRequest = responseAdapterFactory.createUnifiedRequest(messages, tools, currentSettings.modelName);
    
    // Convert to provider-specific format
    const requestData = adapter.convertRequest(unifiedRequest);
    
    // Set up streaming response FIRST
    if (!res.headersSent) {
        const headers = {
            'Content-Type': 'text/plain',
            'Transfer-Encoding': 'chunked'
        };

        if (requestId) {
            headers['X-Request-Id'] = requestId;
        }

        // Include the actual AI request in response headers for frontend debug panel
        if (requestData) {
            headers['X-Actual-Request'] = encodeURIComponent(JSON.stringify(requestData));
        }

        // Assistant turn identifiers, set up-front (turnInfo is built above
        // at the assistant-row insert site) so the frontend can stamp the
        // rendered bubble without a follow-up getCompleteChatHistory fetch
        // (Phase 6 Task 18, replacing the old getLastTurnInfo round-trip).
        // These IDs are stable for the entire tool-call chain because
        // recursive handleChatWithTools calls reuse the same `res` object
        // and the same turnInfo.
        if (turnInfo?.turn_id) {
            headers['X-Assistant-Turn-Id'] = turnInfo.turn_id;
        }
        if (turnInfo?.parent_turn_id) {
            headers['X-Assistant-Parent-Turn-Id'] = turnInfo.parent_turn_id;
        }

        res.writeHead(200, headers);
    }
    
    // Initialize debug data and turn number
    let collectedDebugData = existingDebugData;
    
    // Use the user turn number provided by frontend
    let currentTurn;
    if (collectedDebugData && collectedDebugData.currentTurn) {
        // Reuse existing turn from recursive calls
        currentTurn = collectedDebugData.currentTurn;
    } else {
        // Calculate turn number from DB
        currentTurn = chatId ? getCurrentTurnNumber(chatId) + 1 : 1;
    }
    
    // Calculate next sequence step from existing debug data to maintain sequential order across recursive calls
    let sequenceStep = 1;
    if (collectedDebugData) {
        const sequenceCount = (collectedDebugData.sequence && Array.isArray(collectedDebugData.sequence)) ? collectedDebugData.sequence.length : 0;
        const httpSequenceCount = (collectedDebugData.httpSequence && Array.isArray(collectedDebugData.httpSequence)) ? collectedDebugData.httpSequence.length : 0;
        sequenceStep = sequenceCount + httpSequenceCount + 1;
    }
    
    if (debugData && requestId && !collectedDebugData) {
        collectedDebugData = {
            requestId: requestId,
            currentTurn: currentTurn,
            sequence: [],
            metadata: {
                endpoint: adapter.getEndpointUrl(currentSettings),
                timestamp: new Date().toISOString(),
                tools: tools.length,
                provider: adapter.providerName,
                model: currentSettings.modelName
            },
            rawData: {
                httpResponse: {
                    statusCode: null,
                    statusMessage: null,
                    headers: null
                },
                errors: []
            }
        };
    } else if (collectedDebugData && !collectedDebugData.currentTurn) {
        // Store turn number in existing debug data if not already set
        collectedDebugData.currentTurn = currentTurn;
    }
    
    // Get provider-specific URL and headers
    const targetUrl = adapter.getEndpointUrl(currentSettings);
    const headers = adapter.getHeaders(currentSettings);
    headers['Content-Length'] = Buffer.byteLength(JSON.stringify(requestData));
    
    if (DEBUG_ADAPTERS) {
        log(`[${adapter.providerName.toUpperCase()}-DEBUG] URL:`, targetUrl);
        log(`[${adapter.providerName.toUpperCase()}-DEBUG] Request Body:`, JSON.stringify(requestData, null, 2));
    }
    
    // Store the REAL request data in the user's debug data    
    if (chatId && currentTurn) {
        try {
            const userDebugData = getTurnDebugData(chatId, currentTurn);
            
            if (userDebugData) {
                // Store the ACTUAL request that gets sent to AI with real tool definitions
                userDebugData.actualHttpRequest = {
                    url: targetUrl,
                    method: 'POST',
                    headers: { ...headers },
                    body: requestData // This is the REAL request with full tool definitions
                };
                
                // Save back to the same turn
                saveTurnDebugData(chatId, currentTurn, userDebugData);
            } else {
                log('[DEBUG-STORE] FAIL - No user debug data found');
            }
        } catch (error) {
            log('[DEBUG-STORE] ERROR:', error.message);
        }
    } else {
        log('[DEBUG-STORE] SKIP - Missing chatId or currentTurn');
    }
    
    log('[ACTUAL-REQUEST] Sending to API:', JSON.stringify(requestData, null, 2));
    
    const url = new URL(targetUrl);
    const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: headers
    };
    
    // Create unified response object
    const unifiedResponse = new UnifiedResponse().setProvider(adapter.providerName);
    const context = adapter.createContext(currentSettings.modelName);
    
    // Make HTTP request
    const httpModule = url.protocol === 'https:' ? https : http;
    const apiReq = httpModule.request(options, (apiRes) => {
        // Capture debug data
        if (collectedDebugData && collectedDebugData.rawData) {
            collectedDebugData.rawData.httpResponse = {
                statusCode: apiRes.statusCode,
                statusMessage: apiRes.statusMessage,
                headers: apiRes.headers
            };
        }
        
        if (apiRes.statusCode !== 200) {
            let errorData = '';
            apiRes.on('data', (chunk) => {
                errorData += chunk.toString();
            });
            apiRes.on('end', () => {
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Status:`, apiRes.statusCode);
                log(`[${adapter.providerName.toUpperCase()}-ERROR] Response:`, errorData);
                if (collectedDebugData && collectedDebugData.rawData && collectedDebugData.rawData.errors) {
                    collectedDebugData.rawData.errors.push({ type: 'http_error', message: errorData });
                }
                
                // Parse and show the actual API error message to the user
                let userErrorMessage = `API error: ${apiRes.statusCode} ${apiRes.statusMessage}`;
                
                try {
                    // Try to parse the error response and extract useful details
                    const errorObj = JSON.parse(errorData);
                    if (errorObj.error && errorObj.error.message) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorObj.error.message}`;
                    } else if (errorObj.message) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorObj.message}`;
                    } else if (errorObj.detail) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorObj.detail}`;
                    }
                } catch (parseError) {
                    // If error response isn't JSON, show raw error data if it's reasonable length
                    if (errorData && errorData.length < 500) {
                        userErrorMessage = `[${apiRes.statusCode}] ${errorData.trim()}`;
                    }
                }
                
                // IMPROVED ERROR HANDLING: Save error message and burn the turn
                if (chatId && currentTurn) {
                    const errorMessage = {
                        role: 'assistant',
                        content: userErrorMessage,
                        debug_data: collectedDebugData
                    };
                    saveCompleteMessageToDatabase(chatId, errorMessage, currentTurn, 'api_error', turnInfo)
                        .then(() => {
                            incrementTurnNumber(chatId); // Burn the turn
                            log(`[ERROR-HANDLING] Saved API error message and burned turn ${currentTurn}`);
                        })
                        .catch(saveError => {
                            log(`[ERROR-HANDLING] Failed to save error message: ${saveError.message}`);
                        });
                }
                
                res.write(userErrorMessage);
                res.end();
            });
            return;
        }
        
        // Stream response processing
        apiRes.on('data', (chunk) => {
            try {
                // Process chunk with adapter
                const result = adapter.processChunk(chunk, unifiedResponse, context);
                
                // Handle any events generated - THIS IS CRITICAL FOR TOOL DROPDOWNS!
                for (const event of result.events) {
                    if (event.type === 'tool_call_detected' && requestId) {
                        addToolEvent(requestId, {
                            type: 'tool_call_detected',
                            data: {
                                name: event.data.toolName,
                                id: event.data.toolId
                            }
                        });
                        if (DEBUG_ADAPTERS) log(`[ADAPTER-TOOL-EVENT] Tool call detected:`, event.data.toolName);
                    }
                }
                
                // Update context
                Object.assign(context, result.context);
                
                // Stream any new content to client
                let newContent = '';
                if (unifiedResponse.content && context.lastContentLength !== unifiedResponse.content.length) {
                    newContent = unifiedResponse.content.slice(context.lastContentLength || 0);
                    if (newContent) {
                        res.write(newContent);
                        context.lastContentLength = unifiedResponse.content.length;
                        
                        // Capture the actual content being sent to frontend for debug
                        if (collectedDebugData) {
                            if (!collectedDebugData.streamedContent) {
                                collectedDebugData.streamedContent = '';
                            }
                            collectedDebugData.streamedContent += newContent;
                        }
                    }
                }
                
                // Add to debug data (accumulate response chunks)
                if (collectedDebugData) {
                    if (!collectedDebugData.rawResponseChunks) {
                        collectedDebugData.rawResponseChunks = [];
                    }
                    collectedDebugData.rawResponseChunks.push({
                        chunk: chunk.toString(),
                        timestamp: new Date().toISOString()
                    });
                }
                
            } catch (error) {
                console.error(`[${adapter.providerName.toUpperCase()}-ADAPTER] Error processing chunk:`, error);
                if (collectedDebugData && collectedDebugData.rawData && collectedDebugData.rawData.errors) {
                    collectedDebugData.rawData.errors.push({ type: 'processing_error', message: error.message });
                }
            }
        });
        
        apiRes.on('end', async () => {
            log(`[${adapter.providerName.toUpperCase()}-ADAPTER] Stream ended`);
            
            // Add response step to debug sequence
            if (collectedDebugData && collectedDebugData.sequence) {
                const responseStep = {
                    type: 'response',
                    step: sequenceStep++,
                    timestamp: new Date().toISOString(),
                    data: {
                        raw_http_response: {
                            status: collectedDebugData.rawData.httpResponse.statusCode,
                            provider: adapter.providerName,
                            response_chunks: collectedDebugData.rawResponseChunks || []
                        },
                        content: collectedDebugData.streamedContent || 'No content streamed',
                        has_tool_calls: unifiedResponse.hasToolCalls()
                    }
                };
                collectedDebugData.sequence.push(responseStep);
            }
            
            // Capture complete HTTP response (REAL data)
            if (collectedDebugData && requestId) {
                if (!collectedDebugData.httpSequence) {
                    collectedDebugData.httpSequence = [];
                }
                
                collectedDebugData.httpSequence.push({
                    type: 'http_response',
                    sequence: sequenceStep++,
                    timestamp: new Date().toISOString(),
                    content: unifiedResponse.content || '',
                    toolCalls: unifiedResponse.toolCalls || [],
                    hasToolCalls: unifiedResponse.hasToolCalls()
                });
                
                log(`[SEQUENTIAL-DEBUG] Captured HTTP response, hasTools: ${unifiedResponse.hasToolCalls()}`);
            }
            
            // Handle tool calls if any
            if (unifiedResponse.hasToolCalls()) {
                log(`[ADAPTER] Processing ${unifiedResponse.toolCalls.length} tool calls`);
                
                // Add tool execution steps to debug sequence
                if (collectedDebugData && collectedDebugData.sequence) {
                    for (const toolCall of unifiedResponse.toolCalls) {
                        collectedDebugData.sequence.push({
                            type: 'tool_execution',
                            step: sequenceStep++,
                            timestamp: new Date().toISOString(),
                            data: {
                                tool_name: toolCall.function.name,
                                tool_id: toolCall.id,
                                arguments: JSON.parse(toolCall.function.arguments)
                            }
                        });
                    }
                }
                
                // Execute tools and continue conversation
                await executeToolCallsAndContinue(
                    res, unifiedResponse.toolCalls, messages, tools, chatId,
                    unifiedResponse.content, collectedDebugData, responseCounter,
                    requestId, turnInfo
                );
            } else {
                // No tool calls, finish response
                res.end();
                
                // Increment turn number now that conversation is complete
                if (chatId) {
                    incrementTurnNumber(chatId);
                }
                
                // Save final assistant response to history before ending
                // Save assistant response
                if (chatId && unifiedResponse.content) {
                    log(`[CHAT-SAVE] About to save final assistant response:`);
                    log(`[CHAT-SAVE] Content length: ${unifiedResponse.content.length}`);
                    log(`[CHAT-SAVE] Content preview: "${unifiedResponse.content.substring(0, 200)}..."`);
                    log(`[CHAT-SAVE] Turn number: ${currentTurn}`);
                    
                    const finalAssistantMessage = {
                        role: 'assistant',
                        content: unifiedResponse.content
                    };
                    try {
                        await saveCompleteMessageToDatabase(chatId, finalAssistantMessage, currentTurn, null, turnInfo);
                        log(`[CHAT-SAVE] Successfully saved final assistant response to history`);
                    } catch (error) {
                        log(`[CHAT-SAVE] Error saving final assistant response: ${error.message}`);
                    }
                } else {
                    log(`[CHAT-SAVE] NOT saving final response - chatId: ${chatId}, content length: ${unifiedResponse.content ? unifiedResponse.content.length : 'null'}`);
                }
                
                // Store debug data with complete history
                if (collectedDebugData && requestId) {
                    // Add complete chat history to debug data
                    if (chatId) {
                        try {
                            // Get the complete history
                            collectedDebugData.completeMessageHistory = getChatHistoryForAPI(chatId);
                            
                            // Get the current turn number for debug panel consistency
                            // This ensures "Messages In This Turn" works when reloading saved chats
                            collectedDebugData.currentTurnNumber = getCurrentTurnNumber(chatId);
                            collectedDebugData.currentTurnMessages = null; // Will be fetched by frontend as needed
                        } catch (error) {
                            collectedDebugData.completeMessageHistory = { error: error.message };
                            collectedDebugData.currentTurnMessages = { error: error.message };
                            collectedDebugData.currentTurnNumber = null;
                        }
                    }
                    
                    storeDebugData(requestId, collectedDebugData);
                    log(`[ADAPTER-DEBUG] Debug data stored for request:`, requestId);
                }
            }
        });
    });
    
    apiReq.on('error', (error) => {
        log(`[${adapter.providerName.toUpperCase()}] Request error:`, error);
        if (collectedDebugData && collectedDebugData.rawData && collectedDebugData.rawData.errors) {
            collectedDebugData.rawData.errors.push({ type: 'request_error', message: error.message });
        }
        
        // IMPROVED ERROR HANDLING: Save connection error and burn the turn
        if (chatId && currentTurn) {
            const errorMessage = {
                role: 'assistant',
                content: `Connection error: ${error.message}`,
                debug_data: collectedDebugData
            };
            saveCompleteMessageToDatabase(chatId, errorMessage, currentTurn, 'connection_error', turnInfo)
                .then(() => {
                    incrementTurnNumber(chatId); // Burn the turn
                    log(`[ERROR-HANDLING] Saved connection error and burned turn ${currentTurn}`);
                })
                .catch(saveError => {
                    log(`[ERROR-HANDLING] Failed to save connection error: ${saveError.message}`);
                });
        }
        
        res.write(`Connection error: ${error.message}`);
        res.end();
    });
    
    // Capture ACTUAL HTTP request payload being sent
    const actualRequestPayload = JSON.stringify(requestData);
    
    // Add to sequential debug data (real HTTP request)
    if (collectedDebugData && requestId) {
        if (!collectedDebugData.httpSequence) {
            collectedDebugData.httpSequence = [];
        }
        
        // Only add HTTP request to debug data if it's not the first request
        // The first request is initiated in the user bubble phase and already logged there
        if (collectedDebugData.httpSequence.length > 0 || responseCounter > 1) {
            const requestSequenceNumber = sequenceStep++;
            
            collectedDebugData.httpSequence.push({
                type: 'http_request',
                sequence: requestSequenceNumber,
                timestamp: new Date().toISOString(),
                payload: JSON.parse(actualRequestPayload),  // Store as object for debug panel
                rawPayload: actualRequestPayload            // Store as string for exact representation
            });
            

        } else {
            log(`[SEQUENTIAL-DEBUG] Skipping first HTTP request debug - already captured in user phase`);
        }
    }
    
    apiReq.write(actualRequestPayload);
    apiReq.end();
}

// Execute tool calls and continue conversation
async function executeToolCallsAndContinue(res, toolCalls, messages, tools, chatId, assistantMessage, debugData, responseCounter, requestId, turnInfo = null) {
    // Get the turn number from debug data (calculated once at conversation start)
    const currentTurn = debugData && debugData.currentTurn ? debugData.currentTurn : 1;
    
    // Add assistant message with tool calls to conversation
    const assistantMessageWithTools = {
        role: 'assistant',
        content: assistantMessage || '',
        tool_calls: toolCalls
    };
    messages.push(assistantMessageWithTools);
    
    // Save assistant message with tool calls to database
    if (chatId) {
        await saveCompleteMessageToDatabase(chatId, assistantMessageWithTools, currentTurn, null, turnInfo);
        log(`[CHAT-SAVE] Saved assistant message with ${toolCalls.length} tool calls`);
    }
    
    // Execute each tool call
    for (const toolCall of toolCalls) {
        log(`[TOOL-EXECUTION] Executing tool: ${toolCall.function.name}`);
        
        if (requestId) {
            addToolEvent(requestId, {
                type: 'tool_execution_start',
                data: {
                    name: toolCall.function.name, 
                    id: toolCall.id,
                    arguments: JSON.parse(toolCall.function.arguments)
                }
            });
        }
        
        try {
            const toolArgs = JSON.parse(toolCall.function.arguments);
            const toolResult = await executeMCPTool(toolCall.function.name, toolArgs);
            
            const toolMessage = {
                role: 'tool',
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,  // Add tool name for Gemini conversion
                content: JSON.stringify(toolResult)
            };
            messages.push(toolMessage);
            
            // Save tool message to database
            if (chatId) {
                await saveCompleteMessageToDatabase(chatId, toolMessage, currentTurn, null, turnInfo);
                log(`[CHAT-SAVE] Saved tool response for ${toolCall.function.name}`);
            }
            
            if (requestId) {
                addToolEvent(requestId, {
                    type: 'tool_execution_complete',
                    data: {
                        name: toolCall.function.name, 
                        id: toolCall.id,
                        status: 'success',
                        result: toolResult 
                    }
                });
            }
            
            // Add tool result to debug sequence
            if (debugData && debugData.sequence) {
                // Calculate next sequence step from existing debug data
                const sequenceCount = debugData.sequence.length;
                const httpSequenceCount = debugData.httpSequence ? debugData.httpSequence.length : 0;
                const nextStep = sequenceCount + httpSequenceCount + 1;
                
                debugData.sequence.push({
                    type: 'tool_result',
                    step: nextStep,
                    timestamp: new Date().toISOString(),
                    data: {
                        tool_name: toolCall.function.name,
                        tool_id: toolCall.id,
                        status: 'success',
                        result: toolResult
                    }
                });
            }
            
        } catch (error) {
            log(`[TOOL-EXECUTION] Error executing tool ${toolCall.function.name}:`, error);
            
            const errorMessage = {
                role: 'tool',
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,  // Add tool name for Gemini conversion
                content: JSON.stringify({ error: error.message })
            };
            messages.push(errorMessage);
            
            // Save tool error message to database
            if (chatId) {
                await saveCompleteMessageToDatabase(chatId, errorMessage, currentTurn, null, turnInfo);
                log(`[CHAT-SAVE] Saved tool error for ${toolCall.function.name}`);
            }
            
            if (requestId) {
                addToolEvent(requestId, {
                    type: 'tool_execution_complete',
                    data: {
                        name: toolCall.function.name, 
                        id: toolCall.id,
                        status: 'error',
                        error: error.message 
                    }
                });
            }
            
            // Add tool error to debug sequence
            if (debugData && debugData.sequence) {
                // Calculate next sequence step from existing debug data
                const sequenceCount = debugData.sequence.length;
                const httpSequenceCount = debugData.httpSequence ? debugData.httpSequence.length : 0;
                const nextStep = sequenceCount + httpSequenceCount + 1;
                
                debugData.sequence.push({
                    type: 'tool_result',
                    step: nextStep,
                    timestamp: new Date().toISOString(),
                    data: {
                        tool_name: toolCall.function.name,
                        tool_id: toolCall.id,
                        status: 'error',
                        error: error.message
                    }
                });
            }
        }
    }
    
    // Continue conversation with tool results
    await handleChatWithTools(res, messages, tools, chatId, debugData, responseCounter + 1, requestId, debugData, turnInfo?.parent_turn_id, turnInfo?.turn_id);
}

// Process chat request (entry point from routes)
async function processChatRequest(req, res) {
    const { db } = require('../config/database');
    try {
        // Note: req.body.message is intentionally NOT read here (M7).
        // The LLM-bound messages array is built exclusively from DB history
        // (getChatHistoryForAPI), so the user-supplied `message` field has
        // no effect on what the model sees. Keeping the field would only
        // create an avenue for a stale or attacker-controlled prefix to
        // reach the model. The frontend was updated to stop sending it.
        const { chat_id, enabled_tools, request_id, parent_turn_id, turn_id, lineage_anchor_turn_id } = req.body;


        // Build messages for API from chat history.
        //   If `lineage_anchor_turn_id` is provided, the history is filtered to
        //   the lineage of that turn (the explicit anchor for both user
        //   edit/retry and assistant retry).
        //   Otherwise, if only `parent_turn_id` is provided, the history
        //   is filtered to the lineage of the first assistant row with
        //   that parent (fallback path).
        //   The actual filter is getChatHistoryForAPI(chat_id, historyMaxTurnId)
        //   and uses `turn_id IN (ancestorIds)` — pure lineage via
        //   getAncestorTurnIds, with no turn-number sharing.
        log(`[CHAT] Request body: lineage_anchor_turn_id=${lineage_anchor_turn_id}, parent_turn_id=${parent_turn_id}`);
        let historyMaxTurnId = null;
        if (lineage_anchor_turn_id) {
            // lineage_anchor_turn_id is the explicit history anchor. For user edit/retry and
            // assistant retry this is the user turn the model should respond to.
            const anchorMsg = db.prepare(
                'SELECT turn_id FROM messages WHERE chat_id = ? AND turn_id = ? LIMIT 1'
            ).get(chat_id, lineage_anchor_turn_id);
            if (anchorMsg) {
                historyMaxTurnId = lineage_anchor_turn_id;
                log(`[CHAT] Retry detected: filtering history to selected turn lineage (maxTurnId=${historyMaxTurnId})`);
            }
        } else if (parent_turn_id) {
            // Fallback: find first assistant with this parent_turn_id
            const anchorAssistant = db.prepare(
                'SELECT parent_turn_id FROM messages WHERE chat_id = ? AND parent_turn_id = ? AND role = ? ORDER BY timestamp ASC LIMIT 1'
            ).get(chat_id, parent_turn_id, 'assistant');
            if (anchorAssistant) {
                historyMaxTurnId = anchorAssistant.parent_turn_id;
                log(`[CHAT] Retry detected (fallback): filtering history (maxTurnId=${historyMaxTurnId})`);
            }
        }

        const messages = getChatHistoryForAPI(chat_id, historyMaxTurnId);

        // Log what's in history
        log(`[CHAT-DEBUG] Current history count: ${messages.length}`);

        // Inject system prompt if this is the first message in the conversation/branch
        if (messages.length === 1) {
            const currentSettings = getCurrentSettings();
            if (currentSettings.enableSystemPrompt && currentSettings.systemPrompt && currentSettings.systemPrompt.trim()) {
                const systemMessage = {
                    role: 'system',
                    content: currentSettings.systemPrompt.trim()
                };
                
                // Prepend system prompt to messages array
                messages.unshift(systemMessage);
                log(`[SYSTEM-PROMPT] Added system prompt to first message in conversation`);
                
                // Save system prompt to database (it becomes part of chat history)
                if (chat_id) {
                    try {
                        // The system prompt is a Message in Turn 1, sharing the
                        // first user message's turn_id. This makes it editable
                        // like any other turn message (so plain "edit" can
                        // change the next AI request) and prevents it from
                        // being re-prepended on retries — once it's in the DB,
                        // getChatHistoryForAPI includes it in the filtered
                        // lineage and messages.length is no longer 1.
                        const systemPromptTurnInfo = getTurnInfo(parent_turn_id, turn_id);
                        await saveCompleteMessageToDatabase(chat_id, systemMessage, 1, null, systemPromptTurnInfo);
                        log(`[SYSTEM-PROMPT] Saved system prompt to chat history as a message in turn_id=${turn_id}`);
                    } catch (error) {
                        log(`[SYSTEM-PROMPT] Error saving system prompt to history: ${error.message}`);
                    }
                }
            }
        }
        
        // Check if we have any messages at all
        if (messages.length === 0) {
            // No chat history — the chat was never seeded with a user message.
            // The frontend should have saved a user message before sending
            // here, so this indicates either a missing POST /message call or
            // a brand-new chat. Either way, the LLM has nothing to respond to.
            throw new Error('No chat history available for this chat');
        }
        
        // Get available tools
        const tools = getAvailableToolsForChat(enabled_tools);
        
        // Call the AI API with tools and capture debug data
        const currentSettings = getCurrentSettings();
        const debugData = {
            requestStart: Date.now(),
            endpoint: 'will_be_set_by_adapter',
            settings: currentSettings,
            toolsEnabled: tools.length
        };
        
        // Use provided request ID or generate unique request ID for debug data
        const { generateRequestId, initializeToolEvents } = require('./toolEventService');
        const requestId = request_id || generateRequestId();
        
        log(`[CHAT] Using request ID: ${requestId} (provided: ${!!request_id})`);
        
        // Initialize tool events for this request
        initializeToolEvents(requestId);
        
        await handleChatWithTools(res, messages, tools, chat_id, debugData, 1, requestId, null, parent_turn_id, turn_id);
        // Response is handled in handleChatWithTools via streaming
        
    } catch (error) {
        log('[CHAT] Error:', error);
        
        // IMPROVED ERROR HANDLING: Save processing error and burn the turn
        if (chat_id) {
            const currentTurn = getCurrentTurnNumber(chat_id) + 1;
            const errorMessage = {
                role: 'assistant',
                content: `Processing error: ${error.message}`,
                debug_data: { error: error.message, stack: error.stack }
            };
            saveCompleteMessageToDatabase(chat_id, errorMessage, currentTurn, 'processing_error')
                .then(() => {
                    incrementTurnNumber(chat_id); // Burn the turn
                    log(`[ERROR-HANDLING] Saved processing error and burned turn ${currentTurn}`);
                })
                .catch(saveError => {
                    log(`[ERROR-HANDLING] Failed to save processing error: ${saveError.message}`);
                });
        }
        
        // Only send error response if headers haven't been sent yet
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            // If streaming has started, we can't send JSON, so just end the stream
            res.write(`\n[ERROR] ${error.message}`);
            res.end();
        }
    }
}

/**
 * Utility function to create file-separated content for saving
 * This helps frontends transition to the new structure
 * @param {string} userText - User's text input
 * @param {Array} files - Array of processed file objects
 * @param {Array} images - Array of image objects
 * @returns {Object} - { content, originalContent, fileMetadata }
 */
function createMessageWithSeparatedFiles(userText, files = [], images = []) {
    const hasFiles = files && files.length > 0;
    const hasImages = images && images.length > 0;
    
    let content, originalContent;
    
    if (hasFiles || hasImages) {
        // Create multimodal content
        originalContent = [];
        
        // Add text part
        if (userText || hasFiles) {
            originalContent.push({
                type: 'text',
                text: userText || ''
            });
        }
        
        // Add images
        if (hasImages) {
            originalContent.push(...images);
        }
        
        // Add files as separate part
        if (hasFiles) {
            originalContent.push({
                type: 'files',
                files: files
            });
        }
        
        // Process for AI (with concatenated content)
        const processed = processMessageForAI(originalContent);
        content = processed.aiContent;
        
    } else {
        // Simple text content
        content = userText || '';
        originalContent = userText || '';
    }
    
    const fileMetadata = {
        hasFiles,
        fileCount: files.length,
        imageCount: images.length,
        files: files
    };
    
    return {
        content,
        originalContent,
        fileMetadata
    };
}

module.exports = {
    handleChatWithTools,
    processChatRequest,
    saveCompleteMessageToDatabase,
    getChatHistoryForAPI,
    getCurrentTurnNumber,
    getTurnInfo,
    incrementTurnNumber,
    // Turn-based debug data functions (keyed on turn_id, M6)
    saveTurnDebugData,
    getTurnDebugData,
    // Branch selection persistence (per-chat, Phase 5+ follow-up).
    saveBranchSelections,
    loadBranchSelections,
    deleteBranchSelections,
    // File handling functions
    extractFilesFromContent,
    concatenateFileContent,
    createSeparatedFileContent,
    processMessageForAI,
    createMessageWithSeparatedFiles,
};
