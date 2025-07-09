// UI Initialization and Event Management

// Get DOM element references
function initializeElements() {
    messageInput = document.getElementById('messageInput');
    sendBtn = document.getElementById('sendBtn');
    turnsContainer = document.getElementById('messages');        // Inner div for appending turns
    scrollContainer = document.getElementById('messagesContainer');   // Outer div for scrolling
    conductorModeCheckbox = document.getElementById('conductorMode');
    
    // Initialize smart auto-scroll tracking
    initSmartScroll(scrollContainer);
    
    chatList = document.getElementById('chatList');
    chatTitle = document.getElementById('chatTitle');
    chatInfo = document.getElementById('chatInfo');
    
    settingsModal = document.getElementById('settingsModal');
    settingsBtn = document.getElementById('settingsBtn');
    newChatBtn = document.getElementById('newChatBtn');
    closeModalBtn = document.querySelector('.close');
    
    apiUrlInput = document.getElementById('apiUrl');
    apiKeyInput = document.getElementById('apiKey');
    modelNameInput = document.getElementById('modelName');
    modelSelectDropdown = document.getElementById('modelSelect');
    mainModelSelect = document.getElementById('mainModelSelect');
    refreshModelsBtn = document.getElementById('refreshModelsBtn');
    saveSettingsBtn = document.getElementById('saveSettings');
    debugPanelsInput = document.getElementById('debugPanels');
    showPhaseMarkersInput = document.getElementById('showPhaseMarkers');
    testConnectionBtn = document.getElementById('testConnectionBtn');
    
    // Old thinking mode elements (removed - now handled in settings.js)
    
    // Profile management elements
    profileSelect = document.getElementById('profileSelect');
    newProfileNameInput = document.getElementById('newProfileName');
    saveAsProfileBtn = document.getElementById('saveAsProfileBtn');
    deleteProfileBtn = document.getElementById('deleteProfileBtn');
    
    mcpServersDiv = document.getElementById('mcpServers');
    
    mcpConfigModal = document.getElementById('mcpConfigModal');
    mcpConfigBtn = document.getElementById('mcpConfigBtn');
    closeMcpModalBtn = document.querySelector('.close-mcp');
    mcpConfigText = document.getElementById('mcpConfigText');
    saveMcpConfigBtn = document.getElementById('saveMcpConfig');
    testMcpConfigBtn = document.getElementById('testMcpConfig');
        
    // Log level selector
    const logLevelSelect = document.getElementById('logLevel');
    if (logLevelSelect) {
        // Default level, will be updated by loadInitialSettings
        logLevelSelect.value = 'INFO';
        
        // Handle changes
        logLevelSelect.addEventListener('change', (e) => {
            setLogLevel(e.target.value);
        });
    }
}

