import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { getAssetUrl } from '../utils/paths.js';
import { isFoliageForWind, injectFoliageWind, createWindEnvelope, updateWindEnvelope } from './wind.js';
import { QUALITY } from '../quality.js';
import { POND_TERRAIN } from './pondTerrain.js';

// Garden layout coordinates:
// - Center: Gulmohar Tree (0, 0, 0)
// - Top-Left: Pond (-23, 0, -19)
// - Bottom-Right: Gazebo (+22, 0, +18)
export const GARDEN_POINTS = {
    GULMOHAR: new THREE.Vector3(0, 0, 0),
    POND: new THREE.Vector3(-23.0, 0, -19.0),
    GAZEBO: new THREE.Vector3(22.0, 0, 18.0)
};

// The banyan stands outside the path loop; its root core is excluded from
// grass here, and setupBackgroundTrees places it from the same numbers.
const BANYAN_DEG = 152, BANYAN_R = 32.0;
const BANYAN_XZ = {
    x: Math.cos(BANYAN_DEG * Math.PI / 180) * BANYAN_R,
    z: Math.sin(BANYAN_DEG * Math.PI / 180) * BANYAN_R
};

// The path loop's own shape (createGardenPathway, below) -- pulled to module
// scope so grass and flower beds can ask "is this point clear of the path"
// without re-typing the curve's formula, the way the ground shader used to
// re-type the pond's coordinates.
const PATH_BASE_R = 21.0;
const PATH_WIDTH = 2.4;
const GAZEBO_CLEAR_R = 5.2;

// How far above the waterline the bank must still be to be walkable. The
// banks rise about 0.3m per metre, so this keeps a walker roughly a third of
// a metre back from the water's edge rather than letting them stand in it.
const POND_WADE_MARGIN_M = 0.10;

/**
 * Whether this point is in the pond -- at or below the waterline, with a
 * little of the bank kept back too. Keyed on the baked terrain height rather
 * than a radius, so it follows the basin's real, irregular shoreline; a
 * circle would either leave part of the water walkable or fence off lawn.
 */
export function isInPond(x, z) {
    return groundHeightAt(x, z) < POND_WATER_Y + POND_WADE_MARGIN_M;
}

/**
 * Whether a point stands inside the pavilion. A painting in there is hung on
 * built architecture -- a post, a rail -- and architecture is the one thing in
 * this garden a canvas must never turn away from, so this is what paintings.js
 * asks before deciding whether a painting is allowed to billboard at all.
 */
export function insideGazebo(x, z, margin = 0) {
    return Math.hypot(x - GARDEN_POINTS.GAZEBO.x, z - GARDEN_POINTS.GAZEBO.z) < GAZEBO_CLEAR_R + margin;
}

