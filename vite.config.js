import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const page = (name) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
    base: './',
    // Three real pages, not one app that routes in the browser. Vite's default
    // 'spa' mode answers every unmatched path with index.html, so /work/ and
    // /about/ would silently serve the 3D scene in dev while working in
    // production -- the worst kind of difference. 'mpa' turns that fallback off.
    appType: 'mpa',
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
                entryFileNames: 'assets/[name].js',
                chunkFileNames: 'assets/[name].js',
                assetFileNames: 'assets/[name].[ext]'
            }
        }
    }
});
