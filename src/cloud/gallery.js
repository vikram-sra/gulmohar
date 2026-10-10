import { galleryUrl, useLocalStudio } from './config.js';

/** SDK-free public read, including an explicitly selected local dev preview. */
export async function readGallery() {
    if (useLocalStudio()) {
        const { readLocalGallery } = await import('./localGallery.js');
        return readLocalGallery();
    }
    const url = galleryUrl();
    if (!url) throw new Error('No published gallery');
    const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('Gallery unavailable');
    return response.json();
}
