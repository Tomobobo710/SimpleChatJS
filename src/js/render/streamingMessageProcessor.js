// StreamingMessageProcessor.js - Creates blocks from streaming content (no rendering)

class StreamingMessageProcessor {
    constructor() {
        this.buffer = '';
        this.state = 'normal'; // 'normal', 'thinking'
        this.blocks = [];
        this.currentThinkingBlock = null;
        this.originalResponse = ''; // Track the actual streamed response for saving
    }
    
    // Add chunk of streaming content
    addChunk(chunk) {
        this.originalResponse += chunk; // Track original streamed response
        this.buffer += chunk;
        this.processBuffer(); // Still process for blocks/UI
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
            return this.checkForThinkingStart();
        } else if (this.state === 'thinking') {
            return this.checkForThinkingEnd();
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
        return this.originalResponse; // Return the actual streamed response, not reconstructed from blocks
    }
    
    // Get display content (clean text for preview)
    getDisplayContent() {
        return this.blocks.filter(block => block.type === 'chat')
                          .map(block => block.content)
                          .join(' ');
    }
}