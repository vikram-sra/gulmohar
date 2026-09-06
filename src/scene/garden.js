import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { getAssetUrl } from '../utils/paths.js';

// Garden layout coordinates:
// - Center: Gulmohar Tree (0, 0, 0)
// - Top-Left: Pond with Waterfalls (-23, 0, -19)
// - Bottom-Right: Gazebo (+22, 0, +18)
// - Top-Right: Maple Tree (+23, 0, -21)
export const GARDEN_POINTS = {
    GULMOHAR: new THREE.Vector3(0, 0, 0),
    POND: new THREE.Vector3(-23.0, 0, -19.0),
    GAZEBO: new THREE.Vector3(22.0, 0, 18.0),
    MAPLE: new THREE.Vector3(23.0, 0, -21.0)
};

/**
 * Loads all 3D assets for the garden and constructs the pathways, central bed,
 * landmarks, and interactive targets.
 */
export function loadGarden(loadingManager) {
    const loader = new GLTFLoader(loadingManager);
    // Every garden asset is meshopt-compressed at rest (see README) -- without
    // the decoder, GLTFLoader fails silently on those files and each landmark
    // falls back to its procedural stand-in.
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gardenGroup = new THREE.Group();
    gardenGroup.name = 'Garden';

    const interactives = [];
    const updateables = [];

    const loadGLTF = (path) => new Promise((resolve) => {
        loader.load(
            getAssetUrl(path),
            (gltf) => resolve(gltf),
            undefined,
            (err) => {
                console.warn(`Failed to load GLTF ${path}:`, err);
                resolve(null);
            }
        );
    });

    return Promise.all([
        loadGLTF('models/gulmohar.glb'),
        loadGLTF('models/gazebo.glb'),
        loadGLTF('models/pond.glb'),
        loadGLTF('models/maple.glb'),
        loadGLTF('models/floor_leaves.glb')
    ]).then(([gulmoharGltf, gazeboGltf, pondGltf, mapleGltf, leavesGltf]) => {
        // 1. Gulmohar Centerpiece Tree (At 0,0,0)
        const gulmoharObj = setupGulmohar(gulmoharGltf);
        gardenGroup.add(gulmoharObj.model);
        interactives.push(gulmoharObj.interactive);

        // 2. Gazebo (Bottom-Right corner)
        const gazeboObj = setupGazebo(gazeboGltf);
        gardenGroup.add(gazeboObj.model);
        interactives.push(gazeboObj.interactive);

        // 3. Pond with Waterfalls (Top-Left corner)
        const pondObj = setupPond(pondGltf);
        gardenGroup.add(pondObj.model);
        interactives.push(pondObj.interactive);
        if (pondObj.update) updateables.push(pondObj.update);

        // 4. Maple Tree (Top-Right corner)
        const mapleObj = setupMaple(mapleGltf);
        gardenGroup.add(mapleObj.model);
        interactives.push(mapleObj.interactive);

        // 5. Floor Detailing with floor_leaves.glb everywhere
        const floorResult = setupFloorEverywhere(leavesGltf);
        gardenGroup.add(floorResult.group);

        // 6. Curving Garden Path (centered at origin)
        const pathway = createGardenPathway();
        gardenGroup.add(pathway);

        return {
            group: gardenGroup,
            interactives,
            groundTexture: floorResult.groundTexture,
            groundNormal: floorResult.groundNormal,
            update: (time, delta) => {
                for (let i = 0; i < updateables.length; i++) {
                    updateables[i](time, delta);
                }
            }
        };
    });
}

/**
 * Configure materials for realistic foliage with proper shadow maps and alpha cutoffs.
 */
function enhanceFoliageMaterial(mat, child, alphaCut = 0.32) {
    mat.side = THREE.DoubleSide;
    mat.shadowSide = THREE.FrontSide;
    if (mat.roughness !== undefined) mat.roughness = Math.max(mat.roughness, 0.65);

    child.castShadow = true;
    child.receiveShadow = true;

    const isFoliage = mat.alphaTest > 0 || mat.transparent ||
        (mat.name && /leaf|leaves|foliage|flower|petal|branch|twig|stalk|bud|00[1-4]|mat/i.test(mat.name)) ||
        (child.name && /leaf|leaves|flower|petal|branch|twig/i.test(child.name));

    if (isFoliage && mat.map) {
        mat.alphaTest = alphaCut;
        mat.transparent = false;
        mat.depthWrite = true;
        mat.needsUpdate = true;
        child.customDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            map: mat.map,
            alphaTest: alphaCut,
            side: THREE.FrontSide
        });
    }
}

