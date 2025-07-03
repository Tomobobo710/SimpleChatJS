// Settings Management with Profiles Support

// Profile management variables
let currentProfilesData = null;

// Load initial settings
async function loadInitialSettings() {
    try {
        // Load profiles first
        await loadProfiles();
        
        // Load settings from file storage
        const response = await fetch(`${window.location.origin}/api/settings`);
        const settings = await response.json();
        
        // Cache settings globally so loadSettings() can use them
        window.setCachedSettings(settings);
        
        // If settings are empty/default, save them to backend to ensure persistence
        if (!settings.apiUrl || settings.apiUrl === 'http://localhost:11434/v1') {
            logger.info('Saving default settings to backend for first-time setup');
            await saveSettingsToBackend(settings);
        }
        
        // Apply log level
        if (settings.logLevel) {
            logger.setLevel(settings.logLevel);
            const logLevelSelect = document.getElementById('logLevel');
            if (logLevelSelect) logLevelSelect.value = settings.logLevel;
        }
        
        // Load enabled tools
        await loadEnabledToolsFromBackend();
        
        // Auto-fetch models if API URL is configured (always populate the dropdown)
        if (settings.apiUrl) {
            logger.info('API URL configured - fetching available models for dropdown');
            try {
                await fetchAvailableModels(settings.apiUrl, settings.apiKey || '');
            } catch (error) {
                logger.warn('Could not auto-fetch models at startup:', error.message);
                // Still show current model in dropdown if fetch fails
                if (mainModelSelect && settings.modelName) {
                    mainModelSelect.innerHTML = `<option value="${settings.modelName}">${settings.modelName}</option>`;
                    mainModelSelect.value = settings.modelName;
                }
            }
        } else {
            // No API URL configured, just show current model if available
            if (mainModelSelect) {
                if (settings.modelName) {
                    mainModelSelect.innerHTML = `<option value="${settings.modelName}">${settings.modelName}</option>`;
                    mainModelSelect.value = settings.modelName;
                } else {
                    mainModelSelect.innerHTML = '<option value="">Configure API URL first</option>';
                }
            }
        }

        
        logger.info('Settings and tools loaded from userdata/ file storage');
    } catch (error) {
        logger.warn('Using defaults (backend unavailable):', error);
        cachedEnabledTools = {};
    }
}



// Load settings into modal
async function loadSettingsIntoModal() {
    try {
        // Get fresh settings from backend (not cached)
        const response = await fetch(`${window.location.origin}/api/settings`);
        const settings = await response.json();
        logger.info('Loading fresh settings into modal:', settings);
        
        // If no API URL is set, use the default Ollama URL
        apiUrlInput.value = settings.apiUrl || 'http://localhost:11434/v1';
        apiKeyInput.value = settings.apiKey || '';
        modelNameInput.value = settings.modelName || '';
        debugPanelsInput.checked = settings.debugPanels !== undefined ? settings.debugPanels : true;
        showPhaseMarkersInput.checked = settings.showPhaseMarkers || false;
        
        // Also update main model dropdown if it exists
        if (mainModelSelect && settings.modelName) {
            mainModelSelect.value = settings.modelName;
        }
        
        // If API URL is set, try to fetch models automatically
        if (settings.apiUrl) {
            fetchAvailableModels(settings.apiUrl, settings.apiKey || '').catch(() => {
                // Silently fail - just means models couldn't be fetched
                logger.info('Could not auto-fetch models for existing API URL');
            });
        }
        
        logger.info('Form values after loading:', {
            apiUrl: apiUrlInput.value,
            apiKey: apiKeyInput.value.length > 0 ? '[SET]' : '[EMPTY]',
            modelName: modelNameInput.value,
            debugPanels: debugPanelsInput.checked,
            showPhaseMarkers: showPhaseMarkersInput.checked
        });
        
    } catch (error) {
        logger.error('Failed to load settings into modal:', error);
        // Fallback to defaults if backend fails
        apiUrlInput.value = 'http://localhost:11434/v1';
        apiKeyInput.value = '';
        modelNameInput.value = '';
        debugPanelsInput.checked = true;
        showPhaseMarkersInput.checked = false;
    }
}

