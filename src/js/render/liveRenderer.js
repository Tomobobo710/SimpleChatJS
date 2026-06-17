// Live Renderer - Live rendering during streaming

// Update live rendering during streaming
function updateLiveRendering(processor, liveRenderer, tempContainer) {
    const currentBlocks = processor.getBlocks();
    logger.debug(`[LIVE-RENDER] Called with ${currentBlocks.length} blocks: ${currentBlocks.map(b => b.type).join(', ')}`);
    
    // Track rendered blocks to avoid recreating them
    if (!tempContainer._renderedBlocks) {
        tempContainer._renderedBlocks = [];
    }
    if (!tempContainer._blockElements) {
        tempContainer._blockElements = [];
    }
    
    const renderedCount = tempContainer._renderedBlocks.length;
    
    // Check for updates to existing blocks (content changes)
    for (let i = 0; i < Math.min(currentBlocks.length, renderedCount); i++) {
        const currentBlock = currentBlocks[i];
        const renderedBlock = tempContainer._renderedBlocks[i];
        
        // If block type changed, replace the entire element
        if (currentBlock.type !== renderedBlock.type) {
            const oldElement = tempContainer._blockElements[i];
            if (oldElement) {
                const newElement = liveRenderer.renderBlock(currentBlock);
                oldElement.replaceWith(newElement);
                tempContainer._blockElements[i] = newElement;
                tempContainer._renderedBlocks[i] = { ...currentBlock };
            }
            continue;
        }
        
        // If block content has changed (or codeblock streaming state changed), update
        const contentChanged = currentBlock.content !== renderedBlock.content;
        const streamingChanged = currentBlock.type === 'codeblock' && currentBlock.metadata?.isStreaming !== renderedBlock.metadata?.isStreaming;
        if (contentChanged || streamingChanged) {
            const blockElement = tempContainer._blockElements[i];
            if (blockElement) {
                logger.debug(`[LIVE-RENDER] Updating content for ${currentBlock.type} block ${i}`);
                
                // Update content without destroying the dropdown structure
                if (currentBlock.type === 'tool') {
                    const dropdownInner = blockElement.querySelector('.dropdown-inner');
                    if (dropdownInner) {
                        const formattedContent = formatToolContent(currentBlock.content, currentBlock.metadata?.toolName);
                        dropdownInner.innerHTML = formattedContent;
                    }
                } else if (currentBlock.type === 'thinking') {
                    const dropdownInner = blockElement.querySelector('.dropdown-inner');
                    if (dropdownInner) {
                        if (currentBlock.content.trim()) {
                            dropdownInner.innerHTML = formatStreamingContent(currentBlock.content);
                        } else {
                            dropdownInner.innerHTML = '<em>Thinking...</em>';
                        }
                    }
                } else if (currentBlock.type === 'codeblock') {
                    // Update live streaming code block
                    const codeElement = blockElement.querySelector('code');
                    if (codeElement) {
                        if (currentBlock.metadata.isStreaming) {
                            // Still streaming - show raw content with cursor
                            codeElement.innerHTML = escapeHtml(currentBlock.content) + '<span class="code-cursor">|</span>';
                        } else {
                            // Streaming finished - use SimpleSyntax highlighting
                            const language = currentBlock.metadata.language;
                            codeElement.className = `language-${language}`;
                            codeElement.innerHTML = window.SimpleSyntax ? SimpleSyntax.highlight(currentBlock.content, language) : escapeHtml(currentBlock.content);
                            logger.debug(`[LIVE-RENDER] Applied SimpleSyntax highlighting to finished code block`);
                            // Remove cursor when done
                            const cursor = codeElement.querySelector('.code-cursor');
                            if (cursor) cursor.remove();
                        }
                    }
                } else {
                    // Regular chat block
                    blockElement.innerHTML = formatMessage(escapeHtml(currentBlock.content));
                }
                
                // Update our tracked version
                tempContainer._renderedBlocks[i] = { ...currentBlock };
            }
        }
    }
    
    // Only add new blocks that haven't been rendered yet
    if (currentBlocks.length > renderedCount) {
        const newBlocks = currentBlocks.slice(renderedCount);
        logger.info(`[LIVE-RENDER] Adding ${newBlocks.length} new blocks`);
        
        newBlocks.forEach(blockData => {
            const blockElement = liveRenderer.renderBlock(blockData);
            tempContainer.appendChild(blockElement);
            tempContainer._renderedBlocks.push({ ...blockData });
            tempContainer._blockElements.push(blockElement);
        });
    }
    
}