// ---------------------------------------------------------------------------
// 1. Gulmohar Setup (Center of garden)
// ---------------------------------------------------------------------------
function setupGulmohar(gltf) {
    const targetHeight = 11.2;
    const group = new THREE.Group();
    group.name = 'GulmoharTree';

    let model;
    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scaleFactor = targetHeight / Math.max(size.y, 0.001);

        // Center trunk contact point on origin y = 0
        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -box.min.y * scaleFactor - 0.1, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            child.castShadow = true;
            child.receiveShadow = true;
            enhanceFoliageMaterial(child.material, child, 0.32);
        });
    } else {
        model = createFallbackTree(0xcc3720, 11.2);
    }

    group.position.copy(GARDEN_POINTS.GULMOHAR);
    group.rotation.y = 0.45;
    group.add(model);

    // Hitbox for hover/click (in local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(5.0, 5.0, 12.0, 12, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 5.5, 0);
    group.add(hitbox);

    const interactiveData = {
        id: 'gulmohar',
        title: 'Royal Poinciana (Gulmohar)',
        meta: 'Delonix Regia · Centerpiece of the Garden',
        cameraTarget: { pos: new THREE.Vector3(12.8, 3.2, 11.2), lookAt: new THREE.Vector3(0, 2.8, 0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        }
    };
}

// ---------------------------------------------------------------------------
// 2. Gazebo Setup (Bottom-Right)
// ---------------------------------------------------------------------------
function setupGazebo(gltf) {
    const targetHeight = 4.8;
    const group = new THREE.Group();
    group.name = 'Gazebo';

    let model;
    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scaleFactor = targetHeight / Math.max(size.y, 0.001);

        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -box.min.y * scaleFactor - 0.08, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            child.castShadow = true;
            child.receiveShadow = true;
            child.material.side = THREE.DoubleSide;
            if (child.material.roughness !== undefined) child.material.roughness = 0.72;
        });
    } else {
        model = createFallbackGazebo();
    }

    group.position.copy(GARDEN_POINTS.GAZEBO);
    // Face entrance steps directly toward the center Gulmohar tree
    group.rotation.y = 0.50;
    group.add(model);

    // Hitbox for hover/click (local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(4.2, 4.2, 5.5, 12, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 2.6, 0);
    group.add(hitbox);

    const interactiveData = {
        id: 'gazebo',
        title: 'Garden Pavilion',
        meta: 'Tranquil Gazebo · Click to visit',
        cameraTarget: { pos: new THREE.Vector3(14.5, 4.5, 12.0), lookAt: new THREE.Vector3(22.0, 2.2, 18.0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        }
    };
}

