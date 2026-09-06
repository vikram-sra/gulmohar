# Gulmohar

An interactive botanical garden — a Royal Poinciana (gulmohar) at the centre,
a pond with a waterfall and a Japanese maple in two corners, a gazebo in the
third, and a winding path connecting them — under an astronomically driven
sky, plus two flat pages: a work list and an artist bio.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
```

## Layout

```
index.html            3D scene: HUD, permanent nav, loader, dock styles
main.js               GulmoharApp — renderer, lights, ground, dock, render loop
src/
  content.js          site name, tagline, optional Instagram/email
  scene/garden.js      loads the four landmark GLBs, scatters ground litter,
                        builds the path loop, registers click-to-focus targets
  sky/celestial.js     sun/moon ephemeris, sky dome, stars, Milky Way
  utils/paths.js       asset URLs that survive being served from a subpath
work/index.html        the work list (one dummy painting)
about/index.html       the artist bio (empty placeholders)
page.css               shared by both flat pages
public/
  models/               the five garden GLBs actually served (see below)
  portfolio/             artwork images
  textures/              Milky Way panorama
3d_Assets/             pristine Sketchfab source exports -- gitignored, NOT
                        served. public/models/ holds the optimized derivatives.
garden-plan.html       the top-down layout artifact drafted from the hand
                        sketch (idea.jpeg) before building the 3D scene
```

`work/` and `about/` are real build entries listed in `vite.config.js`. They
are plain HTML on purpose: a WebGL canvas is invisible to search engines and
screen readers, so the site needs a text route to the same material.

## The garden

Four landmarks, positioned in `GARDEN_POINTS` (`src/scene/garden.js`):

| Landmark | Position | Model |
|---|---|---|
| Gulmohar (centrepiece) | `(0, 0, 0)` | `models/gulmohar.glb` |
| Pond with waterfall | `(-23, 0, -19)` | `models/pond.glb` |
| Gazebo | `(22, 0, 18)` | `models/gazebo.glb` |
| Japanese maple | `(23, 0, -21)` | `models/maple.glb` |

`models/floor_leaves.glb` isn't a landmark — `setupFloorEverywhere()` pulls
individual leaf and micro-plant meshes out of it and scatters them as
`InstancedMesh`es across the lawn and under both trees, and lifts its
`ground_close` material's colour/normal map to retexture the ground plane
itself.

A closed Catmull-Rom loop (`createGardenPathway()`) connects the four,
built the same way as everything else that needs a ribbon on the ground: a
curve, sampled, offset left/right by half the path width, triangulated. Tube
geometry along the same curve gives it curbs.

Clicking a landmark's hitbox tweens the camera to that landmark's
`cameraTarget` (`main.js#onClick`); clicking empty ground or a landmark a
second time calls `resetScene()`. This is the same "one gesture, one meaning"
rule as the dock's other controls — see `onClick` and `_registerHover`.

## The optimization pipeline

**The Sketchfab source files are not fit to serve as downloaded.** Combined,
the five originals in `3d_Assets/` are 231 MB and expand to **11.5 million
drawn triangles and 435 MB of texture VRAM once loaded into the scene** —
measured by traversing the live `THREE.Scene`, not estimated. The single
worst offender was `gazebo.glb`: only 5,196 triangles, but three 4096×4096
textures on a small structure cost **256 MB of VRAM by itself**. The second
was `floor_leaves.glb`'s ground litter: dense, real-3D leaf-cluster meshes
(~9,700 triangles each) instanced 1,160 times totalled **9.79 million
triangles — 85% of the entire scene** for decorative litter nobody looks at
closely.

