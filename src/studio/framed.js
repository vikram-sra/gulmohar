import { frameStyle, frameBorderRatio, toInches, METRES_PER_INCH } from '../frames.js';
import { el } from './dom.js';

/**
 * A framed painting drawn in CSS. The border is derived from the same
 * frameBorderMetres rule as the 3D frame, expressed in cqi of the element's
 * own width, so previews stay proportionally true at any size.
 */
export function createFramed() {
    const canvas = el('div', { class: 'canvas loading', role: 'img' });
    const frame = el('div', { class: 'frame' }, canvas);
    const root = el('div', { class: 'framed' }, frame);
    // Updates are partial (e.g. just the image URL once it loads), so merge
    // into what's already known rather than resetting size and frame.
    const state = { dimensions: null, aspect: 1, frame: undefined };

    function update(patch) {
        if ('dimensions' in patch) state.dimensions = patch.dimensions;
        if ('aspect' in patch && patch.aspect) state.aspect = patch.aspect;
        if ('frame' in patch) state.frame = patch.frame;

        const d = state.dimensions || {};
        const wIn = toInches(Number(d.width) || 0, d.unit);
        const hIn = toInches(Number(d.height) || 0, d.unit);
        const ar = wIn > 0 && hIn > 0 ? wIn / hIn : state.aspect;
        canvas.style.setProperty('--ar', String(ar));

        const key = state.frame;
        const hasFrame = key !== 'none';
        frame.classList.toggle('has-frame', hasFrame);
        frame.style.setProperty('--frame-css', hasFrame ? frameStyle(key).css : 'none');
        if (hasFrame) {
            const wM = (wIn || 24 * ar) * METRES_PER_INCH;
            const hM = (hIn || 24) * METRES_PER_INCH;
            const r = frameBorderRatio(wM, hM);
            const m = Math.min(1, 1 / ar);
            frame.style.setProperty('--fb', String((100 * r * m) / (1 + 2 * r * m)));
        }

        if ('url' in patch) {
            canvas.classList.toggle('loading', !patch.url);
            canvas.style.backgroundImage = patch.url ? `url("${patch.url}")` : '';
        }
        if ('alt' in patch) canvas.setAttribute('aria-label', patch.alt);
    }

    return { el: root, update };
}
