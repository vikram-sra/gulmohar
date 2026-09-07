import * as THREE from 'three';
import { getAssetUrl } from '../utils/paths.js';

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
    group.position.fromArray(record.position || [0, 1.5, 0]);
    group.rotation.fromArray(record.rotation || [0, 0, 0]);
    group.scale.setScalar(record.scale || 1);
    group.userData.placement = record;
    anchor.add(group);

    panel.material.map = placeholderTexture();
    panel.material.needsUpdate = true;
    if (record.file) {
        loadPanelTexture(getAssetUrl(record.file), (tex) => {
            panel.material.map = tex;
            panel.material.needsUpdate = true;
        });
    }

    // Camera frames the work square-on, from directly in front, at a
    // distance that fits whichever axis (width or height) needs more room.
    const worldPos = new THREE.Vector3();
    group.getWorldPosition(worldPos);
    const worldQuat = new THREE.Quaternion();
    group.getWorldQuaternion(worldQuat);
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat);
    const focusDist = Math.max(width, height) * 1.9 + 0.6;
    const camPos = worldPos.clone().addScaledVector(facing, focusDist);

    const interactiveData = {
        id: record.id,
        title: record.title || 'Untitled',
        meta: [record.medium, record.year].filter(Boolean).join(' · '),
        cameraTarget: { pos: camPos, lookAt: worldPos.clone() }
    };

    return { group, panel, hitbox, interactive: { object: hitbox, data: interactiveData } };
}

/**
 * Fetches the placements file. A 404 (nothing placed yet) resolves to an
 * empty list rather than rejecting, so the garden with zero paintings is not
 * an error state -- it's the state before anyone has hung anything.
 */
export async function loadPlacements() {
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
export function mountAllPaintings(gardenGroup, placements, registerHover) {
    const mounted = new Map();
    placements.forEach((record) => {
        const m = mountPainting(record, gardenGroup);
        mounted.set(record.id, m);
        if (registerHover) registerHover(m.interactive.object, m.interactive.data);
    });
    return mounted;
}
