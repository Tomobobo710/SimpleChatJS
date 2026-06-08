// Path utilities - centralized path resolution for userdata directories.
// Used by database.js, settingsService.js, and mcpService.js.

const path = require('path');

// Get the userdata directory path.
// Portable mode: set PORTABLE_USERDATA_PATH env var.
// Non-portable mode: uses project/userdata directory.
function getUserdataDir() {
    if (process.env.PORTABLE_USERDATA_PATH) {
        return process.env.PORTABLE_USERDATA_PATH;
    }
    return path.join(__dirname, '..', '..', 'userdata');
}

// Build a path within the userdata directory.
function getUserdataPath(filename) {
    return path.join(getUserdataDir(), filename);
}

module.exports = {
    getUserdataDir,
    getUserdataPath
};
