/**
 * The analogue video link.
 *
 * An FPV wing is flown down one video channel, and that channel has a range.
 * Inside it the picture is clean; approaching the edge of it the picture starts
 * to break up; past it there is nothing on the goggles but grey, black and
 * white snow. Nobody flies a wing home on a screen full of static, so a picture
 * that stays gone is the end of the flight.
 *
 * How far the picture carries is decided by one number the pilot sets before
 * launch: how much the transmitter puts out. Received power falls with the
 * square of distance, so for the same receiver sensitivity the usable range
 * goes with the square root of the transmitted power — four times the power is
 * twice the range. That is the whole range model: a measured reference (a
 * 25 mW link is good for a bit over a kilometre in the open) scaled by
 * `sqrt(power / 25)`.
 *
 * Two things beyond distance matter, and both are the same thing a real pilot
 * complains about:
 *
 *   - **terrain in the way.** 5.8 GHz does not go through a ridge. Putting one
 *     between the aircraft and the ground station costs most of the link,
 *     whatever the range says.
 *   - **the ground station stays at the origin.** The pilot is standing where
 *     the flight started, so range is measured from there and not from
 *     wherever the aircraft happens to have wandered.
 *
 * Framework-agnostic and free of I/O: the simulation steps it, the HUD reads
 * it, and the mission runner ends the flight on it.
 */

import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { isAirworthy } from "../flight/state";
import type { TerrainSampler } from "../terrain/types";
import { hasLineOfSight } from "../terrain/lineOfSight";

/**
 * Transmitter powers the simulator offers, in milliwatts.
 *
 * The ladder real 5.8 GHz hardware is actually sold on, from the 25 mW a race
 * meeting allows up to the 10 W nobody should be transmitting on.
 */
export const VTX_POWER_LEVELS = [
  25, 50, 100, 200, 400, 800, 1000, 2000, 5000, 10000,
] as const;

/**
 * The power setting that switches range simulation off.
 *
 * Zero rather than infinity so a mission is still plain JSON, and so "no
 * transmitter limit" is one value the whole stack can carry.
 */
export const VTX_UNLIMITED = 0;

/** Power the reference range was measured at, milliwatts. */
export const REFERENCE_POWER_MW = 25;
/** How far a 25 mW link carries over open ground, metres. */
export const REFERENCE_RANGE_METRES = 1200;

/** Fraction of the range flown before the picture starts to break up. */
export const CLEAN_FRACTION = 0.62;
/** What the link is worth with a ridge across it. */
const OCCLUSION_FACTOR = 0.16;
/** Seconds of complete signal loss before the airframe is written off. */
export const SIGNAL_LOSS_TIMEOUT = 15;
/** Height of the ground station's antenna above the origin terrain, metres. */
const ANTENNA_HEIGHT = 1.5;

/** Usable range of a transmitter, metres. Infinite when range is not simulated. */
export function videoLinkRange(powerMilliwatts: number): number {
  if (!(powerMilliwatts > 0)) return Number.POSITIVE_INFINITY;
  return (
    REFERENCE_RANGE_METRES *
    Math.sqrt(powerMilliwatts / REFERENCE_POWER_MW)
  );
}

/** A transmitter power the way it is written on the hardware. */
export function formatVtxPower(powerMilliwatts: number): string {
  if (!(powerMilliwatts > 0)) return "Unlimited";
  if (powerMilliwatts < 1000) return `${powerMilliwatts} mW`;
  const watts = powerMilliwatts / 1000;
  return `${Number.isInteger(watts) ? watts : watts.toFixed(1)} W`;
}

/**
 * Picture quality at a range, 0..1.
 *
 * Clean out to `CLEAN_FRACTION` of the range, then a smooth fade to nothing at
 * the range itself — an analogue link degrades, it does not switch off.
 */
export function videoSignalQuality(
  distance: number,
  range: number,
  blocked = false,
): number {
  if (!Number.isFinite(range)) return 1;
  if (range <= 0) return 0;

  const clean = range * CLEAN_FRACTION;
  let quality =
    distance <= clean ? 1 : 1 - (distance - clean) / (range - clean);
  quality = clamp(quality, 0, 1);
  // Smoothstep, so the break-up creeps in rather than arriving on a corner.
  quality = quality * quality * (3 - 2 * quality);

  if (blocked) quality *= OCCLUSION_FACTOR;
  return quality < 0.004 ? 0 : quality;
}

