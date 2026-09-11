import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// ---------------------------------------------------------------------------
// Physically based sky: Rayleigh + Mie + ozone in a spherical atmosphere,
// single scattering after Nishita (1993) plus Hillaire's (2020) multiple-
// scattering approximation, with the Earth parameters of Bruneton (2017).
//
// The hand-painted palette this replaces made every twilight crimson from the
// horizon to the zenith. A real clear twilight is nothing like that:
//   - toward the sun, a yellow-orange arch that reddens only right at the
//     horizon (the long, low path strips blue out first);
//   - overhead stays BLUE all through civil twilight -- by then mostly because
//     ozone's Chappuis band absorbs orange light, not because of Rayleigh;
//   - opposite the sun, the blue-grey Earth's shadow rises off the horizon
//     with the pink Belt of Venus (~10-20 deg up) sitting on top of it;
//   - with the sun 2-6 deg down, a rose/purple glow above the sunset point.
// Each of those falls out of the equations with no special-casing: the
// Earth's shadow and the Belt come from the planet-intersection test on the
// sun ray, the blue zenith from the ozone layer, the arch from aerosol (Mie)
// scattering, and the shadow's blue-grey fill from multiple scattering.
//
// Cost: the full integral runs into a 128x64 texture (a "sky-view LUT",
// Hillaire 2020) only when the sun has moved, and the dome just samples it.
// The multiple-scattering table does not depend on the sun, so it is baked
// once. A CPU copy of the same integral gives the few colours the lights,
// fog and pond need, so everything in the scene agrees with the sky.
// ---------------------------------------------------------------------------

const R_GROUND = 6360e3;
const R_TOP = 6460e3;
// Eye height for the integral. Low on purpose: from any real height the
// geometric horizon dips below 0 deg, and the sliver of sky between the two
// is air in the Earth's shadow -- which drew a dark line right along the
// horizon. The haze on distant land uses its own, taller vantage below.
const OBSERVER_H = 10;
const HAZE_EYE_H = 150;
const RAYLEIGH = [5.802e-6, 13.558e-6, 33.1e-6];         // scattering = extinction
const H_RAYLEIGH = 8000;
const MIE_SCA = 3.996e-6;                                // x mieScale at runtime
const MIE_EXT = 4.40e-6;
const H_MIE = 1200;
const MIE_G = 0.8;
const OZONE = [0.650e-6, 1.881e-6, 0.085e-6];            // absorption only
const OZONE_CENTRE = 25000, OZONE_HALF_WIDTH = 15000;
const GROUND_ALBEDO = 0.25;
// What you see below the horizon past the garden's edge: distant Ontario
// woodland and fields, hazed by the same air as the sky above it.
const LAND_ALBEDO = [0.075, 0.105, 0.06];
// Multiple scattering is mostly Rayleigh, so one bake at typical haze serves
// every time of day.
const MS_MIE = 4.0;

export const LUT_W = 128;
export const LUT_H = 128;        // upper half sky, lower half land
const MS_W = 64, MS_H = 32;
const MS_MU_MIN = -0.5;          // sun cosines below this contribute nothing visible
// Twilight radiance is ~1e-5 of day and a half float stops being precise below
// ~6e-5, so both tables store values pre-multiplied into a comfortable range.
const LUT_SCALE = 64;
const MS_SCALE = 1000;

const VIEW_STEPS = 32;
const SUN_STEPS = 8;

const f = (v) => v.toExponential(6);
const vec3 = (a) => `vec3(${a.map(f).join(', ')})`;

// ---- GLSL -----------------------------------------------------------------

