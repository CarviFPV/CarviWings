/**
 * Wind.
 *
 * The flight model already measures aerodynamic forces against the air rather
 * than the ground, so wind is not a special case in the physics — it is simply
 * the velocity of the air the aircraft is flying through. What this adds is the
 * air's own behaviour: it changes with height, it gusts, and it shifts.
 *
 * ## Height
 *
 * The wind is described by a stack of layers, each quoting a direction and a
 * speed at one height, exactly as a wind aloft forecast does. Between them the
 * speed is interpolated and the direction is walked the short way round, so a
 * surface southwesterly backing to a westerly at two thousand metres gives a
 * continuous shear through the climb rather than a step. Below the lowest layer
 * the logarithmic boundary-layer profile takes over, which is what makes the
 * air near the ridge quieter than the air over it; above the highest, the top
 * layer simply continues.
 *
 * A sky with one layer therefore behaves exactly as the old single-wind model
 * did, which is what the presets and every existing mission still get.
 *
 * ## Gusts and variation
 *
 * Two separate knobs, because they are two separate things to a pilot:
 * `gustiness` is variation in *speed* and `variation` is variation in
 * *direction*. Both are sums of sine waves at unrelated frequencies, so the air
 * never repeats on a period anyone can feel.
 *
 * Everything here is deterministic. Given the same seed and the same elapsed
 * time the wind is identical, which is what lets a mission replay the same way
 * twice.
 */

import { clamp, DEG_TO_RAD } from "../math/scalar";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import { vec3 } from "../math/vec3";
import type { WindLayer, WindSpec } from "./weather";
import {
  WIND_REFERENCE_HEIGHT,
  lerpAngleDegrees,
  normalizeWindLayers,
} from "./weather";

export interface WindOptions {
  readonly seed: string;
  /** The wind at each height. Empty is treated as still air. */
  readonly layers: readonly WindLayer[];
  /** 0..1 how strongly it gusts in speed. */
  readonly gustiness: number;
  /** 0..1 how strongly it wanders in direction. */
  readonly variation: number;
}

/** Surface roughness length for the log wind profile, metres. */
const ROUGHNESS = 0.1;
/** Wind never exceeds this multiple of the layer speed it is sheared from. */
const MAX_SHEAR = 2.2;

interface Oscillator {
  frequency: number;
  phase: number;
  weight: number;
}

function makeOscillators(
  seedKey: string,
  count: number,
  slowest: number,
  fastest: number,
): Oscillator[] {
  const rng = createRng(seedKey);
  const oscillators: Oscillator[] = [];
  let totalWeight = 0;
  for (let i = 0; i < count; i += 1) {
    const frequency = rng.range(slowest, fastest);
    const weight = 1 / (i + 1);
    totalWeight += weight;
    oscillators.push({
      frequency,
      phase: rng.range(0, Math.PI * 2),
      weight,
    });
  }
  for (const oscillator of oscillators) oscillator.weight /= totalWeight;
  return oscillators;
}

function evaluate(oscillators: readonly Oscillator[], time: number): number {
  let sum = 0;
  for (const oscillator of oscillators) {
    sum += oscillator.weight * Math.sin(time * oscillator.frequency + oscillator.phase);
  }
  return sum;
}

/**
 * How a quoted wind changes with height when nothing else says.
 *
 * The logarithmic boundary-layer profile, referenced to the level the wind was
 * quoted at: below the lowest quoted level it falls away to the ground, and
 * above the highest it keeps strengthening, capped. It is never applied
 * *between* two quoted levels — there the forecast already says what the wind
 * is doing, and shearing it again would shear the same air twice.
 *
 * A wind quoted at one level therefore behaves exactly as the old single-wind
 * model did: quiet down in the valley, hard over the ridge.
 */
