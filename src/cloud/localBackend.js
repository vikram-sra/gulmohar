// Local stand-in for the Firebase backend, same interface. Used only on
// localhost before Firebase is configured, so the Studio and placement mode
// can be built and tested end to end. Docs in localStorage, blobs in IndexedDB.

const DOCS_KEY = 'gulmohar-studio-local-v1';
const DB_NAME = 'gulmohar-studio-local';
const LOCAL_USER = { uid: 'local-artist', name: 'Local artist', email: null, photo: null };
const SIGNED_IN_KEY = 'gulmohar-studio-local-signed-in';

function readDocs() {
    try { return JSON.parse(localStorage.getItem(DOCS_KEY)) || { artworks: {}, published: null }; }
    catch { return { artworks: {}, published: null }; }
}
function writeDocs(docs) { localStorage.setItem(DOCS_KEY, JSON.stringify(docs)); }

let _db = null;
function idb() {
    if (_db) return _db;
    _db = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('blobs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _db;
}
async function idbOp(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('blobs', mode);
        const req = fn(tx.objectStore('blobs'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
    });
}

let _backend = null;

export function createLocalBackend() {
    if (_backend) return _backend;
    const artworkListeners = new Set();
    const publishedListeners = new Set();
    const userListeners = new Set();
    const urlCache = new Map();

    const emit = () => {
        const docs = readDocs();
        const list = Object.values(docs.artworks).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        artworkListeners.forEach((cb) => cb(list, { pending: false, fromCache: false }));
        publishedListeners.forEach((cb) => cb(docs.published));
    };
    const mutate = (fn) => { const docs = readDocs(); fn(docs); writeDocs(docs); emit(); };
    const currentUser = () => (localStorage.getItem(SIGNED_IN_KEY) ? LOCAL_USER : null);

    // Another tab (e.g. placement mode) wrote -- same live-sync feel as Firestore.
    window.addEventListener('storage', (e) => {
        if (e.key === DOCS_KEY) emit();
        if (e.key === SIGNED_IN_KEY) userListeners.forEach((cb) => cb(currentUser()));
    });

    _backend = {
        kind: 'local',

        onUser(cb) {
            userListeners.add(cb);
            queueMicrotask(() => cb(currentUser()));
            return () => userListeners.delete(cb);
        },
        async signIn() {
            localStorage.setItem(SIGNED_IN_KEY, '1');
            userListeners.forEach((cb) => cb(LOCAL_USER));
        },
        async signOut() {
            localStorage.removeItem(SIGNED_IN_KEY);
            userListeners.forEach((cb) => cb(null));
        },
        checkAccess: async () => true,

        watchArtworks(cb) {
            artworkListeners.add(cb);
            queueMicrotask(emit);
            return () => artworkListeners.delete(cb);
        },
        watchPublished(cb) {
            publishedListeners.add(cb);
            queueMicrotask(() => cb(readDocs().published));
            return () => publishedListeners.delete(cb);
        },

        async createArtwork(data) {
            const now = Date.now();
            mutate((d) => { d.artworks[data.id] = { ...data, createdAt: now, updatedAt: now }; });
            return data.id;
        },
        async updateArtwork(id, patch) {
            mutate((d) => { if (d.artworks[id]) Object.assign(d.artworks[id], patch, { updatedAt: Date.now() }); });
        },
        async updateMany(entries) {
            mutate((d) => entries.forEach(([id, patch]) => {
                if (d.artworks[id]) Object.assign(d.artworks[id], patch, { updatedAt: Date.now() });
            }));
        },
        async deleteArtworkDoc(id) { mutate((d) => { delete d.artworks[id]; }); },

        async putImage(path, blob, { onProgress } = {}) {
            await idbOp('readwrite', (s) => s.put(blob, path));
            if (onProgress) onProgress(1);
            return { path, url: null };
        },
        setPublic: async () => {},
        async deleteObject(path) {
            await idbOp('readwrite', (s) => s.delete(path));
            const u = urlCache.get(path);
            if (u) { URL.revokeObjectURL(u); urlCache.delete(path); }
        },
        async putGallery(json) {
            await idbOp('readwrite', (s) => s.put(new Blob([json], { type: 'application/json' }), 'public/gallery.json'));
        },
        async setPublished(meta) { mutate((d) => { d.published = meta; }); },

        publicUrl: (path) => `local:${path}`,

        async imageUrl(img) {
            if (!img || !img.path) return null;
            if (urlCache.has(img.path)) return urlCache.get(img.path);
            const blob = await idbOp('readonly', (s) => s.get(img.path));
            if (!blob) return null;
            const url = URL.createObjectURL(blob);
            urlCache.set(img.path, url);
            return url;
        }
    };
    return _backend;
}
