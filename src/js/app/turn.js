// Turn - a first-class concept representing a collection of messages grouped by turn_number.
// Turns are never persisted — they are computed from Message source data.

class Turn {
    constructor(turnNumber, messages = []) {
        this.turnNumber = turnNumber;
        this.messages = messages;
    }

    get errorMessages() {
        return this.messages.filter(m => m.isError());
    }

    get userMessages() {
        return this.messages.filter(m => m.isUser());
    }

    get assistantMessages() {
        return this.messages.filter(m => m.isAssistant());
    }

    hasErrors() {
        return this.errorMessages.length > 0;
    }

    hasUserMessages() {
        return this.userMessages.length > 0;
    }

    hasAssistantMessages() {
        return this.assistantMessages.length > 0;
    }

    // Produce a RenderableTurnObject for this turn.
    // Rendering priority: error messages override, user messages render directly,
    // assistant messages are processed through StreamingMessageProcessor.
    renderable(liveProcessor = null) {
        // Error messages override normal rendering
        if (this.hasErrors()) {
            const errorMsg = this.errorMessages[0];
            return new RenderableTurnObject({
                role: 'error',
                content: errorMsg.content,
                blocks: [{
                    type: 'error',
                    content: errorMsg.content,
                    metadata: {
                        error_type: errorMsg.errorState
                    }
                }],
                turnNumber: errorMsg.turnNumber,
                debugData: errorMsg.debugData,
                editCount: errorMsg.editCount,
            });
        }

        // User messages render directly
        if (this.hasUserMessages()) {
            return RenderableTurnObject.fromUserMessage(this.userMessages[0]);
        }

        // Process assistant messages through StreamingMessageProcessor
        if (this.hasAssistantMessages()) {
            const assistantMessages = this.assistantMessages;
            let primaryMessage = assistantMessages.find(m => !m.content.is && m.content !== '') || assistantMessages[0];
            let turnDebugData = null;

            if (liveProcessor && primaryMessage) {
                // For live rendering, use the existing processor directly
                return new RenderableTurnObject({
                    role: 'assistant',
                    content: liveProcessor.getRawContent() || '',
                    blocks: liveProcessor.getBlocks(),
                    turnNumber: primaryMessage.turnNumber,
                    debugData: primaryMessage.debugData,
                    editCount: primaryMessage.editCount,
                });
            }

            // Reload path: create a new processor and rebuild blocks from content
            let processor = new StreamingMessageProcessor();

            for (const msg of assistantMessages) {
                // Skip empty messages unless they have tool calls
                if (!msg.content && !msg.toolCalls) {
                    continue;
                }

                if (!primaryMessage) {
                    primaryMessage = msg;
                    turnDebugData = msg.debugData;
                }

                // Feed content into processor
                const content = msg.content || '';
                if (typeof content === 'string') {
                    processor.addChunk(content);
                } else if (Array.isArray(content)) {
                    // Multimodal content - process text parts
                    const textParts = content.filter(part => part.type === 'text');
                    textParts.forEach(part => {
                        if (part.text) {
                            processor.addChunk(part.text);
                        }
                    });
                }

                // Simulate tool events if the message has tool calls
                if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
                    for (const toolCall of msg.toolCalls) {
                        const toolName = toolCall.function?.name || 'unknown_tool';
                        const toolId = toolCall.id;
                        let args = {};
                        try {
                            args = JSON.parse(toolCall.function?.arguments || '{}');
                        } catch (e) {
                            args = { raw: toolCall.function?.arguments || '{}' };
                        }

                        // Reconstruct tool result from tool messages in this turn
                        const toolMessage = this.messages.find(m =>
                            m.role === 'tool' && m.toolCallId === toolId
                        );
                        let resultContent = { content: 'No result available' };
                        if (toolMessage) {
                            try {
                                resultContent = JSON.parse(toolMessage.content);
                            } catch (e) {
                                resultContent = { content: toolMessage.content };
                            }
                        }

                        // Simulate the same tool event sequence as live rendering
                        handleToolEvent({
                            type: 'tool_call_detected',
                            data: { id: toolId, name: toolName }
                        }, processor, null, null);

                        handleToolEvent({
                            type: 'tool_execution_start',
                            data: { id: toolId, name: toolName, arguments: args }
                        }, processor, null, null);

                        handleToolEvent({
                            type: 'tool_execution_complete',
                            data: { id: toolId, name: toolName, status: 'success', result: resultContent, execution_time_ms: 0 }
                        }, processor, null, null);
                    }
                }
            }

            processor.finalize();
            const blocks = processor.getBlocks();
            const primary = primaryMessage || this.assistantMessages[0];

            return new RenderableTurnObject({
                role: 'assistant',
                content: processor.getRawContent() || '',
                blocks: blocks,
                turnNumber: primary.turnNumber,
                debugData: turnDebugData,
                editCount: primary.editCount,
            });
        }

        // Fallback: empty turn
        return new RenderableTurnObject({
            role: 'other',
            content: '',
            blocks: null,
            turnNumber: this.turnNumber,
            debugData: null,
            editCount: 0,
        });
    }
}


