// Debug routes - Handle debug data and tool events
const express = require('express');
const { handleDebugDataRequest, handleToolEventsStream } = require('../services/toolEventService');
const { log } = require('../utils/logger');

const router = express.Router();

// Debug data endpoint - completely separate from content
router.get('/debug/:messageId', handleDebugDataRequest);

// Tool events endpoint - Server-Sent Events for real-time tool data
router.get('/tools/:messageId', handleToolEventsStream);

// Logging endpoint for frontend
router.post('/log', (req, res) => {
    try {
        const { level, component, message, data, timestamp } = req.body;
        const logMessage = `[${timestamp}] [${level}] [${component}] ${message}`;
        if (data) {
            console.log(logMessage, data);
        } else {
            console.log(logMessage);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;