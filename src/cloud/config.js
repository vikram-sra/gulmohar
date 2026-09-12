// Firebase web config. Public by design -- Firestore/Storage rules are what
// protect writes -- so it is safe to commit. Paste the object from
// Firebase console > Project settings > Your apps > Web app.
export const FIREBASE_CONFIG = null;

export const GALLERY_PATH = 'public/gallery.json';

export function isCloudConfigured() {
    return !!(FIREBASE_CONFIG && FIREBASE_CONFIG.storageBucket && FIREBASE_CONFIG.apiKey);
}

/** Tokenless download URL; works for any object the Storage rules let the public read. */
export function publicObjectUrl(path) {
    const bucket = FIREBASE_CONFIG.storageBucket;
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
}

export function galleryUrl() {
    return isCloudConfigured() ? publicObjectUrl(GALLERY_PATH) : null;
}
