/**
 * OpenAI Response Adapter
 * 
 * Handles OpenAI API responses and converts them to unified format
 */

const BaseResponseAdapter = require('./BaseResponseAdapter');
const UnifiedResponse = require('./UnifiedResponse');

class OpenAIAdapter extends BaseResponseAdapter {
    constructor() {
        super('openai');
    }

    canHandle(settings) {
        return !settings.apiUrl.toLowerCase().includes('google') && 
               !settings.apiUrl.toLowerCase().includes('anthropic.com');
    }

    getEndpointUrl(settings) {
        return `${settings.apiUrl}/chat/completions`;
    }

    getHeaders(settings) {
        const headers = super.getHeaders(settings);
        
        if (settings.apiKey) {
            headers['Authorization'] = `Bearer ${settings.apiKey}`;
        }
        
        // OpenRouter-specific headers
        if (settings.apiUrl.includes('openrouter.ai')) {
            headers['HTTP-Referer'] = 'https://simplechatjs.local';
            headers['X-Title'] = 'SimpleChatJS';
        }
        
        return headers;
    }

    convertRequest(unifiedRequest) {
        // OpenAI uses the unified request format directly
        return {
            model: unifiedRequest.model,
            messages: unifiedRequest.messages,
            stream: true,
            ...(unifiedRequest.tools?.length ? { tools: unifiedRequest.tools } : {})
        };
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
                        
                        // Handle content
                        if (delta.content) {
                            response.addContent(delta.content);
                        }
                        
                        // Handle tool calls
                        if (delta.tool_calls) {
                            for (const toolCall of delta.tool_calls) {
                                if (toolCall.index === 0 && toolCall.id) {
                                    // New tool call
                                    const newToolCall = {
                                        id: toolCall.id,
                                        type: 'function',
                                        function: {
                                            name: toolCall.function?.name || '',
                                            arguments: toolCall.function?.arguments || ''
                                        }
                                    };
                                    response.addToolCall(newToolCall);
                                    context.currentToolCall = newToolCall;
                                    
                                    // Emit tool call detected event
                                    events.push({
                                        type: 'tool_call_detected',
                                        data: {
                                            toolName: newToolCall.function.name,
                                            toolId: newToolCall.id
                                        }
                                    });
                                } else if (context.currentToolCall && toolCall.function?.arguments) {
                                    // Continue building arguments
                                    context.currentToolCall.function.arguments += toolCall.function.arguments;
                                    
                                    // Update the tool call in response
                                    const latestToolCall = response.getLatestToolCall();
                                    if (latestToolCall) {
                                        latestToolCall.function.arguments = context.currentToolCall.function.arguments;
                                    }
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
}

module.exports = OpenAIAdapter;
