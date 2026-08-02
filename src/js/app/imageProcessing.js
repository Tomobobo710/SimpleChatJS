// Shared Image Processing Logic
// Extracted from the superior edit modal implementation

/**
 * Process an image file with advanced compression.
 *
 * Two-stage compression, same concept as the browser tool's screenshot path
 * (browserToolService.js):
 *   Stage 1: cap the long edge to imageMaxLongEdgePx (from Settings > Tokens >
 *            Image Compression). Pixel dimensions drive vision-model token
 *            cost; this is applied before any byte-size compression. 0 = no cap.
 *   Stage 2: progressive scale/quality ladder targeting imageMaxBase64Kb
 *            (also from Settings). Bounds request/storage size via JPEG
 *            quality and further downscaling.
 *
 * Both settings are read from the global settings cache (loadSettings) so
 * they're always current without callers having to pass config.
 *
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

    let originalWidth = img.width;
    let originalHeight = img.height;

    // Read compression settings from the global settings cache. Defaults
    // match getDefaultProfileSettings() in settingsService.js.
    const settings = typeof loadSettings === 'function' ? loadSettings() : {};
    const maxLongEdgePx = Number.isFinite(settings.imageMaxLongEdgePx) ? settings.imageMaxLongEdgePx : 1568;
    const maxBase64Kb = Number.isFinite(settings.imageMaxBase64Kb) ? settings.imageMaxBase64Kb : 100;

    // Stage 1: cap the long edge to maxLongEdgePx (0 = no cap, never upscales).
    // Same spirit as browserToolService.js's capLongEdge — pixel dimensions
    // drive vision-model token cost, so this is applied before byte-size
    // compression and independent of any devicePixelRatio concerns.
    if (maxLongEdgePx > 0) {
        const longEdge = Math.max(originalWidth, originalHeight);
        if (longEdge > maxLongEdgePx) {
            const capScale = maxLongEdgePx / longEdge;
            originalWidth = Math.round(originalWidth * capScale);
            originalHeight = Math.round(originalHeight * capScale);
            console.log(`[IMAGE-PROCESSING] Long-edge cap ${maxLongEdgePx}px → ${originalWidth}x${originalHeight}`);
        }
    }

    // Stage 2: progressive scale/quality ladder targeting maxBase64Kb.
    const targetKB = Math.floor(maxBase64Kb * 0.75);
    const qualities = Array.from({ length: 7 }, (_, i) => +(0.7 - i * 0.1).toFixed(1));
    const scales = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];

    let resizedBlob = null;
    let base64Data = null;
    let success = false;

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
                    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Blob conversion failed')), 'image/jpeg', q);
                });

                const base64 = await blobToBase64(blob);
                const base64KB = base64.length / 1024;

                console.log(`[IMAGE-PROCESSING] ${scaledW}x${scaledH} @ ${q} quality = ${base64KB.toFixed(1)}KB`);

                if (base64KB <= targetKB) {
                    resizedBlob = blob;
                    base64Data = base64;
                    console.log(`[IMAGE-PROCESSING] Success with scale ${scale} @ ${q}`);
                    success = true;
                    break;
                }
            } catch (err) {
                console.warn(`[IMAGE-PROCESSING] ${scaledW}x${scaledH} @ ${q} failed: ${err.message}`);
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
