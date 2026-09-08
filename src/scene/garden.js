import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getAssetUrl } from '../utils/paths.js';
import { isFoliageForWind, injectFoliageWind, createWindEnvelope, updateWindEnvelope } from './wind.js';
import { QUALITY } from '../quality.js';

// Garden layout coordinates:
// - Center: Gulmohar Tree (0, 0, 0)
// - Top-Left: Pond with Waterfalls (-23, 0, -19)
// - Bottom-Right: Gazebo (+22, 0, +18)
// - Top-Right: Maple Tree (+23, 0, -21)
export const GARDEN_POINTS = {
    GULMOHAR: new THREE.Vector3(0, 0, 0),
    POND: new THREE.Vector3(-23.0, 0, -19.0),
    GAZEBO: new THREE.Vector3(22.0, 0, 18.0),
    MAPLE: new THREE.Vector3(23.0, 0, -21.0)
};

// The path loop's own shape (createGardenPathway, below) -- pulled to module
// scope so grass and flower beds can ask "is this point clear of the path"
// without re-typing the curve's formula, the way the ground shader used to
// re-type the pond's coordinates.
const PATH_BASE_R = 15.5;
const PATH_WAVE_AMP = 2.8;
const PATH_WIDTH = 2.4;
const POND_CLEAR_R = 10.5;   // scatter grass and plants up to the pond perimeter
const GAZEBO_CLEAR_R = 4.6;

/**
 * The path loop's shape, sampled once per angle and shared by everything
 * that needs it -- the path mesh itself, `isGroundClear`'s exclusion band,
 * and the flower-bed placer -- so it's defined exactly once. The base 4-lobe
 * clover (matching the original sketch) is layered with two higher-frequency,
 * phase-shifted sines so the loop reads as an irregular, hand-walked trail
 * rather than a uniform clover -- all three terms are integer multiples of
 * theta, so the curve still closes without a seam at theta = 0 / 2*PI.
 */
const PATH_POND_CLEARANCE = 13.8;   // keep the path out of the pond basin

function pathRadiusAt(theta) {
    const base = PATH_BASE_R
        + Math.sin(theta * 4) * PATH_WAVE_AMP
        + Math.sin(theta * 7 + 1.3) * (PATH_WAVE_AMP * 0.4)
        + Math.sin(theta * 11 - 0.6) * (PATH_WAVE_AMP * 0.22);

    const px = GARDEN_POINTS.POND.x, pz = GARDEN_POINTS.POND.z;
    const proj = px * Math.cos(theta) + pz * Math.sin(theta);
    if (proj <= 0) return base;
    const disc = proj * proj - (px * px + pz * pz) + PATH_POND_CLEARANCE * PATH_POND_CLEARANCE;
    if (disc <= 0) return base;
    const nearRoot = proj - Math.sqrt(disc);
    return nearRoot > 0 ? Math.min(base, nearRoot) : base;
}

// Measured against the pond scan itself. Its water surface sits at y = -0.45m.
// A gentle 48cm hollow brings the lawn seamlessly down to meet the rock perimeter
// without artificial 3-meter crater walls or raised volcanic berms.
const POND_BED_DEPTH = 0.48;    // bed gently settles 48cm below ground
const POND_BED_R = 6.2;         // bed stays flat out to here
const POND_RIM_W = 3.5;         // smooth 3.5m bank transition
const POND_BANK_H = 0.0;        // level lawn, no artificial crater wall
const POND_BANK_R = 10.5;       // bank smoothly blends into flat lawn here

function smoothstep01(t) {
    const c = Math.min(1, Math.max(0, t));
    return c * c * (3 - 2 * c);
}

/**
 * Irregular outline for the pond, as a multiplier on its nominal radius.
 *
 * A perfectly circular dig is invisible at eye level and unmistakable from
 * above -- it reads as a crater stamped into the lawn rather than as water
 * that collected in a hollow. Three phase-shifted harmonics give a lopsided,
 * organic edge instead. All are integer multiples of theta, so the outline
 * closes on itself with no seam, and it is deterministic, so the basin, the
 * bank and the water sheet all agree on exactly the same shape.
 */
function pondShapeAt(theta) {
    return 1
        + Math.sin(theta * 2 + 0.7) * 0.17
        + Math.sin(theta * 3 - 1.9) * 0.10
        + Math.sin(theta * 5 + 2.6) * 0.06;
}

const POND_ROT_Y = 2.35;
const _pondCos = Math.cos(POND_ROT_Y);
const _pondSin = Math.sin(POND_ROT_Y);

export function groundHeightAt(x, z) {
    const dx = x - GARDEN_POINTS.POND.x, dz = z - GARDEN_POINTS.POND.z;
    const d = Math.hypot(dx, dz);
    if (d > 16.0) return 0.0;

    // Transform into pond's local orientation
    const lx = _pondCos * dx - _pondSin * dz;
    const lz = _pondSin * dx + _pondCos * dz;

    // 1. Grassy hillside embankment rising behind the high rock wall
    let hillH = 0.0;
    const hillD = Math.hypot((lx - 10.5) * 0.70, (lz - 1.2) * 0.90);
    if (hillD < 6.0) {
        hillH = 1.6 * Math.pow(1.0 - hillD / 6.0, 1.4);
    }

    // 2. Sunken pond basin bed cradling the water pool
    let basinH = 0.0;
    const basinD = Math.hypot(lx - 0.4, (lz - 0.8) * 1.15);
    if (basinD < 7.5) {
        basinH = -0.48 * (1.0 - smoothstep01((basinD - 3.5) / 4.0));
    }

    return hillH + basinH;
}

/**
 * Ground validity for anything scattered across the lawn -- grass, flower
 * beds -- so pond, path and gazebo footprint are each defined exactly once.
 * `margin` widens every exclusion by the same amount, for things (like a
 * flower bed) that should keep a little more distance than grass does.
 */
export function isGroundClear(x, z, margin = 0) {
    const dx = x - GARDEN_POINTS.POND.x, dz = z - GARDEN_POINTS.POND.z;
    const d = Math.hypot(dx, dz);
    if (d < 12.0 + margin) return false;
    if (Math.hypot(x - GARDEN_POINTS.GAZEBO.x, z - GARDEN_POINTS.GAZEBO.z) < GAZEBO_CLEAR_R + margin) return false;
    const theta = Math.atan2(z, x);
    const pathR = pathRadiusAt(theta);
    if (Math.abs(Math.hypot(x, z) - pathR) < PATH_WIDTH * 0.5 + 0.3 + margin) return false;
    return true;
}

/**
 * Loads all 3D assets for the garden and constructs the pathways, central bed,
 * landmarks, and interactive targets.
 */
