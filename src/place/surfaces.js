import * as THREE from 'three';
import { groundHeightAt } from '../scene/garden.js';

// ---------------------------------------------------------------------------
// What a painting can be attached to, measured from the trees that actually
// loaded rather than from numbers typed here.
//
// Two different questions get two different answers:
//
//   * "Is there a trunk in front of me?" -- a cylinder fitted to the real
//     trunk vertices. Raycasting bark directly would mean ~200k triangles per
//     aim, and worse, bark normals are noisy enough that a hung painting
//     visibly tilts and jitters as you sweep across them. A plumb cylinder
//     gives a clean vertical normal, which is what hanging wants.
//
//   * "Am I standing under branches?" -- the canopy's horizontal extent,
//     deliberately shrunk, so "under the tree" means under it and not at its
//     fringe where a rope would hang off nothing.
//
// Both come from one pass over the tree geometry at startup. The trees are
// static, so it never needs redoing.
// ---------------------------------------------------------------------------

// Where a trunk is a trunk: above the flared roots, below the first branches.
const SLAB_LOW = 0.7, SLAB_HIGH = 1.9;
// Radial gap that means "this is no longer the trunk". The trunk is a solid
// shell of vertices running outward from the axis; a branch or an aerial root
// crossing the same slab sits past a ring of empty space. Walking outward and
// stopping at the first gap this wide finds the bark and nothing else.
const TRUNK_GAP_M = 0.14;
// Nothing in this garden has a 2.5m-radius trunk. A fit that big means the
// walk found no gap -- a dense root curtain, say -- so the fit is discarded
// rather than turned into an invisible wall you could hang a painting on.
const MAX_TRUNK_RADIUS = 2.5;
const CANOPY_FRACTION = 0.6;

const TREE_NAMES = ['GulmoharTree', 'banyan_0', 'mango_1'];

/**
 * @returns {{trunks: Array, canopies: Array}} both in world space. A tree that
 *   failed to load (or fell back to a procedural stand-in with no trunk in the
 *   slab) simply isn't in the lists, which degrades to "you can't hang on that
 *   one" rather than to a proxy floating in the wrong place.
 */
/**
 * Just the canopy extents -- a bounding box per tree, no per-vertex trunk
 * scan. Cheap enough to run on every visitor's mount pass (paintings.js
 * calls this for the rope mount's real branch height), not just placement
 * mode's own aiming setup.
 */
export function fitCanopies(gardenGroup) {
    gardenGroup.updateMatrixWorld(true);
    const canopies = [];
    for (const name of TREE_NAMES) {
        const holder = gardenGroup.getObjectByName(name);
        if (!holder) continue;
        const centre = new THREE.Vector3();
        holder.getWorldPosition(centre);
        const box = new THREE.Box3().setFromObject(holder);
        if (box.isEmpty()) continue;
        const halfX = (box.max.x - box.min.x) / 2;
        const halfZ = (box.max.z - box.min.z) / 2;
        canopies.push({
            name, x: centre.x, z: centre.z,
            radius: Math.min(halfX, halfZ) * CANOPY_FRACTION,
            top: box.max.y
        });
    }
    return canopies;
}

export function fitSurfaces(gardenGroup) {
    gardenGroup.updateMatrixWorld(true);
    const canopies = fitCanopies(gardenGroup);
    const trunks = [];
    for (const c of canopies) {
        const holder = gardenGroup.getObjectByName(c.name);
        if (!holder) continue;
        const ground = groundHeightAt(c.x, c.z);
        const radius = fitTrunkRadius(holder, new THREE.Vector3(c.x, 0, c.z), ground);
        if (radius > 0) {
            trunks.push({ name: c.name, x: c.x, z: c.z, radius, base: ground, top: ground + SLAB_HIGH + 1.2 });
        }
    }
    return { trunks, canopies };
}

function fitTrunkRadius(holder, centre, ground) {
    const distances = [];
    const v = new THREE.Vector3();
    holder.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        const pos = child.geometry.attributes && child.geometry.attributes.position;
        if (!pos) return;
        // Leaf cards and hanging roots are not trunk; sampling them is what
        // makes a fitted radius absurd.
        if (/leaf|leaves|foliage|flower|fruit|vine|canopy/i.test(`${child.name} ${child.material && child.material.name}`)) return;
        // Every 4th vertex: a trunk's silhouette does not need 40k samples,
        // and this keeps the whole fit under a frame's worth of work.
        for (let i = 0; i < pos.count; i += 4) {
            v.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld);
            const y = v.y - ground;
            if (y < SLAB_LOW || y > SLAB_HIGH) continue;
            distances.push(Math.hypot(v.x - centre.x, v.z - centre.z));
        }
    });
    if (distances.length < 24) return 0;
    distances.sort((a, b) => a - b);
    // Walk outward from the axis and stop where the geometry stops being
    // continuous. A percentile cannot do this: on the gulmohar, whose low
    // branches cross the slab, branch vertices outnumber trunk vertices, so
    // any high percentile returns a branch tip -- it fitted a 7.7m cylinder.
    let radius = distances[0];
    for (let i = 1; i < distances.length; i++) {
        if (distances[i] - distances[i - 1] > TRUNK_GAP_M) break;
        radius = distances[i];
    }
    return radius > MAX_TRUNK_RADIUS ? 0 : radius;
}

/** Invisible cylinders the aim ray can hit, added to the garden group. */
export function buildTrunkProxies(gardenGroup, trunks, { visible = false } = {}) {
    const material = new THREE.MeshBasicMaterial({
        visible, color: 0xff4488, wireframe: true, depthTest: !visible
    });
    return trunks.map((t) => {
        const height = t.top - t.base;
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(t.radius, t.radius * 1.06, height, 14, 1, true),
            material
        );
        mesh.name = `TrunkProxy_${t.name}`;
        mesh.position.set(t.x, t.base + height / 2, t.z);
        mesh.userData.trunk = t;
        gardenGroup.add(mesh);
        return mesh;
    });
}

export function canopyOver(canopies, x, z) {
    for (const c of canopies) {
        if (Math.hypot(x - c.x, z - c.z) <= c.radius) return c;
    }
    return null;
}
