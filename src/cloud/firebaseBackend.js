import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDocFromServer,
    query, orderBy, serverTimestamp, writeBatch
} from 'firebase/firestore';
import {
    getStorage, ref, uploadBytes, uploadBytesResumable, getDownloadURL, updateMetadata, deleteObject
} from 'firebase/storage';
import { FIREBASE_CONFIG, GALLERY_PATH, publicObjectUrl } from './config.js';

let _backend = null;

export function createFirebaseBackend() {
    if (_backend) return _backend;
    const app = initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    // Offline cache so edits made without a connection queue and sync later.
    const db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
    const storage = getStorage(app);

    const toUser = (u) => u && { uid: u.uid, name: u.displayName, email: u.email, photo: u.photoURL };

    _backend = {
        kind: 'firebase',

        onUser(cb) {
            return onAuthStateChanged(auth, (u) => cb(toUser(u)));
        },

        // Popup, not redirect: redirect sign-in breaks under Safari's
        // third-party cookie blocking when authDomain is another origin.
        async signIn() {
            await signInWithPopup(auth, new GoogleAuthProvider());
        },

        signOut: () => signOut(auth),

        async checkAccess() {
            try {
                await getDocFromServer(doc(db, 'meta', 'published'));
                return true;
            } catch (err) {
                if (err && err.code === 'permission-denied') return false;
                return true;   // offline: let cached data through; writes still enforce rules
            }
        },

        watchArtworks(cb, onError) {
            const q = query(collection(db, 'artworks'), orderBy('order'));
            return onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
                cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), {
                    pending: snap.metadata.hasPendingWrites,
                    fromCache: snap.metadata.fromCache
                });
            }, onError);
        },

        watchPublished(cb) {
            return onSnapshot(doc(db, 'meta', 'published'), (snap) => cb(snap.exists() ? snap.data() : null), () => cb(null));
        },

        async createArtwork(data) {
            const { id, ...rest } = data;
            await setDoc(doc(db, 'artworks', id), { ...rest, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
            return id;
        },

        updateArtwork(id, patch) {
            return updateDoc(doc(db, 'artworks', id), { ...patch, updatedAt: serverTimestamp() });
        },

        async updateMany(entries) {
            const batch = writeBatch(db);
            entries.forEach(([id, patch]) => batch.update(doc(db, 'artworks', id), { ...patch, updatedAt: serverTimestamp() }));
            await batch.commit();
        },

        deleteArtworkDoc: (id) => deleteDoc(doc(db, 'artworks', id)),

        watchLandmarks(cb, onError) {
            return onSnapshot(collection(db, 'landmarks'), (snap) => {
                cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
            }, onError);
        },
        // setDoc + merge, not updateDoc: a landmark's doc does not exist
        // until its first edit -- there is no seeding step, unlike artworks
        // which are always created through uploadNewArtwork first.
        updateLandmark(id, patch) {
            return setDoc(doc(db, 'landmarks', id), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
        },

        putImage(path, blob, { contentType, cacheControl, onProgress } = {}) {
            return new Promise((resolve, reject) => {
                const task = uploadBytesResumable(ref(storage, path), blob, { contentType, cacheControl });
                task.on('state_changed',
                    (s) => onProgress && onProgress(s.bytesTransferred / Math.max(1, s.totalBytes)),
                    reject,
                    async () => resolve({ path, url: await getDownloadURL(task.snapshot.ref) }));
            });
        },

        setPublic: (path) => updateMetadata(ref(storage, path), { customMetadata: { public: 'true' } }),

        async deleteObject(path) {
            try { await deleteObject(ref(storage, path)); } catch (err) {
                if (!err || err.code !== 'storage/object-not-found') throw err;
            }
        },

        async putGallery(json, revision) {
            const blob = new Blob([json], { type: 'application/json' });
            const meta = { contentType: 'application/json', cacheControl: 'no-cache, max-age=0' };
            await uploadBytes(ref(storage, `public/history/${revision}.json`), blob, meta);
            await uploadBytes(ref(storage, GALLERY_PATH), blob, meta);
        },

        setPublished: (meta) => setDoc(doc(db, 'meta', 'published'), meta),

        publicUrl: (path) => publicObjectUrl(path),

        // Draft images are private; the studio uses the token URL stored at upload.
        imageUrl: async (img) => (img && img.url) || null
    };
    return _backend;
}
