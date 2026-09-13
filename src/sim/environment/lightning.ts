/**
 * Lightning.
 *
 * A thunderstorm that is only a dark cloud with heavy rain under it is not a
 * thunderstorm. What makes one is the discharge: the sky goes white for a
 * fraction of a second, the cloud lights from the inside, and the thunder
 * arrives however many seconds later the distance says it should.
 *
 * This is the timing and the geometry of that, with no renderer attached. It
 * decides *when* a strike happens, *where* in the cell it happened, and how
 * bright the sky is right now as a result. The scene reads the flash and lights
 * itself with it; the soundscape reads the strikes and delays each crack by the
 * distance divided by the speed of sound.
 *
 * Everything is deterministic from the mission seed: the same storm flashes at
 * the same instants every time it is flown, which is what the test suite and a
 * replay both need.
 */

import { clamp } from "../math/scalar";
import { createRng } from "../math/rng";
import type { Rng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import { vec3 } from "../math/vec3";

export interface Strike {
  /** Where the discharge was, in local ENU metres. */
  readonly position: Vec3;
  /** How bright this one is, 0..1. A distant sheet is not a close bolt. */
  readonly brightness: number;
  /** How far the strike was from the observer when it fired, metres. */
  readonly distance: number;
  /** Seconds until the thunder arrives. */
  readonly thunderDelay: number;
}

export interface LightningOptions {
  readonly seed: string;
  /**
   * How active the cell is, 0..1.
   *
   * At the low end a flash every half minute or so, at the top several a
   * second in the middle of a cell — the range a real storm actually covers.
   */
  readonly activity: number;
  /** Bounds of the cloud the discharges happen in, local ENU metres. */
  readonly baseZ: number;
  readonly topZ: number;
  /** How far from the observer strikes are placed, metres. */
  readonly radius: number;
}

/** Speed of sound at low level, m/s. Close enough for counting seconds. */
export const SPEED_OF_SOUND = 343;

/** Seconds between flashes at the two ends of the activity range. */
const SLOWEST_INTERVAL = 34;
const FASTEST_INTERVAL = 2.2;

/** How long a flash takes to fade, seconds. */
const FLASH_DECAY = 0.22;
/** A flash is often two or three strokes rather than one. */
const MAX_STROKES = 3;

/** Strikes older than this are forgotten. */
const STRIKE_MEMORY = 20;

export class LightningField {
  private readonly rng: Rng;
  private activity: number;
  private baseZ: number;
  private topZ: number;
  private radius: number;

  private countdown: number;
  private currentFlash = 0;
  /** Strokes still to fire from the flash in progress. */
  private strokesLeft = 0;
  private strokeTimer = 0;
  private readonly cell = vec3();

  /** Strikes fired since the last time anyone collected them. */
  private pending: Strike[] = [];
  private history: Strike[] = [];

  constructor(options: LightningOptions) {
    this.rng = createRng(`${options.seed}:lightning`);
    this.activity = clamp(options.activity, 0, 1);
    this.baseZ = options.baseZ;
    this.topZ = Math.max(options.topZ, options.baseZ + 100);
    this.radius = Math.max(options.radius, 200);
    this.countdown = this.nextInterval();
    this.placeCell();
  }

  /** How bright the sky is from lightning right now, 0..1. */
  get flash(): number {
    return this.currentFlash;
  }

  /** True when the cell is doing anything at all. */
  get active(): boolean {
    return this.activity > 0.001;
  }

  /** Every strike still remembered, most recent last. */
  get strikes(): readonly Strike[] {
    return this.history;
  }

  /**
   * Re-quotes the storm without restarting it.
   *
   * The weather can be changed mid-flight, and a cell that grew or died has to
   * follow it: the schedule keeps running and only the rate and the geometry
   * move, so switching to a heavier storm does not fire a flash instantly and
   * switching away from one does not leave the sky lit.
   */
  setStorm(options: {
    activity: number;
    baseZ: number;
    topZ: number;
    radius?: number;
  }): void {
    const wasActive = this.active;
    this.activity = clamp(options.activity, 0, 1);
    this.baseZ = options.baseZ;
    this.topZ = Math.max(options.topZ, options.baseZ + 100);
    if (options.radius !== undefined) this.radius = Math.max(options.radius, 200);
    if (!this.active) {
      this.currentFlash = 0;
      this.strokesLeft = 0;
    } else if (!wasActive) {
      this.countdown = this.nextInterval();
      this.placeCell();
    }
  }

  /**
   * Advances the storm.
   *
   * @param observer where the sound and the flash are being judged from, local
   *   ENU metres — the aircraft, not the cell.
   */
  update(dt: number, observer: Vec3): void {
    if (dt <= 0) return;

    this.currentFlash = Math.max(
      0,
      this.currentFlash - (dt / FLASH_DECAY) * (0.4 + this.currentFlash),
    );

    if (!this.active) return;

    // A flash in progress fires its remaining strokes in quick succession,
    // which is what makes lightning flicker rather than blink.
    if (this.strokesLeft > 0) {
      this.strokeTimer -= dt;
      if (this.strokeTimer <= 0) {
        this.strokesLeft -= 1;
        this.strokeTimer = this.rng.range(0.04, 0.13);
        this.fire(observer, 0.55);
      }
      return;
    }

    this.countdown -= dt;
    if (this.countdown > 0) return;

    this.countdown = this.nextInterval();
    this.placeCell();
    this.strokesLeft = this.rng.int(0, MAX_STROKES - 1);
    this.strokeTimer = this.rng.range(0.04, 0.13);
    this.fire(observer, 1);
  }

  /**
   * Takes the strikes that have fired since this was last called.
   *
   * The audio needs each strike exactly once — a thunder crack played twice is
   * two storms — so collecting them empties the queue.
   */
  consumeStrikes(): readonly Strike[] {
    if (this.pending.length === 0) return EMPTY_STRIKES;
    const fired = this.pending;
    this.pending = [];
    return fired;
  }

  private nextInterval(): number {
    const mean =
      SLOWEST_INTERVAL + (FASTEST_INTERVAL - SLOWEST_INTERVAL) * this.activity;
    // Poisson-ish: real storms cluster rather than ticking like a metronome.
    return Math.max(0.25, mean * this.rng.range(0.35, 1.9));
  }

  /** Puts the next flash somewhere in the cell, around the mission area. */
  private placeCell(): void {
    const angle = this.rng.range(0, Math.PI * 2);
    // Square-rooted so strikes are spread evenly over the disc rather than
    // bunched at the middle of it.
    const distance = Math.sqrt(this.rng.next()) * this.radius;
    this.cell.x = Math.cos(angle) * distance;
    this.cell.y = Math.sin(angle) * distance;
    this.cell.z = this.rng.range(this.baseZ, this.topZ);
  }

  private fire(observer: Vec3, strength: number): void {
    const dx = this.cell.x - observer.x;
    const dy = this.cell.y - observer.y;
    const dz = this.cell.z - observer.z;
    const distance = Math.max(Math.hypot(dx, dy, dz), 1);

    // Close discharges wash out the frame; a flash twenty kilometres away is a
    // glow on the underside of the cloud.
    const nearness = clamp(1 - distance / (this.radius * 1.6), 0.08, 1);
    const brightness = clamp(strength * (0.35 + 0.65 * nearness), 0, 1);

    this.currentFlash = Math.max(this.currentFlash, brightness);
    const strike: Strike = {
      position: vec3(this.cell.x, this.cell.y, this.cell.z),
      brightness,
      distance,
      thunderDelay: distance / SPEED_OF_SOUND,
    };
    this.pending.push(strike);
    this.history.push(strike);
    if (this.history.length > STRIKE_MEMORY) this.history.shift();
  }
}

const EMPTY_STRIKES: readonly Strike[] = [];

/**
 * How active a storm is, from the sky it is in.
 *
 * A thunderstorm reported over an otherwise scattered sky is one cell that may
 * or may not come your way; a deep, well-covered cumulonimbus overhead is
 * continuous. Both are `TS` in the report, and the difference between them is
 * how much cloud there is and how far up it goes.
 */
export function stormActivity(options: {
  readonly thunderstorm: boolean;
  readonly coverage: number;
  readonly cloudDepth: number;
}): number {
  if (!options.thunderstorm) return 0;
  const depth = clamp(options.cloudDepth / 9000, 0.2, 1);
  return clamp(0.25 + 0.55 * options.coverage + 0.35 * depth, 0, 1);
}
