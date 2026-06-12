// Message - a persistent source data record, the raw material from which Turns are computed.
// Messages are never merged or combined. They map directly to database rows.

class Message {
    constructor(data = {}) {
        this.id = data.id ?? null;
        this.role = data.role ?? 'other';
        this.content = data.content ?? '';
        this.turnNumber = data.turn_number ?? 0;
        this.turnId = data.turn_id ?? null;
        this.parentTurnId = data.parent_turn_id ?? null;
        this.timestamp = data.timestamp ?? null;
        this.toolCalls = data.tool_calls ?? null;
        this.toolCallId = data.tool_call_id ?? null;
        this.toolName = data.tool_name ?? null;
        this.toolResults = data.tool_results ?? null;
        this.thinking = data.thinking ?? null;
        this.reasoning = data.reasoning ?? null;
        this.errorState = data.error_state ?? null;
        const rawDebug = data.debug_data ?? null;
        if (rawDebug && typeof rawDebug === 'string') {
            try { this.debugData = JSON.parse(rawDebug); }
            catch (_) { this.debugData = rawDebug; }
        } else {
            this.debugData = rawDebug;
        }
        this.editCount = data.edit_count ?? 0;
        this.editedAt = data.edited_at ?? null;
    }

    isUser() {
        return this.role === 'user';
    }

    isAssistant() {
        return this.role === 'assistant';
    }

    isError() {
        return this.errorState !== null;
    }

    hasToolCalls() {
        return this.toolCalls !== null && this.toolCalls.length > 0;
    }

    hasThinking() {
        return this.thinking !== null && this.thinking.length > 0;
    }

    isEditable() {
        return this.isUser() && this.editCount < 3;
    }

    static fromApiData(data) {
        const parsedToolCalls = data.tool_calls
            ? (typeof data.tool_calls === 'string' ? JSON.parse(data.tool_calls) : data.tool_calls)
            : null;

        const parsedDebugData = data.debug_data
            ? (typeof data.debug_data === 'string' ? JSON.parse(data.debug_data) : data.debug_data)
            : null;

        return new Message({
            id: data.original_message_id || data.id || null,
            role: data.role,
            content: data.content,
            turn_number: data.turn_number,
            turn_id: data.turn_id ?? null,
            parent_turn_id: data.parent_turn_id ?? null,
            timestamp: data.timestamp,
            tool_calls: parsedToolCalls,
            tool_call_id: data.tool_call_id ?? null,
            tool_name: data.tool_name ?? null,
            tool_results: data.tool_results ?? null,
            thinking: data.thinking ?? null,
            reasoning: data.reasoning ?? null,
            error_state: data.error_state ?? null,
            debug_data: parsedDebugData,
            edit_count: data.edit_count || 0,
            edited_at: data.edited_at ?? null,
        });
    }

    static fromObject(obj) {
        return new Message(obj);
    }
}


