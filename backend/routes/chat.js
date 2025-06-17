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
    
    try {
        const rows = db.prepare(query).all();
        log(`[CHATS] Found ${rows ? rows.length : 0} chats:`, rows);
        // Transform the data to match frontend expectations
        const chats = (rows || []).map(row => ({
            chat_id: row.id,
            title: row.title,
            last_message: row.last_message || '',
            last_updated: row.updated_at || row.created_at
        }));
        res.json(chats);
    } catch (err) {
        log('[CHATS] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Create new chat
router.post('/chats', (req, res) => {
    const { chat_id, title } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    try {
        const stmt = db.prepare('INSERT OR REPLACE INTO chats (id, title, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)');
        const result = stmt.run(chat_id, title || 'New Chat');
        res.json({ success: true, chat_id });
    } catch (err) {
        log('[CHAT] Create error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get chat history
router.get('/chat/:id/history', (req, res) => {
    const chatId = req.params.id;
    
    try {
        const stmt = db.prepare('SELECT role, content, timestamp, debug_data, blocks FROM messages WHERE chat_id = ? ORDER BY timestamp ASC');
        const rows = stmt.all(chatId);
        
        const messages = (rows || []).map(row => ({
            role: row.role,
            content: row.content,
            debug_data: row.debug_data ? JSON.parse(row.debug_data) : null,
            blocks: row.blocks ? JSON.parse(row.blocks) : null
        }));
        res.json({ messages });
    } catch (err) {
        log('[HISTORY] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete chat
router.delete('/chat/:id', (req, res) => {
    const chatId = req.params.id;
    
    try {
        // Begin transaction
        db.prepare('BEGIN TRANSACTION').run();
        
        // First delete all messages for this chat
        const deleteMessages = db.prepare('DELETE FROM messages WHERE chat_id = ?');
        deleteMessages.run(chatId);
        
        // Then delete the chat itself
        const deleteChat = db.prepare('DELETE FROM chats WHERE id = ?');
        deleteChat.run(chatId);
        
        // Commit transaction
        db.prepare('COMMIT').run();
        
        log(`[CHAT] Deleted chat: ${chatId}`);
        res.json({ success: true });
    } catch (err) {
        // Rollback on error
        try { db.prepare('ROLLBACK').run(); } catch (rollbackErr) { /* ignore */ }
        
        log('[CHAT] Error deleting chat:', err);
        res.status(500).json({ error: err.message });
    }
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
        
        // Begin transaction
        db.prepare('BEGIN TRANSACTION').run();
        
        // Insert message
        const insertStmt = db.prepare('INSERT INTO messages (chat_id, role, content, debug_data, blocks) VALUES (?, ?, ?, ?, ?)');
        const result = insertStmt.run(chat_id, role, content, debugDataJson, blocksJson);
        
        // Update chat timestamp
        const updateStmt = db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        updateStmt.run(chat_id);
        
        // Commit transaction
        db.prepare('COMMIT').run();
        
        res.json({ success: true, messageId: result.lastInsertRowid });
        
    } catch (error) {
        // Rollback on error
        try { db.prepare('ROLLBACK').run(); } catch (rollbackErr) { /* ignore */ }
        
        log('[MESSAGE] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update chat title
router.patch('/chat/:id/title', (req, res) => {
    const chatId = req.params.id;
    const { title } = req.body;
    
    if (!title) {
        return res.status(400).json({ error: 'title is required' });
    }
    
    try {
        const stmt = db.prepare('UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const result = stmt.run(title, chatId);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        
        log(`[CHAT] Updated title for chat ${chatId} to "${title}"`);
        res.json({ success: true, chat_id: chatId, title: title });
    } catch (err) {
        log('[CHAT] Error updating title:', err);
        res.status(500).json({ error: err.message });
    }
});

// Main chat endpoint that frontend expects
router.post('/chat', processChatRequest);

module.exports = router;