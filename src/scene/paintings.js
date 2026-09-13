import * as THREE from 'three';
import { getAssetUrl } from '../utils/paths.js';
// Both SDK-free by design (see each file's own header comment) -- the
// Firebase SDK itself must never reach the visitor bundle. Only
// cloud/backend.js dynamic-imports firebaseBackend.js, and nothing here
// calls it.
import { galleryUrl } from '../cloud/config.js';
import { toPlacementRecord } from '../cloud/schema.js';
import { QUALITY } from '../quality.js';
import { groundHeightAt } from './garden.js';

// ---------------------------------------------------------------------------
// Paintings hung in the garden -- the read-only half. The editor
// (src/edit/editor.js) writes the file this reads; nothing here imports from
// the editor, so a visitor who never adds ?edit never downloads it.
//
// Real inches, not a stylised scale: METRES_PER_INCH = 0.0254. A 24x32in
// canvas is 0.61 x 0.81m, which sits naturally against an ~11m tree or a
// 4.8m gazebo -- this garden is built at human/real scale, unlike a set
// composed for a much larger world.
//
// Panels are tone-mapped MeshStandardMaterial, not the unlit
// toneMapped:false trick some galleries use. That trick exists to fight
// billboarding (a panel that always faces the camera can't rely on a real
// normal for lighting), but every painting here is mounted at a fixed
// orientation -- on a wall, a trunk, or lying on the ground -- so a real
// normal under real directional light is both simpler and more correct than
// faking it, and it keeps the artwork inside the same ACES grade as
// everything else rather than fighting it.
// ---------------------------------------------------------------------------

export const METRES_PER_INCH = 0.0254;

// How a painting meets the garden. Only `surface` is pure transform -- the
// other three need real furniture rendered with them (legs, ropes), for
// visitors as much as for the artist placing it, so the mount type lives in
// the saved record and is rebuilt here rather than being baked into a
// position at placement time.
export const MOUNTS = ['easel', 'ground', 'rope', 'surface'];

// The editor's older vocabulary, still in public/paintings.json.
const LEGACY_MOUNTS = {
    'ground-lean': 'ground', lean: 'ground',
    'ground-flat': 'ground', flat: 'ground',
    tree: 'surface', wall: 'surface', hang: 'surface',
    free: 'surface'
};

export function normalizeMount(mount) {
    if (MOUNTS.includes(mount)) return mount;
    return LEGACY_MOUNTS[mount] || 'surface';
}

// Paintings turn to face whoever is looking at them, as far as the thing
// holding them up allows. Ropes swing, an easel can be walked round, and a
// canvas leaning on the grass can be turned where it stands -- all three
// carry their own furniture with them, so they may face you outright. Only a
// painting nailed flat to bark is pinned: it drifts, or it would rotate off
// the trunk it hangs on.
const BILLBOARD_LIMIT = {
    rope: Math.PI,
    easel: Math.PI,
    ground: Math.PI,
    surface: THREE.MathUtils.degToRad(20)
};
// How fast a painting settles toward facing you. Exponential, so it is
// frame-rate independent and never overshoots.
const BILLBOARD_RESPONSE = 3.5;
// Yaw a painting must have turned since the shadow map was last rendered
// before it is worth re-rendering it. Below about a degree the shadow's
// shape does not visibly disagree with the frame casting it.
const BILLBOARD_SHADOW_EPS = THREE.MathUtils.degToRad(1.2);

/** Shortest signed angle from `a` to `b`, in (-pi, pi]. */
function wrapAngle(d) {
    return Math.atan2(Math.sin(d), Math.cos(d));
}

const EASEL_WOOD = 0x8a6c4a;
const ROPE_COLOR = 0xbfa980;

/**
 * The easel: a back-leaning tripod with a ledge the canvas rests on. Built
 * from one shared cylinder rather than per-painting geometry, because a
 * garden with a dozen easels should cost a dozen draw calls, not a dozen
 * meshes' worth of buffers.
 */