function angDiff(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/**
 * Pathway width varying dynamically -- widens in front of the gazebo into an expansive entrance plaza.
 */
export function pathWidthAt(theta) {
    let w = PATH_WIDTH;
    // Gazebo plaza/terrace (deg 39.3° / 0.69 rad) - generous, wide paved entrance apron
    w += 2.6 * Math.exp(-Math.pow(angDiff(theta, 0.69) / 0.40, 2));
    return w;
}

/**
 * Organic, winding garden pathway loop routed outwards towards the tree trunks
 * and landmark features of the garden.
 */
function pathRadiusAt(theta) {
    let r = PATH_BASE_R;

    // 1. Open north-east lawn (deg 317.6° / 5.54 rad). Swept out 7.8m around
    // the maple's trunk while there was one; a gentle lobe keeps the S-curve
    // between the two inward meanders that flank it.
    r += 2.4 * Math.exp(-Math.pow(angDiff(theta, 5.54) / 0.44, 2));

    // 2. Gazebo (deg 39.3° / 0.69 rad) - sweeps outwards flush to the gazebo entrance steps
    r += 1.8 * Math.exp(-Math.pow(angDiff(theta, 0.69) / 0.46, 2));

    // 3. Banyan Tree (deg 152° / 2.65 rad, trunk at 32m). Dips INWARD around
    // it: the banyan's hanging-root pillars reach up to ~15m from its trunk,
    // and the path used to bulge outward straight through them. Placement was
    // solved against the measured root footprint -- this leaves ~1.8m of lawn
    // between the path's edge and the nearest root.
    r -= 5.0 * Math.exp(-Math.pow(angDiff(theta, 2.65) / 0.42, 2));

    // 4. Pond Shoreline (deg 219.6° / 3.84 rad) - skirts along the pond's near bank
    r -= 2.0 * Math.exp(-Math.pow(angDiff(theta, 3.84) / 0.35, 2));

    // 5. Mango Tree (deg 252° / 4.40 rad, trunk at 25.5m) - winds beside the trunk under canopy
    r += 1.1 * Math.exp(-Math.pow(angDiff(theta, 4.40) / 0.35, 2));

    // Inward meanders between groves for dynamic S-curves:
    r -= 2.8 * Math.exp(-Math.pow(angDiff(theta, 1.67) / 0.48, 2)); // Between Gazebo & Banyan (95°)
    r -= 2.2 * Math.exp(-Math.pow(angDiff(theta, 4.95) / 0.42, 2)); // Between Mango & the NE lawn (284°)
    r -= 2.6 * Math.exp(-Math.pow(angDiff(theta, 6.20) / 0.45, 2)); // Between the NE lawn & Gazebo (355°)

    // Multi-frequency sinusoidal waviness (winding, undulating meanders):
    r += Math.sin(theta * 3 + 0.6) * 1.8;
    r += Math.sin(theta * 6 - 0.9) * 1.2;
    r += Math.sin(theta * 9 + 1.4) * 0.55;
    r += Math.sin(theta * 14 - 0.7) * 0.25;

    return r;
}

// The pond is the basin from "Low Poly Tree Scene Free" (3d_Assets/NEW),
// baked to a height grid by scripts/bake-pond-terrain.py -- its Ground mesh
// only, none of that scene's trees or grass. It is a height field rather than
// a mesh because the lawn plane itself samples groundHeightAt(): the lawn,
// grass, leaves, walking and painting placement then all follow the real
// basin, with no second surface to seam or z-fight against. The water is a
// flat sheet at POND_WATER_Y; where it meets the basin is the shoreline.
const POND_ROT_Y = 2.35;         // faces the pond's long side into the garden
const _pondCos = Math.cos(POND_ROT_Y);
const _pondSin = Math.sin(POND_ROT_Y);

export const POND_WATER_Y = POND_TERRAIN.waterY;
export const POND_EXTENT = POND_TERRAIN.extent;
const POND_N = POND_TERRAIN.n;
const POND_HEIGHTS = (() => {
    const bin = atob(POND_TERRAIN.data);
    const mm = new Int16Array(bin.length / 2);
    for (let i = 0; i < mm.length; i++) {
        const lo = bin.charCodeAt(i * 2), hi = bin.charCodeAt(i * 2 + 1);
        const v = lo | (hi << 8);
        mm[i] = v > 32767 ? v - 65536 : v;
    }
    const h = new Float32Array(mm.length);
    for (let i = 0; i < mm.length; i++) h[i] = mm[i] / 1000;
    return h;
})();
const POND_STEP = (2 * POND_EXTENT) / (POND_N - 1);

/** Pond basin height at pond-local (lx, lz), bilinear; 0 outside the grid. */
function pondHeightLocal(lx, lz) {
    const fx = (lx + POND_EXTENT) / POND_STEP, fz = (lz + POND_EXTENT) / POND_STEP;
    if (fx < 0 || fz < 0 || fx >= POND_N - 1 || fz >= POND_N - 1) return 0;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = POND_HEIGHTS[i * POND_N + j], b = POND_HEIGHTS[(i + 1) * POND_N + j];
    const c = POND_HEIGHTS[i * POND_N + j + 1], d = POND_HEIGHTS[(i + 1) * POND_N + j + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

export function groundHeightAt(x, z) {
    const dx = x - GARDEN_POINTS.POND.x, dz = z - GARDEN_POINTS.POND.z;
    if (Math.abs(dx) > POND_EXTENT * 1.5 || Math.abs(dz) > POND_EXTENT * 1.5) return 0.0;
    // Into the pond's local frame -- the same one its group is rotated by.
    const lx = _pondCos * dx - _pondSin * dz;
    const lz = _pondSin * dx + _pondCos * dz;
    return pondHeightLocal(lx, lz);
}

/**
 * The basin heights as a texture, pond-local, for the water's shoreline fade
 * and depth tint. Built once, on first use (it needs no renderer).
 */
let _pondHeightTexture = null;
export function getPondHeightTexture() {
    if (_pondHeightTexture) return _pondHeightTexture;
    const data = new Uint16Array(POND_N * POND_N * 4);
    for (let j = 0; j < POND_N; j++) {
        for (let i = 0; i < POND_N; i++) {
            // DataTexture rows run along v (lz), columns along u (lx).
            const o = (j * POND_N + i) * 4;
            data[o] = THREE.DataUtils.toHalfFloat(POND_HEIGHTS[i * POND_N + j]);
            data[o + 3] = THREE.DataUtils.toHalfFloat(1);
        }
    }
    const tex = new THREE.DataTexture(data, POND_N, POND_N, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    _pondHeightTexture = tex;
    return tex;
}

/**
 * Ground validity for anything scattered across the lawn -- grass, flower
 * beds -- so pond, path and gazebo footprint are each defined exactly once.
 * `margin` widens every exclusion by the same amount, for things (like a
 * flower bed) that should keep a little more distance than grass does.
 */
export function isGroundClear(x, z, margin = 0) {
    // Keyed on height, not a radius, so it follows the pond's real shoreline:
    // lawn grows down the banks to just above the water. A margin keeps a
    // wider berth, as a height above the waterline (banks rise ~0.3m per m),
    // capped just below lawn level so a big margin can never exclude the
    // flat lawn itself -- only the basin.
    if (groundHeightAt(x, z) < Math.min(POND_WATER_Y + 0.06 + margin * 0.3, -0.03)) return false;
    if (Math.hypot(x - GARDEN_POINTS.GAZEBO.x, z - GARDEN_POINTS.GAZEBO.z) < GAZEBO_CLEAR_R + margin) return false;
    if (Math.hypot(x, z) < 1.1 + margin) return false; // gulmohar trunk: no blades through the bark
    if (Math.hypot(x - BANYAN_XZ.x, z - BANYAN_XZ.z) < 7.5 + margin) return false; // banyan trunk & dense root core
    if (Math.hypot(x - (-7.9), z - (-24.3)) < 2.0 + margin) return false; // Mango trunk
    const theta = Math.atan2(z, x);
    const pathR = pathRadiusAt(theta);
    const currentWidth = pathWidthAt(theta);
    if (Math.abs(Math.hypot(x, z) - pathR) < currentWidth * 0.5 + 0.35 + margin) return false;
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
        loadGLTF('models/floor_leaves.glb'),
        loadGLTF('models/grass_blades.glb'),
        loadGLTF('models/meadow_clumps.glb'),
        QUALITY.backgroundTrees > 0 ? loadGLTF('models/banyan.glb') : Promise.resolve(null),
        QUALITY.backgroundTrees > 0 ? loadGLTF('models/mango.glb') : Promise.resolve(null)
    ]).then(([gulmoharGltf, gazeboGltf, leavesGltf, grassBladesGltf, meadowClumpsGltf,
              banyanGltf, mangoGltf]) => {
        // 1. Gulmohar Centerpiece Tree (At 0,0,0)
        const gulmoharObj = setupGulmohar(gulmoharGltf);
        gardenGroup.add(gulmoharObj.model);
        interactives.push(gulmoharObj.interactive);

        // 2. Gazebo (Bottom-Right corner)
        const gazeboObj = setupGazebo(gazeboGltf);
        gardenGroup.add(gazeboObj.model);
        interactives.push(gazeboObj.interactive);

        // 3. Pond (Top-Left corner) -- no model to load: the basin is baked
        // into groundHeightAt, and the water is built here.
        const pondObj = setupPond();
        gardenGroup.add(pondObj.model);
        interactives.push(pondObj.interactive);
        if (pondObj.update) updateables.push(pondObj.update);

        // 4. Floor Detailing with floor_leaves.glb everywhere
        const floorResult = setupFloorEverywhere(leavesGltf);
        gardenGroup.add(floorResult.group);

        // 5. Curving Garden Path (centered at origin)
        const pathway = createGardenPathway();
        gardenGroup.add(pathway);

        // 6. Background trees, outside the path loop -- hoverable and
        // clickable like the three landmarks, so they push into `interactives`.
        gardenGroup.add(setupBackgroundTrees(banyanGltf, mangoGltf, interactives));

        const windEnv = createWindEnvelope();

        return {
            group: gardenGroup,
            interactives,
            grassBlades: grassBladesGltf,
            meadowClumps: meadowClumpsGltf,
            groundTexture: floorResult.groundTexture,
            groundNormal: floorResult.groundNormal,
            update: (time, delta, lightCtx) => {
                updateWindEnvelope(windEnv, delta, time);
                for (let i = 0; i < updateables.length; i++) {
                    updateables[i](time, delta, lightCtx);
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

/**
 * Canopy sky occlusion for a tree's wood: sky fill (hemisphere, ambient,
 * environment) fades toward the ground, where the canopy hides most of the
 * sky. Direct sun is untouched -- the shadow map owns that.
 *
 * Without it the fill lit a trunk's base and a banyan's root curtain as
 * brightly as open lawn, so under a 26m canopy the roots read as standing
 * outside its shade. Height and strength are uniforms, so every tree shares
 * one compiled variant per underlying material program.
 *
 * @param {THREE.Material} material
 * @param {number} height    world height (m) at which the sky is fully open
 * @param {number} strength  0..1 fill removed at ground level
 */
function applyCanopyOcclusion(material, height, strength) {
    if (material.userData.__canopyAO) return;
    material.userData.__canopyAO = true;
    const uniforms = { uCanopyAoHeight: { value: height }, uCanopyAoMin: { value: 1 - strength } };
    const prev = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    // Chained, and keyed explicitly: Three caches programs by the hook's
    // source text, so a wrapper whose text is identical across materials
    // with DIFFERENT inner hooks (wind, pastel grade) would share one program.
    const baseKey = prevKey !== THREE.Material.prototype.customProgramCacheKey
        ? prevKey.call(material) : (prev ? prev.toString() : '');
    material.customProgramCacheKey = () => `${baseKey}|canopyAO`;
    material.onBeforeCompile = function (shader, renderer) {
        if (prev) prev.call(this, shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = 'varying float vCanopyY;\n' + shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            '#include <worldpos_vertex>\nvCanopyY = (modelMatrix * vec4(transformed, 1.0)).y;'
        );
        shader.fragmentShader = 'varying float vCanopyY;\nuniform float uCanopyAoHeight;\nuniform float uCanopyAoMin;\n'
            + shader.fragmentShader.replace(
                '#include <lights_fragment_end>',
                `#include <lights_fragment_end>
                 {
                     float canopyAo = mix(uCanopyAoMin, 1.0, smoothstep(0.0, uCanopyAoHeight, vCanopyY));
                     reflectedLight.indirectDiffuse *= canopyAo;
                     reflectedLight.indirectSpecular *= canopyAo;
                 }`
            );
    };
    material.needsUpdate = true;
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
function createContactShadow(diameter, y = 0.03) {
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
    decal.position.y = y;   // above the ground line, below root flares and pathway ribbon
    decal.renderOrder = 1;
    return decal;
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

        // Sunk 0.3m: the trunk's bottom 25cm is a flat root-flare plate that
        // spreads to ~1.9m and sat ON the lawn like a skirt, grass poking
        // through its rim. Measured band by band, the trunk is a natural
        // ~1.1m across at 0.25m up -- which is where the ground now cuts it.
        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -box.min.y * scaleFactor - 0.3, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            // The stalks -- the thin rachis stems under each compound leaf --
            // were 189k triangles of the shadow pass (35% of it) for lines a
            // few shadow texels wide; the leaf and flower cards around them
            // already cast the canopy's shade. Cutting them is what lets the
            // shadow map re-render every frame (see main.js). Applied after
            // enhanceFoliageMaterial, which sets castShadow on everything.
            const isStalk = /stalk/i.test(child.material.name || '');
            child.receiveShadow = true;
            // Captured before enhanceFoliageMaterial runs: it rewrites every
            // BLEND material to alphaTest, which would make `transparent`
            // false on all foliage and blind the wind gate's alpha-blend test.
            const wantsWind = isFoliageForWind(child, child.material);
            enhanceFoliageMaterial(child.material, child, 0.32);
            child.castShadow = !isStalk;
            if (wantsWind) injectFoliageWind(child, child.material, { swayFraction: 0.048, speedMult: 0.85 });   // was 0.05/1.0 -- too much sway on the stalk mesh, 48% of the tree's geometry
            // Last, so it chains over every other hook on the material.
            if (/trunk/i.test(child.material.name || '')) applyCanopyOcclusion(child.material, 3.2, 0.5);
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
// 3. Pond (Top-Left)
// ---------------------------------------------------------------------------
// The basin is the lawn itself (groundHeightAt, from the baked terrain); this
// builds only the water: one flat sheet at POND_WATER_Y, discarded wherever
// the basin rises above it. The shoreline is therefore exactly where water
// meets ground, from any angle, and it fades in over the first few
// centimetres of depth instead of z-fighting along the waterline.
//
// The water's own body colour. Twilight used to be painted bronze-amber here
// to fake a sunset reflection; the shader now reflects the real sky colours
// main.js passes in (lightCtx.skyReflect / horizonReflect), so the body only
// darkens a little as the light goes.
const C_WATER_DAY = new THREE.Color(0x164c42);       // deep natural wetland pond emerald
const C_WATER_DUSK = new THREE.Color(0x123a34);
const C_WATER_DAWN = new THREE.Color(0x123a34);
const C_WATER_NIGHT = new THREE.Color(0x09141e);     // starlit deep obsidian indigo pool

// THREE.Color has no addScaledVector (that's Vector3), so the blend is spelt
// out -- the old chained call would have thrown on the first frame it ran.
function blendWeights(out, a, wa, b, wb, c, wc) {
    out.r = a.r * wa + b.r * wb + c.r * wc;
    out.g = a.g * wa + b.g * wb + c.g * wc;
    out.b = a.b * wa + b.b * wb + c.b * wc;
    return out;
}

function setupPond() {
    const group = new THREE.Group();
    group.name = 'Pond';
    group.position.copy(GARDEN_POINTS.POND);
    // Same rotation groundHeightAt() un-does, so this group's local x/z IS
    // the baked terrain's frame and the water can sample it directly.
    group.rotation.y = POND_ROT_Y;

    const pondWaterUniforms = {
        uTime: { value: 0.0 },
        uSkyColor: { value: new THREE.Color(0x9ec0e8) },
        uHorizColor: { value: new THREE.Color(0xd0e0f2) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfffaee) },
        uSunIntensity: { value: 1.0 },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonColor: { value: new THREE.Color(0xdbe5f3) },
        uMoonIntensity: { value: 0.5 },
        uDayWeight: { value: 1.0 },
        uTwiWeight: { value: 0.0 },
        uNightWeight: { value: 0.0 },
        uPondHeight: { value: getPondHeightTexture() },
        uPondExtent: { value: POND_EXTENT },
        uWaterY: { value: POND_WATER_Y }
    };

    const surfaceWaterMat = new THREE.MeshStandardMaterial({
        color: C_WATER_DAY,
        roughness: 0.16,
        metalness: 0.08,
        envMapIntensity: 1.2,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,     // the bed shows through; nothing behind it needs depth from it
        depthTest: true
    });

    const n = getPondHeightTexture().image.width;
    surfaceWaterMat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, pondWaterUniforms);
        shader.vertexShader = 'varying vec3 vWaterW;\nvarying vec3 vWaterLocal;\n' + shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            '#include <worldpos_vertex>\n vWaterLocal = position;\n vWaterW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        );
        shader.fragmentShader = `
varying vec3 vWaterW;
varying vec3 vWaterLocal;
uniform float uTime;
uniform vec3 uSkyColor;
uniform vec3 uHorizColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uMoonIntensity;
uniform float uDayWeight;
uniform float uTwiWeight;
uniform float uNightWeight;
uniform sampler2D uPondHeight;
uniform float uPondExtent;
uniform float uWaterY;
` + shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            `// Depth of water over the baked bed at this point. Texel centres
             // sit on the grid samples, so u maps [-extent, extent] to
             // [0.5/n, 1 - 0.5/n].
             vec2 huv = (vWaterLocal.xz + uPondExtent) / (2.0 * uPondExtent)
                      * ${((n - 1) / n).toFixed(6)} + ${(0.5 / n).toFixed(6)};
             float waterDepth = uWaterY - texture2D(uPondHeight, huv).r;
             if (waterDepth <= 0.0) discard;

             // Ambient water floor adapting to celestial diurnal cycle
             vec3 dayFloor = vec3(0.045, 0.088, 0.082);
             vec3 twiFloor = vec3(0.030, 0.045, 0.050);
             vec3 nightFloor = vec3(0.008, 0.014, 0.022);
             vec3 waterFloor = dayFloor * uDayWeight + twiFloor * uTwiWeight + nightFloor * uNightWeight;
             outgoingLight = max(outgoingLight, waterFloor);

             // Multi-frequency natural water drift and surface shimmer
             float wave1 = sin(vWaterW.x * 2.6 + vWaterW.z * 2.1 + uTime * 0.85);
             float wave2 = cos(vWaterW.x * 1.8 - vWaterW.z * 2.4 + uTime * 0.65);
             float wave3 = sin(vWaterW.x * 4.5 + vWaterW.z * 3.8 - uTime * 1.25) * 0.5;
             // A fourth, off-axis wave: two crossing sines alone interfere
             // into a regular lattice that reads as tiles from above.
             float wave4 = sin(dot(vWaterW.xz, vec2(-3.1, 1.3)) + uTime * 0.55 + wave1 * 0.8) * 0.6;
             float ripple = (wave1 + wave2 + wave3 + wave4) * 0.32;
             vec3 shimmerCol = mix(uHorizColor, uSkyColor, 0.4) * 0.05;
             outgoingLight += shimmerCol * (ripple * 0.5 + 0.5);

             // Real sky reflection via Fresnel angle
             vec3 viewDir = normalize(cameraPosition - vWaterW);
             float NdotV = max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0);
             float fresnel = pow(1.0 - NdotV, 3.2);
             vec3 skyReflect = mix(uHorizColor, uSkyColor, clamp(NdotV * 1.5, 0.0, 1.0));
             outgoingLight += skyReflect * (fresnel * 0.75);

             // Celestial specular sheen (Sun rays during day/sunset, Moon silver at night)
             vec3 lightDir = uDayWeight > 0.05 ? normalize(uSunDir) : normalize(uMoonDir);
             vec3 lightCol = uDayWeight > 0.05 ? uSunColor : uMoonColor;
             float lightInt = uDayWeight > 0.05 ? uSunIntensity : uMoonIntensity;
             vec3 perturbedNorm = normalize(vec3(-ripple * 0.06, 1.0, -ripple * 0.06));
             vec3 halfVec = normalize(lightDir + viewDir);
             float spec = pow(max(dot(perturbedNorm, halfVec), 0.0), 36.0);
             outgoingLight += lightCol * (spec * 0.35 * clamp(lightInt * 0.25, 0.0, 1.0));

             #include <opaque_fragment>

             // Clear at the margin, where you see the bed through a few
             // centimetres of water, thickening to the pond's body colour
             // over the first ~60cm -- with a soft 10cm feather right at the
             // shoreline so the edge never draws a hard line or z-fights.
             float body = smoothstep(0.03, 0.65, waterDepth);
             gl_FragColor.a *= smoothstep(0.0, 0.10, waterDepth) * mix(0.35, 1.0, body);
             if (gl_FragColor.a <= 0.005) discard;`
        );
    };

    const size = POND_EXTENT * 2;
    const waterGeo = new THREE.PlaneGeometry(size, size, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(waterGeo, surfaceWaterMat);
    water.name = 'PondWaterSurface';
    water.position.y = POND_WATER_Y;
    water.receiveShadow = true;
    water.renderOrder = 2;
    group.add(water);

    // Hitbox for hover/click (local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(9.5, 9.5, 3.0, 24, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 1.0, 0);
    group.add(hitbox);

    const update = (time, delta, lightCtx) => {
        pondWaterUniforms.uTime.value = time;
        if (!lightCtx) return;
        if (lightCtx.skyReflect) pondWaterUniforms.uSkyColor.value.copy(lightCtx.skyReflect);
        if (lightCtx.horizonReflect) pondWaterUniforms.uHorizColor.value.copy(lightCtx.horizonReflect);
        if (lightCtx.sunDir) pondWaterUniforms.uSunDir.value.copy(lightCtx.sunDir).normalize();
        if (lightCtx.sunColor) pondWaterUniforms.uSunColor.value.copy(lightCtx.sunColor);
        if (lightCtx.sunIntensity !== undefined) pondWaterUniforms.uSunIntensity.value = lightCtx.sunIntensity;
        if (lightCtx.moonDir) pondWaterUniforms.uMoonDir.value.copy(lightCtx.moonDir).normalize();
        if (lightCtx.moonColor) pondWaterUniforms.uMoonColor.value.copy(lightCtx.moonColor);
        if (lightCtx.moonIntensity !== undefined) pondWaterUniforms.uMoonIntensity.value = lightCtx.moonIntensity;
        const dayW = lightCtx.dayWeight ?? 1;
        const twiW = lightCtx.twiWeight ?? 0;
        const nightW = lightCtx.nightWeight ?? 0;
        pondWaterUniforms.uDayWeight.value = dayW;
        pondWaterUniforms.uTwiWeight.value = twiW;
        pondWaterUniforms.uNightWeight.value = nightW;
        blendWeights(surfaceWaterMat.color, C_WATER_DAY, dayW,
            lightCtx.isMorning ? C_WATER_DAWN : C_WATER_DUSK, twiW, C_WATER_NIGHT, nightW);
        surfaceWaterMat.roughness = THREE.MathUtils.lerp(0.16, 0.11, nightW);
    };

    const interactiveData = {
        id: 'pond',
        title: 'Garden Pond',
        meta: 'Still water, soft banks · Click to visit',
        cameraTarget: { pos: new THREE.Vector3(-11.0, 6.8, -8.0), lookAt: new THREE.Vector3(-23.0, 0.0, -19.0) }
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
// culling keeps most of them off the GPU at any moment. Angles dodge the
// landmarks (pond ~220 deg, gazebo ~39 deg) so nothing
// overlaps or hides them, and every radius sits beyond the path's outer
// wobble (~19.5) and inside the ground's edge fade (starts at 38).
//
// Cost, audited and then reduced with the project's documented gltf-transform
// pass: banyan 12.6MB/111k tris -> 6.8MB/52.6k, mango 15.7MB/130k tris and a
// brutal 49.3MB of texture VRAM (two 2048 maps) -> 5.6MB/90.8k and 17.3MB.
// One of each. Heights set the garden's pecking order deliberately: banyan is
// the tallest thing here, mango next, and the gulmohar (11.2) stays the
// centrepiece by position rather than by size.
const BACKGROUND_TREES = [
    {
        // widen: xz stretch on top of the height scale, for a broader, more
        // banyan-like spread; rotY turns its shallow-rooted side to the path.
        kind: 'banyan', deg: BANYAN_DEG, r: BANYAN_R, height: 26.25, widen: 1.25, rotY: 0.17, yOffset: 0.015,
        id: 'banyan', title: 'Chinese Banyan', meta: 'Ficus microcarpa · Click to visit'
    },
    {
        kind: 'mango', deg: 252, r: 25.5, height: 15.5, rotY: 2.4, yOffset: -0.08,
        id: 'mango', title: 'Mango Tree', meta: 'Mangifera indica · Click to visit'
    }
];

// How wide a berth the gulmohar's canopy needs. Its own fitted radius is
// about 10m; a little more keeps outer branches out of the frame too.
const GULMOHAR_FRAME_CLEAR_R = 12.5;
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * Which way to step back from a tree at (tx, tz) to photograph it. Straight
 * toward the garden centre is the ideal -- it puts the garden behind the
 * subject -- so that is tried first, and the direction is swung further to
 * the side only as far as it takes for both the camera position and the
 * whole sightline to clear the gulmohar. Returns a unit vector.
 */
function standoffDirection(tx, tz, dist) {
    const inward = new THREE.Vector3(-tx, 0, -tz).normalize();
    const tree = new THREE.Vector3(tx, 0, tz);
    const cam = new THREE.Vector3();
    const seg = new THREE.Vector3();
    let best = null;
    // Alternating sides, widening: the first angle that clears wins, so the
    // framing stays as close to "looking in over the garden" as it can.
    for (const deg of [0, 30, -30, 50, -50, 70, -70, 90, -90, 110, -110]) {
        const d = inward.clone().applyAxisAngle(_yAxis, THREE.MathUtils.degToRad(deg));
        cam.copy(tree).addScaledVector(d, dist);
        // Distance from the gulmohar (at the origin) to the camera-to-tree
        // segment: how close the shot passes to the centrepiece.
        seg.subVectors(tree, cam);
        const len2 = seg.lengthSq();
        const t = len2 > 0 ? THREE.MathUtils.clamp(-cam.dot(seg) / len2, 0, 1) : 0;
        const clear = cam.clone().addScaledVector(seg, t).length();
        if (best === null || clear > best.clear) best = { d, clear };
        if (clear >= GULMOHAR_FRAME_CLEAR_R) return d;
    }
    // Nothing fully clears (a tree standing very close in): take the best.
    return best.d;
}

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
            if (wantsWind) {
                if (kind === 'mango') {
                    const isFruit = /004|fruit|mango/i.test(child.name || '') || /004|fruit|mango/i.test(child.material.name || '');
                    if (isFruit) {
                        // Mango fruits: pendular sway with gentle inertia and subtle bob
                        injectFoliageWind(child, child.material, { swayFraction: 0.054, speedMult: 0.85, flutterMult: 0.25, isFruit: true });
                    } else {
                        // Mango leaves: graceful canopy sway and delicate rustling flutter
                        injectFoliageWind(child, child.material, { swayFraction: 0.060, speedMult: 0.80, flutterMult: 1.0, isFruit: false });
                    }
                } else {
                    injectFoliageWind(child, child.material, { swayFraction: 0.042, speedMult: 0.75, flutterMult: 0.8, isFruit: false });
                }
            }
            if (kind === 'banyan') {
                const names = `${child.name} ${child.material.name}`;
                // The hanging roots and branch cards are alpha "foliage" to
                // enhanceFoliageMaterial, which drops shadow receiving on the
                // low tier -- so on phones the root curtain ignored the
                // canopy's shade entirely. A few thousand triangles; always on.
                if (/vine|branch/i.test(names)) child.receiveShadow = true;
                if (/bark|vine|branch|cap/i.test(names)) applyCanopyOcclusion(child.material, 9.0, 0.6);
            }
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
        const w = spec.widen || 1;
        model.scale.set(scaleFactor * w, scaleFactor, scaleFactor * w);
        // Banyan root spread sits gently atop the ground surface (+0.015) so its expansive
        // root network is fully exposed, while mango is sunk slightly (-0.08) to meet lawn.
        const yOff = spec.yOffset !== undefined ? spec.yOffset : -0.08;
        model.position.set(-centre.x * scaleFactor * w, -entry.box.min.y * scaleFactor + yOff, -centre.z * scaleFactor * w);

        const holder = new THREE.Group();
        holder.name = `${spec.kind}_${i}`;
        const theta = THREE.MathUtils.degToRad(spec.deg);
        const wx = Math.cos(theta) * spec.r, wz = Math.sin(theta) * spec.r;
        holder.position.set(wx, 0, wz);
        holder.rotation.y = spec.rotY;
        holder.add(model);
        holder.add(createContactShadow(spec.height * 0.62 * w, spec.kind === 'banyan' ? 0.005 : 0.03));
        group.add(holder);

        // Hoverable and clickable, same machinery as the four original
        // landmarks: an invisible cylinder as the ray target, plus a camera
        // framing. Sized to the canopy rather than the trunk so the whole
        // tree is a target, and counter-rotated out of the holder's own
        // rotation so the framing stays in world space.
        const hitbox = new THREE.Mesh(
            new THREE.CylinderGeometry(spec.height * 0.42 * w, spec.height * 0.42 * w, spec.height, 10, 1, true),
            new THREE.MeshBasicMaterial({ visible: false })
        );
        hitbox.position.set(0, spec.height * 0.5, 0);
        holder.add(hitbox);

        // Stand off toward the garden centre so the camera looks outward at
        // the tree with the rest of the garden behind it, never through it.
        // Straight inward is not good enough on its own: these trees ring a
        // gulmohar that is 20m across, so "toward the centre" walks the
        // camera into the centrepiece and frames the banyan through a
        // curtain of someone else's branches. Swing the stand-off to one
        // side until the whole sightline clears the gulmohar.
        const dist = spec.height * 1.15 * Math.sqrt(w);
        const inward = standoffDirection(wx, wz, dist);
        const camY = spec.kind === 'banyan' ? spec.height * 0.32 : spec.height * 0.52;
        const lookY = spec.kind === 'banyan' ? spec.height * 0.16 : spec.height * 0.42;
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
                        .setY(camY),
                    lookAt: new THREE.Vector3(wx, lookY, wz)
                }
            }
        });
    });

    return group;
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
                if (roll < 0.66) {
                    // Wide garden ground coverage
                    const r = Math.sqrt(Math.random()) * 38.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                } else {
                    // Centerpiece Gulmohar canopy drift
                    const r = Math.sqrt(Math.random()) * 14.5;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                }

                // No fallen leaves under the water (keyed on the basin's
                // height, so it follows the real shoreline).
                if (groundHeightAt(x, z) < POND_WATER_Y + 0.03) {
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

        // A handful of leaves on the path itself. The scatter above lands
        // some inside the path's footprint already, but it sits them on the
        // terrain at +0.022 while the paving is a separate surface at +0.025
        // -- so every one of those is buried a few millimetres under the
        // stones and the path reads as swept clean. These ride the paving
        // instead, following the same pathRadiusAt/pathWidthAt curve the
        // path mesh is built from, so they cannot drift off its edge.
        const pathLeafCount = Math.max(4, Math.round(QUALITY.floorLeafCount * 0.35));
        leafMeshes.forEach(({ geometry, material }, meshIndex) => {
            const instanced = new THREE.InstancedMesh(geometry, material, pathLeafCount);
            instanced.receiveShadow = true;
            instanced.castShadow = false;
            instanced.userData.baseCount = instanced.count;
            for (let i = 0; i < pathLeafCount; i++) {
                // Offset per leaf type so the types interleave along the loop
                // rather than each starting its run at the same place.
                const theta = ((i + meshIndex * 0.37) / pathLeafCount + Math.random() * 0.06) * Math.PI * 2;
                // Biased toward the edges, where leaves actually gather --
                // the middle of a walked path stays clearer than its sides.
                const across = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.24) * pathWidthAt(theta);
                const r = pathRadiusAt(theta) + across;
                const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
                dummy.position.set(x, groundHeightAt(x, z) + 0.032 + (i % 5) * 0.002, z);
                dummy.rotation.set(
                    (Math.random() - 0.5) * 0.1,
                    Math.random() * Math.PI * 2,
                    (Math.random() - 0.5) * 0.1
                );
                const s = 0.6 + Math.random() * 0.35;
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
        // and the other branches were dead code. Rolling a fraction instead of
        // comparing the loop index is what actually reaches both.
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
                if (roll < 0.55) {
                    // The pond's margin: a band just above the waterline, found
                    // by height so it hugs the real shore rather than a circle.
                    x = GARDEN_POINTS.POND.x; z = GARDEN_POINTS.POND.z;
                    for (let t = 0; t < 40; t++) {
                        const r = Math.random() * POND_EXTENT;
                        const theta = Math.random() * Math.PI * 2;
                        const px = GARDEN_POINTS.POND.x + Math.cos(theta) * r;
                        const pz = GARDEN_POINTS.POND.z + Math.sin(theta) * r;
                        const h = groundHeightAt(px, pz);
                        if (h > POND_WATER_Y + 0.02 && h < POND_WATER_Y + 0.30) { x = px; z = pz; break; }
                    }
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
// 6b. Flower beds -- removed
// ---------------------------------------------------------------------------
// There was a createFlowerBeds() here: ~2,200 instanced icosahedron blobs
// along the path's outer shoulder, from before the garden had real plant
// geometry. The meadow clumps and flower GLBs that setupVegetation scatters
// now cover the same ground with actual modelled plants, and the call to it
// was dropped when they landed -- but the function itself was left behind,
// along with its colour tables and a copy of the instanced-colour wiring.
// Deleted rather than revived: bringing the blobs back would put a second,
// cruder planting scheme on top of the real one. See src/scene/grass.js for
// the instanced-colour note the copy here used to carry.

// ---------------------------------------------------------------------------
// 6. Curving Garden Pathway (Centered at Origin 0,0,0)
// ---------------------------------------------------------------------------
function createGardenPathway() {
    const group = new THREE.Group();
    group.name = 'GardenPathway';

    const curvePoints = [];
    const segments = 240;

    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const r = pathRadiusAt(theta);
        const px = Math.cos(theta) * r, pz = Math.sin(theta) * r;
        // Rides the ground height field, or the pond berm swallows the
        // stretch of path that passes closest to the water.
        curvePoints.push(new THREE.Vector3(px, groundHeightAt(px, pz) + 0.018, pz));
    }

    const curve = new THREE.CatmullRomCurve3(curvePoints, true);

    const pathSegments = 360;
    const vertices = [];
    const uvs = [];
    const indices = [];
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i <= pathSegments; i++) {
        const t = i / pathSegments;
        const point = curve.getPointAt(t);
        const theta = Math.atan2(point.z, point.x);
        const w = pathWidthAt(theta);
        const tangent = curve.getTangentAt(t).normalize();
        const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();

        const pLeft = point.clone().addScaledVector(normal, -w * 0.5);
        const pRight = point.clone().addScaledVector(normal, w * 0.5);

        // Conform both rails to the local ground height field
        pLeft.y = groundHeightAt(pLeft.x, pLeft.z) + 0.025;
        pRight.y = groundHeightAt(pRight.x, pRight.z) + 0.025;

        vertices.push(pLeft.x, pLeft.y, pLeft.z);
        vertices.push(pRight.x, pRight.y, pRight.z);

        // Integer V repeat, with U proportional to local width so cobblestones
        // keep their natural size across the widened gazebo plaza.
        const uSpan = w / PATH_WIDTH;
        uvs.push(0, t * 38);
        uvs.push(uSpan, t * 38);

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
        normalScale: new THREE.Vector2(0.85, 0.85),
        color: 0xf6f0e6,
        roughness: 0.88,
        metalness: 0.02,
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

