// Settings service - Manage application settings with profiles support
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');

// Default system prompt constant
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant. If the previous query requires you to use tools, do so. Otherwise, just chat with the user in a friendly manner.';

// Current settings in memory
let currentSettings = {
    apiUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    modelName: ''
};

// Get settings path
function getSettingsPath() {
    return path.join(__dirname, '..', '..', 'userdata', 'settings.json');
}

// Get profiles path
function getProfilesPath() {
    // For portable mode, use the path set by Electron
    if (process.env.PORTABLE_USERDATA_PATH) {
        return path.join(process.env.PORTABLE_USERDATA_PATH, 'profiles.json');
    } else {
        return path.join(__dirname, '..', '..', 'userdata', 'profiles.json');
    }
}

// Get default profile settings
function getDefaultProfileSettings() {
    return {
        apiUrl: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        modelName: '',
        debugPanels: true,
        showPhaseMarkers: false,
        logLevel: 'INFO',
        enableThinkingAnthropic: true,
        thinkingBudgetAnthropic: 1024,
        enableThinkingGoogle: true,
        thinkingBudgetGoogle: -1,
        enableSystemPrompt: true,
        systemPrompt: DEFAULT_SYSTEM_PROMPT
    };
}

// Get default profiles structure
function getDefaultProfiles() {
    return {
        profiles: {
            'Default': {
                ...getDefaultProfileSettings(),
                apiUrl: 'http://127.0.0.1:11434/v1',
                modelName: '',
                enableSystemPrompt: true,
                systemPrompt: DEFAULT_SYSTEM_PROMPT
            }
        },
        activeProfile: 'Default'
    };
}

// Load profiles from file
function loadProfiles() {
    try {
        const profilesPath = getProfilesPath();
        if (fs.existsSync(profilesPath)) {
            const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
            
            // Migrate profiles to ensure they have all default fields
            const defaults = getDefaultProfileSettings();
            let needsSaving = false;
            
            for (const profileName in profiles.profiles) {
                const profile = profiles.profiles[profileName];
                let profileUpdated = false;
                
                // Add any missing fields from defaults
                for (const key in defaults) {
                    if (!(key in profile)) {
                        profile[key] = defaults[key];
                        profileUpdated = true;
                    }
                }
                
                if (profileUpdated) {
                    log(`[PROFILES] Migrated profile '${profileName}' with new settings`);
                    needsSaving = true;
                }
            }
            
            // Save migrated profiles
            if (needsSaving) {
                saveProfiles(profiles);
                log('[PROFILES] Saved migrated profiles');
            }
            
            log('[PROFILES] Loaded from file');
            return profiles;
        } else {
            log('[PROFILES] No profiles file found, creating defaults');
            const defaultProfiles = getDefaultProfiles();
            saveProfiles(defaultProfiles);
            return defaultProfiles;
        }
    } catch (error) {
        log('[PROFILES] Load error:', error);
        const defaultProfiles = getDefaultProfiles();
        saveProfiles(defaultProfiles);
        return defaultProfiles;
    }
}

// Save profiles to file
function saveProfiles(profilesData) {
    try {
        const profilesPath = getProfilesPath();
        fs.writeFileSync(profilesPath, JSON.stringify(profilesData, null, 2), 'utf8');
        log('[PROFILES] Saved to file');
        return { success: true };
    } catch (error) {
        log('[PROFILES] Save error:', error);
        return { success: false, error: error.message };
    }
}

// Get active profile settings
function getActiveProfileSettings() {
    const profilesData = loadProfiles();
    const activeProfileName = profilesData.activeProfile;
    const activeProfile = profilesData.profiles[activeProfileName];
    
    if (activeProfile) {
        // Ensure all required fields exist (for backwards compatibility)
        const defaults = getDefaultProfileSettings();
        const merged = { ...defaults, ...activeProfile };
        return merged;
    } else {
        log('[PROFILES] Active profile not found, using Default');
        return profilesData.profiles['Default'] || getDefaultProfileSettings();
    }
}

