const { log } = require('../utils/logger');
const {
  prepare,
  execMultiple,
  all,
  get,
  run,
  close: closeClient,
} = require('./dbClient');

/**
 * Initialize database schema and run migrations using libSQL client.
 * This mirrors the previous better-sqlite3-based logic but uses async helpers.
 */
async function initializeDatabase() {
  try {
    // Core tables (use executeMultiple for simple creates)
    await execMultiple(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_branches (
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
      );

      CREATE TABLE IF NOT EXISTS branch_messages (
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
      );
    `);

    // Add columns with safe "if not exists" style using try/catch

    // chats.turn_number
    try {
      await run(
        `ALTER TABLE chats ADD COLUMN turn_number INTEGER DEFAULT 0`
      );
    } catch (err) {
      if (!String(err.message || err).includes('duplicate column')) {
        log('[DB] Error adding turn_number to chats:', err.message || err);
      }
    }

    // branch_messages.original_content
    try {
      await run(
        `ALTER TABLE branch_messages ADD COLUMN original_content TEXT`
      );
      log('[DB] Added original_content column to branch_messages');
    } catch (err) {
      if (!String(err.message || err).includes('duplicate column')) {
        log('[DB] Error adding original_content:', err.message || err);
      }
    }

    // branch_messages.file_metadata
    try {
      await run(
        `ALTER TABLE branch_messages ADD COLUMN file_metadata TEXT`
      );
      log('[DB] Added file_metadata column to branch_messages');
    } catch (err) {
      if (!String(err.message || err).includes('duplicate column')) {
        log('[DB] Error adding file_metadata:', err.message || err);
      }
    }

    // branch_messages.error_state
    try {
      await run(
        `ALTER TABLE branch_messages ADD COLUMN error_state TEXT DEFAULT NULL`
      );
      log('[DB] Added error_state column to branch_messages');
    } catch (err) {
      if (!String(err.message || err).includes('duplicate column')) {
        log('[DB] Error adding error_state:', err.message || err);
      }
    }

    // FULL MIGRATION: Move everything to branch-based system and drop old tables
    try {
      log('[DB] Starting FULL migration to everything-is-a-branch system...');

      // Step 1: Migrate any remaining data from old messages table
      const oldTableExists = await get(
        `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='messages'
      `
      );

      if (oldTableExists) {
        log('[DB] Found old messages table, migrating data...');

        const chatsWithoutBranchStmt = prepare(`
          SELECT DISTINCT m.chat_id
          FROM messages m
          LEFT JOIN chat_branches cb
            ON m.chat_id = cb.chat_id AND cb.branch_name = 'main'
          WHERE cb.id IS NULL
          ORDER BY m.chat_id
        `);
        const chatsWithoutBranch = await chatsWithoutBranchStmt.all();

        for (const chat of chatsWithoutBranch) {
          const insertBranchStmt = prepare(`
            INSERT INTO chat_branches
              (chat_id, branch_name, parent_branch_id, branch_point_turn, is_active)
            VALUES (?, 'main', NULL, NULL, TRUE)
          `);
          const branchResult = await insertBranchStmt.run(chat.chat_id);
          const branchId = branchResult.lastInsertRowid;

          const messagesStmt = prepare(`
            SELECT id, role, content, turn_number, tool_calls, tool_call_id,
                   tool_name, blocks, debug_data, edit_count, edited_at, timestamp
            FROM messages
            WHERE chat_id = ?
            ORDER BY timestamp ASC
          `);
          const messages = await messagesStmt.all(chat.chat_id);

          const insertMessageStmt = prepare(`
            INSERT INTO branch_messages
              (branch_id, original_message_id, role, content, turn_number,
               tool_calls, tool_call_id, tool_name, blocks, debug_data,
               edit_count, edited_at, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const msg of messages) {
            await insertMessageStmt.run(
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
            );
          }

          log(
            `[DB] Migrated chat ${chat.chat_id} to main branch with ${messages.length} messages`
          );
        }

        // Step 2: Migrate debug data from turn_debug_data to branch_messages
        log('[DB] Migrating debug data to branch messages...');
        const debugDataExists = await get(
          `
          SELECT name FROM sqlite_master
          WHERE type='table' AND name='turn_debug_data'
        `
        );

        if (debugDataExists) {
          const debugDataStmt = prepare(`
            SELECT chat_id, turn_number, debug_data
            FROM turn_debug_data
          `);
          const debugDataRows = await debugDataStmt.all();

          const updateDebugStmt = prepare(`
            UPDATE branch_messages
            SET debug_data = ?
            WHERE branch_id IN (
              SELECT cb.id FROM chat_branches cb
              WHERE cb.chat_id = ? AND cb.branch_name = 'main'
            )
            AND turn_number = ?
            AND debug_data IS NULL
          `);

          for (const debugRow of debugDataRows) {
            await updateDebugStmt.run(
              debugRow.debug_data,
              debugRow.chat_id,
              debugRow.turn_number
            );
          }

          log(
            `[DB] Migrated ${debugDataRows.length} debug data entries to branch messages`
          );
        }

        // Step 3: Drop old tables after successful migration
        log('[DB] Dropping old tables...');
        await execMultiple(`
          DROP TABLE IF EXISTS messages;
          DROP TABLE IF EXISTS turn_debug_data;
        `);
        log(
          '[DB] Successfully dropped old tables: messages, turn_debug_data'
        );
      }

      // Step 4: Ensure ALL existing chats have main branches
      const chatsWithoutMainBranchStmt = prepare(`
        SELECT c.id
        FROM chats c
        LEFT JOIN chat_branches cb
          ON c.id = cb.chat_id AND cb.branch_name = 'main'
        WHERE cb.id IS NULL
      `);
      const chatsWithoutMainBranch =
        await chatsWithoutMainBranchStmt.all();

      const createMainBranchStmt = prepare(`
        INSERT INTO chat_branches
          (chat_id, branch_name, parent_branch_id, branch_point_turn, is_active)
        VALUES (?, 'main', NULL, NULL, TRUE)
      `);

      for (const chat of chatsWithoutMainBranch) {
        await createMainBranchStmt.run(chat.id);
        log(
          `[DB] Created main branch for existing chat ${chat.id}`
        );
      }

      log(
        '[DB] FULL migration to everything-is-a-branch completed!'
      );
    } catch (migrationError) {
      log(
        '[DB] Error during full migration:',
        migrationError.message || migrationError
      );
      log(
        '[DB] MIGRATION FAILED - system may have inconsistent state'
      );
    }

    log('[DB] Database initialized successfully');
  } catch (err) {
    log('[DB] Error initializing database:', err.message || err);
    throw err;
  }
}

/**
 * Graceful database shutdown
 */
async function closeDatabase() {
  await closeClient();
}

/**
 * Backwards-compatible db-like wrapper so existing code using db.prepare(...) keeps working.
 * All operations are async under the hood via libSQL.
 */
const db = {
  prepare,
  all,
  get,
  run,
};

module.exports = {
  db,
  prepare,
  all,
  get,
  run,
  initializeDatabase,
  closeDatabase,
};