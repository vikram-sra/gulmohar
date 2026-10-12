import './artworkViewer.css';

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('aria-')) node.setAttribute(key, value);
        else node[key] = value;
    }
    node.append(...children.filter(Boolean));
    return node;
}
export const artworkTitle = item => item.title || 'Untitled';
export const artworkAvailability = item => ({ available: 'Available', reserved: 'Reserved', sold: 'Private collection', nfs: 'Not for sale' }[item.availability || 'available'] || item.availability);
export const artworkMetadata = item => {
    const w = item.widthIn || item.dimensions?.width, h = item.heightIn || item.dimensions?.height;
    return [item.year, item.medium, w && h ? `${w} × ${h} ${item.widthIn ? 'in' : item.dimensions?.unit || 'in'}` : ''].filter(Boolean).join(' · ');
};

export function createArtworkViewer({ items = [], imageUrl, gardenHref, onSelect = () => {}, onOpen = () => {}, onClose = () => {} }) {
    let collection = items, current = 0;
    const dialog = el('dialog', { className: 'artwork-viewer', 'aria-label': 'Painting details' });
    const content = el('div', { className: 'artwork-viewer-content' });
    const close = el('button', { type: 'button', textContent: 'Close', onclick: () => dialog.close() });
    const previous = el('button', { type: 'button', textContent: '← Previous', onclick: () => show(current - 1) });
    const next = el('button', { type: 'button', textContent: 'Next →', onclick: () => show(current + 1) });
    const count = el('span', { role: 'status' });
    dialog.append(el('div', { className: 'artwork-viewer-tools' }, previous, count, next, close), content);
    document.body.append(dialog);
    // Viewer interactions must not select garden objects behind the dialog.
    for (const event of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel']) {
        dialog.addEventListener(event, e => e.stopPropagation());
    }
    dialog.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault(); show(current + (e.key === 'ArrowRight' ? 1 : -1));
        }
    });
    dialog.addEventListener('click', e => {
        if (e.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', onClose);
    function show(index) {
        if (!collection.length) return;
        current = (index + collection.length) % collection.length;
        const item = collection[current];
        count.textContent = `${current + 1} / ${collection.length}`;
        previous.disabled = next.disabled = collection.length < 2;
        const title = artworkTitle(item);
        const details = el('div', { className: 'artwork-viewer-details' }, el('h2', { textContent: title }),
            el('p', { textContent: artworkMetadata(item) }), el('p', { textContent: item.description || '' }),
            el('p', { className: 'artwork-availability', textContent: artworkAvailability(item) }));
        const href = gardenHref?.(item);
        if (href) details.append(el('a', { href, textContent: 'See in the garden →' }));
        if ((item.availability || 'available') === 'available') details.append(el('a', {
            href: `mailto:gallery@gulmohar.art?subject=${encodeURIComponent(`Enquiry: ${title}`)}`, textContent: 'Enquire about this painting'
        }));
        const image = el('img', { src: imageUrl(item), alt: title });
        const status = el('p', { className: 'artwork-image-status', role: 'status', textContent: 'Loading painting…' });
        image.addEventListener('load', () => { status.hidden = true; });
        image.addEventListener('error', () => { status.textContent = 'Image unavailable. Please try again.'; });
        if (image.complete && image.naturalWidth) status.hidden = true;
        content.replaceChildren(el('div', { className: 'artwork-viewer-stage' }, image, status), details);
        if (!dialog.open) { onOpen(); dialog.showModal(); }
        onSelect(item);
    }
    return {
        show, setItems(nextItems) { collection = nextItems; },
        open(id) { show(Math.max(0, collection.findIndex(item => item.id === id))); },
        dispose() { if (dialog.open) dialog.close(); dialog.remove(); }
    };
}
