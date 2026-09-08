import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import gsap from 'gsap';

import { createTorontoSkySystem } from './src/sky/celestial.js';
import { QUALITY, resolveQuality, sampleFrame, resetAdaptive } from './src/quality.js';
import { windUniforms } from './src/scene/wind.js';
import { loadGarden, GARDEN_POINTS, groundHeightAt } from './src/scene/garden.js';
import { createGrassField } from './src/scene/grass.js';
import { loadPlacements, mountAllPaintings } from './src/scene/paintings.js';
import { SITE } from './src/content.js';
import { getAssetUrl } from './src/utils/paths.js';

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

const C_DAY_ZENITH = new THREE.Color(0xdfe9ea);        // near-white, barest sky tint -- afternoon reads white
const C_DAY_HORIZON = new THREE.Color(0xf6f4ec);       // white with a whisper of warmth at the rim
const C_DAY_HORIZON_OPP = new THREE.Color(0xeceae2);
const C_DAWN_ZENITH = new THREE.Color(0xb9c6d6);       // sky still cool overhead
const C_DAWN_HORIZON = new THREE.Color(0xffcf6b);      // golden yellow
const C_DAWN_HORIZON_OPP = new THREE.Color(0xc7cdd6);
const C_DUSK_ZENITH = new THREE.Color(0xaa9fb0);       // cooling toward night overhead
const C_DUSK_HORIZON = new THREE.Color(0xf5b942);      // deeper gold than dawn -- late-day warmth
const C_DUSK_HORIZON_OPP = new THREE.Color(0xb2a8bd);
const C_NIGHT_ZENITH = new THREE.Color(0x2f384d);      // deep indigo, never black
const C_NIGHT_HORIZON = new THREE.Color(0x424d5f);

const C_SUN_HIGH = new THREE.Color(0xfffef8);          // near-white at height
const C_SUN_LOW = new THREE.Color(0xffc966);           // golden yellow low in the sky
const C_SUNLIGHT_HIGH = new THREE.Color(0xfffaf0);     // white afternoon light
const C_SUNLIGHT_LOW = new THREE.Color(0xffc35c);      // dusk: rich golden yellow
const C_SUNLIGHT_DAWN = new THREE.Color(0xffd98f);     // dawn: lighter golden yellow
const C_MOON_HIGH = new THREE.Color(0xe6edf5);
const C_MOON_LOW = new THREE.Color(0xc2d2e2);
const C_MOON_EMISSIVE = new THREE.Color(0xe0e8f2);
const C_MOONLIGHT_HIGH = new THREE.Color(0xd8e4f2);
const C_MOONLIGHT_LOW = new THREE.Color(0xc6d6e8);

