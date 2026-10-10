import * as THREE from 'three';
import './place.css';
import { getBackend } from '../cloud/backend.js';
import { dimensionsInInches } from '../cloud/schema.js';
import {
    createPaintingMesh, createMountFurniture, loadPanelTexture, normalizeMount, mountAllPaintings
} from '../scene/paintings.js';
import { groundHeightAt, POND_WATER_Y, GARDEN_POINTS, isInPond, isOnPath, insideGazebo } from '../scene/garden.js';
import { placementIssues } from './placementGeometry.js';
import { fitSurfaces, buildTrunkProxies, canopyOver, fitGazeboPosts } from './surfaces.js';

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

const SIZE_MIN = 0.5, SIZE_MAX = 4.0, SIZE_STEP = 0.15;
const AIM_INTERVAL_MS = 16;            // ~60Hz fluid aim tracking
const CARRY_DISTANCE = 0.8;            // metres in front of the eye
const CARRY_SCREEN_FRACTION = 0.22;    // of the viewport's height
const ROPE_TOP = 2.35;                 // where the frame's top edge hangs
const ROPE_LENGTH = 0.75;              // rope visible above it, into the leaves

export async function attachPlaceMode(app, artworkId) {
    const backend = await getBackend();
    if (!backend) return fail('This device has no studio connection, so nothing can be placed here.');

    const user = await awaitAccess(backend);
    if (!user) return fail('Sign in to the Studio on this device first, then try again.');

    const draftSnapshot = await firstArtwork(backend, artworkId);
    const artwork = draftSnapshot?.artwork;
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
        baseYaw: saved?.rotation?.[1] || 0,
        aim: null,
        dirty: false,
        saving: false,
        optionsOpen: false,
        fineOpen: !!saved,
        dragging: false,
        rise: saved?.rise || ROPE_LENGTH
    };

    const otherPaintings = (draftSnapshot.artworks || []).filter(a => a.id !== artworkId && a.status !== 'trashed' && a.placement?.placed).map(a => {
        const dimensions = dimensionsInInches(a.dimensions);
        return { ...a.placement, scale: a.placement.scale || 1, id: a.id, title: a.title, width: dimensions.widthIn * .0254, height: dimensions.heightIn * .0254 };
    });
    // Arrange against the saved drafts, so unpublished placements are visible
    // to the artist and the clearance feedback refers to what is on screen.
    const publishedVisibility = [...(app.paintings?.values() || [])].map(({ group }) => [group, group.visible]);
    publishedVisibility.forEach(([group]) => { group.visible = false; });
    const draftRecords = await Promise.all(otherPaintings.map(async (p) => {
        const draft = draftSnapshot.artworks.find(a => a.id === p.id);
        const file = draft ? await backend.imageUrl(draft.images?.medium || draft.images?.display || draft.images?.thumb).catch(() => null) : null;
        return { ...p, id: draft?.id, widthIn: p.width / .0254, heightIn: p.height / .0254, frame: draft?.frame, file };
    }));
    const mountedDrafts = mountAllPaintings(garden, draftRecords);
    app.renderer.shadowMap.needsUpdate = true;
    if (app.fpsNavigator) app.fpsNavigator.setColliders([
        ...surfaces.trunks.map(t => ({ ...t, radius: t.collisionRadius || t.radius })),
        ...fitGazeboPosts(garden, GARDEN_POINTS.GAZEBO),
        ...otherPaintings.map(p => ({ x: p.position[0], z: p.position[2], radius: Math.max(p.width, p.height) * p.scale / 2 }))
    ]);
    document.body.classList.add('placing-painting');
    const history = [];
    let dragStart = null;
    function snapshot() {
        return {
            phase: state.phase, mount: state.mount, size: state.size, yawOffset: state.yawOffset,
            baseYaw: state.baseYaw, rise: state.rise, dirty: state.dirty,
            aim: state.aim && { ...state.aim, point: state.aim.point.clone(), normal: state.aim.normal.clone() },
            position: live?.group.position.clone(), rotation: live?.group.rotation.clone()
        };
    }
    function remember() {
        history.push(snapshot());
        if (history.length > 30) history.shift();
    }
    function undo() {
        if (state.saving || !history.length) return;
        stopDragging();
        const previous = history.pop();
        Object.assign(state, previous, { optionsOpen: false });
        carry.group.visible = state.phase === 'carrying';
        if (live) {
            live.group.visible = state.phase === 'placed';
            if (previous.position) {
                live.group.position.copy(previous.position);
                live.group.rotation.copy(previous.rotation);
                live.group.scale.setScalar(state.size);
                rebuildFurniture();
            }
        }
        app.renderer.shadowMap.needsUpdate = true;
        lastCam.elements.fill(0);
        refreshGhost();
        hud.render();
    }
    function currentPlacement() {
        return live && { position: live.group.position.toArray(), rotation: [live.group.rotation.x, live.group.rotation.y, live.group.rotation.z], scale: state.size, mount: state.mount, rise: state.rise, width: w, height: h };
    }
    function issues() {
        if (state.phase !== 'placed' || !live) return [];
        return placementIssues(currentPlacement(), { paintings: otherPaintings, trunks: surfaces.trunks, groundHeightAt, isInPond, isOnPath, canopyAt: (x, z) => canopyOver(surfaces.canopies, x, z) });
    }

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

    let live = null, furniture = null, disposed = false, artworkTexture = null;

    loadArtworkTexture(backend, artwork).then((tex) => {
        if (!tex) return;
        if (disposed) { tex.dispose(); return; }
        artworkTexture = tex;
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

        const yaw = (state.phase === 'placed' || state.optionsOpen ? state.baseYaw : facingYaw(a.point)) + state.yawOffset;

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
        // YXZ to match how mountPainting reads these back (see paintings.js):
        // yaw first, then lean about the painting's own axis.
        group.rotation.set(t.rotation.x, t.rotation.y, t.rotation.z, 'YXZ');
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
        const key = mount === 'easel' || mount === 'rope' || mount === 'surface'
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
        state.rise = t.rise;
        live.group.visible = true;
        apply(live.group, t);

        if (furniture) { live.group.remove(furniture); furniture = null; }
        if (mount === 'easel' || mount === 'rope' || mount === 'surface') {
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
        if (state.saving || !state.aim || !availability()[mount]) return;
        remember();
        stopDragging();
        if (state.phase === 'carrying' && !state.optionsOpen) state.baseYaw = facingYaw(state.aim.point);
        if (!showLive(mount)) return;
        state.mount = mount;
        state.phase = 'placed';
        state.fineOpen = true;
        state.dirty = true;
        state.optionsOpen = false;
        ghost.group.visible = false;
        carry.group.visible = false;
        hud.render();
    }

    function pickUp() {
        if (state.saving) return;
        remember();
        stopDragging();
        state.optionsOpen = false;
        lastCam.elements.fill(0);
        state.phase = 'carrying';
        carry.group.visible = true;
        if (live) live.group.visible = false;
        app.renderer.shadowMap.needsUpdate = true;
        hud.render();
        refreshGhost();
    }

    function adjust(dSize, dYaw) {
        if (state.saving) return;
        remember();
        const previousSize = state.size;
        if (dSize) state.size = clamp(round2(state.size + dSize), SIZE_MIN, SIZE_MAX);
        if (dYaw && state.mount !== 'surface') state.yawOffset += dYaw;
        state.dirty = true;
        if (state.phase === 'placed' && live) {
            // Edit the displayed transform, never derive it from the viewing camera.
            if (state.mount === 'easel' || state.mount === 'ground') {
                live.group.position.y += h * (state.size - previousSize) / 2 * Math.cos(live.group.rotation.x);
            }
            live.group.scale.setScalar(state.size);
            if (state.mount !== 'surface') live.group.rotation.y += dYaw;
            rebuildFurniture();
            app.renderer.shadowMap.needsUpdate = true;
        } else refreshGhost();
        hud.render();
    }

    function supportHeightAt(x, z) {
        const ground = groundHeightAt(x, z);
        if (!insideGazebo(x, z)) return ground;
        const ray = new THREE.Raycaster(new THREE.Vector3(x, ground + .8, z), new THREE.Vector3(0, -1, 0));
        const hit = ray.intersectObjects(targets, false).find(hit => hit.point.y >= ground - .05 && hit.point.y <= ground + .7);
        return hit ? hit.point.y : ground;
    }

    function rebuildFurniture() {
        if (!live) return;
        if (furniture) live.group.remove(furniture);
        const ground = state.aim?.ground ?? supportHeightAt(live.group.position.x, live.group.position.z);
        furniture = createMountFurniture(state.mount, w, h, state.rise / state.size,
            Math.max((live.group.position.y - ground) / state.size, 0));
        if (furniture) live.group.add(furniture);
    }

    function moveBy(dx, dy, dz, record = true) {
        if (state.phase !== 'placed' || state.saving || !live) return;
        if (record) remember();
        const p = live.group.position;
        const oldGround = state.aim.ground;
        p.x += dx; p.z += dz;
        if (state.mount === 'surface') {
            p.y += dy;
            state.aim.point.add(new THREE.Vector3(dx, dy, dz));
        } else {
            state.aim.point.x = p.x; state.aim.point.z = p.z;
            state.aim.ground = supportHeightAt(p.x, p.z);
            state.aim.canopy = canopyOver(surfaces.canopies, p.x, p.z);
            p.y += state.aim.ground - oldGround + dy;
        }
        state.dirty = true;
        rebuildFurniture();
        app.renderer.shadowMap.needsUpdate = true;
        hud.render();
    }
    function nudge(side, forward, up) {
        if (!live) return;
        const yaw = live.group.rotation.y;
        // A surface stays attached to its vertical plane; depth comes from bark.
        if (state.mount === 'surface') forward = 0;
        moveBy(.1 * (side * Math.cos(yaw) + forward * Math.sin(yaw)), up * .1,
            .1 * (-side * Math.sin(yaw) + forward * Math.cos(yaw)));
    }
    function viewPainting(p, yaw) {
        const distance = Math.max(2.4, Math.max(w, h) * state.size * 1.9);
        const cam = p.clone().add(new THREE.Vector3(Math.sin(yaw) * distance, 0, Math.cos(yaw) * distance));
        cam.y = groundHeightAt(cam.x, cam.z) + 1.78;
        app.camera.position.copy(cam);
        app.camera.lookAt(p);
        app.fpsNavigator?.enable(cam, p);
    }
    function suggestedSpot(key) {
        if (state.saving) return;
        stopDragging();
        remember();
        const centre = GARDEN_POINTS[key];
        const offsets = key === 'GULMOHAR' ? [[5, 5], [-5, 5], [5, -5]]
            : key === 'POND' ? [[8, 3], [9, 5], [10, 0]] : [[0, 0], [1, 0], [-1, 0]];
        let selected = null;
        for (const [dx, dz] of offsets) {
            const x = centre.x + dx, z = centre.z + dz;
            if (isInPond(x, z)) continue;
            const ground = supportHeightAt(x, z);
            const position = [x, ground + .62 + h * state.size / 2 * Math.cos(-.16), z];
            const candidate = { position, rotation: [-.16, 0, 0], width: w, height: h, scale: state.size, mount: 'easel' };
            if (!placementIssues(candidate, { paintings: otherPaintings, trunks: surfaces.trunks, groundHeightAt, isInPond, isOnPath, canopyAt: (x, z) => canopyOver(surfaces.canopies, x, z) }).length) {
                selected = { point: new THREE.Vector3(x, ground, z), normal: new THREE.Vector3(0, 1, 0), kind: 'ground', ground, canopy: canopyOver(surfaces.canopies, x, z) };
                break;
            }
        }
        if (!selected) { history.pop(); hud.toast('These spots need more room. Try another area or choose a spot yourself.', true); return; }
        state.aim = selected;
        state.phase = 'carrying'; state.mount = 'easel'; state.yawOffset = 0; state.baseYaw = 0;
        state.optionsOpen = true; state.dirty = true;
        carry.group.visible = true;
        if (live) live.group.visible = false;
        const t = transformFor('easel');
        viewPainting(t.position, 0);
        refreshGhost();
        hud.render();
    }

    // Drag the frame in its supporting plane. Camera controls pause for this
    // explicit editing gesture, so one drag never also rotates the view.
    const canvas = app.renderer.domElement;
    const dragRay = new THREE.Raycaster();
    const dragPlane = new THREE.Plane();
    function pointerOnPlane(e) {
        const rect = canvas.getBoundingClientRect();
        dragRay.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2), app.camera);
        return dragRay.ray.intersectPlane(dragPlane, new THREE.Vector3());
    }
    function stopDragging() {
        dragStart = null;
        if (!state.dragging) return;
        state.dragging = false;
        app.fpsNavigator?.enableFromCamera();
    }
    function toggleDrag() {
        if (state.saving || state.phase !== 'placed') return;
        if (state.dragging) stopDragging();
        else {
            state.dragging = true;
            app.fpsNavigator?.disable();
            if (app.controls) app.controls.enabled = false;
        }
        hud.render();
    }
    function dragDown(e) {
        if (!state.dragging || state.saving || e.button !== 0) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const normal = state.mount === 'surface'
            ? new THREE.Vector3(Math.sin(live.group.rotation.y), 0, Math.cos(live.group.rotation.y)) : new THREE.Vector3(0, 1, 0);
        dragPlane.setFromNormalAndCoplanarPoint(normal, live.group.position);
        const point = pointerOnPlane(e);
        if (!point) return;
        remember();
        dragStart = { point, id: e.pointerId };
        canvas.setPointerCapture(e.pointerId);
    }
    function dragMove(e) {
        if (!dragStart || e.pointerId !== dragStart.id) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const point = pointerOnPlane(e);
        if (!point) return;
        const delta = point.clone().sub(dragStart.point);
        moveBy(delta.x, state.mount === 'surface' ? delta.y : 0, delta.z, false);
        dragStart.point = point;
    }
    function dragUp(e) {
        if (!state.dragging) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        dragStart = null;
    }
    const dragEvents = [['pointerdown', dragDown], ['pointermove', dragMove], ['pointerup', dragUp], ['pointercancel', dragUp]];
    if (canvas) for (const [event, handler] of dragEvents) canvas.addEventListener(event, handler, true);

    async function save() {
        if (state.phase !== 'placed' || !live || !state.mount || state.saving) return;
        const blocked = issues().find(issue => issue.blocking);
        if (blocked) { hud.toast(blocked.message, true); return; }
        stopDragging();
        const t = { position: live.group.position.clone(), rotation: live.group.rotation.clone(), rise: state.rise };
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
            artwork.placement = { ...currentPlacement(), placed: true, anchor: 'world', rise: state.rise };
            history.length = 0;
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
        if (state.phase !== 'carrying' || state.optionsOpen) return;
        if (now - lastAimAt < AIM_INTERVAL_MS) return;
        if (app.camera.matrixWorld.equals(lastCam)) return;
        lastAimAt = now;
        lastCam.copy(app.camera.matrixWorld);

        raycaster.setFromCamera(reticle, app.camera);
        const hits = raycaster.intersectObjects(targets, false);
        state.aim = hits.length && hits[0].distance <= 18 ? describe(hits[0]) : null;
        refreshGhost();
        hud.render();
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

        if (hit.object !== app.groundMesh && Math.abs(normal.y) >= 0.55) return null;
        const kind = hit.object === app.groundMesh ? 'ground' : 'surface';
        if (kind === 'ground' && groundHeightAt(point.x, point.z) < POND_WATER_Y + 0.03) return null;
        return {
            point, normal, kind,
            ground: groundHeightAt(point.x, point.z),
            canopy: kind === 'ground' ? canopyOver(surfaces.canopies, point.x, point.z) : null
        };
    }

    // ---- hud -------------------------------------------------------------
    const hud = buildHud();
    document.body.appendChild(hud.root);
    hud.root.showModal();
    hud.mountPreview();

    function buildHud() {
        const root = document.createElement('dialog');
        root.className = 'place-hud place-modal';
        root.setAttribute('aria-label', 'Arrange paintings in the garden');
        // Pointer events on the HUD must not reach the canvas, or every tap
        // on a button also turns the view.
        ['pointerdown', 'pointerup', 'pointermove', 'click'].forEach((type) => {
            root.addEventListener(type, (e) => { if (!e.target.closest('.place-preview')) e.stopPropagation(); });
        });

        const preview = document.createElement('div');
        preview.className = 'place-preview';
        preview.setAttribute('aria-label', 'Interactive garden preview');
        const instruction = document.createElement('p');
        instruction.className = 'place-preview-hint';
        instruction.textContent = 'Drag the view to look around · Tap another painting to edit it';
        const reticleEl = document.createElement('div');
        reticleEl.className = 'place-reticle';

        const head = document.createElement('div');
        head.className = 'place-head';
        const title = document.createElement('span');
        title.className = 'place-title';
        title.textContent = artwork.title || 'Untitled';
        const step = document.createElement('span');
        step.className = 'place-step';
        const eyebrow = document.createElement('small');
        eyebrow.textContent = 'GARDEN STUDIO';
        const headingCopy = document.createElement('div');
        headingCopy.className = 'place-heading-copy';
        headingCopy.append(eyebrow, title, step);
        const paintingPicker = document.createElement('select');
        paintingPicker.className = 'place-painting-picker';
        paintingPicker.setAttribute('aria-label', 'Select a painting to edit');
        draftSnapshot.artworks.filter(a => a.status === 'ready' || a.id === artworkId).forEach(a => {
            const option = document.createElement('option');
            option.value = a.id;
            option.textContent = `${a.title || 'Untitled'}${a.placement?.placed ? '' : ' · not placed'}`;
            paintingPicker.append(option);
        });
        paintingPicker.value = artworkId;
        const closeEditor = document.createElement('button');
        closeEditor.type = 'button'; closeEditor.className = 'place-close'; closeEditor.textContent = '×';
        closeEditor.setAttribute('aria-label', 'Cancel placement and return to Studio');
        head.append(headingCopy, paintingPicker, closeEditor);

        const workflow = document.createElement('section');
        workflow.className = 'place-workflow';
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
            state.baseYaw = facingYaw(state.aim.point);
            state.optionsOpen = true;
            render();
        });
        const moveBtn = btn('Choose new spot', '', pickUp);
        const displayBtn = btn('Display', '', () => { state.optionsOpen = !state.optionsOpen; render(); });
        const fineBtn = btn('Adjust', '', () => { state.fineOpen = !state.fineOpen; if (!state.fineOpen) stopDragging(); render(); });
        const undoBtn = btn('Undo', '', undo);
        const cancelSpot = btn('Choose another spot', '', pickUp);
        const saveBtn = btn('Save', 'primary', save);
        const unplace = async () => {
            if (!window.confirm('Remove this painting from the garden?')) return;
            state.saving = true;
            hud.render();
            try {
                await backend.updateArtwork(artwork.id, {
                    placement: { placed: false }
                });
                artwork.placement = { ...(artwork.placement || {}), placed: false };
                if (live) {
                    garden.remove(live.group);
                    disposeFrame(live.group);
                    live = null;
                }
                if (furniture) {
                    garden.remove(furniture);
                    furniture = null;
                }
                stopDragging();
                history.length = 0;
                state.phase = 'carrying';
                carry.group.visible = true;
                state.dirty = false;
                state.optionsOpen = false;
                lastCam.elements.fill(0);
                app.renderer.shadowMap.needsUpdate = true;
                hud.toast('Painting removed from garden.');
            } catch (err) {
                console.error(err);
                hud.toast(`Could not remove: ${err.message || err}`, true);
            } finally {
                state.saving = false;
                hud.render();
            }
        };
        const unplaceBtn = btn('Remove from garden', 'danger', unplace);
        const smaller = btn('−', 'round', () => adjust(-SIZE_STEP, 0));
        const bigger = btn('+', 'round', () => adjust(SIZE_STEP, 0));
        const rotL = btn('↺', 'round', () => adjust(0, -Math.PI / 12));
        const rotR = btn('↻', 'round', () => adjust(0, Math.PI / 12));
        [[smaller, 'Make painting smaller'], [bigger, 'Make painting larger'], [rotL, 'Rotate left'], [rotR, 'Rotate right']].forEach(([button, label]) => button.setAttribute('aria-label', label));
        const cancelEditor = () => {
            if (state.saving) return;
            state.dirty = false;
            location.href = './studio/';
        };
        const exit = btn('Cancel', 'ghost', cancelEditor);
        closeEditor.addEventListener('click', cancelEditor);
        root.addEventListener('cancel', e => { e.preventDefault(); cancelEditor(); });
        const switchPrompt = document.createElement('div');
        switchPrompt.className = 'place-switch-prompt'; switchPrompt.hidden = true;
        switchPrompt.setAttribute('role', 'alert');
        const promptCopy = document.createElement('p');
        promptCopy.textContent = 'Save this placement before editing another painting?';
        let pendingPainting = null;
        async function switchNow() {
            const next = pendingPainting;
            pendingPainting = null;
            state.dirty = false;
            paintingPicker.disabled = true;
            await app.switchPlaceArtwork(next);
        }
        async function requestSwitch(id) {
            if (state.saving || id === artworkId) return;
            pendingPainting = id;
            paintingPicker.value = artworkId;
            if (state.dirty) {
                switchPrompt.hidden = false;
                return;
            }
            await switchNow();
        }
        paintingPicker.addEventListener('change', () => requestSwitch(paintingPicker.value));
        const saveSwitch = btn('Save and switch', 'primary', async () => {
            await save();
            if (!state.dirty) await switchNow();
        });
        const discardSwitch = btn('Discard and switch', '', switchNow);
        const keepEditing = btn('Keep editing', '', () => { switchPrompt.hidden = true; pendingPainting = null; });
        switchPrompt.append(promptCopy, saveSwitch, discardSwitch, keepEditing);
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

        const suggestions = document.createElement('div');
        suggestions.className = 'place-suggestions';
        const suggestionsTitle = document.createElement('strong');
        suggestionsTitle.textContent = 'Try a spot';
        suggestions.append(suggestionsTitle);
        [['GULMOHAR', 'Near the gulmohar'], ['POND', 'Beside the pond'], ['GAZEBO', 'Inside the pavilion']].forEach(([key, label]) => {
            suggestions.append(btn(label, '', () => suggestedSpot(key)));
        });
        const fine = document.createElement('div');
        fine.className = 'place-fine';
        const fineTitle = document.createElement('strong');
        fineTitle.textContent = 'Fine adjustments';
        const nudgeHelp = document.createElement('small');
        nudgeHelp.textContent = 'Each tap moves 10 cm. Drag to move freely.';
        const nudges = document.createElement('div');
        nudges.className = 'place-nudges';
        const left = btn('← Left', '', () => nudge(-1, 0, 0));
        const right = btn('Right →', '', () => nudge(1, 0, 0));
        const away = btn('Further', '', () => nudge(0, -1, 0));
        const closer = btn('Closer', '', () => nudge(0, 1, 0));
        const up = btn('↑ Raise', '', () => nudge(0, 0, 1));
        const down = btn('↓ Lower', '', () => nudge(0, 0, -1));
        const dragBtn = btn('Drag painting', '', toggleDrag);
        const frameBtn = btn('View from front', '', () => { stopDragging(); if (live) viewPainting(live.group.position, live.group.rotation.y); render(); });
        const sizeRow = document.createElement('div');
        sizeRow.className = 'place-sizing';
        sizeRow.append(smaller, sizeLabel, bigger, rotL, rotR);
        nudges.append(left, right, away, closer, up, down);
        fine.append(fineTitle, nudgeHelp, sizeRow, nudges, dragBtn, frameBtn);
        const warnings = document.createElement('div');
        warnings.className = 'place-warnings';
        warnings.setAttribute('role', 'status');
        warnings.setAttribute('aria-live', 'polite');
        workflow.append(suggestions, options, fine, warnings);

        function renderOptions() {
            const avail = availability();
            optionBtns.forEach((b, key) => {
                const ok = avail[key];
                b.disabled = !ok || state.saving;
                b.classList.toggle('active', state.phase === 'placed' && state.mount === key);
                b.querySelector('small').textContent = ok ? MOUNTS[key].hint : MOUNTS[key].denied;
            });
        }

        function render() {
            const carrying = state.phase === 'carrying';
            paintingPicker.disabled = closeEditor.disabled = state.saving;
            saveSwitch.disabled = state.saving || carrying || issues().some(issue => issue.blocking);
            discardSwitch.disabled = keepEditing.disabled = state.saving;
            step.textContent = carrying
                ? (state.optionsOpen ? 'Spot selected. Choose how to display it.' : state.aim ? 'Preview ready. Select Place here to choose a display.' : 'Look down at nearby ground, or aim at a trunk.')
                : state.dragging ? 'Drag the painting, then select Done dragging.' : `${MOUNTS[state.mount].label} · ${Math.round(state.size * 100)}%`;
            reticleEl.hidden = !carrying;
            options.hidden = !state.optionsOpen;
            suggestions.hidden = !carrying || state.optionsOpen;
            fine.hidden = carrying || !state.fineOpen;
            displayBtn.hidden = fineBtn.hidden = carrying;
            undoBtn.disabled = state.saving || !history.length;
            const problems = issues();
            warnings.hidden = !problems.length;
            warnings.textContent = problems.map(issue => issue.message).join(' ');
            warnings.classList.toggle('blocking', problems.some(issue => issue.blocking));
            workflow.hidden = suggestions.hidden && options.hidden && fine.hidden && warnings.hidden;
            [left, right, away, closer, up, down, dragBtn, frameBtn, displayBtn, fineBtn].forEach(b => { b.disabled = state.saving; });
            away.hidden = closer.hidden = state.mount === 'surface';
            up.hidden = down.hidden = ['easel', 'ground'].includes(state.mount);
            dragBtn.textContent = state.dragging ? 'Done dragging' : 'Drag painting';
            dragBtn.setAttribute('aria-pressed', String(state.dragging));
            fineBtn.setAttribute('aria-expanded', String(state.fineOpen));
            placeBtn.hidden = !carrying || state.optionsOpen;
            placeBtn.disabled = !state.aim;
            cancelSpot.hidden = !carrying || !state.optionsOpen;
            [moveBtn, smaller, bigger, rotL, rotR, exit, cancelSpot].forEach(b => { b.disabled = state.saving; });
            moveBtn.hidden = carrying;
            saveBtn.hidden = carrying;
            saveBtn.disabled = state.saving || !state.dirty || problems.some(issue => issue.blocking);
            saveBtn.textContent = state.saving ? 'Saving…' : state.dirty ? 'Save placement' : 'Saved';
            const hasSavedPlacement = !!(artwork.placement && artwork.placement.placed);
            unplaceBtn.hidden = !(state.phase === 'placed' || hasSavedPlacement);
            unplaceBtn.disabled = state.saving;
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

        bar.append(placeBtn, cancelSpot, moveBtn, displayBtn, fineBtn, undoBtn, saveBtn, exit, unplaceBtn);
        const body = document.createElement('div');
        body.className = 'place-modal-body';
        const sidebar = document.createElement('aside');
        sidebar.className = 'place-sidebar';
        const sidebarIntro = document.createElement('p');
        sidebarIntro.className = 'place-sidebar-intro';
        sidebarIntro.textContent = 'Choose a spot, preview the display, then save. Switch paintings above to arrange the collection.';
        sidebar.append(sidebarIntro, workflow, switchPrompt);
        preview.append(reticleEl, instruction, toastEl);
        body.append(preview, sidebar);
        const footerCopy = document.createElement('small');
        footerCopy.className = 'place-footer-copy';
        footerCopy.textContent = 'Cancel discards unsaved placement changes. Publish from the Studio when the garden is ready.';
        const footer = document.createElement('footer');
        footer.className = 'place-modal-footer';
        footer.append(footerCopy, bar);
        root.append(head, body, footer);
        let canvasParent, touchParent, resizeObserver;
        function mountPreview() {
            if (!canvas) return;
            canvasParent = canvas.parentNode;
            preview.prepend(canvas);
            canvas.tabIndex = 0;
            canvas.setAttribute('aria-label', 'Garden preview. Use arrow keys to walk and drag to look around.');
            if (app.fpsNavigator?.touchZone) {
                touchParent = app.fpsNavigator.touchZone.parentNode;
                preview.append(app.fpsNavigator.touchZone);
            }
            app._renderViewport = preview;
            app.onResize();
            resizeObserver = new ResizeObserver(() => { app.onResize(); carryLaidOutFor = ''; });
            resizeObserver.observe(preview);
            canvas.focus({ preventScroll: true });
        }
        function unmountPreview() {
            resizeObserver?.disconnect();
            if (canvasParent) canvasParent.appendChild(canvas);
            if (touchParent) touchParent.appendChild(app.fpsNavigator.touchZone);
            app._renderViewport = null;
            app.onResize?.();
        }
        return { root, render, renderOptions, toast, mountPreview, unmountPreview, requestSwitch };
    }

    let tapStart;
    const onPreviewDown = e => { canvas.focus({ preventScroll: true }); tapStart = { x: e.clientX, y: e.clientY }; };
    const onPreviewClick = e => {
        if (state.dragging || !tapStart || Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8) return;
        const rect = canvas.getBoundingClientRect();
        const pick = new THREE.Raycaster();
        pick.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2), app.camera);
        const objects = [...mountedDrafts.values()].map(m => m.interactive.object);
        const hits = pick.intersectObjects(objects, true);
        for (const hit of hits) {
            let object = hit.object;
            while (object && !objects.includes(object)) object = object.parent;
            const match = [...mountedDrafts].find(([, m]) => m.interactive.object === object);
            if (match) { hud.requestSwitch(match[0]); break; }
        }
    };
    canvas?.addEventListener('pointerdown', onPreviewDown);
    canvas?.addEventListener('click', onPreviewClick);

    // ---- keyboard --------------------------------------------------------
    // Deliberately clear of WASD, Space and Shift, which are walking.
    const KEY_MOUNT = { KeyG: 'easel', KeyL: 'ground', KeyR: 'rope', KeyH: 'surface' };
    function onKey(e) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
        const mount = KEY_MOUNT[e.code];
        if (mount) { if (availability()[mount]) place(mount); return; }
        if (e.code === 'KeyF') { if (state.phase === 'placed') pickUp(); return; }
        if (e.code === 'BracketLeft') return adjust(-SIZE_STEP, 0);
        if (e.code === 'BracketRight') return adjust(SIZE_STEP, 0);
        if (e.code === 'KeyQ') return adjust(0, -Math.PI / 12);
        if (e.code === 'KeyE') return adjust(0, Math.PI / 12);
        if (e.code === 'Enter' && e.target.tagName !== 'BUTTON' && state.phase === 'placed') save();
    }
    window.addEventListener('keydown', onKey);
    const beforeUnload = e => { if (state.dirty || state.saving) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);

    // Coming back to something already placed: show it where it is and take
    // the artist right in front of it, so "Move in garden" starts from the truth.
    if (saved && Array.isArray(saved.position) && saved.position.length >= 3) {
        const p = new THREE.Vector3().fromArray(saved.position);
        const mount = normalizeMount(saved.mount);
        const rotArray = Array.isArray(saved.rotation) ? saved.rotation : [0, 0, 0];
        const rot = new THREE.Euler(rotArray[0] || 0, rotArray[1] || 0, rotArray[2] || 0, 'YXZ');
        const yaw = rot.y;

        state.mount = mount;
        state.size = saved.scale || 1;
        state.phase = 'placed';
        state.dirty = false;
        carry.group.visible = false;

        state.aim = {
            point: mount === 'surface' ? p.clone().addScaledVector(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), -0.05 * state.size) : p.clone(),
            normal: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)),
            kind: mount === 'surface' ? 'surface' : 'ground',
            ground: supportHeightAt(p.x, p.z),
            canopy: canopyOver(surfaces.canopies, p.x, p.z)
        };

        if (!live) {
            live = createPaintingMesh(widthIn, heightIn, artwork.frame);
            garden.add(live.group);
            if (carry.panel.material.map) {
                live.panel.material.map = carry.panel.material.map;
                live.panel.material.needsUpdate = true;
            }
        }
        live.group.visible = true;
        live.group.position.copy(p);
        live.group.rotation.copy(rot);
        live.group.scale.setScalar(state.size);

        if (furniture) { live.group.remove(furniture); furniture = null; }
        if (mount === 'easel' || mount === 'rope' || mount === 'surface') {
            const drop = Math.max((p.y - state.aim.ground) / state.size, 0);
            const rise = saved.rise || (mount === 'rope' ? ROPE_LENGTH : 0);
            furniture = createMountFurniture(mount, w, h, rise / state.size, drop);
            if (furniture) live.group.add(furniture);
        }
        app.renderer.shadowMap.needsUpdate = true;

        viewPainting(p, yaw);
    }
    hud.render();
    refreshGhost();

    return {
        // Handy from the console when a mount is unexpectedly unavailable:
        // the answer is almost always in the aim, not in the button.
        reframe: () => { if (live?.group.visible) viewPainting(live.group.position, live.group.rotation.y); },
        debug: () => ({ state, surfaces, availability: availability(), targets: targets.length }),
        dispose() {
            disposed = true;
            stopDragging();
            running = false;
            canvas?.removeEventListener('pointerdown', onPreviewDown);
            canvas?.removeEventListener('click', onPreviewClick);
            if (canvas) for (const [event, handler] of dragEvents) canvas.removeEventListener(event, handler, true);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('beforeunload', beforeUnload);
            hud.unmountPreview();
            hud.root.close();
            hud.root.remove();
            document.body.classList.remove('placing-painting');
            publishedVisibility.forEach(([group, visible]) => { group.visible = visible; });
            mountedDrafts.forEach(({ group, frame }) => { garden.remove(group); disposeFrame(frame); });
            [carry.group, ghost.group, live?.group].filter(Boolean).forEach(disposeFrame);
            artworkTexture?.dispose();
            ghostPanelMat.dispose();
            ghostFrameMat.dispose();
            app.camera.remove(carry.group);
            garden.remove(ghost.group);
            if (live) garden.remove(live.group);
            proxies.forEach((p) => { garden.remove(p); p.geometry.dispose(); });
        }
    };
}

// ---------------------------------------------------------------------------

// Dispose each painting's own panels/bars, while keeping shared furniture
// geometries and materials alive for the other paintings in the scene.
function disposeFrame(group) {
    if (!group) return;
    const materials = new Set();
    group.children.filter(child => child.isMesh).forEach(child => {
        child.geometry.dispose();
        if (child.material) materials.add(child.material);
    });
    materials.forEach(material => material.dispose());
}

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
                finish({ artwork: list.find((a) => a.id === id) || null, artworks: list });
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
        let url = await backend.imageUrl(img);
        if (!url) return null;
        if (typeof window !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && typeof url === 'string') {
            url = url.replace('https://firebasestorage.googleapis.com', '/firebasestorage-proxy');
        }
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
