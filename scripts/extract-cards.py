#!/usr/bin/env python3
"""
Pull a handful of unique meshes out of a large glTF and write a minimal GLB
containing only those meshes, their materials and their textures.

Vegetation assets routinely ship one usable card duplicated hundreds of times:
realtime_grass.glb is 2,013 meshes / 4,029 nodes but only 7 unique geometries,
and 5.70 MB of that is duplicate data plus a demo ground plane we never draw.
Extracting the uniques makes the download honest and lets us instance them
ourselves with the garden's own scatter rules.

  python3 scripts/extract-cards.py IN.glb OUT.glb --meshes 0 1 2 3 4 5
  python3 scripts/extract-cards.py IN.glb OUT.glb --materials 0 2 --per-material 3

Reads only; never modifies the source.
"""
import argparse, json, struct, pathlib

TEX_SLOTS = ["baseColorTexture", "metallicRoughnessTexture", "normalTexture",
             "occlusionTexture", "emissiveTexture"]


def read_glb(path):
    raw = pathlib.Path(path).read_bytes()
    if raw[:4] != b'glTF':
        raise SystemExit(f"{path} is not a binary GLB")
    off, js, bin_ = 12, None, b''
    while off < len(raw):
        ln, ty = struct.unpack_from('<II', raw, off); off += 8
        chunk = raw[off:off + ln]
        if ty == 0x4E4F534A: js = json.loads(chunk)
        elif ty == 0x004E4942: bin_ = chunk
        off += ln
    return js, bin_


def mesh_tris(g, mesh):
    n = 0
    for pr in mesh["primitives"]:
        acc = pr["indices"] if "indices" in pr else pr["attributes"]["POSITION"]
        n += g["accessors"][acc]["count"] // 3
    return n


def extract(src, dst, keep):
    g, bin_ = read_glb(src)
    new_bv, bv_map, blob = [], {}, bytearray()
    new_acc, acc_map = [], {}
    new_img, img_map = [], {}
    new_tex, tex_map = [], {}
    new_mat, mat_map = [], {}

    def add_bv(i):
        if i in bv_map: return bv_map[i]
        bv = g["bufferViews"][i]
        start, length = bv.get("byteOffset", 0), bv["byteLength"]
        while len(blob) % 4: blob.append(0)
        nb = {"buffer": 0, "byteOffset": len(blob), "byteLength": length}
        for k in ("byteStride", "target"):
            if k in bv: nb[k] = bv[k]
        blob.extend(bin_[start:start + length])
        bv_map[i] = len(new_bv); new_bv.append(nb); return bv_map[i]

    def add_acc(i):
        if i in acc_map: return acc_map[i]
        a = dict(g["accessors"][i])
        if "bufferView" in a: a["bufferView"] = add_bv(a["bufferView"])
        acc_map[i] = len(new_acc); new_acc.append(a); return acc_map[i]

    def add_img(i):
        if i in img_map: return img_map[i]
        im = dict(g["images"][i])
        if "bufferView" in im: im["bufferView"] = add_bv(im["bufferView"])
        img_map[i] = len(new_img); new_img.append(im); return img_map[i]

    def add_tex(i):
        if i in tex_map: return tex_map[i]
        t = dict(g["textures"][i])
        if "source" in t: t["source"] = add_img(t["source"])
        tex_map[i] = len(new_tex); new_tex.append(t); return tex_map[i]

    def add_mat(i):
        if i in mat_map: return mat_map[i]
        m = json.loads(json.dumps(g["materials"][i]))
        pbr = m.get("pbrMetallicRoughness", {})
        for slot in TEX_SLOTS:
            for holder in (pbr, m):
                if isinstance(holder.get(slot), dict) and "index" in holder[slot]:
                    holder[slot]["index"] = add_tex(holder[slot]["index"])
        mat_map[i] = len(new_mat); new_mat.append(m); return mat_map[i]

    meshes, nodes = [], []
    for mi in keep:
        mesh = g["meshes"][mi]
        prims = []
        for pr in mesh["primitives"]:
            np_ = {"attributes": {k: add_acc(v) for k, v in pr["attributes"].items()},
                   "mode": pr.get("mode", 4)}
            if "indices" in pr: np_["indices"] = add_acc(pr["indices"])
            if "material" in pr: np_["material"] = add_mat(pr["material"])
            prims.append(np_)
        name = mesh.get("name", f"card{mi}")
        meshes.append({"name": name, "primitives": prims})
        nodes.append({"name": name, "mesh": len(meshes) - 1})

    doc = {"asset": {"version": "2.0", "generator": "gulmohar extract-cards"},
           "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
           "nodes": nodes, "meshes": meshes, "materials": new_mat,
           "textures": new_tex, "images": new_img,
           "samplers": g.get("samplers", []),
           "accessors": new_acc, "bufferViews": new_bv,
           "buffers": [{"byteLength": len(blob)}]}
    for k in ("materials", "textures", "images", "samplers"):
        if not doc[k]: del doc[k]

    jb = json.dumps(doc, separators=(',', ':')).encode()
    while len(jb) % 4: jb += b' '
    while len(blob) % 4: blob.append(0)
    glb = (b'glTF' + struct.pack('<II', 2, 12 + 8 + len(jb) + 8 + len(blob))
           + struct.pack('<II', len(jb), 0x4E4F534A) + jb
           + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))
    pathlib.Path(dst).write_bytes(glb)
    return g, len(glb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--meshes", type=int, nargs="*", default=None)
    ap.add_argument("--materials", type=int, nargs="*", default=None)
    ap.add_argument("--per-material", type=int, default=3)
    ap.add_argument("--max-tris", type=int, default=10 ** 9)
    a = ap.parse_args()

    g, _ = read_glb(a.src)
    if a.meshes is not None:
        keep = a.meshes
    else:
        wanted, keep = set(a.materials or []), []
        seen = {}
        for i, mesh in enumerate(g["meshes"]):
            mats = {pr.get("material") for pr in mesh["primitives"]}
            if not (mats & wanted): continue
            if mesh_tris(g, mesh) > a.max_tris: continue
            key = tuple(sorted(m for m in mats if m is not None))
            if seen.get(key, 0) >= a.per_material: continue
            seen[key] = seen.get(key, 0) + 1
            keep.append(i)

    g2, size = extract(a.src, a.dst, keep)
    tris = sum(mesh_tris(g, g["meshes"][i]) for i in keep)
    print(f"{a.src} -> {a.dst}")
    print(f"  kept {len(keep)} meshes, {tris:,} tris, {size/1024:.0f} KB")
    for i in keep:
        print(f"    mesh[{i}] {str(g['meshes'][i].get('name'))[:44]:44s} {mesh_tris(g, g['meshes'][i]):6,} tris")


if __name__ == "__main__":
    main()
