// Chat routes - Handle chat operations and messaging
const express = require("express");
const { db } = require("../config/database");
const { processChatRequest, cancelInFlightRequest, saveTurnDebugData, getTurnDebugData } = require("../services/chatService");
const { log } = require("../utils/logger");

const router = express.Router();

// Utility function to extract preview text from multimodal content
function extractPreviewText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        // Extract text from multimodal array
        const textPart = content.find((part) => part.type === "text");
        const filesPart = content.find((part) => part.type === "files");
        const imageParts = content.filter((part) => part.type === "image");

        // Priority: text content first
        if (textPart && textPart.text) {
            // If there's text plus other content, show text with indicators
            const extras = [];
            if (filesPart && filesPart.files && filesPart.files.length > 0) {
                if (filesPart.files.length === 1) {
                    const file = filesPart.files[0];
                    const fileName = file.fileName || file.name || file.originalName || "Unknown file";
                    extras.push(`[File] ${fileName}`);
                } else {
                    extras.push(`[${filesPart.files.length} files]`);
                }
            }
            if (imageParts.length > 0) {
                if (imageParts.length === 1) {
                    extras.push("[Image]");
                } else {
                    extras.push(`[${imageParts.length} images]`);
                }
            }

            if (extras.length > 0) {
                return `${textPart.text} + ${extras.join(" + ")}`;
            }
            return textPart.text;
        }
        // No text content, show files/images only
        else {
            const parts = [];
            if (filesPart && filesPart.files && filesPart.files.length > 0) {
                if (filesPart.files.length === 1) {
                    const file = filesPart.files[0];
                    const fileName = file.fileName || file.name || file.originalName || "Unknown file";
                    parts.push(`[File] ${fileName}`);
                } else {
                    parts.push(`[${filesPart.files.length} files]`);
                }
            }
            if (imageParts.length > 0) {
                if (imageParts.length === 1) {
                    parts.push("[Image]");
                } else {
                    parts.push(`[${imageParts.length} images]`);
                }
            }
            if (parts.length > 0) {
                return parts.join(" + ");
            } else {
                return "[Multimodal content]";
            }
        }
    }
    // Handle any other data types gracefully
    if (typeof content === "object" && content !== null) {
        return "[Complex content]";
    }
    return String(content || "");
}

