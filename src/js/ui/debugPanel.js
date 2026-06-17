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

        // Handle response debug data — from DB (responseDebugData) or transient store (request/response)
        if (debugData.responseDebugData && Array.isArray(debugData.responseDebugData)) {
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
                    'unified_request': 'SimpleChat &rarr; Adapter',
                    'ai_http_request': 'Adapter &rarr; AI Provider'
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

        // Collect all debug entries for this turn from responseDebugData (DB query returns all messages)
        // debugData from transient store is just the last response — skip it to avoid duplication
        const allEntries = [];
        if (debugData.responseDebugData && Array.isArray(debugData.responseDebugData)) {
            for (const d of debugData.responseDebugData) {
                if (d.response || d.error) {
                    allEntries.push(d);
                }
            }
        }

        // If no responseDebugData, fall back to debugData alone (edge case)
        if (allEntries.length === 0 && debugData.response) {
            allEntries.push(debugData);
        }

        // Render sequential response timeline
        for (let i = 0; i < allEntries.length; i++) {
            const entry = allEntries[i];
            const resp = entry.response;
            const err = entry.error;
            const isLast = i === allEntries.length - 1;
            const nextEntry = allEntries[i + 1] || null;

            content += `<div class="debug-section timeline-item">`;
            
            // If entry has BOTH response and error, render them together
            // If entry has ONLY error, render just the error
            if (resp) {
                // Render response content
                content += `<div class="debug-section-title">Response ${i + 1}</div>`;

                if (resp && resp.status) {
                    content += `<div class="tool-info">Status: ${resp.status}</div>`;
                }

                // SSE stream
                if (resp && resp.rawBody) {
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

                // Reasoning
                if (resp.reasoning && typeof resp.reasoning === 'string' && resp.reasoning.trim()) {
                    const charCount = resp.reasoning.length;
                    const preview = resp.reasoning.length > 300
                        ? resp.reasoning.substring(0, 300) + '...'
                        : resp.reasoning;
                    content += this.createDropdown(
                        `Reasoning (${charCount} chars)`,
                        preview,
                        false,
                        'text'
                    );
                }

                // Content
                const contentText = resp.content || '';
                const preview = contentText.length > 500
                    ? contentText.substring(0, 500) + '...'
                    : contentText;
                content += this.createDropdown('Content', preview || '(empty)', false, 'json');

                // Tool calls with results
                if (resp.toolCalls && resp.toolCalls.length > 0) {
                    const toolCallHtml = this.renderToolCallsWithResults(resp.toolCalls, entry.toolResults || null);
                    content += toolCallHtml;
                }

                // Recursive request body (next response's request)
                if (nextEntry && nextEntry.request && nextEntry.request.body) {
                    content += this.createDropdown('Recursive Request', JSON.stringify(nextEntry.request.body, null, 2), false, 'json');
                }
            }

            // Show error if this entry has one (rendered AFTER response if both exist)
            if (err) {
                content += `<div class="debug-section error-debug">`;
                content += `<div class="debug-section-title" style="color: #ff9999;">ERROR: ${err.type}</div>`;
                content += `<div class="tool-info" style="color: #ffcccc;">Message: ${err.message || 'No message'}</div>`;
                if (err.status_code) {
                    content += `<div class="tool-info" style="color: #ffcccc;">Status: ${err.status_code}</div>`;
                }
                content += `</div>`;
            }

            // Done marker for last response
            if (isLast && !err) {
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

            html += `<details class="debug-dropdown" data-content-type="json">`;
            html += `<summary class="debug-dropdown-header">`;
            html += `<span class="dropdown-title">${toolName} (${toolId})${hasResult ? ' &#10003;' : ''}</span>`;
            html += `</summary>`;
            html += `<div class="debug-dropdown-content">`;

            const toolInfo = { id: toolId, name: toolName, arguments: args };
            if (result) {
                toolInfo.result = result.result || result.error || null;
                toolInfo.status = result.status;
            }

            html += `<pre>${JSON.stringify(toolInfo, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
            html += `</div>`;
            html += `</details>`;
        }

        html += '</div>';
        return html;
    }

    createDropdown(title, content, isExpanded = false, contentType = 'text') {
        return `
            <details class="debug-dropdown" data-content-type="${contentType}"${isExpanded ? ' open' : ''}>
                <summary class="debug-dropdown-header">
                    <span class="dropdown-title">${title}</span>
                </summary>
                <div class="debug-dropdown-content">
                    <pre>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                </div>
            </details>
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

