// MCP (Model Context Protocol) Management

// Load MCP config into modal
async function loadMCPConfigIntoModal() {
    try {
        const response = await loadMCPConfig();
        
        // Parse the server response to get the config string
        const responseObj = JSON.parse(response);
        let configString = responseObj.config || response;
        
        // Convert literal escape sequences to actual newlines
        configString = configString
            .replace(/\\r\\n/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '');
        
        // Parse and format the actual config JSON
        const configObj = JSON.parse(configString);
        mcpConfigText.value = JSON.stringify(configObj, null, 2);
        
    } catch (error) {
        mcpConfigText.value = JSON.stringify({
            "mcpServers": {}
        }, null, 2);
        showError(`Failed to load MCP config: ${error.message}`);
    }
}

// Handle save MCP config
async function handleSaveMCPConfig() {
    try {
        const configText = mcpConfigText.value.trim();
        
        if (!configText) {
            showError('MCP config cannot be empty');
            return;
        }
        
        await saveMCPConfig(configText);
        showSuccess('MCP config saved successfully');
        mcpConfigModal.classList.add('hidden');
        
        // Refresh MCP status
        updateMCPStatus();
        
    } catch (error) {
        if (error.message.includes('JSON')) {
            showError('Invalid JSON format. Please check your config.');
        } else {
            showError(`Failed to save MCP config: ${error.message}`);
        }
    }
}

// Handle test MCP config
async function handleTestMCPConfig() {
    try {
        const configText = mcpConfigText.value.trim();
        
        // Validate JSON
        JSON.parse(configText);
        
        showSuccess('JSON format is valid');
        
        // Could add actual connection testing here later
        
    } catch (error) {
        showError('Invalid JSON format: ' + error.message);
    }
}

// Auto-connect to MCP servers at startup
async function autoConnectMCP() {
    try {
        logger.info('Auto-connecting to MCP servers...');
        const result = await connectToMCPServers();
        
        if (result.success) {
            logger.info(`Auto-connected to MCP servers! Found ${result.toolCount} tools.`);
            updateMCPStatus();
        } else {
            logger.warn('Auto-connect to MCP failed:', result.error);
        }
    } catch (error) {
        logger.warn('Auto-connect to MCP failed:', error.message);
    }
}

// Handle MCP refresh
async function handleRefreshMCP() {
    try {
        const refreshBtn = document.getElementById('refreshMcpBtn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Refreshing...';
        }
        
        logger.info('Refreshing MCP servers...');
        const result = await connectToMCPServers();
        
        if (result.success) {
            logger.info(`Refreshed MCP servers! Found ${result.toolCount} tools.`);
            updateMCPStatus();
            showSuccess(`Refreshed MCP servers! Found ${result.toolCount} tools.`);
        } else {
            showError(`Failed to refresh: ${result.error}`);
        }
    } catch (error) {
        showError(`Refresh failed: ${error.message}`);
    } finally {
        const refreshBtn = document.getElementById('refreshMcpBtn');
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Refresh MCP Servers';
        }
    }
}

