import './studio.css';
import { el, toast, confirmDialog } from './dom.js';
import { createGrid } from './grid.js';
import { createGardenSection } from './gardenSection.js';
import { createUploadSection } from './upload.js';
import { openEditDialog } from './detail.js';
import { getBackend } from '../cloud/backend.js';
import { toPublicArtwork, hashPublic, pendingChanges } from '../cloud/schema.js';
import {
    uploadNewArtwork, replaceArtworkImage, trashArtwork, reorderArtworks, nextOrder,
    setStartHere, clearStartHere
} from '../cloud/artworks.js';
import { publish, publicArtworks } from '../cloud/publish.js';
import { processImage } from '../cloud/images.js';
import { writeZip } from '../edit/zip.js';

const root = document.getElementById('studio');
let backend = null;
let artworks = [];
let landmarks = [];
let published = null;
let syncState = 'synced';
let appBuilt = false;

const header = (...right) => el('header', { class: 'site' },
    el('a', { class: 'name', href: '../' }, 'Gulmohar', el('small', { text: 'Studio' })),
    el('div', { class: 'studio-bar' }, ...right));

function gate(...children) {
    appBuilt = false;
    root.replaceChildren(header(), el('div', { class: 'gate' }, ...children));
}

async function boot() {
    backend = await getBackend();
    if (!backend) {
        gate(el('h1', { text: 'Not connected yet' }),
            el('p', { text: 'The studio isn’t linked to cloud storage yet. Add the Firebase config to src/cloud/config.js and deploy.' }));
        return;
    }
    backend.onUser(async (user) => {
        if (!user) return showSignIn();
        if (!(await backend.checkAccess())) return showNoAccess(user);
        if (!appBuilt) buildApp();
    });
}

function showSignIn() {
    const btn = el('button', { class: 'btn primary', type: 'button', text: backend.kind === 'local' ? 'Enter (local test mode)' : 'Sign in with Google' });
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await backend.signIn(); } catch (err) {
            btn.disabled = false;
            if (err && err.code === 'auth/popup-closed-by-user') return;
            toast(err && err.code === 'auth/popup-blocked'
                ? 'The sign-in window was blocked. Allow pop-ups for this site and try again.'
                : `Sign-in failed: ${err.message || err}`, { error: true, ms: 6000 });
        }
    });
    gate(el('h1', { text: 'Studio' }), el('p', { text: 'Upload paintings, arrange them in the garden, and publish.' }), btn);
}

function showNoAccess(user) {
    const copy = el('button', { class: 'btn small', type: 'button', text: 'Copy account ID' });
    copy.addEventListener('click', async () => { await navigator.clipboard.writeText(user.uid); toast('Copied.'); });
    gate(el('h1', { text: 'This account can’t edit' }),
        el('p', {}, `Signed in as ${user.email || user.name || 'an unknown account'}. If this is the artist’s account, put this ID in both Firebase rules files (in place of ARTIST_UID) and publish the rules:`,
            el('code', { text: user.uid })),
        copy,
        el('button', { class: 'btn', type: 'button', text: 'Sign out', onclick: () => backend.signOut() }));
}

function statusFor(a) {
    if (a.status !== 'ready') return null;
    const prev = published && published.hashes && published.hashes[a.id];
    if (!prev) return 'new';
    return prev === hashPublic(toPublicArtwork(a, backend.publicUrl)) ? 'live' : 'changed';
}

