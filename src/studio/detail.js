import { el, toast } from './dom.js';
import { createFramed } from './framed.js';
import { createArtworkForm } from './form.js';
import { processImage } from '../cloud/images.js';

/** Edit dialog: the same fields as upload, plus Replace image. */
export function openEditDialog(artwork, { imageUrl, onSave, onReplaceImage }) {
    const framed = createFramed();
    let pendingImage = null;
    let previewUrl = null;

    const form = createArtworkForm({
        values: { ...artwork, imageAspect: artwork.images && artwork.images.aspect },
        onChange: (v) => framed.update({ dimensions: v.dimensions, frame: v.frame })
    });
    const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    const replaceBtn = el('button', { type: 'button', class: 'btn small', text: 'Replace image' });
    const progress = el('div', { class: 'progress', hidden: true }, el('i'));
    const saveBtn = el('button', { type: 'submit', class: 'btn primary', text: 'Save changes' });

    const dlg = el('dialog', { class: 'panel', 'aria-label': `Edit ${artwork.title || 'painting'}` },
        el('form', { method: 'dialog', class: 'inner', novalidate: true },
            el('h3', { text: 'Edit painting' }),
            el('div', { class: 'upload' },
                el('div', { class: 'drop' }, framed.el, replaceBtn, fileInput, progress),
                form.el),
            el('div', { class: 'bottom' },
                el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
                saveBtn)));

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
        try {
            await onSave(form.getValues());
            if (pendingImage) {
                progress.hidden = false;
                await onReplaceImage(pendingImage, (f) => { progress.firstChild.style.width = `${Math.round(f * 100)}%`; });
            }
            toast('Saved.');
            dlg.close();
        } catch (err) {
            console.error(err);
            toast(`Couldn’t save: ${err.message || err}`, { error: true, ms: 6000 });
            saveBtn.disabled = false;
            progress.hidden = true;
        }
    });

    dlg.addEventListener('close', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
}