// Update MCP status in settings
async function updateMCPStatus() {
    try {
        const status = await getMCPStatus();
        const mcpServersDiv = document.getElementById('mcpServers');
        
        if (!mcpServersDiv) return;
        
        if (status.connected && status.servers && status.servers.length > 0) {
            let statusHtml = '';
            
            status.servers.forEach(server => {
                const isConnected = server.connected;
                const statusClass = isConnected ? 'connected' : 'disconnected';
                
                // Count enabled tools
                const enabledTools = isConnected ? server.tools.filter(tool => isToolEnabled(server.name, tool)) : [];
                const statusText = isConnected ? `Connected - ${enabledTools.length}/${server.tools.length} tools enabled` : 'Disconnected';
                
                // Check if all tools are enabled for server toggle
                const allToolsEnabled = isConnected && server.tools.length > 0 && server.tools.every(tool => isToolEnabled(server.name, tool));
                
                // Check if this server was previously expanded
                const isExpanded = expandedServers.has(server.name);
                
                statusHtml += `
                    <div class="mcp-server ${isExpanded ? 'expanded' : ''}" data-server="${escapeHtml(server.name)}">
                        <div class="mcp-server-header">
                            <input type="checkbox" class="mcp-server-toggle" 
                                   data-server="${escapeHtml(server.name)}" 
                                   ${allToolsEnabled ? 'checked' : ''} 
                                   ${!isConnected ? 'disabled' : ''}>
                            <span class="mcp-server-name">${escapeHtml(server.name)}</span>
                            <span class="mcp-server-status ${statusClass}">${statusText}</span>
                            <span class="mcp-server-expand-area" onclick="toggleMCPServer('${escapeHtml(server.name)}')">
                                <span class="mcp-server-arrow">▶</span>
                            </span>
                        </div>
                        
                        ${isConnected && server.tools.length > 0 ? `
                            <div class="mcp-tools">
                                ${server.tools.map(tool => {
                                    const isEnabled = isToolEnabled(server.name, tool);
                                    return `
                                        <div class="mcp-tool">
                                            <input type="checkbox" class="mcp-tool-toggle" 
                                                   data-server="${escapeHtml(server.name)}" 
                                                   data-tool="${escapeHtml(tool)}" 
                                                   ${isEnabled ? 'checked' : ''}>
                                            <span class="mcp-tool-name">${escapeHtml(tool)}</span>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        ` : ''}
                    </div>
                `;
            });
            
            mcpServersDiv.innerHTML = statusHtml;
            
            // Add event listeners for checkboxes
            addMCPCheckboxListeners();
            
        } else {
            mcpServersDiv.innerHTML = `
                <div class="mcp-no-servers">
                    <p><strong>No MCP servers connected</strong></p>
                    <p>Configure servers in "MCP Config" then use "Refresh MCP Servers" to connect.</p>
                </div>
            `;
        }
        
    } catch (error) {
        const mcpServersDiv = document.getElementById('mcpServers');
        if (mcpServersDiv) {
            mcpServersDiv.innerHTML = `
                <div class="mcp-no-servers">
                    <p><strong style="color: #ff9999;">[ERROR] Failed to load MCP status</strong></p>
                    <p>Check the console for more details.</p>
                </div>
            `;
        }
        logger.error('Failed to load MCP status:', error, true);
    }
}

// Keep track of expanded servers
let expandedServers = new Set();

// Toggle MCP server expanded/collapsed state
function toggleMCPServer(serverName) {
    const serverElement = document.querySelector(`.mcp-server[data-server="${CSS.escape(serverName)}"]`);
    if (serverElement) {
        if (serverElement.classList.contains('expanded')) {
            serverElement.classList.remove('expanded');
            expandedServers.delete(serverName);
        } else {
            serverElement.classList.add('expanded');
            expandedServers.add(serverName);
        }
    }
}

// Make toggle function globally accessible
window.toggleMCPServer = toggleMCPServer;
window.expandedServers = expandedServers;

// Add event listeners for MCP checkboxes
function addMCPCheckboxListeners() {
    // Server toggles (enable/disable all tools for a server)
    document.querySelectorAll('.mcp-server-toggle').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const serverName = e.target.dataset.server;
            const isEnabled = e.target.checked;
            
            // Toggle all tools for this server
            document.querySelectorAll(`[data-server="${serverName}"].mcp-tool-toggle`).forEach(toolCheckbox => {
                const toolName = toolCheckbox.dataset.tool;
                toolCheckbox.checked = isEnabled;
                setToolEnabled(serverName, toolName, isEnabled);
            });
            
            logger.info(`${isEnabled ? 'Enabled' : 'Disabled'} all tools for server: ${serverName}`);
            
            // Update the status display
            updateMCPStatus();
        });
    });
    
    // Individual tool toggles
    document.querySelectorAll('.mcp-tool-toggle').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const serverName = e.target.dataset.server;
            const toolName = e.target.dataset.tool;
            const isEnabled = e.target.checked;
            
            setToolEnabled(serverName, toolName, isEnabled);
            
            logger.info(`${isEnabled ? 'Enabled' : 'Disabled'} tool: ${serverName}.${toolName}`);
            
            // Update server toggle state
            const serverToggle = document.querySelector(`[data-server="${serverName}"].mcp-server-toggle`);
            if (serverToggle) {
                const allToolsChecked = document.querySelectorAll(`[data-server="${serverName}"].mcp-tool-toggle:checked`).length;
                const totalTools = document.querySelectorAll(`[data-server="${serverName}"].mcp-tool-toggle`).length;
                serverToggle.checked = allToolsChecked === totalTools;
            }
            
            // Update the status display to show new counts
            updateMCPStatus();
        });
    });
}