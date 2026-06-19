// Message - a persistent source data record, the raw material from which Turns are computed.
// Messages are never merged or combined. They map directly to database rows.

class Message {
    constructor(data = {}) {
        this.id = data.id ?? null;
        this.role = data.role ?? 'other';
      this.content = data.content ?? '';
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
        this.turnType = data.turn_type ?? null;
        this.editCount = data.edit_count ?? 0;
        this.editedAt = data.edited_at ?? null;
        this.activeEditVersion = data.active_edit_version ?? 0;
        
        // Parse editHistory if it's a string (from DB)
        const rawEditHistory = data.edit_history ?? null;
        if (rawEditHistory && typeof rawEditHistory === 'string') {
            try { this.editHistory = JSON.parse(rawEditHistory); }
            catch (_) { this.editHistory = []; }
        } else {
            this.editHistory = Array.isArray(rawEditHistory) ? rawEditHistory : [];
        }
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

     static fromObject(obj) {
        return new Message(obj);
    }
}


