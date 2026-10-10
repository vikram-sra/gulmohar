// Exercise the placement controller with real Three.js transforms and a local
// backend double: no authentication, uploads or production writes required.
// Run: node --experimental-vm-modules scripts/verify-placement.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import { placementIssues } from '../src/place/placementGeometry.js';

class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.append(node); }
    addEventListener(type, fn) { this.events[type] = fn; }
    setAttribute() {}
    querySelector(tag) { return this.children.find(n => n.tagName === tag); }
    remove() {}
    showModal() {}
    close() {}
}
const mesh = () => {
    const group = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    group.add(panel);
    return { group, panel };
};
const source = await readFile(new URL('../src/place/placeMode.js', import.meta.url), 'utf8');
for (const mount of ['easel', 'ground', 'rope', 'surface']) {
    const original = { placed: true, mount, position: [2, 1.4, 3], rotation: [-0.16, 1.1, 0], scale: 1, rise: 0.75 };
    const artwork = { id: 'test', dimensions: { width: 24, height: 32 }, placement: structuredClone(original) };
    let written, releaseSave, switched, writeCount = 0;
    const backend = {
        onUser(fn) { queueMicrotask(() => fn({ id: 'artist' })); return () => {}; },
        checkAccess: async () => true,
        watchArtworks(fn) { queueMicrotask(() => fn([artwork, { id: "other", title: "Other painting", status: "ready", placement: { placed: false } }])); return () => {}; },
        async updateArtwork(id, patch) { writeCount++; written = patch.placement; await new Promise(resolve => { releaseSave = resolve; }); }
    };
    const body = new Element('body');
    const context = vm.createContext({
        console, URLSearchParams, location: { search: '' },
        document: { body, createElement: tag => new Element(tag) },
        window: { addEventListener() {}, removeEventListener() {} },
        requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {}
    });
    const controller = new vm.SourceTextModule(source, { context });
    await controller.link(async specifier => {
        const exports = specifier === 'three' ? THREE
            : specifier.endsWith('.css') ? {}
            : specifier.includes('backend') ? { getBackend: async () => backend }
            : specifier.includes('schema') ? { dimensionsInInches: () => ({ widthIn: 24, heightIn: 32 }) }
            : specifier.includes('paintings') ? { createPaintingMesh: mesh, createMountFurniture: () => new THREE.Group(), loadPanelTexture() {}, normalizeMount: m => m, mountAllPaintings: () => new Map() }
            : specifier.includes('placementGeometry') ? { placementIssues }
            : specifier.includes('garden') ? { groundHeightAt: () => 0, POND_WATER_Y: -1, GARDEN_POINTS: { GULMOHAR: new THREE.Vector3(0, 0, 0) }, isInPond: () => false, isOnPath: () => false, insideGazebo: () => false }
            : { fitSurfaces: () => ({ trunks: [], canopies: [] }), buildTrunkProxies: () => [], fitGazeboPosts: () => [], canopyOver: () => ({ top: 8 }) };
        return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
    });
    await controller.evaluate();
    const group = new THREE.Group();
    const app = { garden: { group }, camera: new THREE.PerspectiveCamera(50, 1.5), scene: new THREE.Scene(), renderer: { shadowMap: {} }, groundMesh: new THREE.Mesh(), async switchPlaceArtwork(id) { switched = id; } };
    const mode = await controller.namespace.attachPlaceMode(app, 'test');
    const all = node => [node, ...node.children.flatMap(all)];
    const button = text => all(body).find(n => n.tagName === 'button' && n.textContent === text);
    const live = group.children.find(n => n.visible);
    app.camera.position.set(-20, 4, -10); // Inspect it from the opposite side.
    button('+').events.click();
    assert.equal(live.rotation.y, original.rotation[1], `${mount}: resizing must not face the viewing camera`);
    if (mount === 'surface' || mount === 'rope') assert.equal(live.position.y, original.position[1]);
    const resizedY = live.position.y;
    button('Right →').events.click();
    assert.equal(live.position.y, resizedY, 'Horizontal nudges keep the frame height on flat terrain');
    button('Undo').events.click();
    assert.equal(live.position.x, original.position[0], 'Undo restores the previous position');
    assert.equal(live.rotation.y, original.rotation[1], 'Undo restores the previous angle');
    const displayed = { position: live.position.toArray(), rotation: [live.rotation.x, live.rotation.y, live.rotation.z], scale: live.scale.x };
    const saving = button('Save placement').events.click();
    button('+').events.click();
    button('Choose new spot').events.click();
    assert.equal(mode.debug().state.phase, 'placed', 'Cannot move while save is pending');
    assert.equal(live.scale.x, displayed.scale, 'Cannot resize while save is pending');
    assert.deepEqual(Array.from(written.position), displayed.position, `${mount}: persisted position matches preview`);
    assert.deepEqual(Array.from(written.rotation), displayed.rotation, `${mount}: persisted rotation matches preview`);
    releaseSave(); await saving;
    assert.equal(mode.debug().state.dirty, false);
    button('Choose new spot').events.click();
    const state = mode.debug().state;
    state.aim = { point: new THREE.Vector3(4, 0, 5), normal: new THREE.Vector3(0, 0, 1), kind: mount === 'surface' ? 'surface' : 'ground', ground: 0, canopy: { top: 8 } };
    button('Place here').events.click();
    const selectedYaw = state.baseYaw;
    app.camera.position.set(30, 2, 20);
    const labels = { easel: 'On an easel', ground: 'On the ground', rope: 'Hung by rope', surface: 'Hung on a surface' };
    all(body).find(n => n.tagName === 'button' && n.children.some(c => c.textContent === labels[mount])).events.click();
    assert.equal(state.phase, 'placed');
    assert.equal(live.position.x, 4, 'The selected spot stays fixed while choosing a mount');
    if (mount !== 'surface') assert.equal(live.rotation.y, selectedYaw, 'The selected orientation stays fixed while choosing a mount');
    const picker = all(body).find(n => n.tagName === 'select');
    picker.value = 'other';
    await picker.events.change();
    assert.equal(switched, undefined, 'Switching an unsaved painting asks how to handle changes');
    assert.equal(picker.value, 'test', 'The picker stays on the current artwork until resolved');
    await button('Discard and switch').events.click();
    assert.equal(switched, 'other', 'Discard and switch opens the selected painting');
    assert.equal(writeCount, 1, 'Discarding makes no new backend writes');
    button('Cancel').events.click();
    assert.equal(context.location.href, './studio/', 'Cancel returns to Studio without another save');
    mode.dispose();
    console.log(`✓ ${mount}: resize, camera movement, save consistency and pending-save guards`);
}