export interface VideoLinkOptions {
  /** Transmitter power in milliwatts; `VTX_UNLIMITED` disables the range. */
  readonly powerMilliwatts: number;
  /** Sampled terrain, used to put ridges between the aircraft and the pilot. */
  readonly terrain?: TerrainSampler | null;
  /** Seconds of dead picture before the airframe counts as lost. */
  readonly lossTimeout?: number;
}

/** What the goggles are showing, and how close the flight is to ending. */
export interface VideoLinkState {
  /** False when range is not simulated; everything below is then nominal. */
  readonly enabled: boolean;
  readonly powerMilliwatts: number;
  /** Range at which the picture is gone, metres. Infinite when disabled. */
  readonly range: number;
  /** Slant range from the ground station to the aircraft, metres. */
  readonly distance: number;
  /** 1 is a clean picture, 0 is snow. */
  readonly quality: number;
  /** True while terrain stands between the aircraft and the ground station. */
  readonly blocked: boolean;
  /** True while there is no picture at all. */
  readonly lost: boolean;
  /** How long the picture has been gone, seconds. */
  readonly lostSeconds: number;
  /** How long it may stay gone before the airframe is written off, seconds. */
  readonly timeout: number;
  /** True once the picture has been gone for the whole timeout. */
  readonly failed: boolean;
}

/**
 * Tracks one aircraft's video link.
 *
 * Stepped by the simulation once per frame rather than per physics step: this
 * is a slow-moving signal, and nothing in the flight model reads it.
 */
export class VideoLink {
  readonly enabled: boolean;
  readonly powerMilliwatts: number;
  readonly range: number;
  readonly timeout: number;

  private readonly terrain: TerrainSampler | null;
  /** Where the pilot is standing, in local ENU metres. */
  private readonly station: Vec3;
  private readonly snapshot: VideoLinkState;

  constructor(options: VideoLinkOptions) {
    this.powerMilliwatts = Math.max(options.powerMilliwatts, 0);
    this.enabled = this.powerMilliwatts > 0;
    this.range = videoLinkRange(this.powerMilliwatts);
    this.timeout = options.lossTimeout ?? SIGNAL_LOSS_TIMEOUT;
    this.terrain = options.terrain ?? null;

    // The frame origin sits on the ground the mission started from, so the
    // pilot is a metre and a half above local zero — give or take whatever the
    // terrain field says about that exact spot.
    const groundZ = this.terrain?.heightAt(0, 0) ?? 0;
    this.station = V.vec3(0, 0, groundZ + ANTENNA_HEIGHT);

    this.snapshot = {
      enabled: this.enabled,
      powerMilliwatts: this.powerMilliwatts,
      range: this.range,
      distance: 0,
      quality: 1,
      blocked: false,
      lost: false,
      lostSeconds: 0,
      timeout: this.timeout,
      failed: false,
    } as VideoLinkState;
  }

  private mutable(): {
    -readonly [K in keyof VideoLinkState]: VideoLinkState[K];
  } {
    return this.snapshot;
  }

  /**
   * The current link. Allocation-free: the same object is returned every call,
   * so callers must read it rather than retain it.
   */
  get state(): VideoLinkState {
    return this.snapshot;
  }

  /** Puts the link back the way it starts, for a fresh airframe. */
  reset(): void {
    const state = this.mutable();
    state.distance = 0;
    state.quality = 1;
    state.blocked = false;
    state.lost = false;
    state.lostSeconds = 0;
    state.failed = false;
  }

  update(player: AircraftState | null, dt: number): void {
    const state = this.mutable();

    // No airframe in the air is not a lost link: a replacement is on its way
    // and it launches from the pilot's feet with a full picture.
    if (!this.enabled || !player || !isAirworthy(player.status)) {
      this.reset();
      return;
    }

    const distance = V.distance(this.station, player.position);
    const blocked =
      this.terrain !== null &&
      !hasLineOfSight(this.terrain, this.station, player.position);
    const quality = videoSignalQuality(distance, this.range, blocked);

    state.distance = distance;
    state.blocked = blocked;
    state.quality = quality;
    state.lost = quality <= 0;
    // The clock only runs while there is nothing at all on the screen, and any
    // picture at all — one frame punching through — puts it back to zero.
    state.lostSeconds = state.lost ? state.lostSeconds + dt : 0;
    state.failed = state.lostSeconds >= this.timeout;
  }
}
