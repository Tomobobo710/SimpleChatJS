// Document Processing Logic - Server-Side
// Handles document upload to backend for text extraction

const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024; // 10MB limit (matches backend)

/**
 * Upload documents to server for processing
 * @param {File[]} files - Document files to process
 * @returns {Promise<Object>} Processing results from server
 */
async function processDocumentFiles(files) {
    console.log(`[DOCUMENT-PROCESSING] Uploading ${files.length} document(s) to server...`);

    // Validate file sizes
    for (const file of files) {
        if (file.size > MAX_DOCUMENT_SIZE) {
            throw new Error(`File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB > ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB)`);
        }
    }

    // Create FormData for file upload
    const formData = new FormData();
    files.forEach(file => {
        formData.append('documents', file);
    });

    try {
        const response = await fetch('/api/process-documents', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Server error: ${response.status}`);
        }

        const result = await response.json();
        console.log(`[DOCUMENT-PROCESSING] Server processed ${result.processed} documents, ${result.failed} failed`);
        
        return result;

    } catch (error) {
        console.error(`[DOCUMENT-PROCESSING] Upload failed:`, error);
        throw new Error(`Document processing failed: ${error.message}`);
    }
}

/**
 * Get file extension from filename
 * @param {string} filename - Name of the file
 * @returns {string} File extension including the dot
 */
function getFileExtension(filename) {
    const lastDotIndex = filename.lastIndexOf('.');
    return lastDotIndex === -1 ? '' : filename.substring(lastDotIndex);
}

/**
 * Get a simple text icon for file type
 * @param {string} filename - Name of the file
 * @returns {string} Text representation of file type
 */
function getFileIcon(filename) {
    const ext = getFileExtension(filename).toLowerCase();
    
    // Document types
    if (['.doc', '.docx', '.odt'].includes(ext)) return '[DOC]';
    if (['.xls', '.xlsx', '.ods'].includes(ext)) return '[XLS]';
    if (['.ppt', '.pptx', '.odp'].includes(ext)) return '[PPT]';
    if (ext === '.pdf') return '[PDF]';
    
    // Text types
    if (['.txt', '.md', '.readme'].includes(ext)) return '[TXT]';
    if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) return '[JS]';
    if (['.html', '.htm', '.xml'].includes(ext)) return '[HTML]';
    if (['.css', '.scss', '.sass'].includes(ext)) return '[CSS]';
    if (['.json', '.yml', '.yaml'].includes(ext)) return '[DATA]';
    if (['.py', '.rb', '.php', '.java', '.cpp', '.c'].includes(ext)) return '[CODE]';
    
    // Default
    return '[FILE]';
}

/**
 * Check if a file is supported for document processing
 * @param {File} file - File to check
 * @returns {boolean} True if file can be processed
 */
function isDocumentSupported(file) {
    // All files are "supported" - server will try officeparser first, then fall back to text
    return !file.type.startsWith('image/'); // Exclude images
}
