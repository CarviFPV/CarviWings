/**
 * How much of the world is fetched before the pilot is handed the sticks.
 *
 * There are two ways to make a flight hold its frame rate over streamed
 * terrain. One is to ask for less world: bound the detail to the mission, roll
 * the tile refinement off with distance, and give up multisampling and render
 * scale when the frames run short. That was tried, and it was worse in the way
 * that matters — the picture got softer *and* the stutters stayed, because the
 * cost was never the far side of the valley in the first place. It was
 * everything arriving at once, through one main thread, in the seconds the
 * pilot was flying.
 *
 * So this is the other way, and the only one now: ask for all of it, and ask
 * before the flight starts. Every tile fetched, decoded and uploaded under the
 * loading screen is one that is not fetched, decoded and uploaded in a frame
 * somebody is flying — and the loading screen is the one place in a simulator
 * where time costs nothing.
 *
 * What is here is the arithmetic of that: how far round the compass the loading
 * camera looks, how high it climbs to stage the distance, and how much ground
 * the elevation cache is filled over. No Cesium, so it can be checked in Node
 * rather than judged by squinting at a frame counter.
 */

import { clamp } from "../math/scalar";

/**
 * How many directions the loading camera looks in, the opening view included.
 *
 * Parked on the start heading, what has streamed by the time the loading screen
 * comes down is the wedge of world the flight opens facing — and the first
 * thing anybody does with a wing is turn out of it. Eight points of the compass
 * at a ninety-degree frustum is the whole circle with half a view of overlap on
 * each side, so a turn of any radius stays inside ground that has already
 * arrived.
 */
export const SWEEP_LEGS = 8;

/**
 * How high the overview pass climbs, as a multiple of the mission radius.
 *
 * The sweep is flown at the height the flight opens at, which stages the ground
 * and the near buildings but not the valley behind them: from two hundred
 * metres most of the district is behind the first ridge. One pass from height
 * puts the whole mission area and the country around it in one frustum, which
 * is what a climb — or a look at the horizon — would otherwise fetch in flight.
 */
const OVERVIEW_HEIGHT_FACTOR = 1.2;

/** The overview pass is never flown lower than this, metres. */
export const MIN_OVERVIEW_HEIGHT = 900;

/**
 * Or higher than this, metres.
 *
 * Past a few kilometres up the tiles in frame are the coarse levels of half a
 * country, which is a great deal of data staged for a view nobody flies.
 */
export const MAX_OVERVIEW_HEIGHT = 4500;

/**
 * How much of the pilot's view distance the overview pass stages, as a
 * fraction.
 *
 * View distance is a fog setting: it decides how thick the air is, not where
 * the frustum ends. A pilot who has pulled it in to three kilometres cannot see
 * the far hills whatever is loaded, so climbing to stage them is a wait with
 * nothing at the end of it.
 */
const OVERVIEW_VIEW_FRACTION = 0.35;

/**
 * The elevation cache is filled over the whole mission area, floored at this,
 * metres.
 *
 * The height field the flight model reads is not the terrain being drawn: it is
 * sampled through its own service, in batches, over the network. Filling the
 * whole mission area means a flight that never leaves its own airspace — which
 * is nearly every flight — asks for no elevation at all once it is airborne.
 *
 * A wing covers a kilometre and a half in its first minute, which is exactly
 * the minute the stutter used to be in, so even the smallest field gets that
 * much ground resolved around it.
 */
export const MIN_TERRAIN_RADIUS = 1600;

/**
 * Or more than this, metres.
 *
 * The grid is a hundred metres on a side and the cell count goes as the square
 * of this, so a fifty-kilometre mission is not fifty kilometres of prefill — it
 * is this, and the rest is warmed along the flight path as it always was.
 */
export const MAX_TERRAIN_RADIUS = 4000;

