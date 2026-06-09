// Debug Panel - Shows request/response data for a turn.
// Two data sources:
//   1. User debug data (built frontend): sequence format with user_input + ai_http_request
//   2. Assistant debug data (from backend): minimal { request, response, error } + transient HTTP data

class DebugPanel {
    constructor() {
        this.container = null;
    }

    render(debugData) {
        if (!debugData) {
            return '<div class="debug-panel"><p>No debug data available</p></div>';
        }

        // Handle user debug data (sequence format from frontend)
        if (debugData.sequence && !debugData.request) {
            return this.renderUserDebugData(debugData);
        }

        // Handle assistant debug data (minimal from backend)
        if (debugData.request || debugData.response || debugData.error) {
            return this.renderAssistantDebugData(debugData);
        }

 

        return '<div class="debug-panel"><p>No debug data available</p></div>';
    }

    renderUserDebugData(debugData) {
        let content = '<div class="debug-panel">';
        content += '<h3>User Request Debug</h3>';
        content += '<div class="debug-note">HTTP request payload sent to AI provider</div>';

        // Show the ai_http_request event
        const requestEvent = debugData.sequence.find(step => step.type === 'ai_http_request');
        if (requestEvent) {
            content += `<div class="debug-section timeline-item">`;
            content += `<div class="debug-section-title">STEP 1: AI HTTP REQUEST</div>`;
            content += `<div class="debug-timestamp">${requestEvent.timestamp}</div>`;
            content += `<div class="debug-note">Request initiated from user bubble phase</div>`;
            content += this.createDropdown('Request Details', JSON.stringify(requestEvent.data, null, 2));
            content += `</div>`;
        }

        // Show turn info
        content += `<div class="message-history-section">`;
        content += `<h4>Messages In This Turn</h4>`;
        if (debugData.currentTurnNumber) {
            content += `<div class="debug-note">Turn #${debugData.currentTurnNumber}</div>`;
        } else {
            content += `<div class="debug-note">Current user message</div>`;
        }

        // Show the user message
        const userInputStep = debugData.sequence.find(step => step.type === 'user_input');
        if (userInputStep && userInputStep.data && userInputStep.data.userQuery) {
            const userMessage = {
                role: 'user',
                content: userInputStep.data.userQuery.message
            };
            content += this.createDropdown(
                `Current User Message`,
                JSON.stringify([userMessage], null, 2),
                true,
                'json'
            );

            // Show conversation history
            if (debugData.conversationHistory && debugData.conversationHistory.length > 0) {
                const prevTurnMessages = [];
                let foundPrevTurn = false;
                for (let i = debugData.conversationHistory.length - 1; i >= 0; i--) {
                    const msg = debugData.conversationHistory[i];
                    if (msg.role === 'assistant' && !foundPrevTurn) {
                        prevTurnMessages.unshift(msg);
                        foundPrevTurn = true;
                    } else if (foundPrevTurn && msg.role === 'user') {
                        prevTurnMessages.unshift(msg);
                        break;
                    }
                }
                if (prevTurnMessages.length > 0) {
                    content += this.createDropdown(
                        `Previous Turn Context (${prevTurnMessages.length} messages)`,
                        JSON.stringify(prevTurnMessages, null, 2),
                        false,
                        'json'
                    );
                }
            }
        } else {
            content += `<div class="debug-note">No user message found in debug data</div>`;
        }
        content += `</div>`;

        // Show complete history
        if (debugData.conversationHistory && debugData.conversationHistory.length > 0) {
            content += `<div class="message-history-section">`;
            content += `<h4>Complete Message History</h4>`;
            content += `<div class="debug-note">Complete history across all turns</div>`;
            content += this.createDropdown(
                `Complete Message History (${debugData.conversationHistory.length} messages)`,
                JSON.stringify(debugData.conversationHistory, null, 2),
                false,
                'json'
            );
            content += `</div>`;
        }

        content += '</div>';
        return content;
    }

