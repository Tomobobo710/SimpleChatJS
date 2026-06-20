// Shell config routes - Expose detected shells and the configured shell.
// The configured shell is stored as the `shell` field on the active profile
// (see settingsService), but a dedicated route keeps detection logic out of
// the frontend and lets the Settings UI read/resolve without a full settings
// save round-trip.

const express = require('express');
const { getCurrentSettings, updateActiveProfile } = require('../services/settingsService');
const shellService = require('../services/shellService');

const router = express.Router();

const VALID_SHELLS = ['auto', 'bash', 'pwsh', 'powershell', 'cmd'];

// GET /api/shell — current shell config + detected + available.
router.get('/shell', (req, res) => {
    try {
        const settings = getCurrentSettings();
        res.json({
            shell: settings.shell || 'auto',
            detected: shellService.getPreferredShell('auto'),
            available: shellService.listShells()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/shell — set the configured shell.
// Body: { shell: 'auto' | 'bash' | 'pwsh' | 'powershell' | 'cmd' }
// If 'auto', resolves to the detected name before saving (settings always
// stores a concrete binary name).
router.post('/shell', (req, res) => {
    try {
        const { shell } = req.body || {};
        if (!VALID_SHELLS.includes(shell)) {
            return res.status(400).json({ error: 'Invalid shell value' });
        }

        const resolved = shell === 'auto'
            ? shellService.getPreferredShell('auto').name
            : shell;

        const settings = getCurrentSettings();
        const updated = { ...settings, shell: resolved };
        const result = updateActiveProfile(updated);

        if (result.success) {
            res.json({
                success: true,
                shell: resolved,
                detected: shellService.getPreferredShell('auto'),
                available: shellService.listShells()
            });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
