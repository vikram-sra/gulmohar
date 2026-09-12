// Pure mapping between the Studio's draft documents, the published gallery,
// and the placement records the 3D scene mounts. No SDK imports: the visitor
// bundle depends on this file.
import { toInches, DEFAULT_FRAME } from '../frames.js';

export const SCHEMA_VERSION = 1;

export function dimensionsInInches(dimensions) {
    const d = dimensions || {};
    return {
        widthIn: toInches(Number(d.width) || 24, d.unit),
        heightIn: toInches(Number(d.height) || 24, d.unit)
    };
}

/**
 * The public shape of one artwork: exactly what visitors may see. `urlFor`
 * maps a Storage path to a public URL, so this stays SDK-free.
 */
export function toPublicArtwork(a, urlFor) {
    const { widthIn, heightIn } = dimensionsInInches(a.dimensions);
    const img = a.images || {};
    const p = a.placement || {};
    return {
        id: a.id,
        title: a.title || 'Untitled',
        year: a.year ?? null,
        medium: a.medium || '',
        description: a.description || '',
        dimensions: a.dimensions || null,
        widthIn: round(widthIn, 3),
        heightIn: round(heightIn, 3),
        frame: a.frame || DEFAULT_FRAME,
        availability: a.availability || 'available',
        order: a.order ?? 0,
        showOnWorkPage: a.showOnWorkPage !== false,
        images: {
            aspect: img.aspect || widthIn / heightIn,
            thumb: img.thumb ? urlFor(img.thumb.path) : null,
            medium: img.medium ? urlFor(img.medium.path) : null,
            display: img.display ? urlFor(img.display.path) : null
        },
        placement: p.placed ? {
            anchor: p.anchor || 'world',
            mount: p.mount || 'surface',
            position: (p.position || [0, 1.5, 0]).map((v) => round(v, 4)),
            rotation: (p.rotation || [0, 0, 0]).map((v) => round(v, 5)),
            scale: round(p.scale || 1, 4),
            // Rope length above the frame; meaningless for the other mounts,
            // so it is only carried when it would actually be drawn.
            ...(p.mount === 'rope' ? { rise: round(p.rise || 0.9, 3) } : {})
        } : null
    };
}

/** Converts a public artwork into the record paintings.js mounts. Null if unplaced. */
export function toPlacementRecord(pub, { preferMedium = false } = {}) {
    if (!pub || !pub.placement) return null;
    const img = pub.images || {};
    return {
        id: pub.id,
        file: (preferMedium ? img.medium : img.display) || img.display || img.medium || img.thumb,
        widthIn: pub.widthIn,
        heightIn: pub.heightIn,
        title: pub.title,
        year: pub.year,
        medium: pub.medium,
        frame: pub.frame,
        anchor: pub.placement.anchor,
        mount: pub.placement.mount,
        position: pub.placement.position,
        rotation: pub.placement.rotation,
        scale: pub.placement.scale,
        rise: pub.placement.rise
    };
}

export function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** FNV-1a over the stable JSON -- enough to tell "changed since publish". */
export function hashPublic(pub) {
    const s = stableStringify(pub);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

/** Diff the live drafts against the last publish. */
export function pendingChanges(publicArtworks, publishedHashes = {}) {
    const live = new Set();
    let added = 0, changed = 0;
    for (const pub of publicArtworks) {
        live.add(pub.id);
        const prev = publishedHashes[pub.id];
        if (!prev) added++;
        else if (prev !== hashPublic(pub)) changed++;
    }
    const removed = Object.keys(publishedHashes).filter((id) => !live.has(id)).length;
    return { added, changed, removed, total: added + changed + removed };
}

export function slugId(title) {
    const slug = String(title || 'untitled').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled';
    const rand = Math.random().toString(36).slice(2, 6);
    return `${slug}-${rand}`;
}

function round(v, digits) {
    const f = 10 ** digits;
    return Math.round(Number(v) * f) / f;
}
