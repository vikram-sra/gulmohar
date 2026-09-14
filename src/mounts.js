// ---------------------------------------------------------------------------
// How a painting is held up, as plain data.
//
// Its own module, with no Three.js import, for the same reason src/frames.js
// is: both the 3D scene and the Studio need to agree on this vocabulary, and
// the Studio must not pull the renderer into its bundle to ask. It used to
// keep a private copy of the translation instead, which drifted until no key
// in it matched anything and every imported painting lost its mount.
// ---------------------------------------------------------------------------

export const MOUNTS = ['easel', 'ground', 'rope', 'surface'];

// Names written by editors this one replaced, still present in
// public/paintings.json and in anything exported before the Studio existed.
const LEGACY_MOUNTS = {
    'ground-lean': 'ground', lean: 'ground',
    'ground-flat': 'ground', flat: 'ground',
    tree: 'surface', wall: 'surface', hang: 'surface',
    free: 'surface'
};

/** A mount name from any era, as one of MOUNTS. */
export function normalizeMount(mount) {
    if (MOUNTS.includes(mount)) return mount;
    return LEGACY_MOUNTS[mount] || 'surface';
}
