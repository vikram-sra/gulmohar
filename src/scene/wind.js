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
const LEAFY = /leaf|leaves|foliage|frond|petal|flower|blossom|canopy|needle|twig|stalk|bud|mango|fruit|00[14]/i;
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
 * @param {number} opts.flutterMult   per-species leaf flutter intensity
 * @param {boolean} opts.isFruit      whether this mesh represents hanging fruits
 */
export function injectFoliageWind(mesh, material, {
    swayFraction = 0.045,
    speedMult = 1.0,
    flutterMult = 1.0,
    isFruit = false
} = {}) {
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1e-4);
    const amplitude = swayFraction * size;
    const baseY = bb.min.y;
    const height = Math.max(bb.max.y - bb.min.y, 1e-4);

    // Distinct compiled programs per (amplitude, speed, flutter, fruit) tuple
    const cacheKey = `foliageWind_${amplitude.toFixed(4)}_${speedMult.toFixed(3)}_${flutterMult.toFixed(2)}_${isFruit ? 'f' : 'l'}`;
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
    // Smooth grove-scale wave: wavelength moves branches and canopies naturally
    float wavePhase = dot(wPos.xz, vec2(0.65, 0.75)) * 0.12 - uWindTime * ${(1.35 * speedMult).toFixed(4)};
    float wave = sin(wavePhase) * 0.70 + sin(wavePhase * 2.1 + 1.1) * 0.30;

    // Height compliance: base of mesh stays anchored, upper canopy moves freely
    float compliance = clamp((transformed.y - (${baseY.toFixed(4)})) / ${height.toFixed(4)}, 0.0, 1.0);
    compliance = mix(0.50, 1.0, compliance);

    float amp = uWindStrength * ${amplitude.toFixed(5)} * compliance;
` + (isFruit ? `
    // Hanging fruit dynamics: graceful pendular sway with inertia and subtle bob
    float fruitPhase = dot(transformed.xyz, vec3(2.4, 1.8, 3.1));
    float fruitSwing = sin(uWindTime * ${(2.2 * speedMult).toFixed(4)} + fruitPhase) * 0.85
                     + sin(uWindTime * ${(3.3 * speedMult).toFixed(4)} + fruitPhase * 1.4) * 0.35;
    float fruitBob = cos(uWindTime * ${(2.6 * speedMult).toFixed(4)} + fruitPhase) * 0.22;

    transformed.x += (wave * 0.72 + fruitSwing * 0.55) * amp;
    transformed.z += (wave * 0.58 + fruitSwing * 0.45) * amp;
    transformed.y += (fruitBob * 0.35 - abs(wave) * 0.12) * amp;
` : `
    // Gentle, natural leaf flutter & rustle across individual leaf clusters
    float leafPhase = dot(transformed.xyz, vec3(4.8, 3.2, 4.1));
    float flutter = (sin(uWindTime * ${(3.6 * speedMult).toFixed(4)} + leafPhase) * 0.70
                   + sin(uWindTime * ${(5.2 * speedMult).toFixed(4)} + leafPhase * 1.5) * 0.30) * ${(0.42 * flutterMult).toFixed(4)};

    transformed.x += (wave * 0.78 + flutter * 0.48) * amp;
    transformed.z += (wave * 0.58 + flutter * 0.42) * amp;
    transformed.y += (-abs(wave) * 0.15 + sin(uWindTime * ${(4.2 * speedMult).toFixed(4)} + leafPhase) * ${(0.22 * flutterMult).toFixed(4)}) * amp;
`) + `
}
`
        );
    };

    // A bare assignment here silently drops whatever onBeforeCompile the
    // material already carried -- which is what threw away the pastel colour
    // grade on exactly the meshes that sway (every leaf and flower), leaving
    // the canopy vivid while the trunk graded correctly. Chain instead.
    if (material.userData.__preWindCompile === undefined) {
        material.userData.__preWindCompile = material.onBeforeCompile || null;
    }
    const preWind = material.userData.__preWindCompile;
    material.onBeforeCompile = preWind
        ? function (shader, renderer) { preWind.call(this, shader, renderer); inject(shader, renderer); }
        : inject;
    material.needsUpdate = true;

    // The shadow pass does not use this material -- it renders the scene again
    // through a depth material, which knows nothing about the displacement
    // above. So a canopy that swayed cast a shadow that did not: the leaves
    // moved and their shadows sat perfectly still underneath them. Give the
    // depth material the same injection and the two agree.
    //
    // Its own cache key, or Three hands it the lit material's compiled program
    // and the shadow renders as a lit surface.
    const depth = mesh.customDepthMaterial;
    if (depth && !depth.userData.__windInjected) {
        depth.userData.__windInjected = true;
        depth.customProgramCacheKey = () => `${cacheKey}_depth`;
        const preDepth = depth.onBeforeCompile || null;
        depth.onBeforeCompile = preDepth
            ? function (shader, renderer) { preDepth.call(this, shader, renderer); inject(shader, renderer); }
            : inject;
        depth.needsUpdate = true;
    }

    // The depth pass deliberately does NOT get the wind: shadow map caching
    // requires static caster positions to prevent 12Hz shadow strobing.
}

// ---------------------------------------------------------------------------
// The wind envelope: turns a single strength into weather rather than a fan
// left on. A slow gate lulls to a gentle ambient floor, eases back over a few
// seconds, and detuned sine terms keep sustained breezes wandering naturally.
// ---------------------------------------------------------------------------
const BASE_STRENGTH = 0.26;

export function createWindEnvelope() {
    return { gate: 0.7, target: 1.0, hold: 8 + Math.random() * 8 };
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
        // Keep a gentle continuous ambient floor (~0.35) during calm lulls
        // so the grass and leaves never freeze completely solid
        env.target = goingCalm ? 0.35 : 1.0;
        env.hold = goingCalm ? (5 + Math.random() * 6) : (25 + Math.random() * 35);
    }
    env.gate += (env.target - env.gate) * (1 - Math.exp(-dt / 3.5));

    const t = elapsedSeconds;
    const gust = 0.65 + Math.sin(t * 0.22) * 0.18 + Math.sin(t * 0.58 + 1.5) * 0.12 + Math.sin(t * 1.05 + 3.8) * 0.05;

    windUniforms.uWindTime.value = elapsedSeconds * 1.35;
    windUniforms.uWindStrength.value = BASE_STRENGTH * env.gate * Math.max(0.25, gust);
}
