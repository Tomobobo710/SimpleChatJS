// Message Repository - DB reads/writes for messages and chat metadata.
// Centralizes all message-related database operations.

const { log } = require('../utils/logger');
const { parseDbRowToMessage, parseContent } = require('../utils/messageConversions');

// Save message to chat
async function saveMessage(chatId, messageData, turnNumber = null, errorState = null, turnInfo = null) {
    const { db } = require('../config/database');
    const { serializeMessageForDb } = require('../utils/messageConversions');
    const { getCurrentTurnNumber } = require('./turnService');

    try {
        const serialized = serializeMessageForDb(messageData);
        const role = messageData.role;
        const toolCallId = messageData.tool_call_id || null;
        const toolName = messageData.tool_name || null;

        // Use turn number or get next
        let finalTurnNumber = turnNumber;
        if (finalTurnNumber === null) {
            finalTurnNumber = getCurrentTurnNumber(chatId);
        }

        // Extract turn info
        const turnId = turnInfo?.turn_id || null;
        const parentTurnId = turnInfo?.parent_turn_id || null;
        const reasoning = messageData.reasoning || null;

        // Insert message with turn info
        const insertStmt = db.prepare(`
            INSERT INTO messages 
            (chat_id, role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, original_content, file_metadata, error_state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = insertStmt.run(
            chatId,
            role,
            serialized.content,
            finalTurnNumber,
            turnId,
            parentTurnId,
            serialized.toolCalls,
            toolCallId,
            toolName,
            reasoning,
            serialized.originalContent,
            serialized.fileMetadata,
            errorState
        );

        // Update chat's updated_at timestamp
        const updateChatStmt = db.prepare("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        updateChatStmt.run(chatId);

        const msgId = result.lastInsertRowid;
        log(
            `[SAVE] Saved ${role} message to chat ${chatId} (id=${msgId}, turn ${finalTurnNumber}, turn_id=${turnId}, parent_turn_id=${parentTurnId})`
        );
        return msgId;
    } catch (error) {
        log("[SAVE] Error saving message:", error);
        throw error;
    }
}

// Get chat history for API (filtered for AI consumption)
function getChatHistoryForAPI(chat_id, maxTurnId = null) {
    if (!chat_id) {
        throw new Error("getChatHistoryForAPI: chat_id is required");
    }

    const { db } = require('../config/database');
    const { getAncestorTurnIds } = require('./turnService');
    const { processMessageForAI } = require('./messageContentService');
    const { parseContent } = require('../utils/messageConversions');

    try {
        log(`[CHAT-HISTORY] Getting complete history for chat ${chat_id}`);

        let messagesStmt;
        let chatMessages;
        if (maxTurnId) {
            // Lineage filtering: include only exact turn_ids in the selected ancestry path.
            const ancestorIds = getAncestorTurnIds(chat_id, maxTurnId);
            log(`[CHAT-HISTORY] Lineage filter: ancestor turn_ids = ${ancestorIds.join(", ")}`);
            const turnIdPlaceholders = ancestorIds.map(() => "?").join(",");

            messagesStmt = db.prepare(`
                SELECT id, role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, original_content, file_metadata, active_edit_version, edit_history
                FROM messages
                WHERE chat_id = ? AND (error_state IS NULL OR (role = 'assistant' AND content != '')) AND turn_id IN (${turnIdPlaceholders})
                ORDER BY timestamp ASC
            `);
            chatMessages = messagesStmt.all(chat_id, ...ancestorIds);
        } else {
            messagesStmt = db.prepare(`
                SELECT id, role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, original_content, file_metadata, active_edit_version, edit_history
                FROM messages
                WHERE chat_id = ? AND (error_state IS NULL OR (role = 'assistant' AND content != ''))
                ORDER BY timestamp ASC
            `);
            chatMessages = messagesStmt.all(chat_id);
        }

        log(`[CHAT-HISTORY] Retrieved ${chatMessages.length} successful messages (errors filtered out)`);

        const aiMessages = chatMessages.map((row) => {
            // The database row always contains the currently active version.
            // We don't need to look in edit_history - edit_history stores
            // the PREVIOUS versions that have been archived.
            // active_edit_version just tracks which version we're on.

            // Process saved messages to ensure AI gets correct content
            let finalContent = row.content;

            // If this message has original content and file metadata, we need to process it for AI
            if (row.original_content && row.file_metadata) {
                try {
                    const originalContent =
                        typeof row.original_content === "string" && row.original_content.startsWith("[")
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

            // Use the base parser, then override content with the AI-processed version
            const message = parseDbRowToMessage(row, {
                includeFileFields: false,
                includeErrorState: false,
            });

            // Override content with AI-processed content
            message.content = parseContent(finalContent);

            return message;
        });

        log(`[CHAT-HISTORY] Retrieved ${aiMessages.length} messages from chat ${chat_id}`);
        return aiMessages;
    } catch (err) {
        log("[CHAT-HISTORY] Error getting chat history:", err);
        throw new Error(`Failed to load chat history: ${err.message}`);
    }
}

// Save debug data to turn_debug table (keyed by chat_id + turn_id)
async function saveTurnDebugData(chatId, turnId, debugData) {
    const { db } = require('../config/database');

    try {
        if (!turnId) {
            log(`[TURN-DEBUG] Skipping debug save: no turnId`);
            return null;
        }

        const debugDataJson = JSON.stringify(debugData);

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO turn_debug (chat_id, turn_id, debug_data)
            VALUES (?, ?, ?)
        `);
        const result = stmt.run(chatId, turnId, debugDataJson);

        log(`[TURN-DEBUG] Saved debug data for turn_id=${turnId} in chat ${chatId}`);
        return result;
    } catch (err) {
        log("[TURN-DEBUG] Error saving debug data:", err);
        throw err;
    }
}

// Get turn debug data (request and/or response)
function getTurnDebugData(chatId, turnId) {
    const { db } = require('../config/database');

    try {
        const stmt = db.prepare(`
            SELECT debug_data
            FROM turn_debug
            WHERE chat_id = ? AND turn_id = ?
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
        log("[TURN-DEBUG] Error getting turn debug data:", err);
        return null;
    }
}

module.exports = {
    saveMessage,
    getChatHistoryForAPI,
    saveTurnDebugData,
    getTurnDebugData
};
