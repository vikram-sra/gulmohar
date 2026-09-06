# Gulmohar

A single 3D view — one tree, one mirrored cone — under an astronomically driven
sky, plus two flat pages: a work list and an artist bio.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
```

## Layout

```
index.html            3D scene: HUD, permanent nav, loader, dock styles
main.js               GulmoharApp — renderer, lights, ground, cone, dock, render loop
src/
  content.js          site name, tagline, optional Instagram/email
  scene/tree.js       loads models/tree.glb, normalises it to 16 m, procedural fallback
  sky/celestial.js    sun/moon ephemeris, sky dome, stars, Milky Way
  utils/paths.js      asset URLs that survive being served from a subpath
work/index.html       the work list (one dummy painting)
about/index.html      the artist bio (empty placeholders)
page.css              shared by both flat pages
public/
  models/tree.glb     the tree (currently a neem, standing in for a gulmohar)
  portfolio/          artwork images
  textures/           Milky Way panorama
```

`work/` and `about/` are real build entries listed in `vite.config.js`. They are
plain HTML on purpose: a WebGL canvas is invisible to search engines and screen
readers, so the site needs a text route to the same material.

## Changing things

- **The tree** — replace `public/models/tree.glb`. `src/scene/tree.js` scales
  whatever it finds to `TARGET_HEIGHT` (16 m) and sinks it by `GROUND_SINK`
  (2.15 m), since exported trees usually have root tips below the trunk's real
  contact point. If the file fails to load, a crude procedural tree stands in
  rather than leaving bare ground.
- **Where the tree stands** — `TREE_POSITION` in `main.js`.
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
everything ambient — sky clock, ground rings, camera orbit — so "paused" means
one thing.

The dock fades after six idle seconds, which is why Work and About also live in
the always-visible corner nav: the only route to the text pages must not
disappear.

## Notes for whoever works on this next

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
- **The shadow map is not redrawn every frame** — `animate()` flags it only once
  the sun has moved far enough to matter, and when the tree finishes loading.
- **Measuring the scene in a headless browser is misleading.** With
  `document.hidden`, `requestAnimationFrame` is throttled and GSAP barely
  advances, so a screenshot catches the tree mid-emergence and the camera
  mid-descent. Scrub `window.__gulmohar._introTl` instead — that is deterministic
  (the dev-only handle exists for exactly this).