export function loadGarden(loadingManager) {
    const loader = new GLTFLoader(loadingManager);
    // Every garden asset is meshopt-compressed at rest (see README) -- without
    // the decoder, GLTFLoader fails silently on those files and each landmark
    // falls back to its procedural stand-in.
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gardenGroup = new THREE.Group();
    gardenGroup.name = 'Garden';

    const interactives = [];
    const updateables = [];

    const loadGLTF = (path) => new Promise((resolve) => {
        loader.load(
            getAssetUrl(path),
            (gltf) => resolve(gltf),
            undefined,
            (err) => {
                console.warn(`Failed to load GLTF ${path}:`, err);
                resolve(null);
            }
        );
    });

    return Promise.all([
        loadGLTF('models/gulmohar.glb'),
        loadGLTF('models/gazebo.glb'),
        loadGLTF('models/pond.glb'),
        loadGLTF('models/maple.glb'),
        loadGLTF('models/floor_leaves.glb'),
        loadGLTF('models/grass_cards.glb'),
        loadGLTF('models/veg_clumps.glb'),
        loadGLTF('models/dense_grass.glb'),
        QUALITY.backgroundTrees > 0 ? loadGLTF('models/banyan.glb') : Promise.resolve(null),
        QUALITY.backgroundTrees > 0 ? loadGLTF('models/mango.glb') : Promise.resolve(null)
    ]).then(([gulmoharGltf, gazeboGltf, pondGltf, mapleGltf, leavesGltf,
              grassCardsGltf, vegClumpsGltf, denseGrassGltf, banyanGltf, mangoGltf]) => {
        // 1. Gulmohar Centerpiece Tree (At 0,0,0)
        const gulmoharObj = setupGulmohar(gulmoharGltf);
        gardenGroup.add(gulmoharObj.model);
        interactives.push(gulmoharObj.interactive);

        // 2. Gazebo (Bottom-Right corner)
        const gazeboObj = setupGazebo(gazeboGltf);
        gardenGroup.add(gazeboObj.model);
        interactives.push(gazeboObj.interactive);

        // 3. Pond with Waterfalls (Top-Left corner)
        const pondObj = setupPond(pondGltf);
        gardenGroup.add(pondObj.model);
        interactives.push(pondObj.interactive);
        if (pondObj.update) updateables.push(pondObj.update);

        // 4. Maple Tree (Top-Right corner)
        const mapleObj = setupMaple(mapleGltf);
        gardenGroup.add(mapleObj.model);
        interactives.push(mapleObj.interactive);

        // 5. Floor Detailing with floor_leaves.glb everywhere
        const floorResult = setupFloorEverywhere(leavesGltf);
        gardenGroup.add(floorResult.group);

        // 6. Curving Garden Path (centered at origin)
        const pathway = createGardenPathway();
        gardenGroup.add(pathway);

        // 7. Background trees, outside the path loop -- hoverable and
        // clickable like the four landmarks, so they push into `interactives`.
        gardenGroup.add(setupBackgroundTrees(banyanGltf, mangoGltf, interactives));

        const windEnv = createWindEnvelope();

        return {
            group: gardenGroup,
            interactives,
            grassCards: grassCardsGltf,
            vegClumps: vegClumpsGltf,
            denseGrass: denseGrassGltf,
            groundTexture: floorResult.groundTexture,
            groundNormal: floorResult.groundNormal,
            update: (time, delta) => {
                updateWindEnvelope(windEnv, delta, time);
                for (let i = 0; i < updateables.length; i++) {
                    updateables[i](time, delta);
                }
            }
        };
    });
}

/**
 * Configure materials for realistic foliage with proper shadow maps and alpha cutoffs.
 */
const WOODY_NAME = /trunk|bark|wood|stem|log|root|limb|timber|shu[_ -]?gan/i;

function enhanceFoliageMaterial(mat, child, alphaCut = 0.32) {
    // Only alpha-cutout leaf cards -- single planes legitimately seen from
    // either face -- need DoubleSide. A trunk is a closed opaque solid, so
    // shading its back faces is both wasted fill and physically wrong. This
    // was applied unconditionally, which put the maple trunk (120,122 tris)
    // and the gulmohar trunk (62,241) through twice-sided shading for nothing.
    // The scene is fill-bound, not draw-call-bound, so this is real budget.
    const isWoody = WOODY_NAME.test(mat.name || '') || WOODY_NAME.test(child.name || '');

    // Canopy cards drop to FrontSide below the top tier: on a phone, halving
    // the shaded fragments of 500k alpha-tested triangles matters more than
    // the few leaves that thin out when viewed from behind.
    mat.side = isWoody ? THREE.FrontSide : QUALITY.canopySide;
    mat.shadowSide = THREE.FrontSide;
    if (mat.roughness !== undefined) mat.roughness = Math.max(mat.roughness, 0.65);

    child.castShadow = true;
    // Foliage RECEIVING shadow means PCF sampling across ~500k leaf fragments.
    // It is the first thing worth cutting under pressure and the first worth
    // buying back: without it leaves take no shadow from the branches above
    // them and a dense canopy renders as uniformly bright. Trunks always
    // receive -- there are few of them and the self-shadowing reads.
    child.receiveShadow = isWoody || QUALITY.foliageReceiveShadow;

    const isFoliage = mat.alphaTest > 0 || mat.transparent ||
        (mat.name && /leaf|leaves|foliage|flower|petal|branch|twig|stalk|bud|00[1-4]|mat/i.test(mat.name)) ||
        (child.name && /leaf|leaves|flower|petal|branch|twig/i.test(child.name));

    if (isFoliage && mat.map) {
        mat.alphaTest = alphaCut;
        mat.transparent = false;
        mat.depthWrite = true;
        mat.needsUpdate = true;
        child.customDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            map: mat.map,
            alphaTest: alphaCut,
            side: THREE.FrontSide
        });
        // The photoreal leaf/flower photos read far more saturated and bright
        // than the pastel-graded rest of the scene -- pull them toward their
        // own luminance (desaturate) and dim slightly, so foliage still reads
        // as real detail without shouting over everything pastel around it.
        // One material is shared across many mesh chunks (a tree's leaves are
        // rarely one mesh), and this runs once per chunk -- guard against
        // wrapping the same material's onBeforeCompile more than once, or
        // the injection duplicates itself into a GLSL redefinition error.
        // ...but only on actual leaves and blossoms. The isFoliage test above
        // ends in `|mat`, which matches almost every material name in these
        // exports (shu_gan_Mat, Material_Mat, Delonix_trunk's included) -- fine
        // for deciding alpha cutout, but grading bark with it bleached the
        // trunks. Reuses the same woody test that decides sidedness above.
        if (!isWoody && !mat.userData.__pastelFoliage) {
            mat.userData.__pastelFoliage = true;
            const prevCompile = mat.onBeforeCompile;
            mat.onBeforeCompile = (shader, renderer) => {
                if (prevCompile) prevCompile(shader, renderer);
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <color_fragment>',
                    `#include <color_fragment>
                     float foliageLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
                     diffuseColor.rgb = mix(diffuseColor.rgb, vec3(foliageLum), 0.30) * 0.90;`
                );
            };
            mat.needsUpdate = true;
        }
    }
}

// Shared across every landmark that gets a contact-shadow decal, so the
// canvas is only ever drawn once.
let _contactShadowTexture = null;
function contactShadowTexture() {
    if (_contactShadowTexture) return _contactShadowTexture;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.35, 'rgba(0,0,0,0.62)');
    g.addColorStop(0.70, 'rgba(0,0,0,0.22)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    _contactShadowTexture = new THREE.CanvasTexture(canvas);
    return _contactShadowTexture;
}

/**
 * A radial-gradient decal under a landmark, for the darkening a real shadow
 * map rarely resolves right at the contact point. Only worth it for objects
 * wide relative to their height -- a disc wider than the object is tall
 * reads as a circle painted on the ground rather than shade (see
 * references/world.md) -- which is why the pond doesn't get one: its basin
 * already reads as sunken.
 *
 * @param {number} diameter  world units; sized per-landmark by the caller
 */
