import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { createPaintingMesh, loadPanelTexture, resolveAnchor } from '../scene/paintings.js';
import { writeZip } from './zip.js';

// Structural/trunk-like meshes only -- a raycast against alpha-cutout leaf
// geometry is unreliable (Raycaster ignores alphaTest) and "mount a painting
// on a transparent leaf texel in mid-air" is exactly the failure that
// produces. The maple's trunk is literally named `shu_gan` (树干, Chinese for
// "tree trunk") -- no English word would catch it, which is why this list is
// shared with wind.js's WOODY pattern rather than re-derived here.
const MOUNTABLE_NAME = /trunk|bark|wood|stem|log|root|limb|timber|branch|shu[_ -]?gan|object/i;

const AUTOSAVE_KEY = 'gulmohar-garden-placements-v1';

export function attachEditor(app) {
    const editor = new Editor(app);
    editor.init();
    // Dev-console access, same convention as window.__gulmohar.
    if (import.meta.env && import.meta.env.DEV) window.__gulmoharEdit = editor;
    return editor;
}

class Editor {
    constructor(app) {
        this.app = app;
        this.records = new Map();   // id -> { record, mounted: {group,panel,hitbox,interactive} }
        this.selectedId = null;
        this.mountCandidates = [];
        this.dirty = false;
    }

    init() {
        const app = this.app;

        // Every existing painting was already mounted read-only by main.js
        // before this attached; adopt them into the editor's own record map
        // rather than re-mounting.
        if (app.paintings) {
            app.paintings.forEach((mounted, id) => {
                this.records.set(id, { record: mounted.group.userData.placement, mounted });
            });
        }

        this.buildMountCandidates();
        this.setupTransformControls();
        this.buildUI();
        this.wireInput();
        this.loadAutosave();

        // A moving sun and an orbiting camera are both hostile to judging
        // placement. "Paused" already means "everything ambient stops" --
        // see main.js's own note on this -- so this is the same rule, not a
        // special edit-mode exception to it.
        app.setMotionPaused(true);
        app.controls.maxPolarAngle = Math.PI * 0.497;   // steep-down look, for placing flat on the ground
        app.resetUIHideTimer = () => {};                // a dock that vanishes over an editor is hostile
        app.setUIVisibility(true);

        window.addEventListener('beforeunload', (e) => {
            if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
        });
    }

    buildMountCandidates() {
        const app = this.app;
        this.mountCandidates = [];
        ['GulmoharTree', 'MapleTree', 'Gazebo'].forEach((name) => {
            const grp = app.garden.group.getObjectByName(name);
            if (!grp) return;
            grp.traverse((o) => {
                if (o.isMesh && !o.isInstancedMesh && MOUNTABLE_NAME.test(o.name || '')) {
                    this.mountCandidates.push(o);
                }
            });
        });
        if (app.groundMesh) this.mountCandidates.push(app.groundMesh);
    }

    // -- transform gizmo ------------------------------------------------

    setupTransformControls() {
        const app = this.app;
        const tc = new TransformControls(app.camera, app.renderer.domElement);
        tc.setSize(0.9);
        tc.addEventListener('dragging-changed', (e) => {
            app.controls.enabled = !e.value;
            // A drag ending is a "short pointer interaction" by the same test
            // a tap uses, so it would otherwise also fire onClick and fly the
            // camera away via resetScene(). Held one tick past pointerup so
            // the click that ends the drag is the one actually suppressed.
            app._suppressClick = true;
            if (!e.value) setTimeout(() => { app._suppressClick = false; }, 0);
        });
        tc.addEventListener('objectChange', () => {
            this.syncSelectedTransform();
            this.markDirty();
        });
        // three 0.182: TransformControls extends Controls, not Object3D --
        // the scene needs its helper, not the controls object itself.
        app.scene.add(tc.getHelper());
        this.transformControls = tc;

        window.addEventListener('keydown', (e) => {
            if (this.isTypingTarget(e.target)) return;
            if (e.key === 'w' || e.key === 'W') tc.setMode('translate');
            else if (e.key === 'e' || e.key === 'E') tc.setMode('rotate');
            else if (e.key === 'r' || e.key === 'R') tc.setMode('scale');
            else if (e.key === 'Escape') this.select(null);
            else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected();
            else if (e.shiftKey) { tc.setTranslationSnap(0.25); tc.setRotationSnap(THREE.MathUtils.degToRad(15)); }
        });
        window.addEventListener('keyup', (e) => {
            if (!e.shiftKey) { tc.setTranslationSnap(null); tc.setRotationSnap(null); }
        });
    }

