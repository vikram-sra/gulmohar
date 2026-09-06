// Helper to resolve asset URLs with the active base path (supports GitHub Pages subpaths)
export function getAssetUrl(path) {
    if (!path) return '';
    if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('data:')) {
        return path;
    }
    const base = import.meta.env.BASE_URL || './';
    const cleanPath = path.replace(/^\/+/, '');
    const cleanBase = base.endsWith('/') ? base : `${base}/`;
    return `${cleanBase}${cleanPath}`;
}
