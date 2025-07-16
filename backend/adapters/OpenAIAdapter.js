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

        return {
            model: unifiedRequest.model,
            messages: processedMessages,
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
                        // HACK: Ollama/OpenAI-compatible APIs often support WebP data but expect JPEG/PNG MIME types
                        let mimeType = part.mimeType || 'image/jpeg';
                        if (mimeType === 'image/webp') {
                            mimeType = 'image/jpeg'; // Lie about WebP being JPEG for compatibility
                        }
                        const dataUrl = `data:${mimeType};base64,${part.imageData}`;
                        
                        return {
                            type: 'image_url',
                            image_url: {
                                url: dataUrl
                            }
                        };
                    
                    default:
                        // Fallback for unknown types
                        console.warn(`[OPENAI-ADAPTER] Unknown content part type: ${part.type}`);
                        return {
                            type: 'text',
                            text: part.text || JSON.stringify(part)
                        };
                }
            });
        }
        
        // Fallback for unexpected content format
        console.warn(`[OPENAI-ADAPTER] Unexpected content format:`, typeof content);
        return String(content);
    }

    /**
     * Check if a model supports vision/image input
     * Since OpenAI could be any model/provider, we'll assume vision support
     * and let the API handle unsupported models
     */
    supportsVision(modelName) {
        // For OpenAI adapter, we can't reliably detect vision support
        // since it could be any model (local, OpenAI, compatible APIs)
        // So we return true and let the API handle unsupported models
        return true;
    }

}

module.exports = OpenAIAdapter;