function createContactShadow(diameter) {
    const decal = new THREE.Mesh(
        new THREE.PlaneGeometry(diameter, diameter),
        new THREE.MeshBasicMaterial({
            map: contactShadowTexture(),
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4
        })
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.y = 0.03;   // above the grass root line, below the pathway ribbon
    decal.renderOrder = 2;
    return decal;
}

/**
 * Collapse a model's static meshes into one mesh per material.
 *
 * The pond arrives as 405 separate meshes sharing four materials, and they are
 * the whole reason the scene's draw calls swing between 27 and 459 depending on
 * which way the camera faces. Merging is only safe *after* setupPond's
 * name-based material lookup has run -- `water`, `riples` and `plane.002` are
 * identified by node name, and merging first would destroy those names. So this
 * runs last, and skips anything the caller still needs to address individually.
 *
 * Transforms are baked relative to `root`, not to the world, so the group's own
 * placement and scale still apply afterwards.
 */
function mergeStaticByMaterial(root, skip = new Set()) {
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const groups = new Map();
    const originals = [];

    root.traverse((child) => {
        // Hidden meshes must not be merged. Merging builds a NEW mesh that is
        // visible by default, so folding an invisible child into it silently
        // resurrects it -- which is what put the pond's removed ripple glint
        // cards back on screen as `merged_riples` after they had been hidden.
        if (!child.isMesh || child.isInstancedMesh || skip.has(child) || !child.visible) return;
        if (!child.geometry || !child.material || Array.isArray(child.material)) return;
        const key = child.material.uuid + '|' + Object.keys(child.geometry.attributes).sort().join(',');
        if (!groups.has(key)) groups.set(key, { material: child.material, meshes: [] });
        groups.get(key).meshes.push(child);
        originals.push(child);
    });

    let merged = 0, removed = 0;
    groups.forEach(({ material, meshes }) => {
        if (meshes.length < 2) return;
        const geoms = meshes.map((m) => {
            const g = m.geometry.clone();
            g.applyMatrix4(inv.clone().multiply(m.matrixWorld));
            // mergeGeometries refuses to merge attributes whose `gpuType` differs,
            // and this export carries a mix even though every array is a
            // Float32Array. Normalising it is what actually lets the merge run.
            for (const attr of Object.values(g.attributes)) {
                if (attr.array instanceof Float32Array) attr.gpuType = THREE.FloatType;
            }
            return g;
        });
        const combined = mergeGeometries(geoms, false);
        geoms.forEach((g) => g.dispose());
        if (!combined) return;   // mismatched attributes: leave this group alone

        const mesh = new THREE.Mesh(combined, material);
        mesh.name = `merged_${material.name || 'material'}`;
        mesh.castShadow = meshes.some((m) => m.castShadow);
        mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
        root.add(mesh);
        meshes.forEach((m) => { m.removeFromParent(); m.geometry.dispose(); removed++; });
        merged++;
    });

    return { merged, removed, remaining: originals.length - removed };
}

// ---------------------------------------------------------------------------
// 1. Gulmohar Setup (Center of garden)
// ---------------------------------------------------------------------------
function setupGulmohar(gltf) {
    const targetHeight = 11.2;
    const group = new THREE.Group();
    group.name = 'GulmoharTree';

    let model;
    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scaleFactor = targetHeight / Math.max(size.y, 0.001);

        // Center trunk contact point on origin y = 0
        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -box.min.y * scaleFactor - 0.1, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            child.castShadow = true;
            child.receiveShadow = true;
            // Captured before enhanceFoliageMaterial runs: it rewrites every
            // BLEND material to alphaTest, which would make `transparent`
            // false on all foliage and blind the wind gate's alpha-blend test.
            const wantsWind = isFoliageForWind(child, child.material);
            enhanceFoliageMaterial(child.material, child, 0.32);
            if (wantsWind) injectFoliageWind(child, child.material, { swayFraction: 0.048, speedMult: 0.85 });   // was 0.05/1.0 -- too much sway on the stalk mesh, 48% of the tree's geometry
        });
    } else {
        model = createFallbackTree(0xcc3720, 11.2);
    }

    group.position.copy(GARDEN_POINTS.GULMOHAR);
    group.rotation.y = 0.45;
    group.add(model);
    group.add(createContactShadow(7.5));

    // Hitbox for hover/click (in local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(5.0, 5.0, 12.0, 12, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 5.5, 0);
    group.add(hitbox);

    const interactiveData = {
        id: 'gulmohar',
        title: 'Royal Poinciana (Gulmohar)',
        meta: 'Delonix Regia · Centerpiece of the Garden',
        cameraTarget: { pos: new THREE.Vector3(12.8, 3.2, 11.2), lookAt: new THREE.Vector3(0, 2.8, 0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        }
    };
}

// ---------------------------------------------------------------------------
// 2. Gazebo Setup (Bottom-Right)
// ---------------------------------------------------------------------------
function setupGazebo(gltf) {
    const targetHeight = 6.6;   // was 4.8 -- read undersized beside 12-17m trees
    const group = new THREE.Group();
    group.name = 'Gazebo';

    let model;
    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scaleFactor = targetHeight / Math.max(size.y, 0.001);

        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -box.min.y * scaleFactor - 0.08, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            child.castShadow = true;
            child.receiveShadow = true;
            child.material.side = THREE.DoubleSide;
            if (child.material.roughness !== undefined) child.material.roughness = 0.72;
        });
    } else {
        model = createFallbackGazebo();
    }

    group.position.copy(GARDEN_POINTS.GAZEBO);
    // Face entrance steps directly toward the center Gulmohar tree
    group.rotation.y = 0.50;
    group.add(model);
    group.add(createContactShadow(6.5));

    // Hitbox for hover/click (local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(4.2, 4.2, 5.5, 12, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 2.6, 0);
    group.add(hitbox);

    const interactiveData = {
        id: 'gazebo',
        title: 'Garden Pavilion',
        meta: 'Tranquil Gazebo · Click to visit',
        cameraTarget: { pos: new THREE.Vector3(14.5, 4.5, 12.0), lookAt: new THREE.Vector3(22.0, 2.2, 18.0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        }
    };
}

