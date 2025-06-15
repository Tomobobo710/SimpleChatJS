// Block System - Modular content management

class Block {
    constructor(type, content, metadata = {}) {
        this.id = this.generateId();
        this.type = type; // 'chat', 'thinking', 'tool'
        this.content = content;
        this.metadata = metadata;
    }

    static create(type, content, metadata = {}) {
        return new Block(type, content, metadata);
    }

    // Convert between block types
    convertTo(newType) {
        if (this.type === newType) return this;
        
        let newContent = this.content;
        let newMetadata = { ...this.metadata };

        // Handle conversions
        if (this.type === 'thinking' && newType === 'chat') {
            // Remove <think> tags
            newContent = this.content.replace(/<\/?think>/g, '').trim();
        } else if (this.type === 'chat' && newType === 'thinking') {
            // Add <think> tags
            newContent = `<think>${this.content}</think>`;
        }
        
        return new Block(newType, newContent, newMetadata);
    }

    generateId() {
        return `block_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

class BlockManager {
    constructor(containerElement) {
        this.container = containerElement;
        this.blocks = [];
    }

    // Add a block
    addBlock(block) {
        this.blocks.push(block);
        return block;
    }

    // Create and add a block from content
    addContent(content, type = 'chat', metadata = {}) {
        const block = Block.create(type, content, metadata);
        return this.addBlock(block);
    }

    // Parse streaming content into blocks
    parseStreamingContent(content) {
        const blocks = [];
        let remaining = content;
        let lastIndex = 0;

        // Extract thinking blocks first
        const thinkingRegex = /<think>(.*?)<\/think>/gs;
        let match;
        
        // Reset regex
        thinkingRegex.lastIndex = 0;
        
        while ((match = thinkingRegex.exec(content)) !== null) {
            // Add content before thinking block
            if (match.index > lastIndex) {
                const beforeContent = content.slice(lastIndex, match.index).trim();
                if (beforeContent) {
                    blocks.push(Block.create('chat', beforeContent));
                }
            }

            // Add thinking block
            blocks.push(Block.create('thinking', match[1].trim()));
            lastIndex = thinkingRegex.lastIndex;
        }

        // Add remaining content after all thinking blocks
        if (lastIndex < content.length) {
            const afterContent = content.slice(lastIndex).trim();
            if (afterContent) {
                // Check for tool markers in remaining content
                if (afterContent.includes('[Executing tools...]') && afterContent.includes('[Tools completed]')) {
                    const toolRegex = /\[Executing tools...\](.*?)\[Tools completed\]/gs;
                    let toolMatch;
                    let toolLastIndex = 0;
                    
                    while ((toolMatch = toolRegex.exec(afterContent)) !== null) {
                        // Add content before tool
                        if (toolMatch.index > toolLastIndex) {
                            const beforeTool = afterContent.slice(toolLastIndex, toolMatch.index).trim();
                            if (beforeTool) {
                                blocks.push(Block.create('chat', beforeTool));
                            }
                        }
                        
                        // Add tool block
                        blocks.push(Block.create('tool', toolMatch[1].trim()));
                        toolLastIndex = toolRegex.lastIndex;
                    }
                    
                    // Add content after all tools
                    if (toolLastIndex < afterContent.length) {
                        const afterTools = afterContent.slice(toolLastIndex).trim();
                        if (afterTools) {
                            blocks.push(Block.create('chat', afterTools));
                        }
                    }
                } else {
                    blocks.push(Block.create('chat', afterContent));
                }
            }
        }

        return blocks.length > 0 ? blocks : [Block.create('chat', content)];
    }

    // Reorder blocks
    reorder(newOrder) {
        const reorderedBlocks = newOrder.map(index => this.blocks[index]).filter(Boolean);
        this.blocks = reorderedBlocks;
    }

    // Convert block type
    convertBlock(blockIndex, newType) {
        if (this.blocks[blockIndex]) {
            this.blocks[blockIndex] = this.blocks[blockIndex].convertTo(newType);
        }
    }

    // Get all content as a single string
    getAllContent() {
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
    
    // Get content without special markers (for UI display)
    getDisplayContent() {
        return this.blocks.map(block => block.content).join('\n\n');
    }
    
    // Clear all blocks
    clear() {
        this.blocks = [];
    }
    
    // Get block by ID
    getBlock(id) {
        return this.blocks.find(block => block.id === id);
    }

    // Remove block
    removeBlock(id) {
        this.blocks = this.blocks.filter(block => block.id !== id);
        this.render();
    }

    // Get blocks by type
    getBlocksByType(type) {
        return this.blocks.filter(block => block.type === type);
    }
    
    // Get content by type
    getContentByType(type) {
        return this.getBlocksByType(type).map(block => block.content).join('\n\n');
    }
    
    // Debug methods
    debugBlocks() {
        console.log('[BLOCKS] Current blocks:', this.blocks.map(block => ({
            id: block.id,
            type: block.type,
            contentLength: block.content.length,
            contentPreview: block.content.substring(0, 50) + (block.content.length > 50 ? '...' : '')
        })));
    }
}