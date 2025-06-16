// StreamingMessageProcessor.js - Creates blocks from streaming content (no rendering)

class StreamingMessageProcessor {
    constructor() {
        this.buffer = '';
        this.state = 'normal'; // 'normal', 'thinking', 'tool'
        this.blocks = [];
        this.currentThinkingBlock = null;
        this.currentToolContent = ''; // Accumulate tool content across chunks
    }
    
    // Add chunk of streaming content
    addChunk(chunk) {
        this.buffer += chunk;
        this.processBuffer();
    }
    
    // Process buffer to identify block boundaries
    processBuffer() {
        let foundPattern = true;
        while (foundPattern) {
            foundPattern = this.processNextPattern();
        }
    }
    
    processNextPattern() {
        if (this.state === 'normal') {
            return this.checkForThinkingStart() || this.checkForToolStart();
        } else if (this.state === 'thinking') {
            return this.checkForThinkingEnd();
        } else if (this.state === 'tool') {
            return this.checkForToolEnd();
        }
        return false;
    }
    
    checkForThinkingStart() {
        const thinkStartIndex = this.buffer.indexOf('<think>');
        if (thinkStartIndex !== -1) {
            // Create chat block for any content before <think>
            if (thinkStartIndex > 0) {
                const contentBefore = this.buffer.slice(0, thinkStartIndex).trim();
                if (contentBefore) {
                    this.createChatBlock(contentBefore);
                }
            }
            
            // Immediately create a thinking block for real-time streaming
            const thinkingBlock = {
                type: 'thinking',
                content: '',
                metadata: { id: `thinking_${Date.now()}`, isStreaming: true }
            };
            this.blocks.push(thinkingBlock);
            this.currentThinkingBlock = thinkingBlock;
            
            // Switch to thinking state
            this.buffer = this.buffer.slice(thinkStartIndex + 7); // Remove '<think>'
            this.state = 'thinking';
            logger.debug(`[PROCESSOR] THINKING BLOCK CREATED IMMEDIATELY! Total blocks: ${this.blocks.length}`);
            return true;
        }
        return false;
    }
    
    checkForThinkingEnd() {
        const thinkEndIndex = this.buffer.indexOf('</think>');
        if (thinkEndIndex !== -1) {
            // Update the existing thinking block with final content
            const thinkingContent = this.buffer.slice(0, thinkEndIndex);
            
            if (this.currentThinkingBlock) {
                this.currentThinkingBlock.content += thinkingContent;
                this.currentThinkingBlock.content = this.currentThinkingBlock.content.trim();
                this.currentThinkingBlock.metadata.isStreaming = false;
                logger.debug(`[PROCESSOR] Completed thinking block: ${this.currentThinkingBlock.content.length} chars`);
            }
            
            // Continue with normal content
            this.buffer = this.buffer.slice(thinkEndIndex + 8); // Remove '</think>'
            this.state = 'normal';
            this.currentThinkingBlock = null;
            return true;
        } else {
            // Still in thinking block, accumulate content and update live
            if (this.currentThinkingBlock) {
                this.currentThinkingBlock.content += this.buffer;
                this.currentThinkingBlock.content = this.currentThinkingBlock.content.trim();
                logger.debug(`[PROCESSOR] Updating thinking content: ${this.currentThinkingBlock.content.length} chars`);
            }
            
            this.buffer = '';
        }
        return false;
    }
    
    checkForToolStart() {
        const toolStartIndex = this.buffer.indexOf('[Executing tools...]');
        if (toolStartIndex !== -1) {
            // Create chat block for any content before tool marker
            if (toolStartIndex > 0) {
                const contentBefore = this.buffer.slice(0, toolStartIndex).trim();
                if (contentBefore) {
                    this.createChatBlock(contentBefore);
                }
            }
            
            // Switch to tool state and reset tool accumulator
            this.currentToolContent = '';
            this.buffer = this.buffer.slice(toolStartIndex + 20); // Remove '[Executing tools...]'
            this.state = 'tool';
            return true;
        }
        return false;
    }
    
    checkForToolEnd() {
        const toolEndIndex = this.buffer.indexOf('[Tools completed]');
        if (toolEndIndex !== -1) {
            // Add final chunk to accumulated tool content
            const finalChunk = this.buffer.slice(0, toolEndIndex);
            this.currentToolContent += finalChunk;
            
            // Create tool block with all accumulated content
            if (this.currentToolContent.trim()) {
                this.createToolBlock(this.currentToolContent.trim());
            }
            
            // Continue with normal content
            this.buffer = this.buffer.slice(toolEndIndex + 17); // Remove '[Tools completed]'
            this.state = 'normal';
            return true;
        } else {
            // Still in tool section, accumulate content and clear buffer
            this.currentToolContent += this.buffer;
            this.buffer = '';
        }
        return false;
    }
    
    // Create a chat block immediately
    createChatBlock(content) {
        if (content.trim()) {
            const block = {
                type: 'chat',
                content: content.trim(),
                metadata: {}
            };
            this.blocks.push(block);
            logger.debug(`[PROCESSOR] Created chat block: ${content.length} chars`);
        }
    }
    
    // Create a tool block immediately
    createToolBlock(content) {
        if (content.trim()) {
            const block = {
                type: 'tool',
                content: content.trim(),
                metadata: this.extractMetadata(content, 'tool')
            };
            this.blocks.push(block);
            logger.debug(`[PROCESSOR] Created tool block: ${content.length} chars`);
        }
    }
    
    extractMetadata(content, type) {
        const metadata = {};
        
        if (type === 'tool') {
            // Try to extract tool name from content
            const toolMatch = content.match(/\[([^\]]+)\]/);
            if (toolMatch) {
                metadata.toolName = toolMatch[1];
            }
        }
        
        return metadata;
    }
    
    finalize() {
        logger.debug(`[PROCESSOR] Finalizing in state: ${this.state}, blocks: ${this.blocks.length}`);
        
        // Handle any remaining content based on current state
        if (this.state === 'thinking') {
            // Update existing thinking block if we have one
            if (this.currentThinkingBlock) {
                this.currentThinkingBlock.content += this.buffer;
                this.currentThinkingBlock.content = this.currentThinkingBlock.content.trim();
                this.currentThinkingBlock.metadata.isStreaming = false;
                logger.debug(`[PROCESSOR] Finalized existing thinking block`);
            }
        } else if (this.state === 'tool') {
            // Add any remaining buffer to tool content and create block
            this.currentToolContent += this.buffer;
            if (this.currentToolContent.trim()) {
                this.createToolBlock(this.currentToolContent.trim());
            }
        } else if (this.state === 'normal') {
            // Create chat block for any remaining normal content
            if (this.buffer.trim()) {
                this.createChatBlock(this.buffer);
            }
        }
        
        logger.debug(`[PROCESSOR] Finalized with ${this.blocks.length} blocks`);
        return this.blocks;
    }
    
    // Get current blocks (for real-time updates)
    getBlocks() {
        return this.blocks;
    }
    
    // Get raw content for saving (original API response)
    getRawContent() {
        return this.blocks.map(block => {
            if (block.type === 'thinking') {
                return `<think>${block.content}</think>`;
            } else if (block.type === 'tool') {
                return `[Executing tools...]${block.content}[Tools completed]`;
            } else {
                return block.content;
            }
        }).join('\n\n');
    }
    
    // Get display content (clean text for preview)
    getDisplayContent() {
        return this.blocks.filter(block => block.type === 'chat')
                          .map(block => block.content)
                          .join(' ');
    }
}