// ---------------------------------------------------------------------------
// 3. Pond with Waterfalls Setup (Top-Left)
// ---------------------------------------------------------------------------
function setupPond(gltf) {
    const group = new THREE.Group();
    group.name = 'PondWithWaterfalls';

    let model;
    let waterMeshList = [];
    const skipMerge = new Set();   // meshes that keep their own material/shader
    let surfaceWaterMat = null;
    let pondWaterUniforms = {
        uPondC: { value: new THREE.Vector2(GARDEN_POINTS.POND.x, GARDEN_POINTS.POND.z) },
        uTime: { value: 0.0 }
    };
    let pondCardMat = null;      // shared alpha-cutout variant (vegetation planes)
    let pondSolidMat = null;     // shared opaque variant (scanned rock)
    const rockGeomMap = new Map();
    let waterTex = null;

    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        const targetWidth = 22.0;
        const scaleFactor = targetWidth / Math.max(size.x, 0.001);

        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -0.42, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;

            const mat = child.material;
            const matName = (mat.name || '').toLowerCase();
            const childName = (child.name || '').toLowerCase();

            if (childName.includes('plane.002') || childName.includes('plane_002')) {
                // Outer terrain of the asset: feather radially so it seamlessly merges under the lawn
                const terrainMat = new THREE.MeshStandardMaterial({
                    map: mat.map || null,
                    roughness: 0.95,
                    metalness: 0.02,
                    transparent: true,
                    depthWrite: false,
                    polygonOffset: true,
                    polygonOffsetFactor: -1,
                    polygonOffsetUnits: -1
                });
                terrainMat.onBeforeCompile = (shader) => {
                    shader.vertexShader = 'varying vec3 vPondLocalPos;\n' + shader.vertexShader.replace(
                        '#include <worldpos_vertex>',
                        '#include <worldpos_vertex>\n vPondLocalPos = transformed;'
                    );
                    shader.fragmentShader = 'varying vec3 vPondLocalPos;\n' + shader.fragmentShader.replace(
                        '#include <dithering_fragment>',
                        `#include <dithering_fragment>
                         // .xy silently pulled in this mesh's own vertical
                         // extent (the pond terrain rises ~5m at the back) --
                         // a horizontal-only radius has to drop the height
                         // axis (.xz), or a tall rim fades out early purely
                         // for being tall, which is what read as an elevated
                         // area missing/floating out back. Band widened
                         // ~4x too, for a much bigger green transition
                         // around that same tall rim rather than a thin ring.
                         float d = length(vPondLocalPos.xz);
                         float fade = 1.0 - smoothstep(5.4, 7.5, d);
                         gl_FragColor.a *= fade;
                         if (gl_FragColor.a <= 0.02) discard;`
                    );
                };
                child.material = terrainMat;
                skipMerge.add(child);   // its shader feathers against local coords
                child.receiveShadow = true;
            } else if (matName.includes('water') || childName.includes('water')) {
                // If it's the raw 4-vertex rectangular water plane (Plane.003_water_0), hide it permanently
                if (child.geometry && child.geometry.attributes.position && child.geometry.attributes.position.count <= 4) {
                    child.visible = false;
                    return;
                }
                // Cascading waterfalls down the rock mound (Plane.120_water_0, Plane.121_water_0)
                const cascadeMat = new THREE.MeshStandardMaterial({
                    color: 0x4aa697,
                    roughness: 0.22,
                    metalness: 0.08,
                    transparent: true,
                    opacity: 0.85,
                    depthWrite: false,
                    side: THREE.DoubleSide
                });
                cascadeMat.onBeforeCompile = (shader) => {
                    shader.uniforms.uTime = pondWaterUniforms.uTime;
                    shader.vertexShader = 'varying vec3 vWaterW;\n' + shader.vertexShader.replace(
                        '#include <worldpos_vertex>',
                        '#include <worldpos_vertex>\n vWaterW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
                    );
                    shader.fragmentShader = 'varying vec3 vWaterW;\nuniform float uTime;\n' + shader.fragmentShader.replace(
                        '#include <opaque_fragment>',
                        `// Luminous waterfall floor so cascading water never goes black in shadow
                         outgoingLight = max(outgoingLight, vec3(0.06, 0.13, 0.12));
                         float foam = sin(vWaterW.y * 14.0 - uTime * 3.5) * 0.5 + 0.5;
                         outgoingLight += vec3(0.06, 0.10, 0.09) * foam * 0.5;
                         #include <opaque_fragment>`
                    );
                };
                child.material = cascadeMat;
                child.receiveShadow = true;
                child.renderOrder = 3;
                waterMeshList.push(child);
            } else if (matName.includes('riple') || childName.includes('riple')) {
                // Removed outright. These are baked light-glint cards from the
                // original scan -- flat quads whose greyscale+alpha texture is
                // meant to read as a specular sheen on water. In this scene
                // they render as a hard pale rectangle floating on the pond:
                // a "ghost reflection" with visible straight edges that no
                // amount of blending or clipping hides, because the artefact
                // IS the quad. The pond's own water material already carries
                // its highlights, so nothing is lost by dropping them.
                child.visible = false;
            } else {
                child.castShadow = !childName.includes('plane');
                child.receiveShadow = true;
                // ONE material covers two incompatible kinds of geometry here,
                // which is why a single setting could never be right:
                //   * Icosphere.* are solid scanned ROCKS. Their 2048 atlas is
                //     RGBA with ~16.5% near-zero alpha, but that is chart
                //     PADDING, not a cutout mask -- alpha-testing them
                //     discarded every texel sampling near a chart boundary and
                //     shattered the rocks into floating shards.
                //   * Plane.* are flat VEGETATION cards whose alpha genuinely
                //     is their silhouette -- drawn opaque they become solid
                //     black rectangles.
                // So split into exactly two shared variants, keyed on geometry
                // rather than on the material's own (misleading) alphaMode.
                // Two clones, not one per mesh: hundreds of unique materials
                // would defeat mergeStaticByMaterial and the draw-call budget.
                // Baked light-reflection cards: flat quads lying HORIZONTAL on
                // the water, whose texture is a pale specular smear. They read
                // as a ghost white rectangle floating on the pond. Vegetation
                // cards are flat too, but they STAND UP, so world-space
                // orientation separates them cleanly where names cannot --
                // every flat quad in this asset is called Plane.something.
                child.updateWorldMatrix(true, false);
                child.geometry.computeBoundingBox();
                const gb = child.geometry.boundingBox;
                let wyMin = Infinity, wyMax = -Infinity, wxz = 0;
                const corner = new THREE.Vector3();
                for (const cx of [gb.min.x, gb.max.x]) {
                    for (const cy of [gb.min.y, gb.max.y]) {
                        for (const cz of [gb.min.z, gb.max.z]) {
                            corner.set(cx, cy, cz).applyMatrix4(child.matrixWorld);
                            wyMin = Math.min(wyMin, corner.y);
                            wyMax = Math.max(wyMax, corner.y);
                            wxz = Math.max(wxz, Math.abs(corner.x), Math.abs(corner.z));
                        }
                    }
                }
                const vertCount = child.geometry.attributes.position.count;
                if (vertCount <= 8 && (wyMax - wyMin) < 0.05) {
                    child.visible = false;   // horizontal glint card
                    return;
                }

                const isCard = childName.startsWith('plane');
                if (isCard) {
                    if (!pondCardMat) {
                        pondCardMat = mat.clone();
                        pondCardMat.alphaTest = 0.35;
                        pondCardMat.transparent = false;
                        pondCardMat.depthWrite = true;
                        pondCardMat.side = THREE.DoubleSide;
                        pondCardMat.shadowSide = THREE.FrontSide;
                    }
                    child.material = pondCardMat;
                    child.renderOrder = 4;
                } else {
                    if (!pondSolidMat) {
                        pondSolidMat = mat.clone();
                        pondSolidMat.alphaTest = 0;
                        pondSolidMat.transparent = false;
                        pondSolidMat.depthWrite = true;
                        pondSolidMat.side = THREE.FrontSide;
                    }
                    child.material = pondSolidMat;
                    if (childName.startsWith('icosphere')) {
                        const baseName = childName.split('_')[0];
                        if (!rockGeomMap.has(baseName)) {
                            rockGeomMap.set(baseName, child.geometry);
                        }
                    }
                }
            }
        });
    } else {
        model = createFallbackPond();
    }

    group.position.copy(GARDEN_POINTS.POND);
    group.rotation.y = POND_ROT_Y;   // 2.35 rad (135 deg: pond faces southeast into the garden, high cliff sits against corner)
    if (model) group.add(model);

    // Sloping Stone Structure behind the high rock wall
    // Conceals the cut-off backside and steps down naturally into the grassy hillside
    const g04 = rockGeomMap.get('icosphere.004') || rockGeomMap.get('icosphere');
    const g10 = rockGeomMap.get('icosphere.010') || g04;
    const g12 = rockGeomMap.get('icosphere.012') || g04;
    const g31 = rockGeomMap.get('icosphere.031') || g04;

    if (g04 && pondSolidMat) {
        const slopeDefs = [
            // Tier 1: Capping the raw high cut-off cliff (Y: 1.6 to 2.1m)
            { geo: g12, pos: [9.2, 2.05, 2.8], scale: [2.3, 2.0, 2.3], rot: [0.2, 0.5, -0.1] },
            { geo: g04, pos: [8.8, 1.85, 0.6], scale: [2.4, 2.1, 2.4], rot: [-0.1, -0.4, 0.2] },
            { geo: g10, pos: [9.0, 1.60, -1.6], scale: [2.1, 1.8, 2.1], rot: [0.3, -0.8, 0.1] },
            // Tier 2: Mid slope stepping down (Y: 0.9 to 1.3m)
            { geo: g31, pos: [11.2, 1.25, 3.2], scale: [2.5, 1.9, 2.5], rot: [-0.2, 0.9, 0.3] },
            { geo: g12, pos: [10.9, 1.10, 0.8], scale: [2.6, 2.0, 2.6], rot: [0.1, 0.3, -0.2] },
            { geo: g04, pos: [10.7, 0.85, -1.3], scale: [2.3, 1.7, 2.3], rot: [-0.3, -0.6, 0.2] },
            // Tier 3: Base slope anchoring into turf (Y: 0.2 to 0.45m)
            { geo: g10, pos: [13.0, 0.42, 2.6], scale: [2.6, 1.6, 2.6], rot: [0.2, 0.4, 0.1] },
            { geo: g04, pos: [12.7, 0.28, 0.5], scale: [2.8, 1.5, 2.8], rot: [-0.1, 0.7, -0.2] },
            { geo: g31, pos: [12.4, 0.18, -1.1], scale: [2.4, 1.4, 2.4], rot: [0.1, -0.5, 0.3] },
        ];

        slopeDefs.forEach((d, idx) => {
            const rock = new THREE.Mesh(d.geo, pondSolidMat);
            rock.name = `PondSlopeRock_${idx}`;
            rock.position.set(d.pos[0], d.pos[1], d.pos[2]);
            rock.scale.set(d.scale[0], d.scale[1], d.scale[2]);
            rock.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
            rock.castShadow = true;
            rock.receiveShadow = true;
            group.add(rock);
        });
    }

    // Organic shoreline-fitted water surface matching the single pond basin
    function createPondWaterSurface() {
        const rings = 20;
        const segments = 64;
        const geo = new THREE.BufferGeometry();
        const positions = [];
        const uvs = [];
        const indices = [];

        const centerX = 0.40;
        const centerZ = 0.77;
        const waterY = -0.42;

        function basinRadius(theta) {
            return 6.3 + 1.25 * Math.cos(theta - 2.8) + 0.45 * Math.sin(2.0 * theta);
        }

        // Center vertex
        positions.push(centerX, waterY, centerZ);
        uvs.push(0.5, 0.5);

        for (let r = 1; r <= rings; r++) {
            const frac = r / rings;
            for (let s = 0; s < segments; s++) {
                const theta = (s / segments) * Math.PI * 2;
                const maxR = basinRadius(theta);
                const rad = maxR * frac;
                const x = centerX + Math.cos(theta) * rad;
                const z = centerZ + Math.sin(theta) * rad;
                positions.push(x, waterY, z);
                uvs.push(0.5 + (x - centerX) / 16.0, 0.5 + (z - centerZ) / 16.0);
            }
        }

        for (let s = 0; s < segments; s++) {
            const nextS = (s + 1) % segments;
            indices.push(0, 1 + s, 1 + nextS);
        }

        for (let r = 1; r < rings; r++) {
            const curRow = 1 + (r - 1) * segments;
            const nextRow = 1 + r * segments;
            for (let s = 0; s < segments; s++) {
                const nextS = (s + 1) % segments;
                const i0 = curRow + s;
                const i1 = curRow + nextS;
                const o0 = nextRow + s;
                const o1 = nextRow + nextS;
                indices.push(i0, o0, i1);
                indices.push(i1, o0, o1);
            }
        }

        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        return geo;
    }

    surfaceWaterMat = new THREE.MeshStandardMaterial({
        color: 0x164c42,       // Deep natural wetland pond emerald
        roughness: 0.16,       // Smooth reflective pond surface
        metalness: 0.08,
        envMapIntensity: 1.2,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,     // Allows submerged rocks and lilies to be visible, zero depth fighting
        depthTest: true,
        side: THREE.DoubleSide
    });

    surfaceWaterMat.onBeforeCompile = (shader) => {
        shader.uniforms.uPondC = pondWaterUniforms.uPondC;
        shader.uniforms.uTime = pondWaterUniforms.uTime;
        shader.vertexShader = 'varying vec3 vWaterW;\nvarying vec3 vWaterLocal;\n' + shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            '#include <worldpos_vertex>\n vWaterLocal = position;\n vWaterW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        );
        shader.fragmentShader = 'varying vec3 vWaterW;\nvarying vec3 vWaterLocal;\nuniform vec2 uPondC;\nuniform float uTime;\n' + shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            `// Minimum luminous floor so water never turns into a black hole in shadow or night
             vec3 waterFloor = vec3(0.045, 0.095, 0.088);
             outgoingLight = max(outgoingLight, waterFloor);

             // Gentle natural water drift and surface shimmer
             float wave1 = sin(vWaterW.x * 2.2 + vWaterW.z * 1.8 + uTime * 0.7);
             float wave2 = cos(vWaterW.x * 1.5 - vWaterW.z * 2.1 + uTime * 0.5);
             float ripple = (wave1 + wave2) * 0.5;
             outgoingLight += vec3(0.015, 0.028, 0.024) * (ripple * 0.5 + 0.5);

             // Soft sky fresnel reflectance at grazing camera angles
             vec3 viewDir = normalize(cameraPosition - vWaterW);
             float fresnel = pow(1.0 - max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0), 3.5);
             outgoingLight += vec3(0.05, 0.11, 0.13) * fresnel * 0.45;
             #include <opaque_fragment>

             // Soft shoreline feathering so the water smoothly blends into the bank with zero hard edge
             float dx = vWaterLocal.x - 0.40;
             float dz = vWaterLocal.z - 0.77;
             float localDist = length(vec2(dx, dz));
             float localAngle = atan(dz, dx);
             float maxR = 6.3 + 1.25 * cos(localAngle - 2.8) + 0.45 * sin(2.0 * localAngle);
             float edgeFade = 1.0 - smoothstep(maxR * 0.90, maxR, localDist);
             gl_FragColor.a *= edgeFade;
             if (gl_FragColor.a <= 0.005) discard;`
        );
    };

    const pondWaterMesh = new THREE.Mesh(createPondWaterSurface(), surfaceWaterMat);
    pondWaterMesh.name = 'PondWaterSurface';
    pondWaterMesh.receiveShadow = true;
    pondWaterMesh.renderOrder = 2;
    group.add(pondWaterMesh);
    waterMeshList.push(pondWaterMesh);
    skipMerge.add(pondWaterMesh);

    // Hitbox for hover/click (local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(12.5, 12.5, 5.0, 24, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 2.5, 0);
    group.add(hitbox);

    // `time` is real accumulated seconds. It used to be a per-frame counter, so
    // the ripple ran at whatever the display refresh rate happened to be -- and
    // slowly enough (one cycle per ~48s) to be invisible either way.
    //
    // Opacity alone never read as water. Scrolling the ripple map is what
    // actually moves: two of them, at detuned rates and opposed directions, so
    // the surface drifts rather than sliding as one sheet.
    waterMeshList.forEach((m) => {
        const map = m.material && m.material.map;
        if (map) {
            map.wrapS = map.wrapT = THREE.RepeatWrapping;   // offsetting a clamped map smears its edge pixels
            map.needsUpdate = true;
        }
    });

    // Safe now, and only now: every mesh this function needed to find by name
    // has already been found and re-materialled.
    if (gltf && gltf.scene) {
        waterMeshList.forEach((m) => skipMerge.add(m));
        const stats = mergeStaticByMaterial(group, skipMerge);
        console.info(`[garden] single pond merged ${stats.removed} meshes into ${stats.merged} (kept ${stats.remaining} unmerged)`);
    }

    const update = (time) => {
        if (pondWaterUniforms) pondWaterUniforms.uTime.value = time;
        for (let i = 0; i < waterMeshList.length; i++) {
            const m = waterMeshList[i];
            if (!m.material) continue;
            if (m.material.opacity !== undefined) {
                const s = 0.88 + Math.sin(time * 0.85 + i * 1.7) * 0.045;
                m.material.opacity = THREE.MathUtils.clamp(s, 0.82, 0.95);
            }
            const map = m.material.map;
            if (map) {
                const dir = i % 2 ? -1 : 1;
                map.offset.x = (time * 0.013 * dir) % 1;
                map.offset.y = (time * 0.021) % 1;
            }
        }
    };

    const interactiveData = {
        id: 'pond',
        title: 'Lotus Pond & Waterfall',
        meta: 'Cascading Water Falls · Click to visit',
        cameraTarget: { pos: new THREE.Vector3(-11.0, 6.8, -8.0), lookAt: new THREE.Vector3(-23.0, 1.8, -19.0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        },
        waterMaterial: surfaceWaterMat,
        update
    };
}

