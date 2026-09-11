import * as THREE from 'three';
import { isGroundClear, groundHeightAt } from './garden.js';
import { windUniforms } from './wind.js';

// ---------------------------------------------------------------------------
// Instanced grass CARDS -- now the wild accents only: meadow clumps at the
// rim, along the pond margin, and small leafy plants in the lawn, all from
// meadow_clumps.glb (simple_grass_chunks, see scripts/extract-meadow-clumps.mjs).
// The lawn itself is real 3D blades now; see lawn.js. History below.
//
// Previously this generated blade geometry procedurally -- 4 blades of 3
// triangles each, tinted by a palette. It read as pale shards no matter how it
// was tuned, because solid-colour geometry cannot carry the fine detail that
// makes grass look like grass; that detail lives in a texture.
//
// Now it instances real grass cards extracted from realtime_grass.glb: three
// card types, each 3 crossed quads = 6 triangles, with a photographic
// alpha-cutout texture. That is HALF the triangles of the procedural clump it
// replaces (6 vs 12) and looks dramatically better, which is the rare case
// where the better-looking option is also the cheaper one.
//
// The source asset ships 2,013 meshes / 4,029 nodes, but only 7 are unique --
// 6 grass cards plus a demo ground plane. `scripts/extract-grass-cards.py`
// pulls out just the 6 cards and their three 512x256 textures, dropping the
// plane and its 1024 map: 5.70 MB -> 1.39 MB.
// ---------------------------------------------------------------------------

// Sized by target height rather than a fixed scale factor, because the two
// assets are authored at completely different scales -- the grass cards are
// ~1.0 unit tall, the vegetation clumps are not. Each card is measured and
// scaled to hit the requested real-world height.
const GRASS_HEIGHT_M = 0.38;

// Subtle now, not structural: the texture carries the colour, so this only
// breaks up repetition between neighbouring tufts. The old palette had to
// BE the colour, which is why it was so much stronger.
// Lush natural botanical garden grass palette
const TINT = [
    new THREE.Color(0x569632), // rich vibrant meadow green
    new THREE.Color(0x428024), // deep emerald turf green
    new THREE.Color(0x6cae3c), // sunlit bright spring green
    new THREE.Color(0x4d8c2c), // lush botanical lawn green
    new THREE.Color(0x386e1e)  // deep lush shade green
];

/**
 * A minimal splittable RNG so the field is reproducible across a reload
 * without depending on Math.random's global state.
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Root-pinned wind plus per-instance tint, injected into a card's material.
 *
 * Displacement grows with height^2 so the base stays planted in the soil and
 * the tip carries almost all the motion -- steeper than the tree canopy's
 * compliance curve, which is right for grass rooted straight in the ground
 * rather than a leaf hanging off flexible wood. Shares `windUniforms` with
 * the trees, so one gust crosses the whole garden together instead of the
 * grass and the canopy drifting out of phase.
 */
function injectGrassShader(material, localH) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uWindTime = windUniforms.uWindTime;
        shader.uniforms.uWindStrength = windUniforms.uWindStrength;
        shader.vertexShader = `
uniform float uWindTime;
uniform float uWindStrength;
attribute vec3 aGrassColor;
varying vec3 vGrassColor;
varying float vGrassHeightRatio;
` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `
#include <begin_vertex>
vGrassColor = aGrassColor;
{
#ifdef USE_INSTANCING
    vec4 wPos = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
#else
    vec4 wPos = modelMatrix * vec4(transformed, 1.0);
#endif
    float heightRatio = clamp(transformed.y / ${Math.max(localH, 0.001).toFixed(4)}, 0.0, 1.0);
    vGrassHeightRatio = heightRatio;
    // Blade compliance: smooth curve so the whole blade body sways gracefully
    float root = pow(heightRatio, 1.45);

    // Rolling gentle wind wave across the field
    vec2 windDir = normalize(vec2(0.82, 0.57));
    float wavePhase = dot(wPos.xz, windDir) * 0.18 - uWindTime * 1.65;
    float crossPhase = dot(wPos.xz, vec2(-windDir.y, windDir.x)) * 0.14;
    float wave = sin(wavePhase) * 0.72 + sin(wavePhase * 1.85 + crossPhase) * 0.28;

    // Organic tip flutter on individual tufts
    float tipFlutter = sin(uWindTime * 3.8 + dot(wPos.xz, vec2(2.1, 1.8))) * 0.22;
    float sway = wave + tipFlutter;

    // Rich, visible flowing wind amplitude
    float swell = sin(uWindTime * 0.9 + dot(wPos.xz, vec2(0.04, 0.03))) * 0.20 + 0.80;
    float amp = (uWindStrength * swell + 0.045) * ${(localH * 2.10).toFixed(4)} * root;

    transformed.x += (windDir.x * sway + (-windDir.y) * sin(wavePhase * 1.3) * 0.16) * amp;
    transformed.z += (windDir.y * sway + (windDir.x) * sin(wavePhase * 1.3) * 0.16) * amp;
    // Natural tip downward bend under breeze (preserves apparent blade length)
    transformed.y -= (abs(sway) * 0.22 + (sway * sway) * 0.16) * amp * heightRatio;
}
`
        );

        shader.fragmentShader = `
varying vec3 vGrassColor;
varying float vGrassHeightRatio;
` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `
#include <color_fragment>
// Multiply by lush green instance tint
diffuseColor.rgb *= vGrassColor * 1.35;

// Chlorophyll sunlight transmission: upper blades catch vibrant spring emerald
float tipSun = smoothstep(0.18, 0.95, vGrassHeightRatio);
vec3 chlorophyll = vec3(diffuseColor.g * 0.72, diffuseColor.g * 1.15, diffuseColor.g * 0.35);
diffuseColor.rgb = mix(diffuseColor.rgb, chlorophyll, 0.38 * tipSun);

// Ground contact occlusion: darkens roots into the soil
float contactAO = mix(0.50, 1.0, smoothstep(0.02, 0.42, vGrassHeightRatio));
diffuseColor.rgb *= contactAO;
`
        );
    };
    material.needsUpdate = true;
}