    renderAssistantDebugData(debugData) {
        let content = '<div class="debug-panel">';
        content += '<h3>Response Debug</h3>';
        content += '<div class="debug-note">AI response and HTTP data</div>';

        // Show turn info
        if (debugData.currentTurnNumber) {
            content += `<div class="debug-note">Turn #${debugData.currentTurnNumber}</div>`;
        }
        if (debugData.turnId) {
            content += `<div class="debug-note">Turn ID: ${debugData.turnId}</div>`;
        }
        if (debugData.parentTurnId) {
            content += `<div class="debug-note">Parent Turn: ${debugData.parentTurnId}</div>`;
        }

        // Collect all responses and errors from all messages in the turn
        const allResponses = [];
        const allErrors = [];
        const allToolCalls = [];

        if (debugData.response) {
            allResponses.push(debugData.response);
        }
        if (debugData.error) {
            allErrors.push(debugData.error);
        }
        if (debugData.debugDataAll && Array.isArray(debugData.debugDataAll)) {
            for (const d of debugData.debugDataAll) {
                if (d.response) {
                    allResponses.push(d.response);
                }
                if (d.error) {
                    allErrors.push(d.error);
                }
                if (d.response && d.response.toolCalls && d.response.toolCalls.length > 0) {
                    allToolCalls.push(...d.response.toolCalls);
                }
            }
        }

        // Show errors
        for (const err of allErrors) {
            content += `<div class="debug-section timeline-item error-section">`;
            content += `<div class="debug-section-title">ERROR: ${err.type}</div>`;
            content += `<div class="debug-timestamp">${new Date().toISOString()}</div>`;
            content += `<div class="tool-info">Message: ${err.message || 'No message'}</div>`;
            if (err.status_code) {
                content += `<div class="tool-info">Status: ${err.status_code}</div>`;
            }
            content += `</div>`;
        }

        // Show all responses
        for (let i = 0; i < allResponses.length; i++) {
            const resp = allResponses[i];
            const label = allResponses.length > 1 ? `Response #${i + 1}` : 'HTTP RESPONSE';
            content += `<div class="debug-section timeline-item">`;
            content += `<div class="debug-section-title">${label}${resp.hasToolCalls ? ' (' + resp.toolCalls.length + ' tool calls)' : ''}</div>`;
            content += `<div class="debug-timestamp">${resp.timestamp || ''}</div>`;
            if (resp.status) {
                content += `<div class="tool-info">Status: ${resp.status}</div>`;
            }
            if (resp.rawBody) {
                const lines = resp.rawBody.split('\n');
                const prettyLines = lines.map(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                        try {
                            return 'data: ' + JSON.stringify(JSON.parse(trimmed.slice(6)), null, 2);
                        } catch (_) {
                            return trimmed;
                        }
                    }
                    if (trimmed === 'data: [DONE]') {
                        return '[DONE]';
                    }
                    return trimmed;
                }).join('\n');
                content += this.createDropdown('Response JSON (SSE stream)', prettyLines, false, 'json');
            }
            if (resp.content) {
                const preview = resp.content.length > 500
                    ? resp.content.substring(0, 500) + '...'
                    : resp.content;
                content += this.createDropdown('Response Content', preview, false, 'json');
            }
            content += `</div>`;
        }

        // Show aggregated tool calls from all responses
        if (allToolCalls.length > 0) {
            content += this.createDropdown('Tool Calls', JSON.stringify(allToolCalls, null, 2));
        }

        // Show Messages In This Turn (query from DB on demand)
        content += `<div class="message-history-section">`;
        content += `<h4>Messages In This Turn</h4>`;
        content += `<div class="debug-note">Turn #${debugData.currentTurnNumber || 'N/A'} — loaded from database</div>`;
        content += `<div class="debug-info" id="turn-messages-loading">Loading...</div>`;
        content += `</div>`;

        // Show complete history (query from DB on demand)
        content += `<div class="message-history-section">`;
        content += `<h4>Complete Message History</h4>`;
        content += `<div class="debug-note">Loaded from database</div>`;
        content += `<div class="debug-info" id="history-loading">Loading...</div>`;
        content += `</div>`;

        content += '</div>';
        return content;
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
    const panel = new DebugPanel();
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

        dropdown.classList.toggle('expanded');
        content.style.display = isExpanded ? 'none' : 'block';
        icon.textContent = isExpanded ? '▶' : '▼';
    }
}
