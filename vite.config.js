import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const release = process.env.GITHUB_SHA || String(Date.now());

const page = (name) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
    base: './',
    define: { __APP_VERSION__: JSON.stringify(release) },
    plugins: [{ name: 'release-version', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: release }) }); } }],
    // Three real pages, not one app that routes in the browser. Vite's default
    // 'spa' mode answers every unmatched path with index.html, so /work/ and
    // /about/ would silently serve the 3D scene in dev while working in
    // production -- the worst kind of difference. 'mpa' turns that fallback off.
    appType: 'mpa',
    server: {
        proxy: {
            '/firebasestorage-proxy': {
                target: 'https://firebasestorage.googleapis.com',
                changeOrigin: true,
                followRedirects: true,
                rewrite: (path) => path.replace(/^\/firebasestorage-proxy/, '')
            }
        }
    },
    build: {
        rollupOptions: {
            // Three real entry points. Without listing them, only index.html is
            // built and /work/ and /about/ vanish from the output.
            input: {
                main: page('index.html'),
                work: page('work/index.html'),
                about: page('about/index.html'),
                studio: page('studio/index.html')
            },
            output: {
                entryFileNames: 'assets/[name]-[hash].js',
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash].[ext]'
            }
        }
    }
});
