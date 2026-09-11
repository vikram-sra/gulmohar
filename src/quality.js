import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Quality tiers.
//
// The scene is fill-rate bound, not draw-call bound: ~1.15M double-sided
// alpha-tested triangles against ~50 draw calls and a fraction of a millisecond
// of CPU submission. So the knobs that matter are the ones that reduce shaded
// fragments and shaded geometry -- instance counts, sidedness, shadow map size
// and pixel ratio -- not batching.
//
// Before this existed, "mobile" changed only antialias, pixel ratio, shadow map
// size, grass count and anisotropy. Geometry, instance counts and sidedness
// were IDENTICAL on a phone, which is the classic "fine on desktop, dies on
// mobile" shape.
//
// QUALITY is mutated in place and never reassigned, so any module can hold the
// imported reference and read live values.
// ---------------------------------------------------------------------------

const TIERS = {
    low: {
        floorLeafCount: 10, microPlantCount: 16,
        grassCount: 18000, grassRadius: 36, backgroundTrees: 2, vegClumpCount: 20, denseGrassCount: 6,
        shadowMapSize: 1024, shadowIntervalMs: 45, shadowType: THREE.PCFShadowMap,
        shadowRadius: 1.0, foliageReceiveShadow: false,
        pixelRatioCap: 1.0, antialias: false, anisotropy: 2,
        canopySide: THREE.DoubleSide,
        skySegW: 16, skySegH: 12, dustCount: 0
    },
    medium: {
        floorLeafCount: 24, microPlantCount: 34,
        grassCount: 32000, grassRadius: 41, backgroundTrees: 2, vegClumpCount: 40, denseGrassCount: 12,
        shadowMapSize: 2048, shadowIntervalMs: 28, shadowType: THREE.PCFShadowMap,
        shadowRadius: 1.4, foliageReceiveShadow: true,
        pixelRatioCap: 1.25, antialias: false, anisotropy: 4,
        canopySide: THREE.DoubleSide,
        skySegW: 24, skySegH: 16, dustCount: 60
    },
    high: {
        floorLeafCount: 45, microPlantCount: 60,
        grassCount: 46000, grassRadius: 41, backgroundTrees: 2, vegClumpCount: 60, denseGrassCount: 16,
        // PCFShadowMap on all tiers. In Three.js v0.182, PCFShadowMap provides
        // hardware depth comparison filtering with Vogel disk / IGN sampling
        // and honors shadow.radius (1.8), giving organic dappled leaf shadows
        // without pixel-stair artifacts or the fallback to basic 1-tap shadows.
        shadowMapSize: 2048, shadowIntervalMs: 0, shadowType: THREE.PCFShadowMap,
        shadowRadius: 1.8, foliageReceiveShadow: true,
        pixelRatioCap: 1.5, antialias: true, anisotropy: 8,
        canopySide: THREE.DoubleSide,
        skySegW: 32, skySegH: 24, dustCount: 100
    }
};

// NOTE: `canopySide` is DoubleSide on every tier, and that is deliberate.
// Dropping canopies to FrontSide looked like free budget on paper -- ~500k
// alpha-tested triangles shaded once instead of twice -- but each leaf is a
// single plane, so culling back faces deletes roughly half the leaf cards
// outright. Measured on the low tier it took the gulmohar from full to
// visibly bald, branches showing through. Trunks are a different case: they
// are closed opaque solids, so FrontSide there is genuinely free and is
// applied at every tier (see enhanceFoliageMaterial). The mobile saving comes
// from scatter density, grass, shadow map size and pixel ratio instead.

const ORDER = ['low', 'medium', 'high'];

export const QUALITY = { tier: 'high', adaptive: true, ...TIERS.high };

/**
 * Reads the GPU string from a throwaway context, so the tier can be resolved
 * BEFORE the real renderer is constructed -- `antialias` is a constructor
 * option and cannot be changed afterwards.
 */
function probeRenderer() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return typeof name === 'string' ? name : null;
    } catch {
        return null;
    }
}

/**
 * Picks a tier by scoring DOWN from `high`. No signal is ever allowed to
 * promote, because every signal available in a browser is far better at
 * proving a device is weak than at proving it is strong.
 */
