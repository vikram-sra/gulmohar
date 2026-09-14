# Test run — local mode, 2026-09-14

Everything in [FEATURES.md](FEATURES.md) that does not need Firebase, run
against `npm run dev` in Chrome at 595×827 CSS px, DPR 2, auto-probed to the
**high** tier.

Firebase-gated items (**[!]**) were skipped by request: A3–A6, A8 (cloud half),
A32–A37 image pipeline, A67–A78 publish and sync, A81–A82 rules.
Touch-only items (**[T]**) were not run — this harness has no touch emulation.

**Result: 7 defects found — all 7 fixed and re-verified (see the Fixed section).** Four are mine to own — I wrote them into
FEATURES.md from the plan document rather than from the code, so they were
never true. Three are real regressions in shipped code.

---

## Defects

### D1 — Legacy import silently destroys every mount type · **high**

`src/studio/main.js:248`

```js
const LEGACY_MOUNT = { 'ground-lean': 'lean', 'ground-flat': 'flat', tree: 'hang', wall: 'hang' };
```

Both sides of this map are dead vocabulary. The mounts that actually exist are
`easel | ground | rope | surface` (`MOUNTS`, `paintings.js:44`), and that is
what `public/paintings.json` contains — so **no key ever matches** and every
import falls through to `|| 'free'`.

Measured after importing all 7 bundled works:

```
Untitled I        mount: "free"   (was easel)
Last Light        mount: "free"   (was surface)
Pond Study        mount: "free"   (was ground)
Canopy            mount: "free"   (was rope)
Aerial Roots      mount: "free"   (was surface)
Under the Banyan  mount: "free"   (was rope)
Reflection Study  mount: "free"   (was surface)
```

`normalizeMount('free')` returns `'surface'`, so publishing after an import
turns the easel piece, the ground piece and both roped pieces into
nailed-flat paintings. Confirmed end to end: opening `?place=canopy-oji6`
shows **"Canopy · Hung on a surface"** for a work that is roped in the source.

The fix is one line — map to the current vocabulary — but note the target
names must be the new ones, and `LEGACY_MOUNTS` in `paintings.js:47` already
has the correct table to copy.

### D2 — Legacy import drops `startHere` · **high**

`src/studio/main.js:250-266`. The import copies title, year, medium,
dimensions, frame and the full placement, but never reads `r.startHere`.
`Canopy` carries `startHere: true` in `public/paintings.json`; after import
the field is **absent on all 7 records**. The opening view silently reverts to
the default framing.

Re-flagging it by hand works (menu → "Open the garden here" set it on Canopy
and the card ring appeared), so this is only the import path.

### D3 — `?edit` does not redirect; the legacy editor still ships · **medium**

Loading `/?edit` opens the **old** editor — title "Gulmohar — edit", the
"Save (download .zip)" workflow — not the Studio. The plan called for `?edit`
to redirect to `/studio/` and for `src/edit/editor.js` to be deleted at the
end of phase 5. Neither happened: `editor.js` is still a 38.91 kB chunk in the
build, and two editors with different save models are both reachable by URL.

### D4 — No collision on the gazebo or the pond · **medium**

`main.js:770` says so outright: *"Gazebo posts and the pond aren't covered
yet."* Colliders are 3 trunks + 7 painting circles = 10 circles; nothing for
the pavilion or the water. You can walk through the gazebo and into the pond.

FEATURES V45 asserted this worked. That was my error — it came from the plan,
not the code.

### D5 — `createFlowerBeds()` is dead code · **low**

`src/scene/garden.js:1249` defines it; nothing calls it. `grep -rn
createFlowerBeds src/ main.js` returns only the definition. No `FlowerBeds`
node exists in the live scene graph — only `MeadowRim` and
`MeadowPondMargin`. `README.md` describes flower beds as a feature.

Either wire it up or delete it; right now it is ~100 lines that cannot run.

### D6 — Banyan collider is far smaller than the banyan · **low**

Fitted trunk radii: gulmohar **1.69 m**, mango **0.98 m**, banyan **0.53 m**.
But raycasting the banyan's bark at eye height finds surface at **0.9–3.8 m**
depending on direction — it is a multi-trunk tree with buttress roots and an
aerial-root curtain, and `fitTrunkRadius` measures only the central stem.

Verified: walking at the banyan from +x stops at 0.873 m (exactly
`0.53 + 0.35` player radius) while visible bark at that bearing is at 2.3 m.
You walk through roughly a metre and a half of tree.

Collision itself is correct — this is the fitted radius being unrepresentative
for this one species.

