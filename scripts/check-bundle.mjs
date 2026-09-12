#!/usr/bin/env node
// Guards the one constraint the Studio's design depends on: visitors never
// download the Firebase SDK. cloud/config.js and cloud/schema.js are meant
// to be safe for the visitor bundle (see their own header comments) because
// nothing in them imports the `firebase` package; everything that DOES
// (firebaseBackend.js) is only ever reached via a dynamic import from
// cloud/backend.js, which paintings.js/main.js never call directly.
//
// A future edit could break that by accident -- e.g. importing
// firebaseBackend.js directly instead of through getBackend(), or pulling a
// helper into schema.js that happens to import `firebase/app`. This would
// pass every other check (the site would even work, slower and heavier for
// every visitor) and be very easy not to notice, so it's a build gate
// instead of a comment asking someone to remember.
//
// Run after `npm run build`:  node scripts/check-bundle.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, 'dist/assets/main.js');

if (!existsSync(target)) {
    console.error(`[check-bundle] ${path.relative(root, target)} not found -- run "npm run build" first.`);
    process.exit(1);
}

const src = readFileSync(target, 'utf8');
const sizeKB = Buffer.byteLength(src, 'utf8') / 1024;

// Substrings that only appear if actual Firebase SDK source made it in --
// not just the word "firebase" (which the sun/moon/garden comments already
// say plenty, e.g. "firebase console", so that alone would false-positive).
const FIREBASE_MARKERS = [
    'firebase.google.com/terms/tou',       // the SDK's own embedded license banner
    'FIRESTORE (',                          // Firestore's internal build-tag string
    '@firebase/app',
    '@firebase/firestore',
    '@firebase/storage',
    '@firebase/auth',
    'FirebaseError',
    'registerFirestore',
    'PersistentLocalCache'
];
const found = FIREBASE_MARKERS.filter((m) => src.includes(m));

// A budget, not a promise of "never grows" -- three.js/gsap updates and real
// visitor-side features (like the gallery.json loader this now includes)
// legitimately move this. Baselined after that loader landed; bump it
// deliberately in the same commit as whatever earns the extra size, with a
// one-line note of why, rather than letting this check silently ratchet up
// forever unnoticed.
const BASELINE_KB = 876; // measured after the gallery.json cloud loader landed in paintings.js
const BUDGET_KB = BASELINE_KB + 3;

let failed = false;
if (found.length) {
    console.error(`[check-bundle] main.js contains Firebase SDK code: ${found.join(', ')}`);
    console.error('[check-bundle] Something the visitor path imports (directly or transitively) now pulls in `firebase`.');
    console.error('[check-bundle] Check for a new import reaching firebaseBackend.js outside cloud/backend.js\'s getBackend().');
    failed = true;
}
if (sizeKB > BUDGET_KB) {
    console.error(`[check-bundle] main.js is ${sizeKB.toFixed(1)} KB, over the ${BUDGET_KB} KB budget (baseline ${BASELINE_KB} KB + 3 KB slack).`);
    console.error('[check-bundle] If this growth is real and expected, raise BASELINE_KB in this file with a one-line reason.');
    failed = true;
}

if (failed) process.exit(1);
console.log(`[check-bundle] OK -- main.js ${sizeKB.toFixed(1)} KB, no Firebase SDK markers found.`);
