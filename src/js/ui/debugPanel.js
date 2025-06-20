// Sequential HTTP Debug Panel - Shows REAL HTTP request/response pairs
class SequentialDebugPanel {
    constructor() {
        this.container = null;
    }

    render(debugData) {
        if (!debugData) {
            return '<div class="debug-panel"><p>No debug data available</p></div>';
        }
        
        // Handle user debug data (sequence format)
        if (debugData.sequence && !debugData.httpSequence) {
            return this.renderUserDebugData(debugData);
        }
        
        // Handle assistant debug data (httpSequence format)
        if (!debugData.httpSequence || !Array.isArray(debugData.httpSequence)) {
            return '<div class="debug-panel"><p>No sequential HTTP data available</p></div>';
        }

        let content = '<div class="debug-panel">';
        content += '<h3>Assistant HTTP Response Debug</h3>';
        content += '<div class="debug-note">AI responses and tool executions</div>';
        
        // Create unified timeline merging sequence and httpSequence by step numbers
        const unifiedTimeline = [];
        
        // Add sequence events (tool executions, tool results, etc.)
        if (debugData.sequence && Array.isArray(debugData.sequence)) {
            debugData.sequence.forEach(event => {
                unifiedTimeline.push({
                    ...event,
                    sortOrder: event.step || 0,
                    source: 'sequence'
                });
            });
        }
        
        // Add httpSequence events (HTTP requests/responses)
        if (debugData.httpSequence && Array.isArray(debugData.httpSequence)) {
            debugData.httpSequence.forEach(event => {
                unifiedTimeline.push({
                    ...event,
                    sortOrder: event.sequence || 0,
                    source: 'httpSequence'
                });
            });
        }
        
        // Sort by step/sequence number to show chronological order
        unifiedTimeline.sort((a, b) => a.sortOrder - b.sortOrder);
        
        // Filter out the initial HTTP response since user bubble shows the request for it
        // Assistant timeline should focus on what happens AFTER the initial AI response
        const filteredTimeline = unifiedTimeline.filter((event, index) => {
            // Skip the first HTTP response (that's just the response to user's request)
            if (event.type === 'http_response' && event.sortOrder === 1) {
                return false;
            }
            return true;
        });
        
        if (filteredTimeline.length > 0) {
            content += `<div class="unified-timeline-section">`;
            content += `<h4>AI Processing Timeline</h4>`;
            content += `<div class="debug-note">Tool executions and follow-up processing after initial AI response</div>`;
            
            filteredTimeline.forEach((event, i) => {
                // Handle different event types
                if (event.type === 'http_response') {
                    const toolCallsInfo = event.hasToolCalls ? ` (${event.toolCalls.length} tool calls)` : '';
                    content += `
                        <div class="debug-section timeline-item">
                            <div class="debug-section-title">STEP ${event.sortOrder}: AI HTTP RESPONSE${toolCallsInfo}</div>
                            <div class="debug-timestamp">${event.timestamp}</div>
                            ${this.createDropdown('Response Content', event.content || 'No content')}
                            ${event.hasToolCalls ? this.createDropdown('Tool Calls from AI', JSON.stringify(event.toolCalls, null, 2)) : ''}
                        </div>
                    `;
                } else if (event.type === 'http_request') {
                    content += `
                        <div class="debug-section timeline-item">
                            <div class="debug-section-title">STEP ${event.sortOrder}: AI HTTP REQUEST</div>
                            <div class="debug-timestamp">${event.timestamp}</div>
                            <div class="debug-note">Follow-up request after tool execution</div>
                            ${this.createDropdown('Raw HTTP Request JSON', JSON.stringify(event.payload, null, 2))}
                            ${this.createDropdown('Messages in Request', this.formatMessages(event.payload.messages))}
                        </div>
                    `;
                } else if (event.type === 'tool_execution') {
                    content += `
                        <div class="debug-section timeline-item">
                            <div class="debug-section-title">STEP ${event.sortOrder}: TOOL EXECUTION</div>
                            <div class="debug-timestamp">${event.timestamp}</div>
                            <div class="tool-info">Tool: ${event.data.tool_name}</div>
                            ${this.createDropdown('Tool Arguments', JSON.stringify(event.data.arguments, null, 2))}
                        </div>
                    `;
                } else if (event.type === 'tool_result') {
                    const status = event.data.status || 'unknown';
                    content += `
                        <div class="debug-section timeline-item">
                            <div class="debug-section-title">STEP ${event.sortOrder}: TOOL RESULT (${status})</div>
                            <div class="debug-timestamp">${event.timestamp}</div>
                            <div class="tool-info">Tool: ${event.data.tool_name} - Status: ${status}</div>
                            ${event.data.result ? this.createDropdown('Tool Result', JSON.stringify(event.data.result, null, 2)) : ''}
                            ${event.data.error ? this.createDropdown('Tool Error', event.data.error) : ''}
                        </div>
                    `;
                } else if (event.type === 'response') {
                    content += `
                        <div class="debug-section timeline-item">
                            <div class="debug-section-title">STEP ${event.sortOrder}: RESPONSE METADATA</div>
                            <div class="debug-timestamp">${event.timestamp}</div>
                            <div class="debug-note">Stream processing completed</div>
                            ${this.createDropdown('Response Metadata', JSON.stringify(event.data, null, 2))}
                        </div>
                    `;
                }
            });
            
            content += `</div>`;  // Close unified-timeline-section
        }
        
        // Add complete message history section at the end
        if (debugData.completeMessageHistory) {
            content += `<div class="message-history-section">`;
            content += `<h4>Complete Message History</h4>`;
            content += `<div class="debug-note">Final history for this message</div>`;
            
            if (debugData.completeMessageHistory.error) {
                content += `<div class="debug-error">Error: ${debugData.completeMessageHistory.error}</div>`;
            } else {
                const messageCount = Array.isArray(debugData.completeMessageHistory) ? debugData.completeMessageHistory.length : 0;
                content += this.createDropdown(
                    `Complete Message History (${messageCount} messages)`,
                    JSON.stringify(debugData.completeMessageHistory, null, 2),
                    false,
                    'json'
                );
            }
            
            content += `</div>`;  // Close message-history-section
        }
        
        content += '</div>';  // Close debug-panel
        return content;
    }
    
    // Render user debug data (sequence format)
    renderUserDebugData(debugData) {
        let content = '<div class="debug-panel">';
        content += '<h3>User HTTP Request Debug</h3>';
        content += '<div class="debug-note">HTTP request payload sent to AI provider</div>';
        
            // Construct unified request from available data
        content += `<div class="http-request-section">`;
        content += `<h4>HTTP Request to AI Provider</h4>`;
        content += `<div class="debug-note">Unified request structure that would be sent to AI</div>`;
        
        // Build unified request structure
        const unifiedRequest = {};
        
        if (debugData.conversationHistory) {
            unifiedRequest.messages = debugData.conversationHistory;
        }
        
        // Add tools from user input data
        const userInputStep = debugData.sequence.find(step => step.type === 'user_input');
        if (userInputStep && userInputStep.data && userInputStep.data.tools && userInputStep.data.tools.definitions) {
            unifiedRequest.tools = userInputStep.data.tools.definitions;
        }
        
        // Add typical fields
        unifiedRequest.stream = true;
        unifiedRequest.model = '[model from settings]';
        
        content += this.createDropdown(
            `Unified Request Structure`,
            JSON.stringify(unifiedRequest, null, 2),
            false,
            'json'
        );
        
        content += `</div>`;
        
        
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