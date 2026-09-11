# Gulmohar

An interactive botanical garden — a Royal Poinciana (gulmohar) at the centre,
a pond in one corner, a gazebo in another, and a winding path connecting
them — under an astronomically driven, physically based sky, plus two flat
pages: a work list and an artist bio.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
```

Append `?edit` to enter **edit mode** (see [Edit mode](#edit-mode) below).
Force a quality tier with `?q=low` / `?q=med` / `?q=high`.

## Layout

```
index.html            3D scene: HUD, permanent nav, loader, dock styles
main.js               GulmoharApp — renderer, lights, ground, dock, render loop
src/
  content.js          site name, tagline, optional Instagram/email
  quality.js          GPU probe, tier definitions (low/med/high), adaptive loop
  controls/
    fpsNavigator.js   WASD/pointer-lock first-person walk (W/A/S/D + drag)
  edit/
    editor.js         painting-placement editor (only loaded on ?edit)
    zip.js            client-side ZIP export helper used by the editor
  scene/
    garden.js         loads the four landmark GLBs, scatters ground litter,
                      builds the path loop, registers click-to-focus targets
    grass.js          instanced grass field, quality-tier aware
    paintings.js      painting load, placement, and persistence helpers
    wind.js           shared wind uniforms injected into canopy/grass shaders
  sky/celestial.js    sun/moon ephemeris, sky dome, stars, Milky Way
  utils/paths.js      asset URLs that survive being served from a subpath
work/index.html       the work list (one dummy painting)
about/index.html      the artist bio (empty placeholders)
page.css              shared by both flat pages
public/
  models/              the five garden GLBs actually served (see below)
  portfolio/           artwork images
  paintings.json       saved painting placements (written by the editor)
  textures/            Milky Way panorama, baked ground texture
3d_Assets/            pristine Sketchfab source exports -- gitignored, NOT
                      served. public/models/ holds the optimized derivatives.
garden-plan.html      the top-down layout artifact drafted from the hand
                      sketch (idea.jpeg) before building the 3D scene
```

`work/` and `about/` are real build entries listed in `vite.config.js`. They
are plain HTML on purpose: a WebGL canvas is invisible to search engines and
screen readers, so the site needs a text route to the same material.

## The garden

Three landmarks, positioned in `GARDEN_POINTS` (`src/scene/garden.js`), with
a banyan and a mango outside the path loop:

| Landmark | Position | Source |
|---|---|---|
| Gulmohar (centrepiece) | `(0, 0, 0)` | `models/gulmohar.glb` |
| Pond | `(-23, 0, -19)` | `src/scene/pondTerrain.js` + `textures/pond_bed.jpg` |
| Gazebo | `(22, 0, 18)` | `models/gazebo.glb` |

**The pond** is the basin from *Low Poly Tree Scene Free* by Nicholas-3D
(CC-BY-4.0, `3d_Assets/NEW`) — its `Ground` mesh only; the scene's trees and
grass are not used. `scripts/bake-pond-terrain.py` rasterises it into a height
grid (`pondTerrain.js`) that `groundHeightAt()` samples, so the lawn plane
*is* the basin: grass, leaves, walking and painting placement all follow it,
with no second surface to seam against. The water is a flat sheet at
`POND_WATER_Y` that discards wherever the bed rises above it — the shoreline is
exactly where water meets ground, feathered over its first 10 cm of depth.

**The lawn** (`src/scene/lawn.js`) is real 3D blades from
`realistics_grass_06.glb` (`scripts/prepare-grass-blades.mjs`): one tuft of
2,184 blades, overlapped across the garden. Blades are index-sorted by a random
key so any fraction is a draw range; the vertex shader thins them continuously
with distance, each tuft is drawn at the smallest range that covers it, tufts
outside the frustum are skipped, and every blade reads a baked garden mask so
path, pond and tree bases need no special placement. ~500k triangles in the
landing view at the top tier, ~110k at the low tier. Wild accents — meadow clumps at the rim and along the
pond margin, small leafy plants in the lawn — come from `meadow_clumps.glb`
(`simple_grass_chunks` by 3dhdscan, CC-BY-4.0, via
`scripts/extract-meadow-clumps.mjs`).

`models/floor_leaves.glb` isn't a landmark — `setupFloorEverywhere()` pulls
individual leaf and micro-plant meshes out of it and scatters them as
`InstancedMesh`es across the lawn and under both trees, and lifts its
`ground_close` material's colour/normal map to retexture the ground plane
itself.

A closed Catmull-Rom loop (`createGardenPathway()`) connects the landmarks,
built the same way as everything else that needs a ribbon on the ground: a
curve, sampled, offset left/right by half the path width, triangulated. Tube
geometry along the same curve gives it curbs.

Clicking a landmark's hitbox tweens the camera to that landmark's
`cameraTarget` (`main.js#onClick`); clicking empty ground or a landmark a
second time calls `resetScene()`. This is the same "one gesture, one meaning"
rule as the dock's other controls — see `onClick` and `_registerHover`.

