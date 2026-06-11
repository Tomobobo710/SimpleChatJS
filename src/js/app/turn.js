// Turn - a first-class concept representing a collection of messages grouped by turn_number AND parent_turn_id.
// Turns are never persisted — they are computed from Message source data.
// Turns with the same parent_turn_id but different turn_id are siblings.

function defaultErrorBlockContent(errorState) {
    switch (errorState) {
        case 'user_stopped': return 'Generation stopped by user.';
        case 'api_error': return 'The API returned an error.';
        case 'connection_error': return 'Connection error while receiving response.';
        case 'processing_error': return 'Error while processing the response stream.';
        default: return 'An error occurred during generation.';
    }
}

function resolveErrorBlockContent(errorMsg) {
    const fromDebug = errorMsg?.debugData?.error?.message;
    if (fromDebug && typeof fromDebug === "string" && fromDebug.trim()) {
        return fromDebug;
    }
    return defaultErrorBlockContent(errorMsg?.errorState);
}

class Turn {
    constructor(turnNumber, messages = [], turnId = null, parentTurnId = null) {
        this.turnNumber = turnNumber;
        this.messages = messages;
        this.turnId = turnId;
        this.parentTurnId = parentTurnId;
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

    hasRequestMessages() {
        return this.userMessages.length > 0;
    }

    hasResponseMessages() {
        return this.assistantMessages.length > 0;
    }

    // True if any assistant message carries non-empty content (i.e.
    // there is real streamed text to render). Used to gate the
    // "content + error" render branch so error-only messages don't
    // accidentally fall through and render an empty chat block.
    hasRenderableResponseContent() {
        return this.assistantMessages.some(
            (m) => m.content && (typeof m.content === 'string' ? m.content !== '' : true)
        );
    }

    // Produce a RenderableTurnObject for this turn.
    // Rendering priority: error-only turns show just the error block;
    // user messages render directly; assistant messages are processed
    // through StreamingMessageProcessor; if a turn has both assistant
    // content and an error, the content is rendered with the error
    // block appended at the end.
    renderable(liveProcessor = null) {
        // Errors alongside real streamed content: render the content +
        // an error block at the end (so user-stopped, connection drops,
        // etc. show what was streamed and what interrupted it).
        if (
            this.hasErrors() &&
            this.hasResponseMessages() &&
            this.hasRenderableResponseContent()
        ) {
            const responseRto = this._renderResponse(liveProcessor);
            const errorMsg = this.errorMessages[0];
            const errorBlock = new Block({
                type: 'error',
                content: resolveErrorBlockContent(errorMsg),
                metadata: {
                    error_type: errorMsg.errorState,
                    debug_data: errorMsg.debugData
                }
            });
            return new RenderableTurnObject({
                role: responseRto.role,
                content: responseRto.content,
                blocks: [...(responseRto.blocks || []), errorBlock],
                turnNumber: responseRto.turnNumber,
                turnId: responseRto.turnId,
                parentTurnId: responseRto.parentTurnId,
                debugData: responseRto.debugData,
                editCount: responseRto.editCount,
                dropdownStates: responseRto.dropdownStates,
            });
        }

        // Error-only turn (no streamed content to show). Rendered as
        // an assistant bubble with just the error block inside, so the
        // background bubble + action bar are consistent with the
        // "content + error" branch.
        if (this.hasErrors()) {
            const errorMsg = this.errorMessages[0];
            return new RenderableTurnObject({
                role: 'assistant',
                content: '',
                blocks: [new Block({
                    type: 'error',
                    content: resolveErrorBlockContent(errorMsg),
                    metadata: {
                        error_type: errorMsg.errorState,
                        debug_data: errorMsg.debugData
                    }
                })],
                turnNumber: errorMsg.turnNumber,
                turnId: this.turnId,
                parentTurnId: this.parentTurnId,
                debugData: errorMsg.debugData,
                editCount: errorMsg.editCount,
            });
        }

        // User messages render directly
        if (this.hasRequestMessages()) {
            return RenderableTurnObject.fromRequestMessage(this.userMessages[0]);
        }

        // Assistant messages: pure content path (no error attached).
        if (this.hasResponseMessages()) {
            return this._renderResponse(liveProcessor);
        }

        // Fallback: empty turn
        return new RenderableTurnObject({
            role: 'other',
            content: '',
            blocks: null,
            turnNumber: this.turnNumber,
            turnId: this.turnId,
            parentTurnId: this.parentTurnId,
            debugData: null,
            editCount: 0,
        });
    }

    // Build an assistant RTO from this turn's messages, using the
    // liveProcessor if provided (live render) or rebuilding blocks
    // from content (reload path). Shared by the pure-assistant and
    // "content + error" branches in renderable().
    _renderResponse(liveProcessor) {
        const assistantMessages = this.assistantMessages;
        let primaryMessage = assistantMessages.find(m => !m.content.is && m.content !== '') || assistantMessages[0];

        if (liveProcessor && primaryMessage) {
            return new RenderableTurnObject({
                role: 'assistant',
                content: liveProcessor.getRawContent() || '',
                blocks: liveProcessor.getBlocks(),
                turnNumber: primaryMessage.turnNumber,
                turnId: this.turnId,
                parentTurnId: this.parentTurnId,
                debugData: primaryMessage.debugData,
                editCount: primaryMessage.editCount,
            });
        }

        const processor = new StreamingMessageProcessor();

        for (const msg of assistantMessages) {
            if (!msg.content && !msg.toolCalls) {
                continue;
            }

            if (!primaryMessage) {
                primaryMessage = msg;
                turnDebugData = msg.debugData;
            }

            const content = msg.content || '';
            if (typeof content === 'string') {
                processor.addChunk(content);
            } else if (Array.isArray(content)) {
                const textParts = content.filter(part => part.type === 'text');
                textParts.forEach(part => {
                    if (part.text) {
                        processor.addChunk(part.text);
                    }
                });
            }

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

                    processor.handleToolEvent({
                        type: 'tool_call_detected',
                        data: { id: toolId, name: toolName }
                    });

                    processor.handleToolEvent({
                        type: 'tool_execution_start',
                        data: { id: toolId, name: toolName, arguments: args }
                    });

                    processor.handleToolEvent({
                        type: 'tool_execution_complete',
                        data: { id: toolId, name: toolName, status: 'success', result: resultContent, execution_time_ms: 0 }
                    });
                }
            }
        }

        processor.finalize();
        const blocks = processor.getBlocks();
        const primary = primaryMessage || this.assistantMessages[0];

        // Collect debug data from all messages in this turn
        const turnDebugDataArray = this.messages
            .map(m => m.debugData)
            .filter(d => d && (d.response || d.error));

        return new RenderableTurnObject({
            role: 'assistant',
            content: processor.getRawContent() || '',
            blocks: blocks,
            turnNumber: primary.turnNumber,
            turnId: this.turnId,
            parentTurnId: this.parentTurnId,
            debugData: primary?.debugData || null,
            debugDataAll: turnDebugDataArray.length > 0 ? turnDebugDataArray : null,
            turnMessages: this.messages.map(m => ({ role: m.role, content: m.content, tool_calls: m.toolCalls, tool_call_id: m.toolCallId, tool_name: m.toolName })),
            editCount: primary.editCount,
        });
    }
}