// Get all chats
router.get("/chats", (req, res) => {
    const { project_id, freeform } = req.query;

    let query = `
        SELECT 
            c.id,
            c.title,
            c.created_at,
            c.updated_at,
            COALESCE(bm.content, '') as last_message,
            c.project_id
        FROM chats c
        LEFT JOIN (
            SELECT 
                chat_id,
                content,
                ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp DESC) as rn
            FROM messages
            WHERE role = 'user'
        ) bm ON c.id = bm.chat_id AND bm.rn = 1
    `;

    if (project_id) {
        query += " WHERE c.project_id = ?";
    } else if (freeform === "true") {
        query += " WHERE c.project_id IS NULL";
    }
    query += " ORDER BY c.updated_at DESC";

    try {
        let rows;
        if (project_id) {
            rows = db.prepare(query).all(project_id);
        } else {
            rows = db.prepare(query).all();
        }
        log(`[CHATS] Found ${rows ? rows.length : 0} chats:`, rows);
        // Transform the data to match frontend expectations
        const chats = (rows || []).map((row) => {
            let processedLastMessage = row.last_message || "";

            // Process multimodal content for preview
            if (
                processedLastMessage &&
                (processedLastMessage.startsWith("[") || processedLastMessage.startsWith("{"))
            ) {
                try {
                    const parsed = JSON.parse(processedLastMessage);
                    processedLastMessage = extractPreviewText(parsed);
                } catch (e) {
                    // If parsing fails, keep original
                    processedLastMessage = row.last_message || "";
                }
            }

            // Convert SQLite timestamp to ISO string for consistent parsing
            const timestamp = row.updated_at || row.created_at;
            const isoTimestamp = timestamp ? new Date(timestamp + "Z").toISOString() : new Date().toISOString();

            return {
                chat_id: row.id,
                title: row.title,
                last_message: processedLastMessage,
                last_updated: isoTimestamp
            };
        });
        res.json(chats);
    } catch (err) {
        log("[CHATS] List error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Create new chat
router.post("/chats", async (req, res) => {
    const { chat_id, title, project_id } = req.body;

    if (!chat_id) {
        return res.status(400).json({ error: "chat_id is required" });
    }

    try {
        // Check if chat already exists
        const existing = db.prepare("SELECT id FROM chats WHERE id = ?").get(chat_id);
        if (existing) {
            // Update existing chat
            const stmt = db.prepare(
                "UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP, project_id = ? WHERE id = ?"
            );
            stmt.run(title || "New Chat", project_id || null, chat_id);
        } else {
            // Create new chat
            const stmt = db.prepare(
                "INSERT INTO chats (id, title, created_at, updated_at, project_id) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)"
            );
            stmt.run(chat_id, title || "New Chat", project_id || null);
        }

        res.json({ success: true, chat_id });
    } catch (err) {
        log("[CHAT] Create error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get chat history including errored messages for UI display
router.get("/chat/:id/history", (req, res) => {
    const chatId = req.params.id;
    const includeErrors = req.query.includeErrors !== 'false'; // default to true

    try {
        log(`[HISTORY] Getting history for chat ${chatId} (includeErrors: ${includeErrors})`);

        // Build query with optional error filtering
        let query = `
            SELECT id, original_message_id, role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, edit_count, edited_at, timestamp, original_content, file_metadata, error_state
            FROM messages
            WHERE chat_id = ?
        `;
        
        if (!includeErrors) {
            query += ` AND error_state IS NULL`;
        }
        
        query += ` ORDER BY timestamp ASC`;

        const messagesStmt = db.prepare(query);
        const chatMessages = messagesStmt.all(chatId);

        const { parseDbRowToMessage } = require("../utils/messageConversions");

        const messages = chatMessages.map((row) =>
            parseDbRowToMessage(row, {
                includeFileFields: true,
                includeErrorState: true,
            })
        );

        log(`[HISTORY] Retrieved ${messages.length} messages from chat ${chatId}`);
        res.json({ messages });
    } catch (err) {
        log("[HISTORY] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Delete chat
router.delete("/chat/:id", (req, res) => {
    const chatId = req.params.id;

    try {
        // Get project_id before deleting
        const chatStmt = db.prepare("SELECT project_id FROM chats WHERE id = ?");
        const chat = chatStmt.get(chatId);

        const { deleteBranchSelections } = require("../services/chatService");

        const tx = db.transaction(() => {
            db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
            deleteBranchSelections(chatId);
            db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
        });
        tx();

        log(`[CHAT] Deleted chat: ${chatId} (project: ${chat?.project_id || "freeform"})`);
        res.json({ success: true, project_id: chat?.project_id || null });
    } catch (err) {
        log("[CHAT] Error deleting chat:", err);
        res.status(500).json({ error: err.message });
    }
});

// Save message using unified approach
router.post("/message", async (req, res) => {
    try {
    const {
        chat_id,
        role,
        content,
        turn_number,
        tool_calls,
        tool_call_id,
        tool_name,
        original_content,
        file_metadata,
        turn_id,
        parent_turn_id,
        error_state
    } = req.body;

        if (!chat_id || !role || content === null || content === undefined) {
            return res.status(400).json({ error: "chat_id, role, and content are required" });
        }

        // Create complete message structure with all possible fields
        const completeMessage = {
            role: role,
            content: content
        };

        // Add tool-specific fields if present
        if (tool_calls) completeMessage.tool_calls = tool_calls;
        if (tool_call_id) completeMessage.tool_call_id = tool_call_id;
        if (tool_name) completeMessage.tool_name = tool_name;

        // Add new file handling fields if present
        if (original_content !== undefined) completeMessage.originalContent = original_content;
        if (file_metadata !== undefined) completeMessage.fileMetadata = file_metadata;

        // Use the unified save function
        const { saveCompleteMessageToDatabase, incrementTurnNumber, getTurnInfo, buildSystemMessageIfEnabled } = require("../services/chatService");
        const turnInfo = getTurnInfo(parent_turn_id, turn_id);

        if (role === "user") {
            const existingSystemCount = db.prepare(
                "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ? AND role = 'system' AND error_state IS NULL"
            ).get(chat_id).count;

            if (existingSystemCount === 0) {
                const systemMessage = buildSystemMessageIfEnabled();
                if (systemMessage) {
                    await saveCompleteMessageToDatabase(chat_id, systemMessage, 1, null, turnInfo);
                }
            }
        }

        // Use turn number provided by frontend
        await saveCompleteMessageToDatabase(chat_id, completeMessage, turn_number, error_state || null, turnInfo);

        // Increment turn number when user sends a message (starts new conversation turn)
        if (role === "user") {
            incrementTurnNumber(chat_id);
        }

        res.json({ success: true, turn_id: turnInfo.turn_id, parent_turn_id: turnInfo.parent_turn_id });
    } catch (error) {
        log("[UPDATE-DEBUG] Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Turn data endpoints — keyed on turn_id for sibling safety.
// Save turn data
router.post("/chat/:id/turns/:turnId", async (req, res) => {
    try {
        const { id: chatId, turnId } = req.params;
        const { data } = req.body;

        if (!turnId) {
            return res.status(400).json({ error: "turnId is required" });
        }
        if (!data) {
            return res.status(400).json({ error: "data is required" });
        }

        await saveTurnDebugData(chatId, turnId, data);
        res.json({ success: true });
    } catch (error) {
        log("[TURN-DATA-SAVE] Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Get turn data
router.get("/chat/:id/turns/:turnId", (req, res) => {
    try {
        const { id: chatId, turnId } = req.params;

        if (!turnId) {
            return res.status(400).json({ error: "turnId is required" });
        }

        const turnData = getTurnDebugData(chatId, turnId);

        if (turnData) {
            res.json(turnData);
        } else {
            res.status(404).json({ error: "Turn data not found" });
        }
    } catch (error) {
        log("[TURN-DATA-GET] Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Update chat title
router.patch("/chat/:id/title", (req, res) => {
    const chatId = req.params.id;
    const { title } = req.body;

    if (!title) {
        return res.status(400).json({ error: "title is required" });
    }

    try {
        const stmt = db.prepare("UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        const result = stmt.run(title, chatId);

        if (result.changes === 0) {
            return res.status(404).json({ error: "Chat not found" });
        }

        log(`[CHAT] Updated title for chat ${chatId} to "${title}"`);
        res.json({ success: true, chat_id: chatId, title: title });
    } catch (err) {
        log("[CHAT] Error updating title:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get clean chat history in API format (for user debug panels)
router.get("/chat/:id/api-history", (req, res) => {
    const chatId = req.params.id;

    try {
        const { getChatHistoryForAPI } = require("../services/chatService");
        const apiHistory = getChatHistoryForAPI(chatId);
        res.json(apiHistory);
    } catch (err) {
        log("[API-HISTORY] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get current turn number for a chat
router.get("/chat/:id/current-turn", (req, res) => {
    const { id: chatId } = req.params;

    try {
        const { getCurrentTurnNumber } = require("../services/chatService");
        const turnNumber = getCurrentTurnNumber(chatId);
        res.json({ turn_number: turnNumber });
    } catch (err) {
        log("[CURRENT-TURN] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Load persisted branch navigation selections for a chat. Returns a
// { parentKey: selectedTurnId } map, or {} if none.
router.get("/chat/:id/branch-selections", (req, res) => {
    const { id: chatId } = req.params;
    try {
        const { loadBranchSelections } = require("../services/chatService");
        const selections = loadBranchSelections(chatId);
        res.json(selections);
    } catch (err) {
        log("[BRANCH-SEL] GET error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Save branch navigation selections. Replaces the entire set for this
// chat. Throws on invalid input.
router.post("/chat/:id/branch-selections", (req, res) => {
    const { id: chatId } = req.params;
    try {
        const body = req.body || {};
        const selections = body.selections;
        const { saveBranchSelections } = require("../services/chatService");
        const result = saveBranchSelections(chatId, selections);
        res.json({ success: true, ...result });
    } catch (err) {
        log("[BRANCH-SEL] POST error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get messages for a specific turn
router.get("/chat/:id/turn/:turnNumber", (req, res) => {
    try {
        const { id: chatId, turnNumber } = req.params;
        const turnNum = parseInt(turnNumber, 10);

        if (isNaN(turnNum)) {
            return res.status(400).json({ error: "Invalid turn number" });
        }

        // Get all messages for this turn from the chat
        log(`[TURN-MESSAGES] Getting messages for turn ${turnNum} in chat ${chatId}`);
        const stmt = db.prepare(`
            SELECT id, role, content, timestamp, turn_number, turn_id, parent_turn_id,
                   edit_count, edited_at, reasoning, original_content
            FROM messages 
            WHERE chat_id = ? AND turn_number = ? 
            ORDER BY timestamp ASC
        `);
        const messages = stmt.all(chatId, turnNum);

        log(`[TURN-MESSAGES] Found ${messages.length} messages for turn ${turnNum} in chat ${chatId}`);

        // Parse multimodal content
        const processedMessages = messages.map((msg) => {
            let processedContent = msg.content;

            // Parse JSON stringified multimodal content
            if (typeof msg.content === "string" && msg.content.startsWith("[")) {
                try {
                    processedContent = JSON.parse(msg.content);
                } catch (e) {
                    // If parsing fails, keep as string
                    processedContent = msg.content;
                }
            }

            return {
                ...msg,
                content: processedContent,
                edit_count: msg.edit_count || 0
            };
        });

        res.json({ messages: processedMessages });
    } catch (error) {
        log("[TURN-MESSAGES] Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Main chat endpoint that frontend expects
router.post("/chat", processChatRequest);

// Cancel an in-flight chat request. Marks it user_stopped, destroys the
// upstream AI provider request, and persists the partial content as an
// assistant message with error_state "user_stopped".
router.post("/chat/cancel/:requestId", (req, res) => {
    const { requestId } = req.params;
    try {
        const result = cancelInFlightRequest(requestId);
        res.json({ success: true, ...result });
    } catch (error) {
        log(`[CANCEL] Error cancelling requestId=${requestId}: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Edit message content
router.patch("/message/:id", async (req, res) => {
    try {
        const messageId = parseInt(req.params.id, 10);
        const { content, original_content, file_metadata, reasoning } = req.body;

        if (isNaN(messageId)) {
            return res.status(400).json({ error: "Invalid message ID" });
        }

        // Find the message
        const getMessageStmt = db.prepare(`
            SELECT content, edit_count, edited_at 
            FROM messages 
            WHERE id = ?
        `);
        const currentMessage = getMessageStmt.get(messageId);

        if (!currentMessage) {
            return res.status(404).json({ error: "Message not found" });
        }

        const newEditCount = (currentMessage.edit_count || 0) + 1;

        log(`[EDIT] Updating message ${messageId}`);
        const updateStmt = db.prepare(`
            UPDATE messages 
            SET content = ?, 
                original_content = ?,
                file_metadata = ?,
                reasoning = ?,
                edit_count = ?, 
                edited_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `);
        const { serializeMessageForDb } = require("../utils/messageConversions");

        const serialized = serializeMessageForDb({ content, original_content, file_metadata });
        const result = updateStmt.run(
            serialized.content,
            serialized.originalContent,
            serialized.fileMetadata,
            reasoning || null,
            newEditCount,
            messageId
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: "Message not found" });
        }

        log(`[EDIT] Updated message ${messageId}, edit count: ${newEditCount}`);

        res.json({
            success: true,
            message_id: messageId,
            edit_count: newEditCount,
            edited_at: new Date().toISOString()
        });
    } catch (error) {
        log("[EDIT] Error updating message:", error);
        res.status(500).json({ error: error.message });
    }
});

// Get message by ID for editing
router.get("/message/:id", (req, res) => {
    try {
        const messageId = parseInt(req.params.id, 10);

        if (isNaN(messageId)) {
            return res.status(400).json({ error: "Invalid message ID" });
        }

        const stmt = db.prepare(`
            SELECT id, chat_id, role, content, original_content, 
                   edit_count, edited_at, timestamp, turn_number 
            FROM messages WHERE id = ?
        `);
        const message = stmt.get(messageId);

        if (!message) {
            return res.status(404).json({ error: "Message not found" });
        }

        res.json(message);
    } catch (error) {
        log("[GET-MESSAGE] Error:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