const _legGeo = new THREE.CylinderGeometry(0.022, 0.028, 1, 5);
const _ropeGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 4);
// Unit cube, scaled to the ledge. Shared like the struts, and for the same
// reason -- placement mode rebuilds this furniture every time the artist
// nudges the size, and a fresh BoxGeometry each time is pure garbage.
const _ledgeGeo = new THREE.BoxGeometry(1, 1, 1);

function woodMaterial() {
    if (!woodMaterial._m) {
        woodMaterial._m = new THREE.MeshStandardMaterial({ color: EASEL_WOOD, roughness: 0.78, metalness: 0.0 });
    }
    return woodMaterial._m;
}
function ropeMaterial() {
    if (!ropeMaterial._m) {
        ropeMaterial._m = new THREE.MeshStandardMaterial({ color: ROPE_COLOR, roughness: 0.92, metalness: 0.0 });
    }
    return ropeMaterial._m;
}

/** A leg/rope as a scaled unit cylinder from `a` to `b` (both local). */
function strut(geo, material, a, b, radiusScale = 1) {
    const mesh = new THREE.Mesh(geo, material);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return null;
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.scale.set(radiusScale, len, radiusScale);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

/**
 * Builds whatever holds the painting up, in the painting group's own local
 * frame so it inherits position, rotation and scale for free -- an easel
 * under a tilted canvas stays under it, and a rope stays plumb with the
 * frame it carries.
 *
 * @param {string} mount      normalised mount type
 * @param {number} w,h        painting size in metres, before group scale
 * @param {number} rise       rope length above the frame (rope mount only)
 * @param {number} groundDrop distance from the painting's centre down to the
 *                            ground, in the group's own (tilted) frame
 */
export function createMountFurniture(mount, w, h, rise, groundDrop) {
    const group = new THREE.Group();
    group.name = 'PaintingMount';

    if (mount === 'easel') {
        const wood = woodMaterial();
        const halfW = w * 0.42;
        const ledgeY = -h / 2 - 0.02;
        const footY = ledgeY - Math.max(groundDrop - h / 2, 0.45);
        // Two front legs splayed out to the canvas's width, one back leg
        // taking the lean -- the shape that reads as "easel" at a glance
        // even at 30m, which a four-legged stand does not.
        const feet = [
            [new THREE.Vector3(-halfW * 0.9, ledgeY, 0.02), new THREE.Vector3(-halfW * 1.25, footY, 0.16)],
            [new THREE.Vector3(halfW * 0.9, ledgeY, 0.02), new THREE.Vector3(halfW * 1.25, footY, 0.16)],
            [new THREE.Vector3(0, ledgeY + h * 0.12, -0.02), new THREE.Vector3(0, footY, -0.42)]
        ];
        feet.forEach(([a, b]) => { const s = strut(_legGeo, wood, a, b); if (s) group.add(s); });
        // The ledge the canvas actually sits on.
        const ledge = new THREE.Mesh(_ledgeGeo, wood);
        ledge.scale.set(w * 0.95, 0.035, 0.075);
        ledge.position.set(0, ledgeY - 0.012, 0.035);
        ledge.castShadow = true;
        ledge.receiveShadow = true;
        group.add(ledge);
        return group;
    }

    if (mount === 'rope') {
        const rope = ropeMaterial();
        const top = h / 2 + 0.01;
        const anchorY = top + Math.max(rise || 0.9, 0.15);
        // Both ropes converge slightly toward a single knot overhead, which
        // is what stops it reading as two unrelated vertical lines.
        const knot = new THREE.Vector3(0, anchorY, 0);
        [-w * 0.42, w * 0.42].forEach((x) => {
            const s = strut(_ropeGeo, rope, new THREE.Vector3(x, top, 0), knot);
            if (s) { s.castShadow = false; group.add(s); }
        });
        return group;
    }

    return null;
}

const FRAME_STYLES = {
    'pale-wood': { color: 0xc9b79a, roughness: 0.62, metalness: 0.05 },
    'maple': { color: 0xc98a2e, roughness: 0.45, metalness: 0.15 },
    'none': { color: 0x3a4238, roughness: 0.7, metalness: 0.0 }
};

/**
 * Anchors a placement can be parented to. "world" is the garden group
 * itself -- unrotated, unscaled -- so ground/free placements just use plain
 * world-ish coordinates without a separate special case.
 */
export function resolveAnchor(gardenGroup, anchorName) {
    if (anchorName === 'world' || !anchorName) return gardenGroup;
    return gardenGroup.getObjectByName(anchorName) || gardenGroup;
}

function frameBorderWidth(w, h) {
    return THREE.MathUtils.clamp(Math.min(w, h) * 0.045, 0.02, 0.05);
}

/**
 * Builds the frame + panel group for one painting, unpositioned (position/
 * rotation/scale are the caller's job -- this only builds geometry).
 * `texture` may be null while an image is still loading; a neutral canvas
 * placeholder is used until swapPanelTexture() replaces it.
 */
export function createPaintingMesh(widthIn, heightIn, frameStyle = 'pale-wood') {
    const w = widthIn * METRES_PER_INCH;
    const h = heightIn * METRES_PER_INCH;
    const group = new THREE.Group();
    group.name = 'Painting';

    const panelMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.DoubleSide
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), panelMat);
    panel.name = 'PaintingPanel';
    panel.castShadow = true;
    panel.receiveShadow = true;
    group.add(panel);

    if (frameStyle !== 'none') {
        const style = FRAME_STYLES[frameStyle] || FRAME_STYLES['pale-wood'];
        const border = frameBorderWidth(w, h);
        const depth = border * 0.7;
        const frameMat = new THREE.MeshStandardMaterial({
            color: style.color, roughness: style.roughness, metalness: style.metalness
        });
        const bars = [
            { w: w + border * 2, h: border, x: 0, y: h / 2 + border / 2 },
            { w: w + border * 2, h: border, x: 0, y: -h / 2 - border / 2 },
            { w: border, h: h, x: w / 2 + border / 2, y: 0 },
            { w: border, h: h, x: -w / 2 - border / 2, y: 0 }
        ];
        bars.forEach((b) => {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, depth), frameMat);
            bar.position.set(b.x, b.y, -depth / 2 + 0.002);
            bar.castShadow = true;
            bar.receiveShadow = true;
            group.add(bar);
        });
    }

    // Slightly larger than the panel, invisible -- so a small painting is
    // still an easy click/hover target.
    const hitbox = new THREE.Mesh(
        new THREE.PlaneGeometry(w * 1.15 + 0.1, h * 1.15 + 0.1),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.z = 0.02;
    group.add(hitbox);

    return { group, panel, hitbox, width: w, height: h };
}