    isTypingTarget(el) {
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    // -- selection & placement -------------------------------------------

    select(id) {
        this.selectedId = id;
        const entry = id ? this.records.get(id) : null;
        if (entry) {
            this.transformControls.attach(entry.mounted.group);
        } else {
            this.transformControls.detach();
        }
        this.refreshInspector();
    }

    syncSelectedTransform() {
        const entry = this.records.get(this.selectedId);
        if (!entry) return;
        const g = entry.mounted.group;
        entry.record.position = g.position.toArray();
        entry.record.rotation = [g.rotation.x, g.rotation.y, g.rotation.z];
        entry.record.scale = g.scale.x;
    }

    /**
     * Raycasts the mount candidates from the current pointer position and,
     * if the selected painting isn't attached to a landmark, re-parents and
     * re-orients it to the hit surface. Ground hits lie flat or lean
     * (toggled by the inspector's "lean" checkbox); anything else orients to
     * the surface's own outward normal with a slight backward tilt, as if
     * hung off a nail.
     */
    tryPlaceAtPointer(clientX, clientY) {
        const app = this.app;
        const entry = this.records.get(this.selectedId);
        if (!entry) return false;

        const rect = app.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, app.camera);
        const hits = ray.intersectObjects(this.mountCandidates, false);
        if (!hits.length) return false;

        const hit = hits[0];
        const { group } = entry.mounted;
        const isGround = hit.object === app.groundMesh;

        let anchorName, anchorObj;
        if (isGround) {
            anchorName = 'world';
            anchorObj = app.garden.group;
        } else {
            let p = hit.object;
            while (p && !['GulmoharTree', 'MapleTree', 'Gazebo'].includes(p.name)) p = p.parent;
            anchorName = p ? p.name : 'world';
            anchorObj = p || app.garden.group;
        }

        if (group.parent !== anchorObj) {
            const worldPos = new THREE.Vector3();
            group.getWorldPosition(worldPos);
            anchorObj.add(group);
        }

        // Position and orientation are set directly in the anchor's local
        // space by converting the world-space hit back through the anchor's
        // own matrix, so a painting anchored to a rotated group (the trees
        // and gazebo all carry a rotation.y) still ends up flush with the
        // surface rather than offset by the anchor's own rotation.
        const localPoint = anchorObj.worldToLocal(hit.point.clone());
        const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
        const localNormalPoint = anchorObj.worldToLocal(hit.point.clone().add(worldNormal));
        const localNormal = localNormalPoint.sub(localPoint).normalize();

        group.position.copy(localPoint);

        if (isGround) {
            const lean = entry.record.mount === 'ground-flat' ? 0 : THREE.MathUtils.degToRad(78);
            group.rotation.set(-Math.PI / 2 + (Math.PI / 2 - lean), 0, 0);
            group.position.y += 0.02;
            entry.record.mount = entry.record.mount === 'ground-flat' ? 'ground-flat' : 'ground-lean';
        } else {
            const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal);
            group.quaternion.copy(quat);
            group.rotateX(THREE.MathUtils.degToRad(-5));   // a slight backward tilt, as if hung off a nail
            group.position.addScaledVector(localNormal, 0.03);
            entry.record.mount = anchorName === 'Gazebo' ? 'wall' : 'tree';
        }

