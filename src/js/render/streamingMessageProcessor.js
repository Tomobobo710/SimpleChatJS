// StreamingMessageProcessor.js - Creates blocks from streaming content (no rendering)

class StreamingMessageProcessor {
    constructor() {
        this.buffer = '';
        this.state = 'normal'; // 'normal', 'thinking', 'tool'
        this.blocks = [];
        this.currentBlockContent = '';
        this.currentBlockType = 'chat';
        this.currentThinkingBlock = null;
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
            // Save any content before <think> as a chat block
            if (thinkStartIndex > 0) {
                const contentBefore = this.buffer.slice(0, thinkStartIndex).trim();
                if (contentBefore) {
                    this.finalizeCurrentBlock(contentBefore, 'chat');
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
            
            // Start new thinking block tracking
            this.startNewBlock('thinking');
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
            this.currentBlockContent += thinkingContent;
            
            if (this.currentThinkingBlock) {
                this.currentThinkingBlock.content = this.currentBlockContent.trim();
                this.currentThinkingBlock.metadata.isStreaming = false;
                logger.debug(`[PROCESSOR] Completed thinking block: ${this.currentBlockContent.length} chars`);
            }
            
            // Continue with normal content
            this.buffer = this.buffer.slice(thinkEndIndex + 8); // Remove '</think>'
            this.startNewBlock('chat');
            this.state = 'normal';
            this.currentThinkingBlock = null;
            return true;
        } else {
            // Still in thinking block, accumulate content and update live
            this.currentBlockContent += this.buffer;
            
            if (this.currentThinkingBlock) {
                this.currentThinkingBlock.content = this.currentBlockContent.trim();
                logger.debug(`[PROCESSOR] Updating thinking content: ${this.currentBlockContent.length} chars`);
            }
            
            this.buffer = '';
        }
        return false;
    }
    
    checkForToolStart() {
        const toolStartIndex = this.buffer.indexOf('[Executing tools...]');
        if (toolStartIndex !== -1) {
            // Save any content before tool marker as a chat block
            if (toolStartIndex > 0) {
                const contentBefore = this.buffer.slice(0, toolStartIndex).trim();
                if (contentBefore) {
                    this.finalizeCurrentBlock(contentBefore, 'chat');
                }
            }
            
            // Start tool block
            this.startNewBlock('tool');
            this.buffer = this.buffer.slice(toolStartIndex + 20); // Remove '[Executing tools...]'
            this.state = 'tool';
            return true;
        }
        return false;
    }
    
    checkForToolEnd() {
        const toolEndIndex = this.buffer.indexOf('[Tools completed]');
        if (toolEndIndex !== -1) {
            // Finalize tool block
            const toolContent = this.buffer.slice(0, toolEndIndex);
            this.currentBlockContent += toolContent;
            this.finalizeCurrentBlock(this.currentBlockContent, 'tool');
            
            // Continue with normal content
            this.buffer = this.buffer.slice(toolEndIndex + 17); // Remove '[Tools completed]'
            this.startNewBlock('chat');
            this.state = 'normal';
            return true;
        } else {
            // Still in tool section, accumulate content
            this.currentBlockContent += this.buffer;
            this.buffer = '';
        }
        return false;
    }
    
    startNewBlock(type) {
        this.currentBlockType = type;
        this.currentBlockContent = '';
    }
    
    finalizeCurrentBlock(content, type) {
        if (content.trim()) {
            const block = {
                type: type,
                content: content.trim(),
                metadata: this.extractMetadata(content, type)
            };
            this.blocks.push(block);
            logger.debug(`[PROCESSOR] Created ${type} block: ${content.length} chars`);
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
        
        // Handle any remaining content
        if (this.state === 'thinking' && this.currentBlockContent.trim()) {
            // DON'T create a new thinking block - we already have one!
            // Just make sure the existing thinking block has the final content
            if (this.currentThinkingBlock) {
                this.currentThinkingBlock.content = this.currentBlockContent.trim();
                this.currentThinkingBlock.metadata.isStreaming = false;
                logger.debug(`[PROCESSOR] Updated existing thinking block instead of creating duplicate`);
            }
        } else if (this.state === 'tool' && this.currentBlockContent.trim()) {
            this.finalizeCurrentBlock(this.currentBlockContent, 'tool');
        } else if (this.state === 'normal' && this.buffer.trim()) {
            this.finalizeCurrentBlock(this.buffer, 'chat');
        }
        
        // Add any accumulated current block content
        if (this.currentBlockContent.trim() && this.state === 'normal') {
            this.finalizeCurrentBlock(this.currentBlockContent, 'chat');
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