import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { isGroundClear } from './garden.js';
import { windUniforms } from './wind.js';

// ---------------------------------------------------------------------------
// Instanced grass: one clump geometry, merged from a handful of thin blades,
// instanced thousands of times in a single draw call. Distribution uses
// sqrt(rand) so density is even across area rather than clumping at the
// centre, and colour comes from per-instance vertex colour rather than a
// second material, which is what keeps the whole field to one draw call.
//
// Every blade shares the wind uniforms `injectFoliageWind` writes in wind.js,
// but grass gets its OWN shader rather than that function, for one reason:
// a canopy's compliance ramp (mix(0.55, 1.0, height)) is right for a tree,
// where even the base has connected, flexible wood above it -- a grass blade
// planted directly in soil should have its root pinned at zero and bend from
// there, which wants a steeper curve (height^2) than a tree's.
// ---------------------------------------------------------------------------

const BLADE_WIDTH = 0.022;
const BLADE_LENGTH = 0.15;
const BLADES_PER_CLUMP = 3;
const SEGMENTS = 2;   // per blade; 2 segments x 3 blades ~= 12-14 triangles/clump

// Deliberately not just green: dry thatch and withering earth in the mix are
// what separate a meadow from a billiard table. Pastel-shifted toward the
// garden-plan palette (lawn #E3E7CB, bed #D7DEC0) rather than duar.one's
// saturated originals.
const PALETTE = [
    new THREE.Color(0x9cad7e),   // sun-lifted sage
    new THREE.Color(0xc3cba0),   // pale lawn
    new THREE.Color(0x6f8158),   // shaded moss
    new THREE.Color(0xc9c08f),   // dry thatch
    new THREE.Color(0x9a9068)    // withering earth
];

