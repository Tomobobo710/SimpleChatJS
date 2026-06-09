// Debug Panel - Shows request/response data for a turn.
// Two data sources:
//   1. Request debug data (from backend): sequence format with user_http_request, unified_request, ai_http_request
//   2. Response debug data (from backend): sequential responses with SSE streams, tool calls, and results

class DebugPanel {
    constructor() {
        this.container = null;
    }

    render(debugData) {
        if (!debugData) {
            return '<div class="debug-panel"><p>No debug data available</p></div>';
        }

        // Handle request debug data (sequence format from backend)
        if (debugData.sequence && !debugData.request) {
            return this.renderRequestDebugData(debugData);
        }

        // Handle response debug data — from DB (debugDataAll) or transient store (request/response)
        if (debugData.debugDataAll && Array.isArray(debugData.debugDataAll)) {
            return this.renderResponseDebugData(debugData);
        }
        if (debugData.request || debugData.response || debugData.error) {
            return this.renderResponseDebugData(debugData);
        }

        return '<div class="debug-panel"><p>No debug data available</p></div>';
    }

    renderRequestDebugData(debugData) {
        let content = '<div class="debug-panel">';
        content += '<h3>Request Debug</h3>';
        content += '<div class="debug-note">Request pipeline: frontend &rarr; SimpleChat &rarr; AI provider</div>';

        // Show turn info
        if (debugData.currentTurnNumber) {
            content += `<div class="debug-note">Turn #${debugData.currentTurnNumber}</div>`;
        }

        // Show the 3-step sequence
        if (debugData.sequence && Array.isArray(debugData.sequence)) {
            for (const step of debugData.sequence) {
                const labels = {
                    'user_http_request': 'Frontend &rarr; SimpleChat',
                    'unified_request': 'SimpleChat &rarr; Unified Format',
                    'ai_http_request': 'SimpleChat &rarr; AI Provider'
                };
                const label = labels[step.type] || step.type;

                content += `<div class="debug-section timeline-item">`;
                content += `<div class="debug-section-title">Step ${step.step}: ${label}</div>`;
                content += `<div class="debug-timestamp">${step.timestamp}</div>`;

                if (step.data && step.data.requestBody) {
                    content += this.createDropdown('Request Body', JSON.stringify(step.data.requestBody, null, 2), false, 'json');
                }

                content += `</div>`;
            }
        }

        // Get messages from the AI HTTP request (authoritative source — includes all roles)
        const aiRequestStep = debugData.sequence.find(s => s.type === 'ai_http_request');
        const allMessages = aiRequestStep && aiRequestStep.data && aiRequestStep.data.requestBody && Array.isArray(aiRequestStep.data.requestBody.messages)
            ? aiRequestStep.data.requestBody.messages
            : null;

        // Show Messages In This Turn
        if (allMessages && allMessages.length > 0) {
            content += `<div class="message-history-section">`;
            content += `<h4>Messages In This Turn</h4>`;
            content += `<div class="debug-note">${allMessages.length} message(s)</div>`;
            content += this.createDropdown(
                `Turn Messages (${allMessages.length} messages)`,
                JSON.stringify(allMessages, null, 2),
                false,
                'json'
            );
            content += `</div>`;
        }

        // Show Complete Message History
        if (allMessages && allMessages.length > 0) {
            content += `<div class="message-history-section">`;
            content += `<h4>Complete Message History</h4>`;
            content += `<div class="debug-note">${allMessages.length} message(s) sent to provider</div>`;
            content += this.createDropdown(
                `Complete Message History (${allMessages.length} messages)`,
                JSON.stringify(allMessages, null, 2),
                false,
                'json'
            );
            content += `</div>`;
        }

        content += '</div>';
        return content;
    }