export function resolveQuality() {
    const params = new URLSearchParams(location.search);

    // Explicit override always wins -- needed to screenshot all three tiers.
    const forced = params.get('q');
    if (forced && TIERS[forced]) return apply(forced, `?q=${forced}`);

    // The editor pins high and disables adaptation: a pixel ratio that drops
    // while you are placing a painting is confusing, not helpful.
    if (params.has('edit')) {
        apply('high', 'editor');
        QUALITY.adaptive = false;
        return QUALITY;
    }

    const gpu = probeRenderer() || '';
    const reasons = [];
    let score = 0;

    // Software rasterisers are not worth attempting the full scene on.
    if (/SwiftShader|llvmpipe|Software|Microsoft Basic/i.test(gpu)) {
        reasons.push(`software renderer (${gpu})`);
        return apply('low', reasons.join(', '));
    }

    // Mobile/integrated GPU families. Note this string is unreliable on Apple
    // hardware -- every Apple device reports "Apple GPU" -- and Safari 17+ and
    // Firefox-RFP return generic strings, so it can only ever demote.
    if (/Mali|Adreno \(TM\) [45]|PowerVR|Videocore/i.test(gpu)) { score -= 3; reasons.push(`mobile GPU (${gpu})`); }
    else if (/Intel.*(HD|UHD) Graphics/i.test(gpu)) { score -= 2; reasons.push(`integrated GPU (${gpu})`); }

    // A coarse pointer plus multi-touch is what actually identifies a tablet or
    // phone. The old UA regex missed modern iPads entirely, because iPadOS 13+
    // reports itself as a Mac -- so they were silently getting desktop settings.
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches === true;
    const touch = (navigator.maxTouchPoints || 0) > 1;
    const physicalPx = (window.screen?.width || 0) * (window.devicePixelRatio || 1);
    if (coarse && touch) {
        score -= 2;
        reasons.push('touch device');
        // Physical pixels is the signal that actually correlates here, because
        // the bottleneck is overdraw and overdraw scales with pixel count.
        if (physicalPx >= 1200) { score -= 1; reasons.push(`${Math.round(physicalPx)} physical px`); }
    }

    // Chromium-only, bucketed, and absent on Safari/Firefox -- demote only.
    if (navigator.deviceMemory !== undefined && navigator.deviceMemory <= 4) {
        score -= 2; reasons.push(`deviceMemory ${navigator.deviceMemory}GB`);
    }
    // Reports 8 for both a flagship phone and a weak laptop -- demote only.
    if (navigator.hardwareConcurrency !== undefined && navigator.hardwareConcurrency <= 4) {
        score -= 1; reasons.push(`${navigator.hardwareConcurrency} cores`);
    }

    const tier = score <= -3 ? 'low' : score <= -1 ? 'medium' : 'high';
    return apply(tier, reasons.length ? reasons.join(', ') : 'no demoting signals');
}

function apply(tier, reason) {
    Object.assign(QUALITY, TIERS[tier]);
    QUALITY.tier = tier;
    QUALITY.reason = reason;
    QUALITY.adaptive = true;
    QUALITY.ceiling = tier;          // adaptation may never promote above this
    QUALITY.pixelRatioScale = 1;     // runtime multiplier on pixelRatioCap
    QUALITY.instanceScale = 1;       // runtime multiplier on instance counts
    return QUALITY;
}

// ---------------------------------------------------------------------------
// Runtime adaptation.
//
// Only two things are safe to change mid-session:
//   * pixel ratio  -- instant, and the single biggest fill lever
//   * InstancedMesh.count -- Three treats it as a draw RANGE, so lowering it
//     costs nothing; no reallocation, no matrix re-upload
// Material.side is deliberately NOT adaptive: flipping it sets needsUpdate and
// recompiles ~14 canopy materials, a multi-hundred-millisecond freeze arriving
// exactly when the device is already struggling.
// ---------------------------------------------------------------------------

const WINDOW = 60;
const samples = [];
let warmup = 90;
let slowWindows = 0, fastWindows = 0, steps = 0, oscillations = 0, lastChangeAt = 0;

export function resetAdaptive() {
    samples.length = 0;
    warmup = 90;
    slowWindows = fastWindows = 0;
}

/**
 * Feed one frame. Returns a descriptor when something should change, else null.
 *
 * `wasShadowFrame` must be true on frames where the shadow map re-rendered.
 * The cadence makes roughly one frame in five systematically expensive, and
 * including those would drag the median onto the shadow frame and misreport
 * the steady-state cost permanently.
 */
export function sampleFrame(dtMs, wasShadowFrame) {
    // Shadow frames are excluded only when they are the exception. With an
    // every-frame cadence (interval 0) every frame is one, and excluding them
    // would leave the loop blind -- it would never adapt at all.
    if (!QUALITY.adaptive || (wasShadowFrame && QUALITY.shadowIntervalMs > 0)) return null;
    if (warmup > 0) { warmup--; return null; }   // shader compile + texture upload

    samples.push(dtMs);
    if (samples.length < WINDOW) return null;

    const sorted = samples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    samples.length = 0;

    const now = performance.now();
    if (now - lastChangeAt < 10000) return null;     // cooldown

    if (median > 22) {
        fastWindows = 0;
        if (++slowWindows < 2 || steps >= 2) return null;
        slowWindows = 0; steps++; lastChangeAt = now;
        if (steps > 0 && oscillations >= 3) { QUALITY.adaptive = false; return null; }
        return down();
    }

    if (median < 13 && steps > 0) {
        slowWindows = 0;
        if (++fastWindows < 5) return null;
        fastWindows = 0; steps--; oscillations++; lastChangeAt = now;
        if (oscillations >= 3) QUALITY.adaptive = false;   // stop hunting
        return up();
    }

    slowWindows = 0; fastWindows = 0;
    return null;
}

function down() {
    if (QUALITY.pixelRatioScale > 0.75) QUALITY.pixelRatioScale = 0.8;
    else QUALITY.instanceScale = 0.5;
    // Thin the shadow cadence too; from every-frame, step to every other.
    QUALITY.shadowIntervalMs = Math.min(120, Math.max(24, QUALITY.shadowIntervalMs * 1.6));
    return descriptor('down');
}

function up() {
    if (QUALITY.instanceScale < 1) QUALITY.instanceScale = 1;
    else QUALITY.pixelRatioScale = 1;
    QUALITY.shadowIntervalMs = TIERS[QUALITY.ceiling].shadowIntervalMs;
    return descriptor('up');
}

function descriptor(direction) {
    return {
        direction,
        pixelRatio: QUALITY.pixelRatioCap * QUALITY.pixelRatioScale,
        instanceScale: QUALITY.instanceScale,
        shadowIntervalMs: QUALITY.shadowIntervalMs
    };
}

/** Highest tier index, so callers can size buffers for the ceiling. */
export function tierMax(field) {
    return ORDER.reduce((max, t) => Math.max(max, TIERS[t][field]), 0);
}