const ATMOSPHERE_GLSL = /* glsl */`
const float A_RG = ${f(R_GROUND)};
const float A_RT = ${f(R_TOP)};
const vec3  A_BR = ${vec3(RAYLEIGH)};
const float A_HR = ${f(H_RAYLEIGH)};
const float A_BM_S = ${f(MIE_SCA)};
const float A_BM_E = ${f(MIE_EXT)};
const float A_HM = ${f(H_MIE)};
const float A_G = ${f(MIE_G)};
const vec3  A_BO = ${vec3(OZONE)};
const float A_PI = 3.14159265359;

// (near, far) along d; far < 0 means a miss. c is written as (r-R)(r+R)
// rather than |o|^2 - R^2: both terms are ~4e13 in float32, and their
// difference is exactly the grazing case that decides Earth's shadow.
vec2 aSphere(vec3 o, vec3 d, float R) {
    float b = dot(o, d);
    float r = length(o);
    float c = (r - R) * (r + R);
    float disc = b * b - c;
    if (disc < 0.0) return vec2(-1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
}

vec3 aDensity(float h) {
    return vec3(exp(-h / A_HR), exp(-h / A_HM),
                max(0.0, 1.0 - abs(h - ${f(OZONE_CENTRE)}) / ${f(OZONE_HALF_WIDTH)}));
}

vec3 aExtinction(vec3 dens, float mie) {
    return A_BR * dens.x + vec3(A_BM_E * mie * dens.y) + A_BO * dens.z;
}

vec3 aScattering(vec3 dens, float mie) {
    return A_BR * dens.x + vec3(A_BM_S * mie * dens.y);
}

// Transmittance from p toward the sun; zero inside the Earth's shadow.
vec3 aSunTransmittance(vec3 p, vec3 s, float mie) {
    if (aSphere(p, s, A_RG).x > 0.0) return vec3(0.0);
    float len = aSphere(p, s, A_RT).y;
    float ds = len / ${SUN_STEPS.toFixed(1)};
    vec3 od = vec3(0.0);
    for (int j = 0; j < ${SUN_STEPS}; j++) {
        vec3 q = p + s * ((float(j) + 0.5) * ds);
        od += aExtinction(aDensity(max(length(q) - A_RG, 0.0)), mie) * ds;
    }
    return exp(-od);
}
`;

// Multiple scattering table, Hillaire 2020 sec. 5.5: for each altitude and
// sun angle, second-order light arriving from every direction (isotropic
// phase, ground bounce included), divided by (1 - f_ms) to sum the infinite
// series of higher orders.
const MS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
${ATMOSPHERE_GLSL}
void main() {
    float u = (vUv.x - ${f(0.5 / MS_W)}) / ${f((MS_W - 1) / MS_W)};
    float v = (vUv.y - ${f(0.5 / MS_H)}) / ${f((MS_H - 1) / MS_H)};
    float mus = ${f(MS_MU_MIN)} + ${f(1 - MS_MU_MIN)} * clamp(u, 0.0, 1.0);
    float h = 20.0 + clamp(v * v, 0.0, 1.0) * (A_RT - A_RG - 40.0);
    vec3 x = vec3(0.0, A_RG + h, 0.0);
    vec3 s = vec3(sqrt(max(0.0, 1.0 - mus * mus)), mus, 0.0);
    const float mie = ${f(MS_MIE)};
    vec3 L2 = vec3(0.0);
    vec3 F = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        for (int j = 0; j < 8; j++) {
            float ct = 1.0 - 2.0 * (float(i) + 0.5) / 8.0;
            float st = sqrt(1.0 - ct * ct);
            float phi = 2.0 * A_PI * (float(j) + 0.5) / 8.0;
            vec3 w = vec3(st * cos(phi), ct, st * sin(phi));
            float tMax = aSphere(x, w, A_RT).y;
            float tg = aSphere(x, w, A_RG).x;
            bool hitGround = tg > 0.0;
            if (hitGround) tMax = tg;
            float ds = tMax / 20.0;
            vec3 od = vec3(0.0);
            for (int k = 0; k < 20; k++) {
                vec3 p = x + w * ((float(k) + 0.5) * ds);
                vec3 dens = aDensity(max(length(p) - A_RG, 0.0));
                vec3 ext = aExtinction(dens, mie);
                vec3 sc = aScattering(dens, mie);
                vec3 T = exp(-(od + ext * (0.5 * ds)));
                L2 += T * sc * aSunTransmittance(p, s, mie) * (0.25 / A_PI) * ds;
                F += T * sc * ds;
                od += ext * ds;
            }
            if (hitGround) {
                vec3 pg = x + w * tg;
                vec3 n = normalize(pg);
                L2 += exp(-od) * aSunTransmittance(pg + n * 2.0, s, mie)
                    * max(dot(n, s), 0.0) * ${f(GROUND_ALBEDO)} / A_PI;
            }
        }
    }
    L2 /= 64.0;
    F /= 64.0;
    gl_FragColor = vec4(L2 / max(vec3(1.0) - F, vec3(1e-3)) * ${f(MS_SCALE)}, 1.0);
}
`;

const VIEW_FRAG = /* glsl */`
precision highp float;
uniform float uSunElev;
uniform float uMieScale;
uniform sampler2D uMs;
varying vec2 vUv;
${ATMOSPHERE_GLSL}

