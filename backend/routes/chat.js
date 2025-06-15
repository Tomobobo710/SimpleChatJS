// Chat routes - Handle chat operations and messaging
const express = require('express');
const { db } = require('../config/database');
const { processChatRequest } = require('../services/chatService');
const { log } = require('../utils/logger');

const router = express.Router();

// Get all chats
router.get('/chats', (req, res) => {
    // Get chats with their last message
    const query = `
        SELECT 
            c.id,
            c.title,
            c.created_at,
            c.updated_at,
            COALESCE(m.content, '') as last_message
        FROM chats c
        LEFT JOIN (
            SELECT 
                chat_id,
                content,
                ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp DESC) as rn
            FROM messages
            WHERE role = 'user'
        ) m ON c.id = m.chat_id AND m.rn = 1
        ORDER BY c.updated_at DESC
    `;
    
    db.all(query, (err, rows) => {
        if (err) {
            log('[CHATS] List error:', err);
            res.status(500).json({ error: err.message });
        } else {
            log(`[CHATS] Found ${rows ? rows.length : 0} chats:`, rows);
            // Transform the data to match frontend expectations
            const chats = (rows || []).map(row => ({
                chat_id: row.id,
                title: row.title,
                last_message: row.last_message || '',
                last_updated: row.updated_at || row.created_at
            }));
            res.json(chats);
        }
    });
});

// Create new chat
router.post('/chats', (req, res) => {
    const { chat_id, title } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    db.run(
        'INSERT OR REPLACE INTO chats (id, title, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [chat_id, title || 'New Chat'],
        function(err) {
            if (err) {
                log('[CHAT] Create error:', err);
                res.status(500).json({ error: err.message });
            } else {
                res.json({ success: true, chat_id });
            }
        }
    );
});

// Get chat history
router.get('/chat/:id/history', (req, res) => {
    const chatId = req.params.id;
    
    db.all(
        'SELECT role, content, timestamp, debug_data, blocks FROM messages WHERE chat_id = ? ORDER BY timestamp ASC',
        [chatId],
        (err, rows) => {
            if (err) {
                log('[HISTORY] Error:', err);
                res.status(500).json({ error: err.message });
            } else {
                const messages = (rows || []).map(row => ({
                    role: row.role,
                    content: row.content,
                    debug_data: row.debug_data ? JSON.parse(row.debug_data) : null,
                    blocks: row.blocks ? JSON.parse(row.blocks) : null
                }));
                res.json({ messages });
            }
        }
    );
});

// Delete chat
router.delete('/chat/:id', (req, res) => {
    const chatId = req.params.id;
    
    // First delete all messages for this chat
    db.run(
        'DELETE FROM messages WHERE chat_id = ?',
        [chatId],
        function(err) {
            if (err) {
                log('[CHAT] Error deleting messages:', err);
                res.status(500).json({ error: err.message });
                return;
            }
            
            // Then delete the chat itself
            db.run(
                'DELETE FROM chats WHERE id = ?',
                [chatId],
                function(err) {
                    if (err) {
                        log('[CHAT] Error deleting chat:', err);
                        res.status(500).json({ error: err.message });
                    } else {
                        log(`[CHAT] Deleted chat: ${chatId}`);
                        res.json({ success: true });
                    }
                }
            );
        }
    );
});

// Save message
router.post('/message', async (req, res) => {
    try {
        const { chat_id, role, content, debug_data, blocks } = req.body;
        
        if (!chat_id || !role || content === null || content === undefined) {
            return res.status(400).json({ error: 'chat_id, role, and content are required' });
        }
        
        // Save message with optional debug data and blocks
        const debugDataJson = debug_data ? JSON.stringify(debug_data) : null;
        const blocksJson = blocks ? JSON.stringify(blocks) : null;
        db.run(
            'INSERT INTO messages (chat_id, role, content, debug_data, blocks) VALUES (?, ?, ?, ?, ?)',
            [chat_id, role, content, debugDataJson, blocksJson],
            function(err) {
                if (err) {
                    log('[MESSAGE] Save error:', err);
                    res.status(500).json({ error: err.message });
                } else {
                    res.json({ success: true, messageId: this.lastID });
                }
            }
        );
        
        // Update chat timestamp
        db.run(
            'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [chat_id]
        );
        
    } catch (error) {
        log('[MESSAGE] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Main chat endpoint that frontend expects
router.post('/chat', processChatRequest);

module.exports = router;