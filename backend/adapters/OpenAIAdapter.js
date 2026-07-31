/**
 * OpenAI Response Adapter
 * 
 * Handles OpenAI API responses and converts them to unified format
 */

const BaseResponseAdapter = require('./BaseResponseAdapter');
const { getProviderById } = require('./providerRegistry');

class OpenAIAdapter extends BaseResponseAdapter {
    constructor() {
        super('openai');
    }

    getEndpointUrl(settings) {
        const providerId = settings.adapterType === 'openai' ? 'openai' : 'openai-compatible';
        return getProviderById(providerId).getEndpointUrl(settings.apiUrl);
    }

    getHeaders(settings) {
        const providerId = settings.adapterType === 'openai' ? 'openai' : 'openai-compatible';
        return getProviderById(providerId).getHeaders(settings.apiKey, settings.apiUrl);
    }

    convertRequest(unifiedRequest, settings = {}) {

        // Process messages to handle multimodal content
        const processedMessages = unifiedRequest.messages.map(message => {
            return {
                role: message.role,
                content: this.convertContentToOpenAI(message.content),
                // Preserve tool calls if present
                ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
                // Preserve tool call id if present
                ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
                // Preserve tool name if present
                ...(message.tool_name ? { tool_name: message.tool_name } : {})
            };
        });

        const request = {
            model: unifiedRequest.model,
            messages: processedMessages,
            stream: true,
            ...(unifiedRequest.tools?.length ? { tools: unifiedRequest.tools } : {})
        };

        // Add reasoning_effort for literal OpenAI adapter when enabled
        if (settings.adapterType === 'openai' && settings.enableThinkingOpenAI === true) {
            request.reasoning_effort = settings.reasoningEffortOpenAI || 'medium';
        }

        return request;
    }

    processChunk(chunk, response, context) {
        const events = [];
        
        try {
            const lines = chunk.toString().split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6);
                    
                    if (dataStr === '[DONE]') {
                        response.setComplete(true);
                        continue;
                    }
                    
                    try {
                        const data = JSON.parse(dataStr);
                        const delta = data.choices?.[0]?.delta;
                        
                        if (!delta) continue;
                        
                        // Handle reasoning content (o1/o3/Qwen reasoning models)
                        if (delta.reasoning_content || delta.reasoning) {
                            const reasoningText = delta.reasoning_content || delta.reasoning;
                            response.addReasoningBlock(reasoningText);
                        }
                        
                        // Handle content
                        if (delta.content) {
                            response.addContent(delta.content);
                        }
                        
                        // Handle tool calls
                        if (delta.tool_calls) {
                            // Track tool calls by their streaming index so that
                            // multiple tool calls in one response are each handled
                            // independently. The OpenAI streaming format assigns
                            // each tool call an index (0, 1, 2, ...); the first
                            // chunk for each carries id + function.name, and
                            // subsequent chunks carry argument deltas for that index.
                            if (!context.toolCallsByIndex) context.toolCallsByIndex = {};

                            for (const toolCall of delta.tool_calls) {
                                const idx = toolCall.index ?? 0;
                                const existing = context.toolCallsByIndex[idx];

                                if (toolCall.id && !existing) {
                                    // New tool call (first chunk for this index)
                                    const newToolCall = {
                                        id: toolCall.id,
                                        type: 'function',
                                        function: {
                                            name: toolCall.function?.name || '',
                                            arguments: normalizeArgsDelta(toolCall.function?.arguments)
                                        }
                                    };
                                    response.addToolCall(newToolCall);
                                    // Store the NORMALIZED object from response.toolCalls
                                    // (addToolCall creates a copy), so argument deltas
                                    // accumulate on the same object the response holds.
                                    context.toolCallsByIndex[idx] = response.toolCalls[response.toolCalls.length - 1];
                                    context.currentToolCall = context.toolCallsByIndex[idx];

                                    // Emit tool call detected event
                                    events.push({
                                        type: 'tool_call_detected',
                                        data: {
                                            toolName: newToolCall.function.name,
                                            toolId: newToolCall.id
                                        }
                                    });

                                    // If the initial chunk already included arguments
                                    // (some servers send name+args in one chunk), emit
                                    // the delta so the UI can start rendering live.
                                    if (newToolCall.function.arguments) {
                                        events.push({
                                            type: 'tool_call_arguments_delta',
                                            data: {
                                                toolId: newToolCall.id,
                                                toolName: newToolCall.function.name,
                                                arguments: newToolCall.function.arguments
                                            }
                                        });
                                    }
                                } else if (existing && toolCall.function?.arguments) {
                                    // Continue building arguments for this tool call
                                    existing.function.arguments += normalizeArgsDelta(toolCall.function.arguments);

                                    // Emit tool call arguments delta for incremental streaming
                                    events.push({
                                        type: 'tool_call_arguments_delta',
                                        data: {
                                            toolId: existing.id,
                                            toolName: existing.function.name,
                                            arguments: existing.function.arguments
                                        }
                                    });
                                }
                            }
                        }
                        
                        // Handle usage info
                        if (data.usage) {
                            response.setUsage(data.usage);
                        }
                        
                    } catch (parseError) {
                        // Skip invalid JSON lines
                        continue;
                    }
                }
            }
        } catch (error) {
            console.error('[OPENAI-ADAPTER] Error processing chunk:', error);
        }
        
        return { events, context };
    }

    /**
     * Convert content (string or multimodal array) to OpenAI format
     * @param {string|Array} content - Message content
     * @returns {string|Array} Content in OpenAI format
     */
    convertContentToOpenAI(content) {
        // If content is a string (text-only), return as-is
        if (typeof content === 'string') {
            return content;
        }
        
        // If content is an array (multimodal), convert each part
        if (Array.isArray(content)) {
            return content.map(part => {
                switch (part.type) {
                    case 'text':
                        return {
                            type: 'text',
                            text: part.text
                        };
                    
                    case 'image':
                        // Convert to OpenAI's image_url format with data URL
                        const dataUrl = `data:${part.mimeType || 'image/jpeg'};base64,${part.imageData}`;
                        
                        return {
                            type: 'image_url',
                            image_url: {
                                url: dataUrl
                            }
                        };
                    
                    default:
                        console.warn(`[OPENAI-ADAPTER] Skipping unknown content part type: ${part.type}`);
                        return null;
                }
            }).filter(Boolean);
        }

        console.warn(`[OPENAI-ADAPTER] Unexpected content format: ${typeof content}`);
        return [];
    }

  }

function normalizeArgsDelta(delta) {
    if (delta == null) return '';
    if (typeof delta === 'string') return delta;
    if (typeof delta === 'object') return JSON.stringify(delta);
    return String(delta);
}

module.exports = OpenAIAdapter;