function createBladeGeometry(rand) {
    const lean = (rand() - 0.5) * 0.5;
    const azimuth = rand() * Math.PI * 2;
    const scale = 0.82 + rand() * 0.4;
    const width = BLADE_WIDTH * (0.85 + rand() * 0.3);

    const positions = [];
    const indices = [];
    // Rows 0..SEGMENTS-1 are (left, right) pairs; the blade converges to a
    // single TIP vertex afterward rather than a second, coincident pair.
    // Tapering the last quad to zero width put two vertices at the exact
    // same point -- a zero-area triangle whose computed normal is the zero
    // vector, which then interpolates across that whole triangle in the
    // fragment shader and renders it black regardless of lighting. A point
    // needs one vertex, not two that happen to match.
    for (let i = 0; i < SEGMENTS; i++) {
        const t = i / SEGMENTS;
        const y = t * BLADE_LENGTH * scale;
        const w = width * (1 - t) * 0.5;
        const arch = Math.pow(t, 1.5) * lean * BLADE_LENGTH * scale;   // forward bend
        positions.push(-w + arch, y, 0, w + arch, y, 0);
        if (i > 0) {
            const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    const tipIndex = positions.length / 3;
    positions.push(lean * BLADE_LENGTH * scale, BLADE_LENGTH * scale, 0);
    const lastRow = (SEGMENTS - 1) * 2;
    indices.push(lastRow, tipIndex, lastRow + 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.rotateY(azimuth);
    geo.computeVertexNormals();
    return geo;
}

function createClumpGeometry(rand) {
    const blades = [];
    for (let i = 0; i < BLADES_PER_CLUMP; i++) blades.push(createBladeGeometry(rand));
    const merged = mergeGeometries(blades, false);
    blades.forEach((g) => g.dispose());
    return merged;
}

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
 * @param {number} outerR   the disc radius grass is scattered within
 * @param {number} count    instance count -- ~7000-8000 keeps this to
 *   roughly 100k triangles in one draw call
 */
export function createGrassField(outerR = 39, count = 7000) {
    const rand = mulberry32(20260906);
    const geometry = createClumpGeometry(rand);

    const material = new THREE.MeshStandardMaterial({
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.DoubleSide
    });

    // Grass reads by count, not by per-blade shadow fidelity: 8,000 instances
    // in the shadow pass would more than double the frame's shadow cost for
    // shadows nobody can resolve at 15cm.
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = 'GrassField';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;   // one huge instanced field; per-instance culling isn't worth tracking

    // Per-instance colour via a hand-rolled InstancedBufferAttribute rather
    // than InstancedMesh.setColorAt(). setColorAt is supposed to be enough on
    // its own -- Three sets the USE_INSTANCING_COLOR shader define from
    // `object.instanceColor !== null` -- but empirically, on this build, that
    // define never made it into the compiled shader even though
    // `mesh.instanceColor` was a real, populated InstancedBufferAttribute at
    // render time: confirmed by dumping the actual compiled vertexShader
    // source, not assumed from setColorAt succeeding. Every blade rendered
    // with vColor at its uninitialised default (black), so diffuseColor.rgb
    // was black regardless of the instance data or any lighting on top of
    // it. Wiring colour through our OWN onBeforeCompile, from our OWN
    // attribute name, has no cache path left to fall through.
    const instanceColors = new Float32Array(count * 3);
    geometry.setAttribute('aGrassColor', new THREE.InstancedBufferAttribute(instanceColors, 3));

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let placed = 0;
    let attempts = 0;
    const maxAttempts = count * 4;

    while (placed < count && attempts < maxAttempts) {
        attempts++;
        const r = Math.sqrt(rand()) * outerR;               // even area density, not centre-clumped
        const theta = rand() * Math.PI * 2;
        const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
        if (!isGroundClear(x, z)) continue;

        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        const s = 0.85 + rand() * 0.5;
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(placed, dummy.matrix);

        const base = PALETTE[Math.floor(rand() * PALETTE.length)];
        color.copy(base).offsetHSL((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.05 - 0.02, (rand() - 0.5) * 0.06);
        instanceColors[placed * 3] = color.r;
        instanceColors[placed * 3 + 1] = color.g;
        instanceColors[placed * 3 + 2] = color.b;

        placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aGrassColor.needsUpdate = true;

    // Root-pinned wind: displacement grows with height^2 so the base stays
    // planted and the tip carries almost all of the motion -- steeper than
    // the tree canopy's compliance curve, which is right for a blade rooted
    // straight in soil rather than a leaf hanging off flexible wood.
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
    float heightRatio = clamp(transformed.y / ${BLADE_LENGTH.toFixed(4)}, 0.0, 1.0);
    float root = heightRatio * heightRatio;
    float phase = dot(wPos.xz, vec2(0.7, 0.7)) * 0.12 - uWindTime * 2.2;
    float sway = sin(phase) * 0.7 + sin(phase * 1.8 + dot(wPos.xz, vec3(0.9,0.4,0.0).xz)) * 0.3;
    float amp = uWindStrength * ${(BLADE_LENGTH * 0.9).toFixed(4)} * root;
    transformed.x += sway * amp;
    transformed.z += sway * amp * 0.6;
}
`
        );

        // Colour travels through a varying we own end to end, rather than
        // Three's built-in vertexColors/instanceColor path -- see the note
        // above the aGrassColor attribute for why that path measured as
        // silently broken on this build (USE_INSTANCING_COLOR never made it
        // into the compiled shader despite a valid, populated
        // InstancedBufferAttribute). Applied in `<color_fragment>`'s slot so
        // it feeds diffuseColor before the lighting pass consumes it.
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

        // A blade this thin is, from most angles, nearly edge-on to both the
        // camera and the sun -- full PBR shading correctly renders that as
        // very dim, since it's evaluating a real physical response to a
        // nearly-zero-area silhouette. That reads as "black speck," not
        // "grass." A self-illumination floor keeps every blade legible at
        // its true hue while full lighting still adds on top for whichever
        // ones do catch the sun -- the same reasoning as the palette's
        // dry-thatch/withering minority: grass needs to read as itself from
        // any angle, not only when lit face-on.
        //
        // Three 0.182's MeshStandardMaterial fragment shader has no
        // `output_fragment` chunk -- verified against the actual compiled
        // source, not assumed from an older version's template -- it goes
        // straight from lighting into `opaque_fragment`, which is where
        // `gl_FragColor` first gets written.
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            `
outgoingLight += diffuseColor.rgb * 0.32;
#include <opaque_fragment>
`
        );
    };
    material.needsUpdate = true;

    return mesh;
}
