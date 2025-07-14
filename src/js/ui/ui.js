// UI Initialization and Event Management

// Get DOM element references
function initializeElements() {
    messageInput = document.getElementById('messageInput');
    sendBtn = document.getElementById('sendBtn');
    
    // Image upload elements
    imageInput = document.getElementById('imageInput');
    addImageBtn = document.getElementById('addImageBtn');
    imagePreviews = document.getElementById('imagePreviews');
    imageArea = document.getElementById('imageArea');
    toolsBtn = document.getElementById('toolsBtn');
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
    // Image upload functionality
    addImageBtn.addEventListener('click', () => {
        imageInput.click();
    });
    
    // Tools button functionality
    if (toolsBtn) {
        toolsBtn.addEventListener('click', openToolsSettings);
    }
    
    imageInput.addEventListener('change', handleImageSelect);
    
    // Drag and drop for images
    imageArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        imageArea.classList.add('drag-over');
    });
    
    imageArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        imageArea.classList.remove('drag-over');
    });
    
    imageArea.addEventListener('drop', (e) => {
        e.preventDefault();
        imageArea.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
        if (files.length > 0) {
            handleImageFiles(files);
        }
    });
    // Clipboard paste support for images
    document.addEventListener('paste', (e) => {
        // Only handle paste when the message input is focused or in the input area
        const isInputFocused = document.activeElement === messageInput;
        const isInInputArea = imageArea.contains(document.activeElement) || 
                              document.getElementById('inputContainer').contains(document.activeElement);
        
        if (!isInputFocused && !isInInputArea) {
            return; // Don't intercept paste events outside input area
        }
        
        const clipboardData = e.clipboardData || window.clipboardData;
        const items = clipboardData.items;
        
        let hasImages = false;
        const imageFiles = [];
        
        // Check for image items in clipboard
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                hasImages = true;
                const file = item.getAsFile();
                if (file) {
                    imageFiles.push(file);
                }
            }
        }
        
        // If we found images, prevent default paste and handle them
        if (hasImages && imageFiles.length > 0) {
            e.preventDefault();
            handleImageFiles(imageFiles, 'paste');
            logger.info(`Pasted ${imageFiles.length} image(s) from clipboard`);
        }
    });
    
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

// Open settings modal directly to MCP tab for tool management
async function openToolsSettings() {
    try {
        await loadSettingsIntoModal();
        settingsModal.classList.remove('hidden');
        switchTab('mcp'); // Switch to MCP tab
        logger.info('Opened tools settings via tools button');
    } catch (error) {
        logger.error('Error opening tools settings:', error);
        showError('Failed to open tools settings');
    }
}

// Auto-focus input on load
window.addEventListener('load', () => {
    if (messageInput) {
        messageInput.focus();
    }
});

// ===== IMAGE HANDLING FUNCTIONS =====

// Store selected images
let selectedImages = [];

function handleImageSelect(event) {
    const files = Array.from(event.target.files);
    handleImageFiles(files);
    // Clear the input so the same file can be selected again
    event.target.value = '';
}

function handleImageFiles(files, source = 'file') {
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    
    if (imageFiles.length === 0) {
        logger.warn('No valid image files selected');
        return;
    }
    
    // Show brief visual feedback for paste operations
    if (source === 'paste' || source === 'clipboard') {
        const hint = document.querySelector('.action-hint');
        if (hint) {
            const originalText = hint.textContent;
            hint.textContent = `✓ Pasted ${imageFiles.length} image${imageFiles.length > 1 ? 's' : ''}`;
            hint.style.color = '#4a9d4a';
            setTimeout(() => {
                hint.textContent = originalText;
                hint.style.color = '';
            }, 2000);
        }
    }
    
    imageFiles.forEach(async (file) => {
        try {
            // Use shared image processing logic (from edit modal)
            const imageData = await processImageFile(file);
            
            selectedImages.push(imageData);
            createImagePreview(imageData, selectedImages.length - 1);
            updateImageAreaVisibility();
            
            logger.info(`Added image: ${imageData.name} (${(imageData.originalSize / 1024).toFixed(1)}KB → ${(imageData.size / 1024).toFixed(1)}KB)`);
            
        } catch (error) {
            logger.error(`Error processing image ${file.name}:`, error);
        }
    });
}

function createImagePreview(imageData, index) {
    const preview = document.createElement('div');
    preview.className = 'image-preview';
    preview.dataset.index = index;
    
    const img = document.createElement('img');
    img.src = `data:${imageData.mimeType};base64,${imageData.data}`;
    img.alt = imageData.name;
    img.title = `${imageData.name} (${(imageData.size / 1024).toFixed(1)}KB)`;
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.innerHTML = '×';
    removeBtn.title = 'Remove image';
    removeBtn.onclick = () => removeImage(index);
    
    preview.appendChild(img);
    preview.appendChild(removeBtn);
    imagePreviews.appendChild(preview);
}

function removeImage(index) {
    selectedImages.splice(index, 1);
    
    // Rebuild all previews with correct indices
    imagePreviews.innerHTML = '';
    selectedImages.forEach((imageData, newIndex) => {
        createImagePreview(imageData, newIndex);
    });
    
    updateImageAreaVisibility();
    logger.info(`Removed image at index ${index}`);
}

function updateImageAreaVisibility() {
    const hasImages = selectedImages.length > 0;
    imagePreviews.style.display = hasImages ? 'flex' : 'none';
    
    // Update input container height smoothly
    const inputContainer = document.getElementById('inputContainer');
    if (hasImages) {
        inputContainer.classList.add('has-images');
    } else {
        inputContainer.classList.remove('has-images');
    }
}

function getSelectedImages() {
    return selectedImages;
}

function clearSelectedImages() {
    selectedImages = [];
    imagePreviews.innerHTML = '';
    updateImageAreaVisibility();
}