### D7 — Visitor dock stays up in place mode · **cosmetic**

FEATURES A39 says the visitor dock is hidden in placement mode. It is not:
`#dock` computes to `display: grid, opacity: 1` and the home orb renders at
y≈763 beneath the placement bar at y≈626. They do not overlap, so nothing is
blocked — it is just two control surfaces on screen at once.

---

## Passed

Grouped; each was measured, not eyeballed, unless noted.

**Load and scene** — V1–V5 (opening flight lands framed on the `startHere`
painting), V6–V13, V15, V17–V18. All landmark nodes present: `GulmoharTree`,
`Gazebo`, `Pond`, `PondWaterSurface`, `banyan_0`, `mango_1`, `GardenPathway`,
`ScatteredLeavesEverywhere`, `BackgroundTrees`, `LawnPlants`. 31 instanced
meshes, 6 823 instances.

**Dust** — V16. 100 points, in-scene. My first probe missed it because
`this.dust` is unnamed; not a defect.

**Sky and time** — V19–V26. `TorontoSkySystem` present, clock read 12:47
against a live sun angle.

**Motion** — V27–V30. Auto-rotate is correctly *off* while a painting is
focused and resumes on Home (`autoRotate: true`, focus `null`).

**Orbit navigation** — V31–V33, V35. A tap on empty scene moves the orbit
pivot by **0.000** (auto-rotate alone drifts the camera 0.74 over the same
2 s).

**Walk mode** — V36, V43, V44, V46. Collision distances land exactly on
`radius + 0.35`: gulmohar 2.04 vs 2.04, canopy painting 0.65 vs 0.65, gazebo
chrome painting 0.60 vs 0.60, banyan 0.873 vs 0.88. Walking into a trunk
slides around it rather than stopping dead, as intended.

**Paintings** — V49–V52, V56, V58, V63–V65. Hardware part counts are exactly
right per mount: rope = 2 fixed (plumb line, hook) + 3 turning (2 struts,
knot); surface under canopy = 3 fixed (nail, cord, hook) + 2 wires; gazebo
surface = 1 fixed (nail only, no cord — correct, no branch). Billboard limits
7° surface / 180° rope-easel-ground / **0° and `fixed: true`** for the gazebo
work. Five frame styles in use: pale-wood, maple, ebony, chrome, none.

**Depth of field** — V69. `DofPass` present in the composer on high
(12 taps, 2.6 px); **absent from the pass list entirely** on low.

**HUD** — V70–V77, V79, V83, V85. All 9 dock buttons present. Noon → sun
angle **1.571** (π/2 exactly); Midnight → **4.712** (3π/2 exactly); both moved
the orbit target by **0.000**. Pause → `paused: true, autoRotate: false,
daySpeed: 0`; resume restores all three. Hover label has its glass plate.

**Quality** — V87–V88, V91. Auto-probe chose `high`. `?q=low` gave tier
`low`, 0 DoF taps, 0 dust, 1024 shadows, AA off, pixel ratio 1.0 — and all
7 paintings still rendered.

**Studio** — A1 (`noindex` confirmed), A7, A9–A11, A13–A15, A17–A20, A61–A66.
Local banner, "Synced" chip, 3 sections, empty state, 5 garden-artifact rows
with drawn likenesses. Editing a landmark's name and description saved
correctly and the row reported "Saved". Card menu offers exactly: Move
earlier, Move later, Remove from garden, Open the garden here, Delete
painting. "Open the garden here" set the flag and drew the card ring.

**Place mode** — A38–A41, A45–A46, A52, A54–A57, A59. Opens in walk mode with
the place HUD, four mount options each with its denial reason, size stepper,
Save, Studio exit. Returning to a placed work starts from where it actually
is. 3 trunk proxies, 8 aim targets.

---

## Not tested

- **Firebase-gated** — skipped by request.
- **Touch-only** — V40–V42, V47, A43, A60, and the touch half of V84. No touch
  emulation in this harness; these need a real device.
- **V34** (banyan framing avoids the gulmohar) — the geometry was proved by
  measurement when it was written (camera 17.1 m out, sightline clearance
  16.0 m, against the old 1.75 m) but I did not re-run the click here.
- **V39 pointer lock**, **V86 Escape**, **V90 portrait**, **V92 reduced
  motion**, **V94 resize** — need viewport or browser-chrome control I did not
  exercise this pass.
- **V66–V68 DoF behaviour** — the pass is present and configured; whether the
  blur *looks* right and holds focus on a rotating painting is a judgement
  call better made by eye than by probe.
