/**
 * Terrain avoidance.
 *
 * An aircraft flying a chase does not get to ignore the ground. This looks
 * along the flight path, finds where it would meet rising terrain, and hands
 * back a climb demand and a turn — never a position or an attitude, so an
 * avoiding aircraft is still being flown rather than moved.
 *
 * Probes are cheap (a cached bilinear lookup each) but they are still not run
 * per physics step: the AI evaluates them a few times a second and holds the
 * result, which is far more often than a closing ridge needs.
 *
 * Columns with no sampled terrain are skipped entirely. Missing data must never
 * become a phantom mountain that sends an aircraft climbing away from nothing.
 */

import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import type { TerrainSampler } from "../terrain/types";

export interface AvoidanceCommand {
  /** True while terrain is dictating part of the flight path. */
  active: boolean;
  /** Extra climb to demand, m/s. */
  climbDemand: number;
  /** Heading offset in degrees, toward whichever side has more room. */
  headingOffset: number;
  /** Worst clearance found ahead, metres. Infinity when nothing is known. */
  clearanceAhead: number;
  /**
   * Which way the escape turn has committed: -1 left, +1 right, 0 straight.
   *
   * Carried between evaluations, because that is the whole point of it. Two
   * sides of a ridge are rarely far apart, and a system that re-picks the
   * roomier one several times a second picks a different one several times a
   * second — which comes out as an aircraft rocking between full left and full
   * right aileron rather than as an aircraft avoiding anything.
   */
  escapeSide: number;
}

export function createAvoidanceCommand(): AvoidanceCommand {
  return {
    active: false,
    climbDemand: 0,
    headingOffset: 0,
    clearanceAhead: Number.POSITIVE_INFINITY,
    escapeSide: 0,
  };
}

export interface TerrainAvoidanceOptions {
  /** Seconds of flight ahead to probe. */
  readonly horizons?: readonly number[];
  /** Half-angle of the left/right escape probes, degrees. */
  readonly escapeAngle?: number;
  /** Largest climb the system will demand, m/s. */
  readonly maxClimbDemand?: number;
  /** Largest turn it will demand, degrees. */
  readonly maxHeadingOffset?: number;
}

/**
 * How much of the way toward a newly chosen turn each evaluation moves.
 *
 * The escape is a decision — left, right, or straight on — but handing the
 * autopilot the full thirty degrees of it in one step is handing it a
 * discontinuity, and the heading loop answers a discontinuity with a snatch of
 * aileron. Ramped in over about a second instead, the same turn is flown as a
 * turn.
 */
const OFFSET_BLEND = 0.3;
/**
 * How much of a climb demand survives an evaluation that no longer wants one.
 *
 * Demands are answered the instant they appear — a ridge does not wait — and
 * let go gently. A probe that alternates between clearing a ridge and not
 * would otherwise alternate between climbing hard and not climbing at all.
 */
const CLIMB_RELEASE = 0.75;
/**
 * How much roomier the other side has to be, as a fraction of the clearance
 * being asked for, before an escape already being flown is abandoned for it.
 */
const COMMIT_HYSTERESIS = 1.2;
/** The same, for a decision being made from straight and level. */
const CHOOSE_THRESHOLD = 0.35;

/**
 * Probe horizons in seconds of flight.
 *
 * Out to twenty-two seconds — over half a kilometre at cruise. A wing climbing
 * at six metres a second gains barely seventy metres in twelve, which is not
 * enough to clear anything worth avoiding; the extra range is what gives the
 * turn time to work.
 */
const DEFAULT_HORIZONS = [2, 4, 7, 11, 16, 22] as const;

const _probe = V.vec3();
const _flat = V.vec3();

export class TerrainAvoidanceSystem {
  private readonly terrain: TerrainSampler;
  private readonly horizons: readonly number[];
  private readonly escapeAngle: number;
  private readonly maxClimbDemand: number;
  private readonly maxHeadingOffset: number;

  constructor(terrain: TerrainSampler, options: TerrainAvoidanceOptions = {}) {
    this.terrain = terrain;
    this.horizons = options.horizons ?? DEFAULT_HORIZONS;
    this.escapeAngle = options.escapeAngle ?? 35;
    this.maxClimbDemand = options.maxClimbDemand ?? 12;
    this.maxHeadingOffset = options.maxHeadingOffset ?? 30;
  }

