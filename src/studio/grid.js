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
    function closeMenu() {
        if (!openMenu) return;
        const owner = openMenu.parentNode && openMenu.parentNode.querySelector('.more');
        if (owner) owner.setAttribute('aria-expanded', 'false');
        openMenu.remove();
        openMenu = null;
    }

    function makeCard(id) {
        const framed = createFramed();
        const title = el('div', { class: 't' });
        const meta = el('div', { class: 'm' });
        const status = el('div', { class: 's' });
        const placeBtn = el('button', { class: 'btn primary small', type: 'button' });
        const editBtn = el('button', { class: 'btn small', type: 'button', text: 'Edit' });
        const moreBtn = el('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More actions', text: '⋯' });
        // The artwork carries the card: no panel, no border, no button row
        // sitting under every painting. Actions live over the image and only
        // surface on hover or keyboard focus, so a wall of twenty paintings
        // reads as a wall of paintings.
        const node = el('li', { class: 'card', draggable: 'true' },
            el('div', { class: 'art' },
                framed.el,
                el('div', { class: 'overlay' }, placeBtn, editBtn),
                moreBtn),
            el('div', { class: 'cap' }, title, meta, status));

        const card = { el: node, framed, title, meta, status, placeBtn, editBtn, moreBtn, artwork: null, url: undefined };

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
            moreBtn.setAttribute('aria-expanded', 'true');
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

        // One quiet line instead of a row of pills. "Live" and "Not placed"
        // are the resting states and say nothing loudly; anything that wants
        // the artist to act -- an incomplete upload, unpublished edits --
        // colours the whole line rather than adding another chip to scan.
        const parts = [
            a.status === 'uploading' ? 'Upload incomplete' : null,
            placed ? 'In garden' : 'Not placed',
            status ? { live: 'Live', changed: 'Changed', new: 'Not live yet' }[status] : null,
            AVAIL_LABEL[a.availability] || null
        ].filter(Boolean);
        card.status.textContent = parts.join(' · ');
        // "Not live yet" is where every painting starts, so it is not a
        // warning -- colouring it would make the whole wall amber before the
        // first publish and leave nothing for the states that do need a look.
        card.status.classList.toggle('warn', a.status === 'uploading' || status === 'changed');

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
