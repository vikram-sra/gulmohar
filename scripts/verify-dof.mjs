import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DofPass } from '../src/post/dofPass.js';

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
const pass = new DofPass(camera, { taps: 8, maxBlurPx: 2 });
pass.focusPoint = new THREE.Vector3(6, 0, -10);
assert.equal(pass.resolveFocusDistance(1 / 60), 10, 'focus uses axial depth, not radial distance');
camera.position.z = -4;
assert.equal(pass.resolveFocusDistance(1 / 60), 6, 'dolly movement tracks subject immediately');
camera.lookAt(pass.focusPoint);
assert.ok(Math.abs(pass.resolveFocusDistance(1 / 60) - Math.sqrt(72)) < 1e-8, 'rotation uses the current camera matrix');

function rack(frames) {
    const c = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    const p = new DofPass(c, { taps: 8, maxBlurPx: 2 });
    p.focusPoint = new THREE.Vector3(0, 0, -10);
    p.resolveFocusDistance(1 / frames);
    p.focusPoint.z = -30;
    let distance;
    for (let i = 0; i < frames; i++) distance = p.resolveFocusDistance(1 / frames);
    p.dispose();
    return distance;
}
assert.ok(Math.abs(rack(30) - rack(120)) < 1e-8, 'subject transition is frame-rate independent');
pass.focusPoint = null;
assert.equal(pass.resolveFocusDistance(1 / 60), 0, 'walking delegates to depth autofocus');
pass.focusPoint = new THREE.Vector3(0, 0, 20);
assert.equal(pass.resolveFocusDistance(1 / 60), 0, 'a subject behind the camera delegates to autofocus');
pass.dispose();
console.log('DOF camera movement, axial depth, subject transition, and mode checks passed.');
