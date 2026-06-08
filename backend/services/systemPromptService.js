// System Prompt Service - Build system messages based on profile settings.

const { getCurrentSettings } = require('./settingsService');

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant. If the previous query requires you to use tools, do so. Otherwise, just chat with the user in a friendly manner.';

function buildSystemMessageIfEnabled() {
    const currentSettings = getCurrentSettings();
    if (
        currentSettings.enableSystemPrompt &&
        currentSettings.systemPrompt &&
        currentSettings.systemPrompt.trim()
    ) {
        return {
            role: "system",
            content: currentSettings.systemPrompt.trim()
        };
    }
    return null;
}

module.exports = {
    buildSystemMessageIfEnabled,
    DEFAULT_SYSTEM_PROMPT
};
