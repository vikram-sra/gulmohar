# Future Session Notes

## Current Status & Next Steps

### 1. GitHub Pages Deployment
- **Workflow**: Automated build and deployment configured in `.github/workflows/deploy.yml`.
- **Pages Setting Required**: In GitHub repo settings (`Settings` → `Pages` → `Build and deployment` → `Source`), ensure **"GitHub Actions"** is selected (not "Deploy from a branch").
- **Known Issue Resolved**: "Failed to resolve module specifier 'three'" happens when GitHub Pages serves unbundled source files instead of Vite's `dist/`. Once GitHub Actions deploys the bundled build, this error will be resolved.

### 2. Recent Updates Completed
- **Day/Night Transition**: Replaced abrupt lighting thresholds with continuous `smoothstep` blending across all sun/moon transitions in `src/sky/celestial.js` and `main.js`.
- **Color Blending**: Fixed `THREE.Color` math using custom `blend3Colors` helper.
- **Fallen Trees**: Scaled down fallen tree assets for better scene balance.
- **Git Repo**: Remote linked at `https://github.com/vikram-sra/gulmohar.git`.

### 3. Open Tasks & Performance Goals
- **Mobile Performance**: Profile shadow map resolution and update frequency on mobile devices.
- **Loading Sequence**: Check camera settling behavior into the default view after asset load.
- **Performance & Asset Loading**: Check texture compressions and lazy loading for 3D assets in `3d_Assets/` and paintings.