vec3 aMultiScatter(float h, float mus) {
    float u = (mus - ${f(MS_MU_MIN)}) / ${f(1 - MS_MU_MIN)};
    float v = sqrt(clamp((h - 20.0) / (A_RT - A_RG - 40.0), 0.0, 1.0));
    vec2 uv = vec2(u, v) * vec2(${f((MS_W - 1) / MS_W)}, ${f((MS_H - 1) / MS_H)})
            + vec2(${f(0.5 / MS_W)}, ${f(0.5 / MS_H)});
    return u < 0.0 ? vec3(0.0) : texture2D(uMs, uv).rgb / ${f(MS_SCALE)};
}

vec3 aSkyRadiance(vec3 d, vec3 s, float mie) {
    vec3 o = vec3(0.0, A_RG + ${f(OBSERVER_H)}, 0.0);
    float tMax = aSphere(o, d, A_RT).y;
    float g = aSphere(o, d, A_RG).x;
    if (g > 0.0) tMax = g;

    float mu = dot(d, s);
    float pR = 3.0 / (16.0 * A_PI) * (1.0 + mu * mu);
    float g2 = A_G * A_G;
    float pM = 3.0 / (8.0 * A_PI) * ((1.0 - g2) * (1.0 + mu * mu))
             / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * A_G * mu, 1.5));

    vec3 sum = vec3(0.0);
    vec3 od = vec3(0.0);
    float tPrev = 0.0;
    // Quadratic spacing: a horizontal ray is ~1100 km long but nearly all of
    // its scattering happens in the first few hundred, where the air is.
    for (int i = 0; i < ${VIEW_STEPS}; i++) {
        float fi = (float(i) + 1.0) / ${VIEW_STEPS.toFixed(1)};
        float t = tMax * fi * fi;
        float ds = t - tPrev;
        vec3 p = o + d * (tPrev + 0.5 * ds);
        tPrev = t;
        float r = length(p);
        float h = max(r - A_RG, 0.0);
        vec3 dens = aDensity(h);
        vec3 ext = aExtinction(dens, mie);
        vec3 tv = exp(-(od + ext * (0.5 * ds)));
        vec3 single = A_BR * dens.x * pR + vec3(A_BM_S * mie * dens.y * pM);
        vec3 multi = aScattering(dens, mie) * aMultiScatter(h, dot(p / r, s));
        sum += tv * (aSunTransmittance(p, s, mie) * single + multi) * ds;
        od += ext * ds;
    }
    // Rays below the horizon end on distant land: lit by the sun and by
    // skylight (pi x the multiple-scattering radiance, which is close to an
    // isotropic sky), then seen through everything in between -- so land
    // a few km out is already mostly haze, and the horizon line is soft.
    if (g > 0.0) {
        vec3 pg = o + d * g;
        vec3 n = normalize(pg);
        float mug = dot(n, s);
        vec3 irr = aSunTransmittance(pg + n * 2.0, s, mie) * max(mug, 0.0)
                 + A_PI * aMultiScatter(20.0, mug);
        sum += exp(-od) * ${vec3(LAND_ALBEDO)} / A_PI * irr;
    }
    return sum;
}

