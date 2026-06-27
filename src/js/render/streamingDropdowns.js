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

// Format content with streaming code block support.
// Renders completed code fences as formatted code blocks,
// open (streaming) fences as code blocks with a blinking cursor.
function formatStreamingContent(content) {
    const regex = /```(\w*)\r?\n?/g;
    let lastIndex = 0;
    let match;
    let html = '';

    while ((match = regex.exec(content)) !== null) {
        const textBefore = content.slice(lastIndex, match.index);
        if (textBefore.trim()) {
            html += formatMessage(escapeHtml(textBefore));
        }

        const lang = match[1];
        const rest = content.slice(match.index + match[0].length);

        // ponytail: prefer \n before closing fence (standard markdown),
        // fallback matches ``` anywhere for models that omit the preceding newline
        const closeMatch = rest.match(/\n```/) || rest.match(/```/);
        if (closeMatch) {
            const fenceLen = closeMatch[0].length;
            const codeContent = rest.slice(0, closeMatch.index);
            const langLabel = lang ? `<div class="code-lang">${lang}</div>` : '';
            const highlighted = window.SimpleSyntax ? SimpleSyntax.highlight(codeContent, lang) : escapeHtml(codeContent);
            html += `${langLabel}<pre><code class="language-${lang}">${highlighted}</code></pre>`;
            lastIndex = match.index + match[0].length + closeMatch.index + fenceLen;
            regex.lastIndex = lastIndex;
        } else {
            logger.debug(`[STREAMING-FMT] Open code fence (lang=${lang}), rest=${rest.slice(0, 80)}`);
            const langLabel = lang ? `<div class="code-lang">${lang}</div>` : '';
            const hl = window.SimpleSyntax ? SimpleSyntax.highlight(rest, lang) : escapeHtml(rest);
            html += `${langLabel}<pre><code class="streaming-code language-${lang}">${hl}<span class="code-cursor">|</span></code></pre>`;
            lastIndex = content.length;
            break;
        }
    }

    const remaining = content.slice(lastIndex);
    if (remaining.trim()) {
        html += formatMessage(escapeHtml(remaining));
    }

    return html || formatMessage(escapeHtml(content));
}

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
        if (!this.isCollapsed) wrapper.open = true;
        const badgeHtml = this.badge
            ? `<span class="dropdown-badge" title="${escapeHtml(this.badge.title || '')}">${escapeHtml(this.badge.text)}</span>`
            : '';
        wrapper.innerHTML = `
            <summary class="dropdown-toggle">
                <span class="dropdown-title">${this.title}</span>
                ${badgeHtml}
            </summary>
            <div class="dropdown-content">
                <div class="dropdown-inner" id="dropdown-content-${this.id}"></div>
            </div>
        `;
        
        wrapper.addEventListener('toggle', () => {
            this.isCollapsed = !wrapper.open;
        });
        
        wrapper._streamingDropdownInstance = this;
        
        return wrapper;
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
                contentDiv.innerHTML = formatStreamingContent(this.content);
            } else if (this.content.includes('<div class="tool-section">')) {
                // Content is already formatted HTML (from formatToolContent)
                contentDiv.innerHTML = this.content;
            } else {
                // Raw content - apply normal formatting
                contentDiv.innerHTML = formatMessage(escapeHtml(this.content));
            }
        }
    }
    
}