    renderResponseDebugData(debugData) {
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

        // Show errors
        if (debugData.error) {
            content += `<div class="debug-section timeline-item error-section">`;
            content += `<div class="debug-section-title">ERROR: ${debugData.error.type}</div>`;
            content += `<div class="debug-timestamp">${new Date().toISOString()}</div>`;
            content += `<div class="tool-info">Message: ${debugData.error.message || 'No message'}</div>`;
            if (debugData.error.status_code) {
                content += `<div class="tool-info">Status: ${debugData.error.status_code}</div>`;
            }
            content += `</div>`;
            content += '</div>';
            return content;
        }

        // Collect all debug entries for this turn from debugDataAll (DB query returns all messages)
        // debugData from transient store is just the last response &mdash; skip it to avoid duplication
        const allEntries = [];
        if (debugData.debugDataAll && Array.isArray(debugData.debugDataAll)) {
            for (const d of debugData.debugDataAll) {
                if (d.response || d.error) {
                    allEntries.push(d);
                }
            }
        }

        // If no debugDataAll, fall back to debugData alone (edge case)
        if (allEntries.length === 0 && debugData.response) {
            allEntries.push(debugData);
        }

        // Render sequential response timeline
        for (let i = 0; i < allEntries.length; i++) {
            const entry = allEntries[i];
            const resp = entry.response;
            const isLast = i === allEntries.length - 1;
            const nextEntry = allEntries[i + 1] || null;

            content += `<div class="debug-section timeline-item">`;
            content += `<div class="debug-section-title">Response ${i + 1}</div>`;

            if (resp.status) {
                content += `<div class="tool-info">Status: ${resp.status}</div>`;
            }

            // SSE stream
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
                content += this.createDropdown('SSE Stream', prettyLines, false, 'json');
            }

            // Content
            if (resp.content) {
                const preview = resp.content.length > 500
                    ? resp.content.substring(0, 500) + '...'
                    : resp.content;
                content += this.createDropdown('Content', preview, false, 'json');
            }

            // Tool calls with results
            if (resp.toolCalls && resp.toolCalls.length > 0) {
                const toolCallHtml = this.renderToolCallsWithResults(resp.toolCalls, entry.toolResults || null);
                content += toolCallHtml;
            }

            // Recursive request body (next response's request)
            if (nextEntry && nextEntry.request && nextEntry.request.body) {
                content += this.createDropdown('Recursive Request', JSON.stringify(nextEntry.request.body, null, 2), false, 'json');
            }

            // Done marker for last response
            if (isLast) {
                content += `<div class="debug-note" style="margin-top:8px;">&#10003; Done</div>`;
            }

            content += `</div>`;
        }

        // Show Messages In This Turn
        if (debugData.turnMessages && Array.isArray(debugData.turnMessages) && debugData.turnMessages.length > 0) {
            const messages = debugData.turnMessages;
            content += `<div class="message-history-section">`;
            content += `<h4>Messages In This Turn</h4>`;
            content += `<div class="debug-note">${messages.length} message(s)</div>`;
            content += this.createDropdown(
                `Turn Messages (${messages.length} messages)`,
                JSON.stringify(messages, null, 2),
                false,
                'json'
            );
            content += `</div>`;
        }

        content += '</div>';
        return content;
    }

    renderToolCallsWithResults(toolCalls, toolResults) {
        let html = '<div class="debug-section timeline-item">';
        html += '<div class="debug-section-title">Tool Calls</div>';

        for (const tc of toolCalls) {
            const toolName = tc.function?.name || 'unknown';
            const toolId = tc.id;
            let args;
            try {
                args = JSON.parse(tc.function?.arguments || '{}');
            } catch (e) {
                args = { raw: tc.function?.arguments || '{}' };
            }

            const result = toolResults?.find(r => r.toolId === toolId);
            const hasResult = result && result.status === 'success';

            html += `<div class="debug-dropdown" data-content-type="json">`;
            html += `<div class="debug-dropdown-header" onclick="toggleDebugDropdown(this)">`;
            html += `<span class="dropdown-icon">&#9654;</span>`;
            html += `<span class="dropdown-title">${toolName} (${toolId})${hasResult ? ' &#10003;' : ''}</span>`;
            html += `</div>`;
            html += `<div class="debug-dropdown-content" style="display: none">`;

            const toolInfo = { id: toolId, name: toolName, arguments: args };
            if (result) {
                toolInfo.result = result.result || result.error || null;
                toolInfo.status = result.status;
            }

            html += `<pre>${JSON.stringify(toolInfo, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
            html += `</div>`;
            html += `</div>`;
        }

        html += '</div>';
        return html;
    }

    createDropdown(title, content, isExpanded = false, contentType = 'text') {
        const expandedClass = isExpanded ? 'expanded' : '';
        const displayStyle = isExpanded ? 'block' : 'none';

        return `
            <div class="debug-dropdown ${expandedClass}" data-content-type="${contentType}">
                <div class="debug-dropdown-header" onclick="toggleDebugDropdown(this)">
                    <span class="dropdown-icon">&#9654;</span>
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
        const expanding = !dropdown.classList.contains('expanded');
        dropdown.classList.toggle('expanded');
        content.style.display = expanding ? 'block' : 'none';
        icon.textContent = expanding ? '▼' : '▶';
    }
}
