// Message Repository - DB reads/writes for messages and chat metadata.
// Centralizes all message-related database operations.

const { log } = require('../utils/logger');
const { parseDbRowToMessage, parseContent } = require('../utils/messageConversions');

// Save message to chat
async function saveMessage(chatId, messageData, turnInfo = null, errorState = null) {
    const { db } = require('../config/database');
    const { serializeMessageForDb } = require('../utils/messageConversions');

    try {
        const serialized = serializeMessageForDb(messageData);
        const role = messageData.role;
        const toolCallId = messageData.tool_call_id || null;
        const toolName = messageData.tool_name || null;

        // Extract turn info
        const turnId = turnInfo?.turn_id || null;
        const parentTurnId = turnInfo?.parent_turn_id || null;
        const reasoning = messageData.reasoning || null;
        const turnType = messageData.turn_type || turnInfo?.turn_type || null;

        // Insert message with turn info
        const insertStmt = db.prepare(`
            INSERT INTO messages
            (chat_id, role, content, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, original_content, file_metadata, error_state, turn_type, debug_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = insertStmt.run(
            chatId,
            role,
            serialized.content,
            turnId,
            parentTurnId,
            serialized.toolCalls,
            toolCallId,
            toolName,
            reasoning,
            serialized.originalContent,
            serialized.fileMetadata,
            errorState,
            turnType,
            serialized.debugData
        );

        // Update chat's updated_at timestamp
        const updateChatStmt = db.prepare("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        updateChatStmt.run(chatId);

        const msgId = result.lastInsertRowid;
        log(
            `[SAVE] Saved ${role} message to chat ${chatId} (id=${msgId}, turn_id=${turnId}, parent_turn_id=${parentTurnId})`
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
                SELECT id, role, content, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, original_content, file_metadata, active_edit_version, edit_history, turn_type
                FROM messages
                WHERE chat_id = ? AND (error_state IS NULL OR (role = 'assistant' AND content != '')) AND turn_id IN (${turnIdPlaceholders})
                ORDER BY id ASC
            `);
            chatMessages = messagesStmt.all(chat_id, ...ancestorIds);

            // Order by LINEAGE (root -> leaf), not timestamp: a turn's parent must
            // always precede it. A steered turn is persisted BEFORE the response it
            // hangs under (the response saves at `done`), so timestamp order would
            // misplace it. `getAncestorTurnIds` returns leaf -> root, so reverse it
            // to get each turn's depth; tiebreak within a turn by row id.
            const lineageOrder = new Map();
            for (let i = ancestorIds.length - 1, ord = 0; i >= 0; i--, ord++) {
                lineageOrder.set(ancestorIds[i], ord);
            }
            chatMessages.sort((a, b) => {
                const oa = lineageOrder.has(a.turn_id) ? lineageOrder.get(a.turn_id) : Number.MAX_SAFE_INTEGER;
                const ob = lineageOrder.has(b.turn_id) ? lineageOrder.get(b.turn_id) : Number.MAX_SAFE_INTEGER;
                if (oa !== ob) return oa - ob;
                return a.id - b.id;
            });
        } else {
            messagesStmt = db.prepare(`
                SELECT id, role, content, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, original_content, file_metadata, active_edit_version, edit_history, turn_type
                FROM messages
                WHERE chat_id = ? AND (error_state IS NULL OR (role = 'assistant' AND content != ''))
                ORDER BY timestamp ASC
            `);
            chatMessages = messagesStmt.all(chat_id);
        }

        log(`[CHAT-HISTORY] Retrieved ${chatMessages.length} successful messages (errors filtered out)`);

        // Defensive: strip any tool calls with invalid JSON arguments
        // (can happen from cancellation mid-stream or other errors)
        for (const row of chatMessages) {
            if (row.tool_calls && typeof row.tool_calls === 'string') {
                try {
                    const parsed = JSON.parse(row.tool_calls);
                    if (Array.isArray(parsed)) {
                        const valid = parsed.filter(tc => {
                            if (!tc.function || typeof tc.function.arguments !== 'string') return false;
                            try { JSON.parse(tc.function.arguments); return true; }
                            catch (_) { return false; }
                        });
                        if (valid.length !== parsed.length) {
                            log(`[CHAT-HISTORY] Stripped ${parsed.length - valid.length} tool call(s) with invalid arguments from history`);
                        }
                        row.tool_calls = valid.length > 0 ? JSON.stringify(valid) : null;
                    }
                } catch (_) {
                    row.tool_calls = null;
                }
            }
        }

        const aiMessages = chatMessages.map((row) => {
            // The database row always contains the currently active version.
            // We don't need to look in edit_history - edit_history stores
            // the PREVIOUS versions that have been archived.
            // active_edit_version just tracks which version we're on.

            // Process saved messages to ensure AI gets correct content
            let finalContent = parseContent(row.content);

            // If content is an array, always run it through processMessageForAI so that
            // {type:"files"} parts get folded into text and images stay as images.
            if (Array.isArray(finalContent)) {
                try {
                    finalContent = processMessageForAI(finalContent).aiContent;
                } catch (e) {
                    log(`[CHAT-HISTORY] Error processing multimodal content: ${e.message}`);
                }
            }

            // Use the base parser, then override content with the AI-processed version
            const message = parseDbRowToMessage(row, {
                includeFileFields: false,
                includeErrorState: false,
            });

            message.content = finalContent;

            return message;
        });

        log(`[CHAT-HISTORY] Retrieved ${aiMessages.length} messages from chat ${chat_id}`);
        return aiMessages;
    } catch (err) {
        log("[CHAT-HISTORY] Error getting chat history:", err);
        throw new Error(`Failed to load chat history: ${err.message}`);
    }
}

// Attach debug data to an already-saved message, identified by turn. Used for the
// REQUEST message: it's persisted before the provider call, so its request wire-debug
// (the sequence) is written on afterward. Targets the message of the given turn_type
// in that turn (the request turn's user message).
function setMessageDebugByTurn(chatId, turnId, turnType, debugData) {
    const { db } = require('../config/database');
    try {
        if (!turnId) return null;
        const json = debugData ? JSON.stringify(debugData) : null;
        const stmt = db.prepare(`
            UPDATE messages SET debug_data = ?
            WHERE chat_id = ? AND turn_id = ? AND (? IS NULL OR turn_type = ?)
        `);
        const result = stmt.run(json, chatId, turnId, turnType || null, turnType || null);
        log(`[MSG-DEBUG] Set debug on ${result.changes} message(s) for turn_id=${turnId}`);
        return result;
    } catch (err) {
        log("[MSG-DEBUG] Error setting message debug:", err);
        return null;
    }
}

// Attach debug data to the most-recently-saved message of a turn (highest id). Used
// by error paths, which save an assistant error message and then need to hang the
// error wire-debug on exactly that message.
function setLatestMessageDebug(chatId, turnId, debugData) {
    const { db } = require('../config/database');
    try {
        if (!turnId) return null;
        const json = debugData ? JSON.stringify(debugData) : null;
        const stmt = db.prepare(`
            UPDATE messages SET debug_data = ?
            WHERE id = (SELECT MAX(id) FROM messages WHERE chat_id = ? AND turn_id = ?)
        `);
        return stmt.run(json, chatId, turnId);
    } catch (err) {
        log("[MSG-DEBUG] Error setting latest message debug:", err);
        return null;
    }
}

module.exports = {
    saveMessage,
    getChatHistoryForAPI,
    setMessageDebugByTurn,
    setLatestMessageDebug
};
