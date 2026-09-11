// Simplify selected meshes inside an already-optimised garden .glb, in place,
// keeping every other mesh, every node name and the meshopt compression.
//
// Used for two over-dense pieces found by counting what a frame actually draws:
//   * floor_leaves.glb  s_list_*  -- fallen leaves ~1,300 triangles each for
//     something 35cm across lying flat; 360 of them were 456k triangles, more
//     than the whole gulmohar.
//   * gulmohar.glb      stalk     -- the leaf rachis stems, 189k triangles of
//     thin tubes that are a few pixels wide at any normal viewing distance.
//
//   npx --yes @gltf-transform/cli --version   # populates npx's cache once
//   GT=$(dirname $(dirname $(ls -d ~/.npm/_npx/*/node_modules/@gltf-transform/core | head -1)))
//   NODE_PATH=$GT node scripts/simplify-meshes.mjs <in.glb> <out.glb> '<mesh-name regex>' <ratio> <error>
//
// e.g.  ... public/models/floor_leaves.glb public/models/floor_leaves.glb '^s_list_' 0.12 0.02
//       ... public/models/gulmohar.glb     public/models/gulmohar.glb     'stalk'    0.35 0.0015
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), 'x.js'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { simplifyPrimitive } = require('@gltf-transform/functions');
const { MeshoptSimplifier, MeshoptDecoder, MeshoptEncoder } = require('meshoptimizer');

const [input, output, pattern, ratioArg, errorArg] = process.argv.slice(2);
const match = new RegExp(pattern, 'i');
const ratio = Number(ratioArg), error = Number(errorArg);

await MeshoptSimplifier.ready;
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder
});
const doc = await io.read(input);

const tris = (prim) => (prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount()) / 3;
let before = 0, after = 0;
for (const mesh of doc.getRoot().listMeshes()) {
    if (!match.test(mesh.getName())) continue;
    for (const prim of mesh.listPrimitives()) {
        const b = tris(prim);
        simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error });
        before += b; after += tris(prim);
        console.log(`${mesh.getName()}: ${b} -> ${tris(prim)} triangles`);
    }
}
console.log(`total ${before} -> ${after} (${(100 * after / Math.max(before, 1)).toFixed(1)}%)`);
await io.write(output, doc);
