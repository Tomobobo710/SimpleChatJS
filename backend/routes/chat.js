// Chat routes - Handle chat operations and messaging
const express = require('express');
const { exec, all, get } = require('../config/database');
const {
    processChatRequest,
    saveTurnDebugData,
    getTurnDebugData,
    getAllTurnDebugData,
    createChatBranch,
    getChatBranches,
    getActiveChatBranch,
    setActiveChatBranch,
    getChatHistoryForAPI,
    getCurrentTurnNumber
} = require('../services/chatService');
const { log } = require('../utils/logger');

const router = express.Router();

// Get all chats (everything-is-a-branch system)
router.get('/chats', async (req, res) => {
    // Get chats with their last message content from active branches
    const query = `
        SELECT 
            c.id,
            c.title,
            c.created_at,
            c.updated_at,
            COALESCE(bm.content, '') as last_message
        FROM chats c
        LEFT JOIN chat_branches cb ON c.id = cb.chat_id AND cb.is_active = TRUE
        LEFT JOIN (
            SELECT 
                branch_id,
                content,
                ROW_NUMBER() OVER (PARTITION BY branch_id ORDER BY timestamp DESC) as rn
            FROM branch_messages
            WHERE role = 'user'
        ) bm ON cb.id = bm.branch_id AND bm.rn = 1
        ORDER BY c.updated_at DESC
    `;
    
    try {
        const rows = await all(query);
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

// Create new chat (everything-is-a-branch system)
router.post('/chats', async (req, res) => {
    const { chat_id, title } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    try {
        // Create or update chat in chats table
        await exec(
            'INSERT OR REPLACE INTO chats (id, title, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
            [chat_id, title || 'New Chat']
        );

        // ALWAYS create a main branch for every new chat (everything-is-a-branch)

        // Check if main branch already exists
        const existingBranch = await get(`
            SELECT id FROM chat_branches
            WHERE chat_id = ? AND branch_name = 'main'
        `, [chat_id]);

        if (!existingBranch) {
            // Create main branch for this chat
            const newBranch = await createChatBranch(chat_id);
            await setActiveChatBranch(chat_id, newBranch.branchId);
            log(`[CHAT-CREATE] Created main branch for new chat ${chat_id}`);
        }

        res.json({ success: true, chat_id });
    } catch (err) {
        log('[CHAT] Create error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get chat history (everything-is-a-branch system)
router.get('/chat/:id/history', async (req, res) => {
    const chatId = req.params.id;
    
    try {
        // Everything-is-a-branch: Always use active branch
        log(`[HISTORY] Getting history from active branch for chat ${chatId}`);

        // Get the active branch
        const activeBranch = await get(`
            SELECT id, branch_name
            FROM chat_branches
            WHERE chat_id = ? AND is_active = TRUE
            LIMIT 1
        `, [chatId]);

        if (!activeBranch) {
            log(`[HISTORY] No active branch found for chat ${chatId} - this shouldn't happen in everything-is-a-branch system`);
            return res.json({ messages: [] });
        }

        // Get all messages from the active branch (debug data is now stored directly in branch_messages)
        const branchMessages = await all(`
            SELECT id, original_message_id, role, content, turn_number, tool_calls, tool_call_id, tool_name, blocks, debug_data, edit_count, edited_at, timestamp
            FROM branch_messages
            WHERE branch_id = ?
            ORDER BY timestamp ASC
        `, [activeBranch.id]);

        const messages = branchMessages.map(row => {
            const parsedBlocks = row.blocks ? JSON.parse(row.blocks) : null;
            const debugData = row.debug_data ? JSON.parse(row.debug_data) : null;
            
            log(`[HISTORY] Loading blocks for ${row.role} message in turn ${row.turn_number}:`, parsedBlocks ? parsedBlocks.map(b => ({ type: b.type, id: b.id })) : 'null');
            
            const message = {
                id: row.original_message_id || row.id, // Use original ID if available for editing compatibility
                role: row.role,
                content: row.content,
                timestamp: row.timestamp,
                turn_number: row.turn_number,
                edit_count: row.edit_count || 0,
                edited_at: row.edited_at,
                debug_data: debugData,
                blocks: parsedBlocks
            };
            
            // Add tool data if present
            if (row.tool_calls) {
                try {
                    message.tool_calls = JSON.parse(row.tool_calls);
                } catch (e) {
                    log(`[HISTORY] Error parsing tool_calls: ${e.message}`);
                }
            }
            if (row.tool_call_id) {
                message.tool_call_id = row.tool_call_id;
            }
            if (row.tool_name) {
                message.tool_name = row.tool_name;
            }
            
            return message;
        });
        
        log(`[HISTORY] Retrieved ${messages.length} messages from branch '${activeBranch.branch_name}'`);
        res.json({ messages });
        
    } catch (err) {
        log('[HISTORY] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete chat
router.delete('/chat/:id', async (req, res) => {
    const chatId = req.params.id;
    
    try {
        // Everything-is-a-branch: Delete all branch messages and branches for this chat, then chat
        await exec(`
            DELETE FROM branch_messages
            WHERE branch_id IN (SELECT id FROM chat_branches WHERE chat_id = ?)
        `, [chatId]);

        await exec('DELETE FROM chat_branches WHERE chat_id = ?', [chatId]);
        await exec('DELETE FROM chats WHERE id = ?', [chatId]);

        log(`[CHAT] Deleted chat: ${chatId}`);
        res.json({ success: true });
    } catch (err) {
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
            await incrementTurnNumber(chat_id);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        log('[MESSAGE] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update chat title
router.patch('/chat/:id/title', async (req, res) => {
    const chatId = req.params.id;
    const { title } = req.body;

    if (!title) {
        return res.status(400).json({ error: 'title is required' });
    }

    try {
        const result = await exec(
            'UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [title, chatId]
        );

        // exec wrapper does not expose changes; verify via SELECT
        const updated = await get('SELECT id FROM chats WHERE id = ?', [chatId]);
        if (!updated) {
            return res.status(404).json({ error: 'Chat not found' });
        }

        log(`[CHAT] Updated title for chat ${chatId} to "${title}"`);
        res.json({ success: true, chat_id: chatId, title });
    } catch (err) {
        log('[CHAT] Error updating title:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get clean chat history in API format (for user debug panels)
router.get('/chat/:id/api-history', async (req, res) => {
    const chatId = req.params.id;
    
    try {
        const apiHistory = await getChatHistoryForAPI(chatId);
        res.json(apiHistory);
    } catch (err) {
        log('[API-HISTORY] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get current turn number for a chat
router.get('/chat/:id/current-turn', async (req, res) => {
    const { id: chatId } = req.params;
    
    try {
        const turnNumber = await getCurrentTurnNumber(chatId);
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
router.get('/chat/:id/turns/:turnNumber', async (req, res) => {
    try {
        const { id: chatId, turnNumber } = req.params;
        const turnNum = parseInt(turnNumber, 10);
        
        if (isNaN(turnNum)) {
            return res.status(400).json({ error: 'Invalid turn number' });
        }
        
        const turnData = await getTurnDebugData(chatId, turnNum);
        
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

// Get messages for a specific turn
router.get('/chat/:id/turn/:turnNumber', async (req, res) => {
    try {
        const { id: chatId, turnNumber } = req.params;
        const turnNum = parseInt(turnNumber, 10);
        
        if (isNaN(turnNum)) {
            return res.status(400).json({ error: 'Invalid turn number' });
        }
        
        // Get all messages for this turn from the current active branch
        // First, get the active branch for this chat
        const activeBranch = await get(`
            SELECT id FROM chat_branches
            WHERE chat_id = ? AND is_active = TRUE
            LIMIT 1
        `, [chatId]);
        
        let messages = [];
        
        if (activeBranch) {
            // Get messages from the active branch
            log(`[TURN-MESSAGES] Getting messages from active branch ${activeBranch.id} for turn ${turnNum}`);
            messages = await all(`
                SELECT id, role, content, timestamp, blocks, turn_number,
                       edit_count, edited_at
                FROM branch_messages
                WHERE branch_id = ? AND turn_number = ?
                ORDER BY timestamp ASC
            `, [activeBranch.id, turnNum]);
        } else {
            // Everything-is-a-branch: No active branch should never happen
            log(`[TURN-MESSAGES] ERROR: No active branch found for chat ${chatId} - this violates everything-is-a-branch principle`);
            return res.status(500).json({ error: `No active branch found for chat ${chatId}. Every chat must have a main branch.` });
        }
        
        log(`[TURN-MESSAGES] Found ${messages.length} messages for turn ${turnNum} in chat ${chatId}`);
        
        // Parse blocks for each message
        const processedMessages = messages.map(msg => ({
            ...msg,
            blocks: msg.blocks ? JSON.parse(msg.blocks) : null,
            edit_count: msg.edit_count || 0
        }));
        
        res.json({ messages: processedMessages });
        
    } catch (error) {
        log('[TURN-MESSAGES] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all turn data for a chat
router.get('/chat/:id/turns', async (req, res) => {
    try {
        const { id: chatId } = req.params;
        
        const turnDataMap = await getAllTurnDebugData(chatId);
        res.json(turnDataMap);
        
    } catch (error) {
        log('[ALL-TURN-DATA] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Main chat endpoint that frontend expects
router.post('/chat', processChatRequest);

// ===== TURN VERSIONING ENDPOINTS =====

// Create new branch for retry from a specific turn
router.post('/chat/:id/turn/:turnNumber/retry', async (req, res) => {
    try {
        const { id: chatId, turnNumber } = req.params;
        const turnNum = parseInt(turnNumber, 10);
        
        if (isNaN(turnNum)) {
            return res.status(400).json({ error: 'Invalid turn number' });
        }
        
        const branchInfo = await createChatBranch(chatId, turnNum);
        
        // Set the new branch as active
        await setActiveChatBranch(chatId, branchInfo.branchId);
        
        res.json({ 
            success: true, 
            branchId: branchInfo.branchId,
            branchName: branchInfo.branchName,
            branchPoint: branchInfo.branchPoint
        });
        
    } catch (error) {
        log('[RETRY] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all branches for a chat
router.get('/chat/:id/branches', async (req, res) => {
    try {
        const { id: chatId } = req.params;
        
        const branches = await getChatBranches(chatId);
        const activeBranch = await getActiveChatBranch(chatId);
        
        const responseData = { 
            branches,
            activeBranch,
            totalBranches: branches.length
        };
        
        log(`[BRANCHES] API response for chat ${chatId}: activeBranch=${activeBranch?.branch_name}, totalBranches=${branches.length}`);
        
        res.json(responseData);
        
    } catch (error) {
        log('[BRANCHES] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Switch to a specific branch
router.post('/chat/:id/branch/:branchId/activate', async (req, res) => {
    try {
        const { id: chatId, branchId } = req.params;
        const branchIdNum = parseInt(branchId, 10);
        
        if (isNaN(branchIdNum)) {
            return res.status(400).json({ error: 'Invalid branch ID' });
        }
        
        const success = await setActiveChatBranch(chatId, branchIdNum);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Branch not found' });
        }
        
    } catch (error) {
        log('[ACTIVATE-BRANCH] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

// Edit message content (libsql + branch_messages only)
router.patch('/message/:id', async (req, res) => {
    try {
        const messageId = parseInt(req.params.id, 10);
        const { content } = req.body;

        if (isNaN(messageId)) {
            return res.status(400).json({ error: 'Invalid message ID' });
        }

        if (!content || content.trim() === '') {
            return res.status(400).json({ error: 'Content is required' });
        }

        const { get, exec } = require('../config/database');

        // Look up message in branch_messages (everything-is-a-branch)
        const currentMessage = await get(
            `SELECT id, edit_count
             FROM branch_messages
             WHERE id = ?`,
            [messageId]
        );

        if (!currentMessage) {
            log(`[EDIT] Message ${messageId} not found in branch_messages`);
            return res.status(404).json({ error: 'Message not found' });
        }

        const newEditCount = (currentMessage.edit_count || 0) + 1;

        // Update message in branch_messages
        await exec(
            `UPDATE branch_messages
             SET content = ?,
                 edit_count = ?,
                 edited_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [content, newEditCount, messageId]
        );

        log(`[EDIT] Updated message ${messageId}, edit count: ${newEditCount}`);

        res.json({
            success: true,
            message_id: messageId,
            edit_count: newEditCount
        });

    } catch (error) {
        log('[EDIT] Error updating message:', error);
        res.status(500).json({ error: 'Failed to update message' });
    }
});

// Get message by ID for editing (from branch_messages)
router.get('/message/:id', async (req, res) => {
    try {
        const messageId = parseInt(req.params.id, 10);

        if (isNaN(messageId)) {
            return res.status(400).json({ error: 'Invalid message ID' });
        }

        const { get } = require('../config/database');

        const message = await get(
            `SELECT id, role, content, edit_count, edited_at, turn_number, branch_id
             FROM branch_messages
             WHERE id = ?`,
            [messageId]
        );

        if (!message) {
            return res.status(404).json({ error: 'Message not found' });
        }

        res.json(message);

    } catch (error) {
        log('[GET-MESSAGE] Error:', error);
        res.status(500).json({ error: 'Failed to get message' });
    }
});