void main() {
    // Inverse of the lookup in SKY_LOOKUP_GLSL: u is the azimuth away from
    // the sun (the sky is mirror-symmetric about the sun's vertical); v maps
    // elevation -90..90 deg with a square law centred on the horizon, so most
    // rows go to the horizon band, where twilight colour changes fastest.
    float u = (vUv.x - ${f(0.5 / LUT_W)}) / ${f((LUT_W - 1) / LUT_W)};
    float v = (vUv.y - ${f(0.5 / LUT_H)}) / ${f((LUT_H - 1) / LUT_H)};
    float az = clamp(u, 0.0, 1.0) * A_PI;
    float t = clamp(v, 0.0, 1.0) * 2.0 - 1.0;
    float el = sign(t) * t * t * 0.5 * A_PI;
    vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
    vec3 s = vec3(cos(uSunElev), sin(uSunElev), 0.0);
    gl_FragColor = vec4(aSkyRadiance(d, s, uMieScale) * ${f(LUT_SCALE)}, 1.0);
}
`;

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Shared by the dome and the ground's horizon fade, so the lawn dissolves
// into exactly the colour the sky shows behind it -- warm toward the sun,
// cool and shadowed away from it -- instead of one averaged fog colour.
// Names are prefixed: this is spliced into Three's own lit shaders, which
// already define PI and a great many uniforms.
export const SKY_LOOKUP_GLSL = /* glsl */`
uniform sampler2D uAtmLut;
uniform vec2 uAtmSunXZ;
uniform vec3 uAtmScale;        // exposure x white balance / LUT scale
uniform float uAtmSaturation;
uniform vec3 uAtmNightZenith;
uniform vec3 uAtmNightHorizon;
uniform float uAtmNightWeight;

vec3 atmLutAt(float u, float el) {
    float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) * 0.63661977236);
    return texture2D(uAtmLut, vec2(u, v) * vec2(${f((LUT_W - 1) / LUT_W)}, ${f((LUT_H - 1) / LUT_H)})
                                + vec2(${f(0.5 / LUT_W)}, ${f(0.5 / LUT_H)})).rgb;
}

