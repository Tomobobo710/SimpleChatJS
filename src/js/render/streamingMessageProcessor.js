/**
 * StreamingMessageProcessor - Processes streaming responses and builds renderable objects.
 * This processor handles structured SSE events from the backend to create reasoning blocks,
 * content blocks, and tool blocks without mixing old and new code paths.
 */

class StreamingMessageProcessor {
    constructor() {
        // Ordered block sequence - maintains insertion order for all block types
        this._blockSequence = [];         // Array of { type, id, ref } tracking arrival order
        
        // Block storage by type
        this._reasoningBlocks = new Map(); // id -> reasoning block
        this._toolBlocks = new Map();      // id -> tool block
        this._activeReasoningBlock = null; // Current reasoning block being written
        
        // Content accumulation
        this._chatContent = '';           // Current chat content accumulation
        
        // Finalization state
        this._finalContent = null;
        this._finalReasoningBlocks = null;
    }

    // ===== BACKWARD COMPAT: Loading from database =====
    // For loading messages from database, we may need to reconstruct from raw content
    addChunk(chunk) {
        this._chatContent += chunk;
        const lastSeq = this._blockSequence[this._blockSequence.length - 1];
        if (lastSeq && lastSeq.type === 'chat') {
            lastSeq.content += chunk;
        } else {
            this._blockSequence.push({ type: 'chat', content: '' + chunk });
        }
    }

    // Load raw reasoning data from database and convert to reasoning blocks
    loadReasoning(reasoningData) {
        if (!reasoningData) return;

        // If it's an array, it's reasoning blocks
        if (Array.isArray(reasoningData)) {
            for (const block of reasoningData) {
                if (block.id && block.content) {
                    const reasoningBlock = {
                        id: block.id,
                        content: block.content,
                        isComplete: block.isComplete !== false,
                        type: 'thinking'
                    };
                    this._reasoningBlocks.set(block.id, reasoningBlock);
                    this._blockSequence.push({ type: 'thinking', id: block.id, ref: reasoningBlock });
                }
            }
        }
        // If it's a string, treat it as raw reasoning text
        else if (typeof reasoningData === 'string') {
            if (reasoningData.trim()) {
                const reasoningBlock = {
                    id: `reasoning_${Date.now()}`,
                    content: reasoningData,
                    isComplete: true,
                    type: 'thinking'
                };
                this._reasoningBlocks.set(reasoningBlock.id, reasoningBlock);
                this._blockSequence.push({ type: 'thinking', id: reasoningBlock.id, ref: reasoningBlock });
            }
        }
    }

    // ===== STRUCTURED SSE HANDLERS =====

    // Start a new reasoning block
    startReasoningBlock(blockId) {
        this._activeReasoningBlock = {
            id: blockId,
            content: '',
            isComplete: false,
            type: 'thinking'
        };
        this._reasoningBlocks.set(blockId, this._activeReasoningBlock);
        // Track in sequence
        this._blockSequence.push({ type: 'thinking', id: blockId, ref: this._activeReasoningBlock });
    }

    // Add content to the active reasoning block
    addReasoningDelta(blockId, text) {
        if (this._activeReasoningBlock && this._activeReasoningBlock.id === blockId) {
            this._activeReasoningBlock.content += text;
        }
    }

    // Finish the active reasoning block
    finishReasoningBlock(blockId) {
        if (this._activeReasoningBlock && this._activeReasoningBlock.id === blockId) {
            this._activeReasoningBlock.isComplete = true;
            this._activeReasoningBlock = null;
        }
    }

    // Add content delta to chat
    addContentDelta(text) {
        // Finish any active reasoning block before adding content
        if (this._activeReasoningBlock) {
            this._activeReasoningBlock.isComplete = true;
            this._activeReasoningBlock = null;
        }
        this._chatContent += text;
        const lastSeq = this._blockSequence[this._blockSequence.length - 1];
        if (lastSeq && lastSeq.type === 'chat') {
            lastSeq.content += text;
        } else {
            this._blockSequence.push({ type: 'chat', content: '' + text });
        }
    }

    // Handle tool events
    handleToolEvent(toolEvent) {
        if (!toolEvent || !toolEvent.data) return;

        const data = toolEvent.data;

        switch (toolEvent.type) {
            case 'tool_call_detected':
                this._onToolCallDetected(data);
                break;
            case 'tool_call_arguments_delta':
                this._onToolCallArgumentsDelta(data);
                break;
            case 'tool_execution_start':
                this._onToolExecutionStart(data);
                break;
            case 'tool_execution_complete':
                this._onToolExecutionComplete(data);
                break;
        }
    }

    _findToolBlock(toolId) {
        return this._toolBlocks.get(toolId);
    }

