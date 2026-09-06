import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getAssetUrl } from '../utils/paths.js';

// One tree. The model is normalised to a target height and sunk slightly into
// the ground, because the exported mesh's lowest vertex is a root tip rather
// than the trunk's contact point -- placing it at y = 0 leaves the tree
// standing on its toes.
const TARGET_HEIGHT = 16.0;
const GROUND_SINK = 2.15;

/**
 * Resolves to a group standing on y = 0, already scaled and shadow-configured.
 * If the GLB cannot be fetched the scene still gets a tree -- a plain
 * procedural one -- rather than an empty patch of ground.
 */
export function loadTree(loadingManager) {
    return new Promise((resolve) => {
        const loader = new GLTFLoader(loadingManager);
        loader.load(
            getAssetUrl('models/tree.glb'),
            (gltf) => resolve(prepare(gltf.scene)),
            undefined,
            (err) => {
                console.warn('Tree GLB failed to load, using procedural stand-in:', err);
                resolve(proceduralTree());
            }
        );
    });
}

function prepare(model) {
    model.name = 'TreeModel';

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const scaleFactor = TARGET_HEIGHT / Math.max(size.y, 0.001);
    model.position.set(-center.x, -box.min.y - GROUND_SINK / scaleFactor, -center.z);

    model.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        child.castShadow = true;
        child.receiveShadow = true;

        const mat = child.material;
        mat.side = THREE.DoubleSide;
        mat.shadowSide = THREE.DoubleSide;
        if (mat.roughness !== undefined) mat.roughness = Math.max(mat.roughness, 0.65);

        // Foliage is alpha-cut, not alpha-blended: cutting keeps depth writes on,
        // which is what lets leaves sort against each other and cast leaf-shaped
        // shadows instead of rectangles. The depth material has to repeat the
        // cutout or the shadow pass ignores it.
        const looksLikeFoliage = mat.alphaTest > 0 || mat.transparent ||
            (mat.name && /leaf|leaves|foliage|branch|00[1-4]/i.test(mat.name)) ||
            (child.name && /leaf|leaves|branch/i.test(child.name));

        if (looksLikeFoliage && mat.map) {
            mat.alphaTest = 0.35;
            mat.transparent = false;
            mat.depthWrite = true;
            mat.needsUpdate = true;
            child.customDepthMaterial = new THREE.MeshDepthMaterial({
                depthPacking: THREE.RGBADepthPacking,
                map: mat.map,
                alphaTest: 0.35,
                side: THREE.DoubleSide
            });
        }
    });

    const wrapper = new THREE.Group();
    wrapper.name = 'Tree';
    wrapper.add(model);
    wrapper.scale.setScalar(scaleFactor);
    return wrapper;
}

// Deliberately crude: this exists so a failed download degrades to a tree-shaped
// object rather than nothing, not so it passes for the real model.
function proceduralTree() {
    const g = new THREE.Group();
    g.name = 'Tree';

    const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.62, 7.0, 12),
        new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.95 })
    );
    trunk.position.y = 3.5;
    trunk.castShadow = trunk.receiveShadow = true;
    g.add(trunk);

    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2f4a24, roughness: 0.9 });
    [[0, 8.6, 0, 3.4], [1.9, 7.6, 1.2, 2.4], [-2.0, 7.9, -1.1, 2.2], [0.6, 10.4, -1.6, 2.0]]
        .forEach(([x, y, z, r]) => {
            const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), canopyMat);
            blob.position.set(x, y, z);
            blob.castShadow = blob.receiveShadow = true;
            g.add(blob);
        });

    return g;
}
