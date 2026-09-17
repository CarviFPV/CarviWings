# Contributing to CarviWings

Thanks for taking an interest. Bug reports, flight-model corrections, new
aircraft, missions, documentation fixes and translations of the manual are all
welcome. This page is the short version of how to get a change in; the
[Development](docs.md#development) section of the manual has the source layout
and the test suite in detail.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md), and any
contribution you make is licensed under the [GPL-3.0](LICENSE) like the rest of
the project.

## Reporting a bug

Open an [issue](https://github.com/CarviFPV/CarviWings/issues) and include:

- **What you flew** — the aircraft, the mode (free flight, intercept, race…),
  and roughly where on the globe.
- **What happened and what you expected** instead.
- **How to reproduce it**, step by step, if you can.
- **Your setup** — the release version (it is in the installer's file name,
  e.g. `CarviWings_2026.09.1_x64-setup.exe`) or the commit hash of the
  checkout, browser or desktop application, operating system, and the
  controller if one is involved.
- A **screenshot or short clip** for anything visual, and the browser console
  output for anything that crashes.

Search first; the same thing may already be reported, and a `+1` or an extra
detail on an existing issue helps more than a duplicate.

## Suggesting a feature

Open an issue and describe the problem the feature solves before the solution.
The simulator has a deliberate shape — no guns, no projectiles, everything in
the browser, no account and no server — so a proposal that fits that
shape is much more likely to land than one that changes it. If you plan to do
the work yourself, say so in the issue so nobody else starts on it.

## Setting up

[Node.js](https://nodejs.org) 20.9 or newer, npm and git. A Rust toolchain is
only needed for the desktop shell.

```bash
git clone https://github.com/CarviFPV/CarviWings.git
cd CarviWings
npm install
npm run dev                    # http://localhost:3000
```

The application asks for a free Cesium ion token on first start; the
[README](README.md#2-get-a-cesium-ion-token) explains where to get one. A
`.env.local` with `NEXT_PUBLIC_CESIUM_ION_TOKEN` does the same for a checkout.
**Never commit a real token.**

## Making a change

1. **Branch from `main`.** One change per branch, named for what it does
   (`fix/biplane-stall-hysteresis`, `feat/night-osd`).
2. **Match the code around you.** The project is TypeScript in strict mode,
   Next.js App Router, React 19 and Tailwind 4. Follow the conventions,
   naming and comment style already in the file you touch rather than
   introducing new ones.
3. **Keep the simulation framework-agnostic.** Everything under `src/sim` is
   plain TypeScript with no React, no DOM and no Cesium imports beyond the
   type-only ones already there. That is what makes it testable, so keep UI
   concerns in `src/components` and `src/state`.
4. **Add or update tests** in `src/sim/__tests__` for any change to the
   simulation — flight models, power systems, missions, AI, terrain, input,
   weather, the HUD layout. The suite has no framework dependency; copy the
   shape of an existing test file.
5. **Run the checks** before you push:

   ```bash
   npm run typecheck
   npm run test:sim
   ```

   Both must pass. A change to `src/sim/**` is not finished until they do.
   Do not add `vitest` or another runner; the project deliberately has none.

6. **Update the manual** when the behaviour a user sees changes. `docs.md` is
   the full reference and `README.md` the quick start; a new setting, key,
   aircraft or mode belongs in `docs.md` in the same section as its neighbours.

## Opening a pull request

- Target `main`.
- Say what the change does and why in the description, and reference the
  issue it addresses with a closing keyword (`Closes #12`, `Fixes #12`) so
  the issue closes when the PR is merged.
- Keep the PR focused. Refactoring that is not needed for the change goes in
  its own PR.
- Include before/after numbers for anything that touches the flight model or
  the per-frame cost (`npm run bench:sim`), and a screenshot for anything
  visual.
- Expect review comments; they are about the code, not about you. Push
  follow-up commits rather than force-pushing over the history while a review
  is in progress.

## What is out of scope

- Weapons, projectiles or anything that turns the aircraft into something
  other than the weapon it already is.
- Accounts, servers, telemetry, analytics or any network traffic beyond what
  the simulator already talks to: Cesium ion, Google Maps (optional), the
  aviationweather.gov METAR feed and SomaFM.
- Bundling CesiumJS differently; it is loaded from its prebuilt browser bundle
  on purpose.

If in doubt, open an issue and ask before writing the code.

## Releases

Releases are cut from tags by `.github/workflows/release.yml` and versioned
`YYYY.MM.N` by `scripts/release-version.mjs`. Contributors do not need to
touch the version anywhere; `package.json` and `src-tauri/Cargo.toml`
deliberately carry placeholders. See
[The desktop application](docs.md#the-desktop-application).
