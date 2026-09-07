import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Foliage wind: a GPU vertex-shader displacement shared by every material that
// opts in, driven by one uniform block so every leaf in the garden moves in
// the same weather.
//
// The three things that make wind on foliage go wrong, all documented in
// references/vegetation-and-wind.md, and all guarded against here:
//
// 1. Amplitude sized from the wrong geometry. `transformed` in a vertex
//    shader is the vertex position BEFORE any instance/model transform, so
//    displacement has to be sized against the mesh's OWN bounding box -- not
//    the finished object's world size, and not a whole model's extent if the
//    mesh being deformed is only part of it. Get this wrong on an instanced
//    mesh and the (wrongly-sized) displacement gets re-scaled and scattered
//    across every instance, shredding the canopy.
// 2. A frame-rate-dependent clock. uWindTime is driven from real elapsed
//    seconds (see updateWindEnvelope), never a per-frame counter.
// 3. A wind gate that sways the wrong geometry. isFoliageForWind() is a
//    POSITIVE test -- name-like-a-leaf OR alpha-blended, then excluding
//    anything trunk-like -- not a reuse of whatever regex happens to gate
//    alpha-cutout shadow handling. Matching neither list means no wind,
//    which is the safe way to be wrong.
// ---------------------------------------------------------------------------

export const windUniforms = {
    uWindTime: { value: 0 },
    uWindStrength: { value: 0 }
};

// A flower stalk or a maple leaf mass reads as leafy; the load-bearing wood
// underneath it never should, however its material happens to be named.
const LEAFY = /leaf|leaves|foliage|frond|petal|flower|blossom|canopy|needle|twig|stalk|bud/i;
const WOODY = /trunk|bark|wood|stem|log|root|limb|timber|branch|shu[_ -]?gan/i;

/**
 * Positive test for "should this mesh sway" -- never a reuse of the alpha-
 * cutout test in enhanceFoliageMaterial, which matches things (a bare "mat",
 * `00[1-4]`) that are structural, not foliage.
 *
 * The maple's canopy material is literally named `Material_Mat` -- no leafy
 * word anywhere -- so the alpha-blend fallback is what catches it; its trunk
 * material is `shu_gan_Mat` (树干, Chinese for "tree trunk"), which the WOODY
 * pattern excludes explicitly since no English word would.
 */
export function isFoliageForWind(mesh, material) {
    const label = `${mesh.name || ''} ${material.name || ''}`;
    if (WOODY.test(label)) return false;
    return LEAFY.test(label) || material.transparent === true || (material.alphaTest || 0) > 0;
}

/**
 * Attaches wind displacement to a material via onBeforeCompile. Call this
 * BEFORE any code that converts the material's transparency (e.g. the
 * BLEND -> alphaTest rewrite in enhanceFoliageMaterial) if you need the
 * pre-conversion `material.transparent` flag for isFoliageForWind -- once
 * that rewrite runs, `transparent` is false on every leaf material and the
 * alpha-blend branch of the gate goes blind.
 *
 * @param {THREE.Mesh} mesh
 * @param {THREE.Material} material
 * @param {object} opts
 * @param {number} opts.swayFraction  amplitude as a fraction of the mesh's
 *   OWN bounding-box extent (never the model's, never a world-space metre value)
 * @param {number} opts.speedMult     per-species speed multiplier
 */