// ---------------------------------------------------------------------------
// 3. Pond with Waterfalls Setup (Top-Left)
// ---------------------------------------------------------------------------
function setupPond(gltf) {
    const group = new THREE.Group();
    group.name = 'PondWithWaterfalls';

    let model;
    let waterMeshList = [];
    let surfaceWaterMat = null;
    let waterTex = null;

    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        const targetWidth = 22.0;
        const scaleFactor = targetWidth / Math.max(size.x, 0.001);

        model.scale.setScalar(scaleFactor);
        // Sink the pond basin so water level rests naturally below the garden ground (y = -0.38)
        model.position.set(-center.x * scaleFactor, -0.38, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;

            const mat = child.material;
            const matName = (mat.name || '').toLowerCase();
            const childName = (child.name || '').toLowerCase();

            if (childName.includes('plane.002') || childName.includes('plane_002')) {
                // Outer terrain of the asset: feather radially so it seamlessly merges under the lawn
                const terrainMat = new THREE.MeshStandardMaterial({
                    map: mat.map || null,
                    roughness: 0.95,
                    metalness: 0.02,
                    transparent: true,
                    depthWrite: false,
                    polygonOffset: true,
                    polygonOffsetFactor: -1,
                    polygonOffsetUnits: -1
                });
                terrainMat.onBeforeCompile = (shader) => {
                    shader.vertexShader = 'varying vec3 vPondLocalPos;\n' + shader.vertexShader.replace(
                        '#include <worldpos_vertex>',
                        '#include <worldpos_vertex>\n vPondLocalPos = transformed;'
                    );
                    shader.fragmentShader = 'varying vec3 vPondLocalPos;\n' + shader.fragmentShader.replace(
                        '#include <dithering_fragment>',
                        `#include <dithering_fragment>
                         float d = length(vPondLocalPos.xy);
                         float fade = 1.0 - smoothstep(5.4, 7.5, d);
                         gl_FragColor.a *= fade;
                         if (gl_FragColor.a <= 0.02) discard;`
                    );
                };
                child.material = terrainMat;
                child.receiveShadow = true;
            } else if (matName.includes('water') || childName.includes('water')) {
                const newWaterMat = new THREE.MeshStandardMaterial({
                    color: 0x167280,
                    emissive: 0x09363e,
                    emissiveIntensity: 0.40,
                    roughness: 0.05,
                    metalness: 0.18,
                    transparent: true,
                    opacity: 0.90,
                    depthWrite: true,
                    side: THREE.DoubleSide
                });
                child.material = newWaterMat;
                child.receiveShadow = true;
                waterMeshList.push(child);
            } else if (matName.includes('riple') || childName.includes('riple')) {
                const newRippleMat = new THREE.MeshStandardMaterial({
                    map: mat.map || null,
                    color: 0x88e2ec,
                    emissive: 0x3d8c97,
                    emissiveIntensity: 0.50,
                    roughness: 0.08,
                    transparent: true,
                    opacity: 0.85,
                    depthWrite: false,
                    side: THREE.DoubleSide
                });
                child.material = newRippleMat;
                waterMeshList.push(child);
            } else {
                child.castShadow = !childName.includes('plane');
                child.receiveShadow = true;
                if (mat.map && (mat.transparent || matName.includes('leaf') || matName.includes('plant'))) {
                    mat.alphaTest = 0.35;
                    mat.transparent = false;
                    mat.depthWrite = true;
                    mat.side = THREE.DoubleSide;
                }
            }
        });
    } else {
        model = createFallbackPond();
    }

    group.position.copy(GARDEN_POINTS.POND);
    group.rotation.y = Math.PI * 0.35;
    group.add(model);

    // Hitbox for hover/click (local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(13.0, 13.0, 5.0, 16, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 2.5, 0);
    group.add(hitbox);

    const update = (time) => {
        for (let i = 0; i < waterMeshList.length; i++) {
            const m = waterMeshList[i];
            if (m.material && m.material.opacity !== undefined) {
                const s = 0.88 + Math.sin(time * 2.2 + i) * 0.04;
                m.material.opacity = THREE.MathUtils.clamp(s, 0.82, 0.95);
            }
        }
    };

    const interactiveData = {
        id: 'pond',
        title: 'Lotus Pond & Waterfall',
        meta: 'Cascading Water Falls · Click to visit',
        cameraTarget: { pos: new THREE.Vector3(-11.0, 6.8, -8.0), lookAt: new THREE.Vector3(-23.0, 1.8, -19.0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        },
        update
    };
}

// ---------------------------------------------------------------------------
// 4. Maple Tree Setup (Top-Right, Firmly Rooted on Ground)
// ---------------------------------------------------------------------------
function setupMaple(gltf) {
    // Mature Maple tree (~14m tall, firmly rooted into soil)
    const targetHeight = 13.8;
    const group = new THREE.Group();
    group.name = 'MapleTree';

    let model;
    if (gltf && gltf.scene) {
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scaleFactor = targetHeight / Math.max(size.y, 0.001);

        // Sunk 1.2m into the ground so trunk base and root flare are solidly buried
        model.scale.setScalar(scaleFactor);
        model.position.set(-center.x * scaleFactor, -box.min.y * scaleFactor - 1.25, -center.z * scaleFactor);

        model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            child.castShadow = true;
            child.receiveShadow = true;
            enhanceFoliageMaterial(child.material, child, 0.35);
        });
    } else {
        model = createFallbackTree(0xd85b24, 13.8);
    }

    group.position.copy(GARDEN_POINTS.MAPLE);
    group.rotation.y = 1.2;
    group.add(model);

    // Hitbox for hover/click (local coordinates relative to group)
    const hitbox = new THREE.Mesh(
        new THREE.CylinderGeometry(5.2, 5.2, 14.0, 10, 1, true),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.set(0, 5.5, 0);
    group.add(hitbox);

    const interactiveData = {
        id: 'maple',
        title: 'Japanese Maple',
        meta: 'Autumn Crimson Canopy · Click to visit',
        cameraTarget: { pos: new THREE.Vector3(13.0, 6.8, -10.0), lookAt: new THREE.Vector3(23.0, 4.0, -21.0) }
    };

    return {
        model: group,
        interactive: {
            object: hitbox,
            targetGroup: group,
            data: interactiveData
        }
    };
}