## Quality tiers

`src/quality.js` probes the GPU on startup (renderer info, pixel ratio,
benchmark frame) and assigns one of three tiers:

| Tier | Target | Key reductions |
|---|---|---|
| `high` | Desktop GPU | Full grass radius, shadow map 2048, MSAA |
| `med` | Mid-range / tablet | Reduced grass, shadow map 1024 |
| `low` | Mobile / integrated | Minimal grass, shadow map 512, no MSAA, no dust |

The **adaptive loop** (`sampleFrame` / `resetAdaptive`) watches live frame
time and steps `pixelRatio` and instance counts down if the device struggles,
or back up if it recovers headroom. `InstancedMesh.count` is a free draw-range
clamp — no geometry reallocation happens.

Force a tier with the `?q=` query parameter; `?edit` pins `high` and disables
adaptation.

`window.__quality` (dev-only) exposes the live singleton. Re-importing
`quality.js` in the console gives a phantom module copy with its own state —
always read from the window global.

## Sky and lighting

`src/sky/celestial.js` runs a Toronto-based sun/moon ephemeris, driving:

- The sky itself, from `src/sky/atmosphere.js`: Rayleigh + Mie + ozone single
  scattering in a spherical atmosphere with Hillaire's (2020) multiple-scattering
  approximation. It is baked into a 128×128 sky-view texture only when the sun
  moves, and a CPU copy of the same integral supplies the sunlight colour, sky
  fill, fog and pond reflections. Twilight comes out as observed — a yellow-orange
  arch toward the sun, a blue (ozone) zenith, the Earth's shadow and pink Belt
  of Venus opposite, the purple light at −2…−6° — and distant land below the
  horizon is hazed by the same air, so the lawn fades into it with no seam.
  Mornings run clearer than evenings (aerosol load).
- Star field and Milky Way panorama (fade starts at −0.28 sun altitude for
  realistic nautical/astronomical twilight)
- Directional sun/moon lights

`main.js` cross-fades a dozen colour constants per frame. All constants live
at module scope — no `THREE.Color` allocations inside the render loop (GC
pressure that shows up as periodic hitches).

**One clock drives everything.** `sunAngle` feeds light direction and colour,
sky gradient, fog, floor tint, pond surface, and the on-screen time. A second
clock for any of those will drift.

### Diurnal pond surface