export function injectFoliageWind(mesh, material, { swayFraction = 0.045, speedMult = 1.0 } = {}) {
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1e-4);
    const amplitude = swayFraction * size;
    const baseY = bb.min.y;
    const height = Math.max(bb.max.y - bb.min.y, 1e-4);

    // Distinct compiled programs per (amplitude, speed) pair -- reusing one
    // program across species/meshes with different constants baked into the
    // GLSL string would silently apply the FIRST mesh's amplitude to all of
    // them, since Three caches by material unless told the key differs.
    const cacheKey = `foliageWind_${amplitude.toFixed(4)}_${speedMult.toFixed(3)}`;
    material.customProgramCacheKey = () => cacheKey;

    const inject = (shader) => {
        shader.uniforms.uWindTime = windUniforms.uWindTime;
        shader.uniforms.uWindStrength = windUniforms.uWindStrength;

        shader.vertexShader = `
uniform float uWindTime;
uniform float uWindStrength;
` + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `
#include <begin_vertex>
{
#ifdef USE_INSTANCING
    vec4 wPos = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
#else
    vec4 wPos = modelMatrix * vec4(transformed, 1.0);
#endif
    // Grove-scale wave: long wavelength, so it moves branches relative to
    // each other rather than translating the whole mesh as one rigid body
    // (rigid translation barely reads as motion at all).
    float wavePhase = dot(wPos.xz, vec2(0.7, 0.7)) * 0.075 - uWindTime * ${(1.5 * speedMult).toFixed(4)};
    float wave = sin(wavePhase) * 0.72 + sin(wavePhase * 2.15 + 1.1) * 0.28;

    // Leaf-scale flutter: phase from LOCAL position, not world position -- a
    // world-space phase term varies across a single leaf's own vertices and
    // tears it apart instead of fluttering it as a whole.
    float flutter = sin(uWindTime * ${(5.0 * speedMult).toFixed(4)} + dot(transformed.xyz, vec3(3.0))) * 0.05;

    // Base of the mesh stays anchored, the tip responds fully -- normalised
    // to THIS mesh's own bounding box, not an assumed metre-scale space.
    float compliance = clamp((wPos.y - modelMatrix[3].y - (${baseY.toFixed(4)})) / ${height.toFixed(4)}, 0.0, 1.0);
    compliance = mix(0.55, 1.0, compliance);

    float amp = uWindStrength * ${amplitude.toFixed(5)} * compliance;
    transformed.x += (wave * 0.82 + flutter * 0.3) * amp;
    transformed.z += (wave * 0.62 + flutter * 0.3) * amp;
    transformed.y += -abs(wave) * amp * 0.14;
}
`
        );
    };

    material.onBeforeCompile = inject;
    material.needsUpdate = true;

    // The shadow must move with the leaf, or a swaying canopy casts a rigid
    // shadow that visibly detaches from it. Same injection, same uniforms --
    // but NOT the same cacheKey. Every leaf/flower/bud mesh gets its own
    // MeshDepthMaterial with a DIFFERENT amplitude baked into its GLSL, and
    // without a distinguishing key here, Three treats them as
    // interchangeable and reuses whichever depth program compiled first --
    // silently rendering some meshes' shadows with another mesh's amplitude
    // and wave phase. That mismatch is what produced a chaotic, flickering,
    // "pixelated" shadow: not a resolution problem, a wrong-constants one.
    if (mesh.customDepthMaterial) {
        mesh.customDepthMaterial.customProgramCacheKey = () => cacheKey + '_depth';
        mesh.customDepthMaterial.onBeforeCompile = inject;
        mesh.customDepthMaterial.needsUpdate = true;
    }
}

// ---------------------------------------------------------------------------
// The wind envelope: turns a single strength into weather rather than a fan
// left on. A slow gate lulls to near-zero for a while, eases back over a few
// seconds, and three detuned (non-harmonic) sine terms keep even a sustained
// "breezy" stretch wandering instead of holding one fixed value.
// ---------------------------------------------------------------------------
const BASE_STRENGTH = 0.15;   // was 0.30 -- read as trees wobbling, not swaying

export function createWindEnvelope() {
    return { gate: 1, target: 1, hold: 6 + Math.random() * 10 };
}

/**
 * @param {object} env   from createWindEnvelope(), mutated in place
 * @param {number} dt    real seconds
 * @param {number} elapsedSeconds  real accumulated seconds, for uWindTime
 */
export function updateWindEnvelope(env, dt, elapsedSeconds) {
    env.hold -= dt;
    if (env.hold <= 0) {
        const goingCalm = env.target > 0.5;
        env.target = goingCalm ? 0 : 1;
        // Calm stretches shorter than breezy ones, or the garden reads as
        // still more often than it reads as windy.
        env.hold = goingCalm ? (8 + Math.random() * 10) : (35 + Math.random() * 45);
    }
    env.gate += (env.target - env.gate) * (1 - Math.exp(-dt / 4.0));

    const t = elapsedSeconds;
    const gust = 0.62 + Math.sin(t * 0.23) * 0.20 + Math.sin(t * 0.61 + 1.7) * 0.12 + Math.sin(t * 1.13 + 4.2) * 0.06;

    windUniforms.uWindTime.value = elapsedSeconds * 1.4;
    windUniforms.uWindStrength.value = BASE_STRENGTH * env.gate * Math.max(0, gust);
}