// Switch to a different profile
function switchProfile(profileName) {
    try {
        const profilesData = loadProfiles();
        
        if (!profilesData.profiles[profileName]) {
            return { success: false, error: 'Profile not found' };
        }
        
        profilesData.activeProfile = profileName;
        const result = saveProfiles(profilesData);
        
        if (result.success) {
            // Update current settings in memory
            Object.assign(currentSettings, profilesData.profiles[profileName]);
            log(`[PROFILES] Switched to profile: ${profileName}`);
        }
        
        return result;
    } catch (error) {
        log('[PROFILES] Switch error:', error);
        return { success: false, error: error.message };
    }
}

// Save current settings as a new profile
function saveAsProfile(profileName, settings) {
    try {
        const profilesData = loadProfiles();
        
        // Don't allow overwriting Default profile
        if (profileName === 'Default') {
            return { success: false, error: 'Cannot overwrite the Default profile. Please use a different name.' };
        }
        
        // Create new profile with provided settings
        profilesData.profiles[profileName] = { ...settings };
        
        // Switch to the new profile
        profilesData.activeProfile = profileName;
        
        const result = saveProfiles(profilesData);
        
        if (result.success) {
            // Update current settings in memory
            Object.assign(currentSettings, settings);
            log(`[PROFILES] Saved new profile: ${profileName} and switched to it`);
        }
        
        return result;
    } catch (error) {
        log('[PROFILES] Save as profile error:', error);
        return { success: false, error: error.message };
    }
}

// Delete a profile
function deleteProfile(profileName) {
    try {
        const profilesData = loadProfiles();
        
        // Can't delete the last profile
        if (Object.keys(profilesData.profiles).length <= 1) {
            return { success: false, error: 'Cannot delete the last profile' };
        }
        
        // Don't allow deleting Default profile
        if (profileName === 'Default') {
            return { success: false, error: 'Cannot delete the Default profile' };
        }
        
        if (!profilesData.profiles[profileName]) {
            return { success: false, error: 'Profile not found' };
        }
        
        // If deleting the active profile, switch to Default (since we protect it)
        if (profilesData.activeProfile === profileName) {
            profilesData.activeProfile = 'Default';
            log('[PROFILES] Switched active profile to Default after deletion');
        }
        
        delete profilesData.profiles[profileName];
        
        const result = saveProfiles(profilesData);
        
        if (result.success) {
            log(`[PROFILES] Deleted profile: ${profileName}`);
        }
        
        return result;
    } catch (error) {
        log('[PROFILES] Delete error:', error);
        return { success: false, error: error.message };
    }
}

// Update active profile settings
function updateActiveProfile(settings) {
    try {
        const profilesData = loadProfiles();
        const activeProfileName = profilesData.activeProfile;
        
        // Update the active profile
        profilesData.profiles[activeProfileName] = { ...settings };
        
        const result = saveProfiles(profilesData);
        
        if (result.success) {
            // Update current settings in memory
            Object.assign(currentSettings, settings);
            log(`[PROFILES] Updated active profile: ${activeProfileName}`);
        }
        
        return result;
    } catch (error) {
        log('[PROFILES] Update error:', error);
        return { success: false, error: error.message };
    }
}



// Current settings access
function getCurrentSettings() {
    return currentSettings;
}

// Load settings on startup
async function loadSettingsOnStartup() {
    try {
        // Load active profile settings into memory
        const activeSettings = getActiveProfileSettings();
        Object.assign(currentSettings, activeSettings);
        log('[SETTINGS] Loaded active profile settings on startup');
    } catch (error) {
        log('[SETTINGS] Load error:', error);
    }
}

module.exports = {
    getCurrentSettings,
    loadSettingsOnStartup,
    
    // Profiles API
    loadProfiles,
    saveProfiles,
    getActiveProfileSettings,
    switchProfile,
    saveAsProfile,
    deleteProfile,
    updateActiveProfile,
    
    // Constants
    DEFAULT_SYSTEM_PROMPT
};