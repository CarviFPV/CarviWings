# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

CarviWings: a browser FPV interception simulator — three fixed wings, a
foam-board triplane, a twin-boom foam warbird, a foam-board biplane, two
multirotors and the five petrol Skyeye UAVs — flown over the real Earth
(Cesium terrain/imagery), with from-scratch fixed-wing and multirotor flight
models, electric and combustion power systems, HUD, environment
simulation, enemy AI, mission system, and controller support. `README.md` is the
quick start and the checkout instructions; `docs.md` is the full feature
rundown (a free Cesium ion token is required to load a world; it is
entered on the first-run screen, or supplied in `.env.local` for a build run
from a checkout).

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run test:sim` — compile and run the simulation test suite
- `npm run bench:sim` — compile and run the simulation benchmarks
- `npm run desktop:dev` — the desktop window, on a live dev server (needs Rust)
- `npm run desktop:build` — the packaged desktop application

Run `npm run typecheck` and `npm run test:sim` before considering a change
to `src/sim/**` complete.

Never run `vitest` (directly or via `npm test`/`npx vitest`). Only run
lint checks in this repository.

## Layout

- `src/app` — Next.js app routes
- `src/components` — React UI: `flight`, `hud`, `screens`, `ui`
- `src/lib` — Cesium setup/environment helpers, audio
- `src/sim` — the simulation core (physics, flight, AI, mission, terrain,
  input, math, render, environment, hud, player), framework-agnostic and
  covered by `test:sim`
- `src/state` — app/store state
- `src-tauri` — the Tauri v2 desktop shell around a static export of the same
  app. That export has no server, so the two `app/api` route handlers are named
  `route.web.ts` and left out of it by `pageExtensions`; `src/lib/desktop`
  covers what they did. Releases are cut by `.github/workflows/release.yml` and
  versioned `YYYY.MM.N` by `scripts/release-version.mjs`. See `docs.md`.

## Working an issue

When asked to work on an issue referenced by number (e.g. "solve #20",
or just "#20"):

1. Look up that issue in this repository (title, body, comments) before
   making changes, and scope the work to what it actually asks for.
2. Implement and test the fix on a branch, following the conventions
   already used in the touched code.
3. When opening the pull request, always include a closing keyword
   referencing the issue in the PR body (e.g. `Closes #20`, or
   `Fixes #20` for a bug), so the issue closes automatically when the PR
   is merged. Use the correct issue number — never omit this.
