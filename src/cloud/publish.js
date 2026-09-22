import { SCHEMA_VERSION, toPublicArtwork, hashPublic, hashLandmarks, hashAbout, toPublicAbout, ABOUT_ID } from './schema.js';
import { purgeArtwork } from './artworks.js';

export function publicArtworks(backend, artworks) {
    return artworks.filter((a) => a.status === 'ready').map((a) => toPublicArtwork(a, backend.publicUrl));
}

// The garden's fixtures are just a name and a description -- nothing here
// needs an image path or a status filter the way a painting does.
export function publicLandmarks(landmarks) {
    return (landmarks || [])
        // The About document shares this store but is not a garden fixture,
        // and has no business in the list the 3D scene reads for hover names.
        .filter((l) => l.id !== ABOUT_ID)
        .filter((l) => l.title || l.meta)
        .map((l) => ({ id: l.id, title: l.title || '', meta: l.meta || '' }));
}

/**
 * Makes the current drafts live. Order matters and the whole thing is safe to
 * re-run: images are flagged public first, then the gallery file -- one
 * object overwrite, the atomic switch -- then bookkeeping and cleanup.
 */
export async function publish(backend, artworks, landmarks, published, onStep = () => {}) {
    const ready = artworks.filter((a) => a.status === 'ready');
    const pubs = publicArtworks(backend, artworks);

    onStep('Preparing images');
    const paths = ready.flatMap((a) => ['thumb', 'medium', 'display']
        .map((k) => a.images && a.images[k] && a.images[k].path).filter(Boolean));
    await Promise.all(paths.map((p) => backend.setPublic(p)));

    onStep('Going live');
    const revision = ((published && published.revision) || 0) + 1;
    const publishedAt = new Date().toISOString();
    const gallery = {
        schemaVersion: SCHEMA_VERSION, revision, publishedAt,
        artworks: pubs, landmarks: publicLandmarks(landmarks),
        about: toPublicAbout(landmarks)
    };
    await backend.putGallery(JSON.stringify(gallery), revision);

    const hashes = Object.fromEntries(pubs.map((p) => [p.id, hashPublic(p)]));
    hashes._landmarks = hashLandmarks(landmarks);
    hashes._about = hashAbout(landmarks);
    await backend.setPublished({ revision, publishedAt, hashes });

    onStep('Tidying up');
    // Retain recent assets so historical revisions in public/history/{revision}.json
    // remain valid for rollbacks. Only permanently purge trashed docs that never went live
    // or have been superseded across multiple revisions.
    const trashed = artworks.filter((a) => a.status === 'trashed');
    for (const a of trashed) {
        if (!published || !published.hashes || !published.hashes[a.id]) {
            await purgeArtwork(backend, a);
        }
    }

    return { revision, publishedAt, count: pubs.length };
}
