import * as THREE from 'three';
import './place.css';
import { getBackend } from '../cloud/backend.js';
import { dimensionsInInches } from '../cloud/schema.js';
import {
    createPaintingMesh, createMountFurniture, loadPanelTexture, normalizeMount
} from '../scene/paintings.js';
import { groundHeightAt } from '../scene/garden.js';
import { fitSurfaces, buildTrunkProxies, canopyOver } from './surfaces.js';

// ---------------------------------------------------------------------------
// Placement mode -- /?place=<id>.
//
// You arrive holding the painting: it rides in the corner of your view, small
// enough to see past, while you walk the garden with the normal first-person
// controls. A ghost shows where it would land if you stopped here. Tap
// "Place here" and the four ways a painting can meet this garden open up --
// easel, ground, rope, surface -- with the ones that don't apply where you're
// aiming dimmed and saying why instead of silently doing nothing. Pick one,
// nudge size and angle, save.
//
// Everything here is loaded on demand from main.js, and the Firebase SDK stays
// behind getBackend()'s own dynamic import, so a visitor downloads none of it
// (enforced by scripts/check-bundle.mjs).
// ---------------------------------------------------------------------------

const MOUNTS = {
    easel: { label: 'On an easel', hint: 'Standing on open ground', tilt: -0.16, denied: 'Aim at open ground' },
    ground: { label: 'On the ground', hint: 'Resting against the grass', tilt: -0.34, denied: 'Aim at open ground' },
    rope: { label: 'Hung by rope', hint: 'Suspended from the branches', tilt: 0, denied: 'Stand under a tree' },
    surface: { label: 'Hung on a surface', hint: 'Flat against bark or post', tilt: 0, denied: 'Aim at a trunk or the gazebo' }
};
const ORDER = ['easel', 'ground', 'rope', 'surface'];

const SIZE_MIN = 0.5, SIZE_MAX = 4.0, SIZE_STEP = 0.1;
const AIM_INTERVAL_MS = 66;            // ~15Hz; a ghost does not need 60
const CARRY_DISTANCE = 0.8;            // metres in front of the eye
const CARRY_SCREEN_FRACTION = 0.22;    // of the viewport's height
const ROPE_TOP = 2.35;                 // where the frame's top edge hangs
const ROPE_LENGTH = 0.75;              // rope visible above it, into the leaves

