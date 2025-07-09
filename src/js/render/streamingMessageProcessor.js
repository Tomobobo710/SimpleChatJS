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
        // Check if buffer ends with a potential partial tag - if so, wait for next chunk
        const partialTags = [
            // Opening tag partials
            '<', '<t', '<th', '<thi', '<thin', '<think', '<thinki', '<thinkin', '<thinking',
            // Closing tag partials  
            '</', '</t', '</th', '</thi', '</thin', '</think', '</thinki', '</thinkin', '</thinking'
        ];
        const endsWithPartial = partialTags.some(partial => this.buffer.endsWith(partial));
        
        if (endsWithPartial) {
            // Don't process yet, wait for next chunk to complete the tag
            return;
        }
        
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
        // Check for both <think> and <thinking> tags, including ones with title attributes
        const thinkStartIndex = this.buffer.indexOf('<think>');
        const thinkingStartIndex = this.buffer.indexOf('<thinking');
        
        let startIndex = -1;
        let tagLength = 0;
        let tagType = '';
        let title = null;
        
        // Find the earliest tag
        if (thinkStartIndex !== -1 && (thinkingStartIndex === -1 || thinkStartIndex < thinkingStartIndex)) {
            startIndex = thinkStartIndex;
            tagLength = 7; // '<think>'.length
            tagType = '<think>';
        } else if (thinkingStartIndex !== -1) {
            // Look for the full thinking tag (could be <thinking> or <thinking title="...">)
            const thinkingTagMatch = this.buffer.slice(thinkingStartIndex).match(/^<thinking(?:\s+title="([^"]*)")?>/);
            if (thinkingTagMatch) {
                startIndex = thinkingStartIndex;
                tagLength = thinkingTagMatch[0].length;
                tagType = thinkingTagMatch[0];
                title = thinkingTagMatch[1] || null; // Extract title if present
            }
        }
        
        if (startIndex !== -1) {
            // Create chat block for any content before thinking tag
            if (startIndex > 0) {
                const contentBefore = this.buffer.slice(0, startIndex).trim();
                if (contentBefore) {
                    this.createChatBlock(contentBefore);
                }
            }
            
            // Immediately create a thinking block for real-time streaming
            const thinkingBlock = {
                type: 'thinking',
                content: '',
                metadata: { 
                    id: `thinking_${Date.now()}`, 
                    isStreaming: true,
                    tagType: tagType, // Track which tag type we're using
                    title: title // Store the title if present
                }
            };
            this.blocks.push(thinkingBlock);
            this.currentThinkingBlock = thinkingBlock;
            
            // Switch to thinking state
            this.buffer = this.buffer.slice(startIndex + tagLength);
            this.state = 'thinking';
            logger.debug(`[PROCESSOR] THINKING BLOCK CREATED with ${tagType}${title ? ` (title: "${title}")` : ''}! Total blocks: ${this.blocks.length}`);
            return true;
        }
        return false;
    }
    
    checkForThinkingEnd() {
        // Check for both </think> and </thinking> tags
        const thinkEndIndex = this.buffer.indexOf('</think>');
        const thinkingEndIndex = this.buffer.indexOf('</thinking>');
        
        let endIndex = -1;
        let tagLength = 0;
        let tagType = '';
        
        // Find the earliest closing tag
        if (thinkEndIndex !== -1 && (thinkingEndIndex === -1 || thinkEndIndex < thinkingEndIndex)) {
            endIndex = thinkEndIndex;
            tagLength = 8; // '</think>'.length
            tagType = '</think>';
        } else if (thinkingEndIndex !== -1) {
            endIndex = thinkingEndIndex;
            tagLength = 11; // '</thinking>'.length
            tagType = '</thinking>';
        }
        
        if (endIndex !== -1) {
            // Update the existing thinking block with final content
            const thinkingContent = this.buffer.slice(0, endIndex);
            
            if (this.currentThinkingBlock) {
                this.currentThinkingBlock.content += thinkingContent;
                this.currentThinkingBlock.content = this.currentThinkingBlock.content.trim();
                this.currentThinkingBlock.metadata.isStreaming = false;
                logger.debug(`[PROCESSOR] Completed thinking block with ${tagType}: ${this.currentThinkingBlock.content.length} chars`);
            }
            
            // Continue with normal content
            this.buffer = this.buffer.slice(endIndex + tagLength);
            this.state = 'normal';
            this.currentThinkingBlock = null;
            
            // Immediately process any remaining content as a chat block
            if (this.buffer.trim()) {
                logger.debug(`[PROCESSOR] Processing remaining content after thinking: "${this.buffer.trim().substring(0, 50)}..."`);
                // Continue processing the remaining buffer in normal state
                return true; // This will cause processBuffer to continue and handle the remaining content
            }
            
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