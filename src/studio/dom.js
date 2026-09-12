export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

let toastTimer = null;
export function toast(message, { error = false, ms = 3200 } = {}) {
    let t = document.getElementById('toast');
    if (!t) {
        t = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
        document.body.append(t);
    }
    t.textContent = message;
    t.classList.toggle('error', error);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
        const dlg = el('dialog', { class: 'panel narrow' },
            el('form', { method: 'dialog', class: 'inner' },
                el('h3', { text: title }),
                typeof body === 'string' ? el('p', { text: body, style: 'color:var(--muted)' }) : body,
                el('div', { class: 'bottom' },
                    el('button', { class: 'btn', value: 'cancel', text: 'Cancel' }),
                    el('button', { class: `btn ${danger ? 'accent' : 'primary'}`, value: 'ok', text: confirm, autofocus: true }))));
        dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
        document.body.append(dlg);
        dlg.showModal();
    });
}

export function formatDims(dimensions) {
    if (!dimensions || !dimensions.width || !dimensions.height) return '';
    const n = (v) => (Math.round(v * 10) / 10).toString();
    return `${n(dimensions.width)} × ${n(dimensions.height)} ${dimensions.unit === 'cm' ? 'cm' : 'in'}`;
}
