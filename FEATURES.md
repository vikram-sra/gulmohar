# Gulmohar — feature inventory

Everything the site does, written from the two points of view that matter:
the **visitor**, who arrives at the garden and looks around, and the
**artist**, who signs in and changes what the visitor sees.

This is a test surface, not an architecture document — each entry is phrased
as something that can be checked. `README.md` covers how it is built.

Legend: **[D]** desktop only · **[T]** touch only · **[?]** URL-gated ·
**[!]** needs Firebase configured (otherwise the local backend stands in).

---

## 1. Visitor

### 1.1 Loading and first impression

| # | Feature | What to check |
|---|---|---|
| V1 | Loader covers the scene until the garden is ready | No half-built garden is ever visible |
| V2 | Scene reveal transition | Fades in rather than popping |
| V3 | Opening camera flight | Camera settles into a framed view of the garden |
| V4 | "Open the garden here" painting | If a painting is flagged `startHere`, the opening flight ends framed on **that** painting instead of the default view |
| V5 | Graceful fallback | With no published `gallery.json` reachable, the bundled `public/paintings.json` renders instead |

### 1.2 The garden itself

| # | Feature | What to check |
|---|---|---|
| V6 | Gulmohar (Royal Poinciana) centrepiece | Flowering canopy at origin |
| V7 | Pond | Water surface, sloping rock bank, reflections |
| V8 | Gazebo / pavilion | Eight posts, deck, open entrance |
| V9 | Banyan | Outside the path loop, aerial-root curtain |
| V10 | Mango | Outside the path loop, fruit |
| V11 | Winding path loop | Widens into a plaza at the gazebo entrance |
| V12 | Instanced lawn | Grass everywhere except path, pond and trunk cores |
| V13 | Grass LOD by distance | Density falls off with range; no visible popping |
| V14 | Meadow clumps and flower plants | Scattered by `setupVegetation` |
| V15 | Scattered leaf litter | Including leaves on the path |
| V16 | Dust motes | Fine floating particles in sunlight |
| V17 | Contact shadows | Under every landmark |
| V18 | Ground texture | Baked top-down texture, not a tiled atlas |

### 1.3 Sky, light and time

| # | Feature | What to check |
|---|---|---|
| V19 | Physically based atmosphere | Multiple-scattering sky, not a gradient |
| V20 | Astronomical sun and moon | Toronto latitude/longitude ephemeris |
| V21 | Day–night cycle | Sun and moon track across the dome over time |
| V22 | Dawn / dusk horizon grading | Warm band low, cool zenith |
| V23 | Stars | Appear as the sky darkens |
| V24 | Milky Way | Correctly oriented against the galactic pole |
| V25 | Clock readout | Top-right time matches the sun's actual angle |
| V26 | Shadows follow the sun | Direction and length change through the day |

### 1.4 Motion

| # | Feature | What to check |
|---|---|---|
| V27 | Wind on the canopy | Leaves and branches sway |
| V28 | Wind on the grass | Blades move with the same envelope |
| V29 | Gusts | Wind strength varies rather than looping flatly |
| V30 | Slow auto-rotate | The garden turns gently when left alone |

### 1.5 Navigating — orbit mode (default)

| # | Feature | What to check |
|---|---|---|
| V31 | Orbit / drag to turn | |
| V32 | Dolly (scroll / pinch) | Clamped to a minimum distance |
| V33 | Click a landmark | Camera flies to a framed view of it |
| V34 | Framing avoids the gulmohar | Clicking the banyan or mango must not look *through* the centrepiece |
| V35 | Click empty scene | Hides the dock. Does **not** move the camera or slide the orbit pivot |

### 1.6 Navigating — walk mode