const frame = { position: [5, 1.5, 5], rotation: [0, 0, 0], width: 1, height: 1, scale: 1, mount: 'easel' };
const clear = { groundHeightAt: () => 0, isInPond: () => false, isOnPath: () => false };
assert.equal(placementIssues(frame, clear).length, 0);
assert(placementIssues(frame, { ...clear, isInPond: () => true }).some(i => i.blocking));
assert(placementIssues({ ...frame, position: [5, .1, 5] }, clear).some(i => i.blocking));
assert(placementIssues(frame, { ...clear, trunks: [{ x: 5, z: 5, radius: .3, top: 4 }] }).some(i => i.blocking));
assert(placementIssues(frame, { ...clear, paintings: [{ ...frame, title: 'Neighbour' }] }).some(i => !i.blocking && i.message.includes('Neighbour')));
assert.equal(placementIssues(frame, { ...clear, paintings: [{ ...frame, position: [15, 1.5, 5] }] }).length, 0);
assert(placementIssues(frame, { ...clear, isOnPath: () => true }).some(i => !i.blocking));
assert(placementIssues({ ...frame, mount: 'rope' }, { ...clear, canopyAt: () => null }).some(i => i.blocking));
console.log('✓ Clearance checks: dry ground, frame height, trunks, neighbouring frames, paths and rope support');
