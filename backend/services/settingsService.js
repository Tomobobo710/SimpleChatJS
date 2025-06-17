// Settings service - Manage application settings
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');

// Current settings in memory
let currentSettings = {
    apiUrl: 'http://localhost:11434/v1',
    apiKey: '',
    modelName: ''
};

// Get settings path
function getSettingsPath() {
    return path.join(__dirname, '..', '..', 'userdata', 'settings.json');
}

// Load settings from file
function loadSettings() {
    try {
        const settingsPath = getSettingsPath();
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            Object.assign(currentSettings, settings);
            log('[SETTINGS] Loaded from file');
            return settings;
        } else {
            log('[SETTINGS] No settings file found, using defaults');
            return getDefaultSettings();
        }
    } catch (error) {
        log('[SETTINGS] Load error:', error);
        return getDefaultSettings();
    }
}

// Save settings to file
function saveSettings(settings) {
    try {
        const settingsPath = getSettingsPath();
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        
        // Update server's in-memory settings immediately
        Object.assign(currentSettings, settings);
        
        return { success: true };
    } catch (error) {
        log('[SETTINGS] Save error:', error);
        return { success: false, error: error.message };
    }
}

// Get default settings
function getDefaultSettings() {
    return {
        apiUrl: 'http://localhost:11434/v1',
        apiKey: '',
        modelName: '',
        debugPanels: true,
        logLevel: 'INFO'
    };
}

// Get current settings
function getCurrentSettings() {
    return currentSettings;
}

// Load settings on startup
async function loadSettingsOnStartup() {
    try {
        const settingsPath = getSettingsPath();
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            Object.assign(currentSettings, settings);
            log('[SETTINGS] Loaded from file');
        } else {
            log('[SETTINGS] No settings file found, using defaults');
        }
    } catch (error) {
        log('[SETTINGS] Load error:', error);
    }
}

module.exports = {
    loadSettings,
    saveSettings,
    getDefaultSettings,
    getCurrentSettings,
    loadSettingsOnStartup
};