# Firebase setup — one-time, done by the artist (you)

Everything the Studio needs on the code side already exists (`src/cloud/`,
`firebase/*.rules`, `firebase/cors.json`). Nothing in this file requires me —
it's console clicking and pasting two things back into the repo. Do it
whenever you're ready; the site works exactly as it does today until you do
(`isCloudConfigured()` in `src/cloud/config.js` returns false with no config
pasted in, so the Studio just shows "Not connected yet" and the public site
is unaffected).

Budget the first pass at **20–30 minutes**, mostly steps 1–3. Steps 6–7 need
a second pass *after* you've deployed the site once (they need your real UID
and your real domain).

---

## 1. Create the project

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Name it anything (`gulmohar` is fine) — it doesn't appear anywhere public.
3. Decline Google Analytics (Analytics is unused here — one less thing collecting data on your own gallery).

## 2. Switch to the Blaze plan, and cap what it can cost

Firestore and Auth are free on the Spark plan with no card at all — it's
specifically **Cloud Storage for Firebase that requires Blaze**, as of a
Google policy change on **February 3, 2026**: Storage buckets now need a
linked billing account even to stay inside the free quota, on every project
(existing or new). Since the Studio needs Storage for the images, the
project needs Blaze regardless of how little Firestore alone would use.

This is a **billing card on file, not a bill**. For a single-artist gallery
this runs **$0/month** in practice — the free quota that used to define
Spark (1GB Firestore storage/50k reads/20k writes per day, 1GB Storage
stored/10GB downloaded per month) still applies on Blaze; you're only
charged for usage *above* it, which normal gallery traffic won't come close
to. The budget alert below is a tripwire, not an expectation of any charge.

1. Project settings (gear icon, top left) → **Usage and billing** → **Modify plan** → **Blaze**.
2. Attach a billing account (a card; Blaze won't charge unless you exceed the free quota).
3. **Google Cloud Console** → this project → **Billing** → **Budgets & alerts** → **Create budget** → **$1**, alert at 50%/90%/100%. You'll get an email; nothing is auto-shut-off, but $1 is far below any quota Firebase would let you hit by accident.

## 3. Register the web app, get the config

1. Project settings → **Your apps** → **</>** (web icon) → nickname it (`gulmohar-web`) → **Register app**. Skip the "add Firebase SDK" snippet Firebase shows you — the code already imports the SDK from npm.
2. Copy the `firebaseConfig` object it shows you.
3. Paste it into **`src/cloud/config.js`**, replacing `null`:

   ```js
   export const FIREBASE_CONFIG = {
       apiKey: "...",
       authDomain: "...",
       projectId: "...",
       storageBucket: "...",
       messagingSenderId: "...",
       appId: "..."
   };
   ```
4. This is safe to commit. Firebase's web config identifies the *project*, not a secret — the Firestore/Storage rules (already written, step 7) are what actually gate access. This is standard Firebase practice, not a shortcut.

## 4. Turn on Google sign-in

1. **Build → Authentication → Get started → Sign-in method** → **Google** → Enable → pick a support email → **Save**.
2. Same page, **Settings → Authorized domains**: add every origin the Studio will ever be opened from. At minimum:
   - `localhost` (usually already listed)
   - your Netlify domain(s) — see [NETLIFY.md](../NETLIFY.md) for exactly which ones
   - `vikram-sra.github.io`, only if you keep that deployment too

   A sign-in attempt from a domain not on this list fails outright, so it's
   worth double-checking after you know your final Netlify URL.

## 5. Create Firestore and Storage

1. **Build → Firestore Database → Create database.** Any region close to you (e.g. `nam5`/`us-central`) — it never faces the public directly, so latency to visitors doesn't matter. **Start in production mode** (the rules in step 7 replace the default-deny anyway).
2. **Build → Storage → Get started.** Same region as Firestore if it offers a choice. Default (locked-down) rules are fine — step 7 overwrites them.

## 6. First deploy, then find your UID

You need the site live once before finishing setup, because the Studio's
own sign-in screen is what shows you the exact UID to put in the rules — no
Firebase-console hunting required.

1. Deploy the site (see [NETLIFY.md](../NETLIFY.md)) with the config from
   step 3 already committed.
2. Open `https://<your-site>/studio/`, sign in with **your own Google
   account** (the one you'll use as the artist).
3. You'll land on "This account can't edit yet" — expected, since the rules
   below still say `ARTIST_UID`. The screen shows your real UID with a copy
   button. Copy it.

## 7. Lock the rules to that UID, then deploy them

1. Open **`firebase/firestore.rules`** and **`firebase/storage.rules`** in
   the repo. Each has exactly one `ARTIST_UID` placeholder — replace both
   with the UID from step 6.
2. Deploy them. Easiest via the Firebase CLI (installs nothing permanent —
   `npx` fetches it once):
   ```bash
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules,storage:rules --project <your-project-id>
   ```
   (`<your-project-id>` is the `projectId` from the config you pasted in
   step 3.) The console's **Firestore → Rules** / **Storage → Rules** tabs
   also have a paste-and-publish editor if you'd rather not touch the CLI —
   copy each file's contents in by hand.
3. Reload `/studio/` and sign in again — you're in.

## 8. Let Storage images load as textures (CORS)

The 3D scene loads Storage images as WebGL textures from the browser, which
needs the bucket's CORS list to include your site's origin. This one step
genuinely has no console UI — it's `gcloud`-only:

1. Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install) if you don't have it, then `gcloud auth login` and `gcloud config set project <your-project-id>`.
2. Open **`firebase/cors.json`** and make sure every origin the site is served from is listed (it already has `localhost` dev ports and a GitHub Pages placeholder — add your real Netlify domain(s), see NETLIFY.md).
3. Apply it:
   ```bash
   gcloud storage buckets update gs://<your-storage-bucket> --cors-file=firebase/cors.json
   ```
   (`<your-storage-bucket>` is the `storageBucket` value from step 3, e.g. `gulmohar-12345.firebasestorage.app`.)
4. Re-run this any time you add a new domain (a custom domain on Netlify, for instance) — CORS doesn't fail loudly in a way that's easy to place; a painting silently not appearing as a texture, or the Studio's image previews not loading, is usually this.

---

## Checklist

- [ ] Project created, Blaze enabled, $1 budget alert set
- [ ] Web app registered, config pasted into `src/cloud/config.js`
- [ ] Google sign-in enabled; authorized domains include the real deploy domain(s)
- [ ] Firestore database created
- [ ] Storage bucket created
- [ ] Site deployed once with the config committed
- [ ] Signed into `/studio/` once to get your UID
- [ ] `ARTIST_UID` replaced in both `.rules` files, rules deployed
- [ ] Real domain(s) added to `firebase/cors.json`, CORS applied with `gcloud`

## Verifying it actually worked

- Sign in with a **second** Google account (any other one) → every write
  should be refused, and a draft image's Storage URL should 403.
- Upload a painting on your phone → open the Studio on a laptop → it should
  appear within a couple of seconds with no reload (Firestore's live
  listeners, not polling).
- Publish → open the public site in a fresh private window → the new
  arrangement should be there within one reload.
- Kill your connection (airplane mode) and reload the public site → it
  should still render, from the bundled `public/paintings.json` fallback.

If any of those don't hold, it's almost always one of: the domain missing
from Authorized domains (sign-in fails outright), the UID not actually
matching in both rules files (writes silently refused), or CORS not applied
to the actual bucket name (images fail to load as textures but Storage
itself works fine, which is a confusing combination the first time you see
it).
