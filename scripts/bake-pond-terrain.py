#!/usr/bin/env python3
"""
Bake the pond out of "Low Poly Tree Scene Free" (3d_Assets/NEW/POND 2 ...zip,
unzipped) into src/scene/pondTerrain.js, and its bank texture into
public/textures/pond_bed.jpg.

Only the pond is taken: the `Ground` mesh's basin and the `Water` plane's
level. The scene's trees (Bark/Leaves) and ~2,700 grass clumps are ignored.

The basin becomes a height grid rather than a mesh, because the garden's own
lawn plane samples groundHeightAt() -- so the lawn, grass, leaves, walking and
painting placement all follow the real basin with no second surface to seam
against. The water is then a flat sheet at the pond's water level; where it
meets the basin is the shoreline.

    python3 scripts/bake-pond-terrain.py <unzipped scene dir>

Output grid is in the pond's LOCAL frame (metres), the same lx/lz frame
groundHeightAt() rotates into by POND_ROT_Y.
"""
import base64, json, sys, os
import numpy as np
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else '.'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCALE = 0.48          # source units -> metres: ~120 m2 of water, like the old pond
RIM = -0.62           # source height of the bank top; becomes lawn level (0)
EXTENT = 11.0         # grid half-size, metres
N = 140               # grid samples per side (~16 cm)
FADE_IN, FADE_OUT = 2.6, 4.6   # metres from open water: full basin -> flat lawn

g = json.load(open(os.path.join(SRC, 'scene.gltf')))
acc, bv = g['accessors'], g['bufferViews']
buf = open(os.path.join(SRC, 'scene.bin'), 'rb').read()


