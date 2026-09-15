// Firebase web config. Public by design -- Firestore/Storage rules are what
// protect writes -- so it is safe to commit. Paste the object from
// Firebase console > Project settings > Your apps > Web app.
export const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBXY-Eg-FQ75JJywI_o2jgNwtLaIpH4i34',
    authDomain: 'gulmohar-ee932.firebaseapp.com',
    projectId: 'gulmohar-ee932',
    storageBucket: 'gulmohar-ee932.firebasestorage.app',
    messagingSenderId: '856433765512',
    appId: '1:856433765512:web:7ee92fb8a308816c2ec33d'
    // measurementId from the console is deliberately dropped: it belongs to
    // Google Analytics, which this project does not load. Keeping it here
    // would imply an analytics pipeline that does not exist.
};

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