`public/models/` holds the fix, built with
[`@gltf-transform/cli`](https://gltf-transform.dev/):

```bash
npx @gltf-transform/cli resize   in.glb out.glb --width 1024 --height 1024
npx @gltf-transform/cli simplify in.glb out.glb --ratio 0.12 --error 0.003
npx @gltf-transform/cli weld     in.glb out.glb
npx @gltf-transform/cli dedup    in.glb out.glb
npx @gltf-transform/cli prune    in.glb out.glb
npx @gltf-transform/cli meshopt  in.glb out.glb --level medium
```

Applied per asset (skip `simplify` where geometry is already cheap; skip
`meshopt` where it doesn't help — it made `pond.glb` slightly *larger*, so
that one ships without it):

| Asset | Triangles | Texture VRAM | File size |
|---|---|---|---|
| `gulmohar.glb` | 394,278 (unchanged) | 55.7 → 35.7 MB | 33.4 → 14.5 MB |
| `gazebo.glb` | 5,196 (unchanged) | 256.0 → 16.0 MB | 39.3 → 4.1 MB |
| `pond.glb` | 3,698 (unchanged) | 28.0 → 12.0 MB | 10.6 → 3.3 MB |
| `maple.glb` | 1,252,651 → 291,322 | 13.3 MB (unchanged) | 97.3 → 11.9 MB |
| `floor_leaves.glb` | 518,432 → 62,836 (base mesh) | 85.3 → 21.3 MB | 49.3 → 4.2 MB |
| **Total (disk)** | | | **231 → 38 MB** |

`floor_leaves.glb`'s instance counts were also cut in `garden.js`
(`countPerMesh` 125→45, `countPerPlant` 40→16), so its *in-scene* cost fell
further than the table above shows. **Live, in-scene totals: 11.46M → 1.15M
triangles (10×), 435 MB → 95 MB texture VRAM (4.6×).** Verified after the
fact by walking `scene.traverse()` and summing real drawn triangles and
unique texture pixel counts — not estimated from the source files, since a
mesh can be shared, hidden, or instanced differently than its file suggests.

Because several files now use meshopt-compressed geometry,
`GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` is wired in
`loadGarden()` — without it those files fail to parse and each landmark
silently falls back to its procedural stand-in (a coloured blob tree, a cone
roof, a flat circle of water — see the `createFallback*` functions at the
bottom of `garden.js`).

**`3d_Assets/` is gitignored.** The originals stay on disk for anyone who
wants to re-derive a different optimization level, but nothing there should
be committed — the first commit of this project did commit them (up to 97 MB
for a single file, against GitHub's 100 MB hard limit), which is why
`git log` still carries that weight even though the working tree doesn't.
Rewriting that history (`git filter-repo` + a force-push) would shrink the
clone but rewrites shared history — worth doing, but only on request.

## Changing things

- **A landmark's model** — replace the file in `public/models/`; re-run the
  pipeline above first if it's a fresh Sketchfab export, or you'll reintroduce
  the problem this section exists to prevent.
- **Where a landmark stands** — `GARDEN_POINTS` in `garden.js`.
- **Where the camera flies on click** — each `setup*()` function's
  `interactiveData.cameraTarget`.
- **Leaf litter density** — `countPerMesh` / `countPerPlant` in
  `setupFloorEverywhere()`.
- **A new work** — drop the image into `public/portfolio/` and copy the
  `<figure>` block in `work/index.html`.
- **The bio** — fill in the four sections of `about/index.html`.
- **An Instagram button in the dock** — set `SITE.instagram` in
  `src/content.js`; an empty string hides it.

## The dock

Home · pause/play · noon · time warp · midnight · work · about.

Every time control follows the same rule: **tap to jump, hold to run time
forward**. Releasing a held sun/warp/moon button leaves the sky where you left
it; releasing a held pause button settles back to ambient drift. Pause stops
everything ambient — sky clock, camera orbit, the pond's ripple animation —
so "paused" means one thing.

The dock fades after six idle seconds, which is why Work and About also live
in the always-visible corner nav: the only route to the text pages must not
disappear.

## Notes for whoever works on this next

- **Measure before trusting a source file's numbers, and measure again after
  changing anything.** The table above exists because reading a `.glb`'s file
  size or a Sketchfab page's polygon count would have been wrong by an order
  of magnitude in both directions — the tiny gazebo's texture cost and the
  leaf litter's instancing multiplier were both invisible without actually
  walking the loaded scene.
- **The camera is never teleported.** The opening crane is one continuous
  `sine.inOut` tween — chaining two eased legs decelerates to zero at the seam
  and reads as a stall. It is gated on both content being ready and the loader
  having cleared, so a fast load cannot play it behind the overlay.
- **One clock drives everything.** `sunAngle` feeds light direction and colour,
  sky gradient, fog, floor tint and the on-screen time. A second clock for any
  of those will drift.
- **Colour constants live at module scope.** The render loop cross-fades a dozen
  of them per frame; allocating `THREE.Color` objects in there is GC pressure
  that shows up as periodic hitches.
- **The shadow map is not redrawn every frame** — `animate()` flags it only
  once the sun has moved far enough to matter, and when the garden finishes
  loading.
- **`setupPond()` and `setupFloorEverywhere()` identify sub-meshes by node
  name** (`water`, `riple`, `plane.002`, `s_list_`, `r1`–`r4`). Any geometry
  pipeline run on those two files must preserve node names — `weld`,
  `simplify`, `resize`, `dedup` and `meshopt` all do, which is why the
  pipeline above never includes gltf-transform's `join`: it would merge
  same-material meshes together and break that name-based lookup. It was
  skipped for every asset here, not only these two, which is why `pond.glb`
  still costs 405 draw calls for a scene this simple — a real fix, just not
  one worth the risk to take on while nothing was actually slow because of it.
- **Measuring the scene in a headless browser is misleading.** With
  `document.hidden`, `requestAnimationFrame` is throttled and GSAP barely
  advances, so a screenshot catches a tween mid-flight regardless of how long
  you wait. Scrub the tween directly instead — find it with
  `gsap.getTweensOf(target)` and call `.progress(1, false)` — which is
  deterministic and immune to the throttling. `window.__gulmohar` (dev-only)
  exists for exactly this.