        entry.record.anchor = anchorName;
        this.syncSelectedTransform();
        this.markDirty();
        return true;
    }

    deleteSelected() {
        const entry = this.records.get(this.selectedId);
        if (!entry) return;
        const { group, hitbox } = entry.mounted;
        const idx = this.app._hoverTargets.indexOf(hitbox);
        if (idx >= 0) this.app._hoverTargets.splice(idx, 1);
        this.app._hoverOwner.delete(hitbox);
        group.parent && group.parent.remove(group);
        this.records.delete(this.selectedId);
        this.select(null);
        this.markDirty();
        this.refreshList();
    }

    // -- adding a painting -------------------------------------------------

    async addPaintingFromFile(file) {
        const { url, widthPx, heightPx, blob } = await this.downscaleImage(file, 1600);
        const aspect = widthPx / heightPx;
        const heightIn = 24;
        const id = `${(file.name || 'untitled').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now().toString(36)}`;
        const fileName = `portfolio/${id}.webp`;

        const record = {
            id, file: fileName, aspect,
            widthIn: Math.round(heightIn * aspect), heightIn,
            title: file.name.replace(/\.[^.]+$/, '') || 'Untitled',
            year: new Date().getFullYear(), medium: '',
            mount: 'free', anchor: 'world',
            position: this.defaultDropPosition(),
            rotation: [0, 0, 0], frame: 'pale-wood'
        };

        // skipAutoTexture: the public/portfolio/<id>.webp this record points
        // at doesn't exist until Save, so letting mountRecord's normal load
        // run would 404 and race the object-URL load below -- whichever
        // settled last used to win, and the network 404 (even to localhost)
        // sometimes lost to it, clobbering the correct image with the
        // placeholder a moment after it appeared.
        const mounted = this.mountRecord(record, { skipAutoTexture: true });
        loadPanelTexture(url, (tex) => { mounted.panel.material.map = tex; mounted.panel.material.needsUpdate = true; });

        this.records.set(id, { record, mounted, blob, objectUrl: url });
        this.select(id);
        this.markDirty();
        this.refreshList();
    }

    defaultDropPosition() {
        const app = this.app;
        const dir = new THREE.Vector3();
        app.camera.getWorldDirection(dir);
        return app.camera.position.clone().addScaledVector(dir, 4).toArray();
    }

    mountRecord(record, { skipAutoTexture = false } = {}) {
        const app = this.app;
        const anchor = resolveAnchor(app.garden.group, record.anchor);
        const { group, panel, hitbox } = createPaintingMesh(record.widthIn, record.heightIn, record.frame);
        group.position.fromArray(record.position);
        group.rotation.fromArray(record.rotation);
        group.scale.setScalar(record.scale || 1);
        group.userData.placement = record;
        anchor.add(group);
        panel.material.needsUpdate = true;

        if (record.file && !skipAutoTexture) {
            loadPanelTexture(getAssetUrlSafe(record.file), (tex) => {
                panel.material.map = tex; panel.material.needsUpdate = true;
            });
        }

        const interactive = {
            object: hitbox,
            data: { id: record.id, title: record.title, meta: record.medium || '', cameraTarget: null, __editorRecord: true }
        };
        app._registerHover(hitbox, interactive.data);
        return { group, panel, hitbox, interactive };
    }

    // -- image handling ----------------------------------------------------

    downscaleImage(file, maxEdge) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const reader = new FileReader();
            reader.onload = () => { img.src = reader.result; };
            reader.onerror = reject;
            img.onload = () => {
                const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
                const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                canvas.toBlob((blob) => {
                    resolve({ url: URL.createObjectURL(blob), widthPx: w, heightPx: h, blob });
                }, 'image/webp', 0.86);
            };
            img.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // -- persistence ---------------------------------------------------

    markDirty() {
        this.dirty = true;
        this.scheduleAutosave();
        this.updateSaveStatus();
    }

    scheduleAutosave() {
        clearTimeout(this._autosaveTimer);
        this._autosaveTimer = setTimeout(() => this.autosave(), 800);
    }

    autosave() {
        const paintings = Array.from(this.records.values()).map((e) => e.record);
        try {
            localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ version: 1, paintings }));
        } catch { /* private mode / quota -- the Save button still works */ }
    }

    loadAutosave() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null'); } catch { /* ignore */ }
        if (!saved || !Array.isArray(saved.paintings)) return;

        // Only apply autosave entries whose id isn't already mounted from
        // paintings.json (an edit made and saved to the file supersedes a
        // stale localStorage draft of the same painting).
        saved.paintings.forEach((record) => {
            if (this.records.has(record.id)) {
                const entry = this.records.get(record.id);
                entry.record.position = record.position;
                entry.record.rotation = record.rotation;
                entry.record.scale = record.scale;
                entry.record.mount = record.mount;
                entry.record.anchor = record.anchor;
                const anchor = resolveAnchor(this.app.garden.group, record.anchor);
                if (entry.mounted.group.parent !== anchor) anchor.add(entry.mounted.group);
                entry.mounted.group.position.fromArray(record.position);
                entry.mounted.group.rotation.fromArray(record.rotation);
                entry.mounted.group.scale.setScalar(record.scale || 1);
            } else {
                // A painting added in a previous session, uploaded but never
                // exported -- its image only exists as a blob that no longer
                // exists after a reload, so it remounts with the placeholder
                // and a visible note rather than silently vanishing.
                const mounted = this.mountRecord(record);
                this.records.set(record.id, { record, mounted });
            }
        });
        this.refreshList();
    }

    async exportZip() {
        const files = [];
        const paintings = [];
        for (const entry of this.records.values()) {
            paintings.push(entry.record);
            if (entry.blob) {
                files.push({ name: entry.record.file, data: new Uint8Array(await entry.blob.arrayBuffer()) });
            }
        }
        const placementsJson = JSON.stringify({ version: 1, paintings }, null, 2);
        files.unshift({ name: 'paintings.json', data: new TextEncoder().encode(placementsJson) });

        const zipBlob = writeZip(files);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(zipBlob);
        a.download = `gulmohar-garden-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();

        this.dirty = false;
        this.updateSaveStatus('Downloaded — unzip paintings.json to the project root and portfolio/* into public/portfolio/, then commit.');
    }

    // -- UI ------------------------------------------------------------

    buildUI() {
        const style = document.createElement('style');
        style.textContent = `
            #editor-panel { position: fixed; top: 16px; right: 16px; width: 280px; max-height: calc(100vh - 32px);
                overflow-y: auto; z-index: 4000; background: rgba(20,24,18,0.88); backdrop-filter: blur(14px);
                border: 1px solid rgba(255,255,255,0.14); border-radius: 12px; padding: 14px;
                font-family: 'Outfit', system-ui, sans-serif; color: #EEF0E8; font-size: 12.5px; line-height: 1.5; }
            #editor-panel h2 { font-size: 11px; letter-spacing: 0.14rem; text-transform: uppercase; opacity: 0.7; margin: 0 0 10px; }
            #editor-panel .drop { border: 1.5px dashed rgba(255,255,255,0.3); border-radius: 8px; padding: 16px 10px;
                text-align: center; cursor: pointer; margin-bottom: 12px; transition: border-color 0.15s, background 0.15s; }
            #editor-panel .drop:hover, #editor-panel .drop.drag { border-color: #d9502f; background: rgba(217,80,47,0.08); }
            #editor-panel .hint { opacity: 0.65; font-size: 11px; margin-bottom: 10px; }
            #editor-panel .hint b { color: #f2a98c; font-weight: 600; }
            #editor-panel button { background: rgba(255,255,255,0.08); color: #EEF0E8; border: 1px solid rgba(255,255,255,0.16);
                border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
            #editor-panel button:hover { background: rgba(255,255,255,0.16); }
            #editor-panel button.primary { background: #d9502f; border-color: #d9502f; }
            #editor-panel button.primary:hover { background: #e8623f; }
            #editor-panel .row { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
            #editor-panel input[type=text], #editor-panel input[type=number] { flex: 1; background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.14); color: #EEF0E8; border-radius: 5px; padding: 5px 7px; font-size: 12px; width: 0; }
            #editor-panel select { flex: 1; background: rgba(255,255,255,0.06); color: #EEF0E8; border: 1px solid rgba(255,255,255,0.14);
                border-radius: 5px; padding: 5px 7px; font-size: 12px; }
            #editor-panel label.mini { display: block; opacity: 0.6; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06rem; margin: 8px 0 3px; }
            #editor-panel .list-item { display: flex; justify-content: space-between; align-items: center; padding: 5px 7px;
                border-radius: 5px; cursor: pointer; margin-bottom: 2px; }
            #editor-panel .list-item:hover { background: rgba(255,255,255,0.06); }
            #editor-panel .list-item.selected { background: rgba(217,80,47,0.22); }
            #editor-panel .status { font-size: 10.5px; opacity: 0.6; margin-top: 10px; min-height: 14px; }
            #editor-panel hr { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 12px 0; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'editor-panel';
        panel.innerHTML = `
            <h2>Gulmohar · edit mode</h2>
            <div class="drop" id="ed-drop">Drop an image, or click to choose</div>
            <input type="file" id="ed-file" accept="image/*" style="display:none">
            <div class="hint">Select a painting, then click the <b>tree, gazebo or ground</b> to place it there.
              <b>W</b> move · <b>E</b> rotate · <b>R</b> scale · <b>Delete</b> remove · hold <b>Shift</b> to snap.</div>
            <div id="ed-list"></div>
            <hr>
            <div id="ed-inspector"></div>
            <hr>
            <div class="row"><button class="primary" id="ed-save" style="flex:1">Save (download .zip)</button></div>
            <div class="status" id="ed-status"></div>
        `;
        document.body.appendChild(panel);
        this.el = panel;

        const fileInput = panel.querySelector('#ed-file');
        const drop = panel.querySelector('#ed-drop');
        drop.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) this.addPaintingFromFile(fileInput.files[0]);
            fileInput.value = '';
        });
        ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
        drop.addEventListener('drop', (e) => {
            const file = e.dataTransfer.files && e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) this.addPaintingFromFile(file);
        });

        panel.querySelector('#ed-save').addEventListener('click', () => this.exportZip());

        // The whole panel is DOM over the canvas; nothing inside it should
        // reach the scene's own pointer handling.
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'click'].forEach((ev) =>
            panel.addEventListener(ev, (e) => e.stopPropagation())
        );

        this.refreshList();
        this.refreshInspector();
    }

    refreshList() {
        const list = this.el.querySelector('#ed-list');
        list.innerHTML = '';
        this.records.forEach((entry, id) => {
            const item = document.createElement('div');
            item.className = 'list-item' + (id === this.selectedId ? ' selected' : '');
            item.textContent = entry.record.title || id;
            item.addEventListener('click', () => this.select(id));
            list.appendChild(item);
        });
        if (this.records.size === 0) {
            list.innerHTML = '<div style="opacity:0.5;padding:4px 7px;">Nothing hung yet.</div>';
        }
    }

    refreshInspector() {
        const box = this.el.querySelector('#ed-inspector');
        const entry = this.records.get(this.selectedId);
        if (!entry) { box.innerHTML = '<div style="opacity:0.5;">Nothing selected.</div>'; return; }
        const r = entry.record;
        box.innerHTML = `
            <label class="mini">Title</label>
            <div class="row"><input type="text" id="f-title" value="${escapeAttr(r.title || '')}"></div>
            <label class="mini">Year · Medium</label>
            <div class="row">
                <input type="number" id="f-year" value="${r.year || ''}" style="flex:0.5">
                <input type="text" id="f-medium" value="${escapeAttr(r.medium || '')}">
            </div>
            <label class="mini">Height (in) · Frame</label>
            <div class="row">
                <input type="number" id="f-height" value="${r.heightIn}" style="flex:0.5">
                <select id="f-frame">
                    <option value="pale-wood" ${r.frame === 'pale-wood' ? 'selected' : ''}>Pale wood</option>
                    <option value="maple" ${r.frame === 'maple' ? 'selected' : ''}>Maple</option>
                    <option value="none" ${r.frame === 'none' ? 'selected' : ''}>None</option>
                </select>
            </div>
            <div class="row"><button id="f-delete" style="flex:1">Remove</button></div>
            <div style="opacity:0.55; font-size:10.5px; margin-top:4px;">mount: ${r.mount} · anchor: ${r.anchor}</div>
        `;
        box.querySelector('#f-title').addEventListener('input', (e) => { r.title = e.target.value; this.markDirty(); this.refreshList(); });
        box.querySelector('#f-year').addEventListener('input', (e) => { r.year = parseInt(e.target.value, 10) || null; this.markDirty(); });
        box.querySelector('#f-medium').addEventListener('input', (e) => { r.medium = e.target.value; this.markDirty(); });
        box.querySelector('#f-height').addEventListener('change', (e) => {
            r.heightIn = parseFloat(e.target.value) || r.heightIn;
            r.widthIn = Math.round(r.heightIn * (r.aspect || 1));
            this.rebuildSelectedGeometry();
            this.markDirty();
        });
        box.querySelector('#f-frame').addEventListener('change', (e) => {
            r.frame = e.target.value;
            this.rebuildSelectedGeometry();
            this.markDirty();
        });
        box.querySelector('#f-delete').addEventListener('click', () => this.deleteSelected());
    }

    // Height/frame changes need new geometry (frame border scales with
    // size) -- rebuilt in place rather than adding a resize path to
    // createPaintingMesh, since this only happens from the inspector.
    rebuildSelectedGeometry() {
        const entry = this.records.get(this.selectedId);
        if (!entry) return;
        const { group: oldGroup, panel: oldPanel } = entry.mounted;
        const parent = oldGroup.parent;
        const pos = oldGroup.position.clone(), rot = oldGroup.rotation.clone(), scl = oldGroup.scale.x;
        const map = oldPanel.material.map;

        this.transformControls.detach();
        parent.remove(oldGroup);
        const idx = this.app._hoverTargets.indexOf(entry.mounted.hitbox);
        if (idx >= 0) this.app._hoverTargets.splice(idx, 1);
        this.app._hoverOwner.delete(entry.mounted.hitbox);

        const fresh = createPaintingMesh(entry.record.widthIn, entry.record.heightIn, entry.record.frame);
        fresh.group.position.copy(pos);
        fresh.group.rotation.copy(rot);
        fresh.group.scale.setScalar(scl);
        fresh.group.userData.placement = entry.record;
        fresh.panel.material.map = map;
        fresh.panel.material.needsUpdate = true;
        parent.add(fresh.group);
        this.app._registerHover(fresh.hitbox, { id: entry.record.id, title: entry.record.title, meta: entry.record.medium || '', cameraTarget: null, __editorRecord: true });

        entry.mounted = { group: fresh.group, panel: fresh.panel, hitbox: fresh.hitbox, interactive: { object: fresh.hitbox } };
        this.transformControls.attach(fresh.group);
    }

    updateSaveStatus(message) {
        const status = this.el.querySelector('#ed-status');
        status.textContent = message || (this.dirty ? 'Unsaved changes (autosaving locally)' : 'Saved');
    }

    // -- pointer routing -----------------------------------------------

    wireInput() {
        const app = this.app;
        const dom = app.renderer.domElement;

        dom.addEventListener('pointerdown', (e) => {
            if (this.transformControls.dragging) return;
            this._downX = e.clientX; this._downY = e.clientY; this._downTime = performance.now();
        });

        dom.addEventListener('pointerup', (e) => {
            if (this.transformControls.dragging || app._suppressClick) return;
            const moved = Math.hypot(e.clientX - (this._downX || 0), e.clientY - (this._downY || 0));
            if (moved > 8 || performance.now() - (this._downTime || 0) > 350) return;

            // A selected painting: try placing it wherever was just clicked.
            // If that hits a mount surface, done -- otherwise fall through to
            // ordinary selection, so clicking another painting still selects it.
            if (this.selectedId && this.tryPlaceAtPointer(e.clientX, e.clientY)) {
                app._suppressClick = true;
                setTimeout(() => { app._suppressClick = false; }, 0);
                return;
            }

            const rect = dom.getBoundingClientRect();
            const ndc = new THREE.Vector2(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1
            );
            const ray = new THREE.Raycaster();
            ray.setFromCamera(ndc, app.camera);
            const hitboxes = Array.from(this.records.values()).map((v) => v.mounted.hitbox);
            const hits = ray.intersectObjects(hitboxes, false);
            if (hits.length) {
                const entry = Array.from(this.records.entries()).find(([, v]) => v.mounted.hitbox === hits[0].object);
                if (entry) {
                    this.select(entry[0]);
                    app._suppressClick = true;
                    setTimeout(() => { app._suppressClick = false; }, 0);
                }
            }
        });
    }
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// paintings.js's getAssetUrl-backed loader expects a subpath-safe URL; the
// editor imports it directly to avoid a second small helper for one call.
function getAssetUrlSafe(path) {
    if (!path) return '';
    const base = import.meta.env.BASE_URL || './';
    const cleanPath = path.replace(/^\/+/, '');
    const cleanBase = base.endsWith('/') ? base : `${base}/`;
    return `${cleanBase}${cleanPath}`;
}
