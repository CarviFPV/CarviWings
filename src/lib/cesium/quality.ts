/**
 * Graphics presets.
 *
 * Plain data, deliberately free of Cesium: the settings UI and the persisted
 * settings store both read these, and neither should have to pull the viewer —
 * or the scenery loader that also reads them — in behind it.
 *
 * A preset is where a flight starts *and* where it stays. Nothing lowers these
 * behind the pilot's back: what is asked for on the menu is what is drawn, for
 * the whole flight. The frames are found by fetching the world before the
 * flight instead of during it; see `sim/render/preloadPlan`.
 *
 * The caches are sized for that. A preload that is evicted before the pilot
 * turns into it was a wait for nothing, and the tile that has to be fetched
 * again is fetched in a frame somebody is flying — which is the one place this
 * simulator will not spend. So every preset holds rather more than the view in
 * front of it, and the higher ones hold most of a mission area.
 *
 * Which preset a pilot *starts* on is a different question, and `auto` is the
 * answer to it: the machine is asked what GPU is in it and given the preset
 * that GPU is good for, once, before the flight. See `sim/render/gpuProfile.ts`
 * for what is read and what is concluded, and `lib/gpuProbe.ts` for the asking.
 */

import type { GraphicsQualityName } from "@/sim/render/gpuProfile";

export const GRAPHICS_PRESETS = {
  low: {
    label: "Low",
    resolutionScale: 0.75,
    maximumScreenSpaceError: 8,
    tileCacheSize: 300,
    terrainNormals: false,
    fxaa: false,
    /** Multisampling; one sample is none. */
    msaaSamples: 1,
    /** Screen-space error for 3D tilesets; higher is coarser and cheaper. */
    tilesetScreenSpaceError: 32,
    /** Tile cache for 3D tilesets, in bytes. */
    tilesetCacheBytes: 384 * 1024 * 1024,
  },
  medium: {
    label: "Medium",
    resolutionScale: 1,
    maximumScreenSpaceError: 4,
    tileCacheSize: 600,
    terrainNormals: true,
    fxaa: true,
    msaaSamples: 2,
    tilesetScreenSpaceError: 20,
    tilesetCacheBytes: 768 * 1024 * 1024,
  },
  high: {
    label: "High",
    resolutionScale: 1,
    maximumScreenSpaceError: 2,
    tileCacheSize: 1000,
    terrainNormals: true,
    fxaa: true,
    msaaSamples: 2,
    tilesetScreenSpaceError: 16,
    tilesetCacheBytes: 1152 * 1024 * 1024,
  },
  ultra: {
    label: "Ultra",
    resolutionScale: 1,
    maximumScreenSpaceError: 1.5,
    tileCacheSize: 1600,
    terrainNormals: true,
    fxaa: true,
    msaaSamples: 2,
    tilesetScreenSpaceError: 12,
    tilesetCacheBytes: 1536 * 1024 * 1024,
  },
  // The names are the GPU profile's, so that what recommends a preset and what
  // defines one cannot drift apart without this failing to compile.
} as const satisfies Record<GraphicsQualityName, unknown>;

export type GraphicsQuality = keyof typeof GRAPHICS_PRESETS;

/** The pilot's other option: let the machine pick, from the GPU it has. */
export const GRAPHICS_QUALITY_AUTO = "auto";

/**
 * What the settings screen stores: a preset, or the instruction to choose one.
 *
 * `auto` is resolved to a preset by `lib/gpuProbe.ts` at the point a viewer is
 * built, and nowhere else — everything downstream of that is handed a real
 * preset and never has to know a pilot was not the one who picked it.
 */
export type GraphicsQualityChoice =
  | GraphicsQuality
  | typeof GRAPHICS_QUALITY_AUTO;

export function isGraphicsQualityChoice(
  value: unknown,
): value is GraphicsQualityChoice {
  // `hasOwn` rather than `in`: every object has a `toString`, and a stored
  // block that had been edited to say so would otherwise pass for a preset.
  return (
    value === GRAPHICS_QUALITY_AUTO ||
    (typeof value === "string" && Object.hasOwn(GRAPHICS_PRESETS, value))
  );
}
