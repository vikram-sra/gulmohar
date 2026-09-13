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

// A drawn likeness per fixture rather than a photo: these are modelled
// objects, so there is no photograph of them to use, and rendering the real
// thing would mean standing up a WebGL context per card (see framed.js's
// note on the same problem for paintings). Each is the same flat, line-and-
// wash language as the rest of the Studio.
const ART = {
    tree: (canopy, trunk) => `<svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="26" r="17" fill="${canopy}"/>
        <circle cx="20" cy="32" r="11" fill="${canopy}"/>
        <circle cx="44" cy="32" r="11" fill="${canopy}"/>
        <path d="M30 40h4v18h-4z" fill="${trunk}"/>
        <path d="M32 48l-7-6M32 52l7-6" stroke="${trunk}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      </svg>`,
    gazebo: () => `<svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M32 8 54 26H10z" fill="#8a6c4a"/>
        <path d="M14 26h4v28h-4zM46 26h4v28h-4zM30 26h4v28h-4z" fill="#6f573b"/>
        <path d="M10 54h44v4H10z" fill="#a08a68"/>
        <path d="M14 42h36v3H14z" fill="#6f573b"/>
      </svg>`,
    pond: () => `<svg viewBox="0 0 64 64" aria-hidden="true">
        <ellipse cx="32" cy="36" rx="24" ry="15" fill="#5E8A86"/>
        <ellipse cx="32" cy="33" rx="24" ry="15" fill="#79a8a2"/>
        <path d="M14 32h12M34 38h14M22 42h10" stroke="#cfe3df" stroke-width="2.5"
              stroke-linecap="round" fill="none" opacity="0.75"/>
      </svg>`
};

export const DEFAULT_LANDMARKS = [
    { id: 'gulmohar', title: 'Royal Poinciana (Gulmohar)', meta: 'Delonix Regia · Centerpiece of the Garden', art: ART.tree('#c4485f', '#7a5a3f') },
    { id: 'banyan', title: 'Chinese Banyan', meta: 'Ficus microcarpa · Click to visit', art: ART.tree('#4a7a4e', '#6b5340') },
    { id: 'mango', title: 'Mango Tree', meta: 'Mangifera indica · Click to visit', art: ART.tree('#5f8f45', '#75593d') },
    { id: 'gazebo', title: 'Garden Pavilion', meta: 'Tranquil Gazebo · Click to visit', art: ART.gazebo() },
    { id: 'pond', title: 'Garden Pond', meta: 'Still water, soft banks · Click to visit', art: ART.pond() }
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

        const art = el('div', { class: 'artifact-art' });
        art.innerHTML = def.art || '';

        const node = el('li', { class: 'artifact-row' },
            art,
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
