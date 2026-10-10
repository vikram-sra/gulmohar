const key = () => `gulmohar-view:${new URL('.', location.href).pathname}`;

export function rememberGardenView(app) {
    try {
        sessionStorage.setItem(key(), JSON.stringify({
            at: Date.now(), position: app.camera.position.toArray(), quaternion: app.camera.quaternion.toArray(),
            target: app.controls.target.toArray(), mode: app.navMode,
            painting: app._paintingFocus?.id || app._paintingSelect?.value || null
        }));
    } catch { /* Storage is optional, including in private browsing. */ }
}
export function restoreGardenView(app) {
    const params = new URLSearchParams(location.search);
    const back = performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
    if (!params.has('restore') && !back) return false;
    try {
        const view = JSON.parse(sessionStorage.getItem(key()));
        const valid = (array, length) => Array.isArray(array) && array.length === length && array.every(Number.isFinite);
        if (!view || Date.now() - view.at > 30 * 60 * 1000 || !valid(view.position, 3) || !valid(view.target, 3) || !valid(view.quaternion, 4)) return false;
        app.camera.position.fromArray(view.position);
        const painting = app.paintings.get(view.painting);
        if (painting) {
            const target = painting.interactive.data.cameraTarget;
            app.controls.minDistance = app._paintingDollyLimit(target.worldHeight, target.pos.distanceTo(target.lookAt));
            app._setPaintingFocus(view.painting, app.camera.position.distanceTo(painting.interactive.data.cameraTarget.lookAt));
            app._paintingSelect.value = view.painting;
            if (app._paintingViewButton) app._paintingViewButton.disabled = false;
            app.showLabelFor(painting.interactive.data);
        }
        app.camera.position.fromArray(view.position);
        app.camera.quaternion.fromArray(view.quaternion);
        app.controls.target.fromArray(view.target);
        app.controls.autoRotate = false;
        if (view.mode === 'walk') { app.setNavMode('walk'); app.fpsNavigator.enableFromCamera(); }
        else app.controls.update();
        return true;
    } catch { return false; }
}