// ---------------------------------------------------------------------------
// Background trees -- banyan and mango, ringed OUTSIDE the path loop
// ---------------------------------------------------------------------------
// Deliberately spread around the ring rather than clustered: at a 50 degree
// FOV the camera sees roughly a quarter of the ring at once, so frustum
// culling keeps most of them off the GPU at any moment. Angles dodge the four
// landmarks (pond ~220 deg, gazebo ~39 deg, maple ~318 deg) so nothing
// overlaps or hides them, and every radius sits beyond the path's outer
// wobble (~19.5) and inside the ground's edge fade (starts at 38).
//
// Cost, audited and then reduced with the project's documented gltf-transform
// pass: banyan 12.6MB/111k tris -> 6.8MB/52.6k, mango 15.7MB/130k tris and a
// brutal 49.3MB of texture VRAM (two 2048 maps) -> 5.6MB/90.8k and 17.3MB.
// One of each. Heights set the garden's pecking order deliberately: banyan is
// the tallest thing here, mango overtops the maple (13.8), and the gulmohar
// (11.2) stays the centrepiece by position rather than by size.
const BACKGROUND_TREES = [
    {
        kind: 'banyan', deg: 152, r: 27.0, height: 17.5, rotY: 0.9,
        id: 'banyan', title: 'Chinese Banyan', meta: 'Ficus microcarpa · Click to visit'
    },
    {
        kind: 'mango', deg: 252, r: 25.5, height: 15.5, rotY: 2.4,
        id: 'mango', title: 'Mango Tree', meta: 'Mangifera indica · Click to visit'
    }
];