`pond.update(time, delta, lightCtx)` receives a `lightCtx` object (assembled
in `main.js`'s render loop) that carries the blended sky/horizon colours, sun
and moon direction/colour/intensity, and the day/twilight/night weights. The
pond shader uses them to:

- Fresnel-reflect the actual sky/horizon colour (not a hardcoded blue)
- Switch specular glint between sun and moon based on time of day
- Lerp water body colour: emerald (day) → darker teal (twilight) → indigo
  (night); the sunset colour itself comes from the reflected sky

### Wind

`src/scene/wind.js` exports a shared `windUniforms` object injected into
canopy and grass shaders via `material.onBeforeCompile`. The hook chains —
it stashes the original on `userData.__preWindCompile` so repeated calls
(one material, many meshes) chain the *same* original instead of wrapping
the wrapper, which would duplicate GLSL into a redefinition error.

Leaves cast shadows from their rest pose. Injecting wind into
`customDepthMaterial` while the shadow map re-renders at ~12 Hz causes the
dapple to strobe (every refresh catches the leaves at a different gust phase).

`window.__wind` (dev-only) exposes the live uniforms object.

## Controls

### Orbit / click-to-focus (default)

Drag to orbit, scroll to zoom. Click a landmark hitbox to fly to it; click
again or click empty ground to reset.

### First-person walk

`FPSNavigator` (`src/controls/fpsNavigator.js`) provides WASD + pointer-lock
first-person navigation. Active in edit mode; the constructor options let the
caller set move speed and look sensitivity.

## Edit mode

Append `?edit` to the URL to enter the painting-placement editor:

```
http://localhost:5173/?edit
```

The editor chunk (`src/edit/editor.js`) is a **dynamic import** — visitors
who never use `?edit` never download it. In edit mode:

- Quality tier is pinned to `high`; adaptive scaling is disabled
- A sidebar panel ("Gulmohar · edit mode") appears
- Click any surface in the scene to raycast a placement point
- Paintings from `public/portfolio/` can be hung on walls or leant against
  surfaces
- Save exports an updated `paintings.json` (and optionally a ZIP of the
  placement data via `src/edit/zip.js`)

`window.__gulmoharEdit` (dev-only) exposes the live editor instance.

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
[`@gltf-transform/cli`](https://gltf-transform.dev/).

**Pipeline order matters** — run in this sequence:

```bash
# Only if the source uses KHR_materials_pbrSpecularGlossiness (e.g. the banyan):
npx @gltf-transform/cli metalrough  in.glb out.glb

npx @gltf-transform/cli resize   in.glb out.glb --width 1024 --height 1024
npx @gltf-transform/cli simplify in.glb out.glb --ratio 0.12 --error 0.003
npx @gltf-transform/cli weld     in.glb out.glb
npx @gltf-transform/cli dedup    in.glb out.glb
npx @gltf-transform/cli prune    in.glb out.glb
npx @gltf-transform/cli meshopt  in.glb out.glb --level medium
```

**Never run `join`.** `setupPond()` and `setupFloorEverywhere()` identify
sub-meshes by node name (`water`, `riple`, `plane.002`, `s_list_`, `r1`–`r4`).
`join` merges same-material meshes and destroys those names — exactly how the
pond's `plane.002` apron check went dead once. All other steps preserve node
names.

Applied per asset (skip `simplify` where geometry is already cheap; skip
`meshopt` where it doesn't help — it made `pond.glb` slightly *larger*, so
that one ships without it):

| Asset | Triangles | Texture VRAM | File size |
|---|---|---|---|
| `gulmohar.glb` | 394,278 (unchanged) | 55.7 → 35.7 MB | 33.4 → 14.5 MB |
| `gazebo.glb` | 5,196 (unchanged) | 256.0 → 16.0 MB | 39.3 → 4.1 MB |
| `floor_leaves.glb` | 518,432 → 62,836 (base mesh) | 85.3 → 21.3 MB | 49.3 → 4.2 MB |
| `grass_blades.glb` | 6,552 (one tuft; LOD in `lawn.js`) | 5.3 MB | 0.7 → 0.8 MB |
| `meadow_clumps.glb` | 68 (4 card types) | 6.7 MB | 140 MB zip → 0.5 MB |

The old `pond.glb` (rocks and waterfall) and `maple.glb` have since been
removed, along with the `grass_cards` / `veg_clumps` / `dense_grass` lawn.

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

### The ground texture

`public/textures/ground_baked.jpg` is not `floor_leaves.glb`'s own
`ground_close` texture tiled directly — that texture is a photogrammetry
**UV atlas** (charts packed for storage, arbitrarily oriented), and tiling
it draws the packing layout, not the ground; no repeat value fixes that,
because the image was never a top-down photo to begin with.

It's baked instead: `ground_close`'s mesh is isolated from the *pristine*
source (`3d_Assets/floor_leaves_in_the_garden.glb` — the already-optimized
`public/models/floor_leaves.glb` has had its textures resized and isn't
worth re-baking from), then rendered as an orthographic top-down projection
with real UVs. The source mesh's local units turned out to be ~2650 units
across (not metres), so `--px-per-unit` has to be picked from the mesh's
own extent, not assumed:

```bash
python3 -c "
import json, struct
d = open('3d_Assets/floor_leaves_in_the_garden.glb','rb').read()
# ...find the ground_close mesh's POSITION accessor min/max, compute extent
"
# then, after isolating just that mesh into its own .glb (mesh 0 here;
# the bake script rasterises EVERY primitive against the FIRST embedded
# image, so leaf-litter meshes must not be present or they get projected
# against the ground atlas too):
python3 /path/to/threejs-experience/scripts/bake-floor-texture.py \
  ground_only.glb public/textures/ground_baked.jpg \
  --size 1536 --px-per-unit 0.58   # extent ~2650 -> ~1536px square
```

Tiling is broken in the ground shader (`main.js`'s `groundMat.onBeforeCompile`)
with two overlapping sine fields at sub-tile, incommensurate frequencies,
multiplying brightness by a continuously varying ±6% — deliberately not a
`floor()`-based hash, which would draw its own hard-edged cell boundaries.

## Changing things

- **A landmark's model** — replace the file in `public/models/`; re-run the
  pipeline above first if it's a fresh Sketchfab export, or you'll reintroduce
  the problem this section exists to prevent.
- **Where a landmark stands** — `GARDEN_POINTS` in `garden.js`.
- **Where the camera flies on click** — each `setup*()` function's
  `interactiveData.cameraTarget`.
- **Leaf litter density** — `countPerMesh` / `countPerPlant` in
  `setupFloorEverywhere()`.
- **Grass density / radius** — `QUALITY.grassCount` / `QUALITY.grassRadius`
  in `src/quality.js` per tier.
- **A new painting** — drop the image into `public/portfolio/` and hang it
  via edit mode (`?edit`), then save; or copy a `<figure>` block in
  `work/index.html`.
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
  sky gradient, fog, floor tint, pond surface, and the on-screen time. A second
  clock for any of those will drift.
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
  pipeline above never includes gltf-transform's `join`.
- **Measuring the scene in a headless browser is misleading.** With
  `document.hidden`, `requestAnimationFrame` is throttled and GSAP barely
  advances, so a screenshot catches a tween mid-flight regardless of how long
  you wait. Scrub the tween directly instead — find it with
  `gsap.getTweensOf(target)` and call `.progress(1, false)` — which is
  deterministic and immune to the throttling. `window.__gulmohar` (dev-only)
  exists for exactly this.
- **`shadow.radius` is ignored by `PCFSoftShadowMap`.** It only applies to PCF
  and VSM. Setting it under PCFSoft pays for the most expensive filter Three
  offers while the blur setting never runs.
- **`renderer.setPixelRatio()` must be followed by `composer.setSize()`.**
  `EffectComposer.setSize` re-reads the pixel ratio; without it the render
  targets stay at the old resolution.
- **`InstancedMesh` is culled against its geometry's bounding sphere** — which
  describes one clump at the origin, not the scattered field. Widen it by hand
  or the whole field pops out when the origin clump leaves frame.
- **`patch` is a reserved word in GLSL ES 3.0** (tessellation). A variable
  named that silently drops the whole ground plane — the sky dome shows below
  the horizon with no error logged. Always assert zero failed programs after a
  shader change: `renderer.info.programs.filter(p => !gl.getProgramParameter(p.program, gl.LINK_STATUS)).length` must be 0.
- **`KHR_materials_pbrSpecularGlossiness` is unsupported by GLTFLoader.**
  Models using it load untextured. Fix with `gltf-transform metalrough`
  *before* the rest of the pipeline.
- **Console `await import('/src/x.js')` gets a second module instance** — a
  phantom with its own state. Read live singletons from `window.__gulmohar`,
  `window.__quality`, `window.__wind`, `window.__gulmoharEdit` instead.
