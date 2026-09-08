import * as THREE from 'three';
import { isGroundClear, groundHeightAt } from './garden.js';
import { windUniforms } from './wind.js';

// ---------------------------------------------------------------------------
// Grass.
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
const GRASS_HEIGHT_M = 0.30;

// Subtle now, not structural: the texture carries the colour, so this only
// breaks up repetition between neighbouring tufts. The old palette had to
// BE the colour, which is why it was so much stronger.
const TINT = [
    new THREE.Color(0xffffff),
    new THREE.Color(0xe8f0d8),
    new THREE.Color(0xd2ddc0),
    new THREE.Color(0xc2d2ac),
    new THREE.Color(0xdfe8cf)
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
function injectGrassShader(material, cardHeight) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uWindTime = windUniforms.uWindTime;
        shader.uniforms.uWindStrength = windUniforms.uWindStrength;
        shader.vertexShader = `
uniform float uWindTime;
uniform float uWindStrength;
attribute vec3 aGrassColor;
varying vec3 vGrassColor;
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
    float heightRatio = clamp(transformed.y / ${Math.max(cardHeight, 0.001).toFixed(4)}, 0.0, 1.0);
    float root = heightRatio * heightRatio;
    float phase = dot(wPos.xz, vec2(0.7, 0.7)) * 0.12 - uWindTime * 1.7;
    float sway = sin(phase) * 0.7 + sin(phase * 1.8 + wPos.x * 0.9) * 0.3;
    // 0.72, against the canopy's much smaller swayFraction: grass is light and
    // should visibly answer a gust that a heavy branch barely registers. At the
    // envelope's peak strength (0.15) this is ~3cm of tip travel on a 30cm
    // tuft -- gentle, a breath rather than a gale.
    float amp = uWindStrength * ${(cardHeight * 0.72).toFixed(4)} * root;
    transformed.x += sway * amp;
    transformed.z += sway * amp * 0.6;
}
`
        );

        // Colour travels through a varying we own end to end, rather than
        // Three's built-in vertexColors/instanceColor path -- that path
        // measured as silently broken on this build: USE_INSTANCING_COLOR
        // never made it into the compiled shader despite a valid, populated
        // InstancedBufferAttribute, so every instance rendered at vColor's
        // uninitialised default of black. Verified by dumping the actual
        // compiled vertexShader source, not inferred from setColorAt
        // appearing to succeed.
        shader.fragmentShader = `
varying vec3 vGrassColor;
` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `
#include <color_fragment>
diffuseColor.rgb *= vGrassColor;
`
        );
    };
    material.needsUpdate = true;
}

/**
 * Builds the grass field from the extracted card asset.
 *
 * @param {object} cardsGltf  loaded models/grass_cards.glb (6 card meshes)
 * @param {number} outerR     radius of the disc grass is scattered within
 * @param {number} count      total tufts across all card types
 * @returns {THREE.Group}     one InstancedMesh per card type
 */
export function createGrassField(cardsGltf, outerR = 41, count = 14000, opts = {}) {
    const { targetHeight = GRASS_HEIGHT_M, name = 'GrassField', clearMargin = 0 } = opts;
    const group = new THREE.Group();
    group.name = name;

    const cards = [];
    if (cardsGltf && cardsGltf.scene) {
        cardsGltf.scene.traverse((child) => {
            if (child.isMesh && child.geometry && child.material) cards.push(child);
        });
    }
    if (cards.length === 0) {
        console.warn('[grass] no cards in grass_cards.glb -- field will be empty');
        return group;
    }

    const rand = mulberry32(20260906);
    const perCard = Math.ceil(count / cards.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    cards.forEach((card) => {
        const geometry = card.geometry.clone();
        geometry.computeBoundingBox();
        const localH = Math.max(geometry.boundingBox.max.y - geometry.boundingBox.min.y, 1e-4);
        const cardScale = targetHeight / localH;
        const cardHeight = targetHeight;

        const material = card.material.clone();
        material.side = THREE.DoubleSide;      // crossed quads, read from every angle
        material.alphaTest = Math.max(material.alphaTest || 0, 0.4);
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
            const r = Math.sqrt(rand()) * outerR;   // even area density, not centre-clumped
            const theta = rand() * Math.PI * 2;
            const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
            if (!isGroundClear(x, z, clearMargin)) continue;

            dummy.position.set(x, groundHeightAt(x, z), z);
            dummy.rotation.set(0, rand() * Math.PI * 2, 0);
            const s = cardScale * (0.8 + rand() * 0.5);
            dummy.scale.set(s, s, s);
            dummy.updateMatrix();
            mesh.setMatrixAt(placed, dummy.matrix);

            color.copy(TINT[Math.floor(rand() * TINT.length)])
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
        geometry.boundingSphere.center.set(0, 0, 0);
        geometry.boundingSphere.radius = outerR + 2;
        mesh.frustumCulled = true;

        injectGrassShader(material, cardHeight);
        group.add(mesh);
    });

    return group;
}
