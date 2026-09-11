// Pull the wild-meadow grass clumps out of 3d_Assets/Floor/simple_grass_chunks
// (scene.gltf) into public/models/meadow_clumps.glb.
//
// Kept: rostlinka_07c (the meadow-grass clump cards) and r12_a/b/c (small
// leafy plants). Dropped: the 52k-triangle grass ground chunk, the 18k
// "Forest001" scatter, the pre-scattered copies and the 4K ground scan -- the
// garden instances the clumps itself. Node transforms are baked into the
// vertices (createGrassField reads raw geometry, not the node tree) and the
// 4096 textures come down to 1024.
//
// gltf-transform isn't a project dependency; run it through npx's cache:
//   npx --yes @gltf-transform/cli --version   # populates the cache once
//   GT=$(dirname $(dirname $(ls -d ~/.npm/_npx/*/node_modules/@gltf-transform/core | head -1)))
//   NODE_PATH=$GT node scripts/extract-meadow-clumps.mjs <in.gltf> <out.glb>
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), 'x.js'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { flatten, clearNodeTransform, prune, dedup, textureCompress, metalRough } = require('@gltf-transform/functions');
const sharp = require('sharp');

const [input, output] = process.argv.slice(2);
const KEEP = /^(rostlinka_07c_rostlinka_07c_0|r12_[abc]_rostlinka12_2k_0)$/;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();

// The source is spec-gloss (KHR_materials_pbrSpecularGlossiness), which
// Three dropped: left as is, every clump loads untextured.
await doc.transform(metalRough(), flatten());
for (const node of root.listNodes()) {
    if (node.getMesh() && !KEEP.test(node.getName())) node.dispose();
}
for (const node of root.listNodes()) {
    if (node.getMesh()) clearNodeTransform(node);
}
await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, resize: [1024, 1024] })
);
// Occlusion maps are baked for the source's own ground chunk; on a lone
// instanced clump they only darken it arbitrarily. Normal maps on thin
// alpha cards a few pixels wide buy nothing visible and cost as much VRAM
// as the colour itself (32 MB -> ~7 MB with both gone).
for (const mat of root.listMaterials()) {
    mat.setOcclusionTexture(null);
    mat.setNormalTexture(null);
}
await doc.transform(prune());
// The r12 plants are ~8 cm across; 512 is already more texels than pixels.
await doc.transform(textureCompress({ encoder: sharp, resize: [512, 512], pattern: /rostlinka12/ }));

for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const pos = mesh.listPrimitives()[0].getAttribute('POSITION');
    console.log(node.getName(), 'verts', pos.getCount(), 'min', pos.getMin([]).map((v) => v.toFixed(3)), 'max', pos.getMax([]).map((v) => v.toFixed(3)));
}
await io.write(output, doc);
