import { el, toast } from './dom.js';
import { ABOUT_FIELDS } from '../cloud/schema.js';

// ---------------------------------------------------------------------------
// The About page's prose, edited here rather than in the HTML.
//
// It lives in the same store as the garden artifacts and publishes in the same
// step, so "write your bio" is the same act as "rename the pond": type, Save,
// Publish. The page itself renders whatever is here and falls back to its own
// static markup when nothing has been written, so an unpublished site is never
// a page of empty headings.
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} host
 * @param {{ onSave(patch): Promise }} actions
 * @returns {{ update(doc: object|null) }}
 */
export function createAboutSection(host, actions) {
    const inputs = new Map();
    let dirty = false;

    const saveBtn = el('button', { class: 'btn small', type: 'button', text: 'Save' });
    const status = el('span', { class: 'artifact-status' });
    saveBtn.disabled = true;

    const markDirty = () => {
        dirty = true;
        saveBtn.disabled = false;
        status.textContent = '';
    };

    const rows = ABOUT_FIELDS.map(({ key, label, rows: rowCount, hint }) => {
        const ta = el('textarea', { rows: rowCount, maxlength: 4000 });
        ta.addEventListener('input', markDirty);
        inputs.set(key, ta);
        return el('label', { class: 'field full' },
            el('span', { class: 'artifact-label', text: label }),
            ta,
            hint ? el('span', { class: 'hint', text: hint }) : null);
    });

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            const patch = {};
            for (const [key, ta] of inputs) patch[key] = ta.value.trim();
            await actions.onSave(patch);
            dirty = false;
            status.textContent = 'Saved';
        } catch (err) {
            toast(`Couldn’t save: ${err.message || err}`, { error: true });
            saveBtn.disabled = false;
        }
        saveBtn.textContent = 'Save';
    });

    host.append(
        el('div', { class: 'about-fields' }, ...rows),
        el('div', { class: 'artifact-actions' }, status, saveBtn));

    function update(doc) {
        // Never clobber an edit in progress if a sync update lands mid-type --
        // the same rule the garden artifacts follow.
        if (dirty) return;
        for (const [key, ta] of inputs) ta.value = (doc && doc[key]) || '';
    }

    return { update };
}
