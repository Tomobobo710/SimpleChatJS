/**
 * Response Adapter Factory
 *
 * Factory that creates the appropriate response adapter based on settings.
 * Uses the provider registry for explicit provider selection.
 */

const OpenAIAdapter = require('./OpenAIAdapter');
const GoogleAdapter = require('./GoogleAdapter');
const AnthropicAdapter = require('./AnthropicAdapter');
const LlamaServerAdapter = require('./LlamaServerAdapter');
const { detectProvider } = require('./providerRegistry');

class ResponseAdapterFactory {
    constructor() {
        // Map provider ids to adapter instances
        this.adapterMap = {
            anthropic: new AnthropicAdapter(),
            google: new GoogleAdapter(),
            openai: new OpenAIAdapter(),
            'openai-compatible': new OpenAIAdapter(),
            'llama-server': new LlamaServerAdapter()
        };
    }

    /**
     * Get the appropriate adapter for the given settings.
     * Throws if no provider matches (no implicit fallback).
     */
    getAdapter(settings) {
        const provider = detectProvider(settings);
        if (!provider) {
            throw new Error(`No provider matched for URL: ${settings.apiUrl}`);
        }
        const adapter = this.adapterMap[provider.id];
        if (!adapter) {
            throw new Error(`No adapter registered for provider: ${provider.id}`);
        }
        return adapter;
    }

    /**
     * Create a unified request object
     */
    createUnifiedRequest(messages, tools, model) {
        return {
            model: model,
            messages: messages,
            tools: tools || [],
            stream: true
        };
    }
}

// Export singleton instance
module.exports = new ResponseAdapterFactory();