| # | Feature | What to check |
|---|---|---|
| V36 | Enter / leave walk mode | Via the dock's pedestrian button |
| V37 | WASD movement **[D]** | |
| V38 | Drag to look **[D]** | |
| V39 | Pointer lock **[D]** | Escape releases it |
| V40 | Touch joystick **[T]** | Bottom-left |
| V41 | Sprint | Shift **[D]** / on-screen button **[T]** |
| V42 | Jump | Space **[D]** / on-screen button **[T]** |
| V43 | Terrain following | Eye height tracks ground height |
| V44 | Collision with trunks | Cannot walk through the gulmohar, banyan or mango |
| V44b | Collision with the pond | Cannot walk into the water |
| V45 | Collision with the gazebo | Posts and rails block; the entrance stays open |
| V46 | Collision with paintings | Cannot walk through a hung canvas |
| V47 | Tap on empty ground **[T]** | Only reveals the dock — must not fast-travel or aim the camera at the grass |
| V48 | Fast-travel to a landmark | Tapping a landmark walks/flies you to it |

### 1.7 Paintings

| # | Feature | What to check |
|---|---|---|
| V49 | Four mount types render | Easel, on the ground, hung by rope, hung on a surface |
| V50 | Rope mount hardware | Plumb rope up to a **real branch**, knot, V into the top corners |
| V51 | Surface mount hardware | Nail, picture wires, plus a cord up to a branch when under a canopy |
| V52 | Gazebo mount | Nail only — no cord, since there is no branch |
| V53 | Rope stays attached while the canvas turns | Fixed half stays put, canvas-side half follows |
| V54 | Rope length is sane | Never a multi-metre line to a far-off limb |
| V55 | Billboarding — ambient | Rope / easel / ground turn freely to face you |
| V56 | Billboarding — surface | Barely drifts (≈7°) while you walk past, so it stays on its post |
| V57 | Billboarding — focused | A focused surface painting turns fully to face you |
| V58 | Gazebo paintings never billboard | Fixed at 0°, focused or not, now and for any hung there later |
| V59 | Click a painting | Flies to a framed, head-on view |
| V60 | Same behaviour in walk mode | Clicking a painting on foot behaves exactly as in orbit mode |
| V61 | Dolly in to fill the screen | A focused painting can be zoomed until it fills the viewport height |
| V62 | Grass parts for ground-mounted work | Only the ground mount; eases open and shut |
| V63 | Shadows update after a painting moves | No stale shadow map |
| V64 | Frame styles | pale-wood, maple, ebony, white, chrome, none |
| V65 | Chrome frame reads as metal | Specular highlight, not flat grey |

### 1.8 Depth of field

| # | Feature | What to check |
|---|---|---|
| V66 | Pointer-driven focus | Focus pulls toward whatever is under the cursor |
| V67 | Subtle, realistic blur | Background softens; never a heavy bokeh |
| V68 | Focused painting stays sharp | Orbiting a zoomed painting must not blur it |
| V69 | Disabled on the low tier | `dofTaps: 0` |

### 1.9 HUD and chrome

| # | Feature | What to check |
|---|---|---|
| V70 | Dock: Home | Returns to the opening view |
| V71 | Dock: Walk | Animated pedestrian icon, always mid-stride |
| V72 | Dock: Motion | Tap pauses/resumes; **hold** ramps speed |
| V73 | Dock: Noon | Tap jumps to midday; hold runs a time-lapse |
| V74 | Dock: Midnight | Tap jumps to midnight; hold runs a time-lapse |
| V75 | Day/night does not move the camera | Tapping either must not pull the view back |
| V76 | Dock: Work / About | Navigate to the flat pages |
| V77 | Dock: Instagram | Only when configured in `src/content.js` |
| V78 | Home orb | Tree silhouette, glowing, gently breathing |
| V79 | Dock ↔ orb morph | Same centre; bar grows out of the orb and shrinks back into it |
| V80 | Orb reopens the dock | And returns home |
| V81 | Dock auto-hides when idle | Shorter delay in walk mode |
| V82 | A dismissed dock stays dismissed | Mouse movement must not summon it back |
| V83 | Hover label | Name and detail on a glass plate, readable over grass |
| V84 | Button tooltips | Hover **[D]** / brief on tap **[T]** |
| V85 | Permanent corner nav | Work / About always reachable even when the dock is hidden |
| V86 | Escape | Resets the view |