function setupBackgroundTrees(banyanGltf, mangoGltf, interactives) {
    const group = new THREE.Group();
    group.name = 'BackgroundTrees';
    const budget = QUALITY.backgroundTrees;
    if (budget <= 0) return group;

    const sources = { banyan: banyanGltf, mango: mangoGltf };
    // One prepared prototype per species, cloned per placement: clones share
    // the same geometry and texture buffers on the GPU, so six trees cost six
    // draw sets but only two trees' worth of memory.
    const prepared = {};
    Object.entries(sources).forEach(([kind, gltf]) => {
        if (!gltf || !gltf.scene) return;
        const proto = gltf.scene;
        proto.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const wantsWind = isFoliageForWind(child, child.material);
            enhanceFoliageMaterial(child.material, child, 0.35);
            // Gentler than the centrepiece gulmohar: these read at distance,
            // where a large sway is what makes background foliage look like
            // it is boiling rather than breathing.
            if (wantsWind) injectFoliageWind(child, child.material, { swayFraction: 0.032, speedMult: 0.7 });
        });
        const box = new THREE.Box3().setFromObject(proto);
        prepared[kind] = { proto, box };
    });

    BACKGROUND_TREES.slice(0, budget).forEach((spec, i) => {
        const entry = prepared[spec.kind];
        if (!entry) return;
        const size = entry.box.getSize(new THREE.Vector3());
        const centre = entry.box.getCenter(new THREE.Vector3());
        const scaleFactor = spec.height / Math.max(size.y, 0.001);

        const model = entry.proto.clone(true);
        model.scale.setScalar(scaleFactor);
        // Sunk slightly so the root flare meets the lawn rather than perching
        // on it, matching how the maple is seated.
        // Just enough to close the contact seam, not enough to bury the
        // root flare -- only the maple, whose whole exposed root ball sits
        // proud of the soil, wants a deep sink.
        model.position.set(-centre.x * scaleFactor, -entry.box.min.y * scaleFactor - 0.08, -centre.z * scaleFactor);

        const holder = new THREE.Group();
        holder.name = `${spec.kind}_${i}`;
        const theta = THREE.MathUtils.degToRad(spec.deg);
        const wx = Math.cos(theta) * spec.r, wz = Math.sin(theta) * spec.r;
        holder.position.set(wx, 0, wz);
        holder.rotation.y = spec.rotY;
        holder.add(model);
        holder.add(createContactShadow(spec.height * 0.62));
        group.add(holder);

        // Hoverable and clickable, same machinery as the four original
        // landmarks: an invisible cylinder as the ray target, plus a camera
        // framing. Sized to the canopy rather than the trunk so the whole
        // tree is a target, and counter-rotated out of the holder's own
        // rotation so the framing stays in world space.
        const hitbox = new THREE.Mesh(
            new THREE.CylinderGeometry(spec.height * 0.42, spec.height * 0.42, spec.height, 10, 1, true),
            new THREE.MeshBasicMaterial({ visible: false })
        );
        hitbox.position.set(0, spec.height * 0.5, 0);
        holder.add(hitbox);

        // Stand off toward the garden centre so the camera looks outward at
        // the tree with the rest of the garden behind it, never through it.
        const inward = new THREE.Vector3(-wx, 0, -wz).normalize();
        const dist = spec.height * 1.15;
        interactives.push({
            object: hitbox,
            targetGroup: holder,
            data: {
                id: spec.id,
                title: spec.title,
                meta: spec.meta,
                cameraTarget: {
                    pos: new THREE.Vector3(wx, 0, wz)
                        .addScaledVector(inward, dist)
                        .setY(spec.height * 0.52),
                    lookAt: new THREE.Vector3(wx, spec.height * 0.42, wz)
                }
            }
        });
    });

    return group;
}

// ---------------------------------------------------------------------------
// 4. Maple Tree Setup (Top-Right, Firmly Rooted on Ground)
// ---------------------------------------------------------------------------
function setupMaple(gltf) {
    // Mature Maple tree (~14m tall, firmly rooted into soil)
    const targetHeight = 13.8;
    const group = new THREE.Group();
    group.name = 'MapleTree';

    let model;
    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scaleFactor = targetHeight / Math.max(size.y, 0.001);

        // Sunk enough to bury the root flare, not the whole contact seam -- a
        // contact-shadow decal now covers the rest (createContactShadow, below),
        // so this no longer has to do all the work on its own. -0.55 (down from
        // -1.25) left the whole gnarled root tangle sitting exposed on top of
        // the dirt rather than growing out of it; -0.9 is the middle ground.
        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -box.min.y * scaleFactor - 1.35, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            child.castShadow = true;
            child.receiveShadow = true;
            // The maple's canopy material is literally named `Material_Mat` --
            // no leafy word anywhere in this export -- so it is caught only by
            // the alpha-blend branch of the gate, which is exactly why this
            // has to run before enhanceFoliageMaterial converts BLEND away.
            const wantsWind = isFoliageForWind(child, child.material);
            enhanceFoliageMaterial(child.material, child, 0.35);
            // Lower amplitude and speed than the gulmohar: this canopy is one
            // large merged mesh rather than separate per-leaf-type meshes, so
            // its own bounding box already spans nearly the whole tree --
            // the same swayFraction here would read as the canopy shredding
            // rather than swaying.
            if (wantsWind) injectFoliageWind(child, child.material, { swayFraction: 0.040, speedMult: 0.7 });   // was 0.032/0.85 -- same over-sway complaint
        });
    } else {
        model = createFallbackTree(0xd85b24, 13.8);
    }

    group.position.copy(GARDEN_POINTS.MAPLE);
    group.rotation.y = 1.2;
    group.add(model);
    group.add(createContactShadow(7.5));

    // Hitbox for hover/click (local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(5.2, 5.2, 14.0, 10, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 5.5, 0);
    group.add(hitbox);

    const interactiveData = {
        id: 'maple',
        title: 'Japanese Maple',
        meta: 'Autumn Crimson Canopy · Click to visit',
        cameraTarget: { pos: new THREE.Vector3(13.0, 6.8, -10.0), lookAt: new THREE.Vector3(23.0, 4.0, -21.0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        }
    };
}