function surfaceShear(heightAgl: number, referenceHeight: number): number {
  const height = Math.max(heightAgl, ROUGHNESS * 2);
  const reference = Math.max(referenceHeight, ROUGHNESS * 4);
  return clamp(
    Math.log(height / ROUGHNESS) / Math.log(reference / ROUGHNESS),
    0,
    MAX_SHEAR,
  );
}

/** Mean speed and direction at a height, before gusts. */
interface LayeredWind {
  speed: number;
  directionDeg: number;
}

const _mean: LayeredWind = { speed: 0, directionDeg: 0 };

export class WindField {
  private currentLayers: readonly WindLayer[];
  private currentGustiness: number;
  private currentVariation: number;

  private readonly speedOscillators: readonly Oscillator[];
  private readonly directionOscillators: readonly Oscillator[];
  private readonly verticalOscillators: readonly Oscillator[];
  private time = 0;

  /** Gust and shift factors, refreshed once per step and reused per sample. */
  private gustFactor = 1;
  private directionShift = 0;
  private currentVertical = 0;

  constructor(options: WindOptions) {
    this.currentLayers = normalizeWindLayers(options.layers);
    this.currentGustiness = clamp(options.gustiness, 0, 1);
    this.currentVariation = clamp(options.variation, 0, 1);

    // Three bands: slow shifts in the airmass, medium gusts, fast buffeting.
    this.speedOscillators = makeOscillators(`${options.seed}:speed`, 3, 0.03, 0.9);
    this.directionOscillators = makeOscillators(`${options.seed}:dir`, 2, 0.02, 0.35);
    this.verticalOscillators = makeOscillators(`${options.seed}:vert`, 3, 0.05, 1.4);
  }

  /** The layers being flown in, lowest first. */
  get layers(): readonly WindLayer[] {
    return this.currentLayers;
  }

  /** Direction the surface layer blows *from*, before it shifts. */
  get baseDirectionDeg(): number {
    return (this.currentLayers[0] as WindLayer).directionDeg;
  }

  /** Mean speed at the reference height, before gusts, m/s. */
  get baseSpeed(): number {
    return (this.currentLayers[0] as WindLayer).speed;
  }

  /** 0..1 how strongly the wind gusts in speed. */
  get gustiness(): number {
    return this.currentGustiness;
  }

  /** 0..1 how strongly the wind wanders in direction. */
  get variation(): number {
    return this.currentVariation;
  }

  /**
   * Re-quotes the airmass without disturbing it.
   *
   * The weather can be changed while the aircraft is flying, and when it is
   * the wind has to follow it. Only the layers and how much they move change:
   * the oscillator phases stay where the seed put them, so the wind eases into
   * its new strength rather than jumping to a different airmass mid-turn.
   */
  setProfile(spec: WindSpec): void {
    this.currentLayers = normalizeWindLayers(spec.layers);
    this.currentGustiness = clamp(spec.gustiness, 0, 1);
    this.currentVariation = clamp(spec.variation, 0, 1);
  }

  /** Current speed at the reference height, m/s. */
  get speed(): number {
    return this.speedAt(WIND_REFERENCE_HEIGHT);
  }

  /** Current direction the wind blows *from* at the reference height. */
  get directionDeg(): number {
    return this.directionAt(WIND_REFERENCE_HEIGHT);
  }

  update(dt: number): void {
    this.time += dt;

    this.gustFactor =
      1 + this.currentGustiness * 0.75 * evaluate(this.speedOscillators, this.time);
    this.directionShift =
      this.currentVariation * 32 * evaluate(this.directionOscillators, this.time);

    // Vertical gusts scale with the horizontal wind: still air does not bump.
    this.currentVertical =
      this.currentGustiness *
      0.18 *
      this.baseSpeed *
      evaluate(this.verticalOscillators, this.time);
  }

