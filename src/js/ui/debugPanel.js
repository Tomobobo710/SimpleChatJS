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
        // Show messages in current turn first (more relevant for debugging)
        // Show Messages In This Turn (filter from complete history)
        if (debugData.currentTurnNumber !== null && debugData.currentTurnNumber !== undefined && debugData.completeMessageHistory) {
            content += `<div class="message-history-section">`;
            content += `<h4>Messages In This Turn</h4>`;
            content += `<div class="debug-note">Turn #${debugData.currentTurnNumber} - Filtered from complete history</div>`;
            
            // Filter messages for this turn from complete history
            const turnMessages = debugData.completeMessageHistory.filter(msg => msg.turn_number === debugData.currentTurnNumber);
            const messageCount = turnMessages.length;
            
            content += this.createDropdown(
                `Turn #${debugData.currentTurnNumber} Messages (${messageCount} messages)`,
                JSON.stringify(turnMessages, null, 2),
                false, // Collapsed by default
                'json'
            );
            
            content += `</div>`;  // Close message-history-section
        } else {
            // Fallback: Show a note about missing turn information
            content += `<div class="message-history-section">`;
            content += `<h4>Messages In This Turn</h4>`;
            content += `<div class="debug-note">Turn information not available</div>`;
            content += `<div class="debug-info">This message was saved before turn tracking was properly implemented. The complete message history below contains all context.</div>`;
            content += `</div>`;  // Close message-history-section
        }
        
        // Still show complete history (collapsed by default)
        if (debugData.completeMessageHistory) {
            content += `<div class="message-history-section">`;
            content += `<h4>Complete Message History</h4>`;
            content += `<div class="debug-note">Complete history across all turns</div>`;
            
            if (debugData.completeMessageHistory.error) {
                content += `<div class="debug-error">Error: ${debugData.completeMessageHistory.error}</div>`;
            } else {
                const messageCount = Array.isArray(debugData.completeMessageHistory) ? debugData.completeMessageHistory.length : 0;
                content += this.createDropdown(
                    `Complete Message History (${messageCount} messages)`,
                    JSON.stringify(debugData.completeMessageHistory, null, 2),
                    false, // Collapsed by default
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
        
        // Look for the ai_http_request event in the sequence
        const requestEvent = debugData.sequence.find(step => step.type === 'ai_http_request');
        if (requestEvent) {
            content += `<div class="debug-section timeline-item">`;
            content += `<div class="debug-section-title">STEP 1: AI HTTP REQUEST</div>`;
            content += `<div class="debug-timestamp">${requestEvent.timestamp}</div>`;
            content += `<div class="debug-note">Request initiated from user bubble phase</div>`;
            content += this.createDropdown('Request Details', JSON.stringify(requestEvent.data, null, 2));
            content += `</div>`;
        }
        
        // Add "Messages In This Turn" section with turn info
        content += `<div class="message-history-section">`;
        content += `<h4>Messages In This Turn</h4>`;
        
        // Show turn number if available
        if (debugData.currentTurnNumber) {
            content += `<div class="debug-note">Turn #${debugData.currentTurnNumber}</div>`;
        } else {
            content += `<div class="debug-note">Current user message</div>`;
        }
        
        // Find the user message from the sequence
        const userInputStep = debugData.sequence.find(step => step.type === 'user_input');
        if (userInputStep && userInputStep.data && userInputStep.data.userQuery) {
            const userMessage = {
                role: 'user',
                content: userInputStep.data.userQuery.message
            };
            
            // Format as a JSON array with just this message
            const messagesInTurn = [userMessage];
            
            content += this.createDropdown(
                `Current User Message`,
                JSON.stringify(messagesInTurn, null, 2),
                true,  // Show expanded by default
                'json'
            );
            
            // Also show the conversation history
            if (debugData.conversationHistory && debugData.conversationHistory.length > 0) {
                // Show only the last turn's messages (the most recent assistant response)
                const prevTurnMessages = [];
                let foundPrevTurn = false;
                
                // Go backwards through history to find the last assistant message
                for (let i = debugData.conversationHistory.length - 1; i >= 0; i--) {
                    const msg = debugData.conversationHistory[i];
                    if (msg.role === 'assistant' && !foundPrevTurn) {
                        prevTurnMessages.unshift(msg);  // Add to beginning
                        foundPrevTurn = true;
                    } else if (foundPrevTurn && msg.role === 'user') {
                        prevTurnMessages.unshift(msg);  // Add the user message that triggered this assistant response
                        break;  // Found complete previous turn
                    }
                }
                
                if (prevTurnMessages.length > 0) {
                    content += this.createDropdown(
                        `Previous Turn Context (${prevTurnMessages.length} messages)`,
                        JSON.stringify(prevTurnMessages, null, 2),
                        false,  // Collapsed by default
                        'json'
                    );
                }
            }
        } else {
            content += `<div class="debug-note">No user message found in debug data</div>`;
        }
        
        content += `</div>`;  // Close message-history-section
        
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
        // We already have userInputStep from above, so we don't need to find it again
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
        
        // Add complete message history in collapsed form for reference
        if (debugData.conversationHistory && debugData.conversationHistory.length > 0) {
            content += `<div class="message-history-section">`;
            content += `<h4>Complete Message History</h4>`;
            content += `<div class="debug-note">Complete history across all turns</div>`;
            
            content += this.createDropdown(
                `Complete Message History (${debugData.conversationHistory.length} messages)`,
                JSON.stringify(debugData.conversationHistory, null, 2),
                false,  // Collapsed by default
                'json'
            );
            
            content += `</div>`;
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
