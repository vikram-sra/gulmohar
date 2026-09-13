import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// ---------------------------------------------------------------------------
// Depth of field: a gentle rack focus that follows the pointer (or the
// screen centre on touch), so whatever is under the cursor stays crisp and
// everything else -- distant lawn, the far canopy, a painting you are not
// looking at -- softens a little. Meant to be almost subliminal: a few
// pixels of blur, not a bokeh showreel.
//
// Two things make this cheap enough to run every frame instead of the
// disqualified BokehPass approach (a second full scene render with an
// override depth material -- doubling the ~900k-triangle main pass, and
// wrong besides, since the override material would skip the vertex-shader
// wind displacement the visible pass uses):
//
//   1. Depth comes free. RenderPass already writes it as a side effect of
//      the normal depth test; this only attaches a DepthTexture to the
//      composer's own ping-pong targets and reads it back.
//   2. Focus distance never touches the CPU. `gl.readPixels` on even a
//      single pixel is a pipeline stall -- the driver has to wait for the
//      GPU to finish before handing data back to JS, which is exactly the
//      kind of per-frame hitch this project measures against. Instead a
//      tiny 1x1 render target samples the depth texture at the pointer and
//      is eased frame to frame entirely on the GPU (blended against its own
//      previous frame, ping-ponged) -- so "what am I looking at" is a
//      texture lookup for the blur pass, never a round trip to JS.
// ---------------------------------------------------------------------------

const PACKING = THREE.ShaderChunk.packing; // perspectiveDepthToViewZ

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const PROBE_FRAG = /* glsl */`
${PACKING}
uniform sampler2D tDepth;
uniform sampler2D tPrevFocus;
uniform vec2 uPointerUV;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uEase;
varying vec2 vUv;

void main() {
    float depth = texture2D(tDepth, uPointerUV).x;
    float viewZ = perspectiveDepthToViewZ(depth, uCameraNear, uCameraFar);
    float raw = clamp(-viewZ, uCameraNear, uCameraFar);
    float prev = texture2D(tPrevFocus, vec2(0.5)).r;
    // Blended here rather than in JS: a value this tiny (one texel) round
    // -tripping through readPixels would be the exact stall this whole
    // scheme exists to avoid.
    float eased = mix(prev, raw, uEase);
    gl_FragColor = vec4(eased, eased, eased, 1.0);
}`;

function buildBlurFrag(taps) {
    return /* glsl */`
${PACKING}
#define TAP_COUNT ${taps}
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tFocus;
uniform vec2 uTexelSize;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uNearRange;
uniform float uFarRange;
uniform float uMaxBlurPx;
varying vec2 vUv;

float sceneDistance(vec2 uv) {
    float depth = texture2D(tDepth, uv).x;
    return -perspectiveDepthToViewZ(depth, uCameraNear, uCameraFar);
}

// 0 at the focal plane, ramping to 1 over uNearRange in front of it and
// uFarRange behind -- asymmetric on purpose, the way a real lens defocuses
// faster in front of the focal plane than behind it.
float coc(float dist, float focus) {
    float diff = dist - focus;
    float t = diff < 0.0 ? clamp(-diff / uNearRange, 0.0, 1.0) : clamp(diff / uFarRange, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

void main() {
    float focus = texture2D(tFocus, vec2(0.5)).r;
    vec4 centre = texture2D(tDiffuse, vUv);
    float centreCoc = coc(sceneDistance(vUv), focus);

    // The common case -- most of a frame sits near the focal plane -- exits
    // after one depth sample and one colour sample, so the full tap loop
    // only ever runs over the parts of the frame that are actually blurred.
    // The threshold is deliberately not tiny: anything under it reads as
    // fully sharp with no softening at all, which is what keeps a wide
    // "roughly in focus" middle ground of the frame genuinely crisp instead
    // of carrying a faint haze everywhere that never quite reads as either
    // sharp or blurred.
    if (centreCoc < 0.05) { gl_FragColor = centre; return; }

    const float GOLDEN = 2.399963;
    vec3 sum = centre.rgb;
    float weight = 1.0;
    float radiusPx = centreCoc * uMaxBlurPx;
    for (int i = 0; i < TAP_COUNT; i++) {
        float a = float(i) * GOLDEN;
        float r = sqrt((float(i) + 0.5) / float(TAP_COUNT));
        vec2 uv2 = vUv + vec2(cos(a), sin(a)) * r * radiusPx * uTexelSize;
        float c2 = coc(sceneDistance(uv2), focus);
        // Weighted by whichever pixel is more out of focus: a sharp edge
        // must not pick up colour bled in from a blurry background behind
        // it, but a blurry pixel still gathers normally from its neighbours.
        float w = max(centreCoc, c2);
        sum += texture2D(tDiffuse, uv2).rgb * w;
        weight += w;
    }
    gl_FragColor = vec4(sum / weight, centre.a);
}`;
}