let _placeholderTexture = null;
function placeholderTexture() {
    if (_placeholderTexture) return _placeholderTexture;
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d8d2c2';
    ctx.fillRect(0, 0, 8, 8);
    _placeholderTexture = new THREE.CanvasTexture(c);
    return _placeholderTexture;
}

const _texLoader = new THREE.TextureLoader();
export function loadPanelTexture(url, onLoad) {
    _texLoader.load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        onLoad(tex);
    }, undefined, () => onLoad(placeholderTexture()));
}

/**
 * Mounts one placement record into the garden. Returns the group (already
 * added to its anchor) plus interactive data in the same shape
 * `_registerHover`/`onClick` in main.js already expects, so paintings share
 * the exact hover/click/focus machinery the four landmarks use.
 */
export function mountPainting(record, gardenGroup) {
    const anchor = resolveAnchor(gardenGroup, record.anchor);
    const { group, panel, hitbox, width, height } = createPaintingMesh(
        record.widthIn, record.heightIn, record.frame
    );
    const rot = record.rotation || [0, 0, 0];
    group.position.fromArray(record.position || [0, 1.5, 0]);
    // YXZ, not Three's default XYZ: under XYZ the lean is applied before the
    // yaw, so a painting's "back" tips toward world north no matter which way
    // it faces. Fine while every angle is authored once and eyeballed; wrong
    // the moment a painting turns, when the lean would visibly roll into a
    // tilt. YXZ yaws first and then leans about the painting's own axis.
    group.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0, 'YXZ');
    group.scale.setScalar(record.scale || 1);
    group.userData.placement = record;
    anchor.add(group);

    // Easels and ropes ride inside the painting's own group, so they inherit
    // its transform instead of needing their own copy of it kept in sync.
    // groundDrop is measured in that (possibly tilted) frame: how far the
    // centre is above the ground directly below it.
    const mount = normalizeMount(record.mount);
    if (mount === 'easel' || mount === 'rope') {
        const scale = record.scale || 1;
        const groundY = groundHeightAt(group.position.x, group.position.z);
        const furniture = createMountFurniture(
            mount, width, height, (record.rise || 0) / scale,
            Math.max((group.position.y - groundY) / scale, 0)
        );
        if (furniture) group.add(furniture);
    }

    panel.material.map = placeholderTexture();
    panel.material.needsUpdate = true;
    if (record.file) {
        loadPanelTexture(getAssetUrl(record.file), (tex) => {
            panel.material.map = tex;
            panel.material.needsUpdate = true;
        });
    }

    // Billboard state. baseYaw is where the mount put it; the painting is only
    // ever allowed to turn within its mount's limit of that.
    group.userData.billboard = {
        baseYaw: group.rotation.y,
        yaw: group.rotation.y,
        shadowYaw: group.rotation.y,
        limit: BILLBOARD_LIMIT[mount] ?? BILLBOARD_LIMIT.surface
    };

    const interactiveData = {
        id: record.id,
        // A painting is a small, deliberately aimed-at target; a landmark's
        // hitbox is a generous cylinder metres wide. Where the two overlap --
        // and every painting hung on a tree overlaps one -- the painting has
        // to win, or it is unclickable wherever it actually hangs.
        kind: 'painting',
        title: record.title || 'Untitled',
        meta: [record.medium, record.year].filter(Boolean).join(' · ')
    };

    // Computed on read, not once at mount: a painting that billboards has
    // turned since it was hung, and framing it against the angle it *used* to
    // face puts the camera off to one side of its own artwork.
    Object.defineProperty(interactiveData, 'cameraTarget', {
        enumerable: true,
        get() {
            const worldPos = new THREE.Vector3();
            const worldQuat = new THREE.Quaternion();
            const worldScale = new THREE.Vector3();
            group.updateWorldMatrix(true, false);
            group.matrixWorld.decompose(worldPos, worldQuat, worldScale);
            const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat);
            // Its size on the wall, not on the drawing board: a painting hung
            // at 1.2x needs to be viewed from 1.2x as far back.
            const s = Math.max(worldScale.x, worldScale.y, 1e-3);
            const focusDist = Math.max(width, height) * s * 1.9 + 0.6;
            return { pos: worldPos.clone().addScaledVector(facing, focusDist), lookAt: worldPos.clone() };
        }
    });

    return { group, panel, hitbox, interactive: { object: hitbox, data: interactiveData } };
}

