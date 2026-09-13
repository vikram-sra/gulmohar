import * as THREE from 'three';
import { windUniforms } from './wind.js';
import { groundHeightAt, isGroundClear } from './garden.js';

// ---------------------------------------------------------------------------
// The lawn: real 3D grass blades from realistics_grass_06.glb (3d_Assets/NEW).
//
// The asset is one tuft of 2,184 individual curved blades, 3 triangles each
// -- geometry, not the photographic cards the old lawn used, so blades catch
// light and move individually. Overlapping tufts cover the lawn; drawn whole
// that would be tens of millions of triangles, so level of detail does the
// work instead:
//
//   * Blades are sorted by a random key and the index buffer written in that
//     order, so "the first k% of blades" is just a draw range. Six LOD
//     meshes share ONE geometry's attributes and differ only in draw range.
//   * The vertex shader keeps a blade only if its key is under a density
//     that falls off smoothly with distance from the camera -- so blades
//     thin out continuously, with no LOD pops. Each tuft is drawn with the
//     smallest draw range that still covers the density at its nearest
//     point, so the discarded blades cost almost nothing.
//   * Tufts outside the view frustum are not drawn at all.
//   * Each blade samples a baked garden mask at its root: where the path,
//     pond, gazebo or a tree base is, it collapses; everywhere else it is
//     lifted onto the real ground height. Tufts can therefore sit on a plain
//     jittered grid and ignore the garden's layout entirely.
// ---------------------------------------------------------------------------

const BLADE_HEIGHT_M = 0.12;          // median blade: a kept lawn, not a meadow -- was 0.20, read as shin-height
// A whole tuft is ~2,600 blades per square metre once neighbours overlap:
// a felt mat, and 3M triangles in view (measured). Budgeted instead at ~400
// blades/m2 up close thinning to ~30/m2 at the rim -- measured ~500k
// triangles in the landing view at the top tier and ~110k at the low tier
// (the old card lawn's low-tier cost), and it still reads as full grass
// because the blades are long.
const MAX_DENSITY = 0.16;
// How far the blade roots are pushed below the ground they are planted on.
// Grass grows out of a mat of older growth, not off a clean surface -- with
// the roots sitting exactly on the ground you see the bottom of every blade
// and it reads as loose bristles standing on soil. Burying them hides the
// ends and the tufts close over into turf.
const BLADE_SINK_M = 0.03;   // scaled down with the shorter blade -- 0.05 buried a third of a 0.12m blade
// How fast the parted patch grows/closes around a focused ground painting.
// Slower than the billboard turn (3.5): the grass moving is a bigger visual
// event than a painting's own rotation, and easing it in gently reads as the
// grass settling aside rather than an area just switching off.
const CLEAR_ZONE_RESPONSE = 2.2;
const LOD_FRACTIONS = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32].map((f) => f * MAX_DENSITY);
const MASK_SIZE_M = 100;              // the mask spans the whole ground plane
const MASK_RES = 400;                 // 25cm texels

// Lawn palette: multiplies the photographed blade, only nudging it toward the
// garden's greens and breaking up tile-to-tile sameness.
const TINTS = [0x7fa85a, 0x6d9a4a, 0x8cb465, 0x77a052, 0x648f44].map((h) => new THREE.Color(h));

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Garden mask: R = ground height, G = 1 where grass may grow. Baked from the
 * same isGroundClear/groundHeightAt the rest of the garden uses, so the pond
 * shoreline, path and exclusions are defined exactly once.
 */