// Setup event listeners
function setupEventListeners() {
    // Send message
    sendBtn.addEventListener('click', handleSendMessage);
    
    // Enter key to send (Shift+Enter for new line)
    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
    
    // Settings modal
    settingsBtn.addEventListener('click', async () => {
        await loadSettingsIntoModal();
        settingsModal.classList.remove('hidden');
    });
    
    closeModalBtn.addEventListener('click', () => {
        settingsModal.classList.add('hidden');
    });
    
    // Modal only closes via X button - no outside click closing
    
    // Save settings
    saveSettingsBtn.addEventListener('click', handleSaveSettings);
    
    // Test connection
    testConnectionBtn.addEventListener('click', handleTestConnection);
    
    // Debug panels toggle - show/hide existing debug toggles immediately
    debugPanelsInput.addEventListener('change', () => {
        const show = debugPanelsInput.checked;
        const debugToggles = document.querySelectorAll('.debug-toggle');
        debugToggles.forEach(toggle => {
            toggle.style.display = show ? 'block' : 'none';
        });
        logger.info(`Debug panels ${show ? 'enabled' : 'disabled'} - ${debugToggles.length} toggles updated`);
    });
    
    // Thinking mode controls are now handled in settings.js
    
    // Model selection from dropdown (settings modal)
    modelSelectDropdown.addEventListener('change', () => {
        if (modelSelectDropdown.value) {
            modelNameInput.value = modelSelectDropdown.value;
            // Also update main dropdown
            if (mainModelSelect) {
                mainModelSelect.value = modelSelectDropdown.value;
            }
            logger.info('Model selected from settings dropdown:', modelSelectDropdown.value);
        }
    });
    
    // Model selection from main dropdown
    if (mainModelSelect) {
        mainModelSelect.addEventListener('change', async () => {
            if (mainModelSelect.value) {
                // Update settings inputs
                modelNameInput.value = mainModelSelect.value;
                modelSelectDropdown.value = mainModelSelect.value;
                
                // Auto-save the setting
                const settings = loadSettings();
                settings.modelName = mainModelSelect.value;
                window.setCachedSettings(settings);
                
                // Save to backend
                try {
                    await fetch(`${window.location.origin}/api/settings`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(settings)
                    });
                    logger.info('Model auto-saved from main dropdown:', mainModelSelect.value);
                } catch (error) {
                    logger.warn('Failed to auto-save model setting:', error);
                }
            }
        });
    }
    
    // Auto-fetch models when API URL changes (with debounce)
    let apiUrlTimeout;
    apiUrlInput.addEventListener('input', () => {
        clearTimeout(apiUrlTimeout);
        apiUrlTimeout = setTimeout(async () => {
            const apiUrl = apiUrlInput.value.trim();
            const apiKey = apiKeyInput.value.trim();
            
            if (apiUrl) {
                logger.info('API URL changed - auto-fetching models');
                try {
                    await fetchAvailableModels(apiUrl, apiKey);
                } catch (error) {
                    // Silently fail - user might still be typing
                    logger.warn('Auto-fetch models failed (URL might be incomplete):', error.message);
                }
            } else {
                // Clear dropdowns if API URL is empty
                if (mainModelSelect) {
                    mainModelSelect.innerHTML = '<option value="">Configure API URL first</option>';
                }
                modelSelectDropdown.innerHTML = '<option value="">-- Select a model --</option>';
            }
        }, 1000); // Wait 1 second after user stops typing
    });
    
    // Refresh models button
    refreshModelsBtn.addEventListener('click', handleRefreshModels);
    
    // Profile management event listeners
    profileSelect.addEventListener('change', () => {
        switchToProfile(profileSelect.value);
    });
    saveAsProfileBtn.addEventListener('click', handleSaveAsProfile);
    deleteProfileBtn.addEventListener('click', handleDeleteProfile);
    
    // New chat
    newChatBtn.addEventListener('click', handleNewChat);
    
    // MCP Config modal
    mcpConfigBtn.addEventListener('click', () => {
        loadMCPConfigIntoModal();
        mcpConfigModal.classList.remove('hidden');
    });
    
    closeMcpModalBtn.addEventListener('click', () => {
        mcpConfigModal.classList.add('hidden');
    });
    
    // MCP modal only closes via X button - no outside click closing
    
    // Save MCP config
    saveMcpConfigBtn.addEventListener('click', handleSaveMCPConfig);
    
    // Test MCP config
    testMcpConfigBtn.addEventListener('click', handleTestMCPConfig);
    
    // MCP refresh
    const refreshMcpBtn = document.getElementById('refreshMcpBtn');
    if (refreshMcpBtn) {
        refreshMcpBtn.addEventListener('click', handleRefreshMCP);
    }
    
    // Tab switching
    const tabButtons = document.querySelectorAll('.tab-button');
    tabButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            switchTab(e.target.dataset.tab);
        });
    });
}

// Tab switching functionality
function switchTab(tabName) {
    // Hide all tab contents
    const tabContents = document.querySelectorAll('.tab-content');
    tabContents.forEach(content => {
        content.classList.remove('active');
    });
    
    // Remove active class from all tab buttons
    const tabButtons = document.querySelectorAll('.tab-button');
    tabButtons.forEach(button => {
        button.classList.remove('active');
    });
    
    // Show selected tab content
    const selectedTab = document.getElementById(tabName + 'Tab');
    if (selectedTab) {
        selectedTab.classList.add('active');
    }
    
    // Add active class to clicked button
    const selectedButton = document.querySelector(`[data-tab="${tabName}"]`);
    if (selectedButton) {
        selectedButton.classList.add('active');
    }
    
    logger.info(`Switched to ${tabName} tab`);
}

// Auto-focus input on load
window.addEventListener('load', () => {
    if (messageInput) {
        messageInput.focus();
    }
});