export async function attachPlaceMode(app, artworkId) {
    const backend = await getBackend();
    if (!backend) return fail('This device has no studio connection, so nothing can be placed here.');

    const user = await awaitAccess(backend);
    if (!user) return fail('Sign in to the Studio on this device first, then try again.');

    const artwork = await firstArtwork(backend, artworkId);
    if (!artwork) return fail('That painting is no longer in the studio.');

    const { widthIn, heightIn } = dimensionsInInches(artwork.dimensions);
    const w = widthIn * 0.0254, h = heightIn * 0.0254;
    const saved = artwork.placement && artwork.placement.placed ? artwork.placement : null;

    const garden = app.garden.group;
    const surfaces = fitSurfaces(garden);
    const proxies = buildTrunkProxies(garden, surfaces.trunks, {
        visible: new URLSearchParams(location.search).has('proxies')
    });
    const targets = [app.groundMesh, ...proxies];
    const gazebo = garden.getObjectByName('Gazebo');
    if (gazebo) gazebo.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });

    const state = {
        phase: 'carrying',                            // 'carrying' | 'placed'
        mount: saved ? normalizeMount(saved.mount) : null,
        size: saved ? (saved.scale || 1) : 1,
        yawOffset: 0,
        aim: null,
        dirty: false,
        saving: false,
        optionsOpen: false
    };

    // ---- the painting, in three roles -----------------------------------
    const carry = createPaintingMesh(widthIn, heightIn, artwork.frame);
    carry.group.rotation.set(0.05, -0.3, 0.04);
    carry.group.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });

    /**
     * Tucks the carried painting into the bottom-right corner, sized as a
     * fraction of what the eye can see rather than as a fixed number of
     * metres. A phone in portrait has a far narrower view than a laptop at
     * the same FOV, and a fixed size that reads as "held in your hand" on one
     * fills half the screen on the other.
     */
    let carryLaidOutFor = '';
    function layOutCarry() {
        const key = `${app.camera.fov}/${app.camera.aspect}`;
        if (key === carryLaidOutFor) return;
        const halfH = CARRY_DISTANCE * Math.tan(THREE.MathUtils.degToRad(app.camera.fov) / 2);
        const halfW = halfH * app.camera.aspect;
        // A hidden or mid-resize canvas reports 0x0, so aspect is 0/0. Writing
        // that through leaves the painting at a NaN position and it never
        // renders again. Driving this from the frame loop rather than from a
        // resize event means the next good frame repairs it either way.
        if (!Number.isFinite(halfW) || halfW <= 0) return;
        carryLaidOutFor = key;
        const scale = (halfH * 2 * CARRY_SCREEN_FRACTION) / Math.max(w, h);
        carry.group.scale.setScalar(scale);
        // Inset by the painting's own half-extent plus a margin, so the corner
        // it sits in is the same corner at every aspect ratio.
        const margin = halfH * 0.08;
        carry.group.position.set(
            halfW - (w * scale) / 2 - margin,
            -halfH + (h * scale) / 2 + margin,
            -CARRY_DISTANCE
        );
    }
    layOutCarry();
    // Anything parented to the camera only renders if the camera is itself in
    // the scene graph -- normally it isn't, since nothing else needs it there.
    app.scene.add(app.camera);
    app.camera.add(carry.group);

    // The ghost has to read at a glance against pale bark, dark grass and
    // bright sky alike. A translucent copy of the painting does not: lit by
    // the same sun as everything else, it disappears into whatever is behind
    // it. So it is drawn unlit, in the site's accent colour on the frame with
    // a pale panel, which nothing in this garden is.
    const ghost = createPaintingMesh(widthIn, heightIn, artwork.frame);
    ghost.group.visible = false;
    const ghostPanelMat = new THREE.MeshBasicMaterial({
        color: 0xfdf6ea, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide
    });
    const ghostFrameMat = new THREE.MeshBasicMaterial({
        color: 0xd9502f, transparent: true, opacity: 0.78, depthWrite: false
    });
    ghost.group.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = false;
        // The hitbox carries a deliberately invisible material; swapping it
        // for a visible one would draw it as a slab around the frame.
        if (!o.material || o.material.visible === false) return;
        o.material = o === ghost.panel ? ghostPanelMat : ghostFrameMat;
    });
    garden.add(ghost.group);

    let live = null, furniture = null;

    loadArtworkTexture(backend, artwork).then((tex) => {
        if (!tex) return;
        [carry, ghost, live].forEach((p) => {
            if (!p) return;
            p.panel.material.map = tex;
            p.panel.material.needsUpdate = true;
        });
    });

    // ---- what can go where ----------------------------------------------
    function availability() {
        const a = state.aim;
        const onGround = !!(a && a.kind === 'ground');
        return {
            easel: onGround,
            ground: onGround,
            rope: onGround && !!a.canopy,
            surface: !!(a && a.kind === 'surface')
        };
    }

    /** The transform a given mount produces at the current aim, or null. */
    function transformFor(mount) {
        const a = state.aim;
        if (!a || !availability()[mount]) return null;
        const scale = state.size;
        const hs = h * scale;

        if (mount === 'surface') {
            const yaw = Math.atan2(a.normal.x, a.normal.z);
            // Stand it off the bark by the frame's own depth, so it sits on
            // the surface rather than half inside it.
            const pos = a.point.clone().addScaledVector(a.normal, 0.05 * scale);
            pos.y = Math.max(pos.y, a.ground + hs / 2 + 0.35);
            return { position: pos, rotation: new THREE.Euler(0, yaw, 0), rise: 0 };
        }

        const yaw = facingYaw(a.point) + state.yawOffset;

        if (mount === 'rope') {
            const top = Math.min(ROPE_TOP, a.canopy.top - ROPE_LENGTH - 0.3);
            const centreY = Math.max(a.ground + hs / 2 + 0.4, top - hs / 2);
            return {
                position: new THREE.Vector3(a.point.x, centreY, a.point.z),
                rotation: new THREE.Euler(0, yaw, 0),
                rise: ROPE_LENGTH
            };
        }

        const tilt = MOUNTS[mount].tilt;
        // An easel holds the canvas up; on the ground it just leans back on
        // its own bottom edge, which is what sets the two heights apart.
        const lift = mount === 'easel' ? 0.62 : 0.01;
        const centreY = a.ground + lift + (hs / 2) * Math.cos(tilt);
        return {
            position: new THREE.Vector3(a.point.x, centreY, a.point.z),
            rotation: new THREE.Euler(tilt, yaw, 0),
            rise: 0
        };
    }

    function facingYaw(point) {
        const c = app.camera.position;
        return Math.atan2(c.x - point.x, c.z - point.z);
    }

    function apply(group, t) {
        group.position.copy(t.position);
        group.rotation.copy(t.rotation);
        group.scale.setScalar(state.size);
    }

    function refreshGhost() {
        if (state.phase !== 'carrying') { ghost.group.visible = false; return; }
        const avail = availability();
        // Before a mount is chosen the ghost previews the most sensible one
        // for whatever you're aiming at, so a spot reads as a spot.
        const preview = state.mount && avail[state.mount] ? state.mount
            : ORDER.find((m) => avail[m]) || null;
        const t = preview && transformFor(preview);
        ghost.group.visible = !!t;
        if (!t) return;
        apply(ghost.group, t);
        ghostFurniture(preview, t);
    }

    // The easel's legs and the rope are most of what distinguishes those two
    // previews from a painting hovering at a height, so the ghost carries them
    // too -- rebuilt only when the shape would actually differ, since this runs
    // at 15Hz and new geometry every tick is pure garbage.
    let ghostProp = null, ghostPropKey = '';
    function ghostFurniture(mount, t) {
        const key = mount === 'easel' || mount === 'rope'
            ? `${mount}|${state.size.toFixed(2)}|${t.rise.toFixed(2)}|${(t.position.y - state.aim.ground).toFixed(2)}`
            : '';
        if (key === ghostPropKey) return;
        ghostPropKey = key;
        if (ghostProp) { ghost.group.remove(ghostProp); ghostProp = null; }
        if (!key) return;
        const drop = Math.max((t.position.y - state.aim.ground) / state.size, 0);
        ghostProp = createMountFurniture(mount, w, h, t.rise / state.size, drop);
        if (!ghostProp) return;
        ghostProp.traverse((o) => {
            o.castShadow = o.receiveShadow = false;
            if (o.material) o.material = ghostFrameMat;
        });
        ghost.group.add(ghostProp);
    }

    function showLive(mount) {
        const t = transformFor(mount);
        if (!t) return false;
        if (!live) {
            live = createPaintingMesh(widthIn, heightIn, artwork.frame);
            garden.add(live.group);
            if (carry.panel.material.map) {
                live.panel.material.map = carry.panel.material.map;
                live.panel.material.needsUpdate = true;
            }
        }
        live.group.visible = true;
        apply(live.group, t);

        if (furniture) { live.group.remove(furniture); furniture = null; }
        if (mount === 'easel' || mount === 'rope') {
            const drop = Math.max((t.position.y - state.aim.ground) / state.size, 0);
            furniture = createMountFurniture(mount, w, h, t.rise / state.size, drop);
            if (furniture) live.group.add(furniture);
        }
        // The shadow map is cached (main.js sets autoUpdate = false), so a
        // painting that just moved keeps its old shadow until we say so.
        app.renderer.shadowMap.needsUpdate = true;
        return true;
    }

    function place(mount) {
        if (!showLive(mount)) return;
        state.mount = mount;
        state.phase = 'placed';
        state.dirty = true;
        state.optionsOpen = false;
        ghost.group.visible = false;
        carry.group.visible = false;
        hud.render();
    }

    function pickUp() {
        state.phase = 'carrying';
        carry.group.visible = true;
        if (live) live.group.visible = false;
        app.renderer.shadowMap.needsUpdate = true;
        hud.render();
        refreshGhost();
    }

    function adjust(dSize, dYaw) {
        if (dSize) state.size = clamp(round2(state.size + dSize), SIZE_MIN, SIZE_MAX);
        if (dYaw) state.yawOffset += dYaw;
        state.dirty = true;
        if (state.phase === 'placed' && state.mount) showLive(state.mount);
        else refreshGhost();
        hud.render();
    }

    async function save() {
        if (!state.mount || state.saving) return;
        const t = transformFor(state.mount);
        if (!t) { hud.toast('Aim somewhere this mount works first.', true); return; }
        state.saving = true;
        hud.render();
        try {
            await backend.updateArtwork(artworkId, {
                placement: {
                    placed: true,
                    anchor: 'world',
                    mount: state.mount,
                    position: [t.position.x, t.position.y, t.position.z],
                    rotation: [t.rotation.x, t.rotation.y, t.rotation.z],
                    scale: state.size,
                    ...(state.mount === 'rope' ? { rise: t.rise } : {})
                }
            });
            state.dirty = false;
            hud.toast('Placed. It goes live when you publish from the Studio.');
        } catch (err) {
            console.error(err);
            hud.toast(`Could not save: ${err.message || err}`, true);
        } finally {
            state.saving = false;
            hud.render();
        }
    }

    // ---- aiming ----------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const reticle = new THREE.Vector2(0, 0);
    const lastCam = new THREE.Matrix4();
    let lastAimAt = 0, running = true;

    function tick(now) {
        if (!running) return;
        requestAnimationFrame(tick);
        layOutCarry();
        if (state.phase !== 'carrying') return;
        if (now - lastAimAt < AIM_INTERVAL_MS) return;
        if (app.camera.matrixWorld.equals(lastCam)) return;
        lastAimAt = now;
        lastCam.copy(app.camera.matrixWorld);

        raycaster.setFromCamera(reticle, app.camera);
        const hits = raycaster.intersectObjects(targets, false);
        state.aim = hits.length ? describe(hits[0]) : null;
        refreshGhost();
        hud.renderOptions();
    }
    requestAnimationFrame(tick);

    const _nm = new THREE.Matrix3();
    function describe(hit) {
        const point = hit.point.clone();
        const normal = new THREE.Vector3(0, 1, 0);
        if (hit.face) {
            normal.copy(hit.face.normal)
                .applyNormalMatrix(_nm.getNormalMatrix(hit.object.matrixWorld))
                .normalize();
        }
        // The gazebo is double-sided and the trunk proxies are open cylinders,
        // so a ray can come back with a normal pointing away from the viewer --
        // which would hang the painting facing into the wood.
        if (normal.dot(raycaster.ray.direction) > 0) normal.negate();

        const kind = Math.abs(normal.y) < 0.55 ? 'surface' : 'ground';
        return {
            point, normal, kind,
            ground: groundHeightAt(point.x, point.z),
            canopy: kind === 'ground' ? canopyOver(surfaces.canopies, point.x, point.z) : null
        };
    }

    // ---- hud -------------------------------------------------------------
    const hud = buildHud();
    document.body.appendChild(hud.root);

    function buildHud() {
        const root = document.createElement('div');
        root.className = 'place-hud';
        // Pointer events on the HUD must not reach the canvas, or every tap
        // on a button also turns the view.
        ['pointerdown', 'pointerup', 'pointermove', 'click'].forEach((type) => {
            root.addEventListener(type, (e) => e.stopPropagation());
        });

        const reticleEl = document.createElement('div');
        reticleEl.className = 'place-reticle';

        const head = document.createElement('div');
        head.className = 'place-head';
        const title = document.createElement('span');
        title.className = 'place-title';
        title.textContent = artwork.title || 'Untitled';
        const step = document.createElement('span');
        step.className = 'place-step';
        head.append(title, step);

        const options = document.createElement('div');
        options.className = 'place-options';

        const bar = document.createElement('div');
        bar.className = 'place-bar';

        const toastEl = document.createElement('div');
        toastEl.className = 'place-toast';

        const btn = (label, cls, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `place-btn ${cls}`.trim();
            b.textContent = label;
            b.addEventListener('pointerdown', (e) => e.preventDefault());
            b.addEventListener('click', fn);
            return b;
        };

        const placeBtn = btn('Place here', 'primary', () => {
            if (!state.aim) { toast('Look at the ground, a trunk or the gazebo first.'); return; }
            state.optionsOpen = true;
            render();
        });
        const moveBtn = btn('Move it', '', pickUp);
        const saveBtn = btn('Save', 'primary', save);
        const smaller = btn('−', 'round', () => adjust(-SIZE_STEP, 0));
        const bigger = btn('+', 'round', () => adjust(SIZE_STEP, 0));
        const rotL = btn('↺', 'round', () => adjust(0, -Math.PI / 12));
        const rotR = btn('↻', 'round', () => adjust(0, Math.PI / 12));
        const exit = btn('Studio', 'ghost', () => {
            if (state.dirty && !window.confirm('Leave without saving this placement?')) return;
            location.href = './studio/';
        });
        const sizeLabel = document.createElement('span');
        sizeLabel.className = 'place-size';

        const optionBtns = new Map();
        ORDER.forEach((key) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'place-option';
            b.append(
                Object.assign(document.createElement('strong'), { textContent: MOUNTS[key].label }),
                document.createElement('small')
            );
            b.addEventListener('pointerdown', (e) => e.preventDefault());
            b.addEventListener('click', () => { if (!b.disabled) place(key); });
            optionBtns.set(key, b);
            options.appendChild(b);
        });

        function renderOptions() {
            const avail = availability();
            optionBtns.forEach((b, key) => {
                const ok = avail[key];
                b.disabled = !ok;
                b.classList.toggle('active', state.phase === 'placed' && state.mount === key);
                b.querySelector('small').textContent = ok ? MOUNTS[key].hint : MOUNTS[key].denied;
            });
        }

        function render() {
            const carrying = state.phase === 'carrying';
            step.textContent = carrying
                ? (state.aim ? 'Place it here, or keep walking.' : 'Walk to where it should go.')
                : `${MOUNTS[state.mount].label} · ${Math.round(state.size * 100)}%`;
            reticleEl.hidden = !carrying;
            options.hidden = carrying && !state.optionsOpen;
            placeBtn.hidden = !carrying;
            moveBtn.hidden = carrying;
            saveBtn.hidden = carrying;
            saveBtn.disabled = state.saving || !state.dirty;
            saveBtn.textContent = state.saving ? 'Saving…' : state.dirty ? 'Save' : 'Saved';
            [smaller, sizeLabel, bigger].forEach((e) => { e.hidden = carrying; });
            // Rotation is meaningless on a surface: the bark decides the angle.
            rotL.hidden = rotR.hidden = carrying || state.mount === 'surface';
            sizeLabel.textContent = `${Math.round(state.size * 100)}%`;
            renderOptions();
        }

        let toastTimer = null;
        function toast(message, isError) {
            toastEl.textContent = message;
            toastEl.classList.toggle('error', !!isError);
            toastEl.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3400);
        }

        bar.append(placeBtn, moveBtn, smaller, sizeLabel, bigger, rotL, rotR, saveBtn, exit);
        root.append(reticleEl, head, options, bar, toastEl);
        return { root, render, renderOptions, toast };
    }

    // ---- keyboard --------------------------------------------------------
    // Deliberately clear of WASD, Space and Shift, which are walking.
    const KEY_MOUNT = { KeyG: 'easel', KeyL: 'ground', KeyR: 'rope', KeyH: 'surface' };
    function onKey(e) {
        if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        const mount = KEY_MOUNT[e.code];
        if (mount) { if (availability()[mount]) place(mount); return; }
        if (e.code === 'KeyF') { if (state.phase === 'placed') pickUp(); return; }
        if (e.code === 'BracketLeft') return adjust(-SIZE_STEP, 0);
        if (e.code === 'BracketRight') return adjust(SIZE_STEP, 0);
        if (e.code === 'KeyQ') return adjust(0, -Math.PI / 12);
        if (e.code === 'KeyE') return adjust(0, Math.PI / 12);
        if (e.code === 'Enter' && state.phase === 'placed') save();
    }
    window.addEventListener('keydown', onKey);

    // Coming back to something already placed: show it where it is, so "Move
    // in garden" starts from the truth rather than from scratch.
    if (saved) {
        const p = new THREE.Vector3().fromArray(saved.position);
        const mount = normalizeMount(saved.mount);
        const yaw = (saved.rotation && saved.rotation[1]) || 0;
        state.aim = {
            point: p,
            normal: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)),
            kind: mount === 'surface' ? 'surface' : 'ground',
            ground: groundHeightAt(p.x, p.z),
            canopy: canopyOver(surfaces.canopies, p.x, p.z)
        };
        if (showLive(mount)) {
            state.phase = 'placed';
            state.dirty = false;
            carry.group.visible = false;
        }
    }
    hud.render();
    refreshGhost();

    return {
        // Handy from the console when a mount is unexpectedly unavailable:
        // the answer is almost always in the aim, not in the button.
        debug: () => ({ state, surfaces, availability: availability(), targets: targets.length }),
        dispose() {
            running = false;
            window.removeEventListener('keydown', onKey);
            hud.root.remove();
            app.camera.remove(carry.group);
            garden.remove(ghost.group);
            if (live) garden.remove(live.group);
            proxies.forEach((p) => { garden.remove(p); p.geometry.dispose(); });
        }
    };
}

// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round2(v) { return Math.round(v * 100) / 100; }

/** Waits for a signed-in artist. Firestore refuses reads until that lands. */
function awaitAccess(backend) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const stop = backend.onUser(async (u) => {
            if (!u) return finish(null);
            finish((await backend.checkAccess()) ? u : null);
            if (typeof stop === 'function') stop();
        });
        setTimeout(() => finish(null), 12000);
    });
}

/** One snapshot of the drafts -- placement mode edits one painting, not a feed. */
function firstArtwork(backend, id) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const stop = backend.watchArtworks(
            (list) => {
                finish(list.find((a) => a.id === id) || null);
                if (typeof stop === 'function') stop();
            },
            () => finish(null)
        );
        setTimeout(() => finish(null), 12000);
    });
}

async function loadArtworkTexture(backend, artwork) {
    const img = artwork.images && (artwork.images.display || artwork.images.medium || artwork.images.thumb);
    if (!img) return null;
    try {
        const url = await backend.imageUrl(img);
        if (!url) return null;
        return await new Promise((resolve) => loadPanelTexture(url, resolve));
    } catch {
        return null;
    }
}

function fail(message) {
    const el = document.createElement('div');
    el.className = 'place-toast show error standalone';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
    return null;
}
