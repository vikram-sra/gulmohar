import './paintingBrowser.css';
import { getAssetUrl } from '../utils/paths.js';
import { rememberGardenView } from './gardenView.js';

/** Compact access to the paintings, independent of walking controls. */
export function attachPaintingBrowser(app) {
    const entries = [...app.paintings.values()].map(m => m.interactive.data);
    if (!entries.length) {
        const link = document.createElement('a');
        link.className = 'painting-browser painting-browser-trigger';
        link.href = './work/';
        link.textContent = 'View paintings ↗';
        document.body.append(link);
        return;
    }
    const nav = document.createElement('nav');
    nav.className = 'painting-browser';
    nav.setAttribute('aria-label', 'Browse paintings');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'painting-browser-trigger';
    trigger.setAttribute('popovertarget', 'painting-browser-panel');
    trigger.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="15" cy="8" r="1"/></svg><span>Paintings</span><span class="painting-browser-count">${entries.length}</span>`;
    const panel = document.createElement('div');
    panel.id = 'painting-browser-panel';
    panel.className = 'painting-browser-panel';
    panel.setAttribute('popover', 'auto');
    const heading = document.createElement('p');
    heading.className = 'painting-browser-heading';
    heading.textContent = 'Explore the garden';
    const controls = document.createElement('div');
    controls.className = 'painting-browser-controls';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Choose a painting');
    select.add(new Option(`Explore ${entries.length} paintings`, ''));
    entries.forEach((entry, index) => select.add(new Option(`${index + 1}. ${entry.title || 'Untitled'}`, entry.id)));
    app._onPaintingFocused = id => {
        select.value = id || '';
        if (app._paintingViewButton) app._paintingViewButton.disabled = !id;
        const url = new URL(location.href);
        url.searchParams.delete('restore');
        if (id) url.searchParams.set('painting', id);
        else url.searchParams.delete('painting');
        history.replaceState(null, '', url);
    };
    const visit = id => {
        const data = entries.find(entry => entry.id === id);
        if (data) app.focusTarget(data);
    };
    const step = delta => {
        const index = entries.findIndex(entry => entry.id === select.value);
        visit(entries[index < 0 ? (delta > 0 ? 0 : entries.length - 1) : (index + delta + entries.length) % entries.length].id);
    };
    const button = (label, text, delta) => {
        const node = document.createElement('button');
        node.type = 'button'; node.textContent = text; node.setAttribute('aria-label', label);
        node.addEventListener('click', () => step(delta));
        return node;
    };
    select.addEventListener('change', () => visit(select.value));
    let viewerPromise;
    let pausedControls;
    const view = document.createElement('button');
    view.type = 'button'; view.textContent = 'View painting'; view.className = 'painting-view-button';
    view.disabled = true;
    view.addEventListener('click', async () => {
        const id = select.value;
        if (!id) return;
        panel.hidePopover();
        viewerPromise ||= import('../gallery/artworkViewer.js').then(({ createArtworkViewer }) => createArtworkViewer({
            items: [...app.paintings.values()].map(m => m.group.userData.placement),
            imageUrl: item => getAssetUrl(item.file),
            onOpen: () => {
                pausedControls = { enabled: app.controls.enabled, autoRotate: app.controls.autoRotate, walking: app.fpsNavigator.enabled };
                app.controls.enabled = app.controls.autoRotate = false;
                app.fpsNavigator.disable();
            },
            onSelect: item => {
                select.value = item.id;
                app.focusTarget(entries.find(entry => entry.id === item.id));
                app.controls.enabled = false;
            },
            onClose: () => {
                app.controls.enabled = app.navMode === 'orbit';
                app.controls.autoRotate = pausedControls.autoRotate;
                const data = entries.find(entry => entry.id === select.value);
                if (data) app.showLabelFor(data);
                if (app.navMode === 'walk') app.fpsNavigator.enableFromCamera();
            }
        }));
        (await viewerPromise).open(id);
    });
    const catalogue = document.createElement('a');
    catalogue.href = './work/'; catalogue.textContent = 'View collection';
    controls.append(button('Previous painting', '←', -1), select, button('Next painting', '→', 1));
    const actions = document.createElement('div');
    actions.className = 'painting-browser-actions';
    actions.append(view, catalogue);
    panel.append(heading, controls, actions);
    nav.append(trigger, panel);
    app._paintingViewButton = view;
    const saveView = () => rememberGardenView(app);
    window.addEventListener('pagehide', saveView);
    document.addEventListener('click', e => { if (e.target.closest?.('a[href]')) saveView(); }, true);
    ['pointerdown', 'pointerup', 'click', 'wheel'].forEach(event => nav.addEventListener(event, e => e.stopPropagation()));
    document.body.append(nav);
    app._paintingSelect = select;
}