/**
 * Fetches the placements file: the published Firebase gallery when the
 * Studio is configured (src/cloud/config.js), else the bundled
 * paintings.json the old ?edit workflow wrote. Either a missing cloud
 * config, a network failure, or a malformed response falls through to the
 * bundled file -- a visitor should never see a blank garden because Storage
 * had a bad moment, and a 404 (nothing placed yet, on either path) resolves
 * to an empty list rather than rejecting, since zero paintings hung is the
 * state before anyone has hung anything, not an error.
 *
 * A cloud fetch that hangs (a flaky response, not a clean failure) still
 * has to give up and fall back -- AbortSignal.timeout, not a bare fetch.
 */
export async function loadPlacements() {
    const cloudUrl = galleryUrl();
    if (cloudUrl) {
        try {
            const res = await fetch(cloudUrl, { cache: 'no-cache', signal: AbortSignal.timeout(6000) });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.artworks)) {
                    const preferMedium = QUALITY.tier === 'low';
                    const paintings = data.artworks
                        .map((a) => toPlacementRecord(a, { preferMedium }))
                        .filter(Boolean);
                    return { version: data.schemaVersion || 1, paintings };
                }
            }
        } catch {
            // Falls through to the bundled file below.
        }
    }
    try {
        const res = await fetch(getAssetUrl('paintings.json'), { cache: 'no-cache' });
        if (!res.ok) return { version: 1, paintings: [] };
        const data = await res.json();
        return { version: 1, paintings: Array.isArray(data.paintings) ? data.paintings : [] };
    } catch {
        return { version: 1, paintings: [] };
    }
}

