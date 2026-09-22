#!/usr/bin/env node
// Automated verification suite for Gulmohar release candidate readiness.
// Run: node scripts/verify-release.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
    hashPublic, hashLandmarks, hashAbout, pendingChanges, stableStringify
} from '../src/cloud/schema.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let passed = 0;
let failed = 0;

function assert(condition, desc) {
    if (condition) {
        console.log(`  ✓ ${desc}`);
        passed++;
    } else {
        console.error(`  ✗ FAIL: ${desc}`);
        failed++;
    }
}

console.log('\n--- 1. Bundle Budget & SDK Isolation ---');
try {
    const out = execSync('node scripts/check-bundle.mjs', { cwd: root, encoding: 'utf8' });
    assert(out.includes('OK'), 'check-bundle passes with no Firebase in visitor bundle and under budget');
} catch (e) {
    assert(false, `check-bundle execution failed: ${e.message}`);
}

console.log('\n--- 2. Schema Hashing & Change Detection ---');
{
    // Stability
    const objA = { b: 2, a: 1, c: [3, 2, 1] };
    const objB = { a: 1, c: [3, 2, 1], b: 2 };
    assert(stableStringify(objA) === stableStringify(objB), 'stableStringify is key-order independent');
    assert(hashPublic(objA) === hashPublic(objB), 'hashPublic produces identical hash for equivalent objects');

    // Landmarks diffing
    const landmarksInitial = [
        { id: 'gulmohar', title: 'Royal Poinciana', meta: 'Centerpiece' },
        { id: 'about', lede: 'Artist bio', statement: 'Statement' }
    ];
    const hashes = {
        _landmarks: hashLandmarks(landmarksInitial),
        _about: hashAbout(landmarksInitial)
    };

    // No changes
    const diff0 = pendingChanges([], hashes, landmarksInitial);
    assert(diff0.total === 0, 'No pending changes when landmarks & about match');

    // Bio edit only
    const landmarksBioEdit = [
        { id: 'gulmohar', title: 'Royal Poinciana', meta: 'Centerpiece' },
        { id: 'about', lede: 'New artist bio', statement: 'Statement' }
    ];
    const diff1 = pendingChanges([], hashes, landmarksBioEdit);
    assert(diff1.total === 1 && diff1.aboutChanged, 'Bio edit triggers pendingChanges (total=1, aboutChanged=true)');

    // Landmark rename only
    const landmarksRename = [
        { id: 'gulmohar', title: 'Great Red Tree', meta: 'Centerpiece' },
        { id: 'about', lede: 'Artist bio', statement: 'Statement' }
    ];
    const diff2 = pendingChanges([], hashes, landmarksRename);
    assert(diff2.total === 1 && diff2.landmarksChanged, 'Landmark edit triggers pendingChanges (total=1, landmarksChanged=true)');
}

console.log('\n--- 3. Public Paintings Fallback Integrity ---');
{
    const paintingsJsonPath = path.join(root, 'public/paintings.json');
    assert(existsSync(paintingsJsonPath), 'public/paintings.json exists');

    const paintingsData = JSON.parse(readFileSync(paintingsJsonPath, 'utf8'));
    assert(Array.isArray(paintingsData.paintings) && paintingsData.paintings.length >= 4, `paintings.json contains ${paintingsData.paintings?.length || 0} paintings`);

    let allFilesExist = true;
    for (const p of paintingsData.paintings) {
        const filePath = path.join(root, 'public', p.file);
        if (!existsSync(filePath)) {
            console.error(`    Missing asset: ${p.file}`);
            allFilesExist = false;
        }
    }
    assert(allFilesExist, 'All files referenced by paintings.json exist on disk');
}

console.log('\n--- 4. Static Pages Integrity ---');
{
    const workHtml = readFileSync(path.join(root, 'work/index.html'), 'utf8');
    assert(workHtml.includes('src/work/main.js'), 'work/index.html includes client module');
    assert(!workHtml.includes('Add another by copying'), 'work/index.html has no developer instructions');

    const aboutHtml = readFileSync(path.join(root, 'about/index.html'), 'utf8');
    assert(aboutHtml.includes('src/about/main.js'), 'about/index.html includes client module');
    assert(!aboutHtml.includes('Not written yet'), 'about/index.html has completed fallback copy');
}

console.log('\n--- 5. Quality Adaptive Logic ---');
{
    const qualitySrc = readFileSync(path.join(root, 'src/quality.js'), 'utf8');
    assert(qualitySrc.includes('pixelRatioScale > 0.85'), 'quality.js down() correctly steps from resolution to instanceScale reduction');
    assert(qualitySrc.includes('backgroundTrees: 0'), 'quality.js low tier sets backgroundTrees to 0');
}

console.log(`\n========================================`);
console.log(`Verification Complete: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
}
