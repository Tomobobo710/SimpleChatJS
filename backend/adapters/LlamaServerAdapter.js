/**
 * LlamaServerAdapter
 *
 * Extends the OpenAI-compatible wire format with llama-server native extras:
 * - thinking_budget_tokens + reasoning_format in requests
 * - reasoning_content in streaming deltas
 * - timings (tokens/sec, prompt speed) in the final chunk
 */

const OpenAIAdapter = require('./OpenAIAdapter');
const { getProviderById } = require('./providerRegistry');

class LlamaServerAdapter extends OpenAIAdapter {
    constructor() {
        super();
        this.providerName = 'llama-server';
    }

    getEndpointUrl(settings) {
        return getProviderById('llama-server').getEndpointUrl(settings.apiUrl);
    }

    getHeaders(settings) {
        return getProviderById('llama-server').getHeaders(settings.apiKey, settings.apiUrl);
    }

    convertRequest(unifiedRequest, settings = {}) {
        // Start with the OpenAI-compatible base request
        const request = super.convertRequest(unifiedRequest, settings);

        // Add llama-server thinking params
        if (settings.enableThinkingLlama) {
            const budget = settings.thinkingBudgetLlama;
            const budgetVal = budget === undefined || budget === null ? -1 : parseInt(budget);
            request.thinking_budget_tokens = budgetVal;
        }

        if (settings.reasoningFormatLlama && settings.reasoningFormatLlama !== 'auto') {
            request.reasoning_format = settings.reasoningFormatLlama;
        }

        return request;
    }

    processChunk(chunk, response, context) {
        // Run the base OpenAI chunk processor (handles content, tool calls, usage, [DONE])
        const result = super.processChunk(chunk, response, context);

        // Additionally parse timings from the final stop chunk
        // llama-server sends a non-SSE JSON object when stop=true on /completion,
        // but on /v1/chat/completions timings appear in a data: chunk alongside usage.
        // We re-parse the chunk here to catch the timings field.
        try {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') continue;
                try {
                    const data = JSON.parse(dataStr);
                    if (data.timings) {
                        response.setTimings({
                            predicted_per_second: data.timings.predicted_per_second ?? null,
                            prompt_per_second: data.timings.prompt_per_second ?? null,
                            predicted_n: data.timings.predicted_n ?? null,
                            prompt_n: data.timings.prompt_n ?? null,
                            predicted_per_token_ms: data.timings.predicted_per_token_ms ?? null
                        });
                    }
                    // Note: reasoning_content on delta is already handled by OpenAIAdapter base class
                } catch (_) {}
            }
        } catch (error) {
            console.error('[LLAMA-ADAPTER] Error parsing timings:', error);
        }

        return result;
    }
}

module.exports = LlamaServerAdapter;
