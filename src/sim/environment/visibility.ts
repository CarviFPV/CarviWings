/**
 * Visibility.
 *
 * Answers one question — how well can this aircraft see that one — and answers
 * it the same way for the player's HUD and for the enemy AI that arrives in the
 * next phase. Detection must never be a matter of simply knowing where everyone
 * is, so every lookup goes through here.
 *
 * Four things reduce visibility:
 *
 *   - **range**, faded against the weather's sight range
 *   - **cloud**, in proportion to how much of the sight line runs through the
 *     layer, and heavily if either aircraft is inside it
 *   - **light**, so a night intercept has to be flown much closer
 *   - **terrain**, which either blocks the line of sight outright or clutters
 *     the background when looking down at a contact
 *
 * Terrain is sampled from the cached elevation field, so this performs no I/O
 * and can be called freely from the simulation.
 */

import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS } from "../flight/state";
import type { TerrainSampler } from "../terrain/types";
import { hasLineOfSight } from "../terrain/lineOfSight";
import type { ResolvedCloudLayer, WeatherProfile } from "./types";
import { WEATHER_PROFILES, WEATHER } from "./types";

/** A deck as this system sees it: where it is, and how much it hides. */
export interface VisibilityLayer {
  /** Bounds in local ENU metres. */
  readonly baseZ: number;
  readonly topZ: number;
  /** How much of a sight line through it is lost, 0..1. */
  readonly opacity: number;
}

export interface VisibilityContext {
  weather: WeatherProfile;
  /** 0 = full night, 1 = full daylight. */
  daylight: number;
  /** Every cloud deck, lowest first, in local ENU metres. */
  layers: readonly VisibilityLayer[];
}

/** How far you can see at full night, as a fraction of the daylight range. */
const NIGHT_RANGE_FACTOR = 0.3;
/** A contact against terrain is harder to pick out than one against sky. */
const GROUND_CLUTTER_FACTOR = 0.72;

export class VisibilitySystem {
  private readonly terrain: TerrainSampler;
  readonly context: VisibilityContext;

  constructor(terrain: TerrainSampler, context?: Partial<VisibilityContext>) {
    this.terrain = terrain;
    this.context = {
      weather: WEATHER_PROFILES[WEATHER.Clear],
      daylight: 1,
      layers: [],
      ...context,
    };
  }

  /**
   * The weather, and with it the decks that came with it.
   *
   * Cloud is part of the weather rather than something set beside it, so a
   * profile carries its own layers and setting one moves them together. The
   * renderer may still override them — it knows where the decks ended up in
   * the local frame — but nothing has to remember to.
   */
  setWeather(weather: WeatherProfile): void {
    this.context.weather = weather;
    this.context.layers = layersFromProfile(weather);
  }

  setDaylight(daylight: number): void {
    this.context.daylight = clamp(daylight, 0, 1);
  }

  /** Where the decks actually are, in local metres. */
  setCloudLayers(layers: readonly VisibilityLayer[]): void {
    this.context.layers = layers;
  }

  /** Effective visual range in metres, after weather and light. */
  get sightRange(): number {
    const light = NIGHT_RANGE_FACTOR + (1 - NIGHT_RANGE_FACTOR) * this.context.daylight;
    return this.context.weather.sightRange * light;
  }

