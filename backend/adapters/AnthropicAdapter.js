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
        
        // Add thinking mode for supported models
        const modelSupportsThinking = this.supportsThinking(unifiedRequest.model);
        const thinkingEnabled = this.isThinkingEnabled();
        const thinkingBudget = this.getThinkingBudget();
        
        if (modelSupportsThinking && thinkingEnabled) {
            request.thinking = {
                type: 'enabled',
                budget_tokens: thinkingBudget
            };
        }
        
        return request;
    }

    /**
     * Check if a model supports thinking mode
     */
    supportsThinking(modelName) {
        const thinkingModels = [
            'claude-3-7-sonnet',
            'claude-3.7-sonnet', 
            'claude-sonnet-4',
            'claude-4-sonnet',
            'claude-opus-4',
            'claude-4-opus'
        ];
        
        return thinkingModels.some(thinkingModel => 
            modelName.toLowerCase().includes(thinkingModel.toLowerCase())
        );
    }

    /**
     * Check if thinking mode is enabled in settings
     */
    isThinkingEnabled() {
        try {
            const { getCurrentSettings } = require('../services/settingsService');
            const settings = getCurrentSettings();
            // Check new provider-specific setting, fallback to old setting for backward compatibility
            return settings.enableThinkingAnthropic === true || settings.enableThinking === true;
        } catch (error) {
            console.log('[ANTHROPIC-ADAPTER] Could not get thinking settings, defaulting to disabled:', error.message);
            return false;
        }
    }

    /**
     * Get thinking budget from settings
     */
    getThinkingBudget() {
        try {
            const { getCurrentSettings } = require('../services/settingsService');
            const settings = getCurrentSettings();
            // Check new provider-specific setting, fallback to old setting for backward compatibility
            const budget = parseInt(settings.thinkingBudgetAnthropic) || parseInt(settings.thinkingBudget) || 8192;
            // Ensure it's within valid range for Anthropic
            return Math.max(1024, Math.min(32000, budget));
        } catch (error) {
            console.log('[ANTHROPIC-ADAPTER] Could not get thinking budget, using default');
            return 1024; // default to minimum
        }
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
                                // Send thinking tag to trigger dropdown system
                                response.addContent('<thinking>');
                                // Thinking block started
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
                                // Thinking content delta - stream to response for dropdown system
                                if (!context.thinkingContent) {
                                    context.thinkingContent = '';
                                }
                                const thinkingText = data.delta.thinking || '';
                                context.thinkingContent += thinkingText;
                                // Stream thinking content so the dropdown system can capture it
                                response.addContent(thinkingText);
                            }
                        } else if (data.type === 'content_block_stop') {
                            // Content block ended
                            if (context.currentContentBlock === 'thinking' && context.thinkingContent) {
                                // Close thinking tag for the dropdown system
                                response.addContent('</thinking>');
                                // Thinking block completed - add to response debug data
                                response.addDebugData('thinkingContent', context.thinkingContent);
                                // Thinking completed
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
