/**
 * The transit pilot.
 *
 * A contact with somewhere to be. It was given a route before the mission
 * started and it flies it: destination to destination, at a cruise, on to the
 * next one, and round again. That is the whole of it.
 *
 * What it does *not* do is the point of it. It never asks where the player is,
 * it has no perception at all, and there is nothing in here that could turn it
 * toward an interceptor or away from one — no state machine, no confidence, no
 * fight-or-run. Fly up behind one at closing speed and it will carry on to its
 * waypoint, because it does not know you are there. An interception is a fight
 * against a pilot who can see you; this is a problem of geometry and patience,
 * and the two are different missions.
 *
 * Like every other AI here it produces nothing but a normalised `FlightInput`
 * and the shared flight model turns that into motion, so it stalls, sinks and
 * hits ridges under exactly the same rules the player does. It is held below
 * the speed of the aircraft hunting it for the same reason an enemy is: both
 * sides fly the same wing, and a contact cruising at the player's own top speed
 * could never be caught from behind however well the approach was flown.
 */

import { clamp } from "../math/scalar";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS } from "../flight/state";
import { levelThrottle, maxLevelSpeed } from "../flight/physics";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import type { TerrainSampler } from "../terrain/types";
import type { AutopilotGoal } from "./autopilot";
import { flyToward, minimumCommandedSpeed } from "./autopilot";
import { advanceWaypoint, containWithin } from "./patrol";
import type { AvoidanceCommand, TerrainAvoidanceSystem } from "./terrainAvoidance";
import { createAvoidanceCommand, liftAboveTerrain } from "./terrainAvoidance";

/**
 * How often the ground and the route are looked at, seconds.
 *
 * Slower than an interceptor's, and it can afford to be: nothing here is
 * chasing anything, so there is no closing pass where a fifth of a second of
 * stale guidance is ten metres of aim. What it has to keep up with is terrain.
 */
const THINK_INTERVAL = 1 / 5;
/** Horizontal distance at which a destination counts as reached, metres. */
const WAYPOINT_RADIUS = 320;
/** Clearance a transit keeps above the ground, metres. */
export const TRANSIT_TERRAIN_MARGIN = 140;
/** Hardest bank a transit is flown at, degrees. A cruise is flown gently. */
const MAX_BANK = 34;
/**
 * How fast a transit contact cruises, as a fraction of the top level speed of
 * the aircraft hunting it.
 *
 * The same rule the interceptors are held to and for the same reason, but a
 * narrower and slower band: an aircraft going somewhere is flown for endurance
 * rather than for the fight it is not expecting, and one that has no idea it is
 * being chased has no reason to be at the top of that band either.
 */
export const TRANSIT_SPEED_FACTOR_MIN = 0.45;
export const TRANSIT_SPEED_FACTOR_MAX = 0.72;
/**
 * Throttle held over the level-flight figure for that cruise.
 *
 * Only the nominal: the autopilot's speed loop trims around it, so the aircraft
 * still has something to climb a ridge or hold a turn with and comes back down
 * to the cruise once it is level again.
 */
const THROTTLE_MARGIN = 0.08;

export interface TransitPilotOptions {
  readonly id: string;
  /** The programmed route in local ENU metres, flown in order and then again. */
  readonly route: readonly Vec3[];
  readonly terrain: TerrainSampler;
  readonly terrainAvoidance: TerrainAvoidanceSystem;
  readonly missionRadius: number;
  /** Distinct per aircraft, so no two cruise at the same speed. */
  readonly seed: string;
  /**
   * Top level speed of the airframe this contact is measured against, m/s —
   * the player's, normally. Omitted, its own airframe answers, which is the
   * same number while everything flies the one wing.
   */
  readonly speedReference?: number;
}

export interface TransitPilotDebug {
  /** Which destination it is flying to, 1-based. */
  readonly waypoint: number;
  readonly waypointCount: number;
  /** Destinations reached since it took off. */
  readonly legsFlown: number;
  /** Metres to the destination. */
  readonly rangeToWaypoint: number;
  /** The cruise it is holding, m/s. */
  readonly speed: number;
  readonly avoiding: boolean;
}

export class TransitPilot {
  readonly id: string;

  private readonly route: readonly Vec3[];
  private readonly terrain: TerrainSampler;
  private readonly terrainAvoidance: TerrainAvoidanceSystem;
  private readonly missionRadius: number;
  private readonly speedReference: number | null;

  /** This contact's own share of the reference speed, drawn once. */
  private readonly speedFactor: number;
  /** The cruise that works out to, m/s. Resolved on the first step. */
  private speed = 0;
  private throttle = 0.6;
  private resolved = false;

  private waypointIndex = 0;
  private legsFlown = 0;
  private rangeToWaypoint = Number.POSITIVE_INFINITY;

  private readonly input: FlightInput = createFlightInput();
  private readonly goalTarget = V.vec3();
  private readonly avoidance: AvoidanceCommand = createAvoidanceCommand();
  private goal: AutopilotGoal;
  private thinkAccumulator = THINK_INTERVAL;

