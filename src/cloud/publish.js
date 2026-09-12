import { SCHEMA_VERSION, toPublicArtwork, hashPublic } from './schema.js';
import { purgeArtwork } from './artworks.js';

export function publicArtworks(backend, artworks) {
    return artworks.filter((a) => a.status === 'ready').map((a) => toPublicArtwork(a, backend.publicUrl));
}

/**
 * Makes the current drafts live. Order matters and the whole thing is safe to
 * re-run: images are flagged public first, then the gallery file -- one
 * object overwrite, the atomic switch -- then bookkeeping and cleanup.
 */
export async function publish(backend, artworks, published, onStep = () => {}) {
    const ready = artworks.filter((a) => a.status === 'ready');
    const pubs = publicArtworks(backend, artworks);

    onStep('Preparing images');
    const paths = ready.flatMap((a) => ['thumb', 'medium', 'display']
        .map((k) => a.images && a.images[k] && a.images[k].path).filter(Boolean));
    await Promise.all(paths.map((p) => backend.setPublic(p)));

    onStep('Going live');
    const revision = ((published && published.revision) || 0) + 1;
    const publishedAt = new Date().toISOString();
    const gallery = { schemaVersion: SCHEMA_VERSION, revision, publishedAt, artworks: pubs };
    await backend.putGallery(JSON.stringify(gallery), revision);

    const hashes = Object.fromEntries(pubs.map((p) => [p.id, hashPublic(p)]));
    await backend.setPublished({ revision, publishedAt, hashes });

    onStep('Tidying up');
    await Promise.all(artworks.filter((a) => a.status === 'trashed').map((a) => purgeArtwork(backend, a)));
    await Promise.all(ready.filter((a) => (a.retiredPaths || []).length).map(async (a) => {
        await Promise.all(a.retiredPaths.map((p) => backend.deleteObject(p)));
        await backend.updateArtwork(a.id, { retiredPaths: [] });
    }));

    return { revision, publishedAt, count: pubs.length };
}
