import * as THREE from 'three';

/** Frame bounds only: furniture is allowed to share ground with nearby decor. */
export function frameBounds(placement) {
    const { position, rotation, width, height, scale = 1 } = placement;
    const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation, 'YXZ')),
        new THREE.Vector3(scale, scale, scale)
    );
    return new THREE.Box3(new THREE.Vector3(-width / 2 - .04, -height / 2 - .04, -.06),
        new THREE.Vector3(width / 2 + .04, height / 2 + .04, .06)).applyMatrix4(matrix);
}

export function placementIssues(placement, { paintings = [], trunks = [], groundHeightAt, isInPond, isOnPath, canopyAt }) {
    const [x, , z] = placement.position;
    const issues = [];
    const bounds = frameBounds(placement);
    if (Math.hypot(x, z) > 46) issues.push({ blocking: true, message: 'Keep the painting inside the garden.' });
    if (isInPond(x, z)) issues.push({ blocking: true, message: 'This spot is in the pond. Move onto dry ground.' });
    if (bounds.min.y < groundHeightAt(x, z) - .08) issues.push({ blocking: true, message: 'The frame intersects the ground. Raise it or choose another spot.' });
    if (placement.mount === 'rope' && canopyAt) {
        const canopy = canopyAt(x, z);
        if (!canopy || bounds.max.y > canopy.top - .2) issues.push({ blocking: true, message: 'The rope needs branches above the frame. Move under a canopy or lower the painting.' });
    }
    if (placement.mount !== 'surface') {
        const yaw = placement.rotation[1], halfW = placement.width * placement.scale / 2;
        for (const trunk of trunks) {
            const dx = trunk.x - x, dz = trunk.z - z;
            const along = Math.max(-halfW, Math.min(halfW, dx * Math.cos(yaw) - dz * Math.sin(yaw)));
            const distance = Math.hypot(dx - along * Math.cos(yaw), dz + along * Math.sin(yaw));
            if (distance < trunk.radius + .08 && bounds.min.y < trunk.top && bounds.max.y > (trunk.base || 0)) {
                issues.push({ blocking: true, message: 'The frame intersects a tree trunk. Move it clear of the bark.' });
                break;
            }
        }
    }
    for (const other of paintings) {
        if (bounds.intersectsBox(frameBounds(other))) issues.push({ blocking: false, message: `May overlap “${other.title || 'another painting'}”. Check the space between the frames.` });
    }
    if (['easel', 'ground'].includes(placement.mount) && isOnPath(x, z, placement.width * placement.scale / 2)) {
        issues.push({ blocking: false, message: 'This display is on the walking path. Leave room for visitors to pass.' });
    }
    return issues;
}
