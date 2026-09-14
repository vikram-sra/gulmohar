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
// Collision asks a different question again, and a vertex walk cannot answer
// it: widening the gap tolerance just runs the banyan out through its aerial
// roots to 11m. What a walker is stopped by is "how far out is the bark on
// this bearing", so measure exactly that -- sweep rays outward at chest
// height and take a low percentile of where they land. The percentile is
// what keeps one far buttress from fencing off the lawn around it.
const COLLISION_BUCKETS = 24;
const TRUNK_SOLID_PERCENTILE = 0.3;
const MAX_COLLISION_RADIUS = 2.5;
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
        const centre = new THREE.Vector3(c.x, 0, c.z);
        const samples = sampleTrunkSlab(holder, centre, ground);
        const radius = fitTrunkRadius(samples);
        if (radius > 0) {
            trunks.push({
                name: c.name, x: c.x, z: c.z, radius,
                // What a walker is stopped by, which is never smaller than
                // what a painting is hung on.
                collisionRadius: fitTrunkCollisionRadius(samples, radius),
                base: ground, top: ground + SLAB_HIGH + 1.2
            });
        }
    }
    return { trunks, canopies };
}

// The pavilion's posts, as collision circles. Fitted by sweeping a ray
// outward from the gazebo's centre at chest height and taking the first solid
// thing on each bearing: posts are the only thing at that height, and the
// entrance shows up for free as the bearings that hit nothing, so the way in
// stays open without anybody typing an angle here. The roof is overhead and
// the deck underfoot, so neither is in the way of this sweep.
const GAZEBO_SWEEP_DEG = 2;          // fine enough to catch every post
const GAZEBO_SWEEP_Y = 1.1;          // chest height: posts, not deck or roof
const GAZEBO_SWEEP_REACH = 7.0;
// Wider than the posts actually are, and deliberately: the sweep finds the
// posts *and* the railing between them, roughly a metre apart around the
// ring, and circles the size of the real posts leave gaps a walker slips
// straight through -- measured, one walked to within 0.2m of the centre.
// Sized instead so neighbouring circles overlap and the ring is sealed. It
// is collision only, never drawn, and the entrance is a 50-degree gap, far
// too wide for this to close.
const GAZEBO_POST_RADIUS = 0.55;
// Bearings closer together than this belong to the same post.
const GAZEBO_POST_MERGE_M = 0.55;

/**
 * Collision circles for the gazebo's posts, or [] if it has not loaded.
 * @param {THREE.Object3D} gardenGroup
 * @param {{x:number,z:number}} centre  the pavilion's world position
 */
export function fitGazeboPosts(gardenGroup, centre) {
    const gazebo = gardenGroup.getObjectByName('Gazebo');
    if (!gazebo) return [];
    gardenGroup.updateMatrixWorld(true);
    const meshes = [];
    gazebo.traverse((child) => {
        // The invisible click cylinder is the whole point of not using
        // intersectObject(gazebo, true) here -- it would swallow every ray.
        if (child.isMesh && child.visible && child.material && child.material.visible !== false) meshes.push(child);
    });
    if (!meshes.length) return [];

    const ray = new THREE.Raycaster();
    const from = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const posts = [];
    for (let deg = 0; deg < 360; deg += GAZEBO_SWEEP_DEG) {
        const a = THREE.MathUtils.degToRad(deg);
        const dx = Math.cos(a), dz = Math.sin(a);
        from.set(centre.x, groundHeightAt(centre.x, centre.z) + GAZEBO_SWEEP_Y, centre.z);
        dir.set(dx, 0, dz);
        ray.set(from, dir);
        ray.near = 0;
        ray.far = GAZEBO_SWEEP_REACH;
        const hit = ray.intersectObjects(meshes, false)[0];
        if (!hit) continue;   // a gap in the ring: the entrance, or between posts
        const x = hit.point.x, z = hit.point.z;
        const near = posts.find((p) => Math.hypot(p.x - x, p.z - z) < GAZEBO_POST_MERGE_M);
        if (near) {
            // Average the bearings that found the same post, so the circle
            // sits on its middle rather than on whichever face was hit first.
            near.x = (near.x * near.n + x) / (near.n + 1);
            near.z = (near.z * near.n + z) / (near.n + 1);
            near.n += 1;
        } else {
            posts.push({ x, z, n: 1 });
        }
    }
    const base = groundHeightAt(centre.x, centre.z);
    return posts.map((p) => ({
        name: 'GazeboPost', x: p.x, z: p.z,
        radius: GAZEBO_POST_RADIUS, base, top: base + 2.6
    }));
}

