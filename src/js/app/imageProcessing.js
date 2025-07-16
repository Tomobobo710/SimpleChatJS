// Shared Image Processing Logic
// Extracted from the superior edit modal implementation

/**
 * Process an image file with advanced compression
 * @param {File} file - Image file to process
 * @returns {Promise<Object>} Processed image data
 */
async function processImageFile(file) {
    console.log(`[IMAGE-PROCESSING] Processing ${file.name} (${(file.size / 1024).toFixed(1)}KB)...`);

    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = URL.createObjectURL(file);
    });

    const originalWidth = img.width;
    const originalHeight = img.height;
    
    // Progressive compression settings (from edit modal)
    const MAX_BASE64_KB = 100;
    const targetKB = Math.floor(MAX_BASE64_KB * 0.75);
    const qualities = Array.from({ length: 7 }, (_, i) => +(0.7 - i * 0.1).toFixed(1));
    const scales = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
    
    let resizedBlob = null;
    let base64Data = null;
    let success = false;

    // Progressive compression attempts (from edit modal)
    for (const scale of scales) {
        const scaledW = Math.round(originalWidth * scale);
        const scaledH = Math.round(originalHeight * scale);

        for (const q of qualities) {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = scaledW;
                canvas.height = scaledH;
                canvas.getContext('2d').drawImage(img, 0, 0, scaledW, scaledH);

                const blob = await new Promise((resolve, reject) => {
                    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Blob conversion failed')), 'image/webp', q);
                });

                const base64 = await blobToBase64(blob);
                const base64KB = base64.length / 1024;

                console.log(`[IMAGE-PROCESSING] ${scaledW}×${scaledH} @ ${q} quality = ${base64KB.toFixed(1)}KB`);

                if (base64KB <= targetKB) {
                    resizedBlob = blob;
                    base64Data = base64;
                    console.log(`[IMAGE-PROCESSING] Success with scale ${scale} @ ${q}`);
                    success = true;
                    break;
                }
            } catch (err) {
                console.warn(`[IMAGE-PROCESSING] ${scaledW}×${scaledH} @ ${q} failed: ${err.message}`);
            }
        }
        if (success) break;
    }

    if (!base64Data) {
        throw new Error('Could not compress image to acceptable size');
    }

    // Clean up
    URL.revokeObjectURL(img.src);

    const originalSizeKB = (file.size / 1024).toFixed(1);
    const resizedSizeKB = (resizedBlob.size / 1024).toFixed(1);
    console.log(`[IMAGE-PROCESSING] Completed: ${file.name} (${originalSizeKB}KB → ${resizedSizeKB}KB)`);

    return {
        name: file.name,
        type: resizedBlob.type,
        size: resizedBlob.size,
        originalSize: file.size,
        data: base64Data,
        mimeType: resizedBlob.type
    };
}

/**
 * Convert blob to base64 string
 * @param {Blob} blob - Blob to convert
 * @returns {Promise<string>} Base64 string (without data URL prefix)
 */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            // Remove the data:image/...;base64, prefix
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = () => reject(new Error('Failed to convert blob to base64'));
        reader.readAsDataURL(blob);
    });
}