/**
 * Stages CesiumJS as a static asset under `public/cesium`.
 *
 * Two things are copied:
 *
 *  - `Workers`, `Assets`, `Widgets` and `ThirdParty`, which Cesium fetches at
 *    runtime from `CESIUM_BASE_URL` rather than importing.
 *  - `Cesium.js`, Cesium's own prebuilt browser bundle.
 *
 * The library is loaded from that bundle at runtime instead of being pushed
 * through the application bundler. Cesium ships several megabytes of embedded
 * binary payloads (Draco, Basis, meshopt) as escaped string literals, and
 * re-minifying them corrupts the escapes — Turbopack emits a raw NUL byte as
 * `\0` immediately followed by a literal `0`, which re-parses as an illegal
 * octal escape and makes the whole chunk fail to load. Cesium's own bundle is
 * already minified and correct, so serving it untouched avoids the problem
 * entirely and keeps a 4.8 MB blob out of the application build.
 *
 * Runs automatically via the `predev` / `prebuild` npm hooks.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "cesium", "Build", "Cesium");
const target = join(root, "public", "cesium");
const stampFile = join(target, ".cesium-version");

const DIRECTORIES = ["Assets", "ThirdParty", "Widgets", "Workers"];
const FILES = ["Cesium.js"];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(source))) {
    console.error(
      "[copy-cesium] node_modules/cesium/Build/Cesium not found. Run `npm install` first.",
    );
    process.exit(1);
  }

  const pkg = JSON.parse(
    await readFile(join(root, "node_modules", "cesium", "package.json"), "utf8"),
  );

  // Skip the copy when the already-copied assets match the installed version.
  if (await exists(stampFile)) {
    const stamp = (await readFile(stampFile, "utf8")).trim();
    if (stamp === pkg.version) {
      console.log(`[copy-cesium] public/cesium already at ${pkg.version}`);
      return;
    }
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const directory of DIRECTORIES) {
    await cp(join(source, directory), join(target, directory), {
      recursive: true,
    });
  }

  for (const file of FILES) {
    await cp(join(source, file), join(target, file));
  }

  await writeFile(stampFile, `${pkg.version}\n`, "utf8");
  console.log(`[copy-cesium] copied Cesium ${pkg.version} assets to public/cesium`);
}

await main();
