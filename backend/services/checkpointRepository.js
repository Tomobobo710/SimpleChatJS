// Checkpoint Repository - DB row lifecycle for the checkpoints table.
// A row is inserted 'pending' before the git operation starts (so the UI can
// show "creating..." immediately), then updated to 'done' or 'error'.

const { log } = require('../utils/logger');

function insertPending(chatId, turnId, kind) {
    const { db } = require('../config/database');
    const result = db
        .prepare(`INSERT INTO checkpoints (chat_id, turn_id, kind, status) VALUES (?, ?, ?, 'pending')`)
        .run(chatId, turnId || null, kind);
    return result.lastInsertRowid;
}

function markDone(id, commitHash) {
    const { db } = require('../config/database');
    db.prepare(`UPDATE checkpoints SET status = 'done', commit_hash = ? WHERE id = ?`).run(commitHash, id);
}

// No-op commit (nothing changed) - drop the row entirely so the UI doesn't
// show duplicate/empty checkpoints, matching Roo's saveCheckpoint returning
// undefined on no changes.
function markNoOp(id) {
    const { db } = require('../config/database');
    db.prepare(`DELETE FROM checkpoints WHERE id = ?`).run(id);
}

function markError(id, message) {
    const { db } = require('../config/database');
    db.prepare(`UPDATE checkpoints SET status = 'error', error = ? WHERE id = ?`).run(message, id);
}

function listForChat(chatId) {
    const { db } = require('../config/database');
    return db
        .prepare(`SELECT * FROM checkpoints WHERE chat_id = ? ORDER BY created_at DESC, id DESC`)
        .all(chatId);
}

function getById(id) {
    const { db } = require('../config/database');
    return db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id);
}

function deleteForChat(chatId) {
    const { db } = require('../config/database');
    const result = db.prepare(`DELETE FROM checkpoints WHERE chat_id = ?`).run(chatId);
    log(`[CHECKPOINT] Deleted ${result.changes} checkpoint row(s) for chat ${chatId}`);
}

module.exports = {
    insertPending,
    markDone,
    markNoOp,
    markError,
    listForChat,
    getById,
    deleteForChat
};
