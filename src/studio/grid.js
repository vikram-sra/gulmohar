import { el, formatDims } from './dom.js';
import { createFramed } from './framed.js';

const AVAIL_LABEL = { sold: 'Sold', 'on-hold': 'On hold', nfs: 'Not for sale' };

/**
 * The "All paintings" grid. Cards are keyed by id and updated in place, so a
 * sync from another device doesn't close an open menu or break a drag.
 */
export function createGrid(container, actions) {
    const cards = new Map();
    let order = [];
    let dragId = null;
    let openMenu = null;

    document.addEventListener('pointerdown', (e) => {
        if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.more')) closeMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }

    function makeCard(id) {
        const framed = createFramed();
        const title = el('div', { class: 't' });
        const meta = el('div', { class: 'm' });
        const badges = el('div', { class: 'badges' });
        const placeBtn = el('button', { class: 'btn primary small', type: 'button' });
        const editBtn = el('button', { class: 'btn small', type: 'button', text: 'Edit' });
        const moreBtn = el('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'More actions', text: '⋯' });
        const node = el('li', { class: 'card', draggable: 'true' },
            moreBtn,
            el('div', { class: 'art' }, framed.el),
            el('div', {}, title, meta),
            badges,
            el('div', { class: 'actions' }, placeBtn, editBtn));

        const card = { el: node, framed, title, meta, badges, placeBtn, editBtn, moreBtn, artwork: null, url: undefined };

        placeBtn.addEventListener('click', () => actions.onPlace(card.artwork));
        editBtn.addEventListener('click', () => actions.onEdit(card.artwork));
        moreBtn.addEventListener('click', () => {
            if (openMenu && openMenu.parentNode === node) { closeMenu(); return; }
            closeMenu();
            const a = card.artwork;
            const idx = order.indexOf(a.id);
            const item = (text, fn, cls) => el('button', { type: 'button', role: 'menuitem', class: cls, text, onclick: () => { closeMenu(); fn(); } });
            openMenu = el('div', { class: 'menu', role: 'menu' },
                idx > 0 ? item('Move earlier', () => move(a.id, -1)) : null,
                idx < order.length - 1 ? item('Move later', () => move(a.id, 1)) : null,
                a.placement && a.placement.placed ? item('Remove from garden', () => actions.onUnplace(a)) : null,
                el('hr'),
                item('Delete painting', () => actions.onDelete(a), 'danger'));
            node.append(openMenu);
            openMenu.querySelector('button').focus();
        });

        node.addEventListener('dragstart', (e) => {
            dragId = id;
            node.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', id);
        });
        node.addEventListener('dragend', () => {
            dragId = null;
            node.classList.remove('dragging');
            cards.forEach((c) => c.el.classList.remove('drag-over'));
        });
        node.addEventListener('dragover', (e) => {
            if (!dragId || dragId === id) return;
            e.preventDefault();
            node.classList.add('drag-over');
        });
        node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
        node.addEventListener('drop', (e) => {
            e.preventDefault();
            node.classList.remove('drag-over');
            if (!dragId || dragId === id) return;
            const ids = order.filter((x) => x !== dragId);
            const target = ids.indexOf(id);
            const before = order.indexOf(dragId) > order.indexOf(id);
            ids.splice(before ? target : target + 1, 0, dragId);
            actions.onReorder(ids);
        });
        return card;
    }

    function move(id, dir) {
        const ids = order.slice();
        const i = ids.indexOf(id), j = i + dir;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        actions.onReorder(ids);
    }

    function updateCard(card, a, status) {
        card.artwork = a;
        card.title.textContent = a.title || 'Untitled';
        card.meta.textContent = [a.year, a.medium, formatDims(a.dimensions)].filter(Boolean).join(' · ');
        const placed = !!(a.placement && a.placement.placed);
        card.placeBtn.textContent = placed ? 'Move in garden' : 'Place in garden';
        card.placeBtn.disabled = a.status !== 'ready';
        card.framed.update({
            dimensions: a.dimensions, aspect: a.images && a.images.aspect, frame: a.frame,
            alt: `${a.title || 'Untitled'}, framed`
        });

        const b = (cls, text) => el('span', { class: `badge ${cls}`, text });
        card.badges.replaceChildren(...[
            a.status === 'uploading' ? b('uploading', 'Upload incomplete') : null,
            placed ? b('placed', 'In garden') : b('', 'Not placed'),
            status ? b(status, { live: 'Live', changed: 'Changed', new: 'Not live yet' }[status]) : null,
            AVAIL_LABEL[a.availability] ? b(a.availability === 'sold' ? 'sold' : '', AVAIL_LABEL[a.availability]) : null
        ].filter(Boolean));

        const thumb = a.images && a.images.thumb;
        const key = thumb ? thumb.path : null;
        if (key !== card.urlKey) {
            card.urlKey = key;
            card.framed.update({ url: null });
            if (thumb) actions.imageUrl(thumb).then((url) => { if (card.urlKey === key) card.framed.update({ url }); });
        }
    }

    function update(artworks, statusFor) {
        order = artworks.map((a) => a.id);
        const seen = new Set();
        artworks.forEach((a, i) => {
            let card = cards.get(a.id);
            if (!card) { card = makeCard(a.id); cards.set(a.id, card); }
            updateCard(card, a, statusFor(a));
            seen.add(a.id);
            if (container.children[i] !== card.el) container.insertBefore(card.el, container.children[i] || null);
        });
        for (const [id, card] of cards) {
            if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
        }
    }

    return { update };
}