/** How long one leg of the sweep may take, milliseconds. */
const LEG_BUDGET_MS = 3000;
/** And one leg over photogrammetry, where a single view is a lot of mesh. */
const HEAVY_LEG_BUDGET_MS = 5000;
/** How long the overview pass may take, milliseconds. */
const OVERVIEW_BUDGET_MS = 5000;
/** And over photogrammetry. */
const HEAVY_OVERVIEW_BUDGET_MS = 8000;

/**
 * However much the arithmetic asks for, the sweep gives up after this,
 * milliseconds.
 *
 * A budget rather than a promise. Loading time is the currency this whole
 * module spends, but a pilot on a slow link still has to be able to reach a
 * flight, and nothing here gates the take-off: the view the flight actually
 * opens on was already waited for properly, and a leg that did not arrive is a
 * leg that streams in flight, which is where it was coming from before.
 */
export const MAX_SWEEP_BUDGET_MS = 45000;

export interface PreloadInputs {
  /** Mission radius in metres — the piece of sky the flight happens in. */
  readonly missionRadius: number;
  /** The pilot's view-distance setting, kilometres. */
  readonly viewDistanceKm: number;
  /**
   * Whether the scenery is photogrammetry.
   *
   * A photorealistic view is an order of magnitude more data than extruded
   * footprints over a height field, so every leg is given longer before it is
   * abandoned — it is also the case where arriving in flight hurts most.
   */
  readonly heavy?: boolean;
}

export interface PreloadPlan {
  /**
   * Bearings the loading camera looks along, in degrees off the start heading.
   *
   * The opening view — zero — is not among them: it has already been aimed at
   * and waited for by the time the sweep starts.
   */
  readonly bearings: readonly number[];
  /** Metres above the field the overview pass is flown from. */
  readonly overviewHeight: number;
  /** Metres of ground the elevation cache is filled over before take-off. */
  readonly terrainRadius: number;
  /** Milliseconds the sweep and the overview pass share. */
  readonly budgetMs: number;
}

/** Where the loading camera looks, evenly round the compass. */
export function sweepBearings(): readonly number[] {
  const bearings: number[] = [];
  for (let leg = 1; leg < SWEEP_LEGS; leg += 1) {
    bearings.push((leg * 360) / SWEEP_LEGS);
  }
  return bearings;
}

/** How high the overview pass is flown for a mission of this size. */
export function overviewHeightFor(
  missionRadius: number,
  viewDistanceKm: number,
): number {
  const throughTheAir =
    Math.max(viewDistanceKm, 0) * 1000 * OVERVIEW_VIEW_FRACTION;
  const ceiling = Math.max(
    Math.min(MAX_OVERVIEW_HEIGHT, throughTheAir),
    MIN_OVERVIEW_HEIGHT,
  );
  return clamp(
    Math.max(missionRadius, 0) * OVERVIEW_HEIGHT_FACTOR,
    MIN_OVERVIEW_HEIGHT,
    ceiling,
  );
}

/** How much ground the elevation cache is filled over before take-off. */
export function terrainPrefillRadius(missionRadius: number): number {
  return clamp(missionRadius, MIN_TERRAIN_RADIUS, MAX_TERRAIN_RADIUS);
}

/** Everything the loading sequence has to be told, in one object. */
export function preloadPlanFor(inputs: PreloadInputs): PreloadPlan {
  const heavy = inputs.heavy ?? false;
  const bearings = sweepBearings();
  // The legs, the overview, and the return to the opening view at the end.
  const legs = bearings.length + 1;
  const budgetMs = Math.min(
    legs * (heavy ? HEAVY_LEG_BUDGET_MS : LEG_BUDGET_MS) +
      (heavy ? HEAVY_OVERVIEW_BUDGET_MS : OVERVIEW_BUDGET_MS),
    MAX_SWEEP_BUDGET_MS,
  );

  return {
    bearings,
    overviewHeight: overviewHeightFor(
      inputs.missionRadius,
      inputs.viewDistanceKm,
    ),
    terrainRadius: terrainPrefillRadius(inputs.missionRadius),
    budgetMs,
  };
}
