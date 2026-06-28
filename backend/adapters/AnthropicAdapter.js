/**
 * Anthropic Response Adapter
 * 
 * Handles Anthropic API responses and converts them to unified format
 */

const BaseResponseAdapter = require('./BaseResponseAdapter');
const { getProviderById } = require('./providerRegistry');

class AnthropicAdapter extends BaseResponseAdapter {
    constructor() {
        super('anthropic');
    }

   getEndpointUrl(settings) {
        return getProviderById('anthropic').getEndpointUrl(settings.apiUrl);
    }

    getHeaders(settings) {
        return getProviderById('anthropic').getHeaders(settings.apiKey);
    }

    // Normalize message content to an array of Anthropic content blocks.
    contentToBlocks(content) {
        if (Array.isArray(content)) return content;
        if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
        if (content == null) return [];
        return [content];
    }

    // Merge adjacent messages that share a role into a single message, combining
    // their content blocks. Anthropic rejects consecutive same-role turns, which
    // steering (multiple queued user messages) can produce.
    mergeConsecutiveMessages(messages) {
        const merged = [];
        for (const msg of messages) {
            const last = merged[merged.length - 1];
            if (last && last.role === msg.role) {
                last.content = this.contentToBlocks(last.content).concat(this.contentToBlocks(msg.content));
            } else {
                merged.push({ role: msg.role, content: msg.content });
            }
        }
        return merged;
    }

    convertRequest(unifiedRequest, settings) {
        // Convert from OpenAI format to Anthropic format
        const anthropicMessages = [];
        let systemPrompt = null;
        
        // Process messages and extract system prompt
        for (const message of unifiedRequest.messages) {
            if (message.role === 'system') {
                // Only the first system message becomes the system prompt; subsequent ones are dropped.
                if (systemPrompt === null) systemPrompt = message.content;
            } else if (message.role === 'tool') {
                // Convert tool results to Anthropic format
                anthropicMessages.push({
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: message.tool_call_id,
                            content: message.content
                        }
                    ]
                });
            } else {
                // Convert tool calls in assistant messages
                if (message.tool_calls && message.tool_calls.length > 0) {
                    const content = [];
                    
                    // Add text content if present
                    if (message.content) {
                        content.push({
                            type: 'text',
                            text: message.content
                        });
                    }
                    
                    // Add tool use blocks
                    for (const toolCall of message.tool_calls) {
                        content.push({
                            type: 'tool_use',
                            id: toolCall.id,
                            name: toolCall.function.name,
                            input: JSON.parse(toolCall.function.arguments)
                        });
                    }
                    
                    anthropicMessages.push({
                        role: message.role,
                        content: content
                    });
                } else {
                    // Handle both string and multimodal array content
                    const anthropicContent = this.convertContentToAnthropic(message.content);
                    anthropicMessages.push({
                        role: message.role,
                        content: anthropicContent
                    });
                }
            }
        }
        
        // Steering can produce consecutive same-role messages (e.g. several
        // queued user steers in a row). Anthropic's Messages API expects
        // alternating roles, so merge adjacent same-role messages by combining
        // their content blocks. This is the adapter's responsibility — the
        // stored history stays a faithful, role-accurate turn sequence (§5.1).
        const request = {
            model: unifiedRequest.model,
            max_tokens: 4096,
            messages: this.mergeConsecutiveMessages(anthropicMessages),
            stream: true
        };
        
        // Add system prompt if present
        if (systemPrompt) {
            request.system = systemPrompt;
        }
        
        // Add tools if present
        if (unifiedRequest.tools && unifiedRequest.tools.length > 0) {
            request.tools = unifiedRequest.tools.map(tool => ({
                name: tool.function.name,
                description: tool.function.description,
                input_schema: tool.function.parameters
            }));
        }
        
        // Add thinking mode if enabled — let the API reject unsupported models
        const thinkingEnabled = settings.enableThinkingAnthropic === true;
        const rawBudget = settings.thinkingBudgetAnthropic;
        const thinkingBudget = rawBudget !== undefined && rawBudget !== null
            ? Math.max(1024, Math.min(32000, parseInt(rawBudget) || 1024))
            : 1024;

        if (thinkingEnabled) {
            request.thinking = {
                type: 'enabled',
                budget_tokens: thinkingBudget
            };
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
                    
                    try {
                        const data = JSON.parse(dataStr);
                        
                        // Handle different event types
                        if (data.type === 'content_block_start') {
                            // Content block started
                            if (data.content_block.type === 'text') {
                                // Text content block started
                                context.currentContentBlock = 'text';
                            } else if (data.content_block.type === 'thinking') {
                                // Thinking content block started
                                context.currentContentBlock = 'thinking';
                            } else if (data.content_block.type === 'tool_use') {
                                // Tool use block started
                                const toolUse = data.content_block;
                                const newToolCall = {
                                    id: toolUse.id,
                                    type: 'function',
                                    function: {
                                        name: toolUse.name,
                                        arguments: JSON.stringify(toolUse.input)
                                    }
                                };
                                response.addToolCall(newToolCall);
                                context.currentToolCall = newToolCall;
                                
                                // Emit tool call detected event
                                events.push({
                                    type: 'tool_call_detected',
                                    data: {
                                        toolName: toolUse.name,
                                        toolId: toolUse.id
                                    }
                                });
                            }
                        } else if (data.type === 'content_block_delta') {
                            if (data.delta.type === 'text_delta') {
                                // Text content delta
                                response.addContent(data.delta.text);
                            } else if (data.delta.type === 'thinking_delta') {
                                // Thinking content delta - add to reasoning
                                const thinkingText = data.delta.thinking || '';
                                response.addReasoningBlock(thinkingText);
                            }
                        } else if (data.type === 'content_block_stop') {
                            // Content block ended
                        } else if (data.type === 'message_stop') {
                            response.setComplete(true);
                        }
                        
                        // Handle usage info
                        if (data.usage) {
                            response.setUsage({
                                prompt_tokens: data.usage.input_tokens,
                                completion_tokens: data.usage.output_tokens,
                                total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
                            });
                        }
                        
                    } catch (parseError) {
                        // Skip invalid JSON lines
                        continue;
                    }
                }
            }
        } catch (error) {
            console.error('[ANTHROPIC-ADAPTER] Error processing chunk:', error);
        }
        
        return { events, context };
    }

    /**
     * Convert content (string or multimodal array) to Anthropic format
     * @param {string|Array} content - Message content
     * @returns {string|Array} Content in Anthropic format
     */
    convertContentToAnthropic(content) {
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
                        // Convert to Anthropic's image format
                        return {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: part.mimeType || 'image/jpeg',
                                data: part.imageData
                            }
                        };
                    
                    default:
                        console.warn(`[ANTHROPIC-ADAPTER] Skipping unknown content part type: ${part.type}`);
                        return null;
                }
            }).filter(Boolean);
        }

        console.warn(`[ANTHROPIC-ADAPTER] Unexpected content format: ${typeof content}`);
        return [];
    }

  }

module.exports = AnthropicAdapter;