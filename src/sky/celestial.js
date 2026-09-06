import * as THREE from 'three';
import { getAssetUrl } from '../utils/paths.js';

// Toronto, Ontario, Canada geographic coordinates
export const TORONTO_LAT = 43.6532 * (Math.PI / 180); // 43.6532° N
export const TORONTO_LON = -79.3832;                  // 79.3832° W

// Mid-to-late August solar declination (~ +12.5°, Aug 20)
export const AUGUST_SOLAR_DECLINATION = 12.5 * (Math.PI / 180);

// Solar right ascension for August (~9h57m)
export const AUGUST_SOLAR_RA = (9.95 / 24) * Math.PI * 2;

/**
 * Standard IAU Galactic Coordinate System Basis Vectors in Three.js Celestial Frame
 */
export const GALACTIC_POLE = new THREE.Vector3(-0.1980, 0.4560, 0.8677).normalize();
export const GALACTIC_CENTER = new THREE.Vector3(-0.8734, -0.4838, 0.0549).normalize();
export const GALACTIC_90 = new THREE.Vector3(0.4448, -0.7469, 0.4941).normalize();

/**
 * Converts Equatorial coordinates (Declination, Local Hour Angle) to Horizon coordinates (Altitude, Azimuth)
 * for an observer in Toronto.
 */
export function getEquatorialToHorizontal(lat, dec, hourAngle) {
    const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

    const cosAlt = Math.cos(alt);
    if (Math.abs(cosAlt) < 1e-5) {
        return { alt, az: 0 };
    }

    const cosAz = (Math.sin(dec) - Math.sin(lat) * Math.sin(alt)) / (Math.cos(lat) * cosAlt);
    const sinAz = (-Math.cos(dec) * Math.sin(hourAngle)) / cosAlt;
    let azFromSouth = Math.atan2(sinAz, Math.max(-1, Math.min(1, cosAz)));
    if (azFromSouth < 0) azFromSouth += Math.PI * 2;

    let azNav = (azFromSouth + Math.PI) % (Math.PI * 2);
    return { alt, az: azNav };
}

/**
 * Converts altitude and azimuth into Three.js 3D world coordinates.
 */
export function horizontalToCartesian(alt, azNav, radius = 1600) {
    const cosAlt = Math.cos(alt);
    const x = radius * cosAlt * Math.sin(azNav);
    const y = radius * Math.sin(alt);
    const z = -radius * cosAlt * Math.cos(azNav);
    return new THREE.Vector3(x, y, z);
}

/**
 * Calculates Toronto solar and lunar positions for a given time angle in August.
 */
export function calculateTorontoSunMoon(timeAngle, radius = 1600) {
    const hourAngle = timeAngle - (Math.PI / 2);

    const sunHoriz = getEquatorialToHorizontal(TORONTO_LAT, AUGUST_SOLAR_DECLINATION, hourAngle);
    const sunPos = horizontalToCartesian(sunHoriz.alt, sunHoriz.az, radius);

    const moonHourAngle = hourAngle + Math.PI;
    const moonDec = -11.0 * (Math.PI / 180);
    const moonHoriz = getEquatorialToHorizontal(TORONTO_LAT, moonDec, moonHourAngle);
    const moonPos = horizontalToCartesian(moonHoriz.alt, moonHoriz.az, radius);

    return {
        sunPos,
        sunAlt: sunHoriz.alt,
        sunAz: sunHoriz.az,
        moonPos,
        moonAlt: moonHoriz.alt,
        moonAz: moonHoriz.az
    };
}

/**
 * Creates the Toronto celestial sky system with the real ESO all-sky panorama skydome
 */
