import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import gsap from 'gsap';

import { createTorontoSkySystem } from './src/sky/celestial.js';
import { loadGarden, GARDEN_POINTS } from './src/scene/garden.js';
import { createGrassField } from './src/scene/grass.js';
import { SITE } from './src/content.js';

// ---------------------------------------------------------------------------
// Module-scope scratch objects and palettes.
//
// Both exist for the same reason: the render loop cross-fades a dozen colours
// and normalises a handful of vectors every frame, and allocating those inside
// animate() is GC pressure that shows up as a periodic hitch rather than a
// lower frame rate.
// ---------------------------------------------------------------------------
const _sunDirScratch = new THREE.Vector3();
const _moonDirScratch = new THREE.Vector3();
const _skyColScratch = new THREE.Color();
const _horizColScratch = new THREE.Color();
const _horizOppScratch = new THREE.Color();
const _twiZenith = new THREE.Color();
const _twiHorizon = new THREE.Color();
const _twiHorizonOpp = new THREE.Color();
const _hemiSkyScratch = new THREE.Color();
const _hemiGndScratch = new THREE.Color();

function blend3Colors(out, c1, w1, c2, w2, c3, w3) {
    out.r = c1.r * w1 + c2.r * w2 + c3.r * w3;
    out.g = c1.g * w1 + c2.g * w2 + c3.g * w3;
    out.b = c1.b * w1 + c2.b * w2 + c3.b * w3;
    return out;
}

const C_DAY_ZENITH = new THREE.Color(0x86adc9);        // porcelain blue
const C_DAY_HORIZON = new THREE.Color(0xcbdcdd);       // pale haze at the rim
const C_DAY_HORIZON_OPP = new THREE.Color(0xbcd1d6);
const C_DAWN_ZENITH = new THREE.Color(0xa9a7c4);       // soft lilac
const C_DAWN_HORIZON = new THREE.Color(0xf2c6ae);      // lifted gulmohar-bright
const C_DAWN_HORIZON_OPP = new THREE.Color(0xc3c0d2);
const C_DUSK_ZENITH = new THREE.Color(0x9a93b2);       // dusty lavender
const C_DUSK_HORIZON = new THREE.Color(0xe8a184);      // apricot, not sodium orange
const C_DUSK_HORIZON_OPP = new THREE.Color(0xb3adc4);
const C_NIGHT_ZENITH = new THREE.Color(0x2f384d);      // deep indigo, never black
const C_NIGHT_HORIZON = new THREE.Color(0x424d5f);

const C_SUN_HIGH = new THREE.Color(0xfffde8);
const C_SUN_LOW = new THREE.Color(0xffb27a);
const C_SUNLIGHT_HIGH = new THREE.Color(0xfff2c8);
const C_SUNLIGHT_LOW = new THREE.Color(0xf0a070);
const C_SUNLIGHT_DAWN = new THREE.Color(0xf3bca6);
const C_MOON_HIGH = new THREE.Color(0xe6edf5);
const C_MOON_LOW = new THREE.Color(0xc2d2e2);
const C_MOON_EMISSIVE = new THREE.Color(0xe0e8f2);
const C_MOONLIGHT_HIGH = new THREE.Color(0xd8e4f2);
const C_MOONLIGHT_LOW = new THREE.Color(0xc6d6e8);

const C_HEMI_NIGHT = new THREE.Color(0x54648a);
const C_HEMI_DAWN = new THREE.Color(0xf0c3b2);
const C_HEMI_DAY = new THREE.Color(0xfdf6e4);
const C_HEMI_GROUND_NIGHT = new THREE.Color(0x2c3444);
const C_HEMI_GROUND_DAWN = new THREE.Color(0x5b4a44);
const C_HEMI_GROUND_DAY = new THREE.Color(0x6e6a52);

const C_FLOOR_NOON = new THREE.Color(0xfaf6ec);
const C_FLOOR_TWILIGHT = new THREE.Color(0xcbc6d2);
const C_FLOOR_MIDNIGHT = new THREE.Color(0xa3afc2);   // the biggest 'not black at night' lever
const C_FLOOR_DAWN = new THREE.Color(0xf3decb);

const AMBIENT_DAY_SPEED = 0.004;   // radians/sec of sun angle at rest (~4.5 min/day)
const UI_HIDE_MS = 6000;

class GulmoharApp {
    constructor() {
        this.container = document.getElementById('app');
        this.scene = new THREE.Scene();
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2(-2, -2);

        this.elapsed = 0;
        this.sunAngle = 0;
        this.daySpeed = AMBIENT_DAY_SPEED;
        this.motionPaused = false;
        this.uiVisible = true;

        this._hoverTargets = [];
        this._hoverOwner = new Map();
        this.hovered = null;
        this._hoverDirty = false;
        this._introStarted = false;
        this._contentReady = false;
        this._revealed = false;

        this.setupLoadingManager();
        this.init();
    }

    // -- loading & reveal ---------------------------------------------------

    setupLoadingManager() {
        this.loadingManager = new THREE.LoadingManager();
        this.loadingManager.onLoad = () => this.revealScene();
        // A failed asset must not leave the loader up forever; the tree module
        // substitutes a procedural stand-in and the scene carries on.
        this.loadingManager.onError = () => this.revealScene();
        setTimeout(() => this.revealScene(), 12000);   // last-resort backstop
    }