// ---------------------------------------------------------------------------
// 5. Floor Detailing with `floor_leaves.glb` Everywhere (No Circles/Discs)
// ---------------------------------------------------------------------------
function setupFloorEverywhere(leavesGltf) {
    const root = new THREE.Group();
    root.name = 'ScatteredLeavesEverywhere';

    let groundTexture = null;
    let groundNormal = null;

    if (!leavesGltf || !leavesGltf.scene) return { group: root, groundTexture, groundNormal };

    const leafMeshes = [];
    const microPlants = [];

    leavesGltf.scene.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mat = child.material;
        const name = (child.name || '').toLowerCase();
        const matName = (mat.name || '').toLowerCase();

        if (matName.includes('ground_close') || name.includes('ground_close')) {
            if (mat.map && !groundTexture) groundTexture = mat.map;
            if (mat.normalMap && !groundNormal) groundNormal = mat.normalMap;
        } else if (name.startsWith('s_list_') && !name.includes('forest')) {
            if (child.geometry && mat.map) {
                const geom = child.geometry.clone();
                geom.center();
                geom.computeBoundingBox();
                const b = geom.boundingBox;
                const maxDim = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
                if (maxDim > 0) {
                    // Natural fallen leaf size (~0.35 meters)
                    const scale = 0.35 / maxDim;
                    geom.scale(scale, scale, scale);
                    // FrontSide, not DoubleSide: these lie flat on the ground
                    // and tilt only a few degrees, and OrbitControls'
                    // maxPolarAngle keeps the camera above the horizon, so
                    // their undersides are never visible. This is the single
                    // biggest fill saving in the scene -- ~450k alpha-tested
                    // triangles were being shaded twice over.
                    mat.side = THREE.FrontSide;
                    mat.shadowSide = THREE.FrontSide;
                    mat.alphaTest = 0.35;
                    mat.transparent = false;
                    mat.depthWrite = true;
                    mat.polygonOffset = true;
                    mat.polygonOffsetFactor = -2;
                    mat.polygonOffsetUnits = -2;
                    leafMeshes.push({ geometry: geom, material: mat });
                }
            }
        } else if ((name.startsWith('r1') || name.startsWith('r2') || name.startsWith('r3') || name.startsWith('r4')) && !name.includes('forest')) {
            if (child.geometry && mat.map) {
                const geom = child.geometry.clone();
                geom.center();
                geom.computeBoundingBox();
                const b = geom.boundingBox;
                const maxDim = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
                if (maxDim > 0) {
                    // Riparian ground cluster size ~0.45 meters
                    const scale = 0.45 / maxDim;
                    geom.scale(scale, scale, scale);
                    mat.side = THREE.DoubleSide;
                    mat.alphaTest = 0.35;
                    mat.transparent = false;
                    mat.depthWrite = true;
                    microPlants.push({ geometry: geom, material: mat });
                }
            }
        }
    });

    // 1. Scatter individual realistic leaves across the entire garden floor
    if (leafMeshes.length > 0) {
        // The most expensive object in the scene, by a wide margin: each leaf
        // is ~1,250 triangles for something 0.35m across lying flat, and they
        // blanket the whole ground. 8 leaf types * 45 = 360 leaves = ~450k
        // alpha-tested triangles at the top tier. Tiered accordingly.
        const countPerMesh = QUALITY.floorLeafCount;
        const dummy = new THREE.Object3D();

        leafMeshes.forEach(({ geometry, material }) => {
            const instanced = new THREE.InstancedMesh(geometry, material, countPerMesh);
            instanced.receiveShadow = true;
            // Base count for the adaptive quality scaler: it lowers
            // InstancedMesh.count (a draw range, free) when frames slow.
            instanced.userData.baseCount = instanced.count;
            instanced.castShadow = false;

            for (let i = 0; i < countPerMesh; i++) {
                let x, z;
                // Distribute leaves with organic natural drifts under canopies + blanket across garden
                const roll = Math.random();
                if (roll < 0.50) {
                    // Wide garden ground coverage
                    const r = Math.sqrt(Math.random()) * 38.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                } else if (roll < 0.78) {
                    // Centerpiece Gulmohar canopy drift
                    const r = Math.sqrt(Math.random()) * 14.5;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                } else {
                    // Japanese Maple canopy drift (autumn crimson leaf drop)
                    const r = Math.sqrt(Math.random()) * 12.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = GARDEN_POINTS.MAPLE.x + Math.cos(theta) * r;
                    z = GARDEN_POINTS.MAPLE.z + Math.sin(theta) * r;
                }

                // Skip scattering fallen ground leaves inside the sunken pond basin
                if (Math.hypot(x - (-23.0), z - (-19.0)) < 6.8) {
                    dummy.position.set(0, -999, 0);
                    dummy.scale.set(0, 0, 0);
                    dummy.updateMatrix();
                    instanced.setMatrixAt(i, dummy.matrix);
                    continue;
                }

                dummy.position.set(x, groundHeightAt(x, z) + 0.022 + (i % 8) * 0.002, z);
                dummy.rotation.set(
                    (Math.random() - 0.5) * 0.16,
                    Math.random() * Math.PI * 2,
                    (Math.random() - 0.5) * 0.16
                );
                const s = 0.75 + Math.random() * 0.45;
                dummy.scale.set(s, s, s);
                dummy.updateMatrix();

                instanced.setMatrixAt(i, dummy.matrix);
            }
            instanced.instanceMatrix.needsUpdate = true;
            root.add(instanced);
        });
    }

    // 2. Scatter micro plants & lush riparian foliage to blend pond edges and garden spaces
    if (microPlants.length > 0) {
        // Was 16 with an `i < 24` / `i < 32` branch split -- at 16 total instances
        // the first branch is always true, so every plant landed in the pond ring
        // and the maple/centerpiece branches were dead code. Rolling a fraction
        // instead of comparing the loop index is what actually reaches all three.
        const countPerPlant = QUALITY.microPlantCount;
        const dummy = new THREE.Object3D();

        microPlants.forEach(({ geometry, material }) => {
            const instanced = new THREE.InstancedMesh(geometry, material, countPerPlant);
            instanced.receiveShadow = true;
            // Base count for the adaptive quality scaler: it lowers
            // InstancedMesh.count (a draw range, free) when frames slow.
            instanced.userData.baseCount = instanced.count;
            instanced.castShadow = false;

            for (let i = 0; i < countPerPlant; i++) {
                let x, z;
                const roll = Math.random();
                if (roll < 0.40) {
                    // Ring around sunken pond bank to merge rocks and garden lawn
                    const r = 7.0 + Math.random() * 2.5;
                    const theta = Math.random() * Math.PI * 2;
                    x = GARDEN_POINTS.POND.x + Math.cos(theta) * r;
                    z = GARDEN_POINTS.POND.z + Math.sin(theta) * r;
                } else if (roll < 0.70) {
                    // Near Japanese maple
                    const r = 3.0 + Math.random() * 5.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = GARDEN_POINTS.MAPLE.x + Math.cos(theta) * r;
                    z = GARDEN_POINTS.MAPLE.z + Math.sin(theta) * r;
                } else {
                    // Centerpiece & gazebo transitions
                    const r = 4.0 + Math.random() * 8.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                }

                dummy.position.set(x, groundHeightAt(x, z) + 0.025, z);
                dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
                const s = 0.8 + Math.random() * 0.6;
                dummy.scale.set(s, s, s);
                dummy.updateMatrix();

                instanced.setMatrixAt(i, dummy.matrix);
            }
            instanced.instanceMatrix.needsUpdate = true;
            root.add(instanced);
        });
    }

    return { group: root, groundTexture, groundNormal };
}

// ---------------------------------------------------------------------------
// 6b. Flower beds along the path's outer shoulder
// ---------------------------------------------------------------------------
// Two InstancedMeshes -- foliage and blossoms -- both sampled from the SAME
// curve formula as createGardenPathway (PATH_BASE_R / PATH_WAVE_AMP), so a
// bed can never drift out of alignment with the path it borders. Placement
// hugs the outer edge and is widest at the clover's four outward lobes
// (where sin(theta*4) peaks), which is what reads as planted rather than a
// uniform painted verge.
const BED_FOLIAGE_COLORS = [
    new THREE.Color(0x4a5c34), new THREE.Color(0x5c7040),
    new THREE.Color(0x3c4c2a), new THREE.Color(0x6b7d4a)
];
const BED_BLOSSOM_COLORS = [
    new THREE.Color(0xd9502f), new THREE.Color(0xb03d22),   // gulmohar red
    new THREE.Color(0xc98a2e), new THREE.Color(0xe3b65c)    // maple gold
];

/**
 * Wires a per-instance colour into an InstancedMesh's material through a
 * hand-rolled attribute, rather than `InstancedMesh.setColorAt()`.
 *
 * setColorAt is supposed to be sufficient on its own -- Three sets the
 * USE_INSTANCING_COLOR shader define from `object.instanceColor !== null` --
 * but measured on this build (see src/scene/grass.js for the full
 * diagnosis), that define never reached the compiled shader even with a
 * real, populated instanceColor attribute, so every instance rendered at
 * vColor's uninitialised default: black. Reusing the same manual wiring
 * here rather than rediscovering the bug a second time.
 */
function wireInstancedColor(mesh, colorArray) {
    mesh.geometry.setAttribute('aInstColor', new THREE.InstancedBufferAttribute(colorArray, 3));
    mesh.material.onBeforeCompile = (shader) => {
        shader.vertexShader = 'attribute vec3 aInstColor;\nvarying vec3 vInstColor;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nvInstColor = aInstColor;'
        );
        shader.fragmentShader = 'varying vec3 vInstColor;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            '#include <color_fragment>\ndiffuseColor.rgb *= vInstColor;'
        );
    };
    mesh.material.needsUpdate = true;
}

