// Live Renderer - Live rendering during streaming

// Update live rendering during streaming
function updateLiveRendering(processor, liveRenderer, tempContainer) {
    const P = window.Profiler;
    const liveStart = P.tstart();
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
        
        // If block content has changed (or codeblock streaming state / thinking
        // completion changed), update.
        const contentChanged = currentBlock.content !== renderedBlock.content;
        const streamingChanged = currentBlock.type === 'codeblock' && currentBlock.metadata?.isStreaming !== renderedBlock.metadata?.isStreaming;
        const thinkingCompletedChanged = currentBlock.type === 'thinking' && currentBlock.isComplete !== renderedBlock.isComplete;
        if (contentChanged || streamingChanged || thinkingCompletedChanged) {
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
                    // Arm auto-collapse.
                    const inst = blockElement._streamingDropdownInstance;
                    if (inst && typeof armThinkingCollapse === 'function') {
                        armThinkingCollapse(inst, { isComplete: currentBlock.isComplete, thinkingDoneAt: currentBlock.thinkingDoneAt });
                    }
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
                    // Regular chat block - live is always a response, so collapse blank lines.
                    // Preserve table cell hover across innerHTML replacement: the full rebuild
                    // destroys the hovered cell's DOM node, losing :hover and causing flicker
                    // every token. Record the hovered cell's grid position, re-apply a
                    // .cell-hover class on the rebuilt cell so the highlight survives without
                    // a paint gap. A mousemove listener (added once) clears .cell-hover so
                    // :hover takes over naturally once the user moves the mouse.
                    var hoveredCell = blockElement.querySelector('.md-table td:hover, .md-table th:hover');
                    var hoverPos = null;
                    if (hoveredCell) {
                        var tr = hoveredCell.closest('tr');
                        var tbl = hoveredCell.closest('table');
                        if (tr && tbl) {
                            var allTables = blockElement.querySelectorAll('.md-table');
                            hoverPos = {
                                t: Array.prototype.indexOf.call(allTables, tbl),
                                r: Array.prototype.indexOf.call(tbl.querySelectorAll('tr'), tr),
                                c: Array.prototype.indexOf.call(tr.children, hoveredCell)
                            };
                        }
                    }
                    blockElement.innerHTML = formatMessage(escapeHtml(collapseResponseBlankLines(currentBlock.content)));
                    if (hoverPos) {
                        var allTables = blockElement.querySelectorAll('.md-table');
                        var tbl = allTables[hoverPos.t];
                        if (tbl) {
                            var rows = tbl.querySelectorAll('tr');
                            if (rows[hoverPos.r] && rows[hoverPos.r].children[hoverPos.c]) {
                                rows[hoverPos.r].children[hoverPos.c].classList.add('cell-hover');
                            }
                        }
                    }
                    if (!blockElement._cellHoverCleanup) {
                        blockElement._cellHoverCleanup = true;
                        blockElement.addEventListener('mousemove', function() {
                            var cells = blockElement.querySelectorAll('.cell-hover');
                            for (var i = 0; i < cells.length; i++) cells[i].classList.remove('cell-hover');
                        });
                    }
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
    
    // Per-call cost of the live streaming renderer (called once per SSE chunk).
    P.timing('live.frameRender', P.tend(liveStart));
}