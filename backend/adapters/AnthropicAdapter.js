/**
 * Anthropic Response Adapter
 * 
 * Handles Anthropic API responses and converts them to unified format
 */

const BaseResponseAdapter = require('./BaseResponseAdapter');
const UnifiedResponse = require('./UnifiedResponse');

class AnthropicAdapter extends BaseResponseAdapter {
    constructor() {
        super('anthropic');
    }

    canHandle(settings) {
        return settings.apiUrl.toLowerCase().includes('anthropic.com');
    }

    getEndpointUrl(settings) {
        return `${settings.apiUrl}/messages`;
    }

    getHeaders(settings) {
        const headers = super.getHeaders(settings);
        
        if (settings.apiKey) {
            headers['x-api-key'] = settings.apiKey;
        }
        
        // Required Anthropic version header
        headers['anthropic-version'] = '2023-06-01';
        
        return headers;
    }

    convertRequest(unifiedRequest) {
        // Convert from OpenAI format to Anthropic format
        const anthropicMessages = [];
        let systemPrompt = null;
        
        // Process messages and extract system prompt
        for (const message of unifiedRequest.messages) {
            if (message.role === 'system') {
                systemPrompt = message.content;
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
                    anthropicMessages.push({
                        role: message.role,
                        content: message.content
                    });
                }
            }
        }
        
        const request = {
            model: unifiedRequest.model,
            max_tokens: 4096,
            messages: anthropicMessages,
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
                            if (data.content_block.type === 'text') {
                                // Text content block started
                                context.currentContentBlock = 'text';
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
                            }
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
}

module.exports = AnthropicAdapter;
