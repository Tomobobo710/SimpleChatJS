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
            
          db.exec(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                original_message_id INTEGER,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                turn_number INTEGER NOT NULL,
                turn_id TEXT,
                parent_turn_id TEXT,
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
                FOREIGN KEY (chat_id) REFERENCES chats (id)
            )`);

            // Indexes for lineage-based queries (L5).
            // The (chat_id, turn_id) and (chat_id, parent_turn_id) pairs are
            // the two lookup shapes used by buildRenderedTurns,
            // getAncestorTurnIds, and the retry/edit-retry history filter.
            db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_turn ON messages(chat_id, turn_id)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_parent ON messages(chat_id, parent_turn_id)");

            // Per-chat branch navigation selections (Phase 5+, persistence
            // follow-up). The frontend's selectedSiblings map is keyed on
            // `${chatId}::${parentKey}` (Phase 5 M2) where parentKey is
            // 'root' or a turn_id. This table stores the same shape so
            // selections survive reloads/restarts. PRIMARY KEY enforces
            // one row per (chat, parent_key); no FK CASCADE — chat delete
            // (chat.js:371) cleans up explicitly in its transaction to
            // match the messages table pattern.
            db.exec(`CREATE TABLE IF NOT EXISTS chat_branch_selections (
                chat_id TEXT NOT NULL,
                parent_key TEXT NOT NULL,
                selected_turn_id TEXT NOT NULL,
                PRIMARY KEY (chat_id, parent_key)
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