### 1.10 Performance, device and access

| # | Feature | What to check |
|---|---|---|
| V87 | GPU probe picks a tier | low / med / high |
| V88 | Tier override **[?]** | `?q=low`, `?q=med`, `?q=high` |
| V89 | Adaptive degradation | Sustained low frame rate drops pixel ratio |
| V90 | Portrait framing | FOV adapts to aspect; composition still works |
| V91 | Phone memory ceiling | Smaller textures on the low tier; textures disposed on unmount |
| V92 | Reduced motion | `prefers-reduced-motion` stops the icon animations |
| V93 | Theme-aware HUD | Light and dark palettes |
| V94 | Resize | No stretching or wrong aspect |

### 1.11 Flat pages

| # | Feature | What to check |
|---|---|---|
| V95 | `/work/` | Lists paintings from the published gallery |
| V96 | `/work/` no-JS fallback | Static HTML still renders |
| V97 | `/about/` | Artist bio |
| V98 | Shared `page.css` | Both pages consistent |
| V99 | Subpath-safe asset URLs | Works served from a project subpath |

---

## 2. Artist

### 2.1 Getting in

| # | Feature | What to check |
|---|---|---|
| A1 | Studio at `/studio/` | Linked from nowhere; `noindex` |
| A2 | `?edit` redirects to the Studio **[?]** | Query string is carried across |
| A3 | Google sign-in **[!]** | Popup, not redirect |
| A4 | Wrong account is refused **[!]** | Shows the account ID to paste into the rules |
| A5 | Copy account ID **[!]** | One click to clipboard |
| A6 | Sign out | |
| A7 | Local test mode | Without Firebase, everything stays in the browser, with a banner saying so |
| A8 | Sync chip | Synced / Saving… / Offline |

### 2.2 The catalogue

| # | Feature | What to check |
|---|---|---|
| A9 | Grid of framed thumbnails | CSS-built frames, not a WebGL render per card |
| A10 | Count of paintings | |
| A11 | Status line per card | In garden / Not placed · Live / Changed / Not live yet · Opening view · availability |
| A12 | Amber warning state | Only for incomplete uploads and unpublished changes |
| A13 | "Opening view" ring | The `startHere` painting is ringed so it is findable at a glance |
| A14 | Drag to reorder | |
| A15 | Move earlier / Move later | Keyboard-accessible fallback for dragging |
| A16 | Edit dialog | Same fields as upload, plus Replace image |
| A17 | Remove from garden | |
| A18 | Open the garden here / Stop opening here | Only offered for a painting that is actually placed |
| A19 | Delete painting | With a confirmation naming the work |
| A20 | Empty state | |

### 2.3 Adding work

| # | Feature | What to check |
|---|---|---|
| A21 | Drop zone and Choose painting | |
| A22 | Title (required) | |
| A23 | Year | |
| A24 | Medium | |
| A25 | Width × Height (required) | |
| A26 | in / cm toggle | |
| A27 | Height pre-fills from aspect | And warns when the typed ratio is >3% off |
| A28 | Frame swatches | With a live framed preview |
| A29 | Availability | available / sold / nfs / on-hold |
| A30 | Show on Work page | |
| A31 | Description | |
| A32 | Three sizes generated | 480 / 1024 / 2048 px |
| A33 | Original kept privately | Never published |
| A34 | Per-size progress bars | |
| A35 | Phone photo orientation | EXIF rotation honoured |
| A36 | WebP with JPEG fallback | iOS Safari silently returns PNG — must be detected |
| A37 | Replace an image | Makes a new version folder |

### 2.4 Placing work in the garden

