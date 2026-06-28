/**
 * Google/Gemini Response Adapter
 * 
 * Handles Google Gemini API responses and converts them to unified format
 */

const BaseResponseAdapter = require('./BaseResponseAdapter');
const { getProviderById } = require('./providerRegistry');

class GoogleAdapter extends BaseResponseAdapter {
    constructor() {
        super('google');
    }

    getEndpointUrl(settings) {
        const base = getProviderById('google').getEndpointUrl(settings.apiUrl, settings.modelName);
        return `${base}:streamGenerateContent?key=${settings.apiKey}`;
    }

    convertRequest(unifiedRequest, settings) {
        // Convert OpenAI format to Gemini format
        const contents = [];
        
        for (const msg of unifiedRequest.messages) {
            // Skip system messages - they're handled via systemInstruction
            if (msg.role === 'system') {
                continue;
            }
            
            // Check if message is already in Gemini format
            if (msg.parts) {
                contents.push(msg);
            } else if (msg.role === 'user' || msg.role === 'assistant') {
                // Convert content to parts array
                const parts = this.convertContentToParts(msg.content);
                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: parts
                });
            } else if (msg.role === 'tool') {
                // OpenAI tool response format - convert to Gemini
                let responseContent;
                try {
                    // Parse JSON string to object for Gemini
                    responseContent = JSON.parse(msg.content);
                } catch (e) {
                    // If not JSON, use as-is
                    responseContent = { result: msg.content };
                }
                
                if (!msg.tool_name) {
                    throw new Error('[GOOGLE-ADAPTER] Tool message missing tool_name');
                }
                contents.push({
                    role: 'user',
                    parts: [{
                        functionResponse: {
                            name: msg.tool_name,
                            response: responseContent
                        }
                    }]
                });
            }
        }
        
        // Convert tools format
        let geminiTools = [];
        if (unifiedRequest.tools?.length > 0) {
            const functionDeclarations = unifiedRequest.tools.map(tool => {
                const cleanParameters = this.cleanSchemaForGemini(tool.function.parameters);
                return {
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: cleanParameters
                };
            });
            geminiTools = [{ functionDeclarations }];
        }
        
        // Add thinking mode if enabled — let the API reject unsupported models
        const thinkingEnabled = settings.enableThinkingGoogle !== false;
        const rawBudget = settings.thinkingBudgetGoogle;
        const thinkingBudget = rawBudget === -1 || rawBudget === '-1'
            ? -1
            : Math.max(0, Math.min(24576, parseInt(rawBudget) || 8192));

        const request = {
            contents,
            ...(geminiTools.length > 0 ? { tools: geminiTools } : {})
        };

        if (thinkingEnabled && thinkingBudget !== 0) {
            request.generationConfig = {
                thinkingConfig: {
                    includeThoughts: true
                }
            };
            if (thinkingBudget !== -1) {
                request.generationConfig.thinkingConfig.thinkingBudget = thinkingBudget;
            }
        }
        
        // Add system instruction if present
        const systemMessage = unifiedRequest.messages.find(msg => msg.role === 'system');
        if (systemMessage) {
            request.systemInstruction = {
                parts: [{ text: systemMessage.content }]
            };
        }
        
        return request;
    }

    processChunk(chunk, response, context) {
        const events = [];
        
        try {
            context.buffer += chunk.toString();
            
            // Google sends streaming JSON in various formats - handle them all
            let remainingBuffer = context.buffer;
            let processedAny = false;
            
            // Keep trying to parse complete JSON chunks from the buffer
            while (remainingBuffer.trim()) {
                let parsed;
                let jsonEndIndex = -1;
                
                try {
                    // Find complete JSON boundaries (objects or arrays)
                    let bracketCount = 0;
                    let inString = false;
                    let escaping = false;
                    let foundStart = false;
                    
                    for (let i = 0; i < remainingBuffer.length; i++) {
                        const char = remainingBuffer[i];
                        
                        if (escaping) {
                            escaping = false;
                            continue;
                        }
                        
                        if (char === '\\') {
                            escaping = true;
                            continue;
                        }
                        
                        if (char === '"') {
                            inString = !inString;
                            continue;
                        }
                        
                        if (!inString) {
                            if (char === '[' || char === '{') {
                                bracketCount++;
                                foundStart = true;
                            } else if (char === ']' || char === '}') {
                                bracketCount--;
                                if (bracketCount === 0 && foundStart) {
                                    jsonEndIndex = i + 1;
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (jsonEndIndex === -1) {
                        break; // Wait for more data
                    }
                    
                    const jsonString = remainingBuffer.substring(0, jsonEndIndex).trim();
                    parsed = JSON.parse(jsonString);
                    
                    // Update remaining buffer
                    remainingBuffer = remainingBuffer.substring(jsonEndIndex).trim();
                    remainingBuffer = remainingBuffer.replace(/^[,\s]+/, '');
                    
                } catch (parseError) {
                    break; // Wait for more data
                }
                
                // Process each response immediately for proper streaming
                const responses = Array.isArray(parsed) ? parsed : [parsed];
                
                // Process each response object normally for streaming
                for (const responseObj of responses) {
                    const candidate = responseObj.candidates?.[0];
                    if (!candidate) continue;
                    
                    const parts = candidate.content?.parts || [];
                    
                    const tc = context.thinkingConfig || {};

                    for (const part of parts) {
                        if (part.text) {
                            if (tc.enabled && tc.budget !== 0 && part.thought) {
                                const lines = part.text.split('\n');
                                const detailedThoughts = lines.slice(2).join('\n').trim();
                                if (detailedThoughts) {
                                    response.addReasoningBlock(detailedThoughts);
                                }
                            } else {
                                response.addContent(part.text);
                            }
                        }
                        
                        if (part.functionCall) {
                            const toolCall = {
                                id: `call_${Date.now()}_${response.toolCalls.length}`,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(part.functionCall.args || {})
                                }
                            };
                            response.addToolCall(toolCall);
                            events.push({
                                type: 'tool_call_detected',
                                data: {
                                    toolName: toolCall.function.name,
                                    toolId: toolCall.id
                                }
                            });
                        }
                    }
                    
                    // Handle finish reason
                    if (candidate.finishReason) {
                        response.setComplete(true);
                    }
                    
                    // Handle usage metadata
                    if (responseObj.usageMetadata) {
                        response.setUsage({
                            prompt_tokens: responseObj.usageMetadata.promptTokenCount,
                            completion_tokens: responseObj.usageMetadata.candidatesTokenCount,
                            total_tokens: responseObj.usageMetadata.totalTokenCount
                        });
                    }
                }
                
                processedAny = true;
            }
            
            // Update buffer with remaining unparsed content
            if (processedAny) {
                context.buffer = remainingBuffer;
            }
                
        } catch (error) {
            // If any error occurs (parsing, processing, etc.), log and continue
            console.error('[GOOGLE-ADAPTER] Error processing chunk:', error.message);
            
            // Reset buffer if it gets too large to prevent memory issues
            if (context.buffer.length > 10000) {
                context.buffer = '';
            }
        }
        
        return { events, context };
    }

    createContext(modelName = '', thinkingConfig = null) {
        return {
            buffer: '', // Gemini needs buffering for complete JSON parsing
            currentToolCall: null,
            processingState: 'content',
            model: modelName, // Store model name for thinking detection
            thinkingConfig // Pass thinking settings from convertRequest
        };
    }

    /**
     * Convert content (string or array) to Google Gemini parts format
     * @param {string|Array} content - Message content
     * @returns {Array} Array of parts for Gemini API
     */
    convertContentToParts(content) {
        // If content is a string (current format), convert to text part
        if (typeof content === 'string') {
            return [{ text: content }];
        }
        
        // If content is an array (new multimodal format), convert each part
        if (Array.isArray(content)) {
            return content.map(part => {
                switch (part.type) {
                    case 'text':
                        return { text: part.text };
                    
                    case 'image':
                        // Convert to Google's inlineData format
                        return {
                            inlineData: {
                                mimeType: part.mimeType || 'image/jpeg',
                                data: part.imageData
                            }
                        };
                    
                    default:
                        console.warn(`[GOOGLE-ADAPTER] Skipping unknown content part type: ${part.type}`);
                        return null;
                }
            }).filter(Boolean);
        }

        console.warn(`[GOOGLE-ADAPTER] Unexpected content format: ${typeof content}`);
        return [];
    }

    /**
     * Clean schema for Gemini compatibility.
     * Removes `additionalProperties` and `default` keys that Gemini's schema
     * validator rejects. This changes JSON Schema semantics but is required
     * for the Gemini API to accept tool definitions.
     */
    cleanSchemaForGemini(schema) {
        if (!schema || typeof schema !== 'object') return schema;
        
        const cleaned = {};
        for (const [key, value] of Object.entries(schema)) {
            // Skip fields Gemini doesn't support
            if (key === 'additionalProperties' || key === 'default') {
                continue;
            }
            
            // Recursively clean nested objects and arrays
            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) {
                    cleaned[key] = value.map(item => 
                        typeof item === 'object' ? this.cleanSchemaForGemini(item) : item
                    );
                } else {
                    cleaned[key] = this.cleanSchemaForGemini(value);
                }
            } else {
                cleaned[key] = value;
            }
        }
        return cleaned;
    }

}

module.exports = GoogleAdapter;