function createFlowerBeds() {
    const group = new THREE.Group();
    group.name = 'FlowerBeds';

    const foliageGeo = new THREE.IcosahedronGeometry(0.16, 0);   // 20 tris, cheap by design
    const blossomGeo = new THREE.IcosahedronGeometry(0.075, 0);

    const foliageMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 });
    const blossomMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.0 });

    const FOLIAGE_COUNT = 1400;
    const BLOSSOM_COUNT = 800;
    const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, FOLIAGE_COUNT);
    const blossoms = new THREE.InstancedMesh(blossomGeo, blossomMat, BLOSSOM_COUNT);
    [foliage, blossoms].forEach((m) => { m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false; });
    wireInstancedColor(foliage, new Float32Array(FOLIAGE_COUNT * 3));
    wireInstancedColor(blossoms, new Float32Array(BLOSSOM_COUNT * 3));

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    const place = (mesh, count, colors, depthRange, radiusJitter) => {
        const colorArray = mesh.geometry.attributes.aInstColor.array;
        for (let i = 0; i < count; i++) {
            const theta = Math.random() * Math.PI * 2;
            // Widest at the clover's outward points: bias depth by how far
            // sin(theta*4) has swung positive, so the lobes read as fuller beds.
            const lobe = Math.max(0, Math.sin(theta * 4));
            const pathR = pathRadiusAt(theta);
            const edge = pathR + PATH_WIDTH * 0.5 + 0.25;
            const depth = depthRange[0] + Math.random() * (depthRange[1] + lobe * 0.9 - depthRange[0]);
            const r = edge + depth + (Math.random() - 0.5) * radiusJitter;
            const x = Math.cos(theta) * r, z = Math.sin(theta) * r;

            // Not in the bed if it isn't clear (or reuse a safe fallback spot
            // rather than leaving a zero-matrix instance, which draws a
            // degenerate triangle at the origin).
            const clear = isGroundClear(x, z, 0.1);
            const px = clear ? x : 0, pz = clear ? z : 0;
            const s = clear ? (0.7 + Math.random() * 0.7) : 0;

            dummy.position.set(px, groundHeightAt(px, pz) + 0.05 + Math.random() * 0.05, pz);
            dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
            dummy.scale.set(s, s, s);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);

            color.copy(colors[Math.floor(Math.random() * colors.length)])
                .offsetHSL((Math.random() - 0.5) * 0.03, (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.06);
            colorArray[i * 3] = color.r; colorArray[i * 3 + 1] = color.g; colorArray[i * 3 + 2] = color.b;
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.aInstColor.needsUpdate = true;
    };

    place(foliage, FOLIAGE_COUNT, BED_FOLIAGE_COLORS, [0.1, 0.9], 0.5);
    place(blossoms, BLOSSOM_COUNT, BED_BLOSSOM_COLORS, [0.15, 0.75], 0.6);

    group.add(foliage, blossoms);
    return group;
}

// ---------------------------------------------------------------------------
// 6. Curving Garden Pathway (Centered at Origin 0,0,0)
// ---------------------------------------------------------------------------
function createGardenPathway() {
    const group = new THREE.Group();
    group.name = 'GardenPathway';

    const curvePoints = [];
    const segments = 160;

    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const r = pathRadiusAt(theta);
        const px = Math.cos(theta) * r, pz = Math.sin(theta) * r;
        // Rides the ground height field, or the pond berm swallows the
        // stretch of path that passes closest to the water.
        curvePoints.push(new THREE.Vector3(px, groundHeightAt(px, pz) + 0.018, pz));
    }

    const curve = new THREE.CatmullRomCurve3(curvePoints, true);
    const pathWidth = 2.4;

    const pathSegments = 240;
    const vertices = [];
    const uvs = [];
    const indices = [];
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i <= pathSegments; i++) {
        const t = i / pathSegments;
        const point = curve.getPointAt(t);
        const tangent = curve.getTangentAt(t).normalize();
        const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();

        const pLeft = point.clone().addScaledVector(normal, -pathWidth * 0.5);
        const pRight = point.clone().addScaledVector(normal, pathWidth * 0.5);

        // The curve already carries the ground height; flattening both rails
        // to a constant y here is what left the path hovering over any relief
        // instead of lying on it.
        pLeft.y = point.y + 0.007;
        pRight.y = point.y + 0.007;

        vertices.push(pLeft.x, pLeft.y, pLeft.z);
        vertices.push(pRight.x, pRight.y, pRight.z);

        // Integer V repeat, so the tiling meets itself exactly where the loop
        // closes at t=0/1 instead of leaving a visible seam there. 26 tiles
        // over the loop keeps the stones near their authored aspect.
        uvs.push(0, t * 26);
        uvs.push(1, t * 26);

        if (i < pathSegments) {
            const i1 = i * 2;
            const i2 = i1 + 1;
            const i3 = (i + 1) * 2;
            const i4 = i3 + 1;
            indices.push(i1, i2, i3);
            indices.push(i2, i4, i3);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // Real stone-path photography, replacing a hand-drawn canvas of rounded
    // rectangles. Taken from stone_path_plane's diffuse and normal maps --
    // its geometry is just a flat 32-triangle plane, so there was nothing
    // worth keeping there; the maps are what carry the look, and the ribbon
    // below already follows the curve and the terrain. The source PNGs are
    // 7.8MB and 4.6MB; resized to 1024 JPEG they are 447KB and 367KB. The
    // specularGlossiness map is dropped -- Three removed that workflow, and
    // roughness/metalness covers it.
    const texLoader = new THREE.TextureLoader();
    const pathTex = texLoader.load(getAssetUrl('textures/path_diffuse.jpg'));
    const pathNormal = texLoader.load(getAssetUrl('textures/path_normal.jpg'));
    pathTex.colorSpace = THREE.SRGBColorSpace;
    [pathTex, pathNormal].forEach((t) => {
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        // The path is almost always seen at a grazing angle -- the worst case
        // for isotropic filtering, and the cheapest place anisotropy pays off.
        t.anisotropy = 8;
        t.repeat.set(1, 1);
    });

    const pathMat = new THREE.MeshStandardMaterial({
        map: pathTex,
        normalMap: pathNormal,
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughness: 0.92,
        metalness: 0.03,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });

    const pathMesh = new THREE.Mesh(geo, pathMat);
    pathMesh.receiveShadow = true;
    group.add(pathMesh);

    // No curb rails. There were two dark tube rails running the length of
    // both edges, which read as a hard drawn border rather than a path worn
    // into grass. The stone texture's own alpha-free edge, sitting slightly
    // proud via polygonOffset with grass scattered right up to it, is what
    // makes it read as seamless.

    return group;
}

// ---------------------------------------------------------------------------
// Procedural Fallbacks
// ---------------------------------------------------------------------------
function createFallbackTree(leafColor, height) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.7, height * 0.5, 12),
        new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.95 })
    );
    trunk.position.y = height * 0.25;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    g.add(trunk);

    const canopyMat = new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.85 });
    const blobs = [[0, height * 0.65, 0, 4.5], [2.2, height * 0.6, 1.5, 3.2], [-2.4, height * 0.62, -1.8, 3.0]];
    blobs.forEach(([x, y, z, r]) => {
        const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), canopyMat);
        b.position.set(x, y, z);
        b.castShadow = true;
        b.receiveShadow = true;
        g.add(b);
    });
    return g;
}

function createFallbackGazebo() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(3.0, 3.2, 0.3, 8),
        new THREE.MeshStandardMaterial({ color: 0x8f887f })
    );
    base.position.y = 0.15;
    g.add(base);

    const roof = new THREE.Mesh(
        new THREE.ConeGeometry(3.4, 1.8, 8),
        new THREE.MeshStandardMaterial({ color: 0x7c4530, roughness: 0.8 })
    );
    roof.position.y = 3.6;
    roof.castShadow = true;
    g.add(roof);
    return g;
}

function createFallbackPond() {
    const g = new THREE.Group();
    const water = new THREE.Mesh(
        new THREE.CircleGeometry(7.0, 32),
        new THREE.MeshStandardMaterial({ color: 0x225566, roughness: 0.1, metalness: 0.2 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.02;
    g.add(water);
    return g;
}
