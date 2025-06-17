// Streaming Dropdowns System
// Handles real-time parsing and rendering of thinking blocks and tool calls

// Enable debugging with: window.debugToolFormatting = true
window.debugToolFormatting = false;

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
        const argsMatch = content.match(/Arguments?:\s*({[\s\S]*?})(?=\s*\n(?:Result:|\[)|$)/i);
        if (argsMatch) {
            if (window.debugToolFormatting) {
                logger.debug('Found arguments match:', argsMatch[1]);
            }
            try {
                toolArgs = JSON.parse(argsMatch[1]);
            } catch (e) {
                if (window.debugToolFormatting) {
                    logger.warn('Failed to parse arguments JSON:', e);
                }
                toolArgs = { raw: argsMatch[1].trim() };
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
        formattedContent += `<div class="tool-section"><div class="tool-section-title">Arguments</div><pre class="tool-content">${JSON.stringify(toolArgs, null, 2)}</pre></div>`;
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
        resultContent = resultContent.replace(/\[Executing tools...\]|\[Tools completed\]/g, '').trim();
    }
    
    if (resultContent) {
        formattedContent += `<div class="tool-section"><div class="tool-section-title">Result</div><pre class="tool-content">${escapeHtml(resultContent)}</pre></div>`;
    }
    
    const result = formattedContent || '<em>No tool output available</em>';
    
    if (window.debugToolFormatting) {
        logger.debug('formatToolContent output:', { toolName, toolArgs, result });
    }
    
    return result;
}

class StreamingDropdown {
    constructor(id, title, type, isCollapsed = true) {
        this.id = id;
        this.title = title;
        this.type = type; // 'thinking' or 'tool'
        this.isCollapsed = isCollapsed;
        this.content = '';
        this.element = this.createElement();
    }
    
    createElement() {
        const wrapper = document.createElement('div');
        wrapper.className = `streaming-dropdown ${this.type}-dropdown`;
        wrapper.innerHTML = `
            <button class="dropdown-toggle ${this.isCollapsed ? 'collapsed' : 'expanded'}" data-dropdown="${this.id}">
                <span class="dropdown-arrow">${this.isCollapsed ? '▶' : '▼'}</span>
                <span class="dropdown-title">${this.title}</span>
            </button>
            <div class="dropdown-content" ${this.isCollapsed ? 'style="display: none;"' : ''}>
                <div class="dropdown-inner" id="dropdown-content-${this.id}"></div>
            </div>
        `;
        
        // Add click handler
        wrapper.querySelector('.dropdown-toggle').addEventListener('click', () => this.toggle());
        
        // Store reference to this instance on the DOM element for state restoration
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
            } else if (this.content.includes('<div class="tool-section">')) {
                // Content is already formatted HTML (from formatToolContent)
                contentDiv.innerHTML = this.content;
            } else {
                // Raw content - apply normal formatting
                contentDiv.innerHTML = formatMessage(escapeHtml(this.content));
            }
        }
    }
    
    toggle() {
        this.isCollapsed = !this.isCollapsed;
        const button = this.element.querySelector('.dropdown-toggle');
        const content = this.element.querySelector('.dropdown-content');
        const arrow = this.element.querySelector('.dropdown-arrow');
        
        if (button) {
            button.className = `dropdown-toggle ${this.isCollapsed ? 'collapsed' : 'expanded'}`;
        }
        if (content) {
            content.style.display = this.isCollapsed ? 'none' : 'block';
        }
        if (arrow) {
            arrow.textContent = this.isCollapsed ? '▶' : '▼';
        }
    }
}


