import { FRAME_STYLES, DEFAULT_FRAME } from '../frames.js';
import { el } from './dom.js';

const MEDIUMS = ['Oil on canvas', 'Acrylic on canvas', 'Watercolour on paper', 'Gouache on paper',
    'Ink on paper', 'Charcoal on paper', 'Mixed media', 'Oil on board', 'Pastel on paper'];

const AVAILABILITY = [['available', 'Available'], ['on-hold', 'On hold'], ['sold', 'Sold'], ['nfs', 'Not for sale']];

let uid = 0;

/**
 * The artwork fields, shared by the upload section and the edit dialog.
 * Height follows width (and vice versa) from the image's proportions until the
 * artist types both, so the common case needs one number.
 */
export function createArtworkForm({ values = {}, onChange = () => {} } = {}) {
    const id = (name) => `f${++uid}-${name}`;
    let aspect = values.imageAspect || null;
    let unit = (values.dimensions && values.dimensions.unit) || 'in';
    let frame = values.frame || DEFAULT_FRAME;
    // Whichever side the artist hasn't typed follows the image's proportions.
    let widthTyped = false, heightTyped = false;

    const title = el('input', { id: id('title'), required: true, maxlength: 200, autocomplete: 'off', value: values.title || '' });
    const year = el('input', { id: id('year'), type: 'number', inputmode: 'numeric', min: 1900, max: 2100, value: values.year ?? '' });
    const listId = id('mediums');
    const medium = el('input', { id: id('medium'), list: listId, autocomplete: 'off', value: values.medium || '' });
    const width = el('input', { id: id('w'), type: 'number', inputmode: 'decimal', min: 0.5, step: 0.25, 'aria-label': 'Width', value: values.dimensions?.width ?? '' });
    const height = el('input', { id: id('h'), type: 'number', inputmode: 'decimal', min: 0.5, step: 0.25, 'aria-label': 'Height', value: values.dimensions?.height ?? '' });
    const description = el('textarea', { id: id('desc'), maxlength: 2000 });
    description.value = values.description || '';
    const availability = el('select', { id: id('avail') },
        AVAILABILITY.map(([v, label]) => el('option', { value: v, selected: (values.availability || 'available') === v, text: label })));
    const showOnWork = el('input', { id: id('work'), type: 'checkbox', checked: values.showOnWorkPage !== false });
    const ratioNote = el('p', { class: 'note', hidden: true });

    const unitBtns = ['in', 'cm'].map((u) => el('button', {
        type: 'button', 'aria-pressed': String(u === unit), text: u,
        onclick: () => {
            if (u === unit) return;
            const k = u === 'cm' ? 2.54 : 1 / 2.54;
            if (width.value) width.value = round(width.value * k);
            if (height.value) height.value = round(height.value * k);
            unit = u;
            unitBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === unit)));
            changed();
        }
    }));

    const swatches = Object.entries(FRAME_STYLES).map(([key, s]) => {
        const chip = el('i', key === 'none' ? { 'data-none': '' } : { style: `--sw:${swatchColor(s.color)}` });
        const b = el('button', {
            type: 'button', class: 'swatch', 'aria-pressed': String(key === frame), 'aria-label': key === 'none' ? s.label : `${s.label} frame`,
            onclick: () => {
                frame = key;
                swatches.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
                changed();
            }
        }, chip, s.label);
        return b;
    });

    function follow(from) {
        if (!aspect) return;
        if (from === 'w' && width.value) height.value = round(width.value / aspect);
        if (from === 'h' && height.value) width.value = round(height.value * aspect);
    }
    width.addEventListener('input', () => { widthTyped = true; if (!heightTyped) follow('w'); changed(); });
    height.addEventListener('input', () => { heightTyped = true; if (!widthTyped) follow('h'); changed(); });
    [title, year, medium, description, availability, showOnWork].forEach((i) => i.addEventListener('input', changed));
    showOnWork.addEventListener('change', changed);

    function checkRatio() {
        const w = Number(width.value), h = Number(height.value);
        const off = aspect && w > 0 && h > 0 ? Math.abs((w / h) / aspect - 1) : 0;
        ratioNote.hidden = off <= 0.03;
        ratioNote.replaceChildren('These proportions differ from the image, so it will be cropped to fit. ',
            el('button', {
                type: 'button', class: 'btn small', text: 'Match image',
                onclick: () => { follow('w'); heightTyped = false; changed(); }
            }));
    }

    function changed() {
        checkRatio();
        onChange(getValues());
    }

    const label = (forId, text, req) => el('span', {}, text, req ? el('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null);

    const root = el('div', { class: 'form' },
        el('label', { class: 'field full', for: title.id }, label(title.id, 'Title', true), title),
        el('label', { class: 'field', for: year.id }, label(year.id, 'Year'), year),
        el('label', { class: 'field', for: medium.id }, label(medium.id, 'Medium'), medium,
            el('datalist', { id: listId }, MEDIUMS.map((m) => el('option', { value: m })))),
        el('div', { class: 'field full' },
            el('span', {}, 'Size', el('span', { class: 'req', 'aria-hidden': 'true' }, ' *')),
            el('div', { class: 'dims' }, width, el('span', { class: 'x', text: '×' }), height, el('div', { class: 'seg', role: 'group', 'aria-label': 'Unit' }, unitBtns)),
            ratioNote),
        el('fieldset', { class: 'field full' }, el('legend', { text: 'Frame' }), el('div', { class: 'swatches' }, swatches)),
        el('label', { class: 'field', for: availability.id }, label(availability.id, 'Availability'), availability),
        el('label', { class: 'field check', for: showOnWork.id }, showOnWork, el('span', { text: 'Show on Work page', style: 'text-transform:none;letter-spacing:0;font-size:.92rem;color:var(--ink)' })),
        el('label', { class: 'field full', for: description.id }, label(description.id, 'Description'), description)
    );

    function getValues() {
        return {
            title: title.value.trim(),
            year: year.value ? Number(year.value) : null,
            medium: medium.value.trim(),
            description: description.value.trim(),
            dimensions: { width: Number(width.value) || null, height: Number(height.value) || null, unit },
            frame,
            availability: availability.value,
            showOnWorkPage: showOnWork.checked
        };
    }

    function validate() {
        const v = getValues();
        if (!v.title) { title.focus(); return 'Give the painting a title.'; }
        if (!(v.dimensions.width > 0) || !(v.dimensions.height > 0)) { width.focus(); return 'Enter the painting’s width and height.'; }
        if (v.year !== null && (v.year < 1900 || v.year > 2100)) { year.focus(); return 'That year looks off.'; }
        return null;
    }

    /** New image chosen: adopt its proportions, and prefill a size if none yet. */
    function setImageAspect(a) {
        aspect = a;
        widthTyped = heightTyped = false;
        if (!width.value && !height.value) {
            if (unit === 'cm') { height.value = 60; } else { height.value = 24; }
            follow('h');
        } else if (width.value) {
            follow('w');
        }
        changed();
    }

    function reset() {
        [title, year, medium, width, height].forEach((i) => { i.value = ''; });
        description.value = '';
        availability.value = 'available';
        showOnWork.checked = true;
        aspect = null; widthTyped = heightTyped = false;
        ratioNote.hidden = true;
    }

    return { el: root, getValues, validate, setImageAspect, reset, focus: () => title.focus() };
}

function round(v) {
    return Math.round(Number(v) * 4) / 4;
}

function swatchColor(hex) {
    return `#${hex.toString(16).padStart(6, '0')}`;
}
