// Project Service - DB lookups for project data.
// Used by chatStreamService to resolve the working directory for the
// shell_run tool on a per-chat basis (project-scoped chats use the project
// directory). Follows the lazy-import service convention.

const os = require('os');

// Resolve the filesystem path for a chat's project, if any.
// Returns the project path string, or null for freeform chats
// (project_id IS NULL) or when the referenced project was deleted.
function getProjectPathForChat(chatId) {
    if (!chatId) return null;
    const { db } = require('../config/database');
    // LEFT JOIN so a deleted project yields null path rather than dropping
    // the row. We don't need to distinguish freeform vs deleted-project here
    // — both mean "no project dir, fall through to the next cwd source".
    const row = db.prepare(`
        SELECT p.path AS project_path
        FROM chats c
        LEFT JOIN projects p ON p.id = c.project_id
        WHERE c.id = ?
    `).get(chatId);
    return row && row.project_path ? row.project_path : null;
}

// Resolve the working directory for a chat with the fixed priority:
//   1. project directory (if project-scoped chat)
//   2. settings.defaultCwd (if set)
//   3. user home directory
// process.cwd() is deliberately never used.
function resolveCwdForChat(chatId, settings) {
    const projectPath = getProjectPathForChat(chatId);
    if (projectPath) return projectPath;

    const defaultCwd = settings && settings.defaultCwd;
    if (defaultCwd && defaultCwd.trim()) return defaultCwd.trim();

    return os.homedir();
}

module.exports = {
    getProjectPathForChat,
    resolveCwdForChat
};