export function createTorontoSkySystem(radius = 1800, isMobile = false) {
    const skyRoot = new THREE.Group();
    skyRoot.name = "TorontoSkySystem";

    // --- 1. Atmospheric Sky Dome ---
    const skyDomeGeo = new THREE.SphereGeometry(radius * 0.98, isMobile ? 24 : 32, isMobile ? 16 : 24);
    const skyDomeMat = new THREE.ShaderMaterial({
        uniforms: {
            uZenithColor: { value: new THREE.Color(0x1a4674) },
            uHorizonColor: { value: new THREE.Color(0x4c78a6) },
            uHorizonOpposite: { value: new THREE.Color(0x4c78a6) },
            uSunDir: { value: new THREE.Vector3(0, 1, 0) },
            uSunColor: { value: new THREE.Color(0xfff5d8) },
            uNightFactor: { value: 0.0 }
        },
        vertexShader: `
            varying vec3 vWorldPos;
            void main() {
                vWorldPos = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uZenithColor;
            uniform vec3 uHorizonColor;
            uniform vec3 uHorizonOpposite;
            uniform vec3 uSunDir;
            uniform vec3 uSunColor;
            uniform float uNightFactor;
            varying vec3 vWorldPos;

            void main() {
                vec3 dir = normalize(vWorldPos);
                float h = max(0.0, dir.y);

                float horizonBand = pow(1.0 - h, 2.8);

                // A sunset is not orange all the way round. The warm band sits in
                // the sun's quarter of the sky and falls off to a cool, dusty
                // counter-glow behind the viewer -- ringing the whole horizon in
                // the same orange is the single thing that makes a procedural sky
                // read as fake. Compare compass bearings only, so the split holds
                // however high the sun is.
                vec2 dirAz = normalize(vec2(dir.x, dir.z) + vec2(1e-6));
                vec2 sunAz = normalize(vec2(uSunDir.x, uSunDir.z) + vec2(1e-6));
                float towardSun = smoothstep(-0.55, 0.95, dot(dirAz, sunAz));
                vec3 horizonMix = mix(uHorizonOpposite, uHorizonColor, towardSun);

                vec3 baseSky = mix(uZenithColor, horizonMix, horizonBand);

                float sunDot = max(0.0, dot(dir, uSunDir));
                // Two terms, not one: a wide Mie-ish scatter that swells around a
                // low sun and gives the sunset its body, and a tight corona for
                // the disc itself. The tight term alone reads as a sticker on a
                // flat gradient.
                float scatter = pow(sunDot, 5.0) * 0.30 * (1.0 - uNightFactor);
                float corona  = pow(sunDot, 256.0) * 0.35 * (1.0 - uNightFactor);

                // Scatter concentrates near the horizon, where the light path
                // through atmosphere is longest.
                scatter *= mix(0.35, 1.0, horizonBand);

                vec3 col = baseSky + uSunColor * (corona + scatter);

                // Deep royal midnight sky with subtle atmospheric horizon airglow
                vec3 nightZenith = vec3(0.008, 0.015, 0.035);
                vec3 nightHorizon = vec3(0.018, 0.036, 0.062);
                vec3 nightSky = mix(nightZenith, nightHorizon, horizonBand);
                col = mix(col, nightSky, uNightFactor);

                gl_FragColor = vec4(col, 1.0);
            }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
    });
    const skyDome = new THREE.Mesh(skyDomeGeo, skyDomeMat);
    skyDome.renderOrder = -200;
    skyRoot.add(skyDome);

    // --- 2. Celestial Sphere with Authentic ESO 360° Milky Way Panorama ---
    const celestialGroup = new THREE.Group();
    celestialGroup.name = "TorontoCelestialGroup";

    const textureLoader = new THREE.TextureLoader();
    const esoMwTexture = textureLoader.load(getAssetUrl('textures/milkyway.jpg'));
    esoMwTexture.wrapS = THREE.RepeatWrapping;
    esoMwTexture.wrapT = THREE.ClampToEdgeWrapping;
    esoMwTexture.minFilter = THREE.LinearFilter;
    esoMwTexture.magFilter = THREE.LinearFilter;
    esoMwTexture.generateMipmaps = false;

    const mwGeo = new THREE.SphereGeometry(radius * 0.95, isMobile ? 32 : 48, isMobile ? 24 : 36);
    const mwMat = new THREE.ShaderMaterial({
        uniforms: {
            uMwTex: { value: esoMwTexture },
            uNightFactor: { value: 0.0 },
            uGalacticPole: { value: GALACTIC_POLE },
            uGalacticCenter: { value: GALACTIC_CENTER },
            uGalactic90: { value: GALACTIC_90 }
        },
        vertexShader: `
            varying vec3 vWorldDir;
            varying vec3 vLocalPos;
            void main() {
                vLocalPos = position;
                vWorldDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D uMwTex;
            uniform float uNightFactor;
            uniform vec3 uGalacticPole;
            uniform vec3 uGalacticCenter;
            uniform vec3 uGalactic90;
            varying vec3 vWorldDir;
            varying vec3 vLocalPos;

            void main() {
                if (uNightFactor <= 0.001) discard;
                vec3 dir = normalize(vLocalPos);

                // Convert celestial sphere direction directly to Galactic Coordinates (b, l)
                float sinB = dot(dir, uGalacticPole);
                float b = asin(clamp(sinB, -1.0, 1.0));

                float xL = dot(dir, uGalacticCenter);
                float yL = dot(dir, uGalactic90);
                float l = atan(yL, xL);

                // Sample ESO 360-degree all-sky panorama
                vec2 uv = vec2((l + 3.14159265) / (2.0 * 3.14159265), (b + 1.5707963) / 3.14159265);
                vec4 tex = texture2D(uMwTex, uv);

                float altFade = smoothstep(-0.16, -0.01, normalize(vWorldDir).y);
                float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));

                // Dynamic Astrophotography Color Grading:
                // - Luminous sapphire blue & cyan along the spiral arms and star clouds
                // - Warm golden amber and ivory in the Sagittarius galactic core
                // - Hydrogen-alpha magenta/pink nebular knots
                float coreZone = exp(-pow(l * 1.5, 2.0)) * exp(-pow(b * 3.8, 2.0));
                float hAlphaZone = pow(max(0.0, sin(l * 5.5 + b * 8.5)), 2.0) * exp(-pow(b * 2.6, 2.0));

                vec3 armColor = vec3(0.42, 0.72, 1.15);     // Electric sapphire/cyan arms
                vec3 coreColor = vec3(1.15, 0.88, 0.60);    // Warm golden-ivory core
                vec3 hAlphaColor = vec3(1.10, 0.45, 0.75);  // H-Alpha magenta/pink

                vec3 coloredGlow = mix(armColor, coreColor, clamp(coreZone * 1.4, 0.0, 1.0));
                coloredGlow = mix(coloredGlow, hAlphaColor, hAlphaZone * 0.32);

                vec3 finalCol = tex.rgb * coloredGlow * 1.50;
                float alpha = smoothstep(0.018, 0.65, lum) * uNightFactor * altFade * 0.95;

                if (alpha <= 0.001) discard;
                gl_FragColor = vec4(finalCol * alpha, alpha);
            }
        `,
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
    });

    const mwMesh = new THREE.Mesh(mwGeo, mwMat);
    mwMesh.renderOrder = -160;
    celestialGroup.add(mwMesh);

    skyRoot.add(celestialGroup);

    return {
        skyRoot,
        skyDomeMat,
        mwMat,
        celestialGroup,
        /**
         * Updates celestial positions and sky dome colors for Toronto's latitude.
         */
        update(sunAngle, elapsedSec, sunDist = 1600) {
            const cel = calculateTorontoSunMoon(sunAngle, sunDist);
            const sunAlt = cel.sunAlt;
            const sH = Math.max(0, Math.sin(sunAlt));
            const mH = Math.max(0, Math.sin(cel.moonAlt));

            // Night factor: 0 in daytime -> 1 at deep night with smoothstep S-curve
            const nightFactor = THREE.MathUtils.smoothstep(-sunAlt, -0.06, 0.16);

            // Update sky dome shader uniforms
            skyDomeMat.uniforms.uSunDir.value.copy(cel.sunPos).normalize();
            skyDomeMat.uniforms.uNightFactor.value = nightFactor;

            // Update Milky Way panorama
            mwMat.uniforms.uNightFactor.value = nightFactor;

            // Diurnal rotation matching Toronto's latitude (43.65° N)
            const lst = (sunAngle - Math.PI / 2) + AUGUST_SOLAR_RA;
            celestialGroup.rotation.order = 'ZXY';
            celestialGroup.rotation.x = (Math.PI / 2 - TORONTO_LAT);
            celestialGroup.rotation.y = -lst;

            return {
                cel,
                sunAlt,
                sH,
                mH,
                nightFactor
            };
        }
    };
}