  constructor(options: TransitPilotOptions) {
    this.id = options.id;
    this.route = options.route;
    this.terrain = options.terrain;
    this.terrainAvoidance = options.terrainAvoidance;
    this.missionRadius = options.missionRadius;
    this.speedReference = options.speedReference ?? null;

    const rng = createRng(`${options.seed}:transit:${options.id}`);
    this.speedFactor = rng.range(
      TRANSIT_SPEED_FACTOR_MIN,
      TRANSIT_SPEED_FACTOR_MAX,
    );

    if (this.route.length > 0) V.copy(this.goalTarget, this.route[0] as Vec3);
    this.goal = {
      target: this.goalTarget,
      speed: 22,
      throttle: 0.6,
      maxBank: MAX_BANK,
      climbBias: 0,
      headingBias: 0,
    };
  }

  get debug(): TransitPilotDebug {
    return {
      waypoint: this.route.length === 0 ? 0 : this.waypointIndex + 1,
      waypointCount: this.route.length,
      legsFlown: this.legsFlown,
      rangeToWaypoint: this.rangeToWaypoint,
      speed: this.speed,
      avoiding: this.avoidance.active,
    };
  }

  /** The `AircraftController` the simulation calls every physics step. */
  control = (self: AircraftState, dt: number): FlightInput => {
    if (self.status !== FLIGHT_STATUS.Flying) {
      this.input.pitch = 0;
      this.input.roll = 0;
      this.input.yaw = 0;
      this.input.throttle = 0;
      return this.input;
    }

    this.thinkAccumulator += dt;
    if (this.thinkAccumulator >= THINK_INTERVAL) {
      this.think(self);
      this.thinkAccumulator = 0;
    }

    // Flown as whatever it is: the transit can be a wing or a quadcopter, and
    // the two are not steered by the same loop.
    return flyToward(self, this.goal, this.input);
  };

  private think(self: AircraftState): void {
    this.resolveCruise(self);
    this.terrainAvoidance.evaluate(self, TRANSIT_TERRAIN_MARGIN, this.avoidance);
    this.advance(self);

    // Terrain has the last word over the route, the same as it does over an
    // interceptor's: a destination on the far side of a ridge is still flown
    // to, over the ridge.
    liftAboveTerrain(this.terrain, this.goalTarget, TRANSIT_TERRAIN_MARGIN);

    this.goal = {
      target: this.goalTarget,
      speed: this.speed,
      throttle: this.throttle,
      maxBank: MAX_BANK,
      climbBias: this.avoidance.climbDemand,
      headingBias: this.avoidance.headingOffset,
    };
  }

  /**
   * Walks the route on, and counts what has been flown.
   *
   * With no route at all it holds height over the middle of the area, which is
   * a contact that has been given nothing to do rather than one that flies into
   * the ground.
   */
  private advance(self: AircraftState): void {
    if (this.route.length === 0) {
      V.set(
        this.goalTarget,
        0,
        0,
        Math.max(self.position.z, TRANSIT_TERRAIN_MARGIN),
      );
      this.rangeToWaypoint = Number.POSITIVE_INFINITY;
      return;
    }

    const previous = this.waypointIndex;
    this.waypointIndex = advanceWaypoint(
      this.route,
      this.waypointIndex,
      self.position,
      WAYPOINT_RADIUS,
    );
    if (this.waypointIndex !== previous) this.legsFlown += 1;

    const destination = this.route[this.waypointIndex] as Vec3;
    V.copy(this.goalTarget, destination);
    this.rangeToWaypoint = V.distance(self.position, destination);
    // The route is laid out inside the area, so this only ever catches a
    // destination the terrain lifted somewhere it should not be.
    containWithin(this.goalTarget, this.missionRadius);
  }

  /**
   * Works out the cruise, once the airframe flying it is known.
   *
   * Deferred to the first step for the same reason an enemy's speed limit is:
   * the pilot is built before it has an aircraft, and the cruise is a property
   * of the two airframes together.
   */
  private resolveCruise(self: AircraftState): void {
    if (this.resolved) return;
    this.resolved = true;

    // Stood on the autopilot's own slowest useful speed, so the wing is still
    // being flown: below it a contact spends its time inside the stall
    // protection rather than in the navigation loops, which is not a slow
    // cruise but an aircraft wallowing at a healthy indicated airspeed. The
    // band is squeezed onto that floor rather than clipped by it, so a flight
    // of contacts drawn under it still cruises at a spread of speeds instead
    // of all at the same one.
    const reference = this.speedReference ?? maxLevelSpeed(self.config);
    const top = reference * TRANSIT_SPEED_FACTOR_MAX;
    const bottom = Math.min(
      Math.max(reference * TRANSIT_SPEED_FACTOR_MIN, minimumCommandedSpeed(self.config)),
      top,
    );
    const share =
      (this.speedFactor - TRANSIT_SPEED_FACTOR_MIN) /
      (TRANSIT_SPEED_FACTOR_MAX - TRANSIT_SPEED_FACTOR_MIN);
    this.speed = bottom + (top - bottom) * share;
    this.throttle = clamp(
      levelThrottle(self.config, this.speed) + THROTTLE_MARGIN,
      0.2,
      1,
    );
  }

  /** Heading a contact takes off on, so it starts down its first leg. */
  static openingHeadingDeg(from: Vec3, route: readonly Vec3[]): number {
    const first = route[0];
    if (!first) return 0;
    const heading =
      Math.atan2(first.x - from.x, first.y - from.y) * (180 / Math.PI);
    return (heading + 360) % 360;
  }
}
