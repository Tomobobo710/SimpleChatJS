// Debug Panel Management

// Simple debug-specific dropdown
function createDebugDropdown(title, content, isOpen = false, contentType = 'json') {
    const dropdownId = `debug-dropdown-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const toggleClass = isOpen ? 'open' : 'closed';
    const contentClass = contentType === 'text' ? 'debug-content debug-text' : 'debug-content debug-json';
    
    return `
        <div class="debug-dropdown ${toggleClass}">
            <div class="debug-dropdown-toggle" data-dropdown-id="${dropdownId}">
                <span class="debug-dropdown-arrow">${isOpen ? '▼' : '▶'}</span>
                <span class="debug-dropdown-title">${title}</span>
            </div>
            <div class="debug-dropdown-content" id="${dropdownId}" style="display: ${isOpen ? 'block' : 'none'}">
                <div class="${contentClass}">${content}</div>
            </div>
        </div>
    `;
}

// Debug panel functionality
function createDebugPanel(messageId, debugData) {
    const panel = document.createElement('div');
    panel.className = 'debug-panel hidden';
    panel.id = `debug-${messageId}`;
    
    let content = '';
    
    // Sequential display for both conductor and simple modes
    if (debugData.sequence && debugData.sequence.length > 0) {
        // Show metadata first
        if (debugData.metadata) {
            content += `
                <div class="debug-section">
                    <div class="debug-section-title">[INFO] Session Metadata</div>
                    <div class="debug-content">Endpoint: ${debugData.metadata.endpoint}<br>
Timestamp: ${debugData.metadata.timestamp}<br>
Tools Available: ${typeof debugData.metadata.tools === 'number' ? debugData.metadata.tools : (debugData.metadata.tools?.length || 'unknown')}</div>
                </div>
            `;
        }
        
        // Iterate through sequence steps
        debugData.sequence.forEach(step => {
            // Get phase info for conductor mode
            const phaseInfo = step.data?.conductorPhase ? ` [Phase ${step.data.conductorPhase}]` : '';
            
            if (step.type === 'request') {
                // Show RAW HTTP Request - exactly what was sent to AI API
                content += `
                    <div class="debug-section" data-step-type="request">
                        <div class="debug-section-title">>> Step ${step.step}: RAW HTTP Request${phaseInfo}</div>
                        <div class="debug-timestamp">${step.timestamp}</div>
                        ${createDebugDropdown('Request JSON', JSON.stringify(step.data.request, null, 2))}
                    </div>
                `;
            }
            
            if (step.type === 'response') {
                // Show RAW HTTP Response - exactly what came back from AI API
                const rawResponse = step.data.raw_http_response;
                const hasToolCalls = step.data.has_tool_calls;
                const responseIcon = '<<';
                const responseTitle = hasToolCalls ? 
                    `RAW HTTP Response (with tool calls)${phaseInfo}` :
                    `RAW HTTP Response${phaseInfo}`;
                
                // Get response content - same source as chat bubble
                const cleanContent = step.data.content || 'No content captured';
                
                content += `
                    <div class="debug-section" data-step-type="response" ${hasToolCalls ? 'data-has-tools="true"' : ''}>
                        <div class="debug-section-title">${responseIcon} Step ${step.step}: ${responseTitle}</div>
                        <div class="debug-timestamp">${step.timestamp}</div>
                        ${createDebugDropdown('Raw Response JSON', JSON.stringify(rawResponse, null, 2))}
                        
                        ${createDebugDropdown('📄 Complete Response (Parsed)', cleanContent.replace(/</g, '&lt;').replace(/>/g, '&gt;'), false, 'text')}
                    </div>
                `;
            }
            
            if (step.type === 'tool_execution') {
                // Show tool execution start
                content += `
                    <div class="debug-section" data-step-type="tool_execution">
                        <div class="debug-section-title">[EXEC] Step ${step.step}: Tool Execution Start${phaseInfo}</div>
                        <div class="debug-timestamp">${step.timestamp}</div>
                        ${createDebugDropdown('Tool Execution Data', JSON.stringify(step.data, null, 2))}
                    </div>
                `;
            }
            
            if (step.type === 'tool_result') {
                // Show tool execution result
                const statusIcon = step.data.status === 'success' ? '[OK]' : '[ERR]';
                content += `
                    <div class="debug-section" data-step-type="tool_result">
                        <div class="debug-section-title">${statusIcon} Step ${step.step}: Tool Result${phaseInfo}</div>
                        <div class="debug-timestamp">${step.timestamp}</div>
                        ${createDebugDropdown('Tool Result Data', JSON.stringify(step.data, null, 2))}
                    </div>
                `;
            }
        });
    }
    
    panel.innerHTML = content;
    return panel;
}

// Handle debug toggle clicks
function toggleDebugPanel(messageId) {
    const panel = document.getElementById(`debug-${messageId}`);
    const toggle = document.querySelector(`[data-message-id="${messageId}"] .debug-toggle`);
    
    if (panel && toggle) {
        panel.classList.toggle('hidden');
        toggle.classList.toggle('active');
    }
}

// Event delegation for debug toggles
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('debug-toggle')) {
        const messageId = e.target.dataset.messageId;
        toggleDebugPanel(messageId);
    }
    
    // Handle debug dropdown toggles
    if (e.target.classList.contains('debug-dropdown-toggle') || e.target.closest('.debug-dropdown-toggle')) {
        const toggle = e.target.classList.contains('debug-dropdown-toggle') ? e.target : e.target.closest('.debug-dropdown-toggle');
        const dropdownId = toggle.dataset.dropdownId;
        const content = document.getElementById(dropdownId);
        const arrow = toggle.querySelector('.debug-dropdown-arrow');
        const dropdown = toggle.closest('.debug-dropdown');
        
        if (content && arrow && dropdown) {
            const isVisible = content.style.display === 'block';
            content.style.display = isVisible ? 'none' : 'block';
            arrow.textContent = isVisible ? '▶' : '▼';
            dropdown.classList.toggle('open', !isVisible);
            dropdown.classList.toggle('closed', isVisible);
        }
    }
});