// Handle save settings
async function handleSaveSettings() {
    const settings = {
        apiUrl: apiUrlInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        modelName: modelNameInput.value.trim(),
        debugPanels: debugPanelsInput.checked,
        showPhaseMarkers: showPhaseMarkersInput.checked
    };
    
    logger.info('Attempting to save settings:', settings);
    
    // Validate required fields (only API URL is required)
    if (!settings.apiUrl) {
        logger.error('API URL validation failed - value is empty');
        showError('API URL is required');
        return;
    }
    
    try {
        // Save to file storage
        const response = await fetch(`${window.location.origin}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        
        if (!response.ok) throw new Error('Failed to save');
        
        // Update cached settings immediately
        const currentSettings = window.cachedSettings() || {};
        window.setCachedSettings({ ...currentSettings, ...settings });
        
        showSuccess('Settings saved successfully');
        settingsModal.classList.add('hidden');
        
    } catch (error) {
        showError(`Failed to save settings: ${error.message}`);
    }
}

// Handle test connection
async function handleTestConnection() {
    const apiUrl = apiUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const modelName = modelNameInput.value.trim();
    
    if (!apiUrl) {
        showError('API URL is required for testing connection');
        return;
    }
    
    // Update button state
    testConnectionBtn.disabled = true;
    testConnectionBtn.className = 'test-connection-btn testing';
    testConnectionBtn.textContent = 'Testing...';
    
    try {
        // If no model specified, we can't test properly
        if (!modelName) {
            testConnectionBtn.className = 'test-connection-btn error';
            testConnectionBtn.textContent = 'No Model';
            showError('Please select a model first, or refresh models to auto-select one');
            
            // Reset button after delay
            setTimeout(() => {
                testConnectionBtn.disabled = false;
                testConnectionBtn.className = 'test-connection-btn';
                testConnectionBtn.textContent = 'Test Connection';
            }, 3000);
            return;
        }
        
        logger.info('Testing API connection', { apiUrl, model: modelName });
        
        // Make test request via backend proxy (fixes CORS)
        const response = await fetch(`${window.location.origin}/api/test-connection`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiUrl: apiUrl,
                apiKey: apiKey,
                modelName: modelName
            })
        });
        
        if (response.ok) {
            // Success
            testConnectionBtn.className = 'test-connection-btn success';
            testConnectionBtn.textContent = 'Success!';
            showSuccess('API connection test successful!');
            logger.info('API connection test successful');
            
            // Auto-fetch available models on successful connection
            await fetchAvailableModels(apiUrl, apiKey);
            
        } else {
            // API error
            const errorText = await response.text();
            testConnectionBtn.className = 'test-connection-btn error';
            testConnectionBtn.textContent = 'Failed';
            showError(`API test failed: HTTP ${response.status} - ${response.statusText}`);
            logger.error('API connection test failed:', { status: response.status, error: errorText });
        }
        
    } catch (error) {
        // Network error
        testConnectionBtn.className = 'test-connection-btn error';
        testConnectionBtn.textContent = 'Failed';
        showError(`Connection test failed: ${error.message}`);
        logger.error('API connection test failed:', error);
    } finally {
        // Reset button after 3 seconds
        setTimeout(() => {
            testConnectionBtn.disabled = false;
            testConnectionBtn.className = 'test-connection-btn';
            testConnectionBtn.textContent = 'Test Connection';
        }, 3000);
    }
}

// Fetch available models from API
async function fetchAvailableModels(apiUrl, apiKey) {
    try {
        logger.info('Fetching available models from API');
        
        // Call backend proxy instead of external API directly (fixes CORS)
        const response = await fetch(`${window.location.origin}/api/models`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiUrl: apiUrl,
                apiKey: apiKey
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            const models = data.data || data.models || [];
            
            if (models.length > 0) {
                populateModelDropdown(models);
                showSuccess(`Found ${models.length} available models`);
                logger.info(`Successfully fetched ${models.length} models`);
            } else {
                logger.warn('No models found in API response');
                showWarning('API connected but no models found');
            }
        } else {
            logger.warn('Models endpoint not available or failed:', response.status);
        }
        
    } catch (error) {
        logger.warn('Failed to fetch models (endpoint may not exist):', error.message);
    }
}

// Populate model dropdown with fetched models
function populateModelDropdown(models) {
    // Clear existing options in both dropdowns
    modelSelectDropdown.innerHTML = '<option value="">-- Select a model --</option>';
    if (mainModelSelect) {
        mainModelSelect.innerHTML = '<option value="">-- Select a model --</option>';
    }
    
    // Add models to both dropdowns
    models.forEach(model => {
        const modelId = model.id || model.name || model;
        
        // Settings modal dropdown
        const option1 = document.createElement('option');
        option1.value = modelId;
        option1.textContent = modelId;
        modelSelectDropdown.appendChild(option1);
        
        // Main UI dropdown (if it exists)
        if (mainModelSelect) {
            const option2 = document.createElement('option');
            option2.value = modelId;
            option2.textContent = modelId;
            mainModelSelect.appendChild(option2);
        }
    });
    
    // If current model name matches one in the dropdowns, select it
    const currentModel = modelNameInput.value.trim();
    if (currentModel) {
        const matchingOption = [...modelSelectDropdown.options].find(opt => opt.value === currentModel);
        if (matchingOption) {
            modelSelectDropdown.value = currentModel;
            if (mainModelSelect) {
                mainModelSelect.value = currentModel;
            }
        }
    } else if (models.length > 0) {
        // If no model is currently set, automatically select the first available model
        const firstModel = models[0].id || models[0].name || models[0];
        modelNameInput.value = firstModel;
        modelSelectDropdown.value = firstModel;
        if (mainModelSelect) {
            mainModelSelect.value = firstModel;
        }
        logger.info(`Auto-selected first available model: ${firstModel}`);
        
        // Auto-save this setting so it persists
        const settings = loadSettings();
        settings.modelName = firstModel;
        window.setCachedSettings(settings);
        
        // Save to backend as well
        fetch(`${window.location.origin}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        }).catch(err => {
            logger.warn('Failed to auto-save model setting:', err);
        });
    }
    
    logger.info(`Populated dropdown with ${models.length} models`);
}