| # | Feature | What to check |
|---|---|---|
| A38 | "Place in garden" / "Move in garden" **[?]** | Opens `/?place=<id>` |
| A39 | Starts in walk mode | Visitor dock hidden, intro skipped |
| A40 | Shows the **draft** arrangement | Not the published one |
| A41 | Carry view | Painting held ahead and below the view, sized by viewport fraction |
| A42 | Aim with the cursor **[D]** | |
| A43 | Centre reticle **[T]** | |
| A44 | Ghost preview | Translucent, visible against grass |
| A45 | Mount availability | Only the mounts that make sense light up |
| A46 | Denial reasons | "Aim at open ground", "Stand under a tree", "Aim at a trunk or the gazebo" |
| A47 | Place on an easel | `G` |
| A48 | Place on the ground | `L` |
| A49 | Hang by rope | `R` |
| A50 | Hang on a surface | `H` |
| A51 | Pick up again | `F`, or tap a placed painting |
| A52 | Size − / + | `[` `]`, 10% steps, 0.5×–4×, shows "1.2× actual size" |
| A53 | Rotate | `Q` / `E` |
| A54 | Save | `Enter`; queues when offline |
| A55 | Exit to the Studio | |
| A56 | Returning to a placed work | Starts from where it actually is, not from scratch |
| A57 | Trunk proxies | Auto-fitted capsules give clean plumb normals |
| A58 | Proxy debug view **[?]** | `&proxies` draws them |
| A59 | Aim throttled to 15 Hz | And only when the view moves |
| A60 | Touch layout | Controls clear of the joystick |

### 2.5 Garden artifacts

| # | Feature | What to check |
|---|---|---|
| A61 | Five fixtures listed | Gulmohar, banyan, mango, gazebo, pond |
| A62 | Drawn likeness per fixture | Inline SVG, no WebGL per card |
| A63 | Edit name and description | |
| A64 | Defaults shown as placeholders | A landmark doc does not exist until first edit |
| A65 | Save per row | |
| A66 | In-progress edits survive a sync | A live update must not clobber what is being typed |

### 2.6 Publishing

| # | Feature | What to check |
|---|---|---|
| A67 | "Publish N changes" | Count computed by diffing hashes, never stored |
| A68 | Confirmation before going live | |
| A69 | Atomic switch | One `gallery.json` overwrite |
| A70 | Step-by-step progress | |
| A71 | Safe to re-run | A half-failed publish can simply be repeated |
| A72 | Images become public only on publish | Draft uploads return 403 until then |
| A73 | Revision history | `public/history/{revision}.json` for rollback |
| A74 | Count returns to zero | |

### 2.7 Data, safety and housekeeping

| # | Feature | What to check |
|---|---|---|
| A75 | Live sync across devices | Phone upload appears on the laptop without a reload |
| A76 | Offline text edits queue | And sync on reconnect |
| A77 | Leave-page warning | While anything is unsaved |
| A78 | Last-write-wins per painting | A painting being edited is not overwritten mid-edit |
| A79 | Download backup | Zip of the catalogue plus images |
| A80 | Import legacy paintings | Pulls the old `paintings.json` in, keeping exact transforms |
| A81 | Firestore rules | Only the artist's UID can write |
| A82 | Storage rules | Size and type limits per size; originals can never be made public |
| A83 | Visitors never load the Firebase SDK | Enforced by `scripts/check-bundle.mjs` |
| A84 | Bundle size budget | The same check fails the build if `main.js` grows past its baseline |

---

## 3. Known trade-offs

Not bugs — decisions with visible consequences, listed so a tester does not
file them as defects.

1. **The banyan-nailed painting sits proud of the bark in places.** No face on
   that tree is flat at canvas scale — the flattest has ~43cm of relief over a
   46×61cm canvas — so it is stood off past the deepest rib. Over the recessed
   parts there is a visible gap behind the canvas.
2. **The banyan rope ties to an aerial root**, not a woody branch. On a banyan
   that reads correctly.
3. **The unlisted Studio URL is concealment, not security.** Anyone can read
   the public JS and find the page; the Firebase rules are the real gate.
4. **A surface mount barely billboards.** Deliberate — it keeps the canvas on
   the thing it is nailed to. Only focus widens it.
