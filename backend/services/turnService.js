// Turn Service - Turn management, branch navigation, and lineage traversal.
// Handles ancestor chains, branch selection persistence, and turn_id generation.

const crypto = require('crypto');
const { log } = require('../utils/logger');

function getTurnInfo(parentTurnId = null, turnId = null) {
    const resolvedTurnId = turnId || crypto.randomUUID();
    const resolvedParentTurnId = parentTurnId || null;

    log(`[TURN-INFO] turn_id=${resolvedTurnId}, parent_turn_id=${resolvedParentTurnId}`);

    return { turn_id: resolvedTurnId, parent_turn_id: resolvedParentTurnId };
}

// Walk the parent_turn_id chain from a given turn_id up to the root.
// Returns an array of turn_ids in the ancestor chain (including the starting turn_id).
function getAncestorTurnIds(chat_id, startTurnId) {
    const { db } = require('../config/database');
    const ancestors = [];
    let currentId = startTurnId;

    while (currentId) {
        ancestors.push(currentId);
        const row = db
            .prepare("SELECT parent_turn_id FROM messages WHERE chat_id = ? AND turn_id = ? LIMIT 1")
            .get(chat_id, currentId);
        currentId = row ? row.parent_turn_id : null;
    }

    return ancestors;
}

// Replace all branch selections for a chat. DB stays consistent even
// if the user navigates between loads.
function saveBranchSelections(chatId, selections) {
    if (!chatId) {
        throw new Error("saveBranchSelections: chatId is required");
    }
    if (selections !== undefined && typeof selections !== "object") {
        throw new Error(`saveBranchSelections: selections must be an object map, got ${typeof selections}`);
    }
    const map = selections !== undefined ? selections : {};

    const { db } = require('../config/database');

    try {
        const upsert = db.prepare(`
            INSERT INTO chat_branch_selections (chat_id, parent_key, selected_turn_id)
            VALUES (?, ?, ?)
            ON CONFLICT(chat_id, parent_key) DO UPDATE SET selected_turn_id = excluded.selected_turn_id
        `);
        const remove = db.prepare(`
            DELETE FROM chat_branch_selections
            WHERE chat_id = ? AND parent_key NOT IN (${
                Object.keys(map).length
                    ? Object.keys(map)
                          .map(() => "?")
                          .join(",")
                    : "NULL"
            })
        `);

        const tx = db.transaction(() => {
            for (const [parentKey, selectedTurnId] of Object.entries(map)) {
                if (typeof selectedTurnId !== "string" || !selectedTurnId) {
                    throw new Error(`saveBranchSelections: invalid selected_turn_id for parent_key="${parentKey}"`);
                }
                upsert.run(chatId, parentKey, selectedTurnId);
            }
            // Remove stale entries for parent_keys no longer in the map.
            if (Object.keys(map).length > 0) {
                remove.run(chatId, ...Object.keys(map));
            } else {
                remove.run(chatId);
            }
        });
        tx();
        log(`[BRANCH-SEL] Saved ${Object.keys(map).length} selection(s) for chat ${chatId}`);
        return { count: Object.keys(map).length };
    } catch (err) {
        log(`[BRANCH-SEL] Error saving selections for chat ${chatId}:`, err.message);
        throw err;
    }
}

// Return all branch selections for a chat as a { parentKey: turnId } map.
// Returns {} for an unknown chat; throws on actual DB errors.
function loadBranchSelections(chatId) {
    if (!chatId) {
        throw new Error("loadBranchSelections: chatId is required");
    }
    const { db } = require('../config/database');

    try {
        const rows = db
            .prepare(`
                SELECT parent_key, selected_turn_id
                FROM chat_branch_selections
                WHERE chat_id = ?
            `)
            .all(chatId);
        const result = {};
        for (const row of rows) {
            result[row.parent_key] = row.selected_turn_id;
        }
        log(`[BRANCH-SEL] Loaded ${rows.length} selection(s) for chat ${chatId}`);
        return result;
    } catch (err) {
        log(`[BRANCH-SEL] Error loading selections for chat ${chatId}:`, err.message);
        throw err;
    }
}

// Delete all branch selections for a chat. Explicit cleanup to match the
// messages table pattern (no FK CASCADE).
function deleteBranchSelections(chatId) {
    if (!chatId) {
        throw new Error("deleteBranchSelections: chatId is required");
    }
    const { db } = require('../config/database');

    try {
        const result = db
            .prepare(`
                DELETE FROM chat_branch_selections WHERE chat_id = ?
            `)
            .run(chatId);
        log(`[BRANCH-SEL] Deleted ${result.changes} selection(s) for chat ${chatId}`);
        return result;
    } catch (err) {
        log(`[BRANCH-SEL] Error deleting selections for chat ${chatId}:`, err.message);
        throw err;
    }
}

module.exports = {
    getTurnInfo,
    getAncestorTurnIds,
    saveBranchSelections,
    loadBranchSelections,
    deleteBranchSelections
};
