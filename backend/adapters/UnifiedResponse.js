/**
 * Unified Response Format
 * 
 * This is the single format that the entire application uses.
 * All provider-specific responses get converted to this format.
 */

class UnifiedResponse {
    constructor() {
        this.provider = null;           // 'openai', 'google', etc
        this.content = '';              // Text content for CURRENT response phase only
        this.toolCalls = [];            // Array of tool calls
        this.isComplete = false;        // Whether response is finished
        this.debugData = {};            // Debug information
        this.usage = {};                // Token usage info
        this.rawResponse = null;        // Original provider response
    }

    // Add text content
    addContent(text) {
        this.content += text;
        return this;
    }

    // Add a tool call
    addToolCall(toolCall) {
        // Normalize tool call format
        const normalized = {
            id: toolCall.id || `call_${Date.now()}_${this.toolCalls.length}`,
            type: 'function',
            function: {
                name: toolCall.function?.name || toolCall.name,
                arguments: typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments 
                    : JSON.stringify(toolCall.function?.arguments || toolCall.args || {})
            }
        };
        this.toolCalls.push(normalized);
        return this;
    }

    // Mark response as complete
    setComplete(complete = true) {
        this.isComplete = complete;
        return this;
    }

    // Set provider
    setProvider(provider) {
        this.provider = provider;
        return this;
    }

    // Set usage data
    setUsage(usage) {
        this.usage = usage;
        return this;
    }

    // Set raw response for debugging
    setRawResponse(rawResponse) {
        this.rawResponse = rawResponse;
        return this;
    }

    // Add debug data
    addDebugData(key, value) {
        this.debugData[key] = value;
        return this;
    }

    // Check if response has tool calls
    hasToolCalls() {
        return this.toolCalls.length > 0;
    }

    // Get the latest tool call
    getLatestToolCall() {
        return this.toolCalls[this.toolCalls.length - 1] || null;
    }

    // Convert to JSON for transmission
    toJSON() {
        return {
            provider: this.provider,
            content: this.content,
            toolCalls: this.toolCalls,
            isComplete: this.isComplete,
            usage: this.usage,
            debugData: this.debugData
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = UnifiedResponse;
} else {
    window.UnifiedResponse = UnifiedResponse;
}
