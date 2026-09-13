"use client";

/**
 * Volumetric scenery: the buildings, trees and forests that terrain alone has
 * none of.
 *
 * Cesium World Terrain is a bare-earth height field, and world imagery is a
 * photograph painted onto it. A forest in that combination is a green patch of
 * texture and a town is a grey one: the mountains have real shape, everything
 * standing *on* them does not. Volume has to come from a 3D Tiles dataset laid
 * over the globe, and this module is the only place one is attached.
 *
 * Two datasets, because they answer different questions:
 *
 *  - **Cesium OSM Buildings** — every OpenStreetMap building footprint on the
 *    planet, extruded to its mapped height. Free with the ion token the
 *    simulator already needs, light enough to fly through, and it lines up with
 *    Cesium World Terrain because it was generated against it. Buildings only:
 *    OpenStreetMap does not map individual trees, so woodland stays flat.
 *  - **Google Photorealistic 3D Tiles** — a photogrammetry mesh of the real
 *    world. Buildings, trees, forests, bridges, masts and the ground they stand
 *    on, all as actual geometry. There are two ways in, and the difference is
 *    only who meters it: through Cesium ion on the token the simulator already
 *    has, which is what happens by default; or straight from Google's Map Tiles
 *    API when a Maps Platform key is configured, which bypasses the ion quota
 *    and bills Google instead. CesiumJS picks the ion route whenever no key is
 *    given.
 *
 * Buildings are incidental: if OSM cannot be reached the scenery degrades to
 * bare terrain and the reason is reported rather than thrown, because a missing
 * building is not a reason to lose the aircraft.
 *
 * Photogrammetry is not incidental. It is the world the pilot chose to fly
 * over, and quietly serving extruded footprints instead is a different flight —
 * so a photorealistic request is retried on a cold first call (the tiles come
 * from a session that has to be opened before anything streams, and that first
 * request is the slow one) and, if it still cannot be opened, reported to the
 * caller as a failure. The pilot decides whether to try again or fly the
 * buildings; the simulator does not decide it for them.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import { GOOGLE_MAPS_KEY_ENV_VAR, readGoogleMapsKey, redactGoogleKey } from "./googleKey";
import { GRAPHICS_PRESETS, type GraphicsQuality } from "./quality";

export const WORLD_DETAIL = {
  /** Terrain and imagery only — the world as it was before this module. */
  Flat: "flat",
  /** OpenStreetMap building footprints, extruded. */
  Buildings: "buildings",
  /** Google's photogrammetry mesh: buildings *and* vegetation. */
  Photorealistic: "photorealistic",
} as const;

export type WorldDetail = (typeof WORLD_DETAIL)[keyof typeof WORLD_DETAIL];

export const WORLD_DETAIL_LABELS: Record<WorldDetail, string> = {
  flat: "Terrain only",
  buildings: "Buildings",
  photorealistic: "Photorealistic",
};

/** Who serves — and meters — the tiles in the scene. */
export type SceneryRoute = "ion" | "google";

export interface SceneryOptions {
  readonly detail: WorldDetail;
  readonly quality: GraphicsQuality;
  /**
   * Narrates what the loader is doing, one line at a time.
   *
   * Opening a photogrammetry session on a cold cache takes long enough to look
   * like a hang, and a retry after a failed one takes longer still. The
   * loading screen says so rather than sitting on "Loading buildings and
   * vegetation" until it gives up.
   */
  readonly onProgress?: (detail: string) => void;
}

/**
 * How many times the photorealistic tileset is asked for before giving up.
 *
 * The first request of the day is the one that fails: it opens a tile session
 * rather than fetching a cached one, and a cold session request is slow enough
 * to time out under load. A second attempt a moment later almost always lands.
 */
const PHOTOREALISTIC_ATTEMPTS = 3;

/** Waits before the second and third attempts, milliseconds. */
const PHOTOREALISTIC_RETRY_DELAYS_MS: readonly number[] = [1500, 4000];

/**
 * Raised when photorealistic scenery was asked for and could not be delivered.
 *
 * Deliberately thrown rather than downgraded: see the module comment. The
 * message is already redacted — the Google key rides on the request URL that
 * Cesium builds its own error messages from.
 */
export class PhotorealisticUnavailableError extends Error {
  /** Which service was asked, and would be asked again by a retry. */
  readonly route: SceneryRoute;
  /** How many times it was asked before this was raised. */
  readonly attempts: number;