    _onToolCallDetected(data) {
        const alreadyExists = this._toolBlocks.has(data.id);
        if (!alreadyExists) {
            const toolBlock = new Block({
                type: 'tool',
                content: `[${data.name}]:\nArguments: Loading...\nResult: Executing...`,
                metadata: { toolName: data.name, id: data.id, status: 'executing' }
            });
            this._toolBlocks.set(data.id, toolBlock);
            // Track in sequence
            this._blockSequence.push({ type: 'tool', id: data.id, ref: toolBlock });
        }
    }

    _onToolCallArgumentsDelta(data) {
        const block = this._findToolBlock(data.id);
        if (block) {
            block.content = `[${data.name}]:\nArguments: ${data.arguments}\nResult: Executing...`;
            block.metadata.arguments = data.arguments;
        }
    }

    _onToolExecutionStart(data) {
        const block = this._findToolBlock(data.id);
        if (block) {
            block.content = `[${data.name}]:\nArguments: ${JSON.stringify(data.arguments, null, 2)}\nResult: Executing...`;
            block.metadata.status = 'executing';
            block.metadata.arguments = data.arguments;
        }
    }

    _onToolExecutionComplete(data) {
        const block = this._findToolBlock(data.id);
        if (block) {
            let resultContent;
            if (data.status === 'success') {
                const result = data.result;
                if (result && result.content) {
                    resultContent = JSON.stringify({
                        success: result.success,
                        content: result.content,
                        isError: result.isError === false ? false : !!result.isError
                    }, null, 2);
                } else {
                    resultContent = JSON.stringify(result, null, 2);
                }
            } else {
                resultContent = `ERROR: ${data.error}`;
            }
            block.content = `[${data.name}]:\nArguments: ${JSON.stringify(block.metadata.arguments || {}, null, 2)}\nResult: ${resultContent}`;
            block.metadata.status = data.status;
            block.metadata.execution_time_ms = data.execution_time_ms;
        }
    }

    // Finalize the response with data from the done event
    finalize(eventData) {
        // Store final content and reasoning blocks from done event if available
        if (eventData) {
            this._finalContent = eventData.content || this._chatContent;
            this._finalReasoningBlocks = eventData.reasoningBlocks || this._reasoningBlocks;
        }

        // Finish any remaining active reasoning block
        if (this._activeReasoningBlock) {
            this._activeReasoningBlock.isComplete = true;
            this._activeReasoningBlock = null;
        }
    }

    // ===== GETTERS FOR RENDERING =====

    getBlocks() {
        const blocks = [];

        for (const item of this._blockSequence) {
            if (item.type === 'thinking') {
                blocks.push(item.ref);
            } else if (item.type === 'tool') {
                blocks.push(item.ref);
            } else if (item.type === 'chat' && item.content.trim()) {
                this._splitIntoBlocks(item.content, blocks);
            }
        }

        return blocks;
    }

    _splitIntoBlocks(content, blocks) {
        const regex = /```(\w*)\r?\n?/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(content)) !== null) {
            const textBefore = content.slice(lastIndex, match.index);
            if (textBefore.trim()) {
                blocks.push(new Block({ type: 'chat', content: textBefore, metadata: {} }));
            }

            const lang = match[1];
            const rest = content.slice(match.index + match[0].length);

            const closeMatch = rest.match(/\n```/) || rest.match(/```/);
            if (closeMatch) {
                const codeContent = rest.slice(0, closeMatch.index);
                blocks.push(new Block({
                    type: 'codeblock', content: codeContent,
                    metadata: { language: lang, isStreaming: false }
                }));
                lastIndex = match.index + match[0].length + closeMatch.index + 4;
                regex.lastIndex = lastIndex;
            } else {
                blocks.push(new Block({
                    type: 'codeblock', content: rest,
                    metadata: { language: lang, isStreaming: true }
                }));
                return;
            }
        }

        const remaining = content.slice(lastIndex);
        if (remaining.trim()) {
            blocks.push(new Block({ type: 'chat', content: remaining, metadata: {} }));
        }
    }

    getRawContent() {
        return this._finalContent !== null ? this._finalContent : this._chatContent;
    }

    getDisplayContent() {
        return this.getRawContent();
    }

    getReasoningBlocks() {
        const blocks = [];
        for (const blockRef of this._reasoningBlocks.values()) {
            blocks.push(blockRef);
        }
        return this._finalReasoningBlocks || blocks;
    }

    getState() {
        return {
            reasoningBlocks: Array.from(this._reasoningBlocks.values()),
            chatContent: this._chatContent,
            toolBlocks: Array.from(this._toolBlocks.values()),
            activeReasoningBlock: this._activeReasoningBlock,
            blockSequence: this._blockSequence
        };
    }
}

// Export for use in browser context
if (typeof module !== 'undefined' && module.exports) {
    module.exports = StreamingMessageProcessor;
}