  /**
   * Looks ahead along the current flight path.
   *
   * @param margin Clearance this aircraft wants to keep, metres.
   */
  evaluate(
    state: AircraftState,
    margin: number,
    out: AvoidanceCommand = createAvoidanceCommand(),
  ): AvoidanceCommand {
    // What the last evaluation decided. Terrain avoidance is a system with
    // memory precisely so that it does not change its mind faster than an
    // aircraft can act on it.
    const previousClimb = out.climbDemand;
    const previousOffset = out.headingOffset;
    const committed = out.escapeSide;

    out.active = false;
    out.climbDemand = 0;
    out.headingOffset = 0;
    out.clearanceAhead = Number.POSITIVE_INFINITY;

    const speed = V.length(state.velocity);
    if (speed < 1) {
      out.escapeSide = 0;
      return out;
    }

    let worstDeficit = 0;
    let worstHorizon = 1;

    for (const horizon of this.horizons) {
      V.addScaled(_probe, state.position, state.velocity, horizon);
      if (!this.terrain.hasCoverage(_probe.x, _probe.y)) continue;

      const ground = this.terrain.heightAt(_probe.x, _probe.y);
      const clearance = _probe.z - ground;
      out.clearanceAhead = Math.min(out.clearanceAhead, clearance);

      const deficit = margin - clearance;
      // Weight by how soon it arrives: a ridge two seconds away matters far
      // more than the same ridge twelve seconds away.
      const urgency = deficit / horizon;
      if (deficit > 0 && urgency > worstDeficit / worstHorizon) {
        worstDeficit = deficit;
        worstHorizon = horizon;
      }
    }

    if (worstDeficit <= 0) {
      // Nothing ahead any more, but the aircraft is still where the last
      // demand put it: let the climb and the turn go rather than dropping
      // them, so clearing a ridge is not itself a disturbance.
      out.escapeSide = 0;
      out.climbDemand = previousClimb * CLIMB_RELEASE;
      out.headingOffset = previousOffset * (1 - OFFSET_BLEND);
      out.active = out.climbDemand > 0.05;
      return out;
    }

    out.active = true;
    // Climb rate that would clear the obstacle by the time it is reached.
    // Taken at once when it rises, released slowly when it falls.
    out.climbDemand = Math.max(
      clamp(worstDeficit / worstHorizon, 0, this.maxClimbDemand),
      previousClimb * CLIMB_RELEASE,
    );

    out.escapeSide = this.chooseEscape(state, margin, speed, committed);
    const wanted = out.escapeSide * this.maxHeadingOffset;
    out.headingOffset = previousOffset + (wanted - previousOffset) * OFFSET_BLEND;
    return out;
  }

  /**
   * Picks the side with more room, and then sticks to it.
   *
   * Climbing alone loses energy and does not always work — a wing pointed at a
   * ridge it cannot outclimb has to turn. Both sides are probed at the same
   * range and the roomier one wins; if neither is better, it keeps climbing
   * straight ahead rather than committing to a turn for no reason.
   *
   * A side already being flown is held until the other is *clearly* better,
   * not merely better. Two escapes around a ridge are usually within a few
   * metres of each other and the probes move with the aircraft, so without the
   * hysteresis the winner changes every evaluation and the aeroplane rocks
   * between them instead of going round either.
   *
   * @param committed Which way it went last time: -1, 0 or +1.
   * @returns The side to fly, in the same terms.
   */
  private chooseEscape(
    state: AircraftState,
    margin: number,
    speed: number,
    committed: number,
  ): number {
    const range = speed * 12;
    const heading = Math.atan2(state.velocity.x, state.velocity.y);
    const angle = (this.escapeAngle * Math.PI) / 180;

    const left = this.clearanceAlong(state, heading - angle, range);
    const right = this.clearanceAlong(state, heading + angle, range);

    if (left === null && right === null) return committed;
    if (left === null) return 1;
    if (right === null) return -1;

    const difference = right - left;
    const side = difference > 0 ? 1 : -1;
    if (committed !== 0 && side !== committed) {
      // Turning back the other way has to be worth it.
      return Math.abs(difference) < margin * COMMIT_HYSTERESIS ? committed : side;
    }
    if (committed === 0 && Math.abs(difference) < margin * CHOOSE_THRESHOLD) {
      return 0;
    }
    return side;
  }

  /** Terrain clearance in a direction, or `null` where nothing is sampled. */
  private clearanceAlong(
    state: AircraftState,
    headingRadians: number,
    range: number,
  ): number | null {
    _flat.x = state.position.x + Math.sin(headingRadians) * range;
    _flat.y = state.position.y + Math.cos(headingRadians) * range;
    if (!this.terrain.hasCoverage(_flat.x, _flat.y)) return null;
    return state.position.z - this.terrain.heightAt(_flat.x, _flat.y);
  }
}

/** Raises a point so it sits at least `margin` above the terrain beneath it. */
export function liftAboveTerrain(
  terrain: TerrainSampler,
  point: Vec3,
  margin: number,
): Vec3 {
  if (!terrain.hasCoverage(point.x, point.y)) return point;
  const floor = terrain.heightAt(point.x, point.y) + margin;
  if (point.z < floor) point.z = floor;
  return point;
}
