import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DofPass, attachDepthTexture } from './src/post/dofPass.js';
import gsap from 'gsap';

import { createTorontoSkySystem } from './src/sky/celestial.js';
import { SKY_LOOKUP_GLSL } from './src/sky/atmosphere.js';
import { QUALITY, resolveQuality, sampleFrame, resetAdaptive } from './src/quality.js';
import { windUniforms } from './src/scene/wind.js';
import { loadGarden, GARDEN_POINTS, groundHeightAt, POND_WATER_Y, POND_EXTENT } from './src/scene/garden.js';
import { createGrassField } from './src/scene/grass.js';
import { createLawn } from './src/scene/lawn.js';
import {
    loadPlacements, mountAllPaintings, updatePaintingBillboards, commitPaintingShadows,
    setBillboardFrozen, setBillboardFocus, normalizeMount, METRES_PER_INCH
} from './src/scene/paintings.js';
// SDK-free geometry (see its own header) -- fitting trunk circles once at
// load, for collision, is the same one-time cost already paid here for the
// rope mount's canopy data, just also keeping the trunk half of the result.
import { fitSurfaces, fitGazeboPosts } from './src/place/surfaces.js';
import { SITE } from './src/content.js';
import { getAssetUrl } from './src/utils/paths.js';
import { FPSNavigator } from './src/controls/fpsNavigator.js';

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
const _hemiSkyScratch = new THREE.Color();
const _hemiGndScratch = new THREE.Color();
const _ambientColScratch = new THREE.Color();
const _skyFillScratch = new THREE.Color();

function blend3Colors(out, c1, w1, c2, w2, c3, w3) {
    out.r = c1.r * w1 + c2.r * w2 + c3.r * w3;
    out.g = c1.g * w1 + c2.g * w2 + c3.g * w3;
    out.b = c1.b * w1 + c2.b * w2 + c3.b * w3;
    return out;
}

const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// The sky, the sun's colour, the fog and the pond's reflections all come
// from the physically based atmosphere (src/sky/atmosphere.js) now. What is
// left here is only what the physics does not decide: night, and how bright
// each light is.
//
// Aerosol load: mornings are clearer than evenings (a day's convection and
// traffic lifts dust and haze), which is why sunrise skies run cooler and
// pinker and sunsets warmer and more orange. Values are x the textbook clear
// sky; 1.0 alone gives a pink, washed arch that no summer evening has.
const MIE_MORNING = 2.8;
const MIE_EVENING = 4.2;

const C_NIGHT_ZENITH = new THREE.Color(0x0a101e);      // deep velvet midnight indigo
const C_NIGHT_HORIZON = new THREE.Color(0x1a2436);
const C_WHITE = new THREE.Color(0xffffff);
const C_AMBIENT_DAY = new THREE.Color(0xfff5ea);

const C_MOON_HIGH = new THREE.Color(0xe8eef7);
const C_MOON_LOW = new THREE.Color(0xc8d6e6);
const C_MOON_EMISSIVE = new THREE.Color(0xe2eaf4);
const C_MOONLIGHT_HIGH = new THREE.Color(0xdbe5f3);
const C_MOONLIGHT_LOW = new THREE.Color(0xcbd9ea);

const C_HEMI_NIGHT = new THREE.Color(0x38486e);
const TWILIGHT_FILL_LUM = 0.42;                        // twilight sky-fill brightness; hue comes from the sky
const C_HEMI_GROUND_DUSK = new THREE.Color(0x6a3824);  // warm earthen sunset ground reflection
const C_HEMI_GROUND_DAWN = new THREE.Color(0x6e4228);  // warm dawn ground reflection
const C_HEMI_DAY = new THREE.Color(0xb0d2f8);
const C_HEMI_GROUND_NIGHT = new THREE.Color(0x283244);
const C_HEMI_GROUND_DAY = new THREE.Color(0x6a7d54);

// The lawn's tint is its albedo, which does not turn orange at sunset -- the
// light does, and painting it orange as well doubled the effect into rust.
// Twilight only darkens it a touch toward the night grade.
const C_FLOOR_NOON = new THREE.Color(0x486e30);      // lush verdant lawn turf base
const C_FLOOR_TWILIGHT = new THREE.Color(0x3e5e2c);
const C_FLOOR_MIDNIGHT = new THREE.Color(0x28382c);   // deep twilight forest floor

