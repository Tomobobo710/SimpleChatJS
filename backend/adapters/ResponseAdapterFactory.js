/**
 * Response Adapter Factory
 * 
 * Factory that creates the appropriate response adapter based on settings.
 * This is the main entry point for the adapter system.
 */

const OpenAIAdapter = require('./OpenAIAdapter');
const GoogleAdapter = require('./GoogleAdapter');
const AnthropicAdapter = require('./AnthropicAdapter');

class ResponseAdapterFactory {
    constructor() {
        // Register available adapters
        this.adapters = [
            new AnthropicAdapter(),
            new GoogleAdapter(),
            new OpenAIAdapter()  // OpenAI as fallback
        ];
    }

    /**
     * Get the appropriate adapter for the given settings
     * @param {Object} settings - Current API settings
     * @returns {BaseResponseAdapter} The adapter to use
     */
    getAdapter(settings) {
        // Find the first adapter that can handle these settings
        for (const adapter of this.adapters) {
            if (adapter.canHandle(settings)) {
                return adapter;
            }
        }
        
        // Fallback to OpenAI adapter
        return this.adapters[this.adapters.length - 1];
    }

    /**
     * Create a unified request object
     * @param {Array} messages - Chat messages
     * @param {Array} tools - Available tools
     * @param {string} model - Model name
     * @returns {Object} Unified request format
     */
    createUnifiedRequest(messages, tools, model) {
        return {
            model: model,
            messages: messages,
            tools: tools || [],
            stream: true
        };
    }

    /**
     * Register a new adapter
     * @param {BaseResponseAdapter} adapter - Adapter to register
     */
    registerAdapter(adapter) {
        this.adapters.unshift(adapter); // Add to beginning for priority
    }

    /**
     * Get all registered adapters
     * @returns {Array} Array of adapters
     */
    getAvailableAdapters() {
        return [...this.adapters];
    }
}

// Export singleton instance
module.exports = new ResponseAdapterFactory();
