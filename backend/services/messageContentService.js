// Message Content Service - Pure functions for message content shaping.
// Handles extraction, concatenation, and AI-format conversion of multimodal content.

const { log } = require('../utils/logger');

/**
 * Extract file content from multimodal message content
 * @param {Array|string} content - Message content (array for multimodal, string for text-only)
 * @returns {Object} - { textContent, files, images, hasFiles }
 */
function extractFilesFromContent(content) {
    const result = {
        textContent: "",
        files: [],
        images: [],
        hasFiles: false
    };

    if (typeof content === "string") {
        result.textContent = content;
        return result;
    }

    if (!Array.isArray(content)) {
        throw new Error(`extractFilesFromContent: unknown content type ${typeof content}`);
    }

    content.forEach((part) => {
        if (part.type === "text") {
            result.textContent = part.text || "";
        } else if (part.type === "image") {
            result.images.push(part);
        } else if (part.type === "files" && part.files && Array.isArray(part.files)) {
            result.files = part.files;
            result.hasFiles = true;
        }
    });

    return result;
}

/**
 * Concatenate file content to text content for AI processing
 * @param {string} textContent - Original user text
 * @param {Array} files - Array of file objects with extractedText
 * @returns {string} - Concatenated content ready for AI
 */
function concatenateFileContent(textContent, files) {
    let finalText = textContent || "";

    if (files && Array.isArray(files) && files.length > 0) {
        files.forEach((file) => {
            if (file.extractedText) {
                finalText += `\n\n\`\`\`userdocument\nFile: ${file.fileName}\n${file.extractedText}\n\`\`\``;
            }
        });

        log(`[FILE-PROCESSING] Concatenated ${files.length} file(s) to message content`);
    }

    return finalText;
}

/**
 * Create multimodal content with separated files for storage
 * @param {string} userText - User's actual text input
 * @param {Array} files - File objects array
 * @param {Array} images - Image objects array
 * @returns {Object} - { originalContent, concatenatedContent }
 */
function createSeparatedFileContent(userText, files, images) {
    const hasFiles = files && files.length > 0;
    const hasImages = images && images.length > 0;

    let originalContent, concatenatedContent;

    if (hasFiles || hasImages) {
        originalContent = [];

        if (userText || hasFiles) {
            originalContent.push({
                type: "text",
                text: userText || ""
            });
        }

        if (hasImages) {
            originalContent.push(...images);
        }

        if (hasFiles) {
            originalContent.push({
                type: "files",
                files: files
            });
        }

        concatenatedContent = concatenateFileContent(userText, files);
    } else {
        originalContent = userText || "";
        concatenatedContent = userText || "";
    }

    return { originalContent, concatenatedContent };
}

/**
 * Process message content for AI consumption
 * @param {Array|string} messageContent - Original message content from frontend
 * @returns {Object} - { aiContent, originalContent, fileMetadata }
 */
function processMessageForAI(messageContent) {
    const extracted = extractFilesFromContent(messageContent);
    const { textContent, files, images, hasFiles } = extracted;

    let aiContent;

    if (hasFiles || images.length > 0) {
        aiContent = [];
        const concatenatedText = concatenateFileContent(textContent, files);
        if (concatenatedText) {
            aiContent.push({
                type: "text",
                text: concatenatedText
            });
        }
        if (images.length > 0) {
            aiContent.push(...images);
        }
    } else {
        aiContent = textContent;
    }

    return {
        aiContent,
        originalContent: messageContent,
        fileMetadata: {
            hasFiles,
            fileCount: files.length,
            imageCount: images.length,
            files: files
        }
    };
}

/**
 * Create message with separated files for saving
 * @param {string} userText - User's text input
 * @param {Array} files - Array of processed file objects
 * @param {Array} images - Array of image objects
 * @returns {Object} - { content, originalContent, fileMetadata }
 */
function createMessageWithSeparatedFiles(userText, files = [], images = []) {
    const hasFiles = files && files.length > 0;
    const hasImages = images && images.length > 0;

    let content, originalContent;

    if (hasFiles || hasImages) {
        originalContent = [];

        if (userText || hasFiles) {
            originalContent.push({
                type: "text",
                text: userText || ""
            });
        }

        if (hasImages) {
            originalContent.push(...images);
        }

        if (hasFiles) {
            originalContent.push({
                type: "files",
                files: files
            });
        }

        const processed = processMessageForAI(originalContent);
        content = processed.aiContent;
    } else {
        content = userText || "";
        originalContent = userText || "";
    }

    const fileMetadata = {
        hasFiles,
        fileCount: files.length,
        imageCount: images.length,
        files: files
    };

    return {
        content,
        originalContent,
        fileMetadata
    };
}

module.exports = {
    extractFilesFromContent,
    concatenateFileContent,
    createSeparatedFileContent,
    processMessageForAI,
    createMessageWithSeparatedFiles
};