/**
 * Mounts every placement, wiring each into the app's existing hover
 * registry. Returns the mounted records (group + panel per id) so the
 * editor can find and manipulate them later without re-mounting.
 */
/**
 * Turns each painting toward the viewer, within whatever its mount allows.
 *
 * @returns {boolean} true when something has turned far enough since the
 *   shadow map was last rendered to be worth re-rendering it. Shadows here
 *   are cached and refreshed on a cadence gated on the sun having moved (see
 *   main.js), so without this a painting would swing while its shadow stayed
 *   put -- most obviously with the day paused, when the sun never moves and
 *   the shadow map would never refresh at all.
 */
export function updatePaintingBillboards(mounted, camera, dt) {
    if (!mounted || !mounted.size) return false;
    const cam = camera.position;
    const ease = 1 - Math.exp(-BILLBOARD_RESPONSE * Math.min(dt, 0.1));
    let needsShadowRefresh = false;

    for (const { group } of mounted.values()) {
        const b = group.userData.billboard;
        if (!b || b.frozen) continue;
        // Where it would have to face to look straight at the viewer.
        const facing = Math.atan2(cam.x - group.position.x, cam.z - group.position.z);
        const target = b.baseYaw + THREE.MathUtils.clamp(
            wrapAngle(facing - b.baseYaw), -b.limit, b.limit
        );
        b.yaw += wrapAngle(target - b.yaw) * ease;
        group.rotation.y = b.yaw;
        if (Math.abs(wrapAngle(b.yaw - b.shadowYaw)) > BILLBOARD_SHADOW_EPS) needsShadowRefresh = true;
    }
    return needsShadowRefresh;
}

/**
 * Holds one painting still while the camera flies in to look at it, and
 * releases every other. The framing is computed from the angle it is facing
 * at the moment of the click, so a painting that kept turning as the camera
 * swung round would slide out of the shot it was being given -- and a canvas
 * you are standing in front of studying should be still.
 */
export function setBillboardFrozen(mounted, id) {
    if (!mounted) return;
    for (const [key, { group }] of mounted) {
        if (group.userData.billboard) group.userData.billboard.frozen = key === id;
    }
}

/** Called on the frames that actually re-render the shadow map. */
export function commitPaintingShadows(mounted) {
    if (!mounted) return;
    for (const { group } of mounted.values()) {
        if (group.userData.billboard) group.userData.billboard.shadowYaw = group.userData.billboard.yaw;
    }
}

export function mountAllPaintings(gardenGroup, placements, registerHover) {
    const mounted = new Map();
    placements.forEach((record) => {
        const m = mountPainting(record, gardenGroup);
        mounted.set(record.id, m);
        if (registerHover) registerHover(m.interactive.object, m.interactive.data);
    });
    return mounted;
}