function buildApp() {
    appBuilt = true;
    const chip = el('span', { class: 'chip', 'data-state': 'synced', role: 'status', 'aria-live': 'polite', text: 'Synced' });
    const publishBtn = el('button', { class: 'btn accent', type: 'button', text: 'Publish', disabled: true });
    const moreBtn = el('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu', text: 'More' });
    const count = el('span', { class: 'count' });
    const gridEl = el('ul', { class: 'grid' });
    const empty = el('div', { class: 'empty', hidden: true });
    const uploadHost = el('div');
    const gardenHost = el('div');

    root.replaceChildren(
        header(chip, publishBtn, moreBtn),
        backend.kind === 'local' ? el('p', { class: 'local-banner', text: 'Local test mode — everything stays in this browser. Connect Firebase to sync between devices and go live.' }) : null,
        el('section', { 'aria-labelledby': 'h-all' },
            el('div', { class: 'section-head' }, el('h2', { id: 'h-all', text: 'All paintings' }), count),
            empty, gridEl),
        el('section', { 'aria-labelledby': 'h-garden' },
            el('div', { class: 'section-head' },
                el('h2', { id: 'h-garden', text: 'Garden artifacts' }),
                el('span', { class: 'count', text: 'The trees, the pavilion, the pond' })),
            gardenHost),
        el('section', { 'aria-labelledby': 'h-add' },
            el('div', { class: 'section-head' }, el('h2', { id: 'h-add', text: 'Add a painting' })),
            uploadHost));

    const garden = createGardenSection(gardenHost, {
        onSave: (id, patch) => backend.updateLandmark(id, patch)
    });

    const grid = createGrid(gridEl, {
        imageUrl: (img) => backend.imageUrl(img),
        onPlace: (a) => { location.href = `../?place=${encodeURIComponent(a.id)}`; },
        onEdit: (a) => openEditDialog(a, {
            imageUrl: (img) => backend.imageUrl(img),
            onSave: (v) => backend.updateArtwork(a.id, v),
            onReplaceImage: (p, prog) => replaceArtworkImage(backend, a, p, prog)
        }),
        onUnplace: (a) => backend.updateArtwork(a.id, { placement: { ...a.placement, placed: false } })
            .then(() => toast(`${a.title} taken out of the garden.`)),
        onDelete: async (a) => {
            const live = !!(published && published.hashes && published.hashes[a.id]);
            const ok = await confirmDialog({
                title: `Delete “${a.title || 'Untitled'}”?`,
                body: live ? 'It stays on the live site until you next publish, then it’s removed for good.' : 'The painting and its images are removed for good.',
                confirm: 'Delete', danger: true
            });
            if (ok) { await trashArtwork(backend, a, (published && published.hashes) || {}); toast('Deleted.'); }
        },
        onReorder: (ids) => reorderArtworks(backend, ids).catch((e) => toast(`Couldn’t reorder: ${e.message}`, { error: true })),
        onToggleStartHere: (a) => {
            const turningOn = !a.startHere;
            const write = turningOn ? setStartHere(backend, artworks, a.id) : clearStartHere(backend, artworks);
            return write
                .then(() => toast(turningOn ? `Visitors now open on “${a.title || 'Untitled'}”.` : 'No longer the opening view.'))
                .catch((e) => toast(`Couldn’t change that: ${e.message}`, { error: true }));
        }
    });

    const upload = createUploadSection(uploadHost, {
        onUpload: (values, processed, prog) => uploadNewArtwork(backend, values, processed, nextOrder(artworks), prog)
    });

    function render() {
        const visible = artworks.filter((a) => a.status !== 'trashed');
        grid.update(visible, statusFor);
        count.textContent = visible.length ? `${visible.length} painting${visible.length === 1 ? '' : 's'}` : '';
        empty.hidden = visible.length > 0;
        if (!visible.length) renderEmpty(empty);

        const pending = pendingChanges(publicArtworks(backend, artworks), (published && published.hashes) || {});
        publishBtn.textContent = pending.total
            ? `Publish ${pending.total} change${pending.total === 1 ? '' : 's'}`
            : (published ? 'All published' : 'Publish');
        publishBtn.disabled = !pending.total || syncState === 'offline';
        publishBtn.dataset.summary = `${pending.added} new, ${pending.changed} changed, ${pending.removed} removed`;
    }

    function setSync(state) {
        syncState = state;
        chip.dataset.state = state;
        chip.textContent = { synced: 'Synced', saving: 'Saving…', offline: 'Offline' }[state];
        render();
    }
    const onlineState = () => (navigator.onLine ? 'synced' : 'offline');
    window.addEventListener('online', () => setSync('synced'));
    window.addEventListener('offline', () => setSync('offline'));

    backend.watchArtworks((list, meta) => {
        artworks = list;
        setSync(meta.pending ? 'saving' : onlineState());
    }, (err) => toast(`Sync error: ${err.message}`, { error: true, ms: 6000 }));
    backend.watchLandmarks((list) => { landmarks = list; garden.update(landmarks); },
        (err) => toast(`Sync error: ${err.message}`, { error: true, ms: 6000 }));
    backend.watchPublished((p) => { published = p; render(); });

    publishBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({
            title: 'Publish to the live site?',
            body: `${publishBtn.dataset.summary}. Visitors see the new arrangement straight away.`,
            confirm: 'Publish'
        });
        if (!ok) return;
        publishBtn.disabled = true;
        try {
            const r = await publish(backend, artworks, landmarks, published, (step) => { publishBtn.textContent = `${step}…`; });
            toast(`Live — ${r.count} painting${r.count === 1 ? '' : 's'} published.`);
        } catch (err) {
            console.error(err);
            toast(`Publish failed: ${err.message || err}. It’s safe to try again.`, { error: true, ms: 7000 });
        } finally {
            render();
        }
    });

    moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const existing = document.querySelector('.menu.bar-menu');
        if (existing) { existing.remove(); return; }
        const item = (text, fn) => el('button', { type: 'button', role: 'menuitem', text, onclick: () => { menu.remove(); fn(); } });
        const menu = el('div', { class: 'menu bar-menu', role: 'menu', style: 'position:absolute;top:auto;right:0' },
            item('View the garden', () => { location.href = '../'; }),
            item('Download backup', () => downloadBackup()),
            el('hr'),
            item('Sign out', () => backend.signOut()));
        moreBtn.parentNode.style.position = 'relative';
        moreBtn.after(menu);
        const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
        setTimeout(() => document.addEventListener('pointerdown', close));
    });

    window.addEventListener('beforeunload', (e) => {
        if (upload.hasUnsaved() || syncState === 'saving') { e.preventDefault(); e.returnValue = ''; }
    });
}

