// Database configuration and setup using @libsql/client (libSQL/Turso compatible)
// Local file-based SQLite via libSQL; no native addons, Node 25 friendly.
const { createClient } = require('@libsql/client');
const path = require('path');
const { log } = require('../utils/logger');
const fs = require('fs');

// Ensure userdata directory exists
const userdataDir = path.join(__dirname, '..', '..', 'userdata');
if (!fs.existsSync(userdataDir)) {
    fs.mkdirSync(userdataDir, { recursive: true });
}

// Database file path (libSQL file URL)
const dbPath = path.join(userdataDir, 'chats.db');
const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;

// Create a shared client instance
// Note: libSQL client is async; we wrap operations behind initializeDatabase and helpers.
const client = createClient({
    url: dbUrl
});

async function exec(sql, args = []) {
    await client.execute({ sql, args });
}

async function all(sql, args = []) {
    const result = await client.execute({ sql, args });
    return result.rows;
}

async function get(sql, args = []) {
    const result = await client.execute({ sql, args });
    return result.rows[0] || null;
}

// Initialize database schema and migrations
async function initializeDatabase() {
    try {
        // Create tables
        await exec(`CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            turn_number INTEGER DEFAULT 0
        )`);

        await exec(`CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);

        await exec(`CREATE TABLE IF NOT EXISTS chat_branches (
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

        await exec(`CREATE TABLE IF NOT EXISTS branch_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch_id INTEGER NOT NULL,
            original_message_id INTEGER,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            turn_number INTEGER NOT NULL,
            tool_calls TEXT,
            tool_call_id TEXT,
            tool_name TEXT,
            blocks TEXT,
            debug_data TEXT,
            edit_count INTEGER DEFAULT 0,
            edited_at DATETIME,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (branch_id) REFERENCES chat_branches (id)
        )`);

        // Migration logic rewritten using async helpers (kept functionally similar)
        try {
            log('[DB] Checking for legacy messages/turn_debug_data tables for migration...');

            const oldTableExists = await get(`
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='messages'
            `);

            if (oldTableExists) {
                log('[DB] Found old messages table, migrating data...');

                const chatsWithoutBranch = await all(`
                    SELECT DISTINCT m.chat_id
                    FROM messages m
                    LEFT JOIN chat_branches cb ON m.chat_id = cb.chat_id AND cb.branch_name = 'main'
                    WHERE cb.id IS NULL
                    ORDER BY m.chat_id
                `);

                for (const chat of chatsWithoutBranch) {
                    const insertBranch = await client.execute({
                        sql: `
                            INSERT INTO chat_branches (chat_id, branch_name, parent_branch_id, branch_point_turn, is_active)
                            VALUES (?, 'main', NULL, NULL, TRUE)
                        `,
                        args: [chat.chat_id]
                    });

                    // libSQL client does not expose lastInsertRowid directly in the same way as better-sqlite3;
                    // fetch branch_id via query.
                    const branch = await get(
                        `SELECT id FROM chat_branches WHERE chat_id = ? AND branch_name = 'main'`,
                        [chat.chat_id]
                    );
                    const branchId = branch?.id;

                    if (!branchId) continue;

                    const messages = await all(`
                        SELECT id, role, content, turn_number, tool_calls, tool_call_id, tool_name, blocks, debug_data, edit_count, edited_at, timestamp
                        FROM messages
                        WHERE chat_id = ?
                        ORDER BY timestamp ASC
                    `, [chat.chat_id]);

                    for (const msg of messages) {
                        await exec(`
                            INSERT INTO branch_messages
                            (branch_id, original_message_id, role, content, turn_number, tool_calls, tool_call_id, tool_name, blocks, debug_data, edit_count, edited_at, timestamp)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            branchId,
                            msg.id,
                            msg.role,
                            msg.content,
                            msg.turn_number || 1,
                            msg.tool_calls,
                            msg.tool_call_id,
                            msg.tool_name,
                            msg.blocks,
                            msg.debug_data,
                            msg.edit_count || 0,
                            msg.edited_at,
                            msg.timestamp
                        ]);
                    }

                    log(`[DB] Migrated chat ${chat.chat_id} to main branch with ${messages.length} messages`);
                }

                log('[DB] Migrating debug data to branch messages...');
                const debugDataExists = await get(`
                    SELECT name FROM sqlite_master
                    WHERE type='table' AND name='turn_debug_data'
                `);

                if (debugDataExists) {
                    const debugDataRows = await all(`
                        SELECT chat_id, turn_number, debug_data
                        FROM turn_debug_data
                    `);

                    for (const row of debugDataRows) {
                        await exec(`
                            UPDATE branch_messages
                            SET debug_data = ?
                            WHERE branch_id IN (
                                SELECT cb.id FROM chat_branches cb
                                WHERE cb.chat_id = ? AND cb.branch_name = 'main'
                            )
                            AND turn_number = ?
                            AND (debug_data IS NULL OR debug_data = '')
                        `, [row.debug_data, row.chat_id, row.turn_number]);
                    }

                    log(`[DB] Migrated ${debugDataRows.length} debug data entries to branch messages`);
                }

                log('[DB] Dropping old tables...');
                await exec('DROP TABLE IF EXISTS messages');
                await exec('DROP TABLE IF EXISTS turn_debug_data');
                log('[DB] Successfully dropped old tables: messages, turn_debug_data');
            }

            const chatsWithoutMainBranch = await all(`
                SELECT c.id
                FROM chats c
                LEFT JOIN chat_branches cb ON c.id = cb.chat_id AND cb.branch_name = 'main'
                WHERE cb.id IS NULL
            `);

            for (const chat of chatsWithoutMainBranch) {
                await exec(`
                    INSERT INTO chat_branches (chat_id, branch_name, parent_branch_id, branch_point_turn, is_active)
                    VALUES (?, 'main', NULL, NULL, TRUE)
                `, [chat.id]);
                log(`[DB] Created main branch for existing chat ${chat.id}`);
            }

            log('[DB] Database initialized successfully');
        } catch (migrationError) {
            log('[DB] Error during migration:', migrationError.message || migrationError);
            log('[DB] MIGRATION FAILED - system may have inconsistent state');
        }
    } catch (err) {
        log('[DB] Error initializing database:', err.message || err);
        throw err;
    }
}

// Graceful database shutdown
async function closeDatabase() {
    try {
        await client.close();
        log('[DATABASE] Closed successfully.');
    } catch (err) {
        log('[DATABASE] Error closing database:', err.message || err);
    }
}

module.exports = {
    client,
    exec,
    all,
    get,
    initializeDatabase,
    closeDatabase
};