  /**
   * The mean wind at a height, before gusts.
   *
   * Written into a shared record rather than returned fresh: this is called
   * once per aircraft per step, and the flight loop allocates nothing.
   */
  private meanAt(altitudeAgl: number, out: LayeredWind): LayeredWind {
    const layers = this.currentLayers;
    const lowest = layers[0] as WindLayer;

    if (altitudeAgl <= lowest.altitudeAgl) {
      out.speed = lowest.speed * surfaceShear(altitudeAgl, lowest.altitudeAgl);
      out.directionDeg = lowest.directionDeg;
      return out;
    }

    for (let i = 1; i < layers.length; i += 1) {
      const upper = layers[i] as WindLayer;
      if (altitudeAgl > upper.altitudeAgl) continue;
      const lower = layers[i - 1] as WindLayer;
      const span = upper.altitudeAgl - lower.altitudeAgl;
      const t = span > 1e-6 ? (altitudeAgl - lower.altitudeAgl) / span : 1;
      out.speed = lower.speed + (upper.speed - lower.speed) * t;
      out.directionDeg = lerpAngleDegrees(
        lower.directionDeg,
        upper.directionDeg,
        t,
      );
      return out;
    }

    const top = layers[layers.length - 1] as WindLayer;
    out.speed = top.speed * surfaceShear(altitudeAgl, top.altitudeAgl);
    out.directionDeg = top.directionDeg;
    return out;
  }

  /**
   * Wind velocity in local ENU m/s at a height above the ground.
   *
   * The mean comes from the layers, the gust and the shift from the airmass's
   * own oscillators — so every height gusts together, which is what a single
   * airmass does, while each height keeps its own mean.
   */
  sample(altitudeAgl: number, out: Vec3 = vec3()): Vec3 {
    const mean = this.meanAt(altitudeAgl, _mean);
    const speed = Math.max(0, mean.speed * this.gustFactor);

    // Meteorological convention: the direction is where it comes *from*.
    const towards = (mean.directionDeg + this.directionShift + 180) * DEG_TO_RAD;
    out.x = Math.sin(towards) * speed;
    out.y = Math.cos(towards) * speed;
    out.z = this.currentVertical;
    return out;
  }

  /** Speed at a height, without building a vector. Used by the OSD. */
  speedAt(altitudeAgl: number): number {
    return Math.max(0, this.meanAt(altitudeAgl, _mean).speed * this.gustFactor);
  }

  /** Direction at a height, without building a vector. Used by the OSD. */
  directionAt(altitudeAgl: number): number {
    const mean = this.meanAt(altitudeAgl, _mean);
    return (((mean.directionDeg + this.directionShift) % 360) + 360) % 360;
  }
}

/**
 * Picks a wind for a mission. Deterministic from the seed, so the same mission
 * always gets the same weather on the day.
 *
 * A preset quotes a direction, but a preset is a kind of day rather than a
 * particular one — flying "Cloudy" should not mean flying the same southwester
 * every single time. So the whole profile is veered by a seeded bearing, which
 * keeps the shear between the layers intact while putting the airmass somewhere
 * new. A wind that came from a real report, or from a report the pilot typed,
 * is left exactly where it was observed.
 */
export function createMissionWind(
  seed: string,
  spec: WindSpec,
  options: { readonly veerBySeed?: boolean } = {},
): WindField {
  const layers = normalizeWindLayers(spec.layers);
  const veer = options.veerBySeed
    ? createRng(`${seed}:wind`).range(0, 360)
    : 0;
  return new WindField({
    seed,
    layers:
      veer === 0
        ? layers
        : layers.map((layer) => ({
            ...layer,
            directionDeg: (layer.directionDeg + veer) % 360,
          })),
    gustiness: spec.gustiness,
    variation: spec.variation,
  });
}

/** Formats a wind for the OSD, e.g. `270/12`. */
export function formatWind(directionDeg: number, speedMs: number): string {
  const direction = Math.round(((directionDeg % 360) + 360) % 360)
    .toString()
    .padStart(3, "0");
  return `${direction}/${Math.round(speedMs * 3.6)}`;
}
