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
                // Live rendering is always a streaming RESPONSE — tag blocks accordingly
                // so chat blocks get response-only blank-line collapsing.
                const newElement = liveRenderer.renderBlock(currentBlock, false, 'response');
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
                    if (currentBlock.metadata?.toolName === 'shell_run' || currentBlock.metadata?.isShellConsole) {
                        // Live shell console: append to the terminal body in place.
                        updateShellConsoleElement(blockElement, currentBlock.metadata || {});
                    } else if (currentBlock.metadata?.toolName === 'edit_file') {
                        // Live edit diff: re-render the diff body in place as args/result arrive.
                        updateEditDiffElement(blockElement, currentBlock.metadata || {});
                    } else if (currentBlock.metadata?.toolName === 'read_file' || currentBlock.metadata?.toolName === 'write_file') {
                        // Live file view: write_file streams its content in; read_file fills on result.
                        updateFileViewElement(blockElement, currentBlock.metadata || {}, currentBlock.metadata.toolName);
                    } else {
                        const dropdownInner = blockElement.querySelector('.dropdown-inner');
                        if (dropdownInner) {
                            const formattedContent = formatToolContent(currentBlock.content, currentBlock.metadata?.toolName);
                            dropdownInner.innerHTML = formattedContent;
                        }
                        // Arm auto-collapse once the tool finishes (per display settings).
                        const inst = blockElement._streamingDropdownInstance;
                        if (inst && inst.maybeAutoCollapse) {
                            inst.maybeAutoCollapse(currentBlock.metadata?.toolName, currentBlock.metadata?.status);
                        }
                    }
                } else if (currentBlock.type === 'thinking') {
                    // Incremental, append-only thinking render — prose + code segments, with
                    // code going through the SAME renderStreamingCode the main blocks use.
                    const dropdownInner = blockElement.querySelector('.dropdown-inner');
                    if (dropdownInner) renderThinkingInto(dropdownInner, currentBlock.content);
                } else if (currentBlock.type === 'codeblock') {
                    // The language label tab may not have existed at first render
                    // (``` streams a beat before the language word). Add/sync it now
                    // that the language is known.
                    const blockLang = currentBlock.metadata.language;
                    if (blockLang) {
                        blockElement.classList.add('has-lang');
                        let langLabel = blockElement.querySelector('.code-lang');
                        if (!langLabel) {
                            langLabel = document.createElement('div');
                            langLabel.className = 'code-lang';
                            langLabel.textContent = blockLang;
                            // Insert at the very top — BEFORE the copy wrap — so the
                            // order is [lang, copyWrap, pre], matching renderCodeBlock.
                            // That keeps the copy button inside the code body below the
                            // tab; inserting before the <pre> instead would leave the
                            // wrap as the first child and push the button above the tab.
                            const anchor = blockElement.querySelector('.code-copy-wrap')
                                || blockElement.querySelector('pre');
                            blockElement.insertBefore(langLabel, anchor);
                        } else if (langLabel.textContent !== blockLang) {
                            langLabel.textContent = blockLang;
                        }
                    }
                    // Update live streaming code block via the shared append-only renderer
                    // (same one thinking code blocks use). O(n): appends only new lines.
                    const codeElement = blockElement.querySelector('code');
                    if (codeElement) {
                        renderStreamingCode(codeElement, currentBlock.content, currentBlock.metadata.language, currentBlock.metadata.isStreaming);
                    }
                } else {
                    // Regular chat block — live is always a response, so collapse blank lines.
                    blockElement.innerHTML = formatMessage(escapeHtml(collapseResponseBlankLines(currentBlock.content)));
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
            const blockElement = liveRenderer.renderBlock(blockData, false, 'response');
            tempContainer.appendChild(blockElement);
            tempContainer._renderedBlocks.push({ ...blockData });
            tempContainer._blockElements.push(blockElement);
        });
    }
    
}