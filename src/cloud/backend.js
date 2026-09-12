import { isCloudConfigured } from './config.js';

export function localBackendAllowed() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}

/** Firebase when configured; the local stand-in on localhost; otherwise null. */
export async function getBackend() {
    if (isCloudConfigured()) {
        const { createFirebaseBackend } = await import('./firebaseBackend.js');
        return createFirebaseBackend();
    }
    if (localBackendAllowed()) {
        const { createLocalBackend } = await import('./localBackend.js');
        return createLocalBackend();
    }
    return null;
}
