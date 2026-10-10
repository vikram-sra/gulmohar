import { readGallery } from '../cloud/gallery.js';
import './work.css';
import { createArtworkViewer, artworkTitle as title, artworkAvailability as availability, artworkMetadata as metadata } from '../gallery/artworkViewer.js';

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('aria-')) node.setAttribute(key, value);
        else node[key] = value;
    }
    node.append(...children.filter(Boolean));
    return node;
}
const image = item => item.images?.display || item.images?.medium || item.images?.thumb || (item.file ? `../${item.file}` : '');
const inGarden = item => (item.placement && item.placement.placed !== false && Array.isArray(item.placement.position)) || (!item.placement && Array.isArray(item.position));

async function loadCatalogue() {
    const list = document.querySelector('.works');
    let items;
    try {
        const data = await readGallery();
        if (!Array.isArray(data.artworks)) throw new Error('Invalid gallery');
        items = data.artworks.filter(a => a.showOnWorkPage !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch {
        try {
            const response = await fetch('../paintings.json', { signal: AbortSignal.timeout(6000) });
            if (!response.ok) throw new Error('Catalogue unavailable');
            items = (await response.json()).paintings;
        } catch { return; }
    }
    if (!Array.isArray(items)) return;
    document.querySelector('.lede').textContent = 'Explore the collection. Open a painting for a closer look, or visit it in the garden.';
    const search = el('input', { type: 'search', placeholder: 'Search paintings', 'aria-label': 'Search by title, medium or year' });
    const filter = el('select', { 'aria-label': 'Filter by availability' }, ...[['', 'All works'], ['available', 'Available'], ['reserved', 'Reserved'], ['sold', 'Private collection'], ['nfs', 'Not for sale']].map(([value, textContent]) => el('option', { value, textContent })));
    const count = el('p', { className: 'work-count', role: 'status' });
    list.before(el('div', { className: 'work-tools' }, search, filter), count);
    let visible = [];
    const viewer = createArtworkViewer({ imageUrl: image,
        gardenHref: item => inGarden(item) ? `../?painting=${encodeURIComponent(item.id)}` : null });
    for (const link of document.querySelectorAll('a[href="../"]')) link.href = '../?restore=1';
    function show(index) { viewer.setItems(visible); viewer.show(index); }
    function render() {
        const query = search.value.trim().toLowerCase();
        visible = items.filter(item => (!filter.value || (item.availability || 'available') === filter.value) && [title(item), item.medium, item.year].join(' ').toLowerCase().includes(query));
        count.textContent = `${visible.length} of ${items.length} works`;
        list.replaceChildren(...visible.map((item, index) => el('li', {},
            el('figure', {}, el('button', { type: 'button', className: 'plate', 'aria-label': `View ${title(item)}`, onclick: () => show(index) },
                el('img', { src: image(item), alt: title(item), loading: 'lazy', decoding: 'async' })),
            el('figcaption', {}, el('div', { className: 't', textContent: title(item) }), el('div', { className: 'm', textContent: metadata(item) }), el('span', { className: 's', textContent: availability(item) }))))));
        if (!visible.length) list.append(el('li', { className: 'empty', textContent: items.length ? 'No paintings match. Try another search or choose All works.' : 'New paintings will appear here when the collection is published.' }));
    }
    search.addEventListener('input', render);
    filter.addEventListener('change', render);
    render();
}
loadCatalogue();