/**
 * How far out a walker should be stopped, per tree.
 *
 * Same vertices as the aim fit, read a different way. The aim fit walks
 * outward from the axis and stops at the first ring of empty space, which is
 * right for "what can a painting lie flat against" and wrong here: on the
 * banyan that ring arrives after 0.53m, around a thin central stem, and let a
 * visitor walk through a metre and a half of visible bark.
 *
 * So bucket the vertices by bearing, ask each bucket how far out this tree
 * reaches, and take a low percentile across the buckets. Anything past
 * MAX_COLLISION_RADIUS is dropped before the percentile rather than clamped
 * after it -- those are branches and aerial roots you should be able to walk
 * under and between, and letting them into the statistic is what would fence
 * off the lawn around the tree. The percentile then means "the radius this
 * trunk occupies in most directions", which is the thing to be stopped by.
 *
 * Raycasting would seem more direct and is not: these holders carry an
 * invisible click-hitbox cylinder metres wide, and the rays simply find that.
 */
function fitTrunkCollisionRadius(samples, aimRadius) {
    const buckets = new Array(COLLISION_BUCKETS).fill(0);
    let filled = 0;
    for (const { r, theta } of samples) {
        if (r > MAX_COLLISION_RADIUS) continue;
        let b = Math.floor(((theta + Math.PI) / (Math.PI * 2)) * COLLISION_BUCKETS);
        if (b < 0) b = 0;
        if (b >= COLLISION_BUCKETS) b = COLLISION_BUCKETS - 1;
        if (buckets[b] === 0) filled += 1;
        if (r > buckets[b]) buckets[b] = r;
    }
    if (filled < COLLISION_BUCKETS / 3) return aimRadius;
    const reach = buckets.filter((v) => v > 0).sort((a, b) => a - b);
    const pick = reach[Math.floor(reach.length * TRUNK_SOLID_PERCENTILE)];
    return Math.max(pick, aimRadius);
}

/**
 * One pass over a tree's trunk-height geometry, as {r, theta} per sampled
 * vertex. Both fits read this; it is walked once per tree at startup.
 */
function sampleTrunkSlab(holder, centre, ground) {
    const samples = [];
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
            const dx = v.x - centre.x, dz = v.z - centre.z;
            samples.push({ r: Math.hypot(dx, dz), theta: Math.atan2(dz, dx) });
        }
    });
    return samples;
}

/** The clean central cylinder a painting can be hung flat against. */
function fitTrunkRadius(samples) {
    if (samples.length < 24) return 0;
    const distances = samples.map((s) => s.r).sort((a, b) => a - b);
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

const _branchRay = new THREE.Raycaster();
const _up = new THREE.Vector3(0, 1, 0);
const _from = new THREE.Vector3();

/**
 * The height of the first actual branch directly above (x, z), or null when
 * the vertical line through that point passes through open air all the way
 * up -- which happens plenty, since a canopy is mostly gaps.
 *
 * Leaves are excluded from the cast, for two separate reasons: leaf cards
 * are alpha-tested, so a ray "hitting" one usually hits a transparent
 * corner of a quad rather than anything you can see; and they are displaced
 * by the wind shader at render time while the CPU-side geometry a raycast
 * reads stays at its rest pose, so a leaf hit is not where the leaf looks.
 * Branch and trunk meshes are neither, which makes them the only honest
 * thing here to tie a rope to.
 *
 * One cast per rope-hung painting at mount time, never per frame.
 */
export function findBranchAbove(gardenGroup, treeName, x, z, fromY, maxY) {
    const holder = gardenGroup.getObjectByName(treeName);
    if (!holder || maxY <= fromY) return null;

    const meshes = [];
    holder.traverse((child) => {
        if (!child.isMesh || !child.visible) return;
        if (/leaf|leaves|foliage|flower|fruit|canopy/i.test(`${child.name} ${child.material && child.material.name}`)) return;
        meshes.push(child);
    });
    if (!meshes.length) return null;

    _from.set(x, fromY, z);
    _branchRay.set(_from, _up);
    _branchRay.near = 0;
    _branchRay.far = maxY - fromY;
    const hits = _branchRay.intersectObjects(meshes, false);
    return hits.length ? hits[0].point.y : null;
}