vec3 atmosphereColor(vec3 dir) {
    float y = clamp(dir.y, -1.0, 1.0);
    vec2 hz = dir.xz;
    float hl = length(hz);
    float c = hl > 1e-5 ? dot(hz / hl, uAtmSunXZ) : 1.0;
    float u = acos(clamp(c, -1.0, 1.0)) * 0.31830988618;
    float el = asin(y);
    // The last ~0.6 deg above the horizon is rays grazing the planet through
    // shadowed air, which drew a hairline dark seam in deep twilight. Hold
    // that sliver at the 0.6 deg value; the eye cannot resolve the gradient.
    const float E0 = ${f(0.6 * Math.PI / 180)};
    vec3 col = atmLutAt(u, max(el, E0));
    if (el < 0.0) {
        // Boundary-layer haze over the land. The model's aerosol is sized
        // for the sky and is ~10x clearer than summer air near the ground
        // (20-30 km visibility), which left distant land as a flat, hard
        // edged plain. Land fades toward haze with distance to where the ray
        // would meet it from a 150 m rise. The haze's colour is the sky at the
        // mirrored elevation -- light scattered toward the eye at a similar
        // angle from the sun -- so the sun's glare falls off down the land
        // instead of lighting all of it. At the horizon it meets the sky
        // value above exactly, so there is no seam.
        float dist = ${f(HAZE_EYE_H)} / max(-y, 1e-4);
        float haze = 1.0 - exp(-dist / 5000.0);
        col = mix(atmLutAt(u, el), atmLutAt(u, max(-el, E0)), haze);
    }
    col *= uAtmScale;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(l), col, uAtmSaturation), 0.0);
    // Night: the airglow gradient above, and darker land below it.
    vec3 night = y >= 0.0 ? mix(uAtmNightHorizon, uAtmNightZenith, sqrt(y))
                          : uAtmNightHorizon * mix(1.0, 0.45, smoothstep(0.0, 0.08, -y));
    return col + night * uAtmNightWeight;
}
`;

// ---- CPU copy (float64), for the handful of colours the lights need --------

function sphere(o, d, R) {
    const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
    const r = Math.hypot(o[0], o[1], o[2]);
    const disc = b * b - (r - R) * (r + R);
    if (disc < 0) return [-1, -1];
    const s = Math.sqrt(disc);
    return [-b - s, -b + s];
}

function extinctionAt(h, mie, out) {
    const dR = Math.exp(-h / H_RAYLEIGH);
    const dM = Math.exp(-h / H_MIE) * mie;
    const dO = Math.max(0, 1 - Math.abs(h - OZONE_CENTRE) / OZONE_HALF_WIDTH);
    for (let c = 0; c < 3; c++) out[c] = RAYLEIGH[c] * dR + MIE_EXT * dM + OZONE[c] * dO;
    return out;
}

const _ext = [0, 0, 0];
const _q = [0, 0, 0];

function sunTransmittanceFrom(p, s, mie, out, steps = SUN_STEPS) {
    if (sphere(p, s, R_GROUND)[0] > 0) { out[0] = out[1] = out[2] = 0; return out; }
    const len = sphere(p, s, R_TOP)[1];
    const ds = len / steps;
    let o0 = 0, o1 = 0, o2 = 0;
    for (let j = 0; j < steps; j++) {
        const t = (j + 0.5) * ds;
        _q[0] = p[0] + s[0] * t; _q[1] = p[1] + s[1] * t; _q[2] = p[2] + s[2] * t;
        extinctionAt(Math.max(Math.hypot(_q[0], _q[1], _q[2]) - R_GROUND, 0), mie, _ext);
        o0 += _ext[0] * ds; o1 += _ext[1] * ds; o2 += _ext[2] * ds;
    }
    out[0] = Math.exp(-o0); out[1] = Math.exp(-o1); out[2] = Math.exp(-o2);
    return out;
}

// The CPU's multiple-scattering table is a coarser run of MS_FRAG (the light
// colours it feeds are averages, not pixels), built once on first use.
const CMS_W = 24, CMS_H = 8;
let cpuMs = null;

function buildCpuMs() {
    const table = new Float32Array(CMS_W * CMS_H * 3);
    const NI = 4, NJ = 6, STEPS = 10;
    const x = [0, 0, 0], s = [0, 0, 0], w = [0, 0, 0], p = [0, 0, 0], ts = [0, 0, 0];
    for (let yi = 0; yi < CMS_H; yi++) {
        const v = yi / (CMS_H - 1);
        const h = 20 + v * v * (R_TOP - R_GROUND - 40);
        x[1] = R_GROUND + h;
        for (let xi = 0; xi < CMS_W; xi++) {
            const mus = MS_MU_MIN + (1 - MS_MU_MIN) * xi / (CMS_W - 1);
            s[0] = Math.sqrt(Math.max(0, 1 - mus * mus)); s[1] = mus;
            let L0 = 0, L1 = 0, L2 = 0, F0 = 0, F1 = 0, F2 = 0;
            for (let i = 0; i < NI; i++) {
                const ct = 1 - 2 * (i + 0.5) / NI, st = Math.sqrt(1 - ct * ct);
                for (let j = 0; j < NJ; j++) {
                    const phi = 2 * Math.PI * (j + 0.5) / NJ;
                    w[0] = st * Math.cos(phi); w[1] = ct; w[2] = st * Math.sin(phi);
                    let tMax = sphere(x, w, R_TOP)[1];
                    const tg = sphere(x, w, R_GROUND)[0];
                    if (tg > 0) tMax = tg;
                    const ds = tMax / STEPS;
                    let od0 = 0, od1 = 0, od2 = 0;
                    for (let k = 0; k < STEPS; k++) {
                        const t = (k + 0.5) * ds;
                        p[0] = w[0] * t; p[1] = x[1] + w[1] * t; p[2] = w[2] * t;
                        const hh = Math.max(Math.hypot(p[0], p[1], p[2]) - R_GROUND, 0);
                        const dR = Math.exp(-hh / H_RAYLEIGH), dM = Math.exp(-hh / H_MIE) * MS_MIE;
                        extinctionAt(hh, MS_MIE, _ext);
                        const T0 = Math.exp(-(od0 + _ext[0] * 0.5 * ds));
                        const T1 = Math.exp(-(od1 + _ext[1] * 0.5 * ds));
                        const T2 = Math.exp(-(od2 + _ext[2] * 0.5 * ds));
                        const sc0 = RAYLEIGH[0] * dR + MIE_SCA * dM;
                        const sc1 = RAYLEIGH[1] * dR + MIE_SCA * dM;
                        const sc2 = RAYLEIGH[2] * dR + MIE_SCA * dM;
                        sunTransmittanceFrom(p, s, MS_MIE, ts, 6);
                        const k4 = ds / (4 * Math.PI);
                        L0 += T0 * sc0 * ts[0] * k4; L1 += T1 * sc1 * ts[1] * k4; L2 += T2 * sc2 * ts[2] * k4;
                        F0 += T0 * sc0 * ds; F1 += T1 * sc1 * ds; F2 += T2 * sc2 * ds;
                        od0 += _ext[0] * ds; od1 += _ext[1] * ds; od2 += _ext[2] * ds;
                    }
                    if (tg > 0) {
                        p[0] = w[0] * tg; p[1] = x[1] + w[1] * tg; p[2] = w[2] * tg;
                        const r = Math.hypot(p[0], p[1], p[2]);
                        const n = [p[0] / r, p[1] / r, p[2] / r];
                        const ndl = Math.max(0, n[0] * s[0] + n[1] * s[1]);
                        if (ndl > 0) {
                            sunTransmittanceFrom([p[0] + n[0] * 2, p[1] + n[1] * 2, p[2] + n[2] * 2], s, MS_MIE, ts, 6);
                            const k = ndl * GROUND_ALBEDO / Math.PI;
                            L0 += Math.exp(-od0) * ts[0] * k; L1 += Math.exp(-od1) * ts[1] * k; L2 += Math.exp(-od2) * ts[2] * k;
                        }
                    }
                }
            }
            const n = NI * NJ, o = (yi * CMS_W + xi) * 3;
            table[o] = (L0 / n) / Math.max(1 - F0 / n, 1e-3);
            table[o + 1] = (L1 / n) / Math.max(1 - F1 / n, 1e-3);
            table[o + 2] = (L2 / n) / Math.max(1 - F2 / n, 1e-3);
        }
    }
    return table;
}

function cpuMultiScatter(h, mus, out) {
    if (!cpuMs) cpuMs = buildCpuMs();
    const u = (mus - MS_MU_MIN) / (1 - MS_MU_MIN);
    if (u < 0) { out[0] = out[1] = out[2] = 0; return out; }
    const v = Math.sqrt(Math.min(Math.max((h - 20) / (R_TOP - R_GROUND - 40), 0), 1));
    const fx = Math.min(u, 1) * (CMS_W - 1), fy = v * (CMS_H - 1);
    const x0 = Math.min(Math.floor(fx), CMS_W - 2), y0 = Math.min(Math.floor(fy), CMS_H - 2);
    const tx = fx - x0, ty = fy - y0;
    for (let c = 0; c < 3; c++) {
        const a = cpuMs[(y0 * CMS_W + x0) * 3 + c], b = cpuMs[(y0 * CMS_W + x0 + 1) * 3 + c];
        const cc = cpuMs[((y0 + 1) * CMS_W + x0) * 3 + c], d = cpuMs[((y0 + 1) * CMS_W + x0 + 1) * 3 + c];
        out[c] = (a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty;
    }
    return out;
}

const OBSERVER = [0, R_GROUND + OBSERVER_H, 0];
const _ts = [0, 0, 0];
const _ms = [0, 0, 0];
const _p = [0, 0, 0];

/** Radiance toward direction d (unit, y up) for a unit-irradiance sun at s. */
export function skyRadiance(d, s, mie = 1, out = [0, 0, 0]) {
    const o = OBSERVER;
    let tMax = sphere(o, d, R_TOP)[1];
    const g = sphere(o, d, R_GROUND)[0];
    if (g > 0) tMax = g;
    const mu = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
    const pR = 3 / (16 * Math.PI) * (1 + mu * mu);
    const g2 = MIE_G * MIE_G;
    const pM = 3 / (8 * Math.PI) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * MIE_G * mu, 1.5));
    let s0 = 0, s1 = 0, s2 = 0, od0 = 0, od1 = 0, od2 = 0, tPrev = 0;
    for (let i = 0; i < VIEW_STEPS; i++) {
        const fi = (i + 1) / VIEW_STEPS;
        const t = tMax * fi * fi;
        const ds = t - tPrev;
        const tm = tPrev + 0.5 * ds;
        tPrev = t;
        _p[0] = o[0] + d[0] * tm; _p[1] = o[1] + d[1] * tm; _p[2] = o[2] + d[2] * tm;
        const r = Math.hypot(_p[0], _p[1], _p[2]);
        const h = Math.max(r - R_GROUND, 0);
        const dR = Math.exp(-h / H_RAYLEIGH);
        const dM = Math.exp(-h / H_MIE) * mie;
        extinctionAt(h, mie, _ext);
        const tv0 = Math.exp(-(od0 + _ext[0] * 0.5 * ds));
        const tv1 = Math.exp(-(od1 + _ext[1] * 0.5 * ds));
        const tv2 = Math.exp(-(od2 + _ext[2] * 0.5 * ds));
        sunTransmittanceFrom(_p, s, mie, _ts);
        cpuMultiScatter(h, (_p[0] * s[0] + _p[1] * s[1] + _p[2] * s[2]) / r, _ms);
        const m = MIE_SCA * dM * pM;
        const scM = MIE_SCA * dM;
        s0 += tv0 * (_ts[0] * (RAYLEIGH[0] * dR * pR + m) + _ms[0] * (RAYLEIGH[0] * dR + scM)) * ds;
        s1 += tv1 * (_ts[1] * (RAYLEIGH[1] * dR * pR + m) + _ms[1] * (RAYLEIGH[1] * dR + scM)) * ds;
        s2 += tv2 * (_ts[2] * (RAYLEIGH[2] * dR * pR + m) + _ms[2] * (RAYLEIGH[2] * dR + scM)) * ds;
        od0 += _ext[0] * ds; od1 += _ext[1] * ds; od2 += _ext[2] * ds;
    }
    out[0] = s0; out[1] = s1; out[2] = s2;
    return out;
}

/** Colour of direct sunlight at the observer for a sun at elevation el. */
export function sunTransmittance(el, mie = 1, out = [0, 0, 0]) {
    return sunTransmittanceFrom(OBSERVER, [Math.cos(el), Math.sin(el), 0], mie, out, 32);
}

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---- the runtime object ---------------------------------------------------

/**
 * Tunables are the grade, not the physics: `exposure` sets noon brightness,
 * `adaptation` how much of twilight's real ~1000x darkening the eye is
 * allowed to undo (1 = all of it, 0 = none), `saturation` the final colour.
 */
export function createAtmosphere({
    exposure = 7.0,
    adaptation = 0.72,
    maxAdapt = 40,
    saturation = 1.12,
    whiteBalanceElev = 45 * Math.PI / 180
} = {}) {
    const target = (w, h) => new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false
    });
    const lut = target(LUT_W, LUT_H);
    const msLut = target(MS_W, MS_H);
    let msBaked = false;

    const quadMat = (fragmentShader, uniforms = {}) => new THREE.ShaderMaterial({
        uniforms, vertexShader: QUAD_VERT, fragmentShader, depthTest: false, depthWrite: false
    });
    const msQuad = new FullScreenQuad(quadMat(MS_FRAG));
    const viewQuad = new FullScreenQuad(quadMat(VIEW_FRAG, {
        uSunElev: { value: 0 }, uMieScale: { value: 1 }, uMs: { value: msLut.texture }
    }));

    // The camera is white-balanced for a high sun, as eyes and cameras are:
    // noon sunlight reads white, and a low sun reads orange RELATIVE to it.
    const wb = sunTransmittance(whiteBalanceElev);
    const wbInv = wb.map((v) => 1 / v);
    const wbNorm = Math.max(...wbInv);
    for (let c = 0; c < 3; c++) wbInv[c] /= wbNorm;
    const wbLum = lum(wb.map((v, c) => v * wbInv[c]));

    const uniforms = {
        uAtmLut: { value: lut.texture },
        uAtmSunXZ: { value: new THREE.Vector2(1, 0) },
        uAtmScale: { value: new THREE.Vector3(1, 1, 1) },
        uAtmSaturation: { value: saturation },
        uAtmNightZenith: { value: new THREE.Color(0x0a101e) },
        uAtmNightHorizon: { value: new THREE.Color(0x1a2436) },
        uAtmNightWeight: { value: 0 }
    };

    // A zenith sample and two rings, weighted roughly by the solid angle
    // each stands for; enough for light colours, which are averages anyway.
    const RING = 8;
    const samples = [{ d: [0, 1, 0], w: 0.2, kind: 'zenith' }];
    for (const [elDeg, w, kind] of [[35, 0.4, 'mid'], [4, 0.4, 'horizon']]) {
        const el = elDeg * Math.PI / 180;
        for (let i = 0; i < RING; i++) {
            const az = (i + 0.5) / RING * Math.PI * 2;
            samples.push({ d: [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)], w: w / RING, kind });
        }
    }

    function measure(el, mie) {
        const s = [Math.cos(el), Math.sin(el), 0];
        const acc = { zenith: [0, 0, 0], mid: [0, 0, 0], horizon: [0, 0, 0], avg: [0, 0, 0] };
        const tmp = [0, 0, 0];
        for (const { d, w, kind } of samples) {
            skyRadiance(d, s, mie, tmp);
            const share = kind === 'zenith' ? 1 : 1 / RING;
            for (let c = 0; c < 3; c++) {
                const v = tmp[c] * wbInv[c];
                acc[kind][c] += v * share;
                acc.avg[c] += v * w;
            }
        }
        return acc;
    }

    const refLum = lum(measure(55 * Math.PI / 180, 4).avg);

    const state = {
        sunElev: NaN,
        mieScale: NaN,
        adapt: 1,
        exposure: exposure,
        zenith: new THREE.Color(),
        midSky: new THREE.Color(),
        horizon: new THREE.Color(),
        average: new THREE.Color(),
        sunColor: new THREE.Color(),   // white-balanced, max channel 1
        sunStrength: 1                 // direct-sun luminance relative to a 45 deg sun
    };

    const scaleVec = uniforms.uAtmScale.value;
    const grade = (out, v, k) => {
        const c = [v[0] * k, v[1] * k, v[2] * k];
        const l = lum(c);
        out.setRGB(...c.map((x) => Math.max(0, l + (x - l) * saturation)), THREE.LinearSRGBColorSpace);
        return out;
    };

    return {
        uniforms,
        state,
        /**
         * Re-bakes the LUT and re-measures the light colours, but only when the
         * sun has moved enough to see (~0.05 deg) or the haze has changed.
         */
        update(renderer, sunDir, sunElev, mieScale, nightWeight) {
            const hl = Math.hypot(sunDir.x, sunDir.z);
            if (hl > 1e-5) uniforms.uAtmSunXZ.value.set(sunDir.x / hl, sunDir.z / hl);
            uniforms.uAtmNightWeight.value = nightWeight;

            if (msBaked && Math.abs(sunElev - state.sunElev) < 0.0009 && Math.abs(mieScale - state.mieScale) < 0.02) return false;
            state.sunElev = sunElev;
            state.mieScale = mieScale;

            const prev = renderer.getRenderTarget();
            if (!msBaked) {
                renderer.setRenderTarget(msLut);
                msQuad.render(renderer);
                msBaked = true;
            }
            viewQuad.material.uniforms.uSunElev.value = sunElev;
            viewQuad.material.uniforms.uMieScale.value = mieScale;
            renderer.setRenderTarget(lut);
            viewQuad.render(renderer);
            renderer.setRenderTarget(prev);

            const m = measure(sunElev, mieScale);
            const L = Math.max(lum(m.avg), 1e-14);
            state.adapt = Math.min(maxAdapt, Math.max(1, Math.pow(refLum / L, adaptation)));
            const k = exposure * state.adapt;
            scaleVec.set(wbInv[0] * k / LUT_SCALE, wbInv[1] * k / LUT_SCALE, wbInv[2] * k / LUT_SCALE);

            grade(state.zenith, m.zenith, k);
            grade(state.midSky, m.mid, k);
            grade(state.horizon, m.horizon, k);
            grade(state.average, m.avg, k);

            const t = sunTransmittance(sunElev, mieScale);
            const tw = [t[0] * wbInv[0], t[1] * wbInv[1], t[2] * wbInv[2]];
            const mx = Math.max(tw[0], tw[1], tw[2]);
            if (mx > 1e-6) state.sunColor.setRGB(tw[0] / mx, tw[1] / mx, tw[2] / mx, THREE.LinearSRGBColorSpace);
            state.sunStrength = lum(tw) / wbLum;
            return true;
        },
        dispose() { lut.dispose(); msLut.dispose(); msQuad.dispose(); viewQuad.dispose(); }
    };
}
