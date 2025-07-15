// Document processing route
// Handles file uploads and text extraction using officeparser

const express = require('express');
const multer = require('multer');
const officeParser = require('officeparser');
const pdfParse = require('pdf-parse');
const path = require('path');
const { log } = require('../utils/logger');

const router = express.Router();

// Configure multer for file uploads (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 5 // Max 5 files at once
    },
    fileFilter: (req, file, cb) => {
        // Allow all files except images (images are handled separately)
        if (file.mimetype.startsWith('image/')) {
            return cb(new Error('Images should not be processed as documents'), false);
        }
        // PDFs are now supported via pdf-parse
        cb(null, true);
    }
});

// Supported office document formats
const SUPPORTED_OFFICE_FORMATS = ['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'];
const SUPPORTED_PDF_FORMATS = ['.pdf'];
const MAX_TEXT_LENGTH = 100000; // 100KB of text

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
            // Use pdf-parse for PDF files
            const data = await pdfParse(buffer);
            extractedText = data.text;
            format = 'pdf';
            log(`[DOCUMENT-API] Used pdf-parse for ${ext} file: ${filename}`);
        } else if (SUPPORTED_OFFICE_FORMATS.includes(ext)) {
            // Use officeparser for supported formats
            extractedText = await officeParser.parseOfficeAsync(buffer, {
                outputErrorToConsole: false,
                newlineDelimiter: '\n',
                ignoreNotes: false,
                putNotesAtLast: false
            });
            format = 'office';
            log(`[DOCUMENT-API] Used officeparser for ${ext} file: ${filename}`);
        } else {
            // Read as UTF-8 text for everything else
            extractedText = buffer.toString('utf8');
            format = 'text';
            log(`[DOCUMENT-API] Used text reader for ${ext} file: ${filename}`);
        }

        // Truncate if too long
        if (extractedText.length > MAX_TEXT_LENGTH) {
            extractedText = extractedText.substring(0, MAX_TEXT_LENGTH) + '\n\n[Content truncated due to length]';
            log(`[DOCUMENT-API] Truncated ${filename} text from ${extractedText.length} to ${MAX_TEXT_LENGTH} characters`);
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
 * POST /api/process-documents
 * Upload and process document files
 */
router.post('/process-documents', upload.array('documents', 5), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        log(`[DOCUMENT-API] Processing ${req.files.length} document(s)`);
        
        const results = [];
        const errors = [];

        // Process each file
        for (const file of req.files) {
            try {
                const result = await processDocumentFile(file.buffer, file.originalname, file.mimetype);
                results.push(result);
                log(`[DOCUMENT-API] Successfully processed: ${file.originalname} (${(file.size / 1024).toFixed(1)}KB)`);
            } catch (error) {
                const errorInfo = {
                    fileName: file.originalname,
                    error: error.message,
                    success: false
                };
                errors.push(errorInfo);
                log(`[DOCUMENT-API] Failed to process: ${file.originalname} - ${error.message}`);
            }
        }

        // Return results
        res.json({
            success: true,
            processed: results.length,
            failed: errors.length,
            results: results,
            errors: errors
        });

    } catch (error) {
        log(`[DOCUMENT-API] Route error: ${error.message}`);
        
        if (error instanceof multer.MulterError) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'File too large (max 10MB)' });
            }
            if (error.code === 'LIMIT_FILE_COUNT') {
                return res.status(413).json({ error: 'Too many files (max 5)' });
            }
        }
        
        res.status(500).json({ error: 'Document processing failed', details: error.message });
    }
});

module.exports = router;