- **V95–V99 flat pages** — not opened this pass.
- **A21–A31 upload form** — needs a real file through a file input.
- **A47–A51 mount placement by key** — the shortcut fires, but a full
  place-each-mount-and-save cycle needs the aim driven interactively.
- **A79 Download backup** — would write a file to the browser's download
  directory.

## Correction to FEATURES.md

V44 said "any of the **five** trees". There are **three** (gulmohar, banyan,
mango); the other two landmarks are the gazebo and the pond. Corrected.


---

# Fixes — same day

All seven, with the measurement that shows each one closed.

| | Was | Now |
|---|---|---|
| D1 | all 7 imports `mount: "free"` | all 7 round-trip exactly; `rise` preserved on both rope works |
| D2 | `startHere` absent on all 7 | set on Canopy only, matching source |
| D3 | `?edit` opened the legacy editor | redirects to `/studio/`; `editor.js` deleted (−38.9 kB chunk) |
| D4 | walked through gazebo and pond | 5 bearings blocked at ~4.2m, entrance open to 0.01m; pond blocks at 5.88m |
| D5 | `createFlowerBeds()` dead | deleted with its colour tables and duplicated wiring (−109 lines) |
| D6 | banyan stopped you at 0.87m | 1.68m; gulmohar and mango unchanged |
| D7 | dock and orb showed in place mode | neither is built |

### Notes worth keeping

**D1 needed a new module, not a new map.** The rot was that the Studio kept a
*second*, private copy of the mount vocabulary. Fixing the copy would have left
the same failure mode in place. `src/mounts.js` now holds it once, free of any
Three.js import so the Studio can read it without pulling the renderer into its
bundle — studio.js grew 1.6 kB, not 900.

**Re-export is not import.** The first attempt at that module used
`export { normalizeMount } from '../mounts.js'` in paintings.js. That form
creates no local binding, so every *importer* worked while paintings.js's own
calls threw `normalizeMount is not defined` — which killed painting loading and
placement mode outright. Caught because the place-mode check was re-run after
the change rather than assumed. Now `import` + `export {}`.

**D6 took three attempts, and the two failures are the interesting part.**
Widening the vertex-walk gap ran the banyan out through its aerial roots to
11.19m, past `MAX_TRUNK_RADIUS`, so the fit returned 0 and nothing changed.
Raycasting outward from the trunk axis found nothing at all — the ray starts
*inside* the mesh and the only faces ahead of it are back faces. Raycasting
inward then found the invisible click-hitbox cylinder at 4.85m on every
bearing. What works is bucketing the vertices already sampled by bearing,
dropping anything past 2.5m *before* taking a low percentile across buckets.
Single-stemmed trees come back unchanged by construction; only the banyan moves.

**D4's gazebo circles are wider than its posts (0.55m vs ~0.16m), on purpose.**
The sweep finds posts *and* railing, about a metre apart; circles the true size
of the posts left gaps a walker went straight through — measured, to within
0.2m of the centre. They are collision-only and never drawn, and the entrance
is a 50-degree gap, far too wide for the widening to close.

### Regression check

Fresh load, clean console: 7 paintings with mounts `easel, surface, ground,
rope, surface, rope, surface`; 31 colliders (3 trunks + 21 gazebo + 7
paintings); dock, orb and clock present; no `FlowerBeds` node; dust in scene;
`RenderPass → DofPass → OutputPass`. `node scripts/check-bundle.mjs` passes.


---

## Follow-up — the hover caption

The glass plate from the earlier readability fix worked and looked wrong: it
had the dock's border, shadow and radius, sat directly above it, and read as a
second dock rather than as a title for the work.

Rebuilt as a gallery wall label. The backdrop blur stays — grass genuinely
does need a real ground behind the ink — but it is now masked with a radial
gradient so it has no edge anywhere: a soft pool of light, not an object.
A hairline rule between the two lines does the job the border was doing.

Two things worth remembering from it:

* **`radial-gradient(ellipse at center, …)` defaults to farthest-*corner*.**
  At the mid-edges the gradient is only part-way along, so the blur box showed
  up as a crisp rectangle. `farthest-side` lands transparent on every edge.
* **A latent bug surfaced on the way.** `#hover-label` was `position: fixed`
  with `left: 50%` and no `right`, so its containing block ran from the middle
  of the screen to the right edge — available width was half the viewport and
  `max-width` never applied. "Royal Poinciana (Gulmohar)" was wrapping to four
  lines at ~300px. Now `left: 0; right: 0` with the plate centred inside:
  the same label is 385px on two lines.