// ---------------------------------------------------------------------------
// 5. Floor Detailing with `floor_leaves.glb` Everywhere (No Circles/Discs)
// ---------------------------------------------------------------------------
function setupFloorEverywhere(leavesGltf) {
    const root = new THREE.Group();
    root.name = 'ScatteredLeavesEverywhere';

    let groundTexture = null;
    let groundNormal = null;

    if (!leavesGltf || !leavesGltf.scene) return { group: root, groundTexture, groundNormal };

    const leafMeshes = [];
    const microPlants = [];

    leavesGltf.scene.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mat = child.material;
        const name = (child.name || '').toLowerCase();
        const matName = (mat.name || '').toLowerCase();

        if (matName.includes('ground_close') || name.includes('ground_close')) {
            if (mat.map && !groundTexture) groundTexture = mat.map;
            if (mat.normalMap && !groundNormal) groundNormal = mat.normalMap;
        } else if (name.startsWith('s_list_') && !name.includes('forest')) {
            if (child.geometry && mat.map) {
                const geom = child.geometry.clone();
                geom.center();
                geom.computeBoundingBox();
                const b = geom.boundingBox;
                const maxDim = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
                if (maxDim > 0) {
                    // Natural fallen leaf size (~0.35 meters)
                    const scale = 0.35 / maxDim;
                    geom.scale(scale, scale, scale);
                    mat.side = THREE.DoubleSide;
                    mat.alphaTest = 0.35;
                    mat.transparent = false;
                    mat.depthWrite = true;
                    mat.polygonOffset = true;
                    mat.polygonOffsetFactor = -2;
                    mat.polygonOffsetUnits = -2;
                    leafMeshes.push({ geometry: geom, material: mat });
                }
            }
        } else if ((name.startsWith('r1') || name.startsWith('r2') || name.startsWith('r3') || name.startsWith('r4')) && !name.includes('forest')) {
            if (child.geometry && mat.map) {
                const geom = child.geometry.clone();
                geom.center();
                geom.computeBoundingBox();
                const b = geom.boundingBox;
                const maxDim = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
                if (maxDim > 0) {
                    // Riparian ground cluster size ~0.45 meters
                    const scale = 0.45 / maxDim;
                    geom.scale(scale, scale, scale);
                    mat.side = THREE.DoubleSide;
                    mat.alphaTest = 0.35;
                    mat.transparent = false;
                    mat.depthWrite = true;
                    microPlants.push({ geometry: geom, material: mat });
                }
            }
        }
    });

    // 1. Scatter individual realistic leaves across the entire garden floor
    if (leafMeshes.length > 0) {
        const countPerMesh = 45; // 8 leaf types * 45 = 360 scattered botanical leaves on ground
        const dummy = new THREE.Object3D();

        leafMeshes.forEach(({ geometry, material }) => {
            const instanced = new THREE.InstancedMesh(geometry, material, countPerMesh);
            instanced.receiveShadow = true;
            instanced.castShadow = false;

            for (let i = 0; i < countPerMesh; i++) {
                let x, z;
                // Distribute leaves with organic natural drifts under canopies + blanket across garden
                const roll = Math.random();
                if (roll < 0.50) {
                    // Wide garden ground coverage
                    const r = Math.sqrt(Math.random()) * 38.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                } else if (roll < 0.78) {
                    // Centerpiece Gulmohar canopy drift
                    const r = Math.sqrt(Math.random()) * 14.5;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                } else {
                    // Japanese Maple canopy drift (autumn crimson leaf drop)
                    const r = Math.sqrt(Math.random()) * 12.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = GARDEN_POINTS.MAPLE.x + Math.cos(theta) * r;
                    z = GARDEN_POINTS.MAPLE.z + Math.sin(theta) * r;
                }

                // Skip scattering fallen ground leaves inside the sunken pond basin
                if (Math.hypot(x - (-23.0), z - (-19.0)) < 6.8) {
                    dummy.position.set(0, -999, 0);
                    dummy.scale.set(0, 0, 0);
                    dummy.updateMatrix();
                    instanced.setMatrixAt(i, dummy.matrix);
                    continue;
                }

                dummy.position.set(x, 0.022 + (i % 8) * 0.002, z);
                dummy.rotation.set(
                    (Math.random() - 0.5) * 0.16,
                    Math.random() * Math.PI * 2,
                    (Math.random() - 0.5) * 0.16
                );
                const s = 0.75 + Math.random() * 0.45;
                dummy.scale.set(s, s, s);
                dummy.updateMatrix();

                instanced.setMatrixAt(i, dummy.matrix);
            }
            instanced.instanceMatrix.needsUpdate = true;
            root.add(instanced);
        });
    }

    // 2. Scatter micro plants & lush riparian foliage to blend pond edges and garden spaces
    if (microPlants.length > 0) {
        const countPerPlant = 16;
        const dummy = new THREE.Object3D();

        microPlants.forEach(({ geometry, material }) => {
            const instanced = new THREE.InstancedMesh(geometry, material, countPerPlant);
            instanced.receiveShadow = true;
            instanced.castShadow = false;

            for (let i = 0; i < countPerPlant; i++) {
                let x, z;
                if (i < 24) {
                    // Ring around sunken pond bank to merge rocks and garden lawn
                    const r = 7.0 + Math.random() * 2.5;
                    const theta = Math.random() * Math.PI * 2;
                    x = GARDEN_POINTS.POND.x + Math.cos(theta) * r;
                    z = GARDEN_POINTS.POND.z + Math.sin(theta) * r;
                } else if (i < 32) {
                    // Near Japanese maple
                    const r = 3.0 + Math.random() * 5.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = GARDEN_POINTS.MAPLE.x + Math.cos(theta) * r;
                    z = GARDEN_POINTS.MAPLE.z + Math.sin(theta) * r;
                } else {
                    // Centerpiece & gazebo transitions
                    const r = 4.0 + Math.random() * 8.0;
                    const theta = Math.random() * Math.PI * 2;
                    x = Math.cos(theta) * r;
                    z = Math.sin(theta) * r;
                }

                dummy.position.set(x, 0.025, z);
                dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
                const s = 0.8 + Math.random() * 0.6;
                dummy.scale.set(s, s, s);
                dummy.updateMatrix();

                instanced.setMatrixAt(i, dummy.matrix);
            }
            instanced.instanceMatrix.needsUpdate = true;
            root.add(instanced);
        });
    }

    return { group: root, groundTexture, groundNormal };
}

