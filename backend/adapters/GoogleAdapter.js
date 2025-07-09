/**
 * Google/Gemini Response Adapter
 * 
 * Handles Google Gemini API responses and converts them to unified format
 */

const BaseResponseAdapter = require('./BaseResponseAdapter');
const UnifiedResponse = require('./UnifiedResponse');

class GoogleAdapter extends BaseResponseAdapter {
    constructor() {
        super('google');
    }

    canHandle(settings) {
        return settings.apiUrl.toLowerCase().includes('google');
    }

    getEndpointUrl(settings) {
        const cleanModelName = settings.modelName.startsWith('models/') 
            ? settings.modelName.substring(7) 
            : settings.modelName;
        
        return `${settings.apiUrl}/models/${cleanModelName}:streamGenerateContent?key=${settings.apiKey}`;
    }

    convertRequest(unifiedRequest) {
        // Convert OpenAI format to Gemini format
        const contents = [];
        
        for (const msg of unifiedRequest.messages) {
            // Check if message is already in Gemini format
            if (msg.parts) {
                contents.push(msg);
            } else if (msg.role === 'user' || msg.role === 'assistant') {
                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
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
                
                contents.push({
                    role: 'user',
                    parts: [{
                        functionResponse: {
                            name: msg.tool_name || 'unknown_tool',
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
        
        // Add thinking mode for supported models
        const modelSupportsThinking = this.supportsThinking(unifiedRequest.model);
        const thinkingEnabled = this.isThinkingEnabled();
        const thinkingBudget = this.getThinkingBudget();
        
        const request = {
            contents,
            ...(geminiTools.length > 0 ? { tools: geminiTools } : {})
        };
        
        // Add thinking configuration for supported models
        if (modelSupportsThinking && thinkingEnabled && thinkingBudget !== 0) {
            request.generationConfig = {
                thinkingConfig: {
                    includeThoughts: true
                }
            };
            
            // Only set thinkingBudget if it's not -1 (auto mode)
            if (thinkingBudget !== -1) {
                request.generationConfig.thinkingConfig.thinkingBudget = thinkingBudget;
            }
        }
        
        return request;
    }

    processChunk(chunk, response, context) {
        const events = [];
        
        try {
            context.buffer += chunk.toString();
            
            // Try to parse complete JSON response
            try {
                const parsed = JSON.parse(context.buffer);
                
                // Handle array of responses or single response
                const responses = Array.isArray(parsed) ? parsed : [parsed];
                
                for (const responseObj of responses) {
                    const candidate = responseObj.candidates?.[0];
                    if (!candidate) continue;
                    
                    const parts = candidate.content?.parts || [];
                    
                    // Handle thinking mode for Google models
                    const isThinkingModel = this.supportsThinking(context.model || '');
                    const isThinkingEnabled = this.isThinkingEnabled();
                    const thinkingBudget = this.getThinkingBudget();
                    const hasThoughts = parts.some(part => part.thought);
                    
                    if (isThinkingModel && isThinkingEnabled && thinkingBudget !== 0 && hasThoughts) {
                        // Process each part according to Google's format
                        for (const part of parts) {
                            if (!part.text) continue;
                            
                            // If this part has thought=true, it's thinking content
                            if (part.thought) {
                                // Parse Gemini thinking content to separate summary from detailed thoughts
                                const lines = part.text.split('\n');
                                const summaryLine = lines[0] || ''; // "**Summary Title**"
                                const summary = summaryLine.replace(/\*\*/g, '').trim(); // Remove markdown bold
                                const detailedThoughts = lines.slice(2).join('\n').trim(); // Skip title and empty line
                                
                                // Use summary as dropdown title, detailed thoughts as content
                                if (summary && detailedThoughts) {
                                    response.addContent(`<thinking title="${summary}">`);
                                    response.addContent(detailedThoughts);
                                    response.addContent('</thinking>');
                                    response.addDebugData('thinkingContent', detailedThoughts);
                                    response.addDebugData('thinkingSummary', summary);
                                } else {
                                    // Fallback: use original format if parsing fails
                                    response.addContent('<thinking>');
                                    response.addContent(part.text);
                                    response.addContent('</thinking>');
                                    response.addDebugData('thinkingContent', part.text);
                                }
                            }
                            // Otherwise it's the regular response
                            else {
                                response.addContent(part.text);
                            }
                            
                            // Handle function calls
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
                    } else {
                        // Process all parts normally
                        
                        for (const part of parts) {
                            // Handle text content
                            if (part.text) {
                                response.addContent(part.text);
                            }
                            
                            // Handle function calls
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
                                
                                // Emit tool call detected event
                                events.push({
                                    type: 'tool_call_detected',
                                    data: {
                                        toolName: toolCall.function.name,
                                        toolId: toolCall.id
                                    }
                                });
                            }
                        }
                    }
                    
                    // Handle finish reason
                    if (candidate.finishReason === 'STOP') {
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
                
                // Clear buffer after successful parse
                context.buffer = '';
                
            } catch (parseError) {
                // Incomplete JSON, keep buffering
                // Reset buffer if it gets too large to prevent memory issues
                if (context.buffer.length > 10000) {
                    context.buffer = '';
                }
            }
            
        } catch (error) {
            console.error('[GOOGLE-ADAPTER] Error processing chunk:', error.message);
        }
        
        return { events, context };
    }

    createContext(modelName = '') {
        return {
            buffer: '', // Gemini needs buffering for complete JSON parsing
            currentToolCall: null,
            processingState: 'content',
            model: modelName // Store model name for thinking detection
        };
    }

    /**
     * Clean schema for Gemini compatibility
     * Removes fields that Gemini doesn't support
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

    /**
     * Check if a model supports thinking mode
     */
    supportsThinking(modelName) {
        return modelName.toLowerCase().includes('2.5');
    }

    /**
     * Check if thinking mode is enabled in settings
     */
    isThinkingEnabled() {
        try {
            const { getCurrentSettings } = require('../services/settingsService');
            const settings = getCurrentSettings();
            return settings.enableThinkingGoogle !== false;
        } catch (error) {
            return true; // default to enabled for Google
        }
    }

    /**
     * Get thinking budget from settings
     */
    getThinkingBudget() {
        try {
            const { getCurrentSettings } = require('../services/settingsService');
            const settings = getCurrentSettings();
            const rawBudget = settings.thinkingBudgetGoogle;
            
            // Handle auto mode
            if (rawBudget === -1 || rawBudget === '-1') {
                return -1;
            }
            
            const budget = parseInt(rawBudget) || 8192;
            return Math.max(0, Math.min(24576, budget));
        } catch (error) {
            return 8192;
        }
    }
}

module.exports = GoogleAdapter;
