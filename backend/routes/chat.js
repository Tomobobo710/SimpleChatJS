// Chat routes - Handle chat operations and messaging
const express = require('express');
const { db } = require('../config/database');
const { processChatRequest, saveTurnDebugData, getTurnDebugData, getAllTurnDebugData } = require('../services/chatService');
const { log } = require('../utils/logger');

const router = express.Router();

// Get all chats
router.get('/chats', (req, res) => {
    // Get chats with their last message content
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
        // Get message data directly from columns
        const stmt = db.prepare('SELECT role, content, timestamp, blocks, turn_number FROM messages WHERE chat_id = ? ORDER BY timestamp ASC');
        const rows = stmt.all(chatId);
        
        // Get all turn data for this chat
        const turnDataMap = getAllTurnDebugData(chatId);
        
        const messages = (rows || []).map(row => {
            // Get turn data from the turn-based storage
            const turnData = row.turn_number ? turnDataMap[row.turn_number] : null;
            
            // Build message object from direct columns
            return {
                role: row.role,
                content: row.content,
                timestamp: row.timestamp,
                turn_number: row.turn_number,
                debug_data: turnData, // Now comes from turn-based storage
                blocks: row.blocks ? JSON.parse(row.blocks) : null
            };
        });
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

// Save message using unified approach
router.post('/message', async (req, res) => {
    try {
        const { chat_id, role, content, turn_number, blocks, tool_calls, tool_call_id, tool_name } = req.body;
        
        if (!chat_id || !role || content === null || content === undefined) {
            return res.status(400).json({ error: 'chat_id, role, and content are required' });
        }
        
        // Create complete message structure with all possible fields
        const completeMessage = {
            role: role,
            content: content
        };
        
        // Add tool-specific fields if present
        if (tool_calls) completeMessage.tool_calls = tool_calls;
        if (tool_call_id) completeMessage.tool_call_id = tool_call_id;
        if (tool_name) completeMessage.tool_name = tool_name;
        
        // Use the unified save function
        const { saveCompleteMessageToDatabase, incrementTurnNumber } = require('../services/chatService');
        // Use turn number provided by frontend
        await saveCompleteMessageToDatabase(chat_id, completeMessage, blocks, turn_number);
        
        // Increment turn number when user sends a message (starts new conversation turn)
        if (role === 'user') {
            incrementTurnNumber(chat_id);
        }
        
        res.json({ success: true });
        
    } catch (error) {
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

// Get clean chat history in API format (for user debug panels)
router.get('/chat/:id/api-history', (req, res) => {
    const chatId = req.params.id;
    
    try {
        const { getChatHistoryForAPI } = require('../services/chatService');
        const apiHistory = getChatHistoryForAPI(chatId);
        res.json(apiHistory);
    } catch (err) {
        log('[API-HISTORY] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get current turn number for a chat
router.get('/chat/:id/current-turn', (req, res) => {
    const { id: chatId } = req.params;
    
    try {
        const { getCurrentTurnNumber } = require('../services/chatService');
        const turnNumber = getCurrentTurnNumber(chatId);
        res.json({ turn_number: turnNumber });
    } catch (err) {
        log('[CURRENT-TURN] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Update debug data for a message
router.patch('/message/debug', async (req, res) => {
    try {
        const { chat_id, role, turn_number, debug_data } = req.body;
        
        if (!chat_id || !role || !turn_number) {
            return res.status(400).json({ error: 'chat_id, role, and turn_number are required' });
        }
        
        const { updateMessageDebugData } = require('../services/chatService');
        await updateMessageDebugData(chat_id, role, turn_number, debug_data);
        
        res.json({ success: true });
        
    } catch (error) {
        log('[UPDATE-DEBUG] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Turn data endpoints (RESTful design)
// Save turn data
router.post('/chat/:id/turns/:turnNumber', async (req, res) => {
    try {
        const { id: chatId, turnNumber } = req.params;
        const { data } = req.body;
        const turnNum = parseInt(turnNumber, 10);
        
        if (isNaN(turnNum)) {
            return res.status(400).json({ error: 'Invalid turn number' });
        }
        
        if (!data) {
            return res.status(400).json({ error: 'data is required' });
        }
        
        await saveTurnDebugData(chatId, turnNum, data);
        res.json({ success: true });
        
    } catch (error) {
        log('[TURN-DATA-SAVE] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get turn data
router.get('/chat/:id/turns/:turnNumber', (req, res) => {
    try {
        const { id: chatId, turnNumber } = req.params;
        const turnNum = parseInt(turnNumber, 10);
        
        if (isNaN(turnNum)) {
            return res.status(400).json({ error: 'Invalid turn number' });
        }
        
        const turnData = getTurnDebugData(chatId, turnNum);
        
        if (turnData) {
            res.json(turnData);
        } else {
            res.status(404).json({ error: 'Turn data not found' });
        }
        
    } catch (error) {
        log('[TURN-DATA-GET] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all turn data for a chat
router.get('/chat/:id/turns', (req, res) => {
    try {
        const { id: chatId } = req.params;
        
        const turnDataMap = getAllTurnDebugData(chatId);
        res.json(turnDataMap);
        
    } catch (error) {
        log('[ALL-TURN-DATA] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Main chat endpoint that frontend expects
router.post('/chat', processChatRequest);

module.exports = router;
