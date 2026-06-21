// Project routes - Handle project CRUD operations
const express = require('express');
const { db } = require('../config/database');
const { log } = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

function generateId() {
    return crypto.randomUUID();
}

// Get all projects
router.get('/projects', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
        const projects = (rows || []).map(row => ({
            id: row.id,
            name: row.name,
            path: row.path,
            created_at: row.created_at
        }));
        log(`[PROJECTS] Found ${projects.length} projects`);
        res.json(projects);
    } catch (err) {
        log('[PROJECTS] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Create a new project
router.post('/projects', (req, res) => {
    const { name, path } = req.body;
    
    if (!name || !path) {
        return res.status(400).json({ error: 'name and path are required' });
    }
    
    try {
        const projectId = generateId();
        const stmt = db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)');
        stmt.run(projectId, name, path);
        
        log(`[PROJECT] Created project: ${projectId} - ${name} (${path})`);
        res.json({ id: projectId, name, path, created_at: new Date().toISOString() });
    } catch (err) {
        log('[PROJECT] Create error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete a project (orphan all its chats)
router.delete('/projects/:id', (req, res) => {
    const projectId = req.params.id;
    
    try {
        const tx = db.transaction(() => {
            db.prepare('UPDATE chats SET project_id = NULL WHERE project_id = ?').run(projectId);
            db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
        });
        tx();
        
        log(`[PROJECT] Deleted project: ${projectId} (chats orphaned)`);
        res.json({ success: true });
    } catch (err) {
        log('[PROJECT] Delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get project info for a specific chat — returns projectId and projectPath
// if the chat is project-scoped, or null if it's a freeform chat.
router.get('/chat/:chatId/project', (req, res) => {
    const chatId = req.params.chatId;

    try {
        const chat = db.prepare('SELECT project_id FROM chats WHERE id = ?').get(chatId);

        if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
        }

        if (!chat.project_id) {
            // Freeform chat — no project path
            return res.json({ projectId: null, projectPath: null });
        }

        const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(chat.project_id);

        if (!project) {
            // Project was deleted but chat still references it
            return res.json({ projectId: chat.project_id, projectPath: null });
        }

        res.json({ projectId: chat.project_id, projectPath: project.path });
    } catch (err) {
        log('[PROJECT] Chat project lookup error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