// Handle refresh models button click
async function handleRefreshModels() {
    const apiUrl = apiUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    
    if (!apiUrl) {
        showError('API URL is required to fetch models');
        return;
    }
    
    // Update button state
    refreshModelsBtn.disabled = true;
    refreshModelsBtn.innerHTML = '⟳';
    
    try {
        await fetchAvailableModels(apiUrl, apiKey);
    } finally {
        // Reset button after 2 seconds
        setTimeout(() => {
            refreshModelsBtn.disabled = false;
            refreshModelsBtn.innerHTML = '🔄';
        }, 2000);
    }
}

// PROFILE MANAGEMENT FUNCTIONS

// Load profiles from backend
async function loadProfiles() {
    try {
        const response = await fetch(`${window.location.origin}/api/profiles`);
        const profilesData = await response.json();
        currentProfilesData = profilesData;
        
        logger.info('[PROFILES] Loaded profiles data:', {
            activeProfile: profilesData.activeProfile,
            availableProfiles: Object.keys(profilesData.profiles),
            profileContents: profilesData.profiles
        });
        
        // Populate profile dropdown
        const profileSelect = document.getElementById('profileSelect');
        profileSelect.innerHTML = '';
        
        Object.keys(profilesData.profiles).forEach(profileName => {
            const option = document.createElement('option');
            option.value = profileName;
            option.textContent = profileName;
            if (profileName === profilesData.activeProfile) {
                option.selected = true;
                logger.info(`[PROFILES] Set ${profileName} as selected in dropdown`);
            }
            profileSelect.appendChild(option);
        });
        
        logger.info(`[PROFILES] Dropdown populated with ${Object.keys(profilesData.profiles).length} profiles`);
        return profilesData;
    } catch (error) {
        logger.error('[PROFILES] Failed to load profiles:', error);
        showError('Failed to load profiles');
        return null;
    }
}

