# Deploying to Netlify

The site is a plain static build (`npm run build` → `dist/`) — Netlify needs
nothing special beyond the `netlify.toml` already in the repo root. This
works alongside the existing GitHub Pages deploy (`.github/workflows/deploy.yml`);
you don't need to remove one to use the other, though running both forever
means two domains to keep in Firebase's authorized-domains list and
`firebase/cors.json` (step 3 below).

## 1. Connect the repo

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project**.
2. Pick GitHub, authorize Netlify, select this repo.
3. Build settings are read from `netlify.toml` automatically (`npm run build`, publish `dist`) — the form should already show them; you shouldn't need to type anything.
4. **Deploy site.** First build takes a minute or two; every push to `main` after this redeploys automatically.

## 2. Find your site's domain

**Site settings → Domain management** shows the default domain: something
like `your-site-name.netlify.app` (Netlify assigns a random name; you can
change it here, free, no custom domain needed). This is the URL you'll
give Firebase.

If you attach a custom domain later, it needs the same two steps as the
`.netlify.app` one below — add it, don't just replace it, since Netlify
domains stay reachable even after a custom domain is attached.

## 3. Tell Firebase about this domain

Two places, both covered in [firebase/SETUP.md](firebase/SETUP.md), worth
repeating here since it's easy to deploy and forget this step:

1. **Firebase console → Authentication → Settings → Authorized domains** — add `your-site-name.netlify.app`. Without this, Google sign-in fails outright from the deployed Studio (it'll work fine from `localhost` and then mysteriously not once deployed — this is almost always why).
2. **`firebase/cors.json`** — add the same domain to the `origin` array, then re-run the `gcloud storage buckets update` command from SETUP.md step 8. Without this, painting images fail to load as textures on the deployed site specifically (works on `localhost`, breaks once deployed — same shape of bug as #1, different cause).

## 4. Environment variables? Not needed

The Firebase web config (`src/cloud/config.js`) is meant to be public and
committed — see the comment at the top of that file for why. There's
nothing secret to keep in a Netlify environment variable for this project;
the Firestore/Storage security rules are the actual gate, not the config
object. If that ever changes (a real API key needing to stay server-side),
Netlify sets those under **Site settings → Environment variables**, read
at build time via `import.meta.env.VITE_*` — but nothing here needs it yet.

---

## Does Netlify itself store data? (so you don't need two backends)

Short answer: it can, but not in a shape that fits this project, so the
plan stays **Netlify hosts the static site; Firebase is the entire data
layer** (Firestore + Storage + Auth), exactly as already built in
`src/cloud/`. Switching the host doesn't touch that.

What Netlify actually offers, and why each falls short of what the Studio
needs (live sync across devices, straight from the browser, with no server
code to write):

- **Netlify Blobs** — a real per-site key-value store, included on every
  plan. But it's reachable only from **Netlify Functions or Edge
  Functions** (server-side) — there's no client-side SDK the way Firestore
  has one, and no public URL for a stored file the way a Storage download
  URL works. Using it would mean writing a function for every read and
  write the Studio does, and hand-rolling the exact permission checks
  Firestore's rules already give for free.
- **Netlify DB (Postgres, via Neon)** — a real relational database,
  provisioned per-site. Same shape of limitation: only reachable from a
  Function with a connection string, never directly from the browser.
- **Neither has anything like Firestore's live listeners.** `onSnapshot` is
  what makes "upload on the phone, see it on the laptop's Studio in a
  couple of seconds, no reload" work with zero extra code. Blobs/DB would
  need polling (a function hit on an interval) or a hand-built WebSocket
  layer to get anywhere close.
- **Netlify Identity** — still supported (Netlify reversed a planned
  deprecation in Feb 2026), and could plausibly handle "only this one
  Google account can sign in." But it's a separate identity system from
  Firestore's rules (`request.auth.uid` wouldn't mean anything to it), so
  using it would mean bridging Netlify's auth into Firestore's rules
  somehow, or gating Storage/Firestore access a completely different way.

None of these are bad services — they're the right call for a project
that's *building* a small backend on Netlify from scratch. This one already
has a backend that does exactly what's needed (Firebase), so adding a
second one would mean writing real server code (the Functions layer above)
purely to duplicate what Firebase already does declaratively. Netlify's job
here stays "serve the static build fast" — the same job GitHub Pages was
doing.

Sources: [Netlify Blobs docs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/),
[Netlify Database announcement](https://www.netlify.com/blog/netlify-database/),
[Netlify Identity status update](https://www.netlify.com/blog/auth0-extension-identity-changes/).
