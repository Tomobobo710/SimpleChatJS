// Database configuration and setup
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { log } = require('../utils/logger');

// Database setup - store in userdata directory
const db = new sqlite3.Database(path.join(__dirname, '..', '..', 'userdata', 'chats.db'));

// Initialize database
function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (chat_id) REFERENCES chats (id)
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )`);
            
            // Add debug_data column to messages table if it doesn't exist
            db.run(`ALTER TABLE messages ADD COLUMN debug_data TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    log('[DB] Error adding debug_data column:', err.message);
                }
            });
            
            // Add blocks column to messages table if it doesn't exist
            db.run(`ALTER TABLE messages ADD COLUMN blocks TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    log('[DB] Error adding blocks column:', err.message);
                } else {
                    log('[DB] Database initialized successfully');
                    resolve();
                }
            });
        });
    });
}

// Graceful database shutdown
function closeDatabase() {
    return new Promise((resolve) => {
        db.close((err) => {
            if (err) {
                log('[DATABASE] Error closing database:', err);
            } else {
                log('[DATABASE] Closed successfully.');
            }
            resolve();
        });
    });
}

module.exports = {
    db,
    initializeDatabase,
    closeDatabase
};