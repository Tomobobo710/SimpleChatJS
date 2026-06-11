// Chat Service - Thin facade re-exporting from split modules.
// Original responsibilities extracted into:
//   messageContentService.js  - content shaping (pure functions)
//   turnService.js            - turn/branch management
//   messageRepository.js      - DB reads/writes for messages
//   chatStreamService.js      - streaming, tool execution, cancellation
//   systemPromptService.js    - system message building

const {
    extractFilesFromContent,
    concatenateFileContent,
    createSeparatedFileContent,
    processMessageForAI,
    createMessageWithSeparatedFiles
} = require('./messageContentService');

const {
    getCurrentTurnNumber,
    getTurnInfo,
    incrementTurnNumber,
    getAncestorTurnIds,
    saveBranchSelections,
    loadBranchSelections,
    deleteBranchSelections
} = require('./turnService');

const {
    saveMessage: saveCompleteMessageToDatabase,
    getChatHistoryForAPI,
    saveTurnDebugData,
    saveRequestDebugData,
    getTurnDebugData
} = require('./messageRepository');

const {
    handleChatWithTools,
    cancelInFlightRequest,
    executeToolCallsAndContinue,
    processChatRequest
} = require('./chatStreamService');

const {
    buildSystemMessageIfEnabled
} = require('./systemPromptService');

module.exports = {
    // Stream / entry points
    handleChatWithTools,
    processChatRequest,
    saveCompleteMessageToDatabase,
    cancelInFlightRequest,

    // History / repo
    getChatHistoryForAPI,

    // System prompt
    buildSystemMessageIfEnabled,

    // Turn management
    getCurrentTurnNumber,
    getTurnInfo,
    incrementTurnNumber,
    getAncestorTurnIds,

    // Turn-based debug data
    saveTurnDebugData,
    saveRequestDebugData,
    getTurnDebugData,

    // Branch navigation
    saveBranchSelections,
    loadBranchSelections,
    deleteBranchSelections,

    // File handling (legacy export for callers that import directly)
    extractFilesFromContent,
    concatenateFileContent,
    createSeparatedFileContent,
    processMessageForAI,
    createMessageWithSeparatedFiles
};
