/**
 * Runs Next for the desktop application.
 *
 * The packaged build needs two environment variables set — `NEXT_PUBLIC_DESKTOP`
 * for the code paths that differ inside the shell, `DESKTOP_EXPORT` for the
 * static export `next.config.ts` switches to — and the Tauri CLI runs its
 * before-commands through whatever shell the machine has. `VAR=1 next build` is
 * not a thing `cmd.exe` understands, and the release is built on Windows, so
 * the variables are set here instead and Next is started from Node directly.
 *
 * Two modes:
 *
 *   node scripts/desktop-frontend.mjs dev     the dev server the shell window
 *                                             points at, routes and all
 *   node scripts/desktop-frontend.mjs build   the static export in `out/`,
 *                                             which is what gets packaged
 *
 * `dev` deliberately leaves `DESKTOP_EXPORT` unset: developing against a real
 * dev server is worth more than matching the packaged build exactly, and the
 * two route handlers it keeps are what make the radio audible on localhost.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODES = new Set(["dev", "build"]);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];

if (!MODES.has(mode)) {
  console.error(
    `[desktop] usage: node scripts/desktop-frontend.mjs <${[...MODES].join("|")}>`,
  );
  process.exit(1);
}

/** Runs a Node script to completion, inheriting stdio, and resolves its code. */
function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_PUBLIC_DESKTOP: "1",
        ...(mode === "build" ? { DESKTOP_EXPORT: "1" } : {}),
      },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${script} was killed by ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

// Same staging the `predev` / `prebuild` hooks do for the web build: Cesium's
// runtime assets have to be under `public/` before Next copies them into the
// export.
const staged = await run(join(root, "scripts", "copy-cesium.mjs"));
if (staged !== 0) process.exit(staged);

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
process.exit(await run(next, [mode]));
