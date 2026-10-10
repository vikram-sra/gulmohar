import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// Orbit focus follows a world-space subject, so camera movement cannot rack
// focus onto grass under a dragging cursor. Walking uses a small central
// depth probe, ignores sky and eases entirely on the GPU: no readback stalls.
// The existing render depth is reused; there is no second scene render.

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
uniform vec2 uProbeStep;
uniform float uFocusDistance;
uniform bool uInitialized;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uEase;
varying vec2 vUv;

void main() {
    float prev = uInitialized ? texture2D(tPrevFocus, vec2(0.5)).r : 20.0;
    float raw = uFocusDistance;
    if (raw <= 0.0) {
        float samples[5];
        samples[0] = texture2D(tDepth, vec2(0.5)).x;
        samples[1] = texture2D(tDepth, vec2(0.5) + vec2(uProbeStep.x, 0.0)).x;
        samples[2] = texture2D(tDepth, vec2(0.5) - vec2(uProbeStep.x, 0.0)).x;
        samples[3] = texture2D(tDepth, vec2(0.5) + vec2(0.0, uProbeStep.y)).x;
        samples[4] = texture2D(tDepth, vec2(0.5) - vec2(0.0, uProbeStep.y)).x;
        for (int i = 0; i < 5; i++) {
            for (int j = 0; j < 4; j++) {
                if (samples[j] > samples[j + 1]) {
                    float tmp = samples[j]; samples[j] = samples[j + 1]; samples[j + 1] = tmp;
                }
            }
        }
        int count = 0;
        for (int i = 0; i < 5; i++) { if (samples[i] < 0.9999) count++; }
        raw = prev;
        if (count > 0) {
            int middle = (count - 1) / 2;
            for (int i = 0; i < 5; i++) {
                if (i == middle) raw = -perspectiveDepthToViewZ(samples[i], uCameraNear, uCameraFar);
            }
        }
    }
    raw = clamp(raw, max(uCameraNear, 0.5), uCameraFar);
    float eased = (!uInitialized || uFocusDistance > 0.0) ? raw : mix(prev, raw, uEase);
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

float coc(float dist, float focus) {
    float diff = dist - focus;
    float sharpBand = max(0.3, focus * 0.08);
    float separation = max(0.0, abs(diff) - sharpBand);
    float range = diff < 0.0 ? max(uNearRange, focus * 0.3) : max(uFarRange, focus * 0.8);
    float t = clamp(separation / range, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

void main() {
    float focus = texture2D(tFocus, vec2(0.5)).r;
    vec4 centre = texture2D(tDiffuse, vUv);
    float centreDistance = sceneDistance(vUv);
    float centreCoc = coc(centreDistance, focus);

    if (centreCoc < 0.05) { gl_FragColor = centre; return; }

    const float GOLDEN = 2.399963;
    vec3 sum = centre.rgb;
    float weight = 1.0;
    float radiusPx = centreCoc * uMaxBlurPx;
    for (int i = 0; i < TAP_COUNT; i++) {
        float a = float(i) * GOLDEN;
        float r = sqrt((float(i) + 0.5) / float(TAP_COUNT));
        vec2 uv2 = vUv + vec2(cos(a), sin(a)) * r * radiusPx * uTexelSize;
        float neighbourDistance = sceneDistance(uv2);
        float depthGap = abs(neighbourDistance - centreDistance);
        float w = 1.0 - smoothstep(max(0.25, centreDistance * 0.02), max(0.5, centreDistance * 0.08), depthGap);
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
        this.focusPoint = null;
        this._trackedPoint = new THREE.Vector3();
        this._viewPoint = new THREE.Vector3();
        this._hasWorldFocus = false;
        this._initialized = false;
        this.easeRate = 6.0;

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
                uProbeStep: { value: new THREE.Vector2() },
                uFocusDistance: { value: 0 },
                uInitialized: { value: false },
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

        const dt = Math.max(0, Math.min(deltaTime ?? 1 / 60, 0.1));

        // 1. Resolve the world subject or sample central geometry,
        // write the single result texel.
        const pm = this._probeMaterial.uniforms;
        pm.uFocusDistance.value = this.resolveFocusDistance(dt);
        pm.uInitialized.value = this._initialized;
        pm.uProbeStep.value.set(0.025 * readBuffer.height / readBuffer.width, 0.025);
        pm.tDepth.value = readBuffer.depthTexture;
        pm.tPrevFocus.value = this._focusRead.texture;
        pm.uCameraNear.value = this.camera.near;
        pm.uCameraFar.value = this.camera.far;
        pm.uEase.value = 1 - Math.exp(-this.easeRate * dt);
        renderer.setRenderTarget(this._focusWrite);
        this._probeQuad.render(renderer);
        this._initialized = true;
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

    // Ease subject changes in world space; convert to axial camera depth
    // after movement. Euclidean distance would be wrong off the optical axis.
    resolveFocusDistance(dt) {
        if (!this.focusPoint) {
            this._hasWorldFocus = false;
            return 0;
        }
        if (!this._hasWorldFocus) this._trackedPoint.copy(this.focusPoint);
        else this._trackedPoint.lerp(this.focusPoint, 1 - Math.exp(-this.easeRate * dt));
        this._hasWorldFocus = true;
        this.camera.updateMatrixWorld();
        this._viewPoint.copy(this._trackedPoint).applyMatrix4(this.camera.matrixWorldInverse);
        if (this._viewPoint.z >= -this.camera.near) return 0;
        return Math.min(-this._viewPoint.z, this.camera.far);
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
