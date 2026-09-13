/**
 * Works out which version the next release is, and stamps it into the build.
 *
 * Versions are dated rather than numbered: `2026.09.1` is the first release of
 * September 2026, `2026.09.2` the second, and October starts again at
 * `2026.10.1`. The year and month come from the clock (UTC, so a release built
 * either side of midnight cannot disagree with itself), and the counter comes
 * from the tags already in the repository — which means the answer is the same
 * whoever asks and whenever, and a release that was never tagged never happened.
 *
 * Two spellings of the same number come out of this, because Windows and
 * Cargo will not accept the one the release is called:
 *
 *   display   2026.09.1   the tag, the release, the file people download
 *   semver    2026.9.1    `Cargo.toml` and `tauri.conf.json`, which parse it
 *                         as semver and reject a leading zero
 *
 * Usage:
 *
 *   node scripts/release-version.mjs                 what the next release is
 *   node scripts/release-version.mjs --apply         ...and stamp it in
 *   node scripts/release-version.mjs --version 2026.09.4 --apply
 *
 * With `GITHUB_OUTPUT` set the three values are written there as well, which is
 * how `.github/workflows/release.yml` picks them up.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** `2026.09.1` — four-digit year, two-digit month, then the count from one. */
const DISPLAY = /^(\d{4})\.(0[1-9]|1[0-2])\.([1-9]\d*)$/;

/** The display version as Cargo and Tauri want it: no leading zero anywhere. */
export function toSemver(display) {
  const match = DISPLAY.exec(display);
  if (!match) throw new Error(`not a release version: ${display}`);
  const [, year, month, count] = match;
  return `${Number(year)}.${Number(month)}.${Number(count)}`;
}

/**
 * The next release version for a month, given the tags that already exist.
 *
 * Tags that are not releases of this month are ignored, including the ones
 * shaped like a release of some other month, so the count is always "how many
 * times have we released in September" and never "how many tags are there".
 */
export function nextVersion(tags, year, month) {
  const prefix = `v${year}.${month}.`;
  let highest = 0;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const count = Number(tag.slice(prefix.length));
    if (!Number.isInteger(count) || count < 1) continue;
    if (count > highest) highest = count;
  }
  return `${year}.${month}.${highest + 1}`;
}

/** Every tag in the checkout. Empty if this is not a repository with any. */
function readTags() {
  try {
    return execFileSync("git", ["tag", "--list"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Replaces the `version` of a JSON file without disturbing anything else. */
function stampJson(path, semver) {
  const source = readFileSync(path, "utf8");
  const stamped = source.replace(
    /^(\s*"version"\s*:\s*)"[^"]*"/m,
    `$1"${semver}"`,
  );
  if (stamped === source) {
    throw new Error(`no "version" to stamp in ${path}`);
  }
  writeFileSync(path, stamped, "utf8");
}

/** The same, for the `version` under `[package]` in a Cargo manifest. */
function stampCargo(path, semver) {
  const source = readFileSync(path, "utf8");
  const stamped = source.replace(
    /^(version\s*=\s*)"[^"]*"/m,
    `$1"${semver}"`,
  );
  if (stamped === source) {
    throw new Error(`no version to stamp in ${path}`);
  }
  writeFileSync(path, stamped, "utf8");
}

function main(argv) {
  const apply = argv.includes("--apply");
  // A version can also arrive in `RELEASE_VERSION`, which is how the workflow
  // passes an optional one along without having to build the flag conditionally.
  const asked = argv.includes("--version")
    ? argv[argv.indexOf("--version") + 1]
    : process.env.RELEASE_VERSION?.trim() || null;

  let display;
  if (asked !== null && asked !== undefined) {
    if (!DISPLAY.test(asked)) {
      throw new Error(`a version looks like 2026.09.1, not ${asked || "nothing"}`);
    }
    display = asked;
  } else {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    display = nextVersion(readTags(), year, month);
  }

  const semver = toSemver(display);
  const tag = `v${display}`;

  if (apply) {
    stampJson(join(root, "src-tauri", "tauri.conf.json"), semver);
    stampCargo(join(root, "src-tauri", "Cargo.toml"), semver);
    console.log(`[release] stamped ${semver} into the desktop build`);
  }

  console.log(`display=${display}`);
  console.log(`semver=${semver}`);
  console.log(`tag=${tag}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `display=${display}\nsemver=${semver}\ntag=${tag}\n`,
    );
  }
}

// Only when run as a command: the two functions above are exported so they can
// be imported and checked without stamping anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
