// Build public/models/grass_blades.glb from 3d_Assets/NEW/realistics_grass_06.glb.
//
//  1. Spec-gloss -> metal-rough. Three dropped KHR_materials_pbrSpecularGlossiness,
//     so left as is the blades load untextured.
//  2. Bleed the blade colour into the texture's transparent pixels. They are
//     white in the source, and every mip level averages them into the blade:
//     past ~10m the lawn turned frosted white. With the transparent texels
//     holding the blade's own average colour, mips stay green.
//  3. Prune what the conversion leaves unused.
//
//   npx --yes @gltf-transform/cli --version   # populates npx's cache once
//   GT=$(dirname $(dirname $(ls -d ~/.npm/_npx/*/node_modules/@gltf-transform/core | head -1)))
//   NODE_PATH=$GT node scripts/prepare-grass-blades.mjs <in.glb> <out.glb>
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), 'x.js'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { metalRough, prune } = require('@gltf-transform/functions');
const sharp = require('sharp');

const [input, output] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
await doc.transform(metalRough());

for (const mat of doc.getRoot().listMaterials()) {
    const tex = mat.getBaseColorTexture();
    if (!tex) continue;
    const { data, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 200) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    }
    const avg = [r / n, g / n, b / n].map(Math.round);
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        // Blend toward the average by transparency, so edge texels soften
        // into it rather than stepping.
        for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * a + avg[c] * (1 - a));
    }
    const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    tex.setImage(new Uint8Array(png)).setMimeType('image/png');
    console.log(`bled ${mat.getName()} base colour: blade average rgb(${avg.join(', ')}) from ${n} opaque texels`);
}
await doc.transform(prune());
await io.write(output, doc);
