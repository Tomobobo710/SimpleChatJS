// Sequential HTTP Debug Panel - Shows REAL HTTP request/response pairs
class SequentialDebugPanel {
    constructor() {
        this.container = null;
    }

    render(debugData) {
        if (!debugData || !debugData.httpSequence) {
            return '<div class="debug-panel"><p>No sequential HTTP data available</p></div>';
        }

        let content = '<div class="debug-panel">';
        content += '<h3>Sequential HTTP Debug</h3>';
        content += '<div class="debug-note">Real HTTP requests/responses as they happened</div>';
        
        // Group requests and responses in pairs
        const requests = debugData.httpSequence.filter(item => item.type === 'http_request');
        const responses = debugData.httpSequence.filter(item => item.type === 'http_response');
        
        for (let i = 0; i < Math.max(requests.length, responses.length); i++) {
            const request = requests[i];
            const response = responses[i];
            
            content += `<div class="http-pair">`;
            content += `<h4>HTTP Interaction #${i + 1}</h4>`;
            
            // Show request
            if (request) {
                content += `
                    <div class="debug-section">
                        <div class="debug-section-title">→ REQUEST #${i + 1}</div>
                        <div class="debug-timestamp">${request.timestamp}</div>
                        ${this.createDropdown('Raw HTTP Request JSON', JSON.stringify(request.payload, null, 2))}
                        ${this.createDropdown('Messages in Request', this.formatMessages(request.payload.messages))}
                    </div>
                `;
            }
            
            // Show response
            if (response) {
                const toolCallsInfo = response.hasToolCalls ? ` (${response.toolCalls.length} tool calls)` : '';
                content += `
                    <div class="debug-section">
                        <div class="debug-section-title">← RESPONSE #${i + 1}${toolCallsInfo}</div>
                        <div class="debug-timestamp">${response.timestamp}</div>
                        ${this.createDropdown('Response Content', response.content || 'No content')}
                        ${response.hasToolCalls ? this.createDropdown('Tool Calls', JSON.stringify(response.toolCalls, null, 2)) : ''}
                    </div>
                `;
            }
            
            content += `</div>`;  // Close http-pair
        }
        
        content += '</div>';  // Close debug-panel
        return content;
    }
    
    formatMessages(messages) {
        if (!messages || !Array.isArray(messages)) {
            return 'No messages';
        }
        
        return messages.map((msg, index) => {
            const hasThinkTags = msg.content && msg.content.includes('<think>');
            const thinkWarning = hasThinkTags ? ' HAS THINK TAGS' : '';
            return `Message ${index + 1} (${msg.role})${thinkWarning}:\n${msg.content || 'No content'}\n`;
        }).join('\n---\n');
    }
    
    createDropdown(title, content, isExpanded = false, contentType = 'text') {
        const expandedClass = isExpanded ? 'expanded' : '';
        const displayStyle = isExpanded ? 'block' : 'none';
        
        return `
            <div class="debug-dropdown ${expandedClass}" data-content-type="${contentType}">
                <div class="debug-dropdown-header" onclick="toggleDebugDropdown(this)">
                    <span class="dropdown-icon">▶</span>
                    <span class="dropdown-title">${title}</span>
                </div>
                <div class="debug-dropdown-content" style="display: ${displayStyle}">
                    <pre>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                </div>
            </div>
        `;
    }
}

// Create debug panel content
function createDebugPanelContent(debugData) {
    const panel = new SequentialDebugPanel();
    return panel.render(debugData);
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createDebugPanelContent
    };
}
// Toggle debug dropdown function
function toggleDebugDropdown(headerElement) {
    const dropdown = headerElement.parentNode;
    const content = dropdown.querySelector('.debug-dropdown-content');
    const icon = headerElement.querySelector('.dropdown-icon');
    
    if (dropdown && content && icon) {
        const isExpanded = dropdown.classList.contains('expanded');
        
        // Toggle class and display
        dropdown.classList.toggle('expanded');
        content.style.display = isExpanded ? 'none' : 'block';
        icon.textContent = isExpanded ? '▶' : '▼';
    }
}