// ---------------------------------------------------------------------------
// 6. Curving Garden Pathway (Centered at Origin 0,0,0)
// ---------------------------------------------------------------------------
function createGardenPathway() {
    const group = new THREE.Group();
    group.name = 'GardenPathway';

    const curvePoints = [];
    const segments = 120;
    const baseR = 15.5;

    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        // Symmetric 4-fold clover lobes matching the sketch, perfectly centered at origin
        const r = baseR + Math.sin(theta * 4) * 2.8;
        curvePoints.push(new THREE.Vector3(Math.cos(theta) * r, 0.018, Math.sin(theta) * r));
    }

    const curve = new THREE.CatmullRomCurve3(curvePoints, true);
    const pathWidth = 2.4;

    const pathSegments = 240;
    const vertices = [];
    const uvs = [];
    const indices = [];
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i <= pathSegments; i++) {
        const t = i / pathSegments;
        const point = curve.getPointAt(t);
        const tangent = curve.getTangentAt(t).normalize();
        const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();

        const pLeft = point.clone().addScaledVector(normal, -pathWidth * 0.5);
        const pRight = point.clone().addScaledVector(normal, pathWidth * 0.5);

        pLeft.y = 0.025;
        pRight.y = 0.025;

        vertices.push(pLeft.x, pLeft.y, pLeft.z);
        vertices.push(pRight.x, pRight.y, pRight.z);

        uvs.push(0, t * 18);
        uvs.push(1, t * 18);

        if (i < pathSegments) {
            const i1 = i * 2;
            const i2 = i1 + 1;
            const i3 = (i + 1) * 2;
            const i4 = i3 + 1;
            indices.push(i1, i2, i3);
            indices.push(i2, i4, i3);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#383531';
    ctx.fillRect(0, 0, 512, 512);

    for (let y = 0; y < 512; y += 48) {
        for (let x = 0; x < 512; x += 48) {
            const shiftX = (y % 96 === 0) ? 24 : 0;
            const px = x + shiftX;
            ctx.fillStyle = (Math.random() > 0.5) ? '#423e39' : '#302d29';
            ctx.beginPath();
            ctx.roundRect(px + 4, y + 4, 40, 40, 6);
            ctx.fill();
            ctx.strokeStyle = '#1e1c1a';
            ctx.lineWidth = 2.5;
            ctx.stroke();
        }
    }
    for (let i = 0; i < 4000; i++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.18})`;
        ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
    }

    const pathTex = new THREE.CanvasTexture(canvas);
    pathTex.wrapS = THREE.RepeatWrapping;
    pathTex.wrapT = THREE.RepeatWrapping;
    pathTex.repeat.set(1, 14);

    const pathMat = new THREE.MeshStandardMaterial({
        map: pathTex,
        color: 0x48443f,
        roughness: 0.95,
        metalness: 0.02,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });

    const pathMesh = new THREE.Mesh(geo, pathMat);
    pathMesh.receiveShadow = true;
    group.add(pathMesh);

    const curbMat = new THREE.MeshStandardMaterial({
        color: 0x272422,
        roughness: 0.95,
        metalness: 0.02
    });

    [-1, 1].forEach((side) => {
        const curbPoints = [];
        for (let i = 0; i <= 160; i++) {
            const t = i / 160;
            const pt = curve.getPointAt(t);
            const tan = curve.getTangentAt(t).normalize();
            const norm = new THREE.Vector3().crossVectors(tan, up).normalize();
            const curbPt = pt.clone().addScaledVector(norm, side * pathWidth * 0.52);
            curbPt.y = 0.04;
            curbPoints.push(curbPt);
        }
        const curbCurve = new THREE.CatmullRomCurve3(curbPoints, true);
        const curbGeo = new THREE.TubeGeometry(curbCurve, 160, 0.06, 6, true);
        const curbMesh = new THREE.Mesh(curbGeo, curbMat);
        curbMesh.receiveShadow = true;
        group.add(curbMesh);
    });

    return group;
}

// ---------------------------------------------------------------------------
// Procedural Fallbacks
// ---------------------------------------------------------------------------
function createFallbackTree(leafColor, height) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.7, height * 0.5, 12),
        new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.95 })
    );
    trunk.position.y = height * 0.25;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    g.add(trunk);

    const canopyMat = new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.85 });
    const blobs = [[0, height * 0.65, 0, 4.5], [2.2, height * 0.6, 1.5, 3.2], [-2.4, height * 0.62, -1.8, 3.0]];
    blobs.forEach(([x, y, z, r]) => {
        const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), canopyMat);
        b.position.set(x, y, z);
        b.castShadow = true;
        b.receiveShadow = true;
        g.add(b);
    });
    return g;
}

function createFallbackGazebo() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(3.0, 3.2, 0.3, 8),
        new THREE.MeshStandardMaterial({ color: 0x8f887f })
    );
    base.position.y = 0.15;
    g.add(base);

    const roof = new THREE.Mesh(
        new THREE.ConeGeometry(3.4, 1.8, 8),
        new THREE.MeshStandardMaterial({ color: 0x7c4530, roughness: 0.8 })
    );
    roof.position.y = 3.6;
    roof.castShadow = true;
    g.add(roof);
    return g;
}

function createFallbackPond() {
    const g = new THREE.Group();
    const water = new THREE.Mesh(
        new THREE.CircleGeometry(7.0, 32),
        new THREE.MeshStandardMaterial({ color: 0x225566, roughness: 0.1, metalness: 0.2 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.02;
    g.add(water);
    return g;
}