// Switch to selected profile (auto-triggered on dropdown change)
async function switchToProfile(selectedProfile) {
    if (!selectedProfile) {
        return;
    }
    
    logger.info(`[PROFILE-SWITCH] Attempting to switch to: ${selectedProfile}`);
    
    try {
        const response = await fetch(`${window.location.origin}/api/profiles/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileName: selectedProfile })
        });
        
        if (response.ok) {
            logger.info(`[PROFILE-SWITCH] Successfully switched to profile: ${selectedProfile}`);
            
            // Reload settings into form
            await loadSettingsIntoModal();
            
            // Update cached settings
            const profilesData = currentProfilesData;
            if (profilesData && profilesData.profiles[selectedProfile]) {
                window.setCachedSettings(profilesData.profiles[selectedProfile]);
                logger.info(`[PROFILE-SWITCH] Updated cached settings for: ${selectedProfile}`);
            }
        } else {
            const error = await response.json();
            logger.error(`[PROFILE-SWITCH] Failed to switch profile: ${error.error}`);
            showError(`Failed to switch profile: ${error.error}`);
        }
    } catch (error) {
        logger.error('[PROFILE-SWITCH] Switch profile error:', error);
        showError('Failed to switch profile');
    }
}

// Save current settings as new profile
async function handleSaveAsProfile() {
    const newProfileNameInput = document.getElementById('newProfileName');
    const profileName = newProfileNameInput.value.trim();
    
    if (!profileName) {
        showError('Please enter a profile name');
        return;
    }
    
    // Get current settings from form
    const settings = {
        apiUrl: apiUrlInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        modelName: modelNameInput.value.trim(),
        debugPanels: debugPanelsInput.checked,
        showPhaseMarkers: showPhaseMarkersInput.checked
    };
    
    logger.info(`[SAVE-PROFILE] Saving profile "${profileName}" with settings:`, settings);
    
    try {
        const response = await fetch(`${window.location.origin}/api/profiles/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileName, settings })
        });
        
        if (response.ok) {
            logger.info(`[SAVE-PROFILE] Successfully saved and switched to profile: ${profileName}`);
            showSuccess(`Profile saved: ${profileName}`);
            newProfileNameInput.value = ''; // Clear input
            
            // Reload profiles to update dropdown and switch to new profile
            await loadProfiles();
            
            // Update the form to show we're now on the new profile
            await loadSettingsIntoModal();
        } else {
            const error = await response.json();
            showError(`Failed to save profile: ${error.error}`);
        }
    } catch (error) {
        logger.error('Save profile error:', error);
        showError('Failed to save profile');
    }
}

// Show custom confirm dialog
function showCustomConfirm(message, onConfirm) {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    
    // Create confirm dialog
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
        <div class="confirm-message">${message}</div>
        <div class="confirm-buttons">
            <button class="confirm-btn confirm-yes">Delete</button>
            <button class="confirm-btn confirm-no">Cancel</button>
        </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    // Handle button clicks
    const yesBtn = dialog.querySelector('.confirm-yes');
    const noBtn = dialog.querySelector('.confirm-no');
    
    const cleanup = () => {
        document.body.removeChild(overlay);
    };
    
    yesBtn.addEventListener('click', () => {
        cleanup();
        onConfirm();
    });
    
    noBtn.addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup();
    });
}

// Delete selected profile
async function handleDeleteProfile() {
    const profileSelect = document.getElementById('profileSelect');
    const selectedProfile = profileSelect.value;
    
    if (!selectedProfile) {
        showError('Please select a profile to delete');
        return;
    }
    
    // Custom confirm dialog
    showCustomConfirm(
        `Delete profile "${selectedProfile}"?`,
        async () => {
            try {
                const response = await fetch(`${window.location.origin}/api/profiles/${selectedProfile}`, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    showSuccess(`Profile deleted: ${selectedProfile}`);
                    
                    // Reload profiles to update dropdown and switch to new active profile
                    await loadProfiles();
                    await loadSettingsIntoModal();
                } else {
                    const error = await response.json();
                    showError(`Failed to delete profile: ${error.error}`);
                }
            } catch (error) {
                logger.error('Delete profile error:', error);
                showError('Failed to delete profile');
            }
        }
    );
}