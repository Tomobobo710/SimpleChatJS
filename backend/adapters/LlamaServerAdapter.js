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

        // Request per-token timing stats in every SSE chunk so the frontend
        // can show live tokens/sec during streaming (not just at completion).
        request.timings_per_token = true;
        // Request prompt processing progress so the frontend can show a
        // footer during the prompt-eval phase, before generation starts.
        request.return_progress = true;

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

        // Additionally parse timings and prompt-progress from each chunk.
        // With timings_per_token=true, llama-server includes a `timings` object
        // in every SSE chunk — not just the final one. With return_progress=true,
        // it sends `prompt_progress` during the prompt-eval phase, before any
        // generation tokens are produced. We emit both as stats_update events
        // so the frontend can show a live footer throughout.
        try {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6);
                if (dataStr === '[DONE]') continue;
                try {
                    const data = JSON.parse(dataStr);
                    if (data.prompt_progress) {
                        const pp = data.prompt_progress;
                        result.events.push({
                            type: 'stats_update',
                            data: {
                                prompt_progress: {
                                    total: pp.total ?? null,
                                    cache: pp.cache ?? null,
                                    processed: pp.processed ?? null,
                                    time_ms: pp.time_ms ?? null
                                }
                            }
                        });
                    }
                    if (data.timings) {
                        const timings = {
                            predicted_per_second: data.timings.predicted_per_second ?? null,
                            prompt_per_second: data.timings.prompt_per_second ?? null,
                            predicted_n: data.timings.predicted_n ?? null,
                            prompt_n: data.timings.prompt_n ?? null,
                            predicted_per_token_ms: data.timings.predicted_per_token_ms ?? null
                        };
                        response.setTimings(timings);
                        result.events.push({
                            type: 'stats_update',
                            data: { timings }
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
