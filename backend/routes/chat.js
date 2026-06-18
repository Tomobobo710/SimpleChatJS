// Chat routes - Handle chat operations and messaging
const express = require("express");
const { db } = require("../config/database");
const { processRequest, cancelInFlightRequest } = require("../services/chatStreamService");
const { saveMessage, saveTurnDebugData, getTurnDebugData } = require("../services/messageRepository");
const { getTurnInfo, deleteBranchSelections, loadBranchSelections, saveBranchSelections } = require("../services/turnService");
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
            SELECT id, original_message_id, role, content, turn_number, turn_id, parent_turn_id, tool_calls, tool_call_id, tool_name, reasoning, edit_count, edited_at, timestamp, original_content, file_metadata, error_state, active_edit_version, edit_history
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

        const turnInfo = getTurnInfo(parent_turn_id, turn_id);

        // turn_number is vestigial — always 0. Lineage (turn_id + parent_turn_id) is the source of truth.
        await saveMessage(chat_id, completeMessage, turn_number, error_state || null, turnInfo);

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

// Load persisted branch navigation selections for a chat. Returns a
// { parentKey: selectedTurnId } map, or {} if none.
router.get("/chat/:id/branch-selections", (req, res) => {
    const { id: chatId } = req.params;
    try {
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
        const result = saveBranchSelections(chatId, selections);
        res.json({ success: true, ...result });
    } catch (err) {
        log("[BRANCH-SEL] POST error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get messages for a specific turn
router.get("/chat/:id/turn/:turnId", (req, res) => {
    try {
        const { id: chatId, turnId } = req.params;

        if (!turnId) {
            return res.status(400).json({ error: "turnId is required" });
        }

        // Get all messages for this turn from the chat
        log(`[TURN-MESSAGES] Getting messages for turn_id=${turnId} in chat ${chatId}`);
        const stmt = db.prepare(`
            SELECT id, role, content, timestamp, turn_number, turn_id, parent_turn_id,
                   edit_count, edited_at, reasoning, original_content, tool_calls, tool_call_id, edit_history, active_edit_version
            FROM messages 
            WHERE chat_id = ? AND turn_id = ? 
            ORDER BY timestamp ASC
        `);
        const messages = stmt.all(chatId, turnId);

        log(`[TURN-MESSAGES] Found ${messages.length} messages for turn_id=${turnId} in chat ${chatId}`);

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

            // Parse tool_calls if present
            let toolCalls = null;
            if (msg.tool_calls) {
                try {
                    toolCalls = JSON.parse(msg.tool_calls);
                } catch (e) {
                    toolCalls = null;
                }
            }

            // Parse edit_history if present
            let editHistory = null;
            if (msg.edit_history) {
                try {
                    editHistory = JSON.parse(msg.edit_history);
                } catch (e) {
                    editHistory = null;
                }
            }

            return {
                ...msg,
                content: processedContent,
                tool_calls: toolCalls,
                edit_history: editHistory,
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
router.post("/chat", processRequest);

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

// Edit message content — accepts all_message_edits array with edits for every
// message in the turn. The :id in the URL is any message in the turn, used
// only to look up the turn_id. All edit data comes from the body.
router.patch("/message/:id", async (req, res) => {
    try {
        const messageId = parseInt(req.params.id, 10);
        const { all_message_edits } = req.body;

        if (isNaN(messageId)) {
            return res.status(400).json({ error: "Invalid message ID" });
        }
        if (!all_message_edits || !Array.isArray(all_message_edits) || all_message_edits.length === 0) {
            return res.status(400).json({ error: "all_message_edits array is required" });
        }

        // Use :id just to find the turn
        const getMessageStmt = db.prepare(`
            SELECT chat_id, turn_id, content, edit_count, edited_at, reasoning, tool_calls, edit_history, active_edit_version
            FROM messages 
            WHERE id = ?
        `);
        const anyTurnMessage = getMessageStmt.get(messageId);

        if (!anyTurnMessage) {
            return res.status(404).json({ error: "Message not found" });
        }

        // Load all messages in this turn
        const getTurnMessagesStmt = db.prepare(`
            SELECT id, content, reasoning, tool_calls, edit_count, edit_history, active_edit_version
            FROM messages
            WHERE turn_id = ?
        `);
        const turnMessages = getTurnMessagesStmt.all(anyTurnMessage.turn_id);

        // Check for actual changes across all edits
        let hasChanges = false;
        for (const edit of all_message_edits) {
            const dbMsg = turnMessages.find(m => m.id === edit.id);
            if (!dbMsg) continue;
            if (edit.content !== undefined && edit.content !== dbMsg.content) { hasChanges = true; break; }
            if (edit.reasoning !== undefined && edit.reasoning !== dbMsg.reasoning) { hasChanges = true; break; }
            if (edit.tool_calls !== undefined) {
                let normalizedDb = null;
                if (dbMsg.tool_calls) {
                    try { normalizedDb = JSON.parse(dbMsg.tool_calls); } catch { normalizedDb = dbMsg.tool_calls; }
                }
                if (JSON.stringify(edit.tool_calls) !== JSON.stringify(normalizedDb)) { hasChanges = true; break; }
            }
        }

        if (!hasChanges) {
            log(`[EDIT] No changes detected for message ${messageId}, skipping save`);
            return res.json({
                success: true,
                message_id: messageId,
                edit_count: anyTurnMessage.edit_count,
                edited_at: anyTurnMessage.edited_at,
                skipped: true
            });
        }

        // Generate fresh tool_call_ids for this version
        let newToolCallsData = null;
        const toolIdMapping = {};
        const toolCallEdit = all_message_edits.find(e => e.tool_calls && Array.isArray(e.tool_calls));

        if (toolCallEdit) {
            newToolCallsData = toolCallEdit.tool_calls.map(tc => {
                const oldId = tc.id;
                const newId = require('crypto').randomBytes(16).toString('base64').replace(/[+/]/g, '').substring(0, 16);
                if (oldId) toolIdMapping[oldId] = newId;
                return { ...tc, id: newId };
            });
        }

        // Update tool_call_id references in tool messages
        if (Object.keys(toolIdMapping).length > 0) {
            const updateToolStmt = db.prepare(`
                UPDATE messages
                SET tool_call_id = ?
                WHERE turn_id = ? AND role = 'tool' AND tool_call_id = ?
            `);
            for (const [oldId, newId] of Object.entries(toolIdMapping)) {
                updateToolStmt.run(newId, anyTurnMessage.turn_id, oldId);
            }
        }

        // Synchronized versioning — all messages get the same bump
        const newEditCount = (anyTurnMessage.edit_count || 0) + 1;
        const newActiveEditVersion = newEditCount;

        log(`[EDIT] Updating ${turnMessages.length} messages in turn, creating version ${newEditCount}`);

        const updateStmt = db.prepare(`
            UPDATE messages 
            SET content = ?, 
                original_content = ?,
                file_metadata = ?,
                reasoning = ?,
                tool_calls = ?,
                edit_count = ?, 
                active_edit_version = ?,
                edit_history = ?,
                edited_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `);

        const { serializeMessageForDb } = require("../utils/messageConversions");

        for (const msg of turnMessages) {
            const edit = all_message_edits.find(e => e.id === msg.id);

            // Archive current state
            let editHistory = [];
            try { editHistory = JSON.parse(msg.edit_history || '[]'); } catch { editHistory = []; }

            let toolCallsForHistory = null;
            if (msg.tool_calls) {
                try { toolCallsForHistory = JSON.parse(msg.tool_calls); } catch { toolCallsForHistory = msg.tool_calls; }
            }

            editHistory.push({
                version: msg.edit_count,
                content: msg.content,
                reasoning: msg.reasoning,
                tool_calls: toolCallsForHistory,
                timestamp: new Date().toISOString()
            });

            let finalContent, finalOriginalContent, finalFileMetadata, finalReasoning, finalToolCalls;

            if (edit) {
                const serialized = serializeMessageForDb({
                    content: edit.content,
                    original_content: edit.original_content,
                    file_metadata: edit.file_metadata
                });
                finalContent = serialized.content;
                finalOriginalContent = serialized.originalContent;
                finalFileMetadata = serialized.fileMetadata;
                finalReasoning = edit.reasoning !== undefined ? edit.reasoning : null;

                if (edit.tool_calls !== undefined) {
                    const isToolSource = toolCallEdit && msg.id === toolCallEdit.id;
                    finalToolCalls = JSON.stringify(isToolSource ? newToolCallsData : edit.tool_calls);
                } else {
                    let normalized = null;
                    if (msg.tool_calls) { try { normalized = JSON.parse(msg.tool_calls); } catch { normalized = msg.tool_calls; } }
                    finalToolCalls = normalized ? JSON.stringify(normalized) : null;
                }
            } else {
                finalContent = msg.content;
                finalOriginalContent = null;
                finalFileMetadata = null;
                finalReasoning = msg.reasoning;
                let normalized = null;
                if (msg.tool_calls) { try { normalized = JSON.parse(msg.tool_calls); } catch { normalized = msg.tool_calls; } }
                finalToolCalls = normalized ? JSON.stringify(normalized) : null;
            }

            updateStmt.run(
                finalContent,
                finalOriginalContent,
                finalFileMetadata,
                finalReasoning,
                finalToolCalls,
                newEditCount,
                newActiveEditVersion,
                JSON.stringify(editHistory),
                msg.id
            );
        }

        log(`[EDIT] Updated ${turnMessages.length} messages in turn with version ${newEditCount}`);

        res.json({
            success: true,
            message_id: messageId,
            edit_count: newEditCount,
            active_edit_version: newActiveEditVersion,
            edited_at: new Date().toISOString(),
            messages_updated: turnMessages.length
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
                   edit_count, edited_at, timestamp, turn_number, edit_history, active_edit_version
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

// Switch to a different edit version (can be called with turnId as identifier)
router.post("/message/:id/switch-version", async (req, res) => {
    try {
        const identifier = req.params.id;
        const { targetVersion, isTurnId } = req.body;

        // If isTurnId is true, identifier is a turnId; otherwise it's a messageId
        let messageIds = [];
        
        if (isTurnId) {
            // Get all messages for this turn
            const turnId = identifier;
            const getMessagesStmt = db.prepare(`
                SELECT id FROM messages WHERE turn_id = ?
            `);
            const messages = getMessagesStmt.all(turnId);
            messageIds = messages.map(m => m.id);
            
            if (messageIds.length === 0) {
                return res.status(404).json({ error: "No messages found for turn" });
            }
        } else {
            // Single message ID
            const messageId = parseInt(identifier, 10);
            if (isNaN(messageId)) {
                return res.status(400).json({ error: "Invalid message ID" });
            }
            messageIds = [messageId];
        }

        if (targetVersion === undefined || targetVersion === null) {
            return res.status(400).json({ error: "targetVersion is required" });
        }

        const targetVer = parseInt(targetVersion, 10);
        if (isNaN(targetVer) || targetVer < 0) {
            return res.status(400).json({ error: "targetVersion must be a non-negative integer" });
        }

        // Switch all messages to the target version
        const results = [];
        
        for (const messageId of messageIds) {
            // Get current message
            const getMessageStmt = db.prepare(`
                SELECT content, reasoning, tool_calls, edit_count, active_edit_version, edit_history
                FROM messages 
                WHERE id = ?
            `);
            const currentMessage = getMessageStmt.get(messageId);

            if (!currentMessage) {
                return res.status(404).json({ error: `Message ${messageId} not found` });
            }

            // Validate target version
            if (targetVer > currentMessage.edit_count) {
                return res.status(400).json({ error: `Target version ${targetVer} exceeds edit count ${currentMessage.edit_count}` });
            }

            // Parse edit history
            let editHistory = [];
            try {
                editHistory = JSON.parse(currentMessage.edit_history || '[]');
            } catch (e) {
                log(`[VERSION-SWITCH] Error parsing edit_history for message ${messageId}`);
                return res.status(500).json({ error: "Corrupted edit history" });
            }

            // Determine source and target content
            let targetContent, targetReasoning, targetToolCalls;

            if (targetVer === 0) {
                // Need to reconstruct original from edit_history
                if (editHistory.length > 0) {
                    const firstEdit = editHistory[0];
                    targetContent = firstEdit.content;
                    targetReasoning = firstEdit.reasoning;
                    targetToolCalls = firstEdit.tool_calls;
                } else {
                    // No history means we're already at original
                    targetContent = currentMessage.content;
                    targetReasoning = currentMessage.reasoning;
                    targetToolCalls = currentMessage.tool_calls;
                }
            } else {
                // Get from edit history (version N is at index N-1)
                if (targetVer - 1 >= editHistory.length) {
                    return res.status(400).json({ error: "Target version not found in history" });
                }
                const targetEdit = editHistory[targetVer - 1];
                targetContent = targetEdit.content;
                targetReasoning = targetEdit.reasoning;
                targetToolCalls = targetEdit.tool_calls;
            }

            // Archive current version to edit history
            if (currentMessage.active_edit_version !== targetVer) {
                const currentEditEntry = {
                    version: currentMessage.active_edit_version,
                    content: currentMessage.content,
                    reasoning: currentMessage.reasoning,
                    tool_calls: currentMessage.tool_calls,
                    timestamp: new Date().toISOString()
                };

                // Update edit history with current version
                if (currentMessage.active_edit_version === 0) {
                    // Moving from original, need to insert at beginning
                    editHistory.unshift(currentEditEntry);
                } else {
                    // Update existing version in history
                    editHistory[currentMessage.active_edit_version - 1] = currentEditEntry;
                }
            }

            // Generate fresh tool_call_ids for this version when switching
            let newToolCalls = null;
            const oldToNewIdMapping = {};
            
            if (targetToolCalls && Array.isArray(targetToolCalls)) {
                newToolCalls = targetToolCalls.map(tc => {
                    const oldId = tc.id;
                    const newId = require('crypto').randomBytes(16).toString('base64').replace(/[+/]/g, '').substring(0, 16);
                    if (oldId) {
                        oldToNewIdMapping[oldId] = newId;
                    }
                    return {
                        ...tc,
                        id: newId
                    };
                });
            }
            
            // Normalize tool_calls to use new IDs
            let normalizedToolCalls = newToolCalls || targetToolCalls;
            if (normalizedToolCalls && typeof normalizedToolCalls === 'string') {
                try {
                    normalizedToolCalls = JSON.parse(normalizedToolCalls);
                    // If we have a tool call but no newToolCalls, generate IDs for this too
                    if (!newToolCalls && Array.isArray(normalizedToolCalls)) {
                        newToolCalls = normalizedToolCalls.map(tc => {
                            const oldId = tc.id;
                            const newId = require('crypto').randomBytes(16).toString('base64').replace(/[+/]/g, '').substring(0, 16);
                            if (oldId) {
                                oldToNewIdMapping[oldId] = newId;
                            }
                            return {
                                ...tc,
                                id: newId
                            };
                        });
                        normalizedToolCalls = newToolCalls;
                    }
                } catch (e) {
                    // Keep as is
                }
            }
            
            // Update tool messages in this turn with new IDs
            if (Object.keys(oldToNewIdMapping).length > 0) {
                const turnId = db.prepare('SELECT turn_id FROM messages WHERE id = ?').get(messageId).turn_id;
                const updateToolStmt = db.prepare(`
                    UPDATE messages
                    SET tool_call_id = ?
                    WHERE turn_id = ? AND role = 'tool' AND tool_call_id = ?
                `);
                
                for (const [oldId, newId] of Object.entries(oldToNewIdMapping)) {
                    updateToolStmt.run(newId, turnId, oldId);
                }
            }

            // Update message with target version
            const updateStmt = db.prepare(`
                UPDATE messages 
                SET content = ?, 
                    reasoning = ?,
                    tool_calls = ?,
                    active_edit_version = ?,
                    edit_history = ?
                WHERE id = ?
            `);

            const editHistoryJson = JSON.stringify(editHistory);
            // Normalize tool_calls to JSON string for storage
            let toolCallsJson = normalizedToolCalls ? JSON.stringify(normalizedToolCalls) : null;
            
            const result = updateStmt.run(
                targetContent,
                targetReasoning,
                toolCallsJson,
                targetVer,
                editHistoryJson,
                messageId
            );

            if (result.changes === 0) {
                return res.status(404).json({ error: `Message ${messageId} not found` });
            }

            results.push({
                message_id: messageId,
                active_edit_version: targetVer,
                content: targetContent,
                reasoning: targetReasoning,
                tool_calls: targetToolCalls
            });
        }

        log(`[VERSION-SWITCH] Switched ${messageIds.length} messages to version ${targetVer}`);

        res.json({
            success: true,
            message_ids: messageIds,
            active_edit_version: targetVer,
            results: results
        });
    } catch (error) {
        log("[VERSION-SWITCH] Error switching version:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
