// Turn - a first-class concept representing a collection of messages grouped by turn_id + parent_turn_id.
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
    constructor(messages = [], turnId = null, parentTurnId = null, responseDebugData = null, identity = null) {
        this.messages = messages;
        this.turnId = turnId;
        this.parentTurnId = parentTurnId;
        this.responseDebugData = responseDebugData;
        this.identity = identity;
    }

    get errorMessages() {
        return this.messages.filter(m => m.isError());
    }

    hasErrors() {
        return this.errorMessages.length > 0;
    }

    // True if any message in this turn carries content worth rendering.
    // Used to gate the "content + error" render branch so we don't
    // render a chat block from an empty content field.
    hasRenderableContent() {
        return this.messages.some(
            (m) => (m.content && (typeof m.content === 'string' ? m.content !== '' : true)) || m.reasoning
        );
    }

    // Produce a RenderableTurnObject for this turn.
    // Identity comes from the stored turn_type on messages (this.identity).
    // Missing identity means the messages lack turn_type — fix your data.
    renderable(liveProcessor = null) {
        if (!this.identity) {
            throw new Error(
                `Turn ${this.turnId} has no identity — messages missing turn_type. `
                + `Found roles: [${[...new Set(this.messages.map(m => m.role))].join(', ')}]`
            );
        }

        if (this.identity === 'request') {
            return this._renderRequest();
        }

        if (this.identity === 'response') {
            // Errors alongside real streamed content
            if (this.hasErrors() && this.hasRenderableContent()) {
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
                    identity: 'response',
                    content: responseRto.content,
                    blocks: [...(responseRto.blocks || []), errorBlock],
                    turnId: responseRto.turnId,
                    parentTurnId: responseRto.parentTurnId,
                    debugData: responseRto.debugData,
                    responseDebugData: this.responseDebugData,
                    editCount: responseRto.editCount,
                    activeEditVersion: responseRto.activeEditVersion,
                    dropdownStates: responseRto.dropdownStates,
                });
            }

            // Error-only turn
            if (this.hasErrors()) {
                const errorMsg = this.errorMessages[0];
                return new RenderableTurnObject({
                    identity: 'response',
                    content: '',
                    blocks: [new Block({
                        type: 'error',
                        content: resolveErrorBlockContent(errorMsg),
                        metadata: {
                            error_type: errorMsg.errorState,
                            debug_data: errorMsg.debugData
                        }
                    })],
                    turnId: this.turnId,
                    parentTurnId: this.parentTurnId,
                    debugData: errorMsg.debugData,
                    responseDebugData: this.responseDebugData,
                    editCount: errorMsg.editCount,
                    activeEditVersion: errorMsg.activeEditVersion,
                });
            }

            return this._renderResponse(liveProcessor);
        }

    }
    _renderRequest() {
        const processor = new StreamingMessageProcessor();

        const imageBlocks = [];

        for (const msg of this.messages) {
            if (!msg.content) continue;
            if (msg.role === 'system') {
                processor.addSystemContent(msg.content);
                continue;
            }
            const content = msg.content;
            if (typeof content === 'string') {
                processor.addChunk(content);
            } else if (Array.isArray(content)) {
                content.forEach(part => {
                    if (part.type === 'text' && part.text) processor.addChunk(part.text);
                    else if (part.type === 'image') imageBlocks.push(new Block({ type: 'image', content: '', metadata: { imageData: part.imageData, mimeType: part.mimeType } }));
                });
            }
        }

        processor.finalize();
        const blocks = [...(processor.getBlocks() || []), ...imageBlocks];
        const primary = this.messages.find(m => m.content && m.role !== 'system') || this.messages.find(m => m.content) || this.messages[0];

        return new RenderableTurnObject({
            identity: 'request',
            content: processor.getRawContent() || '',
            blocks,
            turnId: this.turnId,
            parentTurnId: this.parentTurnId,
            debugData: primary?.debugData || null,
            turnMessages: this.messages.map(m => ({ id: m.id, role: m.role, content: m.content, editCount: m.editCount })),
            editCount: primary?.editCount || 0,
            activeEditVersion: primary?.activeEditVersion || 0,
        });
    }

    // Build a response RTO from this turn's messages, using the
    // liveProcessor if provided (live render) or rebuilding blocks
    // from content (reload path).
    _renderResponse(liveProcessor) {
        // Prefer a message with non-empty string content as primary
        // (tool result messages have toolCallId set, skip them)
        let primaryMessage = this.messages.find(m => !m.toolCallId && m.content && typeof m.content === 'string' && m.content !== '')
            || this.messages.find(m => !m.toolCallId && m.content)
            || this.messages[0];
        let turnDebugData = null;

        if (liveProcessor && primaryMessage) {
           return new RenderableTurnObject({
                identity: 'response',
                content: liveProcessor.getRawContent() || '',
                blocks: liveProcessor.getBlocks(),
                turnId: this.turnId,
                parentTurnId: this.parentTurnId,
                debugData: primaryMessage.debugData,
                editCount: primaryMessage.editCount,
                activeEditVersion: primaryMessage.activeEditVersion,
            });
        }

        const processor = new StreamingMessageProcessor();

        for (const msg of this.messages) {
            if (msg.toolCallId) continue;
            if (msg.role === 'system' && msg.content) {
                processor.addSystemContent(msg.content);
                continue;
            }
            if (!msg.content && !msg.toolCalls && !msg.reasoning) continue;

            if (!primaryMessage) {
                primaryMessage = msg;
                turnDebugData = msg.debugData;
            }

            if (msg.reasoning) {
                processor.loadReasoning(msg.reasoning);
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

                    const toolResult = this.messages.find(m =>
                        m.toolCallId === toolId
                    );
                    let resultContent = { content: 'No result available' };
                    if (toolResult) {
                        try {
                            resultContent = JSON.parse(toolResult.content);
                        } catch (e) {
                            resultContent = { content: toolResult.content };
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
        const blocks = processor.getBlocks() || [];
        const primary = primaryMessage || this.messages[0];

        // Collect debug data from all messages in this turn
        const turnDebugDataArray = this.messages
            .map(m => m.debugData)
            .filter(d => d && (d.response || d.error));

        return new RenderableTurnObject({
            identity: 'response',
            content: processor.getRawContent() || '',
            blocks: blocks,
            turnId: this.turnId,
            parentTurnId: this.parentTurnId,
            debugData: primary?.debugData || null,
            responseDebugData: turnDebugDataArray.length > 0 ? turnDebugDataArray : null,
            turnMessages: this.messages.map(m => ({ id: m.id, role: m.role, content: m.content, tool_calls: m.toolCalls, tool_call_id: m.toolCallId, tool_name: m.toolName, editCount: m.editCount })),
            editCount: primary.editCount,
            activeEditVersion: primary.activeEditVersion,
        });
    }
}