  /** True when a point sits inside any of the cloud decks. */
  isInCloud(position: Vec3): boolean {
    for (const layer of this.context.layers) {
      if (
        layer.opacity > 0.01 &&
        position.z >= layer.baseZ &&
        position.z <= layer.topZ
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * True when terrain does not block the straight line between two points.
   *
   * The same sight line the video link is carried on, so both come from one
   * place: see `terrain/lineOfSight`.
   */
  hasLineOfSight(from: Vec3, to: Vec3): boolean {
    return hasLineOfSight(this.terrain, from, to);
  }

  /**
   * How much of the sight line the cloud eats, 0..1.
   *
   * Every deck the line crosses takes its share, in proportion to how much of
   * the line runs through it and how solid it is; the decks are then combined
   * the way successive filters combine, so three thin sheets add up to
   * something you cannot see through and one of them does not.
   */
  private cloudObscuration(from: Vec3, to: Vec3): number {
    const layers = this.context.layers;
    if (layers.length === 0) return 0;

    const low = Math.min(from.z, to.z);
    const high = Math.max(from.z, to.z);
    const span = high - low;

    let transmitted = 1;
    for (const layer of layers) {
      if (layer.opacity <= 0.01) continue;
      const overlap = Math.min(high, layer.topZ) - Math.max(low, layer.baseZ);
      if (overlap <= 0) continue;
      // A sight line entirely inside a deck is fully in it; one that only
      // clips the edge is in it in proportion to how much of it is inside. A
      // level line inside a deck never leaves it.
      const through = span < 1e-3 ? 1 : clamp(overlap / span, 0, 1);
      transmitted *= 1 - layer.opacity * through;
    }
    return clamp(1 - transmitted, 0, 1);
  }

  /**
   * How visible the point `to` is from the point `from`, as 0..1.
   *
   * Not symmetric: looking down at a contact against terrain is harder than
   * looking up at one silhouetted against the sky.
   */
  visibility(from: Vec3, to: Vec3): number {
    const distance = V.distance(from, to);
    const range = this.sightRange;
    if (distance >= range) return 0;

    // Full clarity up to just over half the range, then a smooth fade out.
    const fadeStart = range * 0.55;
    let factor =
      distance <= fadeStart
        ? 1
        : 1 - (distance - fadeStart) / (range - fadeStart);
    factor = clamp(factor, 0, 1);
    factor *= factor * (3 - 2 * factor);

    if (this.context.layers.length > 0) {
      const inCloudEither = this.isInCloud(from) || this.isInCloud(to);
      if (inCloudEither) {
        // Inside the cloud it barely matters how much of the sky it filled.
        factor *= 1 - 0.92 * this.context.weather.cloudCoverage;
      } else {
        factor *= 1 - this.cloudObscuration(from, to) * 0.85;
      }
    }

    // Looking down puts the contact against terrain rather than sky.
    if (to.z < from.z) factor *= GROUND_CLUTTER_FACTOR;

    if (factor <= 0.001) return 0;
    if (!this.hasLineOfSight(from, to)) return 0;
    return clamp(factor, 0, 1);
  }

  /** How visible the player is to an enemy — the enemy is the observer. */
  playerVisibility(observer: AircraftState, player: AircraftState): number {
    if (!isVisibleCandidate(observer) || !isVisibleCandidate(player)) return 0;
    return this.visibility(observer.position, player.position);
  }

  /** How visible an enemy is to the player. */
  enemyVisibility(player: AircraftState, enemy: AircraftState): number {
    if (!isVisibleCandidate(player) || !isVisibleCandidate(enemy)) return 0;
    return this.visibility(player.position, enemy.position);
  }

  /** How visible the tracked target is; the HUD dims its indicator with this. */
  targetVisibility(
    player: AircraftState,
    target: AircraftState | null,
  ): number {
    if (!target) return 0;
    return this.enemyVisibility(player, target);
  }
}

/**
 * The decks a profile describes, as this system sees them.
 *
 * Heights are above the mission origin's terrain, which the local ENU frame
 * measures from, so no conversion is needed. How much a deck hides is its
 * coverage weighted by how solid the genus is: a broken cirrus sheet is not a
 * broken stratocumulus one.
 */
export function layersFromProfile(
  profile: WeatherProfile,
): readonly VisibilityLayer[] {
  return profile.layers
    .filter((layer: ResolvedCloudLayer) => layer.coverage > 0.01)
    .map((layer: ResolvedCloudLayer) => ({
      baseZ: layer.baseAgl,
      topZ: layer.topAgl,
      opacity: clamp(layer.coverage * layer.density, 0, 1),
    }));
}

function isVisibleCandidate(state: AircraftState): boolean {
  return (
    state.status === FLIGHT_STATUS.Flying ||
    state.status === FLIGHT_STATUS.Crashing
  );
}
