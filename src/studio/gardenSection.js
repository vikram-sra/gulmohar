import { el, toast } from './dom.js';

// ---------------------------------------------------------------------------
// The garden's own fixtures -- the gulmohar, the banyan, the mango, the
// gazebo, the pond -- editable by name and description, listed here as
// "garden artifacts" alongside the paintings rather than folded into them:
// they aren't placed, replaced, or deleted the way an uploaded painting is,
// just named. A landmark doc doesn't exist until its first edit, so the
// defaults below are what a visitor sees (and what an untouched card shows)
// until an artist changes one.
// ---------------------------------------------------------------------------

export const DEFAULT_LANDMARKS = [
    { id: 'gulmohar', title: 'Royal Poinciana (Gulmohar)', meta: 'Delonix Regia · Centerpiece of the Garden' },
    { id: 'banyan', title: 'Chinese Banyan', meta: 'Ficus microcarpa · Click to visit' },
    { id: 'mango', title: 'Mango Tree', meta: 'Mangifera indica · Click to visit' },
    { id: 'gazebo', title: 'Garden Pavilion', meta: 'Tranquil Gazebo · Click to visit' },
    { id: 'pond', title: 'Garden Pond', meta: 'Still water, soft banks · Click to visit' }
];

/**
 * @param {HTMLElement} host
 * @param {{ onSave(id, patch): Promise }} actions
 * @returns {{ update(landmarks: Array) }}
 */
export function createGardenSection(host, actions) {
    const rows = new Map();

    function makeRow(id) {
        const def = DEFAULT_LANDMARKS.find((d) => d.id === id) || { title: id, meta: '' };
        const titleInput = el('input', { type: 'text', maxlength: 80, placeholder: def.title });
        const metaInput = el('input', { type: 'text', maxlength: 120, placeholder: def.meta });
        const saveBtn = el('button', { class: 'btn small', type: 'button', text: 'Save' });
        const status = el('span', { class: 'artifact-status' });

        let dirty = false;
        const markDirty = () => {
            dirty = true;
            saveBtn.disabled = false;
            status.textContent = '';
        };
        titleInput.addEventListener('input', markDirty);
        metaInput.addEventListener('input', markDirty);
        saveBtn.disabled = true;

        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
            try {
                await actions.onSave(id, {
                    title: titleInput.value.trim() || def.title,
                    meta: metaInput.value.trim() || def.meta
                });
                dirty = false;
                status.textContent = 'Saved';
                saveBtn.textContent = 'Save';
            } catch (err) {
                toast(`Couldn’t save: ${err.message || err}`, { error: true });
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        });

        const node = el('li', { class: 'artifact-row' },
            el('div', { class: 'artifact-fields' },
                el('label', {}, el('span', { class: 'artifact-label', text: 'Name' }), titleInput),
                el('label', {}, el('span', { class: 'artifact-label', text: 'Description' }), metaInput)),
            el('div', { class: 'artifact-actions' }, status, saveBtn));

        return { node, titleInput, metaInput, saveBtn, dirty: () => dirty };
    }

    const list = el('ul', { class: 'artifact-list' });
    DEFAULT_LANDMARKS.forEach(({ id }) => {
        const row = makeRow(id);
        rows.set(id, row);
        list.appendChild(row.node);
    });
    host.appendChild(list);

    function update(landmarks) {
        const byId = new Map((landmarks || []).map((l) => [l.id, l]));
        for (const [id, row] of rows) {
            // Don't clobber an edit in progress if a sync update lands mid-type.
            if (row.dirty()) continue;
            const saved = byId.get(id);
            const def = DEFAULT_LANDMARKS.find((d) => d.id === id);
            row.titleInput.value = (saved && saved.title) || '';
            row.metaInput.value = (saved && saved.meta) || '';
            row.titleInput.placeholder = def.title;
            row.metaInput.placeholder = def.meta;
        }
    }

    return { update };
}
