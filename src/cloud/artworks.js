// Studio operations on artworks, written against the backend interface so they
// work the same with Firebase or the local stand-in.
import { SCHEMA_VERSION, slugId } from './schema.js';
import { DEFAULT_FRAME } from '../frames.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

function newVersion() {
    return Date.now().toString(36);
}

/** Uploads every size plus the original; reports overall progress 0..1 by bytes. */
async function uploadAll(backend, id, version, processed, onProgress) {
    const jobs = [
        ...Object.entries(processed.sizes).map(([name, s]) => ({
            key: name, path: `artworks/${id}/${version}/${name}.${s.ext}`,
            blob: s.blob, contentType: s.contentType, cacheControl: IMMUTABLE
        })),
        {
            key: 'original', path: `artworks/${id}/${version}/original.${processed.original.ext}`,
            blob: processed.original.blob, contentType: processed.original.contentType, cacheControl: 'private, max-age=0'
        }
    ];
    const total = jobs.reduce((n, j) => n + j.blob.size, 0) || 1;
    const done = new Map();
    const report = () => onProgress && onProgress([...done.values()].reduce((a, b) => a + b, 0) / total);

    const results = await Promise.all(jobs.map((j) => backend.putImage(j.path, j.blob, {
        contentType: j.contentType,
        cacheControl: j.cacheControl,
        onProgress: (f) => { done.set(j.key, f * j.blob.size); report(); }
    }).then((r) => [j.key, { path: r.path, url: r.url || null, contentType: j.contentType }])));

    const out = Object.fromEntries(results);
    return {
        version,
        aspect: processed.aspect,
        widthPx: processed.widthPx,
        heightPx: processed.heightPx,
        thumb: out.thumb, medium: out.medium, display: out.display,
        original: { path: out.original.path, contentType: out.original.contentType }
    };
}

export async function uploadNewArtwork(backend, fields, processed, order, onProgress) {
    const id = slugId(fields.title);
    const version = newVersion();
    await backend.createArtwork({
        id,
        schemaVersion: SCHEMA_VERSION,
        status: 'uploading',
        title: fields.title,
        year: fields.year ?? null,
        medium: fields.medium || '',
        description: fields.description || '',
        dimensions: fields.dimensions,
        frame: fields.frame || DEFAULT_FRAME,
        availability: fields.availability || 'available',
        showOnWorkPage: fields.showOnWorkPage !== false,
        order,
        images: { version, aspect: processed.aspect, widthPx: processed.widthPx, heightPx: processed.heightPx },
        placement: { placed: false }
    });
    const images = await uploadAll(backend, id, version, processed, onProgress);
    await backend.updateArtwork(id, { images, status: 'ready' });
    return id;
}

/** New version folder; the old one is retired and deleted at the next publish. */
export async function replaceArtworkImage(backend, artwork, processed, onProgress) {
    const images = await uploadAll(backend, artwork.id, newVersion(), processed, onProgress);
    const old = artwork.images || {};
    const retired = [old.thumb, old.medium, old.display, old.original].filter(Boolean).map((i) => i.path);
    await backend.updateArtwork(artwork.id, {
        images,
        retiredPaths: [...(artwork.retiredPaths || []), ...retired]
    });
}

function allPaths(a) {
    const i = a.images || {};
    return [i.thumb, i.medium, i.display, i.original].filter(Boolean).map((x) => x.path)
        .concat(a.retiredPaths || []);
}

/**
 * Never published: gone immediately. Live: kept as `trashed` so the site
 * doesn't lose its image before the next publish removes it for good.
 */
export async function trashArtwork(backend, artwork, publishedHashes = {}) {
    if (!publishedHashes[artwork.id]) {
        await Promise.all(allPaths(artwork).map((p) => backend.deleteObject(p)));
        await backend.deleteArtworkDoc(artwork.id);
    } else {
        await backend.updateArtwork(artwork.id, { status: 'trashed' });
    }
}

export async function purgeArtwork(backend, artwork) {
    await Promise.all(allPaths(artwork).map((p) => backend.deleteObject(p)));
    await backend.deleteArtworkDoc(artwork.id);
}

export function reorderArtworks(backend, ids) {
    return backend.updateMany(ids.map((id, i) => [id, { order: (i + 1) * 1000 }]));
}

export function nextOrder(artworks) {
    return artworks.reduce((m, a) => Math.max(m, a.order ?? 0), 0) + 1000;
}

export function savePlacements(backend, placements) {
    return backend.updateMany(Object.entries(placements).map(([id, placement]) => [id, { placement }]));
}

/**
 * The painting a visitor's camera opens on. Exclusive -- setting one clears
 * any other, in the same write, so two artworks can never both claim it
 * (which the last publish to load would resolve arbitrarily and no artist
 * would be able to predict).
 */
export function setStartHere(backend, artworks, id) {
    const entries = artworks
        .filter((a) => a.startHere && a.id !== id)
        .map((a) => [a.id, { startHere: false }]);
    entries.push([id, { startHere: true }]);
    return backend.updateMany(entries);
}

export function clearStartHere(backend, artworks) {
    const entries = artworks.filter((a) => a.startHere).map((a) => [a.id, { startHere: false }]);
    return entries.length ? backend.updateMany(entries) : Promise.resolve();
}
