// Document Service - Document parsing and file processing.
// Centralizes accepted file policy and parsing logic.

const officeParser = require('officeparser');
const pdfParse = require('pdf-parse');
const path = require('path');
const { log } = require('../utils/logger');

// Supported document formats
const SUPPORTED_OFFICE_FORMATS = ['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'];
const SUPPORTED_PDF_FORMATS = ['.pdf'];
const SUPPORTED_FORMATS = [...SUPPORTED_PDF_FORMATS, ...SUPPORTED_OFFICE_FORMATS];

/**
 * Process a single document file
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Original filename
 * @param {string} mimetype - File mimetype
 * @returns {Promise<Object>} Processed document data
 */
async function processDocumentFile(buffer, filename, mimetype) {
    const ext = path.extname(filename).toLowerCase();
    let extractedText;
    let format;

    try {
        if (SUPPORTED_PDF_FORMATS.includes(ext)) {
            const data = await pdfParse(buffer);
            extractedText = data.text;
            format = 'pdf';
            log(`[DOCUMENT-API] Used pdf-parse for ${ext} file: ${filename}`);
        } else if (SUPPORTED_OFFICE_FORMATS.includes(ext)) {
            extractedText = await officeParser.parseOfficeAsync(buffer, {
                outputErrorToConsole: false,
                newlineDelimiter: '\n',
                ignoreNotes: false,
                putNotesAtLast: false
            });
            format = 'office';
            log(`[DOCUMENT-API] Used officeparser for ${ext} file: ${filename}`);
        } else {
            // Fall back to raw text for any unknown extension
            extractedText = buffer.toString('utf8');
            format = 'text';
            log(`[DOCUMENT-API] Used raw text fallback for ${ext} file: ${filename}`);
        }

        return {
            fileName: filename,
            extractedText: extractedText.trim(),
            format: format,
            size: buffer.length,
            type: mimetype || 'application/octet-stream',
            success: true
        };
    } catch (error) {
        log(`[DOCUMENT-API] Error processing ${filename}: ${error.message}`);
        throw new Error(`Failed to process ${filename}: ${error.message}`);
    }
}

/**
 * Check if a file extension is supported
 * @param {string} filename - Filename to check
 * @returns {boolean}
 */
function isSupportedFormat(filename) {
    const ext = path.extname(filename).toLowerCase();
    return SUPPORTED_FORMATS.includes(ext);
}

module.exports = {
    processDocumentFile,
    isSupportedFormat,
    SUPPORTED_FORMATS
};
