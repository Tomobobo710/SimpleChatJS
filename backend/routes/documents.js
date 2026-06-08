// Document processing route
// Handles file uploads and delegates parsing to documentService

const express = require('express');
const multer = require('multer');
const { log } = require('../utils/logger');
const { processDocumentFile } = require('../services/documentService');

const router = express.Router();

// Configure multer for file uploads (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        files: 99 // Max 99 files at once
    },
    fileFilter: (req, file, cb) => {
        // Allow all files except images (images are handled separately)
        if (file.mimetype.startsWith('image/')) {
            return cb(new Error('Images should not be processed as documents'), false);
        }
        cb(null, true);
    }
});

/**
 * POST /api/process-documents
 * Upload and process document files
 */
router.post('/process-documents', upload.array('documents', 99), async (req, res) => {
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
                return res.status(413).json({ error: 'Too many files (max 99)' });
            }
        }

        res.status(500).json({ error: 'Document processing failed', details: error.message });
    }
});

module.exports = router;
