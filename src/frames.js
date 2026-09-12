// Frame styles as plain data, shared by the 3D scene and the Studio's CSS
// previews. The Studio must not import three.js, so nothing here does.

export const METRES_PER_INCH = 0.0254;
export const METRES_PER_CM = 0.01;

export const FRAME_STYLES = {
    'pale-wood': {
        label: 'Pale wood', color: 0xc9b79a, roughness: 0.62, metalness: 0.05,
        css: 'linear-gradient(135deg, #d8c8ab 0%, #c2ae8e 45%, #b19c7b 100%)'
    },
    'maple': {
        label: 'Maple', color: 0xc98a2e, roughness: 0.45, metalness: 0.15,
        css: 'linear-gradient(135deg, #d99a45 0%, #c2822a 50%, #a86d1f 100%)'
    },
    'ebony': {
        label: 'Ebony', color: 0x1f1b18, roughness: 0.4, metalness: 0.1,
        css: 'linear-gradient(135deg, #3a332d 0%, #221d19 55%, #15110e 100%)'
    },
    'white': {
        label: 'Gallery white', color: 0xf1ede4, roughness: 0.7, metalness: 0.0,
        css: 'linear-gradient(135deg, #fbf9f4 0%, #ece7dc 60%, #ddd6c8 100%)'
    },
    'none': {
        label: 'No frame', color: 0x3a4238, roughness: 0.7, metalness: 0.0,
        css: 'none'
    }
};

export const DEFAULT_FRAME = 'pale-wood';

export function frameStyle(key) {
    return FRAME_STYLES[key] || FRAME_STYLES[DEFAULT_FRAME];
}

/** Frame border width in metres for a painting of w x h metres. */
export function frameBorderMetres(w, h) {
    return Math.min(0.05, Math.max(0.02, Math.min(w, h) * 0.045));
}

/** Border as a fraction of the painting's shorter side -- what the CSS frame needs. */
export function frameBorderRatio(w, h) {
    return frameBorderMetres(w, h) / Math.max(Math.min(w, h), 1e-6);
}

export function toInches(value, unit) {
    return unit === 'cm' ? value / 2.54 : value;
}
