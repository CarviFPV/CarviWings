/**
 * The strike mission.
 *
 * An interception is a fight: the contacts see you coming, turn to face you or
 * run from you, and the mission is decided by who flies the pass better. A
 * strike is the other half of the job. The contacts here are transiting — they
 * were given a route before you ever took off, they fly it from waypoint to
 * waypoint, and they never once look for the aircraft behind them. Nothing
 * evades, nothing turns to fight, and nothing runs. What is being tested is the
 * approach: finding them over real ground, closing from an aspect that works,
 * and arriving.
 *
 * The one thing that can be looking is an escort. Ask for none and the whole
 * mission is unopposed; ask for a few and they are ordinary interceptors flying
 * the ordinary enemy AI, hunting the pilot while the transit goes on around
 * them.
 *
 * Settings only — everything that counts, spawns or ends the mission lives with
 * the rest of it in `missionRunner.ts` and `types.ts`.
 */

import { clamp } from "../math/scalar";

export interface StrikeSettings {
  /**
   * Contacts flying escort on the transit.
   *
   * These are the ones that hunt: the same interceptors an intercept mission is
   * flown against, with the same difficulty profile. Zero is a transit nobody
   * is guarding, which is the mission in its plain form.
   */
  readonly escortCount: number;
}

export const MIN_STRIKE_ESCORTS = 0;
export const MAX_STRIKE_ESCORTS = 10;

export const DEFAULT_STRIKE: StrikeSettings = { escortCount: 0 };

/** Escorts, held to what the mission can actually put in the air. */
export function clampEscortCount(count: number): number {
  return Math.round(clamp(count, MIN_STRIKE_ESCORTS, MAX_STRIKE_ESCORTS));
}
