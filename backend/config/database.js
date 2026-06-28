// Database configuration and setup
const Database = require("better-sqlite3");
const path = require("path");
const { log } = require("../utils/logger");
const fs = require("fs");
const { getUserdataDir } = require("../utils/pathUtils");

// Ensure userdata directory exists
const userdataDir = getUserdataDir();
if (!fs.existsSync(userdataDir)) {
    fs.mkdirSync(userdataDir, { recursive: true });
}

// Database file path
const dbPath = path.join(userdataDir, "chats.db");

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
                project_id TEXT DEFAULT NULL
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
                turn_id TEXT,
                parent_turn_id TEXT,
                tool_calls TEXT,
                tool_call_id TEXT,
                tool_name TEXT,
                reasoning TEXT,
                edit_count INTEGER DEFAULT 0,
                edited_at DATETIME,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                original_content TEXT,
                file_metadata TEXT,
                error_state TEXT DEFAULT NULL,
                edit_history TEXT DEFAULT '[]',
                active_edit_version INTEGER DEFAULT 0,
                turn_type TEXT DEFAULT NULL,
                debug_data TEXT DEFAULT NULL,
                FOREIGN KEY (chat_id) REFERENCES chats (id)
            )`);

            // Indexes for lineage-based lookups used by branch navigation
            // and history filtering.
            db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_turn ON messages(chat_id, turn_id)");
            db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_parent ON messages(chat_id, parent_turn_id)");

            // Persisted branch navigation selections per chat. Keys are
            // `${chatId}::parentKey` (parentKey = 'root' or a turn_id).
            // One row per (chat_id, parent_key); chat delete cleans up
            // explicitly to match the messages table pattern.
            db.exec(`CREATE TABLE IF NOT EXISTS chat_branch_selections (
                chat_id TEXT NOT NULL,
                parent_key TEXT NOT NULL,
                selected_turn_id TEXT NOT NULL,
                PRIMARY KEY (chat_id, parent_key)
            )`);

            log("[DB] Database initialized successfully");
            resolve();
        } catch (err) {
            log("[DB] Error initializing database:", err.message);
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
                log("[DATABASE] Closed successfully.");
            }
            resolve();
        } catch (err) {
            log("[DATABASE] Error closing database:", err.message);
            resolve();
        }
    });
}

module.exports = {
    db, // Export the database instance directly
    initializeDatabase,
    closeDatabase
};