const AMBIENT_DAY_SPEED = 0.004;   // radians/sec of sun angle at rest (~4.5 min/day)
const UI_HIDE_MS = 6000;
const WALK_UI_HIDE_MS = 3200;
// How close orbit mode lets you get to a landmark. Focusing a painting drops
// it for the duration -- a canvas is viewed from about two metres, not six --
// and anything that moves the focus elsewhere puts it back.
const ORBIT_MIN_DISTANCE = 6.0;

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
        this._pickGroups = [];
        this._hoverOwner = new Map();
        this.hovered = null;
        this._hoverDirty = false;
        this._introStarted = false;
        this._contentReady = false;
        this._revealed = false;

        // Placement mode is a dynamic import, so a visitor who never arrives
        // with ?place downloads none of it -- and it pulls the whole Firebase
        // SDK with it, which is exactly what must never reach the visitor
        // bundle. Verified by scripts/check-bundle.mjs.
        const params = new URLSearchParams(location.search);
        // ?edit was the old in-scene editor, whose idea of saving was to hand
        // you a zip to unpack into the repo. The Studio replaced it. The URL
        // is kept as a redirect rather than dropped, because it is the one
        // the artist has bookmarked.
        if (params.has('edit')) {
            const q = new URLSearchParams(location.search);
            q.delete('edit');
            const rest = q.toString();
            location.replace(`./studio/${rest ? `?${rest}` : ''}`);
            return;
        }
        this.placeArtworkId = params.get('place') || null;
        if (this.placeArtworkId) {
            document.title = 'Gulmohar — place';
            const meta = document.createElement('meta');
            meta.name = 'robots';
            meta.content = 'noindex';
            document.head.appendChild(meta);
        }

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
        // Resolved before the renderer exists, because `antialias` is a
        // constructor option that cannot be changed afterwards -- resolveQuality
        // reads the GPU string from a throwaway context to manage that.
        resolveQuality();
        // Kept as a derived alias so nothing downstream has to change at once.
        // The old definition was a UA regex that missed modern iPads entirely
        // (iPadOS 13+ reports as a Mac) and was frozen at construction.
        this.isMobile = QUALITY.tier !== 'high';
        if (import.meta.env && import.meta.env.DEV) {
            console.info(`[quality] tier=${QUALITY.tier} (${QUALITY.reason})`);
        }

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.4, 6000);
        this.camera.fov = this._fovForAspect(window.innerWidth / window.innerHeight);
        this.camera.updateProjectionMatrix();
        this.camera.position.set(12.8, 3.2, 11.2);
        this.camera.lookAt(0, 2.8, 0);

        this.renderer = new THREE.WebGLRenderer({
            antialias: QUALITY.antialias,   // MSAA plus a composer is heavy bandwidth on phones
            powerPreference: 'high-performance',
            alpha: false,
            stencil: false,
            depth: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap));
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.15;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = QUALITY.shadowType;
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
        // A very subtle pointer-driven rack focus: whatever the pointer is
        // over stays sharp, distant lawn and canopy soften a little. Off
        // entirely on the low tier (QUALITY.dofTaps === 0). Depth comes free
        // off RenderPass's own depth test -- see src/post/dofPass.js for why
        // this is one extra full-screen pass rather than a second scene
        // render, and why the focus distance never leaves the GPU.
        this.dofPass = null;
        if (QUALITY.dofTaps > 0) {
            attachDepthTexture(this.composer);
            this.dofPass = new DofPass(this.camera, { taps: QUALITY.dofTaps, maxBlurPx: QUALITY.dofMaxBlurPx });
            this.composer.addPass(this.dofPass);
        }
        this.composer.addPass(new OutputPass());

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 2.8, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = ORBIT_MIN_DISTANCE;
        this.controls.maxDistance = 58;
        this.controls.maxPolarAngle = Math.PI * 0.48;   // low upward glance, never below ground
        this.controls.autoRotate = false;               // released when the intro descent begins
        this.controls.autoRotateSpeed = -0.35;

        // autoRotate keeps adding its own delta every frame regardless of
        // user input, so a drag while it's running fights the ambient spin
        // instead of replacing it -- the drag "doesn't stick". Suspend it for
        // the drag and a short settle afterward, rather than fighting it.
        // OrbitControls fires the same 'start' event for a one-finger drag
        // and a two-finger pinch, so this also covers pinch-zoom: touching
        // the scene at all hands full control over, cancelling whatever's
        // left of the scripted intro fly-in rather than fighting it.
        this.controls.addEventListener('start', () => {
            clearTimeout(this._dragRotateResumeTimer);
            this.controls.autoRotate = false;
            if (this._introTl) { this._introTl.kill(); this._introTl = null; }
        });
        this.controls.addEventListener('end', () => {
            clearTimeout(this._dragRotateResumeTimer);
            this._dragRotateResumeTimer = setTimeout(() => {
                if (!this.motionPaused && this._introStarted) this.controls.autoRotate = true;
            }, 2500);
        });

        this.scene.fog = new THREE.FogExp2(0x8ec2ec, 0.0018);   // light atmospheric depth without milky white washout

        this.setupLighting();
        this.setupEnvironment();
        this.setupDustMotes();
        // Placement mode brings its own controls -- mount options, size,
        // rotate, Save -- and they are the only ones that mean anything while
        // you are carrying a painting. Building the visitor dock as well put
        // two control surfaces on screen at once, with the home orb sitting
        // under the placement bar offering to fly the camera away mid-place.
        if (!this.placeArtworkId) {
            this.createDock();
            this._startClock();
        }

        // Seed the sky to the visitor's actual time of day; it drifts from there.
        const now = new Date();
        this.sunAngle = (((now.getHours() + now.getMinutes() / 60) - 6) / 24) * Math.PI * 2;

        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this.onResize(), 60);
        }, { passive: true });
        // A backgrounded tab produces garbage frame times; throw the window
        // away on return rather than adapting down off throttled frames.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) resetAdaptive();
        });
        window.addEventListener('pointermove', (e) => this.onPointerMove(e), { passive: true });

        this.navMode = 'orbit'; // 'orbit' | 'walk'
        this.fpsNavigator = new FPSNavigator(this.camera, this.renderer.domElement, {
            onModeChange: (isWalking) => {
                if (isWalking && this.navMode !== 'walk') this.setNavMode('walk');
            }
        });

        // Home is now only ever explicit, since a missed click no longer does
        // it. Escape is the keyboard route; the dock's Home button is the
        // pointer one.
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.navMode === 'walk') {
                    this.setNavMode('orbit');
                } else {
                    this.resetScene();
                }
                this.resetUIHideTimer();
            }
        });

        let startX = 0, startY = 0, startTime = 0;
        window.addEventListener('pointerdown', (e) => {
            startX = e.clientX; startY = e.clientY; startTime = performance.now();
            this.onPointerMove(e);              // touch has no hover; raycast on contact
            // Dock buttons stop propagation before this ever runs, so every
            // touch reaching here in walk mode is the canvas: engaging the
            // joystick, dragging to look, or a tap. Reviving the dock's timer
            // on EVERY one of those meant it never actually got out of the
            // way while playing -- each re-grip of the joystick reset the
            // clock. Reveal immediately for orbiting/browsing as before;
            // while walking, wait to see whether this turns into a real tap
            // (below) rather than a hold or a drag.
            if (this.navMode !== 'walk') this.resetUIHideTimer();
        });
        window.addEventListener('pointerup', (e) => {
            const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
            // A tap, not the end of an orbit drag, a walk/look drag, or a long press.
            if (moved < 8 && performance.now() - startTime < 350) {
                this.onClick(e);
                this.resetUIHideTimer();
            }
            if (e.pointerType === 'touch') this.hovered = null;
        });
        ['gesturestart', 'gesturechange', 'gestureend'].forEach(g =>
            window.addEventListener(g, (e) => e.preventDefault(), { passive: false })
        );

        try { this.renderer.compile(this.scene, this.camera); } catch (e) { /* noop */ }

        // Dev-only handle, so the scene can be inspected from the console.
        if (import.meta.env && import.meta.env.DEV) {
            window.__gulmohar = this;
            window.__quality = QUALITY;   // the live singleton, not a re-imported copy
            window.__wind = windUniforms; // ditto -- re-importing gives a phantom copy
        }

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

        // 2048 over this frustum was ~3.3cm/texel -- coarser than the leaf
        // and branch detail casting into it, which read as a blocky,
        // checkered ground shadow rather than an organic dapple. The shadow
        // map now only re-renders at a fixed ~12Hz (see animate()) rather
        // than every frame, which is what makes spending more of the budget
        // on resolution here affordable: 4096 brings it to ~1.66cm/texel.
        // 3072, not 4096: two 4096 maps are 4x the fill of 2048 each time the
        // 12Hz cadence fires, and at this frustum 3072 still resolves leaf
        // detail (~4.4cm/texel) well past the point 2048 went blocky.
        const shadowRes = QUALITY.shadowMapSize;
        // Sized to encompass the full garden radius (41m) plus outer canopy branches
        const d = 45.0;

        this.sunDist = 1600;
        this.sunLight = new THREE.DirectionalLight(0xfff2c8, 3.8);
        this.moonLight = new THREE.DirectionalLight(0xc8d8e8, 2.0);
        [this.sunLight, this.moonLight].forEach((light) => {
            light.castShadow = true;
            light.shadow.mapSize.set(shadowRes, shadowRes);
            // Light distance is 350 units; scene spans -45 to +45 from origin.
            // Tightening near (250) and far (450) concentrates depth buffer precision.
            light.shadow.camera.near = 250.0;
            light.shadow.camera.far = 450.0;
            Object.assign(light.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
            light.shadow.camera.updateProjectionMatrix();
            // Positive bias avoids self-shadow acne; normalBias handles grazing angles
            light.shadow.bias = 0.00005;
            light.shadow.normalBias = 0.022;
            // Now actually has an effect -- radius is honoured by PCFShadowMap
            light.shadow.radius = QUALITY.shadowRadius;
            this.scene.add(light);
            this.scene.add(light.target);
        });

        const sunTex = this.generateSunTexture();
        this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(38, 32, 32), new THREE.MeshBasicMaterial({
            map: sunTex, color: 0xffffff, fog: false, transparent: true, depthWrite: false
        }));
        this.sunMesh.renderOrder = -180;
        this.scene.add(this.sunMesh);

        const sunGlowTex = this.generateSunGlowTexture();
        const sunGlowMat = new THREE.SpriteMaterial({
            map: sunGlowTex,
            color: 0xff4c14,
            transparent: true,
            // Additive: the sky behind is HDR now and often brighter than 1,
            // so a normal-blended glow of any 0..1 colour DARKENED it -- a dull
            // ring around the sun, and a washed-out disc under it.
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false
        });
        this.sunGlow = new THREE.Sprite(sunGlowMat);
        this.sunGlow.scale.set(90, 90, 1);
        this.sunMesh.add(this.sunGlow);

        const moonTex = this.generateMoonTexture();
        this.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(30, 32, 32), new THREE.MeshStandardMaterial({
            map: moonTex, emissiveMap: moonTex, emissive: 0xe0e8f2, emissiveIntensity: 1.1,
            roughness: 0.92, metalness: 0, fog: false, transparent: true
        }));
        this.moonMesh.renderOrder = -180;
        this.scene.add(this.moonMesh);
    }

    generateSunTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.85, '#ffffff');
        grad.addColorStop(0.96, 'rgba(255, 255, 255, 0.85)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);
        return new THREE.CanvasTexture(canvas);
    }

    generateSunGlowTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
        grad.addColorStop(0.25, 'rgba(255, 255, 255, 0.40)');
        grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.08)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);
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
        // Ground: garden disc with a soft organic edge fade. The pond and
        // gazebo corners sit at r=28-31 and the pond's far bank reaches ~38,
        // so the fade band (below) has to start beyond that. 60m was an
        // overcorrection: a bare tan ring past the grass, and a lot of
        // transparent fill for nothing.
        // A tessellated plane rather than a CircleGeometry fan, because the
        // ground has relief -- the whole pond basin is this plane, displaced
        // by groundHeightAt(). 0.5m quads (80k triangles) so the banks curve
        // rather than facet where the water meets them; flat lawn costs the
        // same either way, and against a ~1M scene it is immaterial.
        const groundGeo = new THREE.PlaneGeometry(100, 100, 200, 200);
        groundGeo.rotateX(-Math.PI / 2);
        {
            const pos = groundGeo.attributes.position;
            for (let i = 0; i < pos.count; i++) {
                pos.setY(i, groundHeightAt(pos.getX(i), pos.getZ(i)));
            }
            pos.needsUpdate = true;
            groundGeo.computeVertexNormals();
        }

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
            depthWrite: true
        });
        // The pond's banks and bed wear the pond scene's own ground texture
        // (baked out by scripts/bake-pond-terrain.py), world-mapped.
        const pondBedTex = new THREE.TextureLoader(this.loadingManager).load(getAssetUrl('textures/pond_bed.jpg'));
        pondBedTex.wrapS = pondBedTex.wrapT = THREE.RepeatWrapping;
        pondBedTex.colorSpace = THREE.SRGBColorSpace;
        pondBedTex.anisotropy = this._maxAnisotropy();
        // Keyed on height relative to the water, like everything else about
        // the pond, so it follows the basin with no second copy of its shape.
        const W = POND_WATER_Y.toFixed(3);
        const pondBankGLSL = `smoothstep(${W} + 0.36, ${W} + 0.03, vGroundWorldPos.y)`;
        const floorNoonLum = luma(C_FLOOR_NOON).toFixed(5);
        this.groundMat.onBeforeCompile = (shader) => {
            // Same uniform objects as the dome, so the fade below always reads
            // the sky's current colour with no per-frame copying.
            Object.assign(shader.uniforms, this.skySystem.atmosphere.uniforms);
            shader.uniforms.uPondBed = { value: pondBedTex };
            shader.vertexShader = 'varying vec3 vGroundWorldPos;\n' + shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                '#include <worldpos_vertex>\n vGroundWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `#include <map_fragment>
                 // Swap the lawn's albedo for the pond bank's on the banks and
                 // under the water. The material colour carries the day/night
                 // floor grade, so the bank keeps its brightness, not its green.
                 {
                     float pondBank = ${pondBankGLSL};
                     if (pondBank > 0.0) {
                         vec3 bed = texture2D(uPondBed, vGroundWorldPos.xz * 0.21).rgb;
                         float grade = dot(diffuse, vec3(0.2126, 0.7152, 0.0722)) / ${floorNoonLum};
                         diffuseColor.rgb = mix(diffuseColor.rgb, bed * grade * 0.9, pondBank);
                     }
                 }`
            );
            shader.fragmentShader = 'varying vec3 vGroundWorldPos;\nuniform sampler2D uPondBed;\n' + SKY_LOOKUP_GLSL + shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                 // A tiled photograph repeats exactly every tile, which the eye
                 // catches even when the tile itself is convincing. Two overlapping
                 // sine fields at incommensurate, sub-tile frequencies multiply
                 // brightness by a CONTINUOUSLY varying +-6% -- deliberately not a
                 // floor()-based hash, which would draw its own hard-edged cell
                 // boundaries (exactly the blockiness fixed elsewhere this session).
                 float detile = sin(vGroundWorldPos.x * 0.11 + 1.3) * sin(vGroundWorldPos.z * 0.09 - 0.7)
                              + sin(vGroundWorldPos.x * 0.037 - 2.1) * sin(vGroundWorldPos.z * 0.043 + 0.4) * 0.6;
                 gl_FragColor.rgb *= 1.0 + detile * 0.06;

                 // The bake is a photograph of bare tan gravel, but this is a
                 // garden -- grade it toward lawn. Note this is still LINEAR
                 // HDR here, not sRGB: the scene renders through an
                 // EffectComposer, so <tonemapping_fragment> and
                 // <colorspace_fragment> above are no-ops and OutputPass does
                 // both at the end. Values can exceed 1, so anything that
                 // scales by luminance blows the ground out to white.
                 // Instead: keep each fragment's own luminance and only rotate
                 // its hue toward green, which is exposure-independent and
                 // leaves the photo's pebbles, wear and shading fully intact.
                 // The tint is luma-weighted to ~0.93 so it darkens a touch
                 // rather than brightening. A second low-frequency sine field
                 // varies HOW green each area gets, so it reads as patchy turf
                 // over worn earth instead of one flat wash of colour.
                 float groundLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                 vec3 greened = groundLum * vec3(0.70, 0.98, 0.62);
                 // NB: not "patch" -- that is a reserved word in GLSL ES 3.0
                 // (tessellation), and naming it that failed the whole ground
                 // shader to compile, which silently dropped the entire ground
                 // plane and left the sky dome showing below the horizon.
                 float turfPatch = sin(vGroundWorldPos.x * 0.055 + 0.6) * sin(vGroundWorldPos.z * 0.047 - 1.2)
                                 + sin(vGroundWorldPos.x * 0.021 - 1.7) * sin(vGroundWorldPos.z * 0.019 + 2.2) * 0.5;
                 // Not on the pond bank, which has its own texture (above).
                 gl_FragColor.rgb = mix(gl_FragColor.rgb, greened,
                     clamp(0.58 + turfPatch * 0.20, 0.28, 0.82) * (1.0 - ${pondBankGLSL}));

                 // Wet earth: a damp band a few cm above the waterline, then
                 // the bed darkening with depth, so the water reads as deep
                 // in the middle rather than as a tinted sheet over dry dirt.
                 float wet = smoothstep(${W} + 0.07, ${W} - 0.03, vGroundWorldPos.y) * 0.45
                           + smoothstep(${W} - 0.03, ${W} - 0.8, vGroundWorldPos.y) * 0.5;
                 gl_FragColor.rgb = mix(gl_FragColor.rgb,
                                        gl_FragColor.rgb * vec3(0.34, 0.40, 0.32), wet);

                 float r = length(vGroundWorldPos.xz);
                 // Two-stage horizon: mix toward the backdrop first, then fade
                 // alpha so the dome itself shows through. The mix target is
                 // the atmosphere in this exact view direction -- precisely
                 // what the dome draws behind this pixel (hazed distant land,
                 // below the horizon) -- so the lawn runs out into the
                 // landscape with no seam, warm toward the sun and cool and
                 // shadowed away from it, rather than into one averaged fog
                 // colour that matched neither side.
                 // Branch, not just a zero weight: the lookup is three texture
                 // reads plus trig, and the lawn fills much of the screen.
                 if (r > 38.0) {
                     vec3 edgeSky = atmosphereColor(normalize(vGroundWorldPos - cameraPosition));
                     gl_FragColor.rgb = mix(gl_FragColor.rgb, edgeSky, smoothstep(38.0, 47.0, r));
                 }
                 gl_FragColor.a *= 1.0 - smoothstep(41.0, 49.0, r);
                 // Seamless cutout for the sunken pond basin.
                 // No pond cutout any more. The lawn used to be punched
                 // through with a radial alpha hole so the pond model could sit
                 // in it, and that hole's soft edge was itself visible as a
                 // circular ring from low angles -- tightening the ramp only
                 // made it a harder ring. The ground now dips into a real
                 // basin instead (groundHeightAt in garden.js), so the lawn is
                 // continuous everywhere and there is simply no edge to see.
                 if (gl_FragColor.a <= 0.002) discard;`
            );
        };
        const ground = new THREE.Mesh(groundGeo, this.groundMat);
        // rotateX is already baked into the geometry above, so the mesh
        // itself stays unrotated -- the displaced Y is world Y.
        ground.receiveShadow = true;
        ground.renderOrder = 0;
        this.scene.add(ground);
        this.groundMesh = ground;   // placement mode raycasts it for ground mounts

        this.skySystem = createTorontoSkySystem(1800, QUALITY.skySegW, QUALITY.skySegH);
        this.scene.add(this.skySystem.skyRoot);

        // A baked top-down photograph of the ground, not the photogrammetry
        // scan's own texture tiled directly. That texture is a UV atlas --
        // charts packed for storage, not a picture of the ground from above
        // -- and tiling it drew the packing layout: coherent patches of
        // recognisable dirt separated by bands of visibly smeared, wrongly
        // oriented texture. This was rendered once, offline, by projecting
        // the scan's ground_close mesh orthographically onto its own plane
        // and rasterising every triangle with its real UVs (see the skill's
        // bake-floor-texture.py and the README for the exact command).
        new THREE.TextureLoader(this.loadingManager).load(getAssetUrl('textures/ground_baked.jpg'), (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.repeat.set(10, 10);
            tex.anisotropy = this._maxAnisotropy();
            this.groundMat.map = tex;
            this.groundMat.color.setHex(0xffffff);
            this.groundMat.needsUpdate = true;
        });

        loadGarden(this.loadingManager).then((garden) => {
            this.garden = garden;
            this.scene.add(garden.group);

            const aniso = Math.min(QUALITY.anisotropy, this._maxAnisotropy());
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

            garden.interactives.forEach(({ object, targetGroup, data }) => {
                this._registerHover(object, data);
                // Keep the landmark's actual geometry too. The hitboxes are
                // coarse cylinders, so a click on visible canopy or rock that
                // falls outside one would otherwise register as "nothing".
                if (targetGroup) this._pickGroups.push({ group: targetGroup, data });
            });

            // The lawn: real 3D blades (grass_blades.glb), tiled with
            // distance-based thinning and per-tile frustum culling -- see
            // src/scene/lawn.js. No shadow casting: thousands of 27cm blades
            // in the shadow pass would cost more than the rest of it combined
            // for shadows nobody could resolve. The tier sets its density; the
            // adaptive loop scales that at runtime (_applyQualityChange).
            // Steeper than the tier's grass count: the lawn is the scene's
            // largest geometry, and the low tier is a phone (~0.25 of top).
            this.lawnDensity = Math.min(1, Math.pow(QUALITY.grassCount / 46000, 1.5));
            this.lawn = createLawn(garden.grassBlades, {
                radius: QUALITY.grassRadius, density: this.lawnDensity
            });
            if (this.lawn) this.scene.add(this.lawn.group);

            // Wild edges, from meadow_clumps.glb: the lawn is kept, the rim
            // and the pond margin are let go to meadow, and small leafy plants
            // break up the lawn itself.
            const meadowTints = [0xb9c48a, 0xa6b878, 0xc8c894, 0x98ae6c].map((h) => new THREE.Color(h));
            this.meadowRim = createGrassField(garden.meadowClumps, QUALITY.grassRadius + 1, QUALITY.vegClumpCount * 7, {
                filter: /rostlinka_07c/, innerR: 30, targetHeight: 0.62, clearMargin: 0.5,
                name: 'MeadowRim', tints: meadowTints, seed: 71
            });
            this.scene.add(this.meadowRim);
            this.meadowPond = createGrassField(garden.meadowClumps, POND_EXTENT, QUALITY.vegClumpCount * 4, {
                filter: /rostlinka_07c/, center: GARDEN_POINTS.POND, targetHeight: 0.72,
                accept: (x, z) => groundHeightAt(x, z) < POND_WATER_Y + 0.42,
                name: 'MeadowPondMargin', tints: meadowTints, seed: 72
            });
            this.scene.add(this.meadowPond);
            this.lawnPlants = createGrassField(garden.meadowClumps, QUALITY.grassRadius - 2, QUALITY.vegClumpCount * 8, {
                filter: /r12_/, targetHeight: 0.14, clearMargin: 0.3, name: 'LawnPlants', seed: 73
            });
            this.scene.add(this.lawnPlants);

            // Trunks and the pavilion's posts become simple collision
            // circles -- so a garden you can hang a painting on the bark of
            // is also one you cannot walk straight through. The posts are
            // found by sweeping for them, so the entrance stays open without
            // anyone typing an angle. (The pond is not a circle and is
            // handled by the navigator's own waterline test instead.)
            const trunkColliders = [
                // collisionRadius, not radius: see surfaces.js. The radius a
                // painting hangs on is the clean central cylinder; the one a
                // walker is stopped by has to cover the whole trunk mass.
                ...fitSurfaces(garden.group).trunks.map((t) => ({ ...t, radius: t.collisionRadius || t.radius })),
                ...fitGazeboPosts(garden.group, GARDEN_POINTS.GAZEBO)
            ];
            this.fpsNavigator.setColliders(trunkColliders);

            // Paintings: a 404 on paintings.json resolves to an empty list
            // rather than rejecting, so a garden with nothing hung yet is not
            // an error state. Mounted onto named anchors within garden.group
            // (see resolveAnchor in paintings.js), so they move correctly if
            // a landmark is ever repositioned.
            loadPlacements().then((data) => {
                this.paintings = mountAllPaintings(garden.group, data.paintings, (object, hoverData) => {
                    this._registerHover(object, hoverData);
                });

                // Landmark name/description overrides from the Studio's
                // "Garden artifacts" section (src/studio/gardenSection.js).
                // garden.interactives' `data` objects are the exact objects
                // already registered as hover/click labels, so mutating them
                // in place is all this needs -- no separate copy to keep in
                // sync with what a click on the gulmohar actually shows.
                if (Array.isArray(data.landmarks) && data.landmarks.length) {
                    const overrides = new Map(data.landmarks.map((l) => [l.id, l]));
                    garden.interactives.forEach(({ data: hoverData }) => {
                        const o = hoverData && overrides.get(hoverData.id);
                        if (!o) return;
                        if (o.title) hoverData.title = o.title;
                        if (o.meta) hoverData.meta = o.meta;
                    });
                }

                // Every placed painting blocks walking through it too, not
                // just the trees -- a small circle at its own footprint,
                // added to the same list the trunks are already in.
                const paintingColliders = [...this.paintings.values()].map(({ group }) => {
                    const p = group.userData.placement;
                    const longSide = Math.max(p.widthIn || 24, p.heightIn || 24) * METRES_PER_INCH * (p.scale || 1);
                    return { x: group.position.x, z: group.position.z, radius: Math.max(longSide / 2, 0.25) };
                });
                this.fpsNavigator.setColliders([...trunkColliders, ...paintingColliders]);

                this._contentReady = true;
                this.renderer.shadowMap.needsUpdate = true;
                this._maybeStartIntro();

                if (this.placeArtworkId) {
                    import('./src/place/placeMode.js')
                        .then(({ attachPlaceMode }) => attachPlaceMode(this, this.placeArtworkId))
                        .then((mode) => { this.placeMode = mode; });
                }
            });
        });
    }

    setupDustMotes() {
        const count = QUALITY.dustCount;
        if (count <= 0) return;   // low tier drops them entirely
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
    /**
     * Fallback pick against a landmark's real meshes, for clicks that miss its
     * coarse hitbox cylinder. Only ever runs on click, never per frame.
     */
    _pickByGeometry() {
        let best = null, bestDist = Infinity;
        for (const entry of this._pickGroups) {
            const hits = this.raycaster.intersectObject(entry.group, true);
            if (hits.length && hits[0].distance < bestDist) {
                bestDist = hits[0].distance;
                best = entry.data;
            }
        }
        return best;
    }

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
        // No resetUIHideTimer() here -- this runs on EVERY pointermove
        // anywhere on the page (window listener below, passive), so it used
        // to mean the dock's countdown restarted on any mouse jiggle on
        // desktop and on every step of a joystick/look/orbit drag, which is
        // to say it effectively never auto-hid at all as long as a pointer
        // was doing anything. Revealing it is left to actual gestures:
        // pointerdown (below), a completed tap, and the dock's own buttons.
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
        // Editor gizmo drags satisfy the same "short, quick pointer" test a
        // real tap does -- without this, finishing a drag also fires a
        // scene click, which (finding no landmark under the gizmo) calls
        // resetScene() and flies the camera away from what was just placed.
        if (this._suppressClick) return;
        if (e && e.clientX !== undefined) {
            this.pointer.set(
                (e.clientX / window.innerWidth) * 2 - 1,
                -(e.clientY / window.innerHeight) * 2 + 1
            );
        }
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this._hoverTargets, true);

        // Every distinct landmark under the cursor, nearest first. The
        // landmark hitboxes are generous cylinders that overlap heavily, so
        // taking only the nearest made anything standing behind another tree
        // permanently unclickable -- the ray never got past whichever hitbox
        // happened to be in front.
        const candidates = [];
        for (let i = 0; i < hits.length; i++) {
            let cur = hits[i].object;
            while (cur) {
                if (this._hoverOwner.has(cur)) {
                    const data = this._hoverOwner.get(cur);
                    if (!candidates.includes(data)) candidates.push(data);
                    break;
                }
                cur = cur.parent;
            }
        }

        // A painting under the cursor outranks any landmark it overlaps,
        // however much nearer the landmark's hitbox happens to be: the
        // cylinders are metres wide and every painting hung on a tree sits
        // inside one, so by distance alone the tree always won and the
        // painting could never be selected where it actually hangs.
        candidates.sort((a, b) => (b.kind === 'painting') - (a.kind === 'painting'));

        // Clicking the same spot again steps to the next one behind, then
        // wraps. A click more than a few pixels away is a new selection and
        // starts from the front again.
        let targetData = null;
        if (candidates.length) {
            const nx = e && e.clientX !== undefined ? e.clientX : 0;
            const ny = e && e.clientY !== undefined ? e.clientY : 0;
            const samePlace = this._lastPick
                && Math.hypot(nx - this._lastPick.x, ny - this._lastPick.y) < 24
                && (performance.now() - this._lastPick.t) < 4000;
            const idx = samePlace ? (this._lastPick.i + 1) % candidates.length : 0;
            targetData = candidates[idx];
            this._lastPick = { x: nx, y: ny, i: idx, t: performance.now() };
        } else {
            this._lastPick = null;
        }

        if (!targetData && this.hovered) targetData = this.hovered;
        // Last resort: the coarse hitbox cylinders miss plenty of real
        // clicks -- on outlying canopy, on a rock at the pond's edge -- so
        // fall back to the landmarks' actual geometry before giving up.
        if (!targetData) targetData = this._pickByGeometry();

        // A painting behaves identically wherever it was clicked from -- the
        // same framed, dolly-zoomable, billboard-tracking focus onClick
        // already gives it in orbit mode, not the FPS fast-travel-and-stare
        // landmarks get. Handled first and unconditionally, so walk mode
        // simply hands off to orbit for it rather than keeping a second,
        // divergent way to look at a painting in sync with the first.
        if (targetData && targetData.kind === 'painting' && targetData.cameraTarget) {
            if (this.navMode === 'walk') this.setNavMode('orbit');
            const { pos, lookAt, worldHeight } = targetData.cameraTarget;
            this.controls.minDistance = this._paintingDollyLimit(worldHeight, pos.distanceTo(lookAt));
            this._setPaintingFocus(targetData.id, pos.distanceTo(lookAt));
            gsap.killTweensOf(this.camera.position);
            gsap.killTweensOf(this.controls.target);
            gsap.to(this.camera.position, { x: pos.x, y: pos.y, z: pos.z, duration: 1.4, ease: 'power2.inOut' });
            gsap.to(this.controls.target, { x: lookAt.x, y: lookAt.y, z: lookAt.z, duration: 1.4, ease: 'power2.inOut' });
            this.setUIVisibility(true);
            return;
        }

        if (this.navMode === 'walk') {
            if (targetData && targetData.cameraTarget) {
                // A landmark still fast-travels to it on foot -- that is
                // choosing a destination to walk toward, unlike a painting.
                this.fpsNavigator.fastTravelTo(targetData.cameraTarget.pos.x, targetData.cameraTarget.pos.z, targetData.cameraTarget.lookAt, 1.3);
            } else if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
                // A tap on open ground/grass used to fast-travel there too,
                // which is nearly every tap in walk mode -- WASD/the joystick
                // already move you, so a tap meant to bring the dock back
                // kept also snapping the camera to stare down at whatever
                // patch of grass happened to be under the reticle. Now it
                // does the one thing that tap actually meant: on desktop,
                // re-arm mouse-look; either way, just reveal the dock.
                this.fpsNavigator.requestPointerLock();
            }
            if (targetData && targetData.cameraTarget) this.setUIVisibility(true);
            else this.hideUIForSceneTap();
            return;
        }

        if (targetData && targetData.cameraTarget) {
            // A landmark only -- a painting returned above already.
            const { pos, lookAt } = targetData.cameraTarget;
            // OrbitControls re-clamps the camera to minDistance on its next
            // update, so tweening to a spot nearer than that is undone within
            // a frame. Landmarks keep the coarser 6m floor; it is only a
            // painting's focus that needs to drop all the way to filling the
            // screen, handled in the painting branch above.
            this.controls.minDistance = ORBIT_MIN_DISTANCE;
            this._setPaintingFocus(null);
            gsap.killTweensOf(this.camera.position);
            gsap.killTweensOf(this.controls.target);
            gsap.to(this.camera.position, {
                x: pos.x, y: pos.y, z: pos.z,
                duration: 1.4,
                ease: 'power2.inOut'
            });
            gsap.to(this.controls.target, {
                x: lookAt.x, y: lookAt.y, z: lookAt.z,
                duration: 1.4,
                ease: 'power2.inOut'
            });
            this.setUIVisibility(true);
        } else {
            // Nothing nameable under the cursor. This used to raycast the
            // whole garden and the ground, then slide the orbit pivot to
            // whatever it found -- which is almost every click, since grass
            // covers the screen. Moving the pivot without moving the camera
            // re-frames the whole shot: the garden appears to swing and pull
            // back on its own, from a click the visitor meant as nothing more
            // than "put the dock away". A click on empty space now does only
            // that, and leaves the camera exactly where it was.
            this.hideUIForSceneTap();
        }
    }

    /**
     * How close the orbit dolly may go once a painting is focused: all the
     * way to filling the screen top to bottom, not an arbitrary fraction of
     * the initial framed shot. `worldHeight` comes from the painting's own
     * cameraTarget (undefined for a landmark, which keeps the old, coarser
     * fraction-of-framing-distance floor those still need).
     */
    _paintingDollyLimit(worldHeight, framingDist) {
        if (!worldHeight) return Math.min(ORBIT_MIN_DISTANCE, framingDist * 0.9);
        const vFov = THREE.MathUtils.degToRad(this.camera.fov);
        const fill = (worldHeight / 2) / Math.tan(vFov / 2);
        // Never closer than just past the near clip plane -- without this a
        // small painting's fill distance can undercut it and the camera
        // clips straight through the canvas before reaching the limit.
        return Math.max(fill, this.camera.near + 0.15);
    }

    /**
     * Holds one painting still while you are looking at it, and lets go when
     * you leave. Without the release it stayed frozen for the rest of the
     * session: click one painting and it never turned to face you again.
     */
    _setPaintingFocus(id, focusDist = 0) {
        setBillboardFrozen(this.paintings, id);
        // Widens this one painting's turn limit for as long as it is the one
        // being looked at; a surface mount barely moves otherwise.
        setBillboardFocus(this.paintings, id);
        // Letting go of a painting also gives the orbit floor back, or you
        // would keep a canvas's 1.5m dolly limit for the rest of the session
        // and be able to push the camera inside the landmarks.
        if (!id) this.controls.minDistance = ORBIT_MIN_DISTANCE;
        // `armed` guards the approach. The focus tween starts far outside the
        // release radius, so releasing on distance alone would let go on the
        // first frame; it arms only once the camera has actually arrived.
        this._paintingFocus = id ? { id, release: focusDist * 1.8 + 1.0, armed: false } : null;

        // Only a painting resting on the ground has grass in front of it at
        // all -- the other mounts stand clear of the lawn -- so only that one
        // opens a patch. Cleared on both id === null (walked away) and any
        // other mount, and lawn.tickClearZone eases the patch shut either
        // way; it does not snap closed the instant focus changes.
        const m = id && this.paintings && this.paintings.get(id);
        const record = m && m.group.userData.placement;
        if (record && normalizeMount(record.mount) === 'ground') {
            const scale = record.scale || 1;
            const w = (record.widthIn || 24) * METRES_PER_INCH * scale;
            const h = (record.heightIn || 24) * METRES_PER_INCH * scale;
            this._groundClearTarget = { x: m.group.position.x, z: m.group.position.z, radius: Math.max(w, h) / 2 + 0.4 };
        } else {
            this._groundClearTarget = null;
        }
    }

    _updatePaintingFocus() {
        const f = this._paintingFocus;
        if (!f || !this.paintings) return;
        const m = this.paintings.get(f.id);
        if (!m) { this._setPaintingFocus(null); return; }
        const d = this.camera.position.distanceTo(m.group.position);
        if (!f.armed) {
            if (d > f.release) return;
            f.armed = true;
            // The freeze exists only to survive the fly-in: cameraTarget is
            // computed once, before the tween starts, so if the painting kept
            // turning to chase the moving camera mid-flight it would arrive
            // facing somewhere the shot was no longer framed for. Once the
            // camera has actually landed, holding it frozen stops it doing
            // the one thing "billboard" means -- from here on, orbiting
            // around a zoomed-in painting should still turn it to face you.
            setBillboardFrozen(this.paintings, null);
            return;
        }
        if (d > f.release) this._setPaintingFocus(null);
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

        // Arriving to place a painting, you are already carrying it -- an
        // orbiting bird's-eye of the garden is the wrong first move. Start on
        // foot, near the gulmohar, facing out into the open lawn.
        if (this.placeArtworkId) {
            this.camera.position.set(10.5, 1.7, 9.0);
            this.camera.lookAt(0, 1.7, 0);
            this.controls.autoRotate = false;
            this.setNavMode('walk');
            return;
        }

        // An artist can flag one placed painting as where a visitor's camera
        // opens, instead of the standard establishing shot -- set from the
        // Studio, see setStartHere() in src/cloud/artworks.js. Only a placed
        // one can be flagged this meaningfully (see schema.js), but a flag
        // left over from a since-unplaced painting is still handled here,
        // not assumed away: it just falls through to the default intro below.
        const startHere = this._findStartHerePainting();
        if (startHere) { this._startIntroOnPainting(startHere); return; }

        // A snap to a distant bird's-eye followed by a slow-starting ease
        // read as a dead pause before anything moved. Starting from a small
        // pull-back on the final framing instead, eased straight into the
        // ambient rotation at the same moment the loader fades, means the
        // very first thing a visitor sees is already in motion.
        const target = { x: 12.8, y: 3.2, z: 11.2 };
        this.camera.position.set(target.x * 1.3, target.y + 4.5, target.z * 1.3);
        this.controls.target.set(0, 2.8, 0);

        const tl = gsap.timeline();
        this._introTl = tl;
        tl.to(this.camera.position, { ...target, duration: 2.4, ease: 'sine.out' }, 0);
        tl.call(() => { this.controls.autoRotate = !this.motionPaused; }, null, 0);
        tl.fromTo(this.controls, { autoRotateSpeed: 0 },
            { autoRotateSpeed: -0.4, duration: 3.2, ease: 'sine.inOut' }, 0);
    }

    _findStartHerePainting() {
        if (!this.paintings) return null;
        for (const m of this.paintings.values()) {
            if (m.group.userData.placement && m.group.userData.placement.startHere) return m;
        }
        return null;
    }

    /**
     * The flagged-painting opening: the same framed shot a click on this
     * painting would produce, approached from a small pull-back along the
     * same sightline rather than snapped to directly, so it reads as the
     * intended first move rather than the camera just starting there.
     * Reuses the exact focus machinery a click uses (see onClick) -- the
     * painting billboards toward the approaching camera, freezes once it
     * arrives, and a ground-lain one parts the grass around it -- so this
     * is not a separate, parallel path to keep in sync with that one.
     */
    _startIntroOnPainting(m) {
        const { pos, lookAt, worldHeight } = m.interactive.data.cameraTarget;
        const dist = pos.distanceTo(lookAt) || 1;
        const pullBack = pos.clone().sub(lookAt).normalize().multiplyScalar(dist * 1.9).add(lookAt);
        pullBack.y += 1.2;

        this.camera.position.copy(pullBack);
        this.controls.target.copy(lookAt);
        this.controls.minDistance = this._paintingDollyLimit(worldHeight, dist);
        this._setPaintingFocus(m.interactive.data.id, dist);

        const tl = gsap.timeline();
        this._introTl = tl;
        tl.to(this.camera.position, { x: pos.x, y: pos.y, z: pos.z, duration: 2.6, ease: 'sine.inOut' }, 0);
        tl.to(this.controls.target, { x: lookAt.x, y: lookAt.y, z: lookAt.z, duration: 2.6, ease: 'sine.inOut' }, 0);
    }

    /**
     * Applies a runtime quality change. Only levers that are genuinely free
     * mid-session: pixel ratio, and InstancedMesh draw ranges.
     */
    _applyQualityChange({ direction, pixelRatio, instanceScale }) {
        const target = Math.min(window.devicePixelRatio, pixelRatio);
        if (Math.abs(this.renderer.getPixelRatio() - target) > 0.01) {
            this.renderer.setPixelRatio(target);
            // Must follow setPixelRatio: EffectComposer.setSize re-reads the
            // renderer's pixel ratio, and without this its render targets stay
            // at the old resolution and the change does nothing.
            this.composer.setSize(window.innerWidth, window.innerHeight);
        }

        // `count` is a draw range, not an allocation -- lowering it costs
        // nothing and needs no matrix re-upload. Grass is now a Group of
        // per-card InstancedMeshes, so it comes through this same traversal
        // via userData.baseCount rather than needing a special case.
        this.scene.traverse((o) => {
            if (o.isInstancedMesh && o.userData.baseCount) {
                o.count = Math.max(1, Math.round(o.userData.baseCount * instanceScale));
            }
        });
        // The lawn sets its own instance counts every frame (per-tile LOD),
        // so it takes the same scale as a blade density instead.
        if (this.lawn) this.lawn.setDensityScale(instanceScale);

        this.renderer.shadowMap.needsUpdate = true;
        if (import.meta.env && import.meta.env.DEV) {
            console.info(`[quality] adapt ${direction}: pixelRatio=${target.toFixed(2)} instanceScale=${instanceScale}`);
        }
    }

    resetScene() {
        if (this.navMode === 'walk') {
            this.setNavMode('orbit');
        }
        if (this._introTl) { this._introTl.kill(); this._introTl = null; }
        gsap.killTweensOf(this.camera.position);
        gsap.killTweensOf(this.controls.target);

        this.controls.enabled = true;
        this.controls.minDistance = ORBIT_MIN_DISTANCE;   // a painting may have lowered it
        this._setPaintingFocus(null);
        this.camera.fov = this._fovForAspect(window.innerWidth / window.innerHeight);
        this.camera.updateProjectionMatrix();

        gsap.to(this.camera.position, {
            x: 12.8, y: 3.2, z: 11.2,
            duration: 1.8,
            ease: 'power2.inOut',
            onComplete: () => {
                if (!this.motionPaused && this._introStarted) this.controls.autoRotate = true;
            }
        });
        gsap.to(this.controls.target, {
            x: 0, y: 2.8, z: 0,
            duration: 1.8,
            ease: 'power2.inOut'
        });
        this.setUIVisibility(true);
    }

    toggleNavMode() {
        this.setNavMode(this.navMode === 'walk' ? 'orbit' : 'walk');
    }

    setNavMode(mode) {
        if (mode === this.navMode) return;
        this.navMode = mode;

        if (mode === 'walk') {
            this.controls.enabled = false;
            this.controls.autoRotate = false;
            if (this._introTl) { this._introTl.kill(); this._introTl = null; }
            gsap.killTweensOf(this.camera.position);
            gsap.killTweensOf(this.controls.target);

            if (this.walkBtn) this.walkBtn.classList.add('active-walk');
            // Start walk navigation directly from active camera angle & position
            this.fpsNavigator.enableFromCamera();
        } else {
            this.fpsNavigator.disable();
            if (this.walkBtn) this.walkBtn.classList.remove('active-walk');
            this.controls.enabled = true;
            // Orient OrbitControls target ahead of current camera view so orbit resumes naturally
            const forward = new THREE.Vector3();
            this.camera.getWorldDirection(forward);
            this.controls.target.copy(this.camera.position).addScaledVector(forward, 8.0);
            this.controls.update();
        }
        this.resetUIHideTimer();
    }

    // A time-warp tap swaps the whole sky in one step -- easy to miss when
    // framed tight on one landmark. Pulling back gives a wider, more legible
    // view of the change without touching where the visitor was looking.
    _pullBackForLightChange() {
        const offset = this.camera.position.clone().sub(this.controls.target);
        const dist = offset.length();
        const newDist = Math.min(this.controls.maxDistance * 0.92, dist * 1.55);
        if (newDist <= dist) return;
        const newPos = this.controls.target.clone().addScaledVector(offset.normalize(), newDist);
        gsap.to(this.camera.position, { x: newPos.x, y: newPos.y, z: newPos.z, duration: 1.5, ease: 'sine.inOut' });
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

    // "Paused" means the same thing everywhere: the sky clock and the camera
    // orbit both stop. A half-moving state is one no label can describe
    // honestly. The `rotation: false` option is the one exception, used by the
    // time buttons, which resume the clock without also restarting the orbit
    // under someone who is deliberately holding a view.
    setMotionPaused(paused, { rotation = true } = {}) {
        this.motionPaused = paused;

        // Resuming has to restart the sky clock too, or "Resume motion" is a
        // lie. Tapping Noon / Midnight / Time-warp parks the sun at a chosen
        // hour by setting daySpeed to 0; before this, unpausing started the
        // camera orbit again but left the clock frozen at that hour with no
        // way to restart it short of a reload. Only a STOPPED clock is
        // restored -- a deliberate time-lapse speed set by holding a time
        // button is left alone, and the long-press handlers that call this
        // before ramping daySpeed themselves are unaffected.
        if (!paused && this.daySpeed <= 0) this.daySpeed = AMBIENT_DAY_SPEED;

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
        // A dock put away on purpose stays away. This runs on ordinary
        // pointer activity, and a tap is pointer activity, so without this
        // the tap's own move event summoned the dock straight back in the
        // same gesture that dismissed it -- hideUIForSceneTap hid it and
        // this line re-showed it a frame later. Only the orb (or a control)
        // clears the dismissal.
        if (!this.uiVisible && !this._uiDismissed) this.setUIVisibility(true);
        // Shorter while walking: the touch controls (joystick, jump, sprint)
        // already cover "how do I move", so the top dock lingering for the
        // same 6s it gets during idle orbiting just sits in the way of the
        // view a moment longer than it needs to.
        const delay = this.navMode === 'walk' ? WALK_UI_HIDE_MS : UI_HIDE_MS;
        this._uiHideTimer = setTimeout(() => this.setUIVisibility(false), delay);
    }

    /**
     * A tap on empty scene flips the dock rather than only ever summoning it:
     * with the orb always on screen there is now a way back, so tapping to
     * put the controls away is worth having. Taps that actually hit
     * something (a painting, a landmark) still just reveal it -- you are
     * engaging with the scene, not asking for the chrome to go.
     */
    toggleUIVisibility() {
        if (this.uiVisible) {
            clearTimeout(this._uiHideTimer);
            this.setUIVisibility(false);
        } else {
            this.resetUIHideTimer();
        }
    }

    /**
     * What a tap on empty scene means: put the dock away. Not a toggle --
     * tapping the garden is how you get an unobstructed look at it, and a
     * toggle made every other such tap pop the chrome back up over the view.
     * The orb it collapses into is the way back, and it is right there.
     */
    hideUIForSceneTap() {
        clearTimeout(this._uiHideTimer);
        this._uiDismissed = true;
        this.setUIVisibility(false);
    }

    setUIVisibility(visible) {
        this.uiVisible = visible;
        // Anything that deliberately shows the dock -- the orb, clicking a
        // landmark or a painting -- also lifts the dismissal, so the next
        // idle timeout behaves normally again.
        if (visible) this._uiDismissed = false;
        // Two states of one control sharing a spot in the dock's grid: the
        // bar grows out of the orb and the orb fades up through it, so
        // exactly one of the pair is ever showing.
        if (this.uiBar) this.uiBar.classList.toggle('bar-collapsed', !visible);
        if (this.homeOrb) this.homeOrb.classList.toggle('orb-hidden', visible);
        const clock = document.getElementById('clock');
        if (clock) clock.classList.toggle('ui-hidden', !visible);
    }

    createDock() {
        const container = document.createElement('div');
        container.id = 'dock';
        this.uiContainer = container;

        const wrapper = document.createElement('div');
        wrapper.className = 'glass-bar-wrapper';
        this.uiBar = wrapper;
        wrapper.onmouseenter = () => this.resetUIHideTimer();

        const icons = {
            // A rounded canopy over a short trunk -- this garden's landing
            // page is a tree-centred scene, so "home" reads more directly as
            // the gulmohar than the old diamond did.
            // A two-tier pine silhouette, not a rounded canopy -- a circle-
            // on-a-stick reads as a balloon or a lollipop at dock size just
            // as easily as a tree, and the organic blob before that read as
            // a smudge. Two stacked triangles over a trunk is unambiguous at
            // any size, which is what an outline-only icon most needs.
            // Drawn for the orb, which renders it at 26px rather than the
            // dock's 14px -- at that size a real canopy silhouette with a
            // forked trunk reads properly, where at 14px it collapsed into a
            // smudge and had to be flattened into bare triangles.
            // A gulmohar in silhouette: broad, flat-topped, wider than it is
            // tall. Built from overlapping filled circles rather than one
            // traced outline -- they merge into a single lobed crown that
            // survives being scaled down to an orb, which a hand-tuned path
            // at this size does not.
            // A gulmohar in silhouette. The crown is built from two rows of
            // overlapping filled circles -- a wide flat lower band and a
            // shorter upper one -- which merge into the species' actual
            // shape: a broad, flat-topped umbrella far wider than it is tall.
            // Circles rather than one traced outline because a hand-tuned
            // path this size falls apart when the orb scales it down.
            // Deliberately no angled limbs below the crown: drawn solid, a
            // trunk with two down-swept branches resolves into an arrowhead,
            // and the whole icon reads as a download button.
            home: `<svg viewBox="0 0 24 24" class="solid-icon"><circle cx="5.4" cy="10.1" r="3.1"/><circle cx="8.7" cy="10.6" r="3.2"/><circle cx="12" cy="10.7" r="3.3"/><circle cx="15.3" cy="10.6" r="3.2"/><circle cx="18.6" cy="10.1" r="3.1"/><circle cx="8.6" cy="7.5" r="2.9"/><circle cx="12" cy="6.9" r="3.1"/><circle cx="15.4" cy="7.5" r="2.9"/><path d="M11.3 21.3V11.5h1.4v9.8z"/><path d="M9.2 21.9q1.5-1 2.8-1.1 1.3.1 2.8 1.1z"/></svg>`,
            day: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 1v1.5M12 21.5V23M1 12h1.5M21.5 12H23"/></svg>`,
            night: `<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
            pause: `<svg viewBox="0 0 24 24"><rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/></svg>`,
            play: `<svg viewBox="0 0 24 24"><path d="M8 5.4L18.4 12 8 18.6Z"/></svg>`,
            work: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
            about: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.6"/></svg>`,
            // A walking figure with independent shoulder and hip joints, so
            // the arms and legs read as swinging opposite each other rather
            // than five lines radiating from one point -- which is what the
            // first attempt at this looked like at 14px: a star, not a
            // person walking.
            // The limbs are separate elements inside .walk-fig purely so CSS
            // can swing them (see index.html) -- a pedestrian signal that is
            // always mid-stride, rather than a figure standing still on a
            // button labelled "walk".
            // The crossing-signal pedestrian: solid head, thick round-capped
            // limbs, leaning into the stride. Arms and legs swing in
            // opposition, so it is always mid-walk.
            walk: `<svg viewBox="0 0 24 24" class="solid-icon walk-icon"><g class="walk-fig"><circle cx="12.5" cy="3.8" r="2.3"/><path d="M12.3 6.6 11.4 13.2"/><path class="leg-a" d="M11.4 13.2 14.3 16.3 13.7 20.7"/><path class="leg-b" d="M11.4 13.2 8.7 16.5 8.1 20.7"/><path class="arm-a" d="M12.1 7.4 9.2 10.1 9.9 13.6"/><path class="arm-b" d="M12.1 7.4 14.8 9.9 14.1 13.4"/></g></svg>`,
            instagram: `<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`
        };
        this._motionIcons = { pause: icons.pause, play: icons.play };

        const createBtn = (svg, onClick, label = '') => {
            const btn = document.createElement('button');
            btn.type = 'button';
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
                let startX = 0, startY = 0, startTime = 0;
                let triggerFired = false;
                const fire = (e) => {
                    if (e) {
                        e.stopPropagation();
                    }
                    onClick();
                    this.resetUIHideTimer();
                };

                btn.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    // Stops the browser reading this touch as the start of a
                    // scroll on the bar (it overflow-scrolls on narrow
                    // phones) rather than a tap -- see the addLongPress note.
                    e.preventDefault();
                    startX = e.clientX;
                    startY = e.clientY;
                    startTime = performance.now();
                    triggerFired = false;
                });

                btn.addEventListener('pointerup', (e) => {
                    e.stopPropagation();
                    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
                    if (dist < 18 && (performance.now() - startTime) < 500) {
                        triggerFired = true;
                        fire(e);
                    }
                });

                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (!triggerFired) fire(e);
                };
            } else {
                btn.addEventListener('pointerdown', e => e.stopPropagation());
                btn.addEventListener('pointerup', e => e.stopPropagation());
            }
            return btn;
        };

        const HOLD_MS = 420;
        const addLongPress = (btn, onInterval, onTap) => {
            let interval = null, startedAt = 0, isLongPress = false;
            const start = (e) => {
                e.stopPropagation();
                // Without this, a touch that starts on the button can still be
                // read by the browser as the first move of a scroll on the bar
                // (it overflow-scrolls on narrow phones) and be handed off with
                // a pointercancel rather than a pointerup -- see settle() below
                // for what that used to do unchecked.
                e.preventDefault();
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
            // Release means "stay where you left it" for the time buttons, and
            // "settle back to ambient" for the motion button -- shared by a
            // real release and a cancelled touch, so a gesture the browser
            // aborts mid-hold still stops ramping instead of being stuck open.
            const settle = () => {
                if (btn === this.motionBtn) {
                    this.controls.autoRotateSpeed = -0.35;
                    this.daySpeed = AMBIENT_DAY_SPEED;
                } else {
                    this.daySpeed = 0;
                }
            };
            const end = (e) => {
                if (interval) { clearInterval(interval); interval = null; }
                if (startedAt && performance.now() - startedAt > HOLD_MS) isLongPress = true;
                if (!isLongPress && onTap && e.type !== 'pointerleave') {
                    onTap();
                    this.resetUIHideTimer();
                } else if (isLongPress) {
                    settle();
                }
                startedAt = 0;
            };
            // A cancelled touch is not a tap -- onTap never fires for one --
            // but if the hold had already started ramping autoRotate/daySpeed,
            // that has to be undone here too, or it was PERMANENT: nothing else
            // ever clears `interval`, so onInterval kept firing every 50ms
            // forever, autoRotate re-enabling itself and daySpeed climbing
            // long after the finger left the screen. This is what made a tap
            // on the motion button occasionally spin the camera away and race
            // the sky on its own with no further input.
            const cancel = () => {
                if (interval) { clearInterval(interval); interval = null; }
                if (startedAt && performance.now() - startedAt > HOLD_MS) isLongPress = true;
                if (isLongPress) settle();
                startedAt = 0;
            };
            btn.addEventListener('pointerdown', start);
            btn.addEventListener('pointerup', end);
            btn.addEventListener('pointerleave', end);   // a finger sliding off must not stick
            btn.addEventListener('pointercancel', cancel);
        };

        const walkBtn = createBtn(icons.walk, () => this.toggleNavMode(), 'Walk / Explore · WASD or touch to navigate');
        this.walkBtn = walkBtn;

        // No onClick: the long-press handler owns both paths, or a tap fires twice.
        const motionBtn = createBtn(icons.pause, null, 'Pause motion · Hold to speed up');
        motionBtn.style.color = '#fff';
        this.motionBtn = motionBtn;
        addLongPress(motionBtn, () => {
            if (this.motionPaused) this.setMotionPaused(false);
            this.controls.autoRotate = true;
            if (this.controls.autoRotateSpeed > -1.2) this.controls.autoRotateSpeed = -1.2;
            this.controls.autoRotateSpeed = Math.max(-9.0, this.controls.autoRotateSpeed * 1.08);
            if (this.daySpeed < 0.035) this.daySpeed = 0.035;
            this.daySpeed = Math.min(0.28, this.daySpeed * 1.08);
        }, () => this.setMotionPaused(!this.motionPaused));

        const sunBtn = createBtn(icons.day, null, 'Noon · Hold for a time-lapse');
        sunBtn.classList.add('day-btn');
        addLongPress(sunBtn, () => {
            if (this.motionPaused) this.setMotionPaused(false, { rotation: false });
            if (this.daySpeed < 0.035) this.daySpeed = 0.035;
            this.daySpeed = Math.min(0.28, this.daySpeed * 1.08);
        }, () => { this.sunAngle = Math.PI / 2; this.daySpeed = 0; });

        const moonBtn = createBtn(icons.night, null, 'Midnight · Hold for a time-lapse');
        moonBtn.classList.add('night-btn');
        addLongPress(moonBtn, () => {
            if (this.motionPaused) this.setMotionPaused(false, { rotation: false });
            if (this.daySpeed < 0.035) this.daySpeed = 0.035;
            this.daySpeed = Math.min(0.28, this.daySpeed * 1.08);
        }, () => { this.sunAngle = 3 * Math.PI / 2; this.daySpeed = 0; });

        // The routes to the flat pages also exist in the always-visible corner
        // nav, since the dock auto-hides and these must never become unreachable.
        const workBtn = createBtn(icons.work, () => { window.location.href = './work/'; }, 'Work');
        const aboutBtn = createBtn(icons.about, () => { window.location.href = './about/'; }, 'About');

        // No separate "time warp" control any more -- its hold ramped the
        // same daySpeed the motion button's hold already does, and its tap
        // (step 15deg per click) is redundant with a brief hold-and-release
        // on Day/Night/Motion. One fewer button, and one motion model:
        // Motion's tap pauses or resumes everything together, its hold fast-
        // forwards it, and Day/Night still jump straight to a chosen hour.
        // Home leads the bar. The orb is the same control collapsed, and the
        // orb is gone while the bar is open, so without this there is no way
        // back to the start without first closing the dock.
        const homeBtn = createBtn(icons.home, () => this.resetScene(), 'Home · back to the garden');

        wrapper.append(homeBtn, walkBtn, motionBtn, sunBtn, moonBtn, workBtn, aboutBtn);

        if (SITE.instagram) {
            wrapper.append(createBtn(icons.instagram, () => {
                window.open(SITE.instagram, '_blank', 'noopener,noreferrer');
            }, 'Instagram'));
        }

        container.appendChild(wrapper);

        // The orb is part of the dock, sat directly under the bar: one
        // assembly, not two floating pieces. setUIVisibility collapses the
        // bar into it rather than hiding the dock, so the orb survives and
        // stays the handle that brings the rest back.
        const orb = document.createElement('button');
        orb.type = 'button';
        orb.id = 'home-orb';
        orb.innerHTML = icons.home;
        orb.setAttribute('aria-label', 'Home · also opens the controls');
        orb.addEventListener('pointerdown', (e) => {
            // Stops the tap also reaching the canvas, where it would be read
            // as a scene click and toggle the dock straight back shut.
            e.stopPropagation();
            e.preventDefault();
        });
        orb.addEventListener('pointerup', (e) => e.stopPropagation());
        orb.addEventListener('click', (e) => {
            e.stopPropagation();
            this.resetScene();
            // The orb is the way back from a dock the visitor put away, so it
            // lifts the dismissal before asking for the dock -- otherwise the
            // guard in resetUIHideTimer would swallow its own summons.
            this._uiDismissed = false;
            this.resetUIHideTimer();
        });
        container.appendChild(orb);
        document.body.appendChild(container);
        this.homeOrb = orb;

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

        const isMorning = Math.sin(this.sunAngle - Math.PI / 2) < 0;
        // Sun elevation warmth factor (1 at horizon/dawn/dusk, 0 high in sky)
        const sunWarmth = 1.0 - THREE.MathUtils.smoothstep(sky.sunAlt, -0.02, 0.36);

        // 3-way continuous hermite blend between Day, Twilight, and Night
        const dayWeight = THREE.MathUtils.smoothstep(sky.sunAlt, 0.00, 0.24);
        const nightWeight = 1.0 - THREE.MathUtils.smoothstep(sky.sunAlt, -0.26, 0.00);
        const twiWeight = Math.max(0.0, 1.0 - dayWeight - nightWeight);

        // Continuous 0 (evening) .. 1 (morning), so the haze eases between
        // the two over the day instead of switching at noon.
        const dawnDuskMix = THREE.MathUtils.clamp(-Math.sin(this.sunAngle - Math.PI / 2) * 1.5 + 0.5, 0.0, 1.0);
        const atm = this.skySystem.atmosphere;
        atm.update(this.renderer, sky.cel.sunPos, sky.sunAlt,
            THREE.MathUtils.lerp(MIE_EVENING, MIE_MORNING, dawnDuskMix), nightWeight);
        const A = atm.state;

        // The disc is the sunlight that survives the path through the air:
        // white high up, orange by ~5 deg, red at the horizon. The light
        // itself keeps a little white so a red sun still reads as light
        // falling on things rather than paint.
        // The disc must out-shine the glare around it, which the atmosphere
        // now renders in HDR -- at plain 0..1 colour it read as a dull beige
        // coin pasted on a bright sky. Scaled by how much direct sunlight
        // survives the air: the tone mapper rolls a high sun to white, while
        // near the horizon, where it is genuinely dimmed and reddened, it
        // keeps its orange.
        const discBoost = (6.0 + 40.0 * A.sunStrength) * Math.sqrt(A.adapt);
        this.sunMesh.material.color.copy(A.sunColor).multiplyScalar(discBoost);
        this.sunLight.color.copy(A.sunColor).lerp(C_WHITE, 0.15);

        this.sunMesh.position.copy(sky.cel.sunPos);
        // The disc texture is centred on the sphere's local +X (where
        // SphereGeometry puts u = 0.5); left unrotated, the texture's
        // transparent rim wrapped onto the visible face as a dark seam down
        // the middle of the sun. Face +X at the viewer.
        this.sunMesh.lookAt(0, 0, 0);
        this.sunMesh.rotateY(-Math.PI / 2);
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

        // Smoothly fade celestial discs across the horizon
        const sunFade = THREE.MathUtils.smoothstep(sky.cel.sunAlt, -0.035, 0.035);
        this.sunMesh.material.opacity = sunFade;
        this.sunMesh.visible = sunFade > 0.001;
        if (this.sunGlow) {
            this.sunGlow.material.color.copy(A.sunColor);
            this.sunGlow.material.opacity = sunFade * (0.30 + 0.30 * (1.0 - sunWarmth));
            this.sunGlow.visible = sunFade > 0.005;
        }
        const moonFade = THREE.MathUtils.smoothstep(sky.cel.moonAlt, -0.035, 0.035);
        this.moonMesh.material.opacity = moonFade;
        this.moonMesh.visible = moonFade > 0.001;

        // Continuous smooth transition between day and night key lights
        const sunFactor = THREE.MathUtils.smoothstep(sky.sunAlt, -0.04, 0.06);
        const moonAltFactor = THREE.MathUtils.smoothstep(sky.cel.moonAlt, -0.04, 0.10);
        const moonDarkness = 1.0 - THREE.MathUtils.smoothstep(sky.sunAlt, -0.22, 0.00);
        const moonFactor = moonAltFactor * moonDarkness;

        // Shadow STRENGTH ramps with the light instead of snapping on at a threshold
        const sunShadow = THREE.MathUtils.smoothstep(sky.sunAlt, -0.02, 0.28);
        const moonShadow = THREE.MathUtils.smoothstep(sky.cel.moonAlt, 0.02, 0.30) * moonDarkness;

        // Sunset/sunrise directional light boost for dramatic low-angle golden/crimson hour raking rays
        const sunsetBoost = THREE.MathUtils.smoothstep(sky.sunAlt, 0.28, 0.04) * (1.0 - THREE.MathUtils.smoothstep(sky.sunAlt, -0.04, 0.02));
        const fullSunIntensity = 3.6 + Math.sin(Math.max(0.0, sky.sunAlt)) * 1.8 + sunsetBoost * 2.2;
        this.sunLight.intensity = sunFactor * fullSunIntensity;
        // Soften direct shadows so ambient and bounce light fill in dark areas without harsh black cutoffs
        this.sunLight.shadow.intensity = sunShadow * 0.62;
        this.sunLight.castShadow = sunShadow > 0.005;

        const fullMoonIntensity = Math.max(2.2, sky.mH * 3.0);
        this.moonLight.intensity = moonFactor * fullMoonIntensity;
        // Moonlight shadows stay softer than the sun's even at full moon
        this.moonLight.shadow.intensity = moonShadow * 0.45;
        this.moonLight.castShadow = moonShadow > 0.01 && this.sunLight.intensity < 0.20;

        // Re-render the shadow maps on a cadence while the sun moves: every
        // frame on the top tier, every other frame (~33 Hz) on medium, ~22 Hz
        // on low (QUALITY.shadowIntervalMs). It used to be 16 / 11 / 7 Hz,
        // and at the ambient day speed that read as visibly stepped shadows --
        // worst on phones. What made every-frame affordable was cutting the
        // pass itself: the gulmohar's stalks no longer cast (35% of the pass),
        // so a refresh is ~350k triangles, not ~540k. A light that has just
        // started/stopped casting still forces an immediate refresh --
        // otherwise it would render with no map at all until the next tick.
        const castingKey = (this.sunLight.castShadow ? 1 : 0) | (this.moonLight.castShadow ? 2 : 0);
        const shadowDue = (nowMs - (this._lastShadowMs ?? 0)) > QUALITY.shadowIntervalMs;
        // The time gate alone re-rendered ~691k triangles twelve times a second
        // even with the sun completely still -- which is the common case, since
        // pausing motion or tapping Noon/Midnight sets daySpeed to 0. Requiring
        // the sun to have actually moved makes a static scene cost nothing at
        // all, while the time gate still paces a MOVING sun smoothly (an
        // angle-only gate, as duar.one uses, fired ~3Hz at this day speed and
        // read as jitter). Anything else needing a refresh -- a late landmark,
        // the editor placing a painting -- sets needsUpdate directly, and Three
        // clears the flag itself after rendering.
        const sunMoved = Math.abs(this.sunAngle - (this._lastShadowAngle ?? 1e9)) > 1e-5;
        // A painting that has swung to follow the viewer is the other thing
        // that can invalidate the map while the sun sits still.
        const shadowFrame = (shadowDue && (sunMoved || this._paintingsTurned))
            || castingKey !== this._lastCastingKey;
        if (shadowFrame) {
            this._lastShadowMs = nowMs;
            this._lastShadowAngle = this.sunAngle;
            this._lastCastingKey = castingKey;
            this._paintingsTurned = false;
            commitPaintingShadows(this.paintings);
            this.renderer.shadowMap.needsUpdate = true;
        }

        // Adaptive quality. Frames that re-render the shadow map are excluded:
        // the cadence makes roughly one frame in five systematically expensive,
        // and including them drags the median onto the shadow frame and
        // misreports the steady-state cost permanently.
        const change = sampleFrame(dt * 1000, shadowFrame);
        if (change) this._applyQualityChange(change);

        const moonWarmth = 1.0 - THREE.MathUtils.smoothstep(sky.cel.moonAlt, -0.02, 0.38);
        this.moonMesh.material.color.lerpColors(C_MOON_HIGH, C_MOON_LOW, moonWarmth);
        this.moonMesh.material.emissive.copy(this.moonMesh.material.color);
        this.moonLight.color.lerpColors(C_MOONLIGHT_HIGH, C_MOONLIGHT_LOW, moonWarmth);

        const u = this.skySystem.skyDomeMat.uniforms;
        u.uSunColor.value.copy(A.sunColor);
        // Only reaches a few percent within the garden's 50m, but it is what
        // distant geometry reads against, so it tracks the real horizon.
        this.scene.fog.color.copy(C_NIGHT_HORIZON).multiplyScalar(nightWeight).add(A.horizon);

        // Sky fill takes its HUE from the sky that is actually overhead --
        // blue at noon, lavender-blue through twilight, never the crimson the
        // old palette used. That is what gives low sun its warm-light,
        // cool-shadow look. Brightness keeps the tuned per-phase levels.
        const twiHemiGnd = isMorning ? C_HEMI_GROUND_DAWN : C_HEMI_GROUND_DUSK;
        const litWeight = dayWeight + twiWeight;
        if (litWeight > 1e-4) {
            // Twilight gets more than the old crimson's luminance: blue-lavender
            // light on a green lawn multiplies out far darker than red light
            // on the rust-tinted lawn did, and read as a black ground.
            const targetLum = (dayWeight * luma(C_HEMI_DAY) + twiWeight * TWILIGHT_FILL_LUM) / litWeight;
            _skyFillScratch.copy(A.midSky).lerp(A.zenith, 0.35);
            const l = luma(_skyFillScratch);
            if (l > 1e-6) _skyFillScratch.multiplyScalar(targetLum / l);
            else _skyFillScratch.copy(C_HEMI_NIGHT);
        } else {
            _skyFillScratch.copy(C_HEMI_NIGHT);
        }
        _hemiSkyScratch.copy(_skyFillScratch).lerp(C_HEMI_NIGHT, nightWeight);
        blend3Colors(_hemiGndScratch, C_HEMI_GROUND_DAY, dayWeight, twiHemiGnd, twiWeight, C_HEMI_GROUND_NIGHT, nightWeight);

        // Night keeps starlight fill; day keeps its neutral warmth; twilight
        // takes the sky's own colour.
        _ambientColScratch.lerpColors(C_HEMI_NIGHT, _skyFillScratch, twiWeight);
        if (dayWeight > 0.01) _ambientColScratch.lerp(C_AMBIENT_DAY, dayWeight);
        this.ambientLight.color.copy(_ambientColScratch);
        this.ambientLight.intensity = 0.12 * nightWeight + 0.22 * twiWeight + 0.16 * dayWeight;

        this.hemiLight.color.copy(_hemiSkyScratch);
        this.hemiLight.groundColor.copy(_hemiGndScratch);
        this.hemiLight.intensity = 0.42 * nightWeight + 0.65 * twiWeight + 0.58 * dayWeight;

        blend3Colors(this.groundMat.color, C_FLOOR_NOON, dayWeight, C_FLOOR_TWILIGHT, twiWeight, C_FLOOR_MIDNIGHT, nightWeight);

        // The pond's reflection was written to take the sky's colours but was
        // never handed them, so it reflected a noon sky all night.
        const lc = this._lightCtx || (this._lightCtx = {
            skyReflect: new THREE.Color(), horizonReflect: new THREE.Color(),
            sunDir: new THREE.Vector3(), sunColor: new THREE.Color(), moonDir: new THREE.Vector3(),
            moonColor: new THREE.Color()
        });
        lc.skyReflect.copy(C_NIGHT_ZENITH).multiplyScalar(nightWeight).add(A.midSky);
        lc.horizonReflect.copy(C_NIGHT_HORIZON).multiplyScalar(nightWeight).add(A.horizon);
        lc.sunDir.copy(sky.cel.sunPos);
        lc.sunColor.copy(this.sunLight.color);
        lc.sunIntensity = this.sunLight.intensity;
        lc.moonDir.copy(_moonDirScratch);
        lc.moonColor.copy(this.moonLight.color);
        lc.moonIntensity = this.moonLight.intensity;
        lc.dayWeight = dayWeight;
        lc.twiWeight = twiWeight;
        lc.nightWeight = nightWeight;
        lc.isMorning = isMorning;

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
            if (this.garden && this.garden.update) this.garden.update(this.elapsed, dt, this._lightCtx);
            if (this.dust) this.dust.rotation.y += 0.0002;
        }

        // Damping can overshoot a limit for a frame, so clamp height as a backstop.
        if (this.camera.position.y < 0.2) this.camera.position.y = 0.2;

        if (this.navMode === 'walk') {
            this.fpsNavigator.update(dt);
        } else {
            this.controls.update();
        }
        // After the camera has moved for this frame, so tile culling and the
        // blades' distance thinning use the view actually being rendered.
        if (this.lawn) {
            this.camera.updateMatrixWorld();
            this.lawn.update(this.camera);
            // Unconditional, unlike update() above: that call skips its own
            // work once the camera stops moving, but the clear patch still
            // has to keep easing in while you stand still studying the
            // painting it is opening space around.
            this.lawn.tickClearZone(this._groundClearTarget, dt);
        }
        // Also after the camera has moved, for the same reason. The shadow
        // gate runs earlier in the frame, so the flag is read on the next one
        // -- a frame's latency on a shadow refresh nobody can see.
        this._updatePaintingFocus();
        if (this.paintings && updatePaintingBillboards(this.paintings, this.camera, dt)) {
            this._paintingsTurned = true;
        }
        if (this.dofPass) {
            // While a painting is being looked at, focus is pinned to the
            // painting itself rather than to the cursor. Orbiting is done by
            // dragging, and a drag is mostly spent with the cursor out over
            // empty grass or sky -- which is exactly what "focus follows the
            // pointer" would then focus on, throwing the very thing you are
            // studying out of focus every time you turned around it.
            let uv = null;
            if (this._paintingFocus && this.paintings) {
                const m = this.paintings.get(this._paintingFocus.id);
                if (m) {
                    const v = m.group.position.clone().project(this.camera);
                    if (v.z < 1) uv = [v.x * 0.5 + 0.5, v.y * 0.5 + 0.5];
                }
            }
            // Otherwise the cursor. this.pointer is NDC (-1..1) and starts at
            // the (-2,-2) sentinel before any pointer event has arrived; touch
            // only ever updates it on contact (see onPointerMove's own
            // comment), so between touches it holds the last tap rather than
            // tracking a hover that does not exist. Either way, off-screen
            // reads as "no pointer" here and falls back to the screen centre.
            if (!uv) {
                const px = this.pointer.x, py = this.pointer.y;
                uv = (px >= -1 && px <= 1 && py >= -1 && py <= 1)
                    ? [px * 0.5 + 0.5, py * 0.5 + 0.5]
                    : [0.5, 0.5];
            }
            this.dofPass.pointerUV.set(uv[0], uv[1]);
        }
        // One path for every device. Mobile used to bypass the composer, which
        // meant it applied tone mapping and the sRGB encode differently from
        // desktop -- so every colour tuned on a desktop was a colour phones
        // never showed. With bloom gone the composer is a render plus one
        // full-screen blit, which is affordable everywhere.
        this.composer.render();
    }
}

new GulmoharApp();
