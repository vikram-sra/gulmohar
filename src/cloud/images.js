// Client-side image pipeline: decode (honouring camera EXIF rotation), then
// encode the sizes the site serves. 2048 is the GPU texture cap in the garden.

export const SIZES = { thumb: 480, medium: 1024, display: 2048 };

export class ImageDecodeError extends Error {}

async function decode(file) {
    if (file.type !== 'image/svg+xml') {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch { /* fall through to <img>, which also covers SVG */ }
    }
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new ImageDecodeError('decode failed'));
            el.src = url;
        });
        if (!img.naturalWidth) {   // SVG without intrinsic size
            img.width = 1600; img.height = 1600;
        }
        return img;
    } finally {
        // Revoked after the caller draws; a microtask is enough for <img>.
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encode(source, srcW, srcH, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    // iOS Safari can't encode WebP and silently returns PNG instead.
    let blob = await canvasToBlob(canvas, 'image/webp', 0.86);
    if (!blob || blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg', 0.88);
    const contentType = blob.type;
    return { blob, contentType, ext: contentType === 'image/webp' ? 'webp' : 'jpg', width: w, height: h };
}

function originalExt(file) {
    const fromName = (file.name || '').split('.').pop().toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
    return (file.type.split('/')[1] || 'bin').replace('svg+xml', 'svg').replace('jpeg', 'jpg');
}

/**
 * @returns {{aspect, widthPx, heightPx, sizes: {thumb, medium, display}, original}}
 * Each size is {blob, contentType, ext, width, height}.
 */
export async function processImage(file) {
    let source;
    try {
        source = await decode(file);
    } catch {
        throw new ImageDecodeError("Couldn't read this image. Export it as JPEG or PNG and try again.");
    }
    const srcW = source.width || source.naturalWidth;
    const srcH = source.height || source.naturalHeight;
    const sizes = {};
    for (const [name, edge] of Object.entries(SIZES)) {
        sizes[name] = await encode(source, srcW, srcH, edge);
    }
    if (source.close) source.close();
    return {
        aspect: srcW / srcH,
        widthPx: srcW,
        heightPx: srcH,
        sizes,
        original: { blob: file, contentType: file.type || 'application/octet-stream', ext: originalExt(file) }
    };
}
