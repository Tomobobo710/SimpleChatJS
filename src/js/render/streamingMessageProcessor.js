// StreamingMessageProcessor.js - Creates blocks from streaming content (no rendering)

class StreamingMessageProcessor {
    constructor() {
        this.buffer = '';
        this.state = 'normal'; // 'normal', 'thinking', 'codeblock'
        this.blocks = [];
        this.currentThinkingBlock = null;
        this.currentCodeBlock = null; // Track current streaming code block
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
        // Check if buffer ends with a potential partial tag/backticks - if so, wait for next chunk
        const partialTags = [
            // Opening tag partials
            '<', '<t', '<th', '<thi', '<thin', '<think', '<thinki', '<thinkin', '<thinking',
            // Closing tag partials  
            '</', '</t', '</th', '</thi', '</thin', '</think', '</thinki', '</thinkin', '</thinking',
            // Code block partials
            '`', '``'
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
            // Check for both thinking and code block starts
            return this.checkForThinkingStart() || this.checkForCodeBlockStart();
        } else if (this.state === 'thinking') {
            return this.checkForThinkingEnd();
        } else if (this.state === 'codeblock') {
            return this.checkForCodeBlockEnd();
        }
        return false;
    }
    
    checkForCodeBlockStart() {
        // Look for triple backticks (```)
        const codeStartIndex = this.buffer.indexOf('```');
        
        if (codeStartIndex !== -1) {
            // Look for language identifier after the backticks
            const afterBackticks = this.buffer.slice(codeStartIndex + 3);
            const newlineIndex = afterBackticks.indexOf('\n');
            
            // If we found backticks but no newline yet, wait for more content
            // (unless the buffer doesn't look like it will have a language)
            if (newlineIndex === -1) {
                // Check if we have enough content to determine there's no language
                // If we have spaces or non-word chars right after ```, then no language
                const immediateChar = afterBackticks[0];
                if (immediateChar && !/\w/.test(immediateChar)) {
                    // No language, proceed with code block creation
                } else if (afterBackticks.length < 20) {
                    // Wait for more content - might be streaming language identifier
                    return false;
                }
            }
            
            // Create chat block for any content before code block
            if (codeStartIndex > 0) {
                const contentBefore = this.buffer.slice(0, codeStartIndex);
                if (contentBefore) {
                    this.createChatBlock(contentBefore);
                }
            }
            
            let language = '';
            let startOfCode = codeStartIndex + 3;
            
            if (newlineIndex !== -1) {
                // Extract potential language identifier
                const potentialLang = afterBackticks.slice(0, newlineIndex).trim();
                if (potentialLang && /^\w+$/.test(potentialLang)) {
                    language = potentialLang;
                    startOfCode = codeStartIndex + 3 + newlineIndex + 1; // Skip past language and newline
                } else {
                    startOfCode = codeStartIndex + 3; // No language, start right after backticks
                }
            } else {
                // No newline found, but we're proceeding anyway
                startOfCode = codeStartIndex + 3;
            }
            
            // Create a live streaming code block
            const codeBlock = {
                type: 'codeblock',
                content: '',
                metadata: { 
                    id: `code_${Date.now()}`,
                    isStreaming: true,
                    language: language
                }
            };
            
            logger.debug(`[PROCESSOR] CODE BLOCK CREATED with language: "${language}" from buffer: "${afterBackticks.slice(0, 20)}..."`);
            this.blocks.push(codeBlock);
            this.currentCodeBlock = codeBlock;
            
            // Switch to code block state and update buffer
            this.buffer = this.buffer.slice(startOfCode);
            this.state = 'codeblock';
            logger.debug(`[PROCESSOR] CODE BLOCK STARTED${language ? ` (${language})` : ''}! Total blocks: ${this.blocks.length}`);
            return true;
        }
        return false;
    }
    
    checkForCodeBlockEnd() {
        // Look for closing triple backticks
        const codeEndIndex = this.buffer.indexOf('```');
        
        if (codeEndIndex !== -1) {
            // Update the existing code block with final content
            const codeContent = this.buffer.slice(0, codeEndIndex);
            
            if (this.currentCodeBlock) {
                this.currentCodeBlock.content += codeContent;
                this.currentCodeBlock.metadata.isStreaming = false;
                logger.debug(`[PROCESSOR] Completed code block: ${this.currentCodeBlock.content.length} chars`);
            }
            
            // Continue with normal content after the closing backticks
            this.buffer = this.buffer.slice(codeEndIndex + 3);
            this.state = 'normal';
            this.currentCodeBlock = null;
            
            // Process any remaining content
            if (this.buffer) {
                logger.debug(`[PROCESSOR] Processing remaining content after code block`);
                return true; // Continue processing
            }
            
            return true;
        } else {
            // Still in code block, accumulate content and update live
            if (this.currentCodeBlock) {
                this.currentCodeBlock.content += this.buffer;
                logger.debug(`[PROCESSOR] Updating code content: ${this.currentCodeBlock.content.length} chars`);
            }
            
            this.buffer = '';
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
                const contentBefore = this.buffer.slice(0, startIndex);
                if (contentBefore) { // Don't trim - preserve whitespace
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
        if (content) { // Don't check for trimmed content - preserve whitespace
            const block = {
                type: 'chat',
                content: content, // Don't trim - preserve whitespace
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
        } else if (this.state === 'codeblock') {
            // Update existing code block if we have one (incomplete code block)
            if (this.currentCodeBlock) {
                this.currentCodeBlock.content += this.buffer;
                this.currentCodeBlock.metadata.isStreaming = false;
                logger.debug(`[PROCESSOR] Finalized incomplete code block`);
            }
        } else if (this.state === 'normal') {
            // Create chat block for any remaining normal content
            if (this.buffer) { // Don't trim check - preserve whitespace
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
    
    // Get current state (for live rendering)
    getState() {
        return this.state;
    }
    
    // Get current buffer (for live rendering)
    getBuffer() {
        return this.buffer;
    }
}