const C_HEMI_NIGHT = new THREE.Color(0x54648a);
const C_HEMI_DAWN = new THREE.Color(0xf5cf8f);
const C_HEMI_DAY = new THREE.Color(0xfefcf5);
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
        this._pickGroups = [];
        this._hoverOwner = new Map();
        this.hovered = null;
        this._hoverDirty = false;
        this._introStarted = false;
        this._contentReady = false;
        this._revealed = false;

        // A dynamic import, so a visitor who never adds ?edit never
        // downloads the editor chunk -- verify this with
        // `grep -c TransformControls dist/assets/main.js` after a build,
        // which must stay 0.
        this.editMode = new URLSearchParams(location.search).has('edit');
        if (this.editMode) {
            document.title = 'Gulmohar — edit';
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
        this.renderer.toneMappingExposure = 1.08;
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

        this.scene.fog = new THREE.FogExp2(0xcbdcdd, 0.0032);   // was 0.005 -- crept in well before the ground's own edge fade, thickening the corners early

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
        // A backgrounded tab produces garbage frame times; throw the window
        // away on return rather than adapting down off throttled frames.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) resetAdaptive();
        });
        window.addEventListener('pointermove', (e) => this.onPointerMove(e), { passive: true });

        // Home is now only ever explicit, since a missed click no longer does
        // it. Escape is the keyboard route; the dock's Home button is the
        // pointer one.
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { this.resetScene(); this.resetUIHideTimer(); }
        });

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
        // Compact shadow frustum tightly framing the garden for high performance and crisp shadows
        const d = 34;

        this.sunDist = 1600;
        this.sunLight = new THREE.DirectionalLight(0xfff2c8, 3.8);
        this.moonLight = new THREE.DirectionalLight(0xc8d8e8, 2.0);
        [this.sunLight, this.moonLight].forEach((light) => {
            light.castShadow = true;
            light.shadow.mapSize.set(shadowRes, shadowRes);
            // near 10 rather than 5: the lights sit 1600 units out, nothing is
            // within 10 units of them, and pulling the near plane in wastes
            // depth precision across the whole range that IS occupied.
            light.shadow.camera.near = 10.0;
            light.shadow.camera.far = 600;
            Object.assign(light.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
            light.shadow.camera.updateProjectionMatrix();
            light.shadow.bias = -0.0001;
            light.shadow.normalBias = 0.018;   // finer texels need less bias (duar.one)
            // Now actually has an effect -- radius is honoured by PCFShadowMap
            // but silently ignored by PCFSoftShadowMap, which this used to be.
            light.shadow.radius = QUALITY.shadowRadius;
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
        // Ground: garden disc with a soft organic edge fade. The maple/pond/
        // gazebo corners sit at r=28-31 and the maple's canopy reaches ~37, so
        // the fade band (below) has to start beyond that -- at the old r=31 it
        // began at the maple's own trunk and dissolved it into fog. 60m was an
        // overcorrection: a bare tan ring past the grass, and a lot of
        // transparent fill for nothing.
        // A tessellated plane rather than a CircleGeometry fan, because the
        // ground now has relief: CircleGeometry has a centre vertex and a rim
        // ring and nothing in between, so there is simply nowhere to put a
        // berm. The disc shape still comes from the radial alpha fade in the
        // shader below, which discards everything past the edge, so the square
        // corners never draw. ~20k triangles for 1m of displacement
        // resolution, against a ~1M scene -- immaterial.
        const groundGeo = new THREE.PlaneGeometry(100, 100, 100, 100);
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
            depthWrite: true,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
        this.groundMat.onBeforeCompile = (shader) => {
            shader.vertexShader = 'varying vec3 vGroundWorldPos;\n' + shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                '#include <worldpos_vertex>\n vGroundWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
            );
            shader.fragmentShader = 'varying vec3 vGroundWorldPos;\n' + shader.fragmentShader.replace(
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
                 vec3 greened = groundLum * vec3(0.60, 1.08, 0.45);
                 // NB: not "patch" -- that is a reserved word in GLSL ES 3.0
                 // (tessellation), and naming it that failed the whole ground
                 // shader to compile, which silently dropped the entire ground
                 // plane and left the sky dome showing below the horizon.
                 float turfPatch = sin(vGroundWorldPos.x * 0.055 + 0.6) * sin(vGroundWorldPos.z * 0.047 - 1.2)
                                 + sin(vGroundWorldPos.x * 0.021 - 1.7) * sin(vGroundWorldPos.z * 0.019 + 2.2) * 0.5;
                 gl_FragColor.rgb = mix(gl_FragColor.rgb, greened, clamp(0.62 + turfPatch * 0.22, 0.30, 0.88));

                 // Below the waterline the ground is a pond bed, not lawn --
                 // without this you see bright grass straight through the
                 // water. Keyed off world height so it follows the basin
                 // exactly and needs no second copy of its radius.
                 float wet = smoothstep(-0.15, -1.05, vGroundWorldPos.y);
                 gl_FragColor.rgb = mix(gl_FragColor.rgb,
                                        gl_FragColor.rgb * vec3(0.34, 0.40, 0.32), wet);

                 float r = length(vGroundWorldPos.xz);
                 // Two-stage horizon: mix toward the fog first, then fade alpha so
                 // the real sky shows through. A colour mix alone cannot match a
                 // horizon that is warm toward the sun and cool away from it.
                 #ifdef USE_FOG
                 gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(38.0, 47.0, r));
                 #endif
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
        this.scene.add(ground);
        this.groundMesh = ground;   // referenced by the editor for ground-mount raycasts

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

            // One InstancedMesh, one draw call, castShadow false -- 8,000
            // clumps in the shadow pass would more than double its cost for
            // shadows nobody could resolve at 15cm anyway. Thinned on mobile
            // rather than removed, so the world doesn't visibly change shape
            // by device -- just how dense the lawn reads.
            // Denser and wider: 39m left a bare ring between the grass and the
            // ground's own edge fade (which starts at 41), and the field was
            // thin enough that the tan bake showed through as the dominant
            // colour. Still one draw call, still no shadow casting.
            // Real instanced grass cards (6 tris each) rather than procedural
            // blades (12) -- cheaper AND better looking. Allocated at the
            // tier's count; the adaptive loop lowers each InstancedMesh's
            // `count` at runtime, which Three treats as a draw range, so it
            // costs no reallocation and no matrix re-upload.
            this.grass = createGrassField(garden.grassCards, QUALITY.grassRadius, QUALITY.grassCount);
            this.scene.add(this.grass);

            // A second, much sparser layer of larger vegetation clumps from
            // grass_vegitation_mix.glb. These are ~380 triangles each rather
            // than 6, so they are scattered in the low hundreds purely to
            // break up the uniformity of the grass -- the mix's other meshes
            // (2.7k and 4.1k tris) were left behind as far too heavy to
            // instance at any useful density.
            this.vegClumps = createGrassField(
                garden.vegClumps, QUALITY.grassRadius, QUALITY.vegClumpCount,
                { targetHeight: 0.62, name: 'VegetationClumps', clearMargin: 0.4 }
            );
            this.scene.add(this.vegClumps);

            // The mix's heavy clumps -- 2.7k and 4.1k triangles each, versus 6
            // for a grass card. Far too expensive to scatter at any density,
            // but a few dozen read as thick established planting and give the
            // lawn somewhere to build up to. Kept off the path with a wider
            // clear margin so they never swallow it.
            this.denseGrass = createGrassField(
                garden.denseGrass, QUALITY.grassRadius * 0.82, QUALITY.denseGrassCount,
                { targetHeight: 1.15, name: 'DenseGrass', clearMargin: 1.2 }
            );
            this.scene.add(this.denseGrass);

            // Paintings: a 404 on paintings.json resolves to an empty list
            // rather than rejecting, so a garden with nothing hung yet is not
            // an error state. Mounted onto named anchors within garden.group
            // (see resolveAnchor in paintings.js), so they move correctly if
            // a landmark is ever repositioned.
            loadPlacements().then((data) => {
                this.paintings = mountAllPaintings(garden.group, data.paintings, (object, hoverData) => {
                    this._registerHover(object, hoverData);
                });

                this._contentReady = true;
                this.renderer.shadowMap.needsUpdate = true;
                this._maybeStartIntro();

                if (this.editMode) {
                    import('./src/edit/editor.js').then(({ attachEditor }) => attachEditor(this));
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
            // A click that hits nothing used to fly the camera home. With
            // hitboxes this coarse that fired constantly -- most "misses" were
            // aimed at something -- and being yanked back to the gulmohar is a
            // far worse outcome than a click doing nothing. Going home is now
            // only ever explicit: the dock's Home button, or Escape.
            this.setUIVisibility(true);
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

        this.renderer.shadowMap.needsUpdate = true;
        if (import.meta.env && import.meta.env.DEV) {
            console.info(`[quality] adapt ${direction}: pixelRatio=${target.toFixed(2)} instanceScale=${instanceScale}`);
        }
    }

    resetScene() {
        gsap.to(this.camera.position, { x: 12.8, y: 3.2, z: 11.2, duration: 1.8, ease: 'power2.inOut' });
        gsap.to(this.controls.target, { x: 0, y: 2.8, z: 0, duration: 1.8, ease: 'power2.inOut' });
        this.setUIVisibility(true);
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
        }, () => {
            this.sunAngle = (this.sunAngle + Math.PI / 12) % (Math.PI * 2);
            this.daySpeed = 0;
            this._pullBackForLightChange();
        });

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

        // Shadow STRENGTH ramps with the light instead of snapping on at a
        // threshold. `castShadow` is a hard boolean, so toggling it at
        // sunFactor 0.06 made a full-strength shadow appear out of nothing at
        // dawn and vanish at dusk. `shadow.intensity` is a plain uniform --
        // it costs no shadow-map re-render and updates every frame, not on
        // the 12Hz cadence -- so it can fade continuously. castShadow still
        // gates the (expensive) map render, but now only flips once the
        // intensity has already reached zero, making the switch invisible.
        // Ramped against ALTITUDE, not against sunFactor. sunFactor is itself
        // a smoothstep over sunAlt -0.05..0.16 -- barely 12 degrees -- so
        // smoothstepping it again saturated to 1 while the sun was still very
        // low, and the shadow still slammed on. Driving from the raw altitude
        // over a deliberately WIDER band than the light uses means the shadow
        // starts weakening well before sunset and is already near zero by the
        // time the sun/moon caster handover happens, which is what makes the
        // switch invisible rather than merely quick.
        const sunShadow = THREE.MathUtils.smoothstep(sky.sunAlt, -0.02, 0.38);
        const moonShadow = THREE.MathUtils.smoothstep(sky.cel.moonAlt, -0.02, 0.34) * moonFactor;

        const fullSunIntensity = 3.6 + Math.sin(Math.max(0.0, sky.sunAlt)) * 1.8;
        this.sunLight.intensity = sunFactor * fullSunIntensity;
        this.sunLight.shadow.intensity = sunShadow;
        this.sunLight.castShadow = sunShadow > 0.002 && sunFactor >= moonFactor;

        const fullMoonIntensity = Math.max(2.4, sky.mH * 3.0);
        this.moonLight.intensity = moonFactor * fullMoonIntensity;
        // Moonlight shadows stay softer than the sun's even at full moon.
        this.moonLight.shadow.intensity = moonShadow * 0.72;
        this.moonLight.castShadow = moonShadow > 0.002 && moonFactor > sunFactor;

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
        const shadowFrame = (shadowDue && sunMoved) || castingKey !== this._lastCastingKey;
        if (shadowFrame) {
            this._lastShadowMs = nowMs;
            this._lastShadowAngle = this.sunAngle;
            this._lastCastingKey = castingKey;
            this.renderer.shadowMap.needsUpdate = true;
        }

        // Adaptive quality. Frames that re-render the shadow map are excluded:
        // the cadence makes roughly one frame in five systematically expensive,
        // and including them drags the median onto the shadow frame and
        // misreports the steady-state cost permanently.
        const change = sampleFrame(dt * 1000, shadowFrame);
        if (change) this._applyQualityChange(change);

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
