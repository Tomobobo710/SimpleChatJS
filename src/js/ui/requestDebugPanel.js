// Request Debug Panel - Shows request sequence data for a turn.
// Separate from response debug panel - handles only request data.

class RequestDebugPanel {
    constructor() {
        this.container = null;
    }

    render(debugData) {
        if (!debugData || !debugData.sequence) {
            return '<div class="request-debug-panel"><p>No request debug data available</p></div>';
        }

        let content = '<div class="request-debug-panel">';
        content += '<h3>Request Debug</h3>';
        content += '<div class="debug-note">Request pipeline: frontend &rarr; SimpleChat &rarr; AI provider</div>';

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

// Create request debug panel content
function createRequestDebugPanelContent(debugData) {
    const panel = new RequestDebugPanel();
    return panel.render(debugData);
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createRequestDebugPanelContent
    };
}