let legacyPromise = null;
function legacyRecords() {
    legacyPromise = legacyPromise || fetch('../paintings.json', { cache: 'no-cache' })
        .then((res) => (res.ok ? res.json() : { paintings: [] }))
        .then((d) => d.paintings || [])
        .catch(() => []);
    return legacyPromise;
}

// Runs on every sync update, so it builds once rather than stacking buttons.
async function renderEmpty(host) {
    if (host.dataset.built) return;
    host.dataset.built = '1';
    host.replaceChildren(el('p', { text: 'No paintings yet. Add your first one below.' }));
    const legacy = await legacyRecords();
    if (!legacy.length || artworks.length) return;
    const btn = el('button', { class: 'btn small', type: 'button', text: `Import ${legacy.length} painting${legacy.length === 1 ? '' : 's'} from the old site` });
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Importing…';
        try {
            for (const r of legacy) await importLegacy(r);
            toast('Imported, with their garden positions.');
        } catch (err) {
            console.error(err);
            toast(`Import failed: ${err.message}`, { error: true });
            btn.disabled = false;
        }
    });
    host.append(el('p', {}, btn));
}

const LEGACY_MOUNT = { 'ground-lean': 'lean', 'ground-flat': 'flat', tree: 'hang', wall: 'hang' };

async function importLegacy(r) {
    const res = await fetch(`../${r.file}`);
    if (!res.ok) throw new Error(`couldn't fetch ${r.file}`);
    const blob = await res.blob();
    const name = r.file.split('/').pop();
    const processed = await processImage(new File([blob], name, { type: blob.type }));
    const id = await uploadNewArtwork(backend, {
        title: r.title || 'Untitled', year: r.year ?? null, medium: r.medium || '',
        dimensions: { width: r.widthIn, height: r.heightIn, unit: 'in' },
        frame: r.frame, availability: 'available'
    }, processed, nextOrder(artworks));
    // Transform copied exactly, so it renders where it always has.
    await backend.updateArtwork(id, {
        placement: {
            placed: true, anchor: r.anchor || 'world', mount: LEGACY_MOUNT[r.mount] || 'free',
            position: r.position || [0, 1.5, 0], rotation: r.rotation || [0, 0, 0], scale: r.scale || 1
        }
    });
}

async function downloadBackup() {
    toast('Preparing backup…', { ms: 10000 });
    try {
        const enc = new TextEncoder();
        const catalogue = artworks.filter((a) => a.status !== 'trashed').map((a) => {
            const { images, ...rest } = a;
            return { ...rest, images: images && { aspect: images.aspect, display: images.display && images.display.path } };
        });
        const files = [{ name: 'catalogue.json', data: enc.encode(JSON.stringify({ exportedAt: new Date().toISOString(), artworks: catalogue }, null, 2)) }];
        for (const a of artworks) {
            const img = a.images && a.images.display;
            if (!img || a.status === 'trashed') continue;
            const url = await backend.imageUrl(img);
            if (!url) continue;
            const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
            files.push({ name: `images/${a.id}.${img.path.split('.').pop()}`, data: buf });
        }
        const zip = writeZip(files);
        const link = el('a', { href: URL.createObjectURL(zip), download: `gulmohar-studio-${new Date().toISOString().slice(0, 10)}.zip` });
        document.body.append(link);
        link.click();
        link.remove();
        toast('Backup downloaded.');
    } catch (err) {
        console.error(err);
        toast(`Backup failed: ${err.message}`, { error: true });
    }
}

boot();
