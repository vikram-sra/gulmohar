// Hashed bundles invalidate HTTP caches; check open tabs on return as well.
// Never clear Firebase auth or IndexedDB: those contain sign-in and pending edits.
if (import.meta.env.PROD) {
    const script = document.querySelector('script[type="module"][src]');
    const root = new URL('../', script?.src || import.meta.url);
    let checking = false;
    async function checkVersion() {
        if (checking || document.hidden || document.querySelector('.version-notice')) return;
        checking = true;
        try {
            const response = await fetch(new URL('version.json', root), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
            if (!response.ok) return;
            const { version } = await response.json();
            if (!version || version === __APP_VERSION__) return;
            const notice = document.createElement('aside');
            notice.className = 'version-notice';
            notice.setAttribute('role', 'status');
            notice.append('A new version is ready. Save any edits, then ');
            const refresh = document.createElement('button');
            refresh.textContent = 'Refresh';
            refresh.onclick = () => {
                const url = new URL(location.href);
                url.searchParams.set('v', version);
                location.replace(url);
            };
            notice.append(refresh);
            document.body.append(notice);
        } catch { /* An offline visit remains usable. */ }
        finally { checking = false; }
    }
    checkVersion();
    document.addEventListener('visibilitychange', checkVersion);
    setInterval(checkVersion, 120000);
}
