import { galleryUrl } from '../cloud/config.js';
import { ABOUT_FIELDS } from '../cloud/schema.js';

// ---------------------------------------------------------------------------
// Fills the About page from whatever the artist last published.
//
// SDK-free on purpose: this is a plain fetch of one public JSON file, the same
// one the 3D scene reads, so the About page costs a visitor nothing beyond it.
// The static markup in about/index.html stays as the fallback and is only
// replaced where there is something to replace it with -- no cloud, no
// connection, or nothing written yet all leave the page exactly as authored.
// ---------------------------------------------------------------------------

/** Plain text to paragraphs, splitting on blank lines and keeping line breaks. */
function paragraphs(text) {
    return text.split(/\n{2,}/).map((block) => {
        const p = document.createElement('p');
        block.split('\n').forEach((line, i) => {
            if (i) p.appendChild(document.createElement('br'));
            p.appendChild(document.createTextNode(line));
        });
        return p;
    });
}

function fill(key, text) {
    const host = document.querySelector(`[data-about="${key}"]`);
    if (!host || !text) return;
    host.classList.remove('empty');
    host.replaceChildren(...paragraphs(text));
}

async function load() {
    const url = galleryUrl();
    if (!url) return;                       // not connected: keep the static page
    let about = null;
    try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) return;
        about = (await res.json()).about;
    } catch {
        return;                             // offline: keep the static page
    }
    if (!about) return;
    for (const { key } of ABOUT_FIELDS) fill(key, about[key]);
}

load();