function bakeMask() {
    const data = new Uint16Array(MASK_RES * MASK_RES * 4);
    const step = MASK_SIZE_M / MASK_RES;
    const half = MASK_SIZE_M / 2;
    const one = THREE.DataUtils.toHalfFloat(1);
    for (let j = 0; j < MASK_RES; j++) {
        const z = -half + (j + 0.5) * step;
        for (let i = 0; i < MASK_RES; i++) {
            const x = -half + (i + 0.5) * step;
            const o = (j * MASK_RES + i) * 4;
            const r = Math.hypot(x, z);
            data[o] = THREE.DataUtils.toHalfFloat(groundHeightAt(x, z));
            data[o + 1] = r < 44 && isGroundClear(x, z, 0) ? one : 0;
            data[o + 3] = one;
        }
    }
    const tex = new THREE.DataTexture(data, MASK_RES, MASK_RES, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Splits the patch into blades (connected components of the index buffer),
 * scales it to BLADE_HEIGHT_M, and rebuilds it with per-blade attributes and
 * the index ordered by each blade's random key.
 */
function buildBladeGeometry(source) {
    const geo = source.clone();
    geo.computeBoundingBox();
    const pos = geo.attributes.position;
    const index = geo.index ? geo.index.array : null;
    const vCount = pos.count;

    const parent = new Int32Array(vCount);
    for (let i = 0; i < vCount; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const tris = index ? index.length / 3 : vCount / 3;
    const triVert = (t, k) => (index ? index[t * 3 + k] : t * 3 + k);
    for (let t = 0; t < tris; t++) {
        const a = find(triVert(t, 0));
        parent[find(triVert(t, 1))] = a;
        parent[find(triVert(t, 2))] = a;
    }

    // Per blade: root (its lowest vertex) and height.
    const bladeOf = new Int32Array(vCount);
    const ids = new Map();
    for (let v = 0; v < vCount; v++) {
        const r = find(v);
        if (!ids.has(r)) ids.set(r, ids.size);
        bladeOf[v] = ids.get(r);
    }
    const nBlades = ids.size;
    const rootV = new Int32Array(nBlades).fill(-1);
    const topY = new Float32Array(nBlades).fill(-Infinity);
    for (let v = 0; v < vCount; v++) {
        const b = bladeOf[v], y = pos.getY(v);
        if (rootV[b] < 0 || y < pos.getY(rootV[b])) rootV[b] = v;
        if (y > topY[b]) topY[b] = y;
    }
    const heights = Array.from({ length: nBlades }, (_, b) => topY[b] - pos.getY(rootV[b])).sort((p, q) => p - q);
    const scale = BLADE_HEIGHT_M / Math.max(heights[nBlades >> 1], 1e-6);

    // Centre the tuft on the centroid of its roots, scale it, and measure how
    // far out the roots reach (85th percentile, so a few stray blades don't
    // set the spacing).
    let cxr = 0, czr = 0;
    for (let b = 0; b < nBlades; b++) { cxr += pos.getX(rootV[b]); czr += pos.getZ(rootV[b]); }
    geo.translate(-cxr / nBlades, 0, -czr / nBlades);
    geo.scale(scale, scale, scale);
    const reach = Array.from({ length: nBlades }, (_, b) => Math.hypot(pos.getX(rootV[b]), pos.getZ(rootV[b])))
        .sort((p, q) => p - q);
    const tuftRadius = reach[Math.floor(nBlades * 0.85)];

    const rand = mulberry32(912);
    const key = new Float32Array(nBlades);
    for (let b = 0; b < nBlades; b++) key[b] = rand();

    // `pos` is the same attribute translate()/scale() just rewrote in place,
    // so roots read here are already in metres; topY was taken before the
    // (y-preserving) translate and only needs the scale.
    const aBlade = new Float32Array(vCount * 4);    // root xyz, key
    const aBladeH = new Float32Array(vCount);       // blade height
    for (let v = 0; v < vCount; v++) {
        const b = bladeOf[v], rv = rootV[b];
        aBlade[v * 4] = pos.getX(rv);
        aBlade[v * 4 + 1] = pos.getY(rv);
        aBlade[v * 4 + 2] = pos.getZ(rv);
        aBlade[v * 4 + 3] = key[b];
        aBladeH[v] = Math.max(topY[b] * scale - pos.getY(rv), 0.02);
    }
    geo.setAttribute('aBlade', new THREE.BufferAttribute(aBlade, 4));
    geo.setAttribute('aBladeH', new THREE.BufferAttribute(aBladeH, 1));

    // Index, grouped by blade and ordered by key.
    const trisOf = Array.from({ length: nBlades }, () => []);
    for (let t = 0; t < tris; t++) trisOf[bladeOf[triVert(t, 0)]].push(t);
    const order = Array.from({ length: nBlades }, (_, b) => b).sort((p, q) => key[p] - key[q]);
    const out = new Uint32Array(tris * 3);
    const cumulative = new Float32Array(nBlades);   // index count after k blades
    let w = 0;
    order.forEach((b, k) => {
        for (const t of trisOf[b]) { out[w++] = triVert(t, 0); out[w++] = triVert(t, 1); out[w++] = triVert(t, 2); }
        cumulative[k] = w;
    });
    geo.setIndex(new THREE.BufferAttribute(out, 1));
    const rangeFor = (fraction) => cumulative[Math.min(nBlades - 1, Math.max(0, Math.ceil(fraction * nBlades) - 1))];

    return { geometry: geo, tuftRadius, rangeFor, nBlades, tris };
}

function injectLawnShader(material, uniforms) {
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms, {
            uWindTime: windUniforms.uWindTime,
            uWindStrength: windUniforms.uWindStrength
        });
        shader.vertexShader = `
#define BLADE_SINK ${BLADE_SINK_M.toFixed(4)}
attribute vec4 aBlade;
attribute float aBladeH;
attribute vec3 aTileTint;
uniform sampler2D uLawnMask;
uniform vec3 uLawnMaskXform;   // min x, min z, 1/size
uniform vec3 uLawnCam;
uniform vec4 uLawnFade;        // near, far, far density, global density
uniform vec4 uClearZone;       // x, z, radius, fade width -- parts the grass
                                // around a ground-lain painting while it is
                                // being looked at, so blades don't poke in
                                // front of the canvas. Radius sits far
                                // negative when idle, so the smoothstep below
                                // resolves to 1 (no effect) everywhere without
                                // a branch.
uniform float uWindTime;
uniform float uWindStrength;
varying float vBladeT;
varying vec3 vTileTint;
` + shader.vertexShader;

        // Lit like a soft volume, not like the thin planes the blades really
        // are: bending every normal most of the way to vertical is the
        // standard grass trick, and stops blades seen edge-on going black.
        shader.vertexShader = shader.vertexShader.replace(
            '#include <beginnormal_vertex>',
            '#include <beginnormal_vertex>\nobjectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.45));'
        );

        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
{
    vec4 rootW = modelMatrix * instanceMatrix * vec4(aBlade.xyz, 1.0);
    vec4 mask = texture2D(uLawnMask, (rootW.xz - uLawnMaskXform.xy) * uLawnMaskXform.z);
    float key = aBlade.w;

    // Continuous thinning with distance; blades grow in over a short band
    // of key so nothing pops as the camera moves.
    float d = distance(rootW.xz, uLawnCam.xz);
    float density = mix(1.0, uLawnFade.z, smoothstep(uLawnFade.x, uLawnFade.y, d)) * uLawnFade.w;
    float grow = smoothstep(key, key + 0.004, density);
    // Fuzzy mask edge: each blade gets its own threshold, so path and pond
    // borders read as a ragged edge of grass, not a stencil.
    grow *= step(0.25 + 0.5 * fract(key * 61.7), mask.g);
    // Part around a ground-lain painting while it is being viewed, so blades
    // don't stand in front of the canvas at close range. Smooth, not a
    // stencil edge, and per-blade rather than per-tuft so it reads as the
    // grass being nudged aside rather than a bare disc appearing.
    grow *= smoothstep(uClearZone.z, uClearZone.z + uClearZone.w, distance(rootW.xz, uClearZone.xy));

    float along = clamp((position.y - aBlade.y) / aBladeH, 0.0, 1.0);
    vBladeT = along;
    vTileTint = aTileTint;

    // Collapse toward the root, then plant on the real ground. The offset is
    // wanted in world metres but applied before instanceMatrix, which scales
    // each tuft, so it is divided back out.
    transformed = aBlade.xyz + (transformed - aBlade.xyz) * grow;
    transformed.y += (mask.r - rootW.y - BLADE_SINK) / length(instanceMatrix[1].xyz);

    // Wind: root pinned, tip carries the motion; shares the trees' gusts.
    vec2 windDir = normalize(vec2(0.82, 0.57));
    float phase = dot(rootW.xz, windDir) * 0.18 - uWindTime * 1.65;
    float sway = sin(phase) * 0.72 + sin(phase * 1.85 + dot(rootW.xz, vec2(-0.57, 0.82)) * 0.14) * 0.28
               + sin(uWindTime * 3.8 + key * 40.0) * 0.18;
    float amp = (uWindStrength * 0.9 + 0.05) * aBladeH * pow(along, 1.6);
    // instanceMatrix rotates (and may mirror) tiles about Y -- orthonormal,
    // so its transpose takes the wind direction back into the tile's frame.
    vec3 wLocal = transpose(mat3(instanceMatrix)) * vec3(windDir.x, 0.0, windDir.y);
    transformed.xz += wLocal.xz * sway * amp;
    transformed.y -= abs(sway) * amp * 0.25 * along;
}`
        );

        shader.fragmentShader = `
varying float vBladeT;
varying vec3 vTileTint;
` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `#include <color_fragment>
diffuseColor.rgb *= vTileTint * 1.2;
// Darker in the thatch at the roots, where blades shade one another.
diffuseColor.rgb *= mix(0.45, 1.0, smoothstep(0.0, 0.55, vBladeT));`
        );
    };
    material.needsUpdate = true;
}

/**
 * @param {object} gltf      loaded models/grass_blades.glb
 * @param {object} options   { radius, density (0..1, tier) }
 * @returns {{ group, update(camera), setDensityScale(s), tickClearZone(target, dt), stats() } | null}
 */
export function createLawn(gltf, { radius = 41, density = 1 } = {}) {
    let source = null;
    if (gltf && gltf.scene) {
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
            if (!source && o.isMesh) {
                source = { geometry: o.geometry.clone().applyMatrix4(o.matrixWorld), material: o.material };
            }
        });
    }
    if (!source) {
        console.warn('[lawn] no blade mesh in grass_blades.glb -- lawn will be empty');
        return null;
    }

    const { geometry, tuftRadius, rangeFor } = buildBladeGeometry(source.geometry);
    const mask = bakeMask();

    const uniforms = {
        uLawnMask: { value: mask },
        uLawnMaskXform: { value: new THREE.Vector3(-MASK_SIZE_M / 2, -MASK_SIZE_M / 2, 1 / MASK_SIZE_M) },
        uLawnCam: { value: new THREE.Vector3() },
        // near, far, far-density, global density. The far end was tuned when
        // blades were 0.20m and density 0.09; they are now 0.12m and 0.16, so
        // the same 26m falloff was holding ~1.9M triangles of lawn on screen
        // (measured) against the ~500k this was originally budgeted for --
        // most of it blades under a pixel wide. Pulling the falloff in and
        // dropping the far floor keeps the dense turf where it is actually
        // looked at and stops paying for the part of the field that reads as
        // flat colour either way.
        uLawnFade: { value: new THREE.Vector4(3.5, 15, 0.045, MAX_DENSITY * density) },
        // -1000 radius: smoothstep(-1000, -1000+fade, d) reads 1 for every
        // real distance, i.e. no clearing, without a branch in the shader.
        uClearZone: { value: new THREE.Vector4(0, 0, -1000, 0.7) }
    };

    // A plain matte material, not the loaded one: the asset is spec-gloss,
    // and its conversion to metal-rough carries a white KHR_materials_specular
    // layer that turned every blade into a pale sheen -- the lawn read as
    // frosted. Thin blades gain nothing visible from the normal map either.
    const material = new THREE.MeshStandardMaterial({
        map: source.material.map,
        roughness: 0.82,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: 0.5
    });
    // No alpha-to-coverage, tempting as it is for blade edges: the scene
    // renders through the composer's render target, not the multisampled
    // canvas, and there it frosted every blade edge white (measured -- the
    // whole lawn read pale until it was turned off).
    injectLawnShader(material, uniforms);

    // Tufts on a jittered grid at under their own radius, so neighbours
    // overlap into continuous grass instead of reading as separate mounds;
    // any rotation, a little scale spread. The mask does the layout.
    const spacing = tuftRadius * 1.25;
    const rand = mulberry32(4401);
    const tiles = [];
    const nSide = Math.ceil((radius + spacing) / spacing);
    const probe = (x, z) => Math.hypot(x, z) < radius && isGroundClear(x, z, 0);
    const up = new THREE.Vector3(0, 1, 0);
    for (let iz = -nSide; iz <= nSide; iz++) {
        for (let ix = -nSide; ix <= nSide; ix++) {
            const x = (ix + (rand() - 0.5) * 0.8) * spacing;
            const z = (iz + (rand() - 0.5) * 0.8) * spacing;
            if (Math.hypot(x, z) > radius + tuftRadius) continue;
            // Skip tufts with nowhere at all for grass to grow.
            const h = tuftRadius * 0.7;
            if (![[0, 0], [h, 0], [-h, 0], [0, h], [0, -h]].some(([ox, oz]) => probe(x + ox, z + oz))) continue;
            const s = 0.85 + rand() * 0.3;
            const m = new THREE.Matrix4().compose(
                new THREE.Vector3(x, 0, z),
                new THREE.Quaternion().setFromAxisAngle(up, rand() * Math.PI * 2),
                new THREE.Vector3(s, s, s)
            );
            const tint = TINTS[Math.floor(rand() * TINTS.length)].clone()
                .offsetHSL((rand() - 0.5) * 0.02, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.04);
            tiles.push({ x, z, matrix: m, tint });
        }
    }

    const group = new THREE.Group();
    group.name = 'Lawn';
    const lods = LOD_FRACTIONS.map((fraction) => {
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(geometry.attributes)) g.setAttribute(name, attr);
        g.setIndex(geometry.index);
        g.setDrawRange(0, rangeFor(fraction));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + tuftRadius * 2);
        const tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(tiles.length * 3), 3);
        g.setAttribute('aTileTint', tintAttr);
        const mesh = new THREE.InstancedMesh(g, material, tiles.length);
        mesh.frustumCulled = false;     // culled per tile below
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.count = 0;
        mesh.name = `Lawn_LOD${fraction}`;
        group.add(mesh);
        return { fraction, mesh, tint: tintAttr };
    });

    // Clear-zone state lives outside the uniform itself so the centre can
    // stay put while the radius eases back to zero on release -- reading the
    // uniform back each frame would work too, but this keeps the target
    // explicit instead of round-tripping it through GPU-bound state.
    let clearX = 0, clearZ = 0, clearRadius = 0;

    const frustum = new THREE.Frustum();
    const projView = new THREE.Matrix4();
    const sphere = new THREE.Sphere(new THREE.Vector3(), tuftRadius * 1.6);
    const lastCam = new THREE.Matrix4();
    let lastDensity = -1;
    let dirty = true;

    const densityAt = (d) => {
        const f = uniforms.uLawnFade.value;
        const t = THREE.MathUtils.smoothstep(d, f.x, f.y);
        return (1 + (f.z - 1) * t) * f.w;
    };

    function update(camera) {
        uniforms.uLawnCam.value.setFromMatrixPosition(camera.matrixWorld);
        const f = uniforms.uLawnFade.value;
        if (!dirty && f.w === lastDensity && camera.matrixWorld.equals(lastCam)) return;
        lastCam.copy(camera.matrixWorld);
        lastDensity = f.w;
        dirty = false;

        projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projView);
        const cam = uniforms.uLawnCam.value;
        for (const lod of lods) lod.mesh.count = 0;
        const halfDiag = tuftRadius * 1.3;
        for (const tile of tiles) {
            sphere.center.set(tile.x, 0.15, tile.z);
            if (!frustum.intersectsSphere(sphere)) continue;
            const near = Math.max(0, Math.hypot(tile.x - cam.x, tile.z - cam.z) - halfDiag);
            // A blade shows at all only while its key is under the density
            // (the shader's grow band sits below that), so the draw range
            // needs to reach exactly the density at the tuft's nearest point.
            const need = densityAt(near) * 1.001;
            let lod = lods[0];
            for (const l of lods) if (l.fraction >= need) lod = l;
            const k = lod.mesh.count++;
            lod.mesh.setMatrixAt(k, tile.matrix);
            lod.tint.setXYZ(k, tile.tint.r, tile.tint.g, tile.tint.b);
        }
        for (const lod of lods) {
            lod.mesh.instanceMatrix.needsUpdate = true;
            lod.tint.needsUpdate = true;
        }
    }

    return {
        group,
        update,
        /** The adaptive quality loop's lever: 1 = the tier's density. */
        setDensityScale(s) { uniforms.uLawnFade.value.w = MAX_DENSITY * density * s; },
        /**
         * Eases the parted patch toward `target` ({x, z, radius}) each frame,
         * or toward closed when `target` is null. Called unconditionally from
         * the render loop -- unlike update(), which skips work when the
         * camera hasn't moved, this has to keep easing even while the viewer
         * stands still looking at the painting it is clearing space around.
         */
        tickClearZone(target, dt) {
            if (target) { clearX = target.x; clearZ = target.z; }
            const targetRadius = target ? target.radius : 0;
            const ease = 1 - Math.exp(-CLEAR_ZONE_RESPONSE * Math.min(dt, 0.1));
            clearRadius += (targetRadius - clearRadius) * ease;
            const v = uniforms.uClearZone.value;
            // Snap the rest of the way and park far off once it is close
            // enough to zero to be invisible -- an exponential ease never
            // quite reaches its target, so without this the shader carries a
            // permanent, pointless near-zero-radius clear circle.
            if (clearRadius < 0.02) { clearRadius = 0; v.set(clearX, clearZ, -1000, 0.7); }
            else v.set(clearX, clearZ, clearRadius, 0.7);
        },
        stats() {
            let tris = 0;
            for (const l of lods) tris += l.mesh.count * l.mesh.geometry.drawRange.count / 3;
            return { tiles: tiles.length, drawn: lods.map((l) => l.mesh.count), tris: Math.round(tris) };
        }
    };
}