    revealScene() {
        if (this._revealed) return;
        this._revealed = true;
        const loader = document.getElementById('loader');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.remove(), 900);
        }
        this._maybeStartIntro();
    }

    // -- setup --------------------------------------------------------------

    init() {
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth < 768;
        this.isMobile = isMobile;

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.4, 6000);
        this.camera.fov = this._fovForAspect(window.innerWidth / window.innerHeight);
        this.camera.updateProjectionMatrix();
        this.camera.position.set(12.8, 3.2, 11.2);
        this.camera.lookAt(0, 2.8, 0);

        this.renderer = new THREE.WebGLRenderer({
            antialias: !isMobile,        // MSAA plus a composer is heavy bandwidth on phones
            powerPreference: 'high-performance',
            alpha: false,
            stencil: false,
            depth: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.25 : 1.5));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.08;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // The scene is static apart from the sun: nothing moves, so re-rendering
        // both shadow maps every frame draws ~686k triangles for an identical
        // result. animate() flips needsUpdate only when the sun has actually
        // moved far enough to see, or when a light starts or stops casting.
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = true;
        this.renderer.setClearColor(0x000000, 1);
        this.container.appendChild(this.renderer.domElement);

        try {
            const pmrem = new THREE.PMREMGenerator(this.renderer);
            const envScene = new RoomEnvironment();
            this.scene.environment = pmrem.fromScene(envScene).texture;
            this.scene.environmentIntensity = 0.13;   // 0.35 flooded shadowed foliage with fill
            envScene.dispose();
            pmrem.dispose();
        } catch (e) {
            console.warn('Environment map unavailable:', e);
        }

        // RenderPass -> OutputPass. Tone mapping and the sRGB encode happen once,
        // at the end, on a linear chain -- which is the whole point of OutputPass
        // and the foundation the colour grading below is tuned against.
        //
        // There is no bloom pass. UnrealBloomPass only composites correctly when
        // it is the *final* pass: in any earlier position it draws its glow into
        // readBuffer without first blitting the base image (that blit lives
        // inside its `if (this.renderToScreen)` branch), and here that measured
        // as a black frame. It was earning very little anyway -- at threshold
        // 0.98 / strength 0.08 the only thing above the line was the sun disc --
        // and dropping it also removes a five-mip blur chain from every frame.
        // If the sun wants a glow later, an additive sprite on the sun mesh is
        // cheaper and far more controllable than a full-screen pass.
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.composer.addPass(new OutputPass());

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 2.8, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 6.0;
        this.controls.maxDistance = 58;
        this.controls.maxPolarAngle = Math.PI * 0.48;   // low upward glance, never below ground
        this.controls.autoRotate = false;               // released when the intro descent begins
        this.controls.autoRotateSpeed = -0.6;

        this.scene.fog = new THREE.FogExp2(0xcbdcdd, 0.005);   // was 0.002 (none); 0.011 washed it out

        this.setupLighting();
        this.setupEnvironment();
        this.setupDustMotes();
        this.createDock();
        this._startClock();

        // Seed the sky to the visitor's actual time of day; it drifts from there.
        const now = new Date();
        this.sunAngle = (((now.getHours() + now.getMinutes() / 60) - 6) / 24) * Math.PI * 2;

        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this.onResize(), 60);
        }, { passive: true });
        window.addEventListener('pointermove', (e) => this.onPointerMove(e), { passive: true });

        let startX = 0, startY = 0, startTime = 0;
        window.addEventListener('pointerdown', (e) => {
            startX = e.clientX; startY = e.clientY; startTime = performance.now();
            this.onPointerMove(e);              // touch has no hover; raycast on contact
            this.resetUIHideTimer();
        });
        window.addEventListener('pointerup', (e) => {
            const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
            // A tap, not the end of an orbit drag or a long press.
            if (moved < 8 && performance.now() - startTime < 350) this.onClick(e);
            if (e.pointerType === 'touch') this.hovered = null;
        });
        ['gesturestart', 'gesturechange', 'gestureend'].forEach(g =>
            window.addEventListener(g, (e) => e.preventDefault(), { passive: false })
        );

        try { this.renderer.compile(this.scene, this.camera); } catch (e) { /* noop */ }

        // Dev-only handle, so the scene can be inspected from the console.
        if (import.meta.env && import.meta.env.DEV) window.__gulmohar = this;

        this._lastFrame = performance.now();
        this.animate();
    }

    setupLighting() {
        // Ambient lifts lit and shadowed surfaces equally, which is exactly what
        // removes contrast -- keep it barely present and let the hemisphere light,
        // which at least distinguishes sky from ground, do the filling.
        this.ambientLight = new THREE.AmbientLight(0xfff5ea, 0.02);
        this.scene.add(this.ambientLight);
        this.hemiLight = new THREE.HemisphereLight(0xfff3d8, 0x221c16, 0.28);
        this.scene.add(this.hemiLight);

        const shadowRes = this.isMobile ? 1024 : 2048;
        // Compact shadow frustum tightly framing the garden for high performance and crisp shadows
        const d = 34;

        this.sunDist = 1600;
        this.sunLight = new THREE.DirectionalLight(0xfff2c8, 3.8);
        this.moonLight = new THREE.DirectionalLight(0xc8d8e8, 2.0);
        [this.sunLight, this.moonLight].forEach((light) => {
            light.castShadow = true;
            light.shadow.mapSize.set(shadowRes, shadowRes);
            light.shadow.camera.near = 5.0;
            light.shadow.camera.far = 600;
            Object.assign(light.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
            light.shadow.camera.updateProjectionMatrix();
            light.shadow.bias = -0.0001;
            light.shadow.normalBias = 0.025;
            light.shadow.radius = 1.8;
            this.scene.add(light);
            this.scene.add(light.target);
        });

        const sunTex = this.generateSunTexture();
        this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(44, 32, 32), new THREE.MeshStandardMaterial({
            map: sunTex, emissiveMap: sunTex, emissive: 0xffe477, emissiveIntensity: 2.2,
            roughness: 0.85, fog: false, transparent: true
        }));
        this.sunMesh.renderOrder = -180;
        this.scene.add(this.sunMesh);

        const moonTex = this.generateMoonTexture();
        this.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(30, 32, 32), new THREE.MeshStandardMaterial({
            map: moonTex, emissiveMap: moonTex, emissive: 0xe0e8f2, emissiveIntensity: 1.1,
            roughness: 0.92, metalness: 0, fog: false, transparent: true
        }));
        this.moonMesh.renderOrder = -180;
        this.scene.add(this.moonMesh);
    }

    // A flat disc reads as a hole punched in the sky; a gradient with a little
    // turbulence reads as a body.
    generateSunTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#fffbeb');
        grad.addColorStop(0.4, '#ffe67c');
        grad.addColorStop(1, '#ffb833');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 512, 256);
        for (let i = 0; i < 200; i++) {
            ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.15})`;
            ctx.beginPath();
            ctx.arc(Math.random() * 512, Math.random() * 256, Math.random() * 14, 0, Math.PI * 2);
            ctx.fill();
        }
        return new THREE.CanvasTexture(canvas);
    }

    generateMoonTexture() {
        const w = 512, h = 256;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');

        const base = ctx.createLinearGradient(0, 0, 0, h);
        base.addColorStop(0, '#e8edf3');
        base.addColorStop(0.5, '#dbe2ea');
        base.addColorStop(1, '#caced4');
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, w, h);

        let seed = 12345;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

        // The maria are what make a moon recognisable at a glance; the crater
        // field alone reads as noise.
        [[0.38, 0.32, 58, 40], [0.58, 0.36, 38, 30], [0.62, 0.47, 42, 32],
         [0.76, 0.38, 22, 18], [0.42, 0.61, 36, 27], [0.48, 0.18, 70, 12]]
            .forEach(([fx, fy, rx, ry]) => {
                ctx.save();
                ctx.filter = 'blur(8px)';
                ctx.fillStyle = 'rgba(76,88,102,0.6)';
                ctx.beginPath();
                ctx.ellipse(fx * w, fy * h, rx, ry, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            });

        for (let i = 0; i < 120; i++) {
            const cx = rnd() * w, cy = rnd() * h, cr = 1 + rnd() * 3.5;
            ctx.fillStyle = 'rgba(70,80,92,0.35)';
            ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = 0.8;
            ctx.beginPath(); ctx.arc(cx - 0.5, cy - 0.5, cr, -Math.PI * 0.75, Math.PI * 0.25); ctx.stroke();
        }
        return new THREE.CanvasTexture(canvas);
    }

    // A tiled ground plane seen at a grazing angle is exactly what anisotropic
    // filtering is for, and nothing in this project was setting it. Capped at 8:
    // past that the returns are invisible and some drivers get expensive.
    _maxAnisotropy() {
        if (this._aniso === undefined) {
            this._aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        }
        return this._aniso;
    }

    setupEnvironment() {
        // Ground: compact garden disc (radius 42m) with soft organic edge fade
        const groundGeo = new THREE.CircleGeometry(42, 48);

        // Procedural organic lawn texture canvas
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#4c703e';
        ctx.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 4000; i++) {
            const x = Math.random() * 256;
            const y = Math.random() * 256;
            const g = 80 + Math.floor(Math.random() * 55);
            ctx.fillStyle = `rgba(${Math.floor(g * 0.65)}, ${g}, ${Math.floor(g * 0.45)}, ${0.15 + Math.random() * 0.25})`;
            ctx.fillRect(x, y, 1 + Math.random() * 2, 2 + Math.random() * 4);
        }
        const grassTex = new THREE.CanvasTexture(canvas);
        grassTex.wrapS = THREE.RepeatWrapping;
        grassTex.wrapT = THREE.RepeatWrapping;
        grassTex.repeat.set(10, 10);
        grassTex.anisotropy = this._maxAnisotropy();

        this.groundMat = new THREE.MeshStandardMaterial({
            map: grassTex,
            color: 0x567b45,
            roughness: 0.95,
            metalness: 0.02,
            transparent: true,
            depthWrite: true,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
        this.groundMat.onBeforeCompile = (shader) => {
            // Fed from GARDEN_POINTS so the cutout follows the pond if it moves,
            // rather than being a second copy of its coordinates in a string.
            shader.uniforms.uPondCentre = { value: new THREE.Vector2(GARDEN_POINTS.POND.x, GARDEN_POINTS.POND.z) };
            shader.vertexShader = 'varying vec3 vGroundWorldPos;\n' + shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                '#include <worldpos_vertex>\n vGroundWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
            );
            shader.fragmentShader = 'varying vec3 vGroundWorldPos;\nuniform vec2 uPondCentre;\n' + shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                 float r = length(vGroundWorldPos.xz);
                 // Two-stage horizon: mix toward the fog first, then fade alpha so
                 // the real sky shows through. A colour mix alone cannot match a
                 // horizon that is warm toward the sun and cool away from it.
                 #ifdef USE_FOG
                 gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(31.0, 41.5, r));
                 #endif
                 gl_FragColor.a *= 1.0 - smoothstep(34.0, 42.0, r);
                 // Seamless cutout for the sunken pond basin.
                 float distPond = length(vGroundWorldPos.xz - uPondCentre);
                 gl_FragColor.a *= smoothstep(5.4, 7.4, distPond);
                 if (gl_FragColor.a <= 0.002) discard;`
            );
        };
        const ground = new THREE.Mesh(groundGeo, this.groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);

        this.skySystem = createTorontoSkySystem(1800, this.isMobile);
        this.scene.add(this.skySystem.skyRoot);

        loadGarden(this.loadingManager).then((garden) => {
            this.garden = garden;
            this.scene.add(garden.group);

            if (garden.groundTexture) {
                const gt = garden.groundTexture.clone();
                gt.wrapS = THREE.RepeatWrapping;
                gt.wrapT = THREE.RepeatWrapping;
                gt.repeat.set(10, 10);
                gt.anisotropy = this._maxAnisotropy();
                gt.needsUpdate = true;
                this.groundMat.map = gt;
                this.groundMat.color.setHex(0xffffff);
            }
            if (garden.groundNormal) {
                const gn = garden.groundNormal.clone();
                gn.wrapS = THREE.RepeatWrapping;
                gn.wrapT = THREE.RepeatWrapping;
                gn.repeat.set(10, 10);
                gn.anisotropy = this._maxAnisotropy();
                gn.needsUpdate = true;
                this.groundMat.normalMap = gn;
            }
            this.groundMat.needsUpdate = true;

            const aniso = this.isMobile ? 4 : this._maxAnisotropy();
            const seenTex = new Set();
            garden.group.traverse((child) => {
                if (!child.isMesh || !child.material) return;
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => {
                    ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach((slot) => {
                        const t = m[slot];
                        if (t && !seenTex.has(t.uuid)) {
                            seenTex.add(t.uuid);
                            t.anisotropy = aniso;
                            t.needsUpdate = true;
                        }
                    });
                });
            });

            garden.interactives.forEach(({ object, data }) => {
                this._registerHover(object, data);
            });

            // One InstancedMesh, one draw call, castShadow false -- 8,000
            // clumps in the shadow pass would more than double its cost for
            // shadows nobody could resolve at 15cm anyway. Thinned on mobile
            // rather than removed, so the world doesn't visibly change shape
            // by device -- just how dense the lawn reads.
            const grassCount = Math.round((this.isMobile ? 0.4 : 1.0) * 7000);
            this.grass = createGrassField(39, grassCount);
            this.scene.add(this.grass);

            this._contentReady = true;
            this.renderer.shadowMap.needsUpdate = true;
            this._maybeStartIntro();
        });
    }

    setupDustMotes() {
        const count = 100;
        const pos = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            pos[i * 3] = (Math.random() - 0.5) * 120;
            // Kept clear of the ground: motes sitting at y \u2248 0 read as litter
            // scattered on the floor rather than dust hanging in the air.
            pos[i * 3 + 1] = 1.2 + Math.random() * 9.5;
            pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this.dust = new THREE.Points(geom, new THREE.PointsMaterial({
            color: 0xffffff, size: 0.05, transparent: true, opacity: 0.3, sizeAttenuation: true
        }));
        this.scene.add(this.dust);
    }

    // -- hover & click ------------------------------------------------------

    // Raycasting a flat array of declared targets, rather than the whole scene
    // graph: intersectObjects(scene.children, true) descends into the sky dome,
    // the ground and every mote of dust.
    _registerHover(object, data) {
        this._hoverTargets.push(object);
        this._hoverOwner.set(object, data);
    }

    onPointerMove(e) {
        this.pointer.set(
            (e.clientX / window.innerWidth) * 2 - 1,
            -(e.clientY / window.innerHeight) * 2 + 1
        );
        this._hoverDirty = true;
        this.resetUIHideTimer();
    }

    checkHover() {
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this._hoverTargets, true);
        let owner = null;
        for (let i = 0; i < hits.length; i++) {
            let cur = hits[i].object;
            while (cur) {
                if (this._hoverOwner.has(cur)) {
                    owner = this._hoverOwner.get(cur);
                    break;
                }
                cur = cur.parent;
            }
            if (owner) break;
        }

        if (owner === this.hovered) return;
        this.hovered = owner;

        const label = document.getElementById('hover-label');
        if (!label) return;
        if (owner) {
            label.querySelector('.hl-title').textContent = owner.title;
            label.querySelector('.hl-meta').textContent = owner.meta || '';
            label.classList.add('visible');
            document.body.style.cursor = 'pointer';
        } else {
            label.classList.remove('visible');
            document.body.style.cursor = 'crosshair';
        }
    }

    onClick(e) {
        if (e && e.clientX !== undefined) {
            this.pointer.set(
                (e.clientX / window.innerWidth) * 2 - 1,
                -(e.clientY / window.innerHeight) * 2 + 1
            );
        }
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this._hoverTargets, true);
        let targetData = null;
        for (let i = 0; i < hits.length; i++) {
            let cur = hits[i].object;
            while (cur) {
                if (this._hoverOwner.has(cur)) {
                    targetData = this._hoverOwner.get(cur);
                    break;
                }
                cur = cur.parent;
            }
            if (targetData) break;
        }

        if (!targetData && this.hovered) {
            targetData = this.hovered;
        }

        if (targetData && targetData.cameraTarget) {
            const { pos, lookAt } = targetData.cameraTarget;
            gsap.to(this.camera.position, {
                x: pos.x, y: pos.y, z: pos.z,
                duration: 2.2,
                ease: 'power2.inOut'
            });
            gsap.to(this.controls.target, {
                x: lookAt.x, y: lookAt.y, z: lookAt.z,
                duration: 2.2,
                ease: 'power2.inOut'
            });
            this.setUIVisibility(true);
        } else {
            this.resetScene();
        }
    }

    // -- camera -------------------------------------------------------------

    _fovForAspect(aspect, base = 50) {
        // Three's fov is vertical. Holding it fixed on a portrait phone collapses
        // the horizontal field to a slice, so widen vertically as aspect narrows.
        const REF = 4 / 3;
        if (aspect >= REF) return base;
        const halfV = THREE.MathUtils.degToRad(base) / 2;
        const halfH = Math.atan(Math.tan(halfV) * REF);
        const halfVNew = Math.atan(Math.tan(halfH) / Math.max(aspect, 0.35));
        return THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(halfVNew) * 2, base, 58);
    }

    _maybeStartIntro() {
        // Both gates, whichever lands later: a fast load must not play the
        // opening move behind a loading overlay.
        if (this._introStarted || !this._contentReady || !this._revealed) return;
        this._introStarted = true;

        const target = { x: 12.8, y: 3.2, z: 11.2 };
        this.camera.position.set(0, 36, 64);
        this.controls.target.set(0, 2.8, 0);

        const tl = gsap.timeline();
        this._introTl = tl;
        tl.to(this.camera.position, { ...target, duration: 6.5, ease: 'sine.inOut' });
        tl.call(() => { this.controls.autoRotate = !this.motionPaused; }, null, 0.6);
        tl.fromTo(this.controls, { autoRotateSpeed: 0 },
            { autoRotateSpeed: -0.4, duration: 4, ease: 'sine.inOut' }, 0.6);
    }

    resetScene() {
        gsap.to(this.camera.position, { x: 12.8, y: 3.2, z: 11.2, duration: 1.8, ease: 'power2.inOut' });
        gsap.to(this.controls.target, { x: 0, y: 2.8, z: 0, duration: 1.8, ease: 'power2.inOut' });
        this.setUIVisibility(true);
    }

    onResize() {
        const aspect = window.innerWidth / window.innerHeight;
        this.camera.aspect = aspect;
        this.camera.fov = this._fovForAspect(aspect);
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
    }

    // -- motion & UI --------------------------------------------------------

    // "Paused" means the same thing everywhere: the sky clock, the ground rings
    // and the camera orbit all stop. A half-moving state is one no label can
    // describe honestly.
    setMotionPaused(paused, { rotation = true } = {}) {
        this.motionPaused = paused;
        if (rotation) this.controls.autoRotate = !paused && this._introStarted;
        if (this.motionBtn) {
            this.motionBtn.innerHTML = paused ? this._motionIcons.play : this._motionIcons.pause;
            const label = paused ? 'Resume motion' : 'Pause motion · Hold to speed up';
            this.motionBtn.setAttribute('aria-label', label);
            const tip = document.createElement('span');
            tip.className = 'btn-tip';
            tip.textContent = label;
            this.motionBtn.appendChild(tip);
        }
    }

    resetUIHideTimer() {
        clearTimeout(this._uiHideTimer);
        if (!this.uiVisible) this.setUIVisibility(true);
        this._uiHideTimer = setTimeout(() => this.setUIVisibility(false), UI_HIDE_MS);
    }

    setUIVisibility(visible) {
        this.uiVisible = visible;
        if (this.uiContainer) this.uiContainer.classList.toggle('ui-hidden', !visible);
        const clock = document.getElementById('clock');
        if (clock) clock.classList.toggle('ui-hidden', !visible);
    }

    createDock() {
        const container = document.createElement('div');
        container.id = 'dock';
        this.uiContainer = container;

        const wrapper = document.createElement('div');
        wrapper.className = 'glass-bar-wrapper';
        wrapper.onmouseenter = () => this.resetUIHideTimer();

        const icons = {
            home: `<svg viewBox="0 0 24 24"><path d="M12 3L3 12L12 21L21 12L12 3Z"/></svg>`,
            day: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 1v1.5M12 21.5V23M1 12h1.5M21.5 12H23"/></svg>`,
            spiral: `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9c0 4.97 4.03 9 9 9s9-4.03 9-9a7.2 7.2 0 0 0-7.2-7.2 7.2 7.2 0 0 0-7.2 7.2c0 3.09 2.51 5.6 5.6 5.6s5.6-2.51 5.6-5.6a4 4 0 0 0-4-4c-1.33 0-2.4 1.07-2.4 2.4s1.07 2.4 2.4 2.4"/></svg>`,
            night: `<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
            pause: `<svg viewBox="0 0 24 24"><rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/></svg>`,
            play: `<svg viewBox="0 0 24 24"><path d="M8 5.4L18.4 12 8 18.6Z"/></svg>`,
            work: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
            about: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.6"/></svg>`,
            instagram: `<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`
        };
        this._motionIcons = { pause: icons.pause, play: icons.play };

        const createBtn = (svg, onClick, label = '') => {
            const btn = document.createElement('button');
            btn.className = 'glass-btn';
            btn.innerHTML = svg;
            if (label) {
                btn.setAttribute('aria-label', label);
                const tip = document.createElement('span');
                tip.className = 'btn-tip';
                tip.textContent = label;
                btn.appendChild(tip);
                // Touch devices have no hover state, so show the tip briefly on tap.
                let tipTimeout;
                btn.addEventListener('touchstart', () => {
                    tip.classList.add('tip-visible');
                    clearTimeout(tipTimeout);
                    tipTimeout = setTimeout(() => tip.classList.remove('tip-visible'), 1400);
                }, { passive: true });
            }
            if (onClick) {
                btn.onclick = (e) => { e.stopPropagation(); onClick(); this.resetUIHideTimer(); };
            }
            btn.addEventListener('pointerdown', e => e.stopPropagation());
            btn.addEventListener('pointerup', e => e.stopPropagation());
            return btn;
        };

        const HOLD_MS = 200;
        const addLongPress = (btn, onInterval, onTap) => {
            let interval = null, startedAt = 0, isLongPress = false;
            const start = (e) => {
                e.stopPropagation();
                if (interval) clearInterval(interval);
                this.resetUIHideTimer();
                startedAt = performance.now();
                isLongPress = false;
                // How long the button has been held is read from the clock, not
                // counted in ticks: browsers throttle timers, and counting ticks
                // makes a real hold register as a tap exactly when the device is
                // busiest.
                interval = setInterval(() => {
                    this.resetUIHideTimer();
                    if (performance.now() - startedAt > HOLD_MS) {
                        isLongPress = true;
                        onInterval();
                    }
                }, 50);
            };
            const end = (e) => {
                if (interval) { clearInterval(interval); interval = null; }
                if (startedAt && performance.now() - startedAt > HOLD_MS) isLongPress = true;
                if (!isLongPress && onTap && e.type !== 'pointerleave') {
                    onTap();
                    this.resetUIHideTimer();
                } else if (isLongPress) {
                    // Release means "stay where you left it" for the time buttons,
                    // and "settle back to ambient" for the motion button.
                    if (btn === this.motionBtn) {
                        this.controls.autoRotateSpeed = -0.8;
                        this.daySpeed = AMBIENT_DAY_SPEED;
                    } else {
                        this.daySpeed = 0;
                    }
                }
                startedAt = 0;
            };
            btn.addEventListener('pointerdown', start);
            btn.addEventListener('pointerup', end);
            btn.addEventListener('pointerleave', end);   // a finger sliding off must not stick
        };

        const homeBtn = createBtn(icons.home, () => this.resetScene(), 'Home');

        // No onClick: the long-press handler owns both paths, or a tap fires twice.
        const motionBtn = createBtn(icons.pause, null, 'Pause motion · Hold to speed up');
        motionBtn.style.color = '#fff';
        this.motionBtn = motionBtn;
        addLongPress(motionBtn, () => {
            if (this.motionPaused) this.setMotionPaused(false);
            this.controls.autoRotateSpeed = Math.max(-40, Math.min(-0.5, this.controls.autoRotateSpeed * 1.05));
            if (this.daySpeed < 0.02) this.daySpeed = 0.02;
            this.daySpeed = Math.min(0.65, this.daySpeed * 1.08);
        }, () => this.setMotionPaused(!this.motionPaused));

        const sunBtn = createBtn(icons.day, null, 'Noon · Hold for a time-lapse');
        sunBtn.classList.add('day-btn');
        addLongPress(sunBtn, () => {
            if (this.motionPaused) this.setMotionPaused(false, { rotation: false });
            if (this.daySpeed < 0.01) this.daySpeed = 0.01;
            this.daySpeed = Math.min(0.20, this.daySpeed * 1.10);
        }, () => { this.sunAngle = Math.PI / 2; this.daySpeed = 0; });

        const spiralBtn = createBtn(icons.spiral, null, 'Time warp · Hold to cycle');
        addLongPress(spiralBtn, () => {
            if (this.motionPaused) this.setMotionPaused(false, { rotation: false });
            if (this.daySpeed < 0.02) this.daySpeed = 0.02;
            this.daySpeed = Math.min(0.65, this.daySpeed * 1.08);
        }, () => { this.sunAngle = (this.sunAngle + Math.PI / 12) % (Math.PI * 2); this.daySpeed = 0; });

        const moonBtn = createBtn(icons.night, null, 'Midnight · Hold for a time-lapse');
        moonBtn.classList.add('night-btn');
        addLongPress(moonBtn, () => {
            if (this.motionPaused) this.setMotionPaused(false, { rotation: false });
            if (this.daySpeed < 0.01) this.daySpeed = 0.01;
            this.daySpeed = Math.min(0.20, this.daySpeed * 1.10);
        }, () => { this.sunAngle = 3 * Math.PI / 2; this.daySpeed = 0; });

        // The routes to the flat pages also exist in the always-visible corner
        // nav, since the dock auto-hides and these must never become unreachable.
        const workBtn = createBtn(icons.work, () => { window.location.href = './work/'; }, 'Work');
        const aboutBtn = createBtn(icons.about, () => { window.location.href = './about/'; }, 'About');

        wrapper.append(homeBtn, motionBtn, sunBtn, spiralBtn, moonBtn, workBtn, aboutBtn);

        if (SITE.instagram) {
            wrapper.append(createBtn(icons.instagram, () => {
                window.open(SITE.instagram, '_blank', 'noopener,noreferrer');
            }, 'Instagram'));
        }

        container.appendChild(wrapper);
        document.body.appendChild(container);
        this.resetUIHideTimer();
    }

    // The clock reads the same sun angle that lights the scene, so it cannot
    // drift out of step with what is on screen.
    _startClock() {
        const el = document.getElementById('clock');
        if (!el) return;
        const tick = () => {
            const hours = ((this.sunAngle / (Math.PI * 2)) * 24 + 6 + 24) % 24;
            const h = Math.floor(hours);
            const m = Math.floor((hours - h) * 60);
            el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };
        tick();
        setInterval(tick, 1000);
    }

    // -- frame --------------------------------------------------------------

    animate() {
        requestAnimationFrame(() => this.animate());

        const nowMs = performance.now();
        // Clamped, so a backgrounded tab returning does not jump the sky by hours.
        const dt = Math.min((nowMs - (this._lastFrame || nowMs)) / 1000, 0.1);
        this._lastFrame = nowMs;
        this.elapsed += dt;

        if (this._hoverDirty) { this._hoverDirty = false; this.checkHover(); }

        if (!this.motionPaused) this.sunAngle += this.daySpeed * 6.0 * dt;

        const sky = this.skySystem.update(this.sunAngle, this.elapsed, this.sunDist);

        this.sunMesh.position.copy(sky.cel.sunPos);
        this.moonMesh.position.copy(sky.cel.moonPos);
        this.moonMesh.lookAt(0, 0, 0);

        // A directional light's position only sets its direction; putting it at
        // 350 units rather than the disc's 1600 keeps shadow-camera precision.
        _sunDirScratch.copy(sky.cel.sunPos).normalize().multiplyScalar(350);
        // Keep the moon key light high enough to throw an aesthetic shadow
        _moonDirScratch.set(
            sky.cel.moonPos.x || 120,
            Math.max(160, Math.abs(sky.cel.moonPos.y)),
            sky.cel.moonPos.z || 120
        ).normalize().multiplyScalar(320);
        this.sunLight.position.copy(_sunDirScratch);
        this.moonLight.position.copy(_moonDirScratch);

        // Smoothly fade celestial discs across twilight horizon
        const sunFade = THREE.MathUtils.smoothstep(sky.cel.sunAlt, -0.04, 0.12);
        this.sunMesh.material.opacity = sunFade;
        this.sunMesh.visible = sunFade > 0.001;
        const moonFade = THREE.MathUtils.smoothstep(sky.cel.moonAlt, -0.04, 0.12);
        this.moonMesh.material.opacity = moonFade;
        this.moonMesh.visible = moonFade > 0.001;

        // Continuous smooth transition between day and night key lights
        // Both lights smoothly cross-fade across the horizon so sunrise/sunset has zero pop.
        const sunFactor = THREE.MathUtils.smoothstep(sky.sunAlt, -0.05, 0.16);
        const moonFactor = 1.0 - THREE.MathUtils.smoothstep(sky.sunAlt, -0.04, 0.10);

        const fullSunIntensity = 3.6 + Math.sin(Math.max(0.0, sky.sunAlt)) * 1.8;
        this.sunLight.intensity = sunFactor * fullSunIntensity;
        this.sunLight.castShadow = sunFactor > 0.06 && sunFactor >= moonFactor;

        const fullMoonIntensity = Math.max(2.4, sky.mH * 3.0);
        this.moonLight.intensity = moonFactor * fullMoonIntensity;
        this.moonLight.castShadow = moonFactor > 0.06 && moonFactor > sunFactor;

        // Re-render the shadow maps on a fixed cadence, not purely on sun-angle
        // delta. A pure angle gate looked right in isolation and was wrong in
        // practice: at the ambient day speed (a ~4.5 min cycle) the 0.008 rad
        // threshold only fires about 3 times a second, which reads as visibly
        // jittery, stepped shadow motion rather than a smooth sweep -- worse
        // once foliage wind was added, since the canopy now moves every frame
        // while its shadow sat frozen for ~330ms at a time between updates.
        // ~12 Hz is still an ~80% reduction in shadow-pass cost from rendering
        // every frame, and frequent enough that PCFSoft's own blur hides the
        // gap between updates. A light that has just started/stopped casting
        // still forces an immediate refresh -- otherwise it would render with
        // no map at all until the next scheduled tick.
        const castingKey = (this.sunLight.castShadow ? 1 : 0) | (this.moonLight.castShadow ? 2 : 0);
        const shadowDue = (nowMs - (this._lastShadowMs ?? 0)) > 82;
        if (shadowDue || castingKey !== this._lastCastingKey) {
            this._lastShadowMs = nowMs;
            this._lastCastingKey = castingKey;
            this.renderer.shadowMap.needsUpdate = true;
        }

        const isMorning = Math.sin(this.sunAngle - Math.PI / 2) < 0;
        // Sun elevation warmth factor (1 at horizon/dawn/dusk, 0 high in sky)
        const sunWarmth = THREE.MathUtils.smoothstep(sky.sunAlt, 0.38, -0.02);

        if (isMorning) {
            this.sunMesh.material.color.lerpColors(C_SUN_HIGH, C_SUN_LOW, sunWarmth);
            this.sunLight.color.lerpColors(C_SUNLIGHT_HIGH, C_SUNLIGHT_DAWN, sunWarmth);
        } else {
            this.sunMesh.material.color.lerpColors(C_SUN_HIGH, C_SUN_LOW, sunWarmth);
            this.sunLight.color.lerpColors(C_SUNLIGHT_HIGH, C_SUNLIGHT_LOW, sunWarmth);
        }

        const moonWarmth = THREE.MathUtils.smoothstep(sky.cel.moonAlt, 0.38, -0.02);
        this.moonMesh.material.color.lerpColors(C_MOON_HIGH, C_MOON_LOW, moonWarmth);
        this.moonMesh.material.emissive.copy(this.moonMesh.material.color);
        this.moonLight.color.lerpColors(C_MOONLIGHT_HIGH, C_MOONLIGHT_LOW, moonWarmth);

        // Smooth twilight palette cross-fade (Dawn vs Dusk)
        const dawnDuskMix = THREE.MathUtils.clamp(-Math.sin(this.sunAngle - Math.PI / 2) * 1.5 + 0.5, 0.0, 1.0);
        _twiZenith.lerpColors(C_DUSK_ZENITH, C_DAWN_ZENITH, dawnDuskMix);
        _twiHorizon.lerpColors(C_DUSK_HORIZON, C_DAWN_HORIZON, dawnDuskMix);
        _twiHorizonOpp.lerpColors(C_DUSK_HORIZON_OPP, C_DAWN_HORIZON_OPP, dawnDuskMix);

        // 3-way continuous hermite blend between Day, Twilight, and Night
        const dayWeight = THREE.MathUtils.smoothstep(sky.sunAlt, -0.02, 0.22);
        const nightWeight = 1.0 - THREE.MathUtils.smoothstep(sky.sunAlt, -0.16, 0.04);
        const twiWeight = Math.max(0.0, 1.0 - dayWeight - nightWeight);

        blend3Colors(_skyColScratch, C_DAY_ZENITH, dayWeight, _twiZenith, twiWeight, C_NIGHT_ZENITH, nightWeight);
        blend3Colors(_horizColScratch, C_DAY_HORIZON, dayWeight, _twiHorizon, twiWeight, C_NIGHT_HORIZON, nightWeight);
        blend3Colors(_horizOppScratch, C_DAY_HORIZON_OPP, dayWeight, _twiHorizonOpp, twiWeight, C_NIGHT_HORIZON, nightWeight);

        const u = this.skySystem.skyDomeMat.uniforms;
        u.uZenithColor.value.copy(_skyColScratch);
        u.uHorizonColor.value.copy(_horizColScratch);
        if (u.uHorizonOpposite) u.uHorizonOpposite.value.copy(_horizOppScratch);
        if (u.uSunColor) u.uSunColor.value.copy(this.sunLight.color);
        this.scene.fog.color.copy(_horizColScratch);

        // Rich atmospheric ambient lighting
        blend3Colors(_hemiSkyScratch, C_HEMI_DAY, dayWeight, C_HEMI_DAWN, twiWeight, C_HEMI_NIGHT, nightWeight);
        blend3Colors(_hemiGndScratch, C_HEMI_GROUND_DAY, dayWeight, C_HEMI_GROUND_DAWN, twiWeight, C_HEMI_GROUND_NIGHT, nightWeight);

        // Night needs a floor it never had; day keeps its contrast.
        this.ambientLight.intensity = 0.02 + 0.06 * nightWeight;
        this.hemiLight.color.copy(_hemiSkyScratch);
        this.hemiLight.groundColor.copy(_hemiGndScratch);
        this.hemiLight.intensity = 0.30 * nightWeight + 0.36 * twiWeight + 0.40 * dayWeight;

        // Ground floor tint seamlessly matching celestial lighting
        const twiFloorColor = isMorning ? C_FLOOR_DAWN : C_FLOOR_TWILIGHT;
        blend3Colors(this.groundMat.color, C_FLOOR_NOON, dayWeight, twiFloorColor, twiWeight, C_FLOOR_MIDNIGHT, nightWeight);

        // The HUD carries two glass treatments (index.html's [data-tod] tokens)
        // because no single one is legible over both a pale noon sky and an
        // indigo night. Written only on an actual crossing, with hysteresis so
        // it does not flicker back and forth right at the boundary -- and CSS
        // transitions turn the swap into a 0.9s fade rather than a cut.
        const wantNight = this._hudNight ? nightWeight > 0.35 : nightWeight > 0.55;
        if (wantNight !== this._hudNight) {
            this._hudNight = wantNight;
            document.body.dataset.tod = wantNight ? 'night' : 'day';
        }

        if (!this.motionPaused) {
            if (this.garden && this.garden.update) this.garden.update(this.elapsed, dt);
            if (this.dust) this.dust.rotation.y += 0.0002;
        }

        // Damping can overshoot a limit for a frame, so clamp height as a backstop.
        if (this.camera.position.y < 0.4) this.camera.position.y = 0.4;

        this.controls.update();
        // One path for every device. Mobile used to bypass the composer, which
        // meant it applied tone mapping and the sRGB encode differently from
        // desktop -- so every colour tuned on a desktop was a colour phones
        // never showed. With bloom gone the composer is a render plus one
        // full-screen blit, which is affordable everywhere.
        this.composer.render();
    }
}

new GulmoharApp();
