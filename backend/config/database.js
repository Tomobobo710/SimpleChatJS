// Database configuration and setup
const Database = require('better-sqlite3');
const path = require('path');
const { log } = require('../utils/logger');
const fs = require('fs');

// Ensure userdata directory exists
let userdataDir;
if (process.env.PORTABLE_USERDATA_PATH) {
    // Electron portable mode - use path set by main process
    userdataDir = process.env.PORTABLE_USERDATA_PATH;
} else {
    // Running as normal Node.js - use project directory
    userdataDir = path.join(__dirname, '..', '..', 'userdata');
}
if (!fs.existsSync(userdataDir)) {
    fs.mkdirSync(userdataDir, { recursive: true });
}

// Database file path
const dbPath = path.join(userdataDir, 'chats.db');

// Database connection - initialize immediately with basic connection
// This ensures db is never undefined when imported
let db = new Database(dbPath);

// Initialize database schema
function initializeDatabase() {
    return new Promise((resolve, reject) => {
        try {
            db.exec(`CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                turn_number INTEGER DEFAULT 0,
                project_id TEXT DEFAULT NULL
            )`);
            
           db.exec(`CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )`);
            
          db.exec(`CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            
          db.exec(`CREATE TABLE IF NOT EXISTS chat_branches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                branch_name TEXT NOT NULL,
                parent_branch_id INTEGER,
                branch_point_turn INTEGER,
                is_active BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(chat_id, branch_name),
                FOREIGN KEY (chat_id) REFERENCES chats (id),
                FOREIGN KEY (parent_branch_id) REFERENCES chat_branches (id)
            )`);
            
           db.exec(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch_id INTEGER NOT NULL,
                original_message_id INTEGER,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                turn_number INTEGER NOT NULL,
                tool_calls TEXT,
                tool_call_id TEXT,
                tool_name TEXT,
                debug_data TEXT,
                edit_count INTEGER DEFAULT 0,
                edited_at DATETIME,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                original_content TEXT,
                file_metadata TEXT,
                error_state TEXT DEFAULT NULL,
                FOREIGN KEY (branch_id) REFERENCES chat_branches (id)
            )`);
            
            log('[DB] Database initialized successfully');
            resolve();
        } catch (err) {
            log('[DB] Error initializing database:', err.message);
            reject(err);
        }
    });
}

// Graceful database shutdown
function closeDatabase() {
    return new Promise((resolve) => {
        try {
            if (db) {
                db.close();
                log('[DATABASE] Closed successfully.');
            }
            resolve();
        } catch (err) {
            log('[DATABASE] Error closing database:', err.message);
            resolve();
        }
    });
}

module.exports = {
    db,  // Export the database instance directly
    initializeDatabase,
    closeDatabase
};
