// Streaming Dropdowns System
// Handles real-time parsing and rendering of thinking blocks and tool calls

// Enable debugging with: window.debugToolFormatting = true
window.debugToolFormatting = false;

// Parse a tool name into its display parts. MCP tools are namespaced by the
// backend as mcp__<server>__<tool>; SimpleTools use a bare name.
// Returns { isMcp, serverName, toolName }.
function parseMcpToolName(name) {
    if (typeof name === 'string' && name.startsWith('mcp__')) {
        const rest = name.slice('mcp__'.length);
        const sep = rest.indexOf('__');
        if (sep !== -1) {
            return {
                isMcp: true,
                serverName: rest.slice(0, sep),
                toolName: rest.slice(sep + 2)
            };
        }
    }
    return { isMcp: false, serverName: null, toolName: name };
}

// Unified tool formatting function
function formatToolContent(content, toolName = null, toolArgs = null) {
    // Debug: log the content we're trying to parse
    if (window.debugToolFormatting) {
        logger.debug('formatToolContent input:', { content, toolName, toolArgs });
    }
    
    // Extract tool name and arguments from content if not provided
    if (!toolName || !toolArgs) {
        // Look for patterns like "[tool_name]:"
        const toolMatch = content.match(/^\[(\w+)\]:/m);
        if (toolMatch) {
            toolName = toolMatch[1];
        }
        
        // Extract JSON arguments from "Arguments: {...}" pattern
        // Match both complete JSON ({...}) and partial JSON (no closing } yet)
        const argsMatch = content.match(/Arguments?:\s*(\{[\s\S]*?)(?=\s*\n(?:Result:|\[)|$)/i);
        if (argsMatch) {
            if (window.debugToolFormatting) {
                logger.debug('Found arguments match:', argsMatch[1]);
            }
            try {
                toolArgs = JSON.parse(argsMatch[1]);
            } catch (e) {
                if (window.debugToolFormatting) {
                    logger.warn('Failed to parse arguments JSON (partial streaming):', e);
                }
                toolArgs = argsMatch[1].trim();
            }
        }
        
        if (window.debugToolFormatting && (!toolName || !toolArgs)) {
            logger.debug('No tool/arguments match found in content:', content);
        }
    }
    
    // Format with Arguments and Result sections
    let formattedContent = '';
    
    // Always show Arguments section (even if empty)
    if (toolArgs !== null && toolArgs !== undefined) {
        if (typeof toolArgs === 'string') {
            // Partial/incomplete JSON during streaming - show raw text
            formattedContent += `<div class="tool-section"><div class="tool-section-title">Arguments</div><pre class="tool-content">${escapeHtml(toolArgs)}</pre></div>`;
        } else {
            formattedContent += `<div class="tool-section"><div class="tool-section-title">Arguments</div><pre class="tool-content">${JSON.stringify(toolArgs, null, 2)}</pre></div>`;
        }
    } else {
        // If no arguments found, show empty object
        formattedContent += `<div class="tool-section"><div class="tool-section-title">Arguments</div><pre class="tool-content">{}</pre></div>`;
    }
    
    // Extract the result part from "Result: ..." pattern
    let resultContent = content;
    
    const resultMatch = content.match(/Result:\s*([\s\S]+?)(?=\n\[|$)/i);
    if (resultMatch) {
        resultContent = resultMatch[1].trim();
    } else {
        // Remove everything before Result: and clean up
        resultContent = resultContent.replace(new RegExp(`^\\[${toolName}\\]:[\s\S]*?(?=Result:|$)`, 'm'), '');
        resultContent = resultContent.replace(/^Result:\s*/m, '');
        resultContent = resultContent.trim();
    }
    
    if (resultContent) {
        let resultDisplay = resultContent;
        try {
            let parsed = JSON.parse(resultContent);
            
            // If content is a JSON string, parse it too
            if (parsed.content && typeof parsed.content === 'string') {
                try {
                    parsed.content = JSON.parse(parsed.content);
                } catch (e) {
                    // Keep as string if not valid JSON
                }
            }
            
            // Deep unescape: convert escape sequences in all string values
            const deepUnescape = (obj) => {
                if (typeof obj === 'string') {
                    return obj
                        .replace(/\\n/g, '\n')
                        .replace(/\\t/g, '\t')
                        .replace(/\\r/g, '\r');
                } else if (Array.isArray(obj)) {
                    return obj.map(deepUnescape);
                } else if (obj !== null && typeof obj === 'object') {
                    const result = {};
                    for (const [key, value] of Object.entries(obj)) {
                        result[key] = deepUnescape(value);
                    }
                    return result;
                }
                return obj;
            };
            
            parsed = deepUnescape(parsed);
            
            // Format as readable text WITHOUT re-escaping
            const formatValue = (val, indent = 0) => {
                const spaces = '  '.repeat(indent);
                const nextSpaces = '  '.repeat(indent + 1);
                if (typeof val === 'string') {
                    // If string contains newlines, indent each line after the first
                    if (val.includes('\n')) {
                        const lines = val.split('\n');
                        return '"' + lines.join('\n' + nextSpaces) + '"';
                    }
                    return `"${val}"`;
                } else if (Array.isArray(val)) {
                    if (val.length === 0) return '[]';
                    return '[\n' + val.map(v => nextSpaces + formatValue(v, indent + 1)).join(',\n') + '\n' + spaces + ']';
                } else if (val !== null && typeof val === 'object') {
                    const keys = Object.keys(val);
                    if (keys.length === 0) return '{}';
                    return '{\n' + keys.map(k => nextSpaces + '"' + k + '": ' + formatValue(val[k], indent + 1)).join(',\n') + '\n' + spaces + '}';
                } else {
                    return String(val);
                }
            };
            
            resultDisplay = formatValue(parsed, 0);
        } catch (e) {
            // Not valid JSON, use as-is
            resultDisplay = resultContent;
        }
        formattedContent += `<div class="tool-section"><div class="tool-section-title">Result</div><pre class="tool-content">${escapeHtml(resultDisplay)}</pre></div>`;
    }
    
    const result = formattedContent || '<em>No tool output available</em>';
    
    if (window.debugToolFormatting) {
        logger.debug('formatToolContent output:', { toolName, toolArgs, result });
    }
    
    return result;
}

// (Thinking/streaming content now renders through renderThinkingInto in chatRenderer.js —
// one append-only segment renderer shared by live + reload, reusing renderStreamingCode for
// code fences. The old full-rebuild formatStreamingContent was removed.)

class StreamingDropdown {
    constructor(id, title, type, isCollapsed = true, badge = null) {
        this.id = id;
        this.title = title;
        this.type = type; // 'thinking' or 'tool'
        this.isCollapsed = isCollapsed;
        this.badge = badge; // optional { text, title } rendered right-aligned in the header
        this.content = '';
        this.element = this.createElement();
    }
    
    createElement() {
        const wrapper = document.createElement('details');
        wrapper.className = `streaming-dropdown ${this.type}-dropdown`;
        // Expanded state is the .dd-open class (drives the resting height + chevron in
        // turns.css); the native `open` attribute is kept in sync for semantics. Set
        // both up-front when starting open so it renders expanded with no animation.
        if (!this.isCollapsed) { wrapper.open = true; wrapper.classList.add('dd-open'); }
        const badgeHtml = this.badge
            ? `<span class="dropdown-badge" title="${escapeHtml(this.badge.title || '')}">${escapeHtml(this.badge.text)}</span>`
            : '';
        // .dropdown-clip (overflow:hidden) is the element whose pixel height is tweened
        // open/closed by toggleOpen(). .dropdown-content / .dropdown-inner keep all
        // their styling.
        wrapper.innerHTML = `
            <summary class="dropdown-toggle">
                <span class="dropdown-title">${this.title}</span>
                ${badgeHtml}
            </summary>
            <div class="dropdown-clip">
                <div class="dropdown-content">
                    <div class="dropdown-inner" id="dropdown-content-${this.id}"></div>
                </div>
            </div>
        `;

        // Drive open/close ourselves: the native summary-click toggle applies the open
        // state without running a transition (it snaps), so we intercept it and animate
        // the clip height via the Web Animations API instead.
        wrapper.querySelector('.dropdown-toggle').addEventListener('click', (e) => {
            e.preventDefault();
            this._userToggled = true;   // user's choice wins over the auto-collapse policy
            this.toggleOpen(wrapper);
        });

        wrapper.addEventListener('toggle', () => {
            this.isCollapsed = !wrapper.open;
        });

        // Stick the (internally-scrolling) body to its bottom while content streams.
        // Defaults to true so a freshly-opened dropdown follows from the start; the
        // user scrolling up within it pauses the follow, returning to the bottom
        // resumes it (mirrors the page-level isUserAtBottom rule). Inferring this from
        // the initial scroll position fails — a fresh scroller starts at the top.
        this._stickToBottom = true;
        const scroller = wrapper.querySelector('.dropdown-content');
        const inner = wrapper.querySelector('.dropdown-inner');
        if (scroller) {
            // Direction-aware, same as the page-level tracker (utils.js): a plain
            // position check races against fast streaming growth and wrongly pauses.
            // Only an actual upward scroll disarms the follow; reaching bottom re-arms.
            let lastTop = 0, lastH = 0;
            scroller.addEventListener('scroll', () => {
                const st = scroller.scrollTop, sh = scroller.scrollHeight;
                const atBottom = sh - st - scroller.clientHeight < 30;
                const shrank = sh < lastH - 1;
                if (!shrank && st < lastTop - 2) this._stickToBottom = false;
                else if (atBottom) this._stickToBottom = true;
                lastTop = st; lastH = sh;
            });
            // Follow streaming content by watching the inner body's SIZE rather than
            // hooking the writes. Live tool streaming sets .dropdown-inner.innerHTML
            // directly (liveRenderer.js) and never calls updateDisplay(), so a
            // write-hook misses it; a ResizeObserver catches every growth path. Gated
            // on _stickToBottom so scrolling up to read pauses the follow.
            if (inner && typeof ResizeObserver !== 'undefined') {
                const obs = new ResizeObserver(() => {
                    // Only follow an OPEN dropdown that's actively growing. Collapsed
                    // dropdowns (incl. replayed history) are left untouched, so opening
                    // a finished tool later starts at the top to read, not the bottom.
                    if (this._stickToBottom && !this.isCollapsed) {
                        scroller.scrollTop = scroller.scrollHeight;
                    }
                });
                obs.observe(inner);
            }
        }

        wrapper._streamingDropdownInstance = this;

        return wrapper;
    }

    // Animate the dropdown open/closed by tweening the clip's pixel height (Web
    // Animations API). The .dd-open class holds the resting state (height auto vs 0)
    // and flips the chevron; `open` tracks semantics. Honors prefers-reduced-motion.
    toggleOpen(wrapper) {
        const clip = wrapper.querySelector('.dropdown-clip');
        if (!clip) return;
        if (this._anim) { this._anim.cancel(); this._anim = null; }
        const opening = !wrapper.classList.contains('dd-open');
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const opts = { duration: 180, easing: 'ease' };

        if (opening) {
            wrapper.open = true;
            this.isCollapsed = false;
            const target = clip.scrollHeight;       // full content height (clip is overflow:hidden)
            wrapper.classList.add('dd-open');        // resting height = auto
            if (reduce || !clip.animate) return;
            this._anim = clip.animate([{ height: '0px' }, { height: target + 'px' }], opts);
            this._anim.onfinish = this._anim.oncancel = () => { this._anim = null; };
        } else {
            const start = clip.scrollHeight;
            this.isCollapsed = true;
            wrapper.classList.remove('dd-open');     // resting height = 0
            if (reduce || !clip.animate) { wrapper.open = false; return; }
            this._anim = clip.animate([{ height: start + 'px' }, { height: '0px' }], opts);
            // Drop native open only once the collapse finishes (keeps content rendered
            // during the slide); skip if a re-open cancelled us.
            this._anim.onfinish = () => { this._anim = null; wrapper.open = false; };
            this._anim.oncancel = () => { this._anim = null; };
        }
    }

    // Auto-collapse this dropdown N seconds after the tool finishes, per the per-tool
    // display settings. Auto-EXPAND-while-executing is handled at creation (renderToolBlock
    // opens it for an executing tool); here we just schedule the close. No-op once the
    // user has toggled it, if already armed, or if the tool isn't done yet.
    maybeAutoCollapse(toolName, status) {
        if (this._userToggled || this._autoCollapseArmed) return;
        if (status !== 'success' && status !== 'error') return;
        const opts = getToolDisplaySettings(toolName);
        if (!opts.autoCollapse) return;
        this._autoCollapseArmed = true;
        setTimeout(() => {
            if (this._userToggled) return;
            if (this.element.classList.contains('dd-open')) this.toggleOpen(this.element);
        }, opts.autoCollapseSec * 1000);
    }

    appendContent(newContent) {
        this.content += newContent;
        this.updateDisplay();
    }
    
    setContent(content) {
        this.content = content;
        this.updateDisplay();
    }
    
    updateDisplay() {
        const contentDiv = this.element.querySelector(`#dropdown-content-${this.id}`);
        if (contentDiv) {
            if (!this.content.trim()) {
                contentDiv.innerHTML = '<em>No content yet...</em>';
            } else if (this.type === 'thinking') {
                // Same incremental segment renderer the live path uses (one code-block
                // renderer everywhere). For a finished/reloaded block it just renders all
                // segments once.
                renderThinkingInto(contentDiv, this.content);
            } else if (this.content.includes('<div class="tool-section">')) {
                // Content is already formatted HTML (from formatToolContent)
                contentDiv.innerHTML = this.content;
            } else {
                // Raw content - apply normal formatting
                contentDiv.innerHTML = formatMessage(escapeHtml(this.content));
            }

            // The dropdown body scrolls internally (max-height + overflow), so the
            // page-level auto-scroll can't reveal streaming content once it's capped.
            // Follow it here unless the user scrolled up within the dropdown.
            const scroller = this.element.querySelector('.dropdown-content');
            if (this._stickToBottom && scroller) scroller.scrollTop = scroller.scrollHeight;
        }
    }
    
}


