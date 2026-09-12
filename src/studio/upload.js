import { el, toast } from './dom.js';
import { createFramed } from './framed.js';
import { createArtworkForm } from './form.js';
import { processImage } from '../cloud/images.js';

/** Section 2: one button to choose a painting, the fields, and a live framed preview. */
export function createUploadSection(container, { onUpload }) {
    let processed = null;
    let previewUrl = null;
    let busy = false;

    const framed = createFramed();
    const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    const chooseBtn = el('button', { type: 'button', class: 'btn primary', text: 'Choose painting' });
    const hint = el('p', { class: 'hint', text: 'or drop an image here — JPEG, PNG, WebP, or straight from your phone’s photos' });
    const changeBtn = el('button', { type: 'button', class: 'btn small', text: 'Choose a different image', hidden: true });
    const drop = el('div', { class: 'drop' }, chooseBtn, hint, changeBtn, fileInput);

    const progress = el('div', { class: 'progress', hidden: true }, el('i'));
    const status = el('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const addBtn = el('button', { type: 'submit', class: 'btn accent', text: 'Add to studio', disabled: true });
    const clearBtn = el('button', { type: 'button', class: 'btn', text: 'Clear', hidden: true });

    const form = createArtworkForm({ onChange: (v) => framed.update({ dimensions: v.dimensions, frame: v.frame }) });
    const formEl = el('form', { class: 'upload-form', novalidate: true },
        form.el,
        el('div', { class: 'form-actions', style: 'margin-top:18px' }, addBtn, clearBtn, status),
        progress);

    container.append(el('div', { class: 'upload' }, drop, formEl));

    const choose = () => { if (!busy) fileInput.click(); };
    chooseBtn.addEventListener('click', choose);
    changeBtn.addEventListener('click', choose);
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) take(fileInput.files[0]); fileInput.value = ''; });

    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
        if (![...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) return;
        e.preventDefault();
        drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
        if (file) take(file);
    });

    async function take(file) {
        status.textContent = 'Preparing image…';
        addBtn.disabled = true;
        try {
            processed = await processImage(file);
        } catch (err) {
            processed = null;
            status.textContent = '';
            toast(err.message || 'Could not read that image.', { error: true, ms: 5000 });
            return;
        }
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(processed.sizes.medium.blob);
        if (!framed.el.isConnected) drop.prepend(framed.el);
        chooseBtn.hidden = true;
        hint.hidden = true;
        changeBtn.hidden = false;
        clearBtn.hidden = false;
        const title = form.getValues().title;
        form.setImageAspect(processed.aspect);
        const v = form.getValues();
        framed.update({ dimensions: v.dimensions, aspect: processed.aspect, frame: v.frame, url: previewUrl, alt: title || 'Chosen painting' });
        if (!title) form.focus();
        status.textContent = `${processed.widthPx} × ${processed.heightPx} px`;
        addBtn.disabled = false;
    }

    function clear() {
        processed = null;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
        framed.el.remove();
        chooseBtn.hidden = false;
        hint.hidden = false;
        changeBtn.hidden = true;
        clearBtn.hidden = true;
        addBtn.disabled = true;
        status.textContent = '';
        form.reset();
    }
    clearBtn.addEventListener('click', clear);

    formEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy || !processed) return;
        const problem = form.validate();
        if (problem) { toast(problem, { error: true }); return; }
        busy = true;
        addBtn.disabled = true;
        progress.hidden = false;
        const bar = progress.firstChild;
        bar.style.width = '0%';
        status.textContent = 'Uploading…';
        try {
            await onUpload(form.getValues(), processed, (f) => { bar.style.width = `${Math.round(f * 100)}%`; });
            toast('Added. Place it in the garden whenever you’re ready.');
            clear();
        } catch (err) {
            console.error(err);
            status.textContent = 'Upload failed.';
            toast(`Upload failed: ${err.message || err}. Your details are kept — try again.`, { error: true, ms: 6000 });
            addBtn.disabled = false;
        } finally {
            busy = false;
            progress.hidden = true;
        }
    });

    return { isBusy: () => busy, hasUnsaved: () => busy || !!processed };
}