  constructor(
    message: string,
    options: { route: SceneryRoute; attempts: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "PhotorealisticUnavailableError";
    this.route = options.route;
    this.attempts = options.attempts;
  }
}

export interface Scenery {
  /** What the settings asked for. */
  readonly requested: WorldDetail;
  /** What is actually in the scene, which may be less. */
  readonly applied: WorldDetail;
  /** Where the tiles came from; null when there is no tileset at all. */
  readonly route: SceneryRoute | null;
  /** Every tileset attached, in the order they were added. */
  readonly tilesets: readonly Cesium.Cesium3DTileset[];
  /** Why `applied` differs from `requested`; null when nothing was downgraded. */
  readonly note: string | null;
  destroy(): void;
}

/**
 * Attaches the requested 3D scenery to a viewer.
 *
 * Rejects with a `PhotorealisticUnavailableError` when photogrammetry was asked
 * for and every attempt at it failed. Every other shortfall comes back as a
 * downgrade with a `note` explaining it.
 */
export async function loadScenery(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
  options: SceneryOptions,
): Promise<Scenery> {
  const requested = options.detail;
  if (requested === WORLD_DETAIL.Flat) {
    return inertScenery(requested, WORLD_DETAIL.Flat, null);
  }

  if (requested === WORLD_DETAIL.Photorealistic) {
    return loadPhotorealistic(cesium, viewer, options);
  }

  try {
    const tileset = await cesium.createOsmBuildingsAsync();
    applyTilesetQuality(tileset, options.quality);
    viewer.scene.primitives.add(tileset);
    return attachedScenery(viewer, {
      requested,
      applied: WORLD_DETAIL.Buildings,
      route: "ion",
      tilesets: [tileset],
      note: null,
      hidGlobe: false,
    });
  } catch (error) {
    const failure =
      `Cesium OSM Buildings could not be loaded (${describeFailure(error)}).` +
      " Flying over bare terrain.";
    return inertScenery(requested, WORLD_DETAIL.Flat, failure);
  }
}

/**
 * Opens the photogrammetry tileset, retrying a cold first request.
 *
 * A Maps Platform key is optional: without one the tiles come through ion on
 * the token that is already configured. With one they come straight from
 * Google, which is what a project past ion's free monthly allowance wants.
 */
async function loadPhotorealistic(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
  options: SceneryOptions,
): Promise<Scenery> {
  const key = readGoogleMapsKey();
  const route: SceneryRoute = key ? "google" : "ion";
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= PHOTOREALISTIC_ATTEMPTS; attempt += 1) {
    if (attempt === 1) {
      options.onProgress?.("Opening the photogrammetry tile session...");
    } else {
      const step = Math.min(attempt - 2, PHOTOREALISTIC_RETRY_DELAYS_MS.length - 1);
      const delay = PHOTOREALISTIC_RETRY_DELAYS_MS[step] ?? 0;
      options.onProgress?.(
        `Photogrammetry did not answer (${describeFailure(lastError)}). ` +
          `Retrying, attempt ${attempt} of ${PHOTOREALISTIC_ATTEMPTS}...`,
      );
      await delayFor(delay);
    }

    // The flight can be abandoned while a retry is waiting; there is nothing
    // left to attach the tiles to.
    if (viewer.isDestroyed()) {
      return inertScenery(WORLD_DETAIL.Photorealistic, WORLD_DETAIL.Flat, null);
    }

    try {
      const tileset = await createPhotorealisticTileset(cesium, key, options.quality);
      if (viewer.isDestroyed()) {
        if (!tileset.isDestroyed()) tileset.destroy();
        return inertScenery(WORLD_DETAIL.Photorealistic, WORLD_DETAIL.Flat, null);
      }
      viewer.scene.primitives.add(tileset);
      // Photogrammetry carries its own ground. Left visible underneath it the
      // globe z-fights with that ground and shows through as flickering
      // patches of satellite image, so it goes away while these tiles are up.
      viewer.scene.globe.show = false;
      return attachedScenery(viewer, {
        requested: WORLD_DETAIL.Photorealistic,
        applied: WORLD_DETAIL.Photorealistic,
        route,
        tilesets: [tileset],
        note:
          attempt === 1
            ? null
            : `Photorealistic 3D tiles needed ${attempt} attempts to open.`,
        hidGlobe: true,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw new PhotorealisticUnavailableError(
    key
      ? `Google's photorealistic 3D tiles could not be opened with the key in ` +
          `${GOOGLE_MAPS_KEY_ENV_VAR} after ${PHOTOREALISTIC_ATTEMPTS} attempts ` +
          `(${describeFailure(lastError)}).`
      : `Photorealistic 3D tiles could not be opened through Cesium ion after ` +
          `${PHOTOREALISTIC_ATTEMPTS} attempts (${describeFailure(lastError)}). ` +
          `The ion account may not have the Google Photorealistic 3D Tiles asset ` +
          `added, or its monthly allowance may be spent.`,
    { route, attempts: PHOTOREALISTIC_ATTEMPTS, cause: lastError },
  );
}

/**
 * Google's tileset, tuned for a camera that moves at aircraft speed.
 *
 * Passing no key is deliberate rather than a fallback: CesiumJS then resolves
 * the tileset as ion asset 2275207 and it is served on the ion token, which is
 * the cheapest way in for a small project. A key routes around ion entirely.
 *
 * `onlyUsingWithGoogleGeocoder` is Google's licence condition either way: the
 * tiles may not be paired with a competing geocoder. The simulator ships no
 * geocoder at all — `geocoder: false` on the viewer, and missions are flown
 * from stored coordinates — so the condition holds trivially.
 */
async function createPhotorealisticTileset(
  cesium: CesiumModule,
  key: string | null,
  quality: GraphicsQuality,
): Promise<Cesium.Cesium3DTileset> {
  const preset = GRAPHICS_PRESETS[quality];
  return cesium.createGooglePhotorealistic3DTileset(
    key
      ? { key, onlyUsingWithGoogleGeocoder: true }
      : { onlyUsingWithGoogleGeocoder: true },
    {
      maximumScreenSpaceError: preset.tilesetScreenSpaceError,
      cacheBytes: preset.tilesetCacheBytes,
      maximumCacheOverflowBytes: preset.tilesetCacheBytes,
      // The view is nearly always a shallow forward one from a few hundred
      // metres up, where most of the screen is ground receding to the horizon.
      // Relaxing detail gently with distance is what keeps that affordable.
      // Gently is the whole of it: these are Cesium's own figures for this
      // dataset, and they take about a quarter off a tile's threshold at the
      // far end rather than stopping it refining there. A hard roll-off bounded
      // to the mission radius was tried instead, and it cost the picture
      // without buying the frames — what costs the frames is streaming during
      // flight, not the far side of the valley being sharp.
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 0.00278,
      dynamicScreenSpaceErrorFactor: 4,
      // Refining a tile only once its whole level is in place gives a stable
      // picture; the pop-in of skipped levels is very visible at speed.
      skipLevelOfDetail: false,
      preloadWhenHidden: false,
      // See `loadTheWholeView`, which is the same decision for the tilesets
      // that are configured after they are built.
      foveatedScreenSpaceError: false,
    },
  );
}

function applyTilesetQuality(
  tileset: Cesium.Cesium3DTileset,
  quality: GraphicsQuality,
): void {
  const preset = GRAPHICS_PRESETS[quality];
  tileset.maximumScreenSpaceError = preset.tilesetScreenSpaceError;
  tileset.cacheBytes = preset.tilesetCacheBytes;
  tileset.maximumCacheOverflowBytes = preset.tilesetCacheBytes;
  tileset.preloadWhenHidden = false;
  loadTheWholeView(tileset);
}

/**
 * Turns off the foveation Cesium applies by default.
 *
 * Left on, a tileset defers the tiles away from the middle of the screen and
 * lets them arrive once the camera has been still for a moment — a sensible
 * default for a mouse dragging a globe around. In an aircraft it is the
 * opposite of what is wanted: the edge of the screen is where the next second
 * of flight comes from, the camera never stops turning, so the deferral never
 * lifts and the tiles arrive mid-turn instead of on the loading screen. The
 * preload sweep exists to have the whole circle in the cache before take-off,
 * and foveation would quietly decline to fetch most of it.
 */
function loadTheWholeView(tileset: Cesium.Cesium3DTileset): void {
  tileset.foveatedScreenSpaceError = false;
}

/**
 * How long a tileset's queue has to stay empty before the view counts as
 * complete, milliseconds.
 *
 * `tilesLoaded` goes true every time the queue happens to drain — between two
 * camera moves, or after the low-detail pass that arrives first. Only a queue
 * that stays empty means there is nothing more coming for this view.
 */
const SETTLE_MS = 1200;

/** How often the wait re-examines the tileset, milliseconds. */
const POLL_MS = 150;

export interface SceneryWaitOptions {
  /**
   * Give up after this long with nothing arriving at all, milliseconds. The
   * budget is a stall budget rather than a total one: a mesh that is still
   * streaming is still worth waiting for, however long it takes, and one that
   * has stopped arriving will not start again by being waited on.
   */
  readonly stallMs: number;
  /** Hard ceiling on the whole wait, milliseconds. */
  readonly timeoutMs: number;
  /**
   * How long the queue has to stay empty to count as settled, milliseconds.
   *
   * Defaults to the figure a take-off is gated on. A caller that is only
   * prefetching — the preload sweep round the field, which is looking at views
   * nothing is about to be drawn from — can afford a shorter one: it wants the
   * requests issued and landed, not a guarantee that the view is complete.
   */
  readonly settleMs?: number;
  /** 0..1 across the tiles known to be outstanding. */
  readonly onProgress?: (fraction: number) => void;
}

/**
 * Waits for the scenery around the camera to finish streaming.
 *
 * Resolves `true` when every tileset settled and `false` when one of them ran
 * out of budget first, so the caller can say the world is incomplete rather
 * than pretend it is not.
 *
 * This is what stands between a photogrammetry flight and taking off over a
 * hole in the world: with the globe hidden there is no terrain queue to wait on
 * — `Globe.tilesLoaded` reports "loaded" over an empty scene — and the
 * tileset's own `initialTilesLoaded` will already have fired for whatever the
 * camera was looking at before it was aimed at the spawn.
 */
export function waitForSceneryStreamed(
  scenery: Scenery,
  options: SceneryWaitOptions,
): Promise<boolean> {
  if (scenery.tilesets.length === 0) {
    options.onProgress?.(1);
    return Promise.resolve(true);
  }

  const fractions = scenery.tilesets.map(() => 0);
  const report = (index: number, fraction: number): void => {
    fractions[index] = fraction;
    options.onProgress?.(Math.min(...fractions));
  };

  return Promise.all(
    scenery.tilesets.map((tileset, index) =>
      waitForTilesetSettled(tileset, {
        ...options,
        onProgress: (fraction) => report(index, fraction),
      }),
    ),
  ).then((results) => results.every(Boolean));
}

function waitForTilesetSettled(
  tileset: Cesium.Cesium3DTileset,
  options: SceneryWaitOptions,
): Promise<boolean> {
  if (tileset.isDestroyed()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const settleMs = options.settleMs ?? SETTLE_MS;
    const started = Date.now();
    let lastActivity = started;
    let idleSince: number | null = null;
    let peakQueue = 1;
    let settled = false;

    const onLoadProgress = (pending: number, processing: number): void => {
      const queue = pending + processing;
      lastActivity = Date.now();
      if (queue > peakQueue) peakQueue = queue;
      options.onProgress?.(queue === 0 ? 1 : 1 - queue / peakQueue);
    };

    const finish = (complete: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!tileset.isDestroyed()) {
        tileset.loadProgress.removeEventListener(onLoadProgress);
      }
      options.onProgress?.(1);
      resolve(complete);
    };

    const poll = setInterval(() => {
      const now = Date.now();
      // A destroyed tileset belongs to an abandoned flight, which nothing is
      // waiting on any more.
      if (tileset.isDestroyed()) {
        finish(true);
        return;
      }
      if (!tileset.tilesLoaded) idleSince = null;
      else if (idleSince === null) idleSince = now;

      if (idleSince !== null && now - idleSince >= settleMs) finish(true);
      else if (now - lastActivity >= options.stallMs) finish(false);
      else if (now - started >= options.timeoutMs) finish(false);
    }, POLL_MS);

    tileset.loadProgress.addEventListener(onLoadProgress);
  });
}

function delayFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function attachedScenery(
  viewer: Cesium.Viewer,
  parts: {
    requested: WorldDetail;
    applied: WorldDetail;
    route: SceneryRoute;
    tilesets: Cesium.Cesium3DTileset[];
    note: string | null;
    hidGlobe: boolean;
  },
): Scenery {
  let destroyed = false;
  return {
    requested: parts.requested,
    applied: parts.applied,
    route: parts.route,
    tilesets: parts.tilesets,
    note: parts.note,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      // A destroyed viewer has already taken its primitives with it.
      if (viewer.isDestroyed()) return;
      if (parts.hidGlobe) viewer.scene.globe.show = true;
      for (const tileset of parts.tilesets) {
        if (!tileset.isDestroyed()) viewer.scene.primitives.remove(tileset);
      }
    },
  };
}

function inertScenery(
  requested: WorldDetail,
  applied: WorldDetail,
  note: string | null,
): Scenery {
  return { requested, applied, route: null, tilesets: [], note, destroy: () => {} };
}

/**
 * A short, key-free description of why a tileset failed.
 *
 * Cesium reports request failures with the full URL, and the Google key rides
 * on it as a query parameter — so every message is redacted before it can reach
 * a console, the debug overlay or a bug report.
 */
function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = redactGoogleKey(raw).trim();
  if (safe.length === 0) return "no reason given";
  return safe.length > 160 ? `${safe.slice(0, 157)}...` : safe;
}