export class DofPass extends Pass {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {{taps:number, maxBlurPx:number, nearRange?:number, farRange?:number}} opts
     */
    constructor(camera, { taps, maxBlurPx, nearRange = 6.0, farRange = 20.0 }) {
        super();
        this.camera = camera;
        this.needsSwap = true;
        // Where the effect looks: NDC-space (-1..1) on desktop, following the
        // existing pointer tracker; main.js resolves the "no pointer yet" /
        // touch case to screen centre before writing here.
        this.pointerUV = new THREE.Vector2(0.5, 0.5);
        // How fast the rack focus follows a new subject. Slower than the
        // billboard turn -- refocusing is the most noticeable thing this
        // effect does, and doing it leisurely is what keeps it feeling like
        // a lens easing across the scene rather than a spotlight snapping.
        this.easeRate = 2.0;

        const rtOpts = {
            type: THREE.HalfFloatType, format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
            depthBuffer: false, stencilBuffer: false
        };
        this._focusA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
        this._focusB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
        this._focusRead = this._focusA;
        this._focusWrite = this._focusB;

        this._probeMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tDepth: { value: null },
                tPrevFocus: { value: null },
                uPointerUV: { value: this.pointerUV },
                uCameraNear: { value: camera.near },
                uCameraFar: { value: camera.far },
                uEase: { value: 1 }
            },
            vertexShader: QUAD_VERT,
            fragmentShader: PROBE_FRAG,
            depthTest: false,
            depthWrite: false
        });
        this._probeQuad = new FullScreenQuad(this._probeMaterial);

        this._blurMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                tDepth: { value: null },
                tFocus: { value: null },
                uTexelSize: { value: new THREE.Vector2() },
                uCameraNear: { value: camera.near },
                uCameraFar: { value: camera.far },
                uNearRange: { value: nearRange },
                uFarRange: { value: farRange },
                uMaxBlurPx: { value: maxBlurPx }
            },
            vertexShader: QUAD_VERT,
            fragmentShader: buildBlurFrag(taps),
            depthTest: false,
            depthWrite: false
        });
        this._blurQuad = new FullScreenQuad(this._blurMaterial);

        // Plain passthrough for the one failure mode worth handling: if
        // attachDepthTexture() was ever skipped, sampling a null depth
        // texture would be silent-wrong (undefined depth -> undefined
        // focus) rather than loudly broken, so this copies the frame through
        // unblurred instead of guessing at a depth value.
        this._copyMaterial = new THREE.ShaderMaterial({
            uniforms: { tDiffuse: { value: null } },
            vertexShader: QUAD_VERT,
            fragmentShader: /* glsl */`
                uniform sampler2D tDiffuse;
                varying vec2 vUv;
                void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
            `,
            depthTest: false,
            depthWrite: false
        });
        this._copyQuad = new FullScreenQuad(this._copyMaterial);
    }

    render(renderer, writeBuffer, readBuffer, deltaTime) {
        // readBuffer.depthTexture is only present once main.js has attached
        // one to both of the composer's ping-pong targets. If that wiring
        // is ever skipped -- an older EffectComposer, a target swapped out
        // for some other reason -- fail open onto a plain copy rather than
        // sampling a null texture.
        if (!readBuffer.depthTexture) {
            this._copyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
            renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
            if (this.clear) renderer.clear();
            this._copyQuad.render(renderer);
            return;
        }

        const dt = Math.min(deltaTime ?? 1 / 60, 0.1);

        // 1. Probe: sample depth under the pointer, ease against last frame,
        // write the single result texel.
        const pm = this._probeMaterial.uniforms;
        pm.tDepth.value = readBuffer.depthTexture;
        pm.tPrevFocus.value = this._focusRead.texture;
        pm.uCameraNear.value = this.camera.near;
        pm.uCameraFar.value = this.camera.far;
        pm.uEase.value = 1 - Math.exp(-this.easeRate * dt);
        renderer.setRenderTarget(this._focusWrite);
        this._probeQuad.render(renderer);
        const tmp = this._focusRead; this._focusRead = this._focusWrite; this._focusWrite = tmp;

        // 2. Blur, focused on what the probe just found.
        const bm = this._blurMaterial.uniforms;
        bm.tDiffuse.value = readBuffer.texture;
        bm.tDepth.value = readBuffer.depthTexture;
        bm.tFocus.value = this._focusRead.texture;
        bm.uTexelSize.value.set(1 / readBuffer.width, 1 / readBuffer.height);
        bm.uCameraNear.value = this.camera.near;
        bm.uCameraFar.value = this.camera.far;

        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        if (this.clear) renderer.clear();
        this._blurQuad.render(renderer);
    }

    dispose() {
        this._focusA.dispose();
        this._focusB.dispose();
        this._probeMaterial.dispose();
        this._probeQuad.dispose();
        this._blurMaterial.dispose();
        this._blurQuad.dispose();
        this._copyMaterial.dispose();
        this._copyQuad.dispose();
    }
}

/**
 * Attaches a DepthTexture to both of the EffectComposer's ping-pong render
 * targets. Needed because EffectComposer's own targets carry no depth
 * texture by default, and because which of the two targets RenderPass
 * writes into alternates every frame (composer.readBuffer/writeBuffer stay
 * swapped from the previous frame's render, they are not reset per call) --
 * so only one of the pair would have a stale or missing texture attached
 * unless both get one.
 */
export function attachDepthTexture(composer) {
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
        const depthTexture = new THREE.DepthTexture(target.width, target.height);
        depthTexture.type = THREE.UnsignedShortType;
        depthTexture.format = THREE.DepthFormat;
        target.depthTexture = depthTexture;
        target.depthBuffer = true;
    }
}
