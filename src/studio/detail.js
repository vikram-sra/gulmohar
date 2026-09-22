import { el, toast } from './dom.js';
import { createFramed } from './framed.js';
import { createArtworkForm } from './form.js';
import { processImage } from '../cloud/images.js';

/** Edit dialog: the same fields as upload, plus Replace image and Delete. */
export function openEditDialog(artwork, { imageUrl, onSave, onReplaceImage, onDelete, onUnplace }) {
    const framed = createFramed();
    let pendingImage = null;
    let previewUrl = null;
    let isExpanded = false;

    const form = createArtworkForm({
        values: { ...artwork, imageAspect: artwork.images && artwork.images.aspect },
        onChange: (v) => framed.update({ dimensions: v.dimensions, frame: v.frame })
    });
    const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    const replaceBtn = el('button', { type: 'button', class: 'btn small', text: 'Replace image' });
    const progress = el('div', { class: 'progress', hidden: true }, el('i'));
    const saveBtn = el('button', { type: 'submit', class: 'btn primary', text: 'Save changes' });

    const deleteBtn = onDelete ? el('button', { type: 'button', class: 'btn danger', text: 'Delete painting' }) : null;
    const unplaceBtn = (onUnplace && artwork.placement && artwork.placement.placed)
        ? el('button', { type: 'button', class: 'btn', text: 'Remove from garden' })
        : null;

    const expandBtn = el('button', {
        type: 'button', class: 'btn small modal-tool-btn', 'aria-label': 'Expand modal', title: 'Toggle expanded view'
    }, el('span', { class: 'expand-icon', text: '⤢' }), el('span', { class: 'expand-text', text: 'Expand' }));

    const closeBtn = el('button', {
        type: 'button', class: 'icon-btn modal-close-btn', 'aria-label': 'Close dialog', text: '✕'
    });

    const modalHead = el('div', { class: 'modal-head' },
        el('h3', { text: `Edit “${artwork.title || 'painting'}”` }),
        el('div', { class: 'modal-tools' }, expandBtn, closeBtn));

    const dlg = el('dialog', { class: 'panel edit-modal', 'aria-label': `Edit ${artwork.title || 'painting'}` },
        el('form', { method: 'dialog', class: 'inner', novalidate: true },
            modalHead,
            el('div', { class: 'upload' },
                el('div', { class: 'drop' }, framed.el, replaceBtn, fileInput, progress),
                form.el),
            el('div', { class: 'bottom' },
                el('div', { class: 'left-actions', style: 'display:flex;gap:8px;align-items:center;' }, deleteBtn, unplaceBtn),
                el('div', { class: 'right-actions' },
                    el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
                    saveBtn))));

    expandBtn.addEventListener('click', () => {
        isExpanded = !isExpanded;
        dlg.classList.toggle('expanded', isExpanded);
        expandBtn.querySelector('.expand-icon').textContent = isExpanded ? '⤡' : '⤢';
        expandBtn.querySelector('.expand-text').textContent = isExpanded ? 'Compact' : 'Expand';
    });
    closeBtn.addEventListener('click', () => dlg.close());

    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            const ok = await onDelete(artwork);
            if (ok) dlg.close();
        });
    }

    if (unplaceBtn) {
        unplaceBtn.addEventListener('click', async () => {
            if (!window.confirm('Remove this painting from the garden?')) return;
            unplaceBtn.disabled = true;
            unplaceBtn.textContent = 'Removing…';
            try {
                await onUnplace(artwork);
                dlg.close();
            } catch (err) {
                console.error(err);
                toast(`Couldn’t remove: ${err.message || err}`, { error: true });
                unplaceBtn.disabled = false;
                unplaceBtn.textContent = 'Remove from garden';
            }
        });
    }

    const v0 = form.getValues();
    framed.update({ dimensions: v0.dimensions, aspect: artwork.images && artwork.images.aspect, frame: v0.frame, url: null, alt: artwork.title });
    imageUrl(artwork.images && (artwork.images.medium || artwork.images.thumb)).then((url) => { if (!pendingImage) framed.update({ url }); });

    replaceBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        try {
            pendingImage = await processImage(file);
        } catch (err) {
            toast(err.message, { error: true, ms: 5000 });
            return;
        }
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(pendingImage.sizes.medium.blob);
        form.setImageAspect(pendingImage.aspect);
        const v = form.getValues();
        framed.update({ dimensions: v.dimensions, aspect: pendingImage.aspect, frame: v.frame, url: previewUrl });
        replaceBtn.textContent = 'New image chosen — choose another';
    });

    dlg.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const problem = form.validate();
        if (problem) { toast(problem, { error: true }); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            await onSave(form.getValues());
            if (pendingImage) {
                progress.hidden = false;
                saveBtn.textContent = 'Uploading…';
                await onReplaceImage(pendingImage, (f) => {
                    const pct = Math.round(f * 100);
                    progress.firstChild.style.width = `${pct}%`;
                    saveBtn.textContent = `Uploading ${pct}%…`;
                });
            }
            toast('Saved.');
            dlg.close();
        } catch (err) {
            console.error(err);
            toast(`Couldn’t save: ${err.message || err}`, { error: true, ms: 6000 });
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save changes';
            progress.hidden = true;
        }
    });

    dlg.addEventListener('close', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
}
