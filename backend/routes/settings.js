// Settings routes - Handle application settings
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { getUserdataPath } = require('../utils/pathUtils');

const UI_STATE_PATH = getUserdataPath('ui_state.json');

function loadUiState() {
    try {
        return JSON.parse(fs.readFileSync(UI_STATE_PATH, 'utf8'));
    } catch { return {}; }
}

function saveUiState(data) {
    const current = loadUiState();
    fs.writeFileSync(UI_STATE_PATH, JSON.stringify({ ...current, ...data }, null, 2), 'utf8');
}
const { 
    getActiveProfileSettings,
    updateActiveProfile,
    loadProfiles, 
    switchProfile, 
    saveAsProfile, 
    deleteProfile 
} = require('../services/settingsService');
const { log } = require('../utils/logger');
const { 
    buildModelsRequestOptions, 
    buildTestConnectionRequestOptions 
} = require('../adapters/providerRegistry');

const router = express.Router();

// Get settings
router.get('/settings', (req, res) => {
    try {
        const settings = getActiveProfileSettings();
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save settings
router.post('/settings', (req, res) => {
    try {
        const result = updateActiveProfile(req.body);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Models endpoint - proxy to avoid CORS
router.post('/models', async (req, res) => {
    try {
        const { apiUrl, apiKey } = req.body;
        
        if (!apiUrl) {
            return res.status(400).json({ error: 'API URL is required' });
        }
        
        const options = buildModelsRequestOptions({ apiUrl, apiKey });
        
        const httpModule = options.path.startsWith('https:') 
            ? https 
            : http;
        const apiReq = httpModule.request(options, (apiRes) => {
            let data = '';
            
            apiRes.on('data', (chunk) => {
                data += chunk;
            });
            
            apiRes.on('end', () => {
                if (apiRes.statusCode === 200) {
                    try {
                        const parsedData = JSON.parse(data);
                        res.json(parsedData);
                    } catch (parseError) {
                        res.status(500).json({ error: 'Failed to parse API response' });
                    }
                } else {
                    res.status(apiRes.statusCode).json({ 
                        error: `API error: ${apiRes.statusCode} ${apiRes.statusMessage}`,
                        details: data
                    });
                }
            });
        });
        
        apiReq.on('error', (error) => {
            log('Models API request error:', error);
            res.status(500).json({ error: `Connection error: ${error.message}` });
        });
        
        apiReq.end();
        
    } catch (error) {
        log('Models endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test connection endpoint - proxy to avoid CORS
router.post('/test-connection', async (req, res) => {
    try {
        const { apiUrl, apiKey, modelName } = req.body;
        
        if (!apiUrl || !modelName) {
            return res.status(400).json({ error: 'API URL and model name are required' });
        }
        
        const options = buildTestConnectionRequestOptions({ apiUrl, apiKey, modelName });
        
        const httpModule = options.path.startsWith('https:') 
            ? https 
            : http;
        const apiReq = httpModule.request(options, (apiRes) => {
            let data = '';
            
            apiRes.on('data', (chunk) => {
                data += chunk;
            });
            
            apiRes.on('end', () => {
                if (apiRes.statusCode === 200) {
                    res.json({ success: true, message: 'Connection test successful' });
                } else {
                    res.status(apiRes.statusCode).json({ 
                        error: `API error: ${apiRes.statusCode} ${apiRes.statusMessage}`,
                        details: data
                    });
                }
            });
        });
        
        apiReq.on('error', (error) => {
            log('Test connection error:', error);
            res.status(500).json({ error: `Connection error: ${error.message}` });
        });
        
        apiReq.write(JSON.stringify(options.body));
        apiReq.end();
        
    } catch (error) {
        log('Test connection endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
});

// PROFILES API ENDPOINTS

// Get all profiles and active profile
router.get('/profiles', (req, res) => {
    try {
        const profilesData = loadProfiles();
        res.json(profilesData);
    } catch (error) {
        log('[PROFILES] Get profiles error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Switch to a different profile
router.post('/profiles/switch', (req, res) => {
    try {
        const { profileName } = req.body;
        
        if (!profileName) {
            return res.status(400).json({ error: 'Profile name is required' });
        }
        
        const result = switchProfile(profileName);
        
        if (result.success) {
            res.json({ success: true, message: `Switched to profile: ${profileName}` });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        log('[PROFILES] Switch profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save current settings as a new profile
router.post('/profiles/save', (req, res) => {
    try {
        const { profileName, settings } = req.body;
        
        if (!profileName || !settings) {
            return res.status(400).json({ error: 'Profile name and settings are required' });
        }
        
        const result = saveAsProfile(profileName, settings);
        
        if (result.success) {
            res.json({ success: true, message: `Profile saved: ${profileName}` });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        log('[PROFILES] Save profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a profile
router.delete('/profiles/:profileName', (req, res) => {
    try {
        const { profileName } = req.params;
        
        const result = deleteProfile(profileName);
        
        if (result.success) {
            res.json({ success: true, message: `Profile deleted: ${profileName}` });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        log('[PROFILES] Delete profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

// UI state (last active chat, etc.)
router.get('/ui-state', (req, res) => {
    res.json(loadUiState());
});

router.post('/ui-state', (req, res) => {
    try {
        saveUiState(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;