def read(ai):
    a = acc[ai]; v = bv[a['bufferView']]
    o = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    dt = {5126: '<f4', 5125: '<u4', 5123: '<u2'}[a['componentType']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    isz = np.dtype(dt).itemsize; st = v.get('byteStride') or isz * n
    raw = np.frombuffer(buf, dtype=np.uint8, count=st * (a['count'] - 1) + isz * n, offset=o)
    idx = np.arange(a['count'])[:, None] * st + np.arange(isz * n)[None, :]
    return raw[idx].copy().view(dt).reshape(a['count'], n)


def local(n):
    if 'matrix' in n:
        return np.array(n['matrix']).reshape(4, 4).T
    T = np.eye(4); T[:3, 3] = n.get('translation', [0, 0, 0])
    x, y, z, w = n.get('rotation', [0, 0, 0, 1])
    R = np.eye(4)
    R[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                 [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                 [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return T @ R @ np.diag(n.get('scale', [1, 1, 1]) + [1])


parent = {c: p for p, n in enumerate(g['nodes']) for c in n.get('children', [])}


def world_of(name_prefix):
    idx = next(i for i, n in enumerate(g['nodes']) if n.get('name', '').startswith(name_prefix))
    mesh_node = g['nodes'][idx]['children'][0]
    chain, j = [], mesh_node
    while j is not None:
        chain.append(j); j = parent.get(j)
    M = np.eye(4)
    for j in reversed(chain):
        M = M @ local(g['nodes'][j])
    prim = g['meshes'][g['nodes'][mesh_node]['mesh']]['primitives'][0]
    P = read(prim['attributes']['POSITION']).astype(np.float64)
    W = (M @ np.c_[P, np.ones(len(P))].T).T[:, :3]
    I = read(prim['indices']).ravel() if 'indices' in prim else np.arange(len(P))
    return W, I, prim


ground, gI, gprim = world_of('Ground')
water, _, _ = world_of('Water')
WATER = float(water[:, 1].mean())

# Rasterise the ground mesh onto a fine grid in source units.
res = 0.1
xs = np.arange(-26, 26 + res, res); M_ = len(xs)
H = np.full((M_, M_), np.nan)
for t in gI.reshape(-1, 3):
    a, b, c = ground[t]
    i0 = max(int(np.floor((min(a[0], b[0], c[0]) + 26) / res)), 0)
    i1 = min(int(np.ceil((max(a[0], b[0], c[0]) + 26) / res)), M_ - 1)
    j0 = max(int(np.floor((min(a[2], b[2], c[2]) + 26) / res)), 0)
    j1 = min(int(np.ceil((max(a[2], b[2], c[2]) + 26) / res)), M_ - 1)
    gx, gz = np.meshgrid(xs[i0:i1 + 1], xs[j0:j1 + 1], indexing='ij')
    d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if abs(d) < 1e-12:
        continue
    l1 = ((b[2] - c[2]) * (gx - c[0]) + (c[0] - b[0]) * (gz - c[2])) / d
    l2 = ((c[2] - a[2]) * (gx - c[0]) + (a[0] - c[0]) * (gz - c[2])) / d
    l3 = 1 - l1 - l2
    inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
    sub = H[i0:i1 + 1, j0:j1 + 1]
    sub[inside] = (l1 * a[1] + l2 * b[1] + l3 * c[1])[inside]
H = np.nan_to_num(H, nan=RIM)

wet = H < WATER
gx, gz = np.meshgrid(xs, xs, indexing='ij')
cx, cz = gx[wet].mean(), gz[wet].mean()


def sample(sx, sz):
    fx = np.clip((sx + 26) / res, 0, M_ - 1.001); fz = np.clip((sz + 26) / res, 0, M_ - 1.001)
    i, j = fx.astype(int), fz.astype(int); tx, tz = fx - i, fz - j
    return (H[i, j] * (1 - tx) * (1 - tz) + H[i + 1, j] * tx * (1 - tz)
            + H[i, j + 1] * (1 - tx) * tz + H[i + 1, j + 1] * tx * tz)


# Output grid, pond-local metres.
ls = np.linspace(-EXTENT, EXTENT, N)
LX, LZ = np.meshgrid(ls, ls, indexing='ij')
Hs = sample(cx + LX / SCALE, cz + LZ / SCALE)
out = (Hs - RIM) * SCALE

# Fade to flat lawn by distance from open water, so the scene's surrounding
# hillocks don't come along -- only the basin and its banks.
wet_pts = np.c_[LX[Hs < WATER], LZ[Hs < WATER]][::3]
dist = np.full(LX.size, 1e9)
flat = np.c_[LX.ravel(), LZ.ravel()]
for k in range(0, len(wet_pts), 400):
    chunk = wet_pts[k:k + 400]
    dd = np.sqrt(((flat[:, None, :] - chunk[None, :, :]) ** 2).sum(-1)).min(1)
    dist = np.minimum(dist, dd)
dist = dist.reshape(LX.shape)
t = np.clip((dist - FADE_IN) / (FADE_OUT - FADE_IN), 0, 1)
w = 1 - t * t * (3 - 2 * t)
out = out * w
edge = np.maximum(np.abs(LX), np.abs(LZ))
out *= 1 - np.clip((edge - (EXTENT - 0.8)) / 0.8, 0, 1)   # guarantee exactly 0 at the grid border

water_y = (WATER - RIM) * SCALE
mm = np.round(out * 1000).astype('<i2')
b64 = base64.b64encode(mm.tobytes()).decode()

js = f"""// GENERATED by scripts/bake-pond-terrain.py -- do not edit by hand.
//
// The pond basin from "Low Poly Tree Scene Free" by Nicholas-3D (CC-BY-4.0,
// https://sketchfab.com/3d-models/low-poly-tree-scene-free-89daa5e21f0d4f08a59dba0d566e88bd),
// its Ground mesh only, rasterised to a height grid in the pond's local frame
// and scaled x{SCALE}. Heights are int16 millimetres, row-major with x outer.
export const POND_TERRAIN = {{
    n: {N},
    extent: {EXTENT},
    waterY: {water_y:.3f},
    data: '{b64}'
}};
"""
open(os.path.join(ROOT, 'src/scene/pondTerrain.js'), 'w').write(js)

tex_idx = g['materials'][gprim['material']]['pbrMetallicRoughness']['baseColorTexture']['index']
img = g['images'][g['textures'][tex_idx]['source']]['uri']
Image.open(os.path.join(SRC, img)).convert('RGB').save(os.path.join(ROOT, 'public/textures/pond_bed.jpg'), quality=86)

print(f'water level {water_y:.3f} m, deepest {out.min():.3f} m, highest {out.max():.3f} m, '
      f'water cells {(out < water_y).sum()} ({(out < water_y).sum() * (2 * EXTENT / (N - 1)) ** 2:.1f} m2), '
      f'module {len(js) / 1024:.1f} KB')