/**
 * Builds the grass field from the extracted card asset.
 *
 * @param {object} cardsGltf  a loaded card asset (models/meadow_clumps.glb)
 * @param {number} outerR     radius of the disc grass is scattered within
 * @param {number} count      total tufts across all card types
 * @returns {THREE.Group}     one InstancedMesh per card type
 */
export function createGrassField(cardsGltf, outerR = 41, count = 14000, opts = {}) {
    const {
        targetHeight = GRASS_HEIGHT_M, name = 'GrassField', clearMargin = 0,
        filter = null,        // RegExp on mesh name: which card types to use
        innerR = 0,           // scatter in a ring rather than the full disc
        center = null,        // { x, z }: scatter around this instead of the origin
        accept = null,        // (x, z) => bool, on top of isGroundClear
        tints = TINT, seed = 20260906
    } = opts;
    const group = new THREE.Group();
    group.name = name;

    const cards = [];
    if (cardsGltf && cardsGltf.scene) {
        cardsGltf.scene.traverse((child) => {
            if (child.isMesh && child.geometry && child.material && (!filter || filter.test(child.name))) cards.push(child);
        });
    }
    if (cards.length === 0) {
        console.warn(`[grass] no cards for ${name} -- field will be empty`);
        return group;
    }

    const rand = mulberry32(seed);
    const perCard = Math.ceil(count / cards.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    cards.forEach((card) => {
        const geometry = card.geometry.clone();
        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox;
        const cx = (bbox.min.x + bbox.max.x) * 0.5;
        const cz = (bbox.min.z + bbox.max.z) * 0.5;
        const minY = bbox.min.y;
        // Center card horizontally so rotations don't swing it eccentrically,
        // and align base to y=0 so bottom is planted in ground instead of 50% buried.
        geometry.translate(-cx, -minY, -cz);
        geometry.computeBoundingBox();

        const localH = Math.max(geometry.boundingBox.max.y, 1e-4);
        const cardScale = targetHeight / localH;

        const material = card.material.clone();
        material.side = THREE.DoubleSide;      // crossed quads, read from every angle
        // Respect an authored alphaTest; the meadow clumps are BLEND, so they get 0.2.
        material.alphaTest = material.alphaTest > 0 ? material.alphaTest : 0.2;
        material.transparent = false;          // cutout, not blended -- keeps depth sane
        material.depthWrite = true;

        const mesh = new THREE.InstancedMesh(geometry, material, perCard);
        mesh.castShadow = false;               // 14k tufts in the shadow pass buys nothing at this scale
        mesh.receiveShadow = true;

        const instanceColors = new Float32Array(perCard * 3);
        geometry.setAttribute('aGrassColor', new THREE.InstancedBufferAttribute(instanceColors, 3));

        let placed = 0, attempts = 0;
        const maxAttempts = perCard * 4;
        while (placed < perCard && attempts < maxAttempts) {
            attempts++;
            // Even area density across the disc or ring, not centre-clumped.
            const r = Math.sqrt(innerR * innerR + rand() * (outerR * outerR - innerR * innerR));
            const theta = rand() * Math.PI * 2;
            const x = Math.cos(theta) * r + (center ? center.x : 0);
            const z = Math.sin(theta) * r + (center ? center.z : 0);
            if (!isGroundClear(x, z, clearMargin)) continue;
            if (accept && !accept(x, z)) continue;

            dummy.position.set(x, groundHeightAt(x, z), z);
            dummy.rotation.set(0, rand() * Math.PI * 2, 0);
            const s = cardScale * (1.10 + rand() * 0.40);
            dummy.scale.set(s * (1.12 + rand() * 0.20), s, s * (1.12 + rand() * 0.20));
            dummy.updateMatrix();
            mesh.setMatrixAt(placed, dummy.matrix);

            color.copy(tints[Math.floor(rand() * tints.length)])
                .offsetHSL((rand() - 0.5) * 0.02, (rand() - 0.5) * 0.04, (rand() - 0.5) * 0.05);
            instanceColors[placed * 3] = color.r;
            instanceColors[placed * 3 + 1] = color.g;
            instanceColors[placed * 3 + 2] = color.b;
            placed++;
        }

        mesh.count = placed;
        mesh.userData.baseCount = placed;      // the adaptive scaler's draw-range lever
        mesh.instanceMatrix.needsUpdate = true;
        geometry.attributes.aGrassColor.needsUpdate = true;

        // Three culls an InstancedMesh against its GEOMETRY's bounding sphere,
        // which here describes one card at the origin, not the scattered field.
        // Left alone, the whole field pops out the moment that origin card
        // leaves frame, so it has to be widened by hand to the real extent.
        geometry.computeBoundingSphere();
        geometry.boundingSphere.center.set(center ? center.x : 0, 0, center ? center.z : 0);
        geometry.boundingSphere.radius = outerR + 2;
        mesh.frustumCulled = true;

        injectGrassShader(material, localH);
        group.add(mesh);
    });

    return group;
}
