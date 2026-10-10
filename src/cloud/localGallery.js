// Development-only reader for the existing local Studio's IndexedDB store.
// Public pages still never import the editing backend or Firebase SDK.
export async function readLocalGallery() {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('gulmohar-studio-local', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('blobs');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const read = path => new Promise((resolve, reject) => {
        const request = db.transaction('blobs').objectStore('blobs').get(path);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        const blob = await read('public/gallery.json');
        if (!blob) throw new Error('No local gallery published');
        const gallery = JSON.parse(await blob.text());
        for (const artwork of gallery.artworks || []) {
            for (const [size, value] of Object.entries(artwork.images || {})) {
                if (typeof value === 'string' && value.startsWith('local:')) {
                    const image = await read(value.slice(6));
                    artwork.images[size] = image ? URL.createObjectURL(image) : null;
                }
            }
        }
        return gallery;
    } finally { db.close(); }
}
