// Debug routes - Handle debug data and tool events
const express = require('express');
const { handleToolEventsStream } = require('../services/toolEventService');
const { db } = require('../config/database');
const { log } = require('../utils/logger');

const router = express.Router();

// Database schema debug endpoint
// Only expose tables that are known to be safe for inspection.
const ALLOWED_DEBUG_TABLES = new Set(['chats', 'messages', 'projects', 'chat_branch_selections', 'mcp_servers', 'turn_debug']);

router.get('/debug/schema', (req, res) => {
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        const result = {};
        for (const { name } of tables) {
            if (!ALLOWED_DEBUG_TABLES.has(name)) {
                log(`[DEBUG-SCHEMA] Skipping table: ${name} (not in allowed list)`);
                continue;
            }
            const columns = db.prepare(`PRAGMA table_info(${name})`).all();
            const rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${name}`).get();
            const sample = db.prepare(`SELECT * FROM ${name} LIMIT 20`).all();
            // Exclude large debug_data columns from sample output
            const debugColumns = new Set(['debug_data', 'file_metadata']);
            const cleanSample = sample.map(row => {
                const cleaned = { ...row };
                for (const col of debugColumns) {
                    if (col in cleaned) delete cleaned[col];
                }
                return cleaned;
            });
            result[name] = {
                columns: columns.map(c => c.name),
                count: rowCount.count,
                data: cleanSample
            };
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get request debug data for a turn (returns the sequence part)
router.get('/debug/request/:chatId/:turnId', (req, res) => {
    const { chatId, turnId } = req.params;
    try {
        const stmt = db.prepare(`
            SELECT debug_data FROM turn_debug
            WHERE chat_id = ? AND turn_id = ?
        `);
        const row = stmt.get(chatId, turnId);
        
        if (row && row.debug_data) {
            try {
                const data = JSON.parse(row.debug_data);
                // Return just the request part (sequence for request debug)
                return res.json(data);
            } catch (_) {}
        }
        res.status(404).json({ error: 'Request debug not found' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get response debug data for a turn (returns array of responses)
router.get('/debug/response/:chatId/:turnId', (req, res) => {
    const { chatId, turnId } = req.params;
    try {
        const stmt = db.prepare(`
            SELECT debug_data FROM turn_debug
            WHERE chat_id = ? AND turn_id = ?
        `);
        const row = stmt.get(chatId, turnId);
        
        if (row && row.debug_data) {
            try {
                const data = JSON.parse(row.debug_data);
                // Return responses array or convert single response to array
                if (data.responses && Array.isArray(data.responses)) {
                    return res.json(data.responses);
                } else if (data.response) {
                    // If there's a single response (old format), wrap it in array
                    return res.json([data]);
                }
            } catch (_) {}
        }
        res.status(404).json({ error: 'Response debug not found' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Tool events endpoint - Server-Sent Events for real-time tool data
router.get('/tools/:requestId', handleToolEventsStream);

// Logging endpoint for frontend
router.post('/log', (req, res) => {
    try {
        const { level, component, message, data } = req.body;
        // Format the message but skip timestamp (log() will add it)
        const logMessage = `[${level}] [${component}] ${message}`;
        // Use the log function to maintain consistency with backend logging
        log(logMessage, data);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;