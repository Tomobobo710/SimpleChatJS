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

    // Add system content block (inserted at natural position in sequence)
    addSystemContent(content) {
        if (!content || (typeof content === 'string' && !content.trim())) return;
        this._blockSequence.push({ type: 'system', content: '' + content });
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
            case 'shell_output_chunk':
                this._onShellOutputChunk(data);
                break;
            case 'tool_execution_complete':
                this._onToolExecutionComplete(data);
                break;
        }
    }

    // Keep the live console's in-memory buffer bounded so a runaway command can't
    // pin a huge string in the DOM. We only ever show the tail anyway.
    static get SHELL_CONSOLE_MAX() { return 500000; }

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
        if (!block) return;
        block.metadata.arguments = data.arguments;
        if (block.metadata.toolName === 'shell_run') {
            // Stream the command into the console as the model types it (data.arguments
            // is the accumulated partial JSON, so pull a best-effort command out).
            block.metadata.isShellConsole = true;
            const cmd = StreamingMessageProcessor._partialShellCommand(data.arguments);
            if (cmd) block.metadata.command = cmd;
            if (block.metadata.shellStatus !== 'done') block.metadata.shellStatus = 'running';
            block.content = `__shell__|args:${(data.arguments || '').length}`;
        } else {
            block.content = `[${data.name}]:\nArguments: ${data.arguments}\nResult: Executing...`;
        }
    }

    // Extract the command value from a partial/streaming JSON args string, tolerating
    // an unterminated string or a dangling escape mid-stream.
    static _partialShellCommand(argsStr) {
        if (typeof argsStr !== 'string') return '';
        const m = argsStr.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (!m) return '';
        for (const candidate of [m[1], m[1].replace(/\\+$/, '')]) {
            try { return JSON.parse('"' + candidate + '"'); } catch (e) { /* keep trying */ }
        }
        return m[1];
    }

    _onToolExecutionStart(data) {
        let block = this._findToolBlock(data.id);
        // Defensive: if no tool_call_detected preceded this (e.g. some adapters),
        // create the block so shell chunks have somewhere to land.
        if (!block) {
            block = new Block({
                type: 'tool',
                content: `[${data.name}]:`,
                metadata: { toolName: data.name, id: data.id, status: 'executing' }
            });
            this._toolBlocks.set(data.id, block);
            this._blockSequence.push({ type: 'tool', id: data.id, ref: block });
        }
        block.metadata.status = 'executing';
        block.metadata.arguments = data.arguments;

        if (data.name === 'shell_run') {
            block.metadata.isShellConsole = true;
            block.metadata.command = data.arguments && data.arguments.command;
            block.metadata.shellStatus = 'running';
            if (block.metadata.shellOutput === undefined) block.metadata.shellOutput = '';
            block.content = `__shell__|status:running|len:${block.metadata.shellOutput.length}`;
        } else {
            block.content = `[${data.name}]:\nArguments: ${JSON.stringify(data.arguments, null, 2)}\nResult: Executing...`;
        }
    }

    _onShellOutputChunk(data) {
        const block = this._findToolBlock(data.id);
        if (!block) return;
        block.metadata.isShellConsole = true;
        let out = (block.metadata.shellOutput || '') + (data.chunk || '');
        const max = StreamingMessageProcessor.SHELL_CONSOLE_MAX;
        if (out.length > max) out = out.slice(out.length - max);
        block.metadata.shellOutput = out;
        block.metadata.shellStatus = 'running';
        // Bump content so the live-render diff fires and the console body updates.
        block.content = `__shell__|status:running|len:${out.length}`;
    }

    _onToolExecutionComplete(data) {
        const block = this._findToolBlock(data.id);
        if (!block) return;

        // Keep the raw result/error on metadata so getToolMessages() can reconstruct
        // the tool-role message (the debug panel's source for tool results) on the
        // live path, matching what the DB stores for the reload path.
        block.metadata.result = data.status === 'success' ? (data.result ?? null) : null;
        block.metadata.error = data.status === 'success' ? null : (data.error ?? null);

        // Shell consoles keep the terminal view instead of an Arguments/Result
        // dropdown. On reload there were no live chunks, so seed the console body
        // from the stored result output here.
        if (block.metadata.isShellConsole || data.name === 'shell_run') {
            block.metadata.isShellConsole = true;
            const result = (data.status === 'success' && data.result) ? data.result : (data.result || {});
            if (!block.metadata.shellOutput) {
                block.metadata.shellOutput = (result && typeof result.output === 'string') ? result.output : '';
            }
            block.metadata.shellExitCode = (result && result.exit_code !== undefined) ? result.exit_code : null;
            block.metadata.shellSuccess = data.status === 'success' && (!result || result.success !== false);
            block.metadata.shellResult = result || null; // full result object for the raw JSON view
            block.metadata.shellTruncated = !!(result && result.truncated);
            block.metadata.shellError = (result && result.error) || (data.status !== 'success' ? data.error : null);
            block.metadata.shellStatus = 'done';
            // Live finishes linger before auto-collapsing (grace period to read the
            // output); reloads collapse immediately (shellDoneAt = 0 → no delay).
            block.metadata.shellDoneAt = this._live ? Date.now() : 0;
            block.metadata.command = block.metadata.command || (block.metadata.arguments && block.metadata.arguments.command);
            block.metadata.status = data.status;
            block.content = `__shell__|status:done|exit:${block.metadata.shellExitCode}|len:${(block.metadata.shellOutput || '').length}`;
            return;
        }

        {
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

    // Tool-role messages reconstructed from this turn's tool blocks, shaped like the
    // DB's tool messages ({ role, tool_call_id, tool_name, content }). Lets the live
    // debug panel read tool results from the same single source the reload path uses.
    getToolMessages() {
        const msgs = [];
        for (const item of this._blockSequence) {
            if (item.type !== 'tool') continue;
            const md = (item.ref && item.ref.metadata) || {};
            if (!md.id) continue;
            const content = md.status === 'success'
                ? JSON.stringify(md.result ?? null)
                : JSON.stringify({ error: md.error ?? 'error' });
            msgs.push({ role: 'tool', tool_call_id: md.id, tool_name: md.toolName, content });
        }
        return msgs;
    }

    getBlocks() {
        const blocks = [];

        for (const item of this._blockSequence) {
            if (item.type === 'thinking') {
                blocks.push(item.ref);
            } else if (item.type === 'tool') {
                blocks.push(item.ref);
            } else if (item.type === 'system' && item.content.trim()) {
                blocks.push(new Block({ type: 'system', content: item.content, metadata: {} }));
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
