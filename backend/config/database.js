// Database configuration and setup
const Database = require('better-sqlite3');
const path = require('path');
const { log } = require('../utils/logger');
const fs = require('fs');

// Ensure userdata directory exists
const userdataDir = path.join(__dirname, '..', '..', 'userdata');
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
            // Create tables
            db.exec(`CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            
            db.exec(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chat_id) REFERENCES chats (id)
            )`);
            
            db.exec(`CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )`);
            
            // Add columns if they don't exist
            try {
                db.exec(`ALTER TABLE messages ADD COLUMN debug_data TEXT`);
            } catch (err) {
                // Column likely already exists
                if (!err.message.includes('duplicate column name')) {
                    log('[DB] Error adding debug_data column:', err.message);
                }
            }
            
            try {
                db.exec(`ALTER TABLE messages ADD COLUMN blocks TEXT`);
            } catch (err) {
                // Column likely already exists
                if (!err.message.includes('duplicate column name')) {
                    log('[DB] Error adding blocks column:', err.message);
                }
            }
            
            // Add turn_number column for grouping messages into turns
            try {
                db.exec(`ALTER TABLE messages ADD COLUMN turn_number INTEGER`);
            } catch (err) {
                // Column likely already exists
                if (!err.message.includes('duplicate column name')) {
                    log('[DB] Error adding turn_number column:', err.message);
                }
            }
            
            // Add turn_number to chats table for proper turn tracking
            try {
                db.exec(`ALTER TABLE chats ADD COLUMN turn_number INTEGER DEFAULT 0`);
            } catch (err) {
                // Column likely already exists
                if (!err.message.includes('duplicate column name')) {
                    log('[DB] Error adding turn_number to chats:', err.message);
                }
            }
            
            // Create turn_debug_data table for turn-based debug storage
            db.exec(`CREATE TABLE IF NOT EXISTS turn_debug_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                turn_number INTEGER NOT NULL,
                debug_data TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(chat_id, turn_number),
                FOREIGN KEY (chat_id) REFERENCES chats (id)
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