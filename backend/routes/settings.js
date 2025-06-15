// Settings routes - Handle application settings
const express = require('express');
const { loadSettings, saveSettings, getDefaultSettings } = require('../services/settingsService');

const router = express.Router();

// Get settings
router.get('/settings', (req, res) => {
    try {
        const settings = loadSettings();
        if (settings.error) {
            res.status(500).json({ error: settings.error });
        } else {
            res.json(settings);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save settings
router.post('/settings', (req, res) => {
    try {
        const result = saveSettings(req.body);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;