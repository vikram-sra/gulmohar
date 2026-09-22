import { galleryUrl } from '../cloud/config.js';

// ---------------------------------------------------------------------------
// Dynamic catalogue loader for the Work page.
// SDK-free: reads the published gallery.json (or local paintings.json fallback),
// respecting artist ordering and work page visibility.
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k.startsWith('data-')) node.setAttribute(k, v);
        else node[k] = v;
    }
    for (const c of children.flat()) {
        if (!c) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

function renderCard(item) {
    const title = item.title || 'Untitled';
    const year = item.year ? `${item.year}` : '';
    const medium = item.medium || '';
    const w = item.widthIn || (item.dimensions && item.dimensions.width);
    const h = item.heightIn || (item.dimensions && item.dimensions.height);
    const dim = (w && h) ? `${w} × ${h} in` : '';

    const metaParts = [year, medium, dim].filter(Boolean).join(' · ');
    const avail = item.availability || 'available';
    const availLabel = { available: 'Available', reserved: 'Reserved', sold: 'Private collection' }[avail] || avail;

    // Image URL resolution
    let src = '';
    if (item.images) {
        src = item.images.display || item.images.medium || item.images.thumb || '';
    } else if (item.file) {
        src = item.file.startsWith('/') || item.file.startsWith('http') ? item.file : `../${item.file}`;
    }

    const enquireHref = `mailto:gallery@gulmohar.art?subject=${encodeURIComponent(`Enquiry: ${title}`)}`;

    const figure = el('figure', {},
        el('div', { class: 'plate' },
            src ? el('img', {
                src,
                alt: `${title} — ${medium || 'painting'}`,
                loading: 'lazy',
                decoding: 'async',
                onerror(e) { e.target.style.opacity = '0.3'; }
            }) : null
        ),
        el('figcaption', {},
            el('div', { class: 't' }, title),
            metaParts ? el('div', { class: 'm' }, metaParts) : null,
            el('div', { class: 'card-footer', style: 'display:flex; justify-content:space-between; align-items:center; margin-top:8px;' },
                el('span', { class: 's' }, availLabel),
                avail === 'available' ? el('a', {
                    href: enquireHref,
                    style: 'font-size:0.75rem; letter-spacing:0.08rem; text-transform:uppercase; text-decoration:none; color:var(--muted); border-bottom:1px solid var(--rule);'
                }, 'Enquire →') : null
            )
        )
    );

    return el('li', {}, figure);
}

async function loadCatalogue() {
    const listEl = document.querySelector('.works');
    const ledeEl = document.querySelector('.lede');
    if (!listEl) return;

    let items = null;
    const cloud = galleryUrl();

    if (cloud) {
        try {
            const res = await fetch(cloud, { cache: 'no-cache', signal: AbortSignal.timeout(6000) });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.artworks) && data.artworks.length) {
                    items = data.artworks
                        .filter((a) => a.showOnWorkPage !== false)
                        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                }
            }
        } catch {
            // Fall through to local fallback
        }
    }

    if (!items) {
        try {
            const res = await fetch('../paintings.json', { cache: 'no-cache' });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.paintings)) {
                    items = data.paintings;
                }
            }
        } catch {
            return; // keep static markup
        }
    }

    if (!items || !items.length) return;

    listEl.replaceChildren(...items.map(renderCard));
    if (ledeEl) {
        ledeEl.textContent = `${items.length} work${items.length === 1 ? '' : 's'} on exhibition. Placed in the garden and listed here.`;
    }
}

loadCatalogue();
