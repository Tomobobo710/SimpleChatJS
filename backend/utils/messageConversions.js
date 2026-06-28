// Message conversion utilities - centralizes all DB row <-> JS object conversion
// to avoid duplication across routes and services.

const { log } = require("./logger");

// Safely parse a JSON string from a DB column. Returns the parsed value
// or null if the column is falsy / parsing fails.
function safeJsonParse(value, fieldName = null) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch (e) {
        if (fieldName) {
            log(`[MESSAGE-CONVERSION] Error parsing ${fieldName}: ${e.message}`);
        }
        return null;
    }
}

// Parse content that may be a plain string or a JSON-stringified multimodal array.
// If it's a string starting with '[', attempt to parse it as JSON; otherwise return as-is.
function parseContent(content) {
    if (typeof content === "string" && content.startsWith("[")) {
        return safeJsonParse(content, "content") ?? content;
    }
    return content;
}

// Parse a DB row into a plain JS object representing a message.
// Options control which optional fields to include:
//   includeFileFields — add original_content, file_metadata (default: false)
//   includeErrorState — add error_state (default: false)
function parseDbRowToMessage(row, options = {}) {
    const {
        includeFileFields = false,
        includeErrorState = false,
    } = options;

    const msg = {
        id: row.original_message_id || row.id,
        role: row.role,
        content: parseContent(row.content),
        timestamp: row.timestamp,
        turn_id: row.turn_id,
        parent_turn_id: row.parent_turn_id,
        edit_count: row.edit_count ?? 0,
        edited_at: row.edited_at,
        active_edit_version: row.active_edit_version ?? 0,
        turn_type: row.turn_type || null,
    };

    // Edit history (JSON array)
    if (row.edit_history) {
        msg.edit_history = safeJsonParse(row.edit_history, "edit_history") ?? [];
    }

    // Tool fields (always parsed the same way, present in all three readers)
    if (row.tool_calls) {
        msg.tool_calls = safeJsonParse(row.tool_calls, "tool_calls") ?? msg.tool_calls;
    }
    if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
    if (row.tool_name) msg.tool_name = row.tool_name;

    // Reasoning (plain text from AI, not JSON)
    if (row.reasoning) {
        msg.reasoning = row.reasoning;
    }

    // Per-message debug (wire data: request/response). The single source for the
    // debug panel — each message carries its own.
    if (row.debug_data) {
        msg.debug_data = safeJsonParse(row.debug_data, "debug_data");
    }

    // Conditional fields
    if (includeFileFields) {
        if (row.original_content) {
            msg.original_content = parseContent(row.original_content);
        }
        if (row.file_metadata) {
            msg.file_metadata = safeJsonParse(row.file_metadata, "file_metadata");
        }
    }
    if (includeErrorState) {
        msg.error_state = row.error_state;
    }

    return msg;
}

// Serialize a JS message object for storage in the DB.
// Returns an object with snake_case keys ready for an INSERT statement.
function serializeMessageForDb(messageData) {
    const content = Array.isArray(messageData.content)
        ? JSON.stringify(messageData.content)
        : messageData.content;

    const toolCalls = messageData.tool_calls ? JSON.stringify(messageData.tool_calls) : null;

    // Handle original content — may come as originalContent (camelCase) or original_content
    const originalContentVal = messageData.originalContent ?? messageData.original_content;
    const originalContent = originalContentVal
        ? Array.isArray(originalContentVal)
            ? JSON.stringify(originalContentVal)
            : originalContentVal
        : null;

    // Handle file metadata — may come as fileMetadata (camelCase) or file_metadata
    const fileMetadataVal = messageData.fileMetadata ?? messageData.file_metadata;
    const fileMetadata = fileMetadataVal ? JSON.stringify(fileMetadataVal) : null;

    // Per-message debug (wire data). Accept an object or pre-stringified JSON.
    const debugVal = messageData.debug_data ?? messageData.debugData ?? null;
    const debugData = debugVal
        ? (typeof debugVal === "string" ? debugVal : JSON.stringify(debugVal))
        : null;

    return {
        content,
        toolCalls,
        originalContent,
        fileMetadata,
        debugData,
    };
}

module.exports = {
    safeJsonParse,
    parseContent,
    parseDbRowToMessage,
    serializeMessageForDb,
};
