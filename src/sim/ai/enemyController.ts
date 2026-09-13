/**
 * Enemy pilot.
 *
 * Produces a normalised `FlightInput` and nothing else — it cannot move an
 * aircraft, rotate one, or read anything the aircraft could not see. The same
 * flight model that flies the player flies this, so an enemy stalls, sinks and
 * hits ridges under exactly the same rules.
 *
 * Two rates:
 *
 *   - **think**, a few times a second — perception, the state machine, terrain
 *     probes, and choosing where to go
 *   - **fly**, every physics step — the autopilot loops, working from whatever
 *     the last think decided
 *
 * That split is what keeps twenty enemies affordable: the expensive parts run
 * at 6 Hz, and the cheap part runs at 240 Hz because it must.
 */

import { forwardAxis } from "../math/quat";
import { clamp, DEG_TO_RAD } from "../math/scalar";
import type { Rng } from "../math/rng";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS } from "../flight/state";
import { levelThrottle, maxLevelSpeed, stallSpeed } from "../flight/physics";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import type { VisibilitySystem } from "../environment/visibility";
import type { TerrainSampler } from "../terrain/types";
import { flyToward, minimumCommandedSpeed } from "./autopilot";
import type { AutopilotGoal } from "./autopilot";
import { interceptPoint } from "./interception";
import { advanceWaypoint, containWithin } from "./patrol";
import type { AvoidanceCommand, TerrainAvoidanceSystem } from "./terrainAvoidance";
import { createAvoidanceCommand, liftAboveTerrain } from "./terrainAvoidance";
import type { AiState, DifficultyProfile } from "./types";
import {
  AI_STATE,
  CONFIRM_CONFIDENCE,
  LOST_CONFIDENCE,
  NOTICE_CONFIDENCE,
} from "./types";

export interface EnemyControllerOptions {
  readonly id: string;
  readonly difficulty: DifficultyProfile;
  /** Waypoints to patrol, in local ENU metres. */
  readonly route: readonly Vec3[];
  readonly terrainAvoidance: TerrainAvoidanceSystem;
  readonly terrain: TerrainSampler;
  /** Without one, every contact is treated as plainly visible. */
  readonly visibility: VisibilitySystem | null;
  readonly missionRadius: number;
  readonly seed: string;
  /** False keeps the aircraft on patrol: it will watch, but never commit. */
  readonly aggressive: boolean;
  /** The aircraft this pilot is hunting. */
  readonly getTarget: () => AircraftState | null;
  /**
   * Top level speed of the airframe this pilot is measured against, m/s —
   * the player's, normally.
   *
   * The pilot's own speed limit is a fraction of it, so "slower than the
   * aircraft chasing me" stays true whatever either aeroplane is retuned to.
   * Omitted, the pilot falls back to its own airframe's top speed, which is
   * the same number while everything flies the one wing.
   */
  readonly speedReference?: number;
}

/**
 * How often perception, the state machine and terrain probes run.
 *
 * Six times a second is ample for deciding where to go, but not for arriving:
 * on a closing pass the last second of guidance is the whole engagement, and at
 * 60 m/s of closure a sixth of a second is ten metres of aim. Aircraft that
 * have committed think faster, and there are never many of those at once.
 */
const THINK_INTERVAL = 1 / 6;
const TERMINAL_THINK_INTERVAL = 1 / 30;
/** Horizontal distance at which a patrol waypoint counts as reached. */
const WAYPOINT_RADIUS = 260;
/** Give up searching after this long without a sighting. */
const SEARCH_TIMEOUT = 25;
/**
 * How far outside the mission area an enemy will chase, as a multiple of the
 * mission radius, before breaking off and going back on patrol.
 */
const BREAK_OFF_RADIUS_FACTOR = 2.5;
/** Longest interception horizon the AI will aim at, seconds. */
const MAX_INTERCEPT_HORIZON = 25;
/** Track convergence rate with no visual at all, per second. */
const TRACK_RATE_BASE = 1.5;
/** Additional convergence with a clear visual, per second. */
const TRACK_RATE_VISUAL = 14;
// --- Power management ------------------------------------------------------
//
// The airframe tops out a little under 30 m/s in level flight, so an enemy
// that holds full throttle whenever it can see you is one a player flying the
// same wing can never close on. Cruise is therefore flown at part power — the
// pilot has somewhere to go when it needs it — and the throttle that comes out
// is a consequence of the situation rather than of the state machine.

/** Cruise throttle the speeds below are referenced to. */
const NOMINAL_CRUISE_THROTTLE = 0.6;
/** Airspeed the airframe settles at from that throttle, m/s. */
const CRUISE_SPEED = 24;
/** Roughly how much airspeed a unit of throttle is worth around cruise, m/s. */
const SPEED_PER_THROTTLE = 18;
/** Slowest and fastest a pilot will ask the speed loop for, m/s. */
const MIN_COMMANDED_SPEED = 16;
const MAX_COMMANDED_SPEED = 34;
/**
 * Cruise throttle flown while nothing has been noticed, as a fraction of the
 * pilot's own cruise. An aircraft that does not know it is being followed has
 * no reason to burn a battery, and flies for endurance instead.
 */
const ECONOMY_FACTOR = 0.85;
/** Seconds after the last sighting before a pilot settles back into that. */
const ECONOMY_DELAY = 20;
/** Extra throttle over cruise while investigating a contact. */
const SEARCH_THROTTLE_BOOST = 0.1;
/** Extra throttle over cruise at the far end of an intercept. */
const PURSUIT_THROTTLE_BOOST = 0.15;
/**
 * Range at which an intercept goes to full power, as a multiple of the
 * pilot's attack range. Beyond it the chase is flown at a cruise the player
 * can out-accelerate; inside it the pass is flown for real.
 */
const TERMINAL_RANGE_FACTOR = 3;
/**
 * How fast an enemy is allowed to fly, as a fraction of the top level speed of
 * the aircraft hunting it.
 *
 * Both sides fly the same wing, so an enemy that opens the throttle simply
 * stays where it is relative to a player who does the same: a stern chase on
 * equal aircraft is a chase that never ends, however well it is flown. Every
 * pilot is therefore given a speed it will not exceed, drawn once from its own
 * seed, and a contact can always be run down from behind — the question is how
 * long it takes and what it does about it on the way.
 *
 * The limit is a speed rather than a throttle setting because a throttle
 * setting means nothing on its own: the same number is a climb, a cruise or a
 * dive depending on what the aircraft is doing with it.
 */
export const ENEMY_SPEED_FACTOR_MIN = 0.4;
export const ENEMY_SPEED_FACTOR_MAX = 0.8;
/**
 * Throttle the pilot may nominally hold above the level-flight figure for its
 * limit, so a limited aircraft can still climb and turn.
 *
 * It only moves the *nominal*: the autopilot's speed loop still trims around
 * it, so the aircraft may open right up to recover a speed it has lost and
 * comes straight back down once it is at its limit again.
 */
const SPEED_LIMIT_THROTTLE_MARGIN = 0.15;
/** Shortest and longest run from a contact, seconds. */
export const FLEE_MIN_SECONDS = 30;
export const FLEE_MAX_SECONDS = 90;
/** Seconds after a run before the same pilot will consider running again. */
const FLEE_COOLDOWN = 45;
/** How far ahead of the nose a contact has to be to have been seen coming. */
const FRONTAL_ASPECT = 0.25;
/** Range inside which a contact pointing at this aircraft is a threat, metres. */
const THREAT_RANGE = 2500;
/** How closely a contact has to be pointing at us to read as an attack run. */
const THREAT_CONE = Math.cos(30 * DEG_TO_RAD);
/**
 * Closure a chase is content with, m/s.
 *
 * Power is for closing a range. A contact coming the other way closes it at
 * fifty metres a second on its own and the throttle adds nothing; a contact
 * running, or crossing, closes it at almost nothing, and then the throttle is
 * the only thing that will.
 */
const USEFUL_CLOSURE = 20;
/** How far a run is aimed ahead of the aircraft, metres. */
const FLEE_LOOKAHEAD = 1500;
/** Height a run is willing to trade for speed, metres. */
const MAX_FLEE_DIVE = 50;

/**
 * What a pilot has decided to do about the contact it is holding.
 *
 * Not every aircraft in the area wants a fight. An interceptor that sees one
 * coming at it may well decide it would rather be somewhere else, and that
 * decision is made once and lived with rather than reconsidered six times a
 * second.
 */
const POSTURE = {
  /** No confirmed contact yet, or the last one was lost. */
  Undecided: "UNDECIDED",
  /** Turning to fight. */
  Commit: "COMMIT",
  /** Running. */
  Run: "RUN",
} as const;

type Posture = (typeof POSTURE)[keyof typeof POSTURE];

export interface EnemyDebugState {
  readonly state: AiState;
  readonly confidence: number;
  readonly timeSinceSeen: number;
  readonly waypoint: number;
  readonly avoiding: boolean;
  readonly clearanceAhead: number;
  readonly rangeToTarget: number;
  /** Throttle this pilot is cruising on right now. */
  readonly cruiseThrottle: number;
  /** True while it has noticed nothing and is flying for endurance. */
  readonly unaware: boolean;
  /** Airspeed this pilot will not exceed, m/s. */
  readonly speedLimit: number;
  /** Seconds left of a run, or 0 when it is not running. */
  readonly fleeRemaining: number;
}

const _toTarget = V.vec3();
const _forward = V.vec3();
const _away = V.vec3();

export class EnemyController {
  readonly id: string;
  readonly difficulty: DifficultyProfile;

  private state: AiState = AI_STATE.Patrol;
  private readonly route: readonly Vec3[];
  private readonly terrainAvoidance: TerrainAvoidanceSystem;
  private readonly terrain: TerrainSampler;
  private readonly visibility: VisibilitySystem | null;
  private readonly missionRadius: number;
  private readonly aggressive: boolean;
  private readonly getTarget: () => AircraftState | null;
  private readonly rng: Rng;

  // --- Perception ----------------------------------------------------------
  /** 0..1 belief that the remembered contact position is where the target is. */
  private confidence = 0;
  private readonly lastKnown = V.vec3();
  private readonly lastKnownVelocity = V.vec3();
  private timeSinceSeen = Number.POSITIVE_INFINITY;
  private everSeen = false;
  private rangeToTarget = Number.POSITIVE_INFINITY;
  private previousRange = Number.POSITIVE_INFINITY;
  /** Smoothed rate the range is coming down at, m/s. Negative while opening. */
  private closureRate = 0;

  // --- Decision ------------------------------------------------------------
  private pendingState: AiState | null = null;
  private pendingTimer = 0;
  private evadeTimer = 0;
  private waypointIndex = 0;
  private searchPhase: number;
  /**
   * Fight or run, decided once when a contact is confirmed and held until that
   * contact is lost again. Rolling it every think would make a pilot dither.
   */
  private posture: Posture = POSTURE.Undecided;
  private fleeTimer = 0;
  private fleeCooldown = 0;

  // --- Airmanship ----------------------------------------------------------
  /** Seconds this pilot has been flying, for the throttle wander. */
  private elapsed = 0;
  /** This pilot's own cruise throttle, before the wander. */
  private readonly cruiseBase: number;
  private readonly wanderAmplitude: number;
  private readonly wanderRate: number;
  private readonly wanderPhase: number;
  /**
   * How well this pilot watches the airspace it is not looking at, scaling the
   * difficulty's peripheral vision. Some pilots never check their six, which
   * is what makes a stern approach worth flying.
   */
  private readonly vigilance: number;
  /**
   * This pilot's own share of the reference speed, drawn once and flown for
   * the whole mission. Two contacts in the same flight run at different
   * speeds, and neither of them at the player's.
   */
  private readonly speedFactor: number;
  private readonly speedReference: number | null;
  /** Airspeed this pilot will not ask for, m/s. Resolved on the first step. */
  private speedLimit = Infinity;
  /** Nominal throttle that goes with it. */
  private throttleCeiling = 1;
  private limitsResolved = false;

  // --- Output --------------------------------------------------------------
  private readonly input: FlightInput = createFlightInput();
  private readonly aimPoint = V.vec3();
  private readonly goalTarget = V.vec3();
  private readonly avoidance: AvoidanceCommand = createAvoidanceCommand();
  private goal: AutopilotGoal;
  private thinkAccumulator = THINK_INTERVAL;
  private thinkInterval = THINK_INTERVAL;

  constructor(options: EnemyControllerOptions) {
    this.id = options.id;
    this.difficulty = options.difficulty;
    this.route = options.route;
    this.terrainAvoidance = options.terrainAvoidance;
    this.terrain = options.terrain;
    this.visibility = options.visibility;
    this.missionRadius = options.missionRadius;
    this.aggressive = options.aggressive;
    this.getTarget = options.getTarget;
    this.rng = createRng(`${options.seed}:${options.id}`);
    this.searchPhase = this.rng.range(0, Math.PI * 2);

    // No two pilots cruise on the same number, and none of them holds one
    // number for long: the throttle drifts the way a real pilot's does.
    const variation = options.difficulty.throttleVariation;
    this.cruiseBase = clamp(
      options.difficulty.patrolThrottle + this.rng.range(-variation, variation),
      0.35,
      0.85,
    );
    this.wanderAmplitude = this.rng.range(0.015, 0.045);
    this.wanderRate = this.rng.range(0.03, 0.1);
    this.wanderPhase = this.rng.range(0, Math.PI * 2);
    this.vigilance = this.rng.range(0.25, 1.3);
    this.speedReference = options.speedReference ?? null;
    this.speedFactor = this.rng.range(
      ENEMY_SPEED_FACTOR_MIN,
      ENEMY_SPEED_FACTOR_MAX,
    );

    this.goal = {
      target: this.goalTarget,
      speed: this.speedFor(this.cruiseBase),
      throttle: this.cruiseBase,
      maxBank: options.difficulty.maxBank * 0.7,
      climbBias: 0,
      headingBias: 0,
    };
    if (this.route.length > 0) V.copy(this.goalTarget, this.route[0] as Vec3);
  }

  get currentState(): AiState {
    return this.state;
  }

  get debug(): EnemyDebugState {
    return {
      state: this.state,
      confidence: this.confidence,
      timeSinceSeen: this.timeSinceSeen,
      waypoint: this.waypointIndex,
      avoiding: this.avoidance.active,
      clearanceAhead: this.avoidance.clearanceAhead,
      rangeToTarget: this.rangeToTarget,
      cruiseThrottle: this.cruiseThrottle,
      unaware: this.unaware,
      speedLimit: this.speedLimit,
      fleeRemaining: this.state === AI_STATE.Flee ? Math.max(0, this.fleeTimer) : 0,
    };
  }

  /** The `AircraftController` the simulation calls every physics step. */
  control = (self: AircraftState, dt: number): FlightInput => {
    if (self.status !== FLIGHT_STATUS.Flying) {
      this.state = AI_STATE.Crashed;
      this.input.pitch = 0;
      this.input.roll = 0;
      this.input.yaw = 0;
      this.input.throttle = 0;
      return this.input;
    }

    this.thinkAccumulator += dt;
    if (this.thinkAccumulator >= this.thinkInterval) {
      this.think(self, this.thinkAccumulator);
      this.thinkAccumulator = 0;
    }

    // Whichever aeroplane the contact is actually in: a wing is steered and a
    // quadcopter is flown to the point by leaning at it, and an opposition
    // that can be a wing or a quadcopter has to be flown as what it is.
    return flyToward(self, this.goal, this.input);
  };

  // --- Thinking ------------------------------------------------------------

  private think(self: AircraftState, dt: number): void {
    this.resolveSpeedLimit(self);
    this.perceive(self, dt);
    this.terrainAvoidance.evaluate(self, this.difficulty.terrainMargin, this.avoidance);
    this.updateState(self, dt);
    this.buildGoal(self);
    this.thinkInterval =
      this.state === AI_STATE.Attack ? TERMINAL_THINK_INTERVAL : THINK_INTERVAL;
  }

  /**
   * Updates what this pilot believes about the target.
   *
   * Nothing here reads the target's true position unless the visibility system
   * says it can be seen. When it cannot, the remembered position is carried
   * forward on the last known velocity and the belief decays — so a pilot that
   * loses you searches where you were heading, and is wrong if you turned.
   */
  private perceive(self: AircraftState, dt: number): void {
    const target = this.getTarget();
    const difficulty = this.difficulty;

    if (!target || target.status !== FLIGHT_STATUS.Flying) {
      this.confidence = Math.max(0, this.confidence - difficulty.forgetRate * dt);
      this.timeSinceSeen += dt;
      this.rangeToTarget = Number.POSITIVE_INFINITY;
      return;
    }

    this.previousRange = this.rangeToTarget;
    this.rangeToTarget = V.distance(self.position, target.position);
    if (Number.isFinite(this.previousRange) && dt > 0) {
      const instant = (this.previousRange - this.rangeToTarget) / dt;
      this.closureRate += (instant - this.closureRate) * clamp(dt * 2, 0, 1);
    }

    let seen = 0;
    if (this.visibility) {
      const range = this.visibility.sightRange * difficulty.sightRangeFactor;
      if (this.rangeToTarget <= range) {
        seen = this.visibility.playerVisibility(self, target);
      }
    } else {
      seen = 1;
    }

    if (seen > 0) {
      // A contact off the nose is picked up far faster than one behind.
      V.subtract(_toTarget, target.position, self.position);
      V.normalize(_toTarget, _toTarget);
      forwardAxis(_forward, self.orientation);
      const aspect = V.dot(_toTarget, _forward);
      const halfFov = Math.cos((difficulty.fieldOfView / 2) * DEG_TO_RAD);
      seen *=
        aspect >= halfFov
          ? 1
          : difficulty.peripheralFactor * this.vigilance;
    }

    if (seen > 0.02) {
      this.confidence = clamp(
        this.confidence + difficulty.detectionRate * seen * dt,
        0,
        1,
      );
      this.timeSinceSeen = 0;

      if (!this.everSeen) {
        this.everSeen = true;
        V.copy(this.lastKnown, target.position);
        V.copy(this.lastKnownVelocity, target.velocity);
      } else {
        // The track converges on the truth at a rate set by how clearly the
        // contact is seen. A plain visual is tracked tightly — you are looking
        // straight at it. A contact glimpsed through weather or at the edge of
        // vision lags badly, and the aim goes where it was rather than where it
        // is, which is most of what makes a hard pilot hard.
        const trackingRate = TRACK_RATE_BASE + TRACK_RATE_VISUAL * seen * seen;
        const blend = 1 - Math.exp(-trackingRate * dt);
        V.lerpVec3(this.lastKnown, this.lastKnown, target.position, blend);
        V.lerpVec3(
          this.lastKnownVelocity,
          this.lastKnownVelocity,
          target.velocity,
          blend,
        );
      }
      return;
    }

    this.confidence = Math.max(0, this.confidence - difficulty.forgetRate * dt);
    this.timeSinceSeen += dt;
    // Dead reckoning on the last known velocity.
    if (this.everSeen) {
      V.addScaled(this.lastKnown, this.lastKnown, this.lastKnownVelocity, dt);
    }
  }

  private updateState(self: AircraftState, dt: number): void {
    this.elapsed += dt;
    if (this.fleeCooldown > 0) this.fleeCooldown -= dt;
    // A contact that has gone cold is a fresh decision next time.
    if (this.confidence < LOST_CONFIDENCE && this.state !== AI_STATE.Flee) {
      this.posture = POSTURE.Undecided;
    }

    let desired: AiState;

    if (!this.aggressive) {
      // Combat off: it will notice you and shadow you, but never commit.
      desired =
        this.confidence >= NOTICE_CONFIDENCE ? AI_STATE.Search : AI_STATE.Patrol;
    } else if (this.state === AI_STATE.Flee) {
      this.fleeTimer -= dt;
      if (this.fleeTimer > 0) {
        desired = AI_STATE.Flee;
      } else {
        // Far enough, long enough: back to normal operations. Whatever it can
        // still see it now deals with, and it will not run again immediately.
        this.posture = POSTURE.Commit;
        this.fleeCooldown = FLEE_COOLDOWN;
        desired =
          this.confidence >= NOTICE_CONFIDENCE
            ? AI_STATE.Intercept
            : AI_STATE.Patrol;
      }
    } else if (this.state === AI_STATE.Evade) {
      this.evadeTimer -= dt;
      desired =
        this.evadeTimer > 0
          ? AI_STATE.Evade
          : this.confidence >= NOTICE_CONFIDENCE
            ? AI_STATE.Intercept
            : AI_STATE.Patrol;
    } else if (this.confidence >= CONFIRM_CONFIDENCE) {
      if (this.posture === POSTURE.Undecided && this.underThreat(self)) {
        this.decidePosture();
      }
      if (this.posture === POSTURE.Run) {
        desired = AI_STATE.Flee;
      } else {
        desired =
          this.rangeToTarget <= this.difficulty.attackRange
            ? AI_STATE.Attack
            : AI_STATE.Intercept;
      }
    } else if (this.confidence >= NOTICE_CONFIDENCE) {
      desired = AI_STATE.Search;
    } else if (
      this.confidence < LOST_CONFIDENCE ||
      this.timeSinceSeen > SEARCH_TIMEOUT
    ) {
      desired = AI_STATE.Patrol;
    } else {
      desired = AI_STATE.Search;
    }

    // An overshoot: the target is behind and opening. Break off and reset
    // rather than turning endlessly inside its circle.
    if (this.state === AI_STATE.Attack && this.isOvershooting(self)) {
      desired = AI_STATE.Evade;
      this.evadeTimer = this.difficulty.evadeDuration;
    }

    // Dragged too far from station: give up the chase and go back on patrol.
    // A target that runs far enough gets away, which is a decision the pilot
    // makes rather than a wall it bounces off.
    const fromOrigin = Math.hypot(self.position.x, self.position.y);
    if (fromOrigin > this.missionRadius * BREAK_OFF_RADIUS_FACTOR) {
      desired = AI_STATE.Patrol;
      this.confidence = Math.min(this.confidence, NOTICE_CONFIDENCE * 0.5);
    }

    this.requestState(desired, dt);
  }

  /**
   * Is this contact coming for us?
   *
   * Not "can I see it" — "is it pointing at me". An aircraft crossing the area
   * is traffic; one seen head-on, a couple of kilometres out and flying down
   * the line between us, is an interceptor on its run, and that is the only
   * thing worth abandoning a patrol over. A contact behind the wing fails the
   * first test, which is precisely why a stern approach is worth flying.
   */
  private underThreat(self: AircraftState): boolean {
    if (!Number.isFinite(this.rangeToTarget)) return false;
    if (this.rangeToTarget > THREAT_RANGE) return false;
    // A pass already inside firing range is flown, not abandoned.
    if (this.rangeToTarget <= this.difficulty.attackRange) return false;

    V.subtract(_toTarget, this.lastKnown, self.position);
    V.normalize(_toTarget, _toTarget);
    forwardAxis(_forward, self.orientation);
    if (V.dot(_toTarget, _forward) < FRONTAL_ASPECT) return false;

    const speed = V.length(this.lastKnownVelocity);
    if (speed < 1) return false;
    return -V.dot(_toTarget, this.lastKnownVelocity) / speed >= THREAT_CONE;
  }

  /**
   * Fight, or run.
   *
   * Rolled once per contact, the first time that contact turns into something
   * coming at this aircraft, and then lived with: a pilot that re-rolled six
   * times a second would dither instead of deciding.
   */
  private decidePosture(): void {
    if (this.fleeCooldown > 0) {
      this.posture = POSTURE.Commit;
      return;
    }
    if (this.rng.next() < this.difficulty.evasionChance) {
      this.posture = POSTURE.Run;
      this.fleeTimer = this.rng.range(FLEE_MIN_SECONDS, FLEE_MAX_SECONDS);
    } else {
      this.posture = POSTURE.Commit;
    }
  }

  /** Cruise throttle right now: this pilot's own figure, slowly drifting. */
  private get cruiseThrottle(): number {
    return clamp(
      this.cruiseBase +
        this.wanderAmplitude *
          Math.sin(this.elapsed * this.wanderRate + this.wanderPhase),
      0.3,
      0.9,
    );
  }

  /** True while nothing has been noticed and the pilot is simply transiting. */
  private get unaware(): boolean {
    return (
      this.confidence < NOTICE_CONFIDENCE && this.timeSinceSeen > ECONOMY_DELAY
    );
  }

  /**
   * Works out this pilot's speed limit, once the airframe it is flying is
   * known.
   *
   * Deferred to the first step rather than done in the constructor because
   * that is when the aircraft arrives: a controller is built before it has one
   * to fly, and the limit is a property of the two airframes together.
   */
  private resolveSpeedLimit(self: AircraftState): void {
    if (this.limitsResolved) return;
    this.limitsResolved = true;

    // The bottom of the band is the airframe's business, not the pilot's. The
    // slowest fractions work out below anything the wing can actually be
    // manoeuvred at, so the band is stood on the autopilot's own slowest
    // useful cruise: under that a contact is not flying slowly, it is living
    // inside its stall protection — giving up most of its bank limit, unable
    // to answer a terrain climb, and pitching about at a perfectly respectable
    // indicated airspeed.
    //
    // The band is *squeezed* onto that floor rather than clipped by it. Clipped,
    // every pilot drawn below the floor comes out at exactly the same speed,
    // and a flight of contacts that were meant to be all flying differently
    // ends up flying in step. Squeezed, the spread survives — and the slowest
    // of them is still far below a player at full power, which is the only
    // thing the band exists to guarantee.
    const reference = this.speedReference ?? maxLevelSpeed(self.config);
    const top = reference * ENEMY_SPEED_FACTOR_MAX;
    const bottom = Math.min(
      Math.max(reference * ENEMY_SPEED_FACTOR_MIN, minimumCommandedSpeed(self.config)),
      top,
    );
    const share =
      (this.speedFactor - ENEMY_SPEED_FACTOR_MIN) /
      (ENEMY_SPEED_FACTOR_MAX - ENEMY_SPEED_FACTOR_MIN);
    this.speedLimit = bottom + (top - bottom) * share;
    this.throttleCeiling = Math.min(
      1,
      levelThrottle(self.config, this.speedLimit) + SPEED_LIMIT_THROTTLE_MARGIN,
    );
  }

  /**
   * The airspeed a throttle setting is worth in level flight.
   *
   * The speed loop trims around the nominal throttle, so the two have to agree:
   * ask for a speed the throttle cannot hold and the loop simply pushes the
   * throttle wherever it likes, which is exactly the behaviour this replaces.
   */
  private speedFor(throttle: number): number {
    return clamp(
      CRUISE_SPEED + (throttle - NOMINAL_CRUISE_THROTTLE) * SPEED_PER_THROTTLE,
      MIN_COMMANDED_SPEED,
      MAX_COMMANDED_SPEED,
    );
  }

  private isOvershooting(self: AircraftState): boolean {
    if (!Number.isFinite(this.previousRange)) return false;
    if (this.rangeToTarget < this.previousRange + 0.5) return false;
    V.subtract(_toTarget, this.lastKnown, self.position);
    V.normalize(_toTarget, _toTarget);
    forwardAxis(_forward, self.orientation);
    return V.dot(_toTarget, _forward) < 0.1;
  }

  /**
   * Applies a change of mind only after it has held for the pilot's reaction
   * time, so an enemy does not flip between states on noise.
   */
  private requestState(next: AiState, dt: number): void {
    if (next === this.state) {
      this.pendingState = null;
      this.pendingTimer = 0;
      return;
    }
    if (this.pendingState !== next) {
      this.pendingState = next;
      this.pendingTimer = 0;
    }
    this.pendingTimer += dt;
    if (this.pendingTimer >= this.difficulty.reactionTime) {
      this.state = next;
      this.pendingState = null;
      this.pendingTimer = 0;
    }
  }

  // --- Where to go ---------------------------------------------------------

  private buildGoal(self: AircraftState): void {
    const difficulty = this.difficulty;
    const cruise = this.cruiseThrottle;
    let throttle = cruise;
    let maxBank = difficulty.maxBank * 0.7;
    let aimMode: "altitude" | "direct" = "altitude";

    switch (this.state) {
      case AI_STATE.Patrol:
        this.patrolGoal(self);
        // Nothing seen, nothing to hurry for: fly the battery, not the clock.
        if (this.unaware) throttle = cruise * ECONOMY_FACTOR;
        break;

      case AI_STATE.Search:
        this.searchGoal(self);
        throttle = Math.min(1, cruise + SEARCH_THROTTLE_BOOST);
        maxBank = difficulty.maxBank * 0.85;
        break;

      case AI_STATE.Intercept:
        this.pursuitGoal(self);
        throttle = this.pursuitThrottle(cruise);
        maxBank = difficulty.maxBank;
        break;

      case AI_STATE.Attack:
        this.pursuitGoal(self);
        throttle = difficulty.attackThrottle;
        maxBank = difficulty.maxBank;
        // Committed: point the aircraft itself at the target.
        aimMode = "direct";
        break;

      case AI_STATE.Evade:
        this.evadeGoal(self);
        throttle = difficulty.attackThrottle;
        maxBank = difficulty.maxBank * 0.8;
        break;

      case AI_STATE.Flee:
        this.fleeGoal(self);
        // Running is flown hard, and no two pilots run at quite the same
        // setting: the wander that varies a cruise varies this too.
        throttle = clamp(
          difficulty.fleeThrottle + (cruise - this.cruiseBase) * 2,
          0.7,
          1,
        );
        maxBank = difficulty.maxBank * 0.9;
        break;

      default:
        this.patrolGoal(self);
        break;
    }

    // The pilot's speed limit has the last word over every state above,
    // including the ones that would otherwise run at full power: a contact
    // that opens the throttle the moment it is chased is a contact that is
    // never caught, which is the whole reason the limit exists.
    //
    // The ramming pass is the exception, and only because it is not a chase.
    // `Attack` is entered inside a few hundred metres and lasts seconds, so
    // full power there buys the contact no ground on a player it is already
    // beside — but without it the pass never quite arrives, and a contact that
    // can approach but never connect is not opposition at all. Everything that
    // decides a chase — the patrol, the run in, and the running away — stays
    // under the limit, so a target can always be run down from behind and can
    // never run the player down.
    const chasing = this.state !== AI_STATE.Attack;
    const speed = chasing
      ? Math.min(this.speedFor(throttle), this.speedLimit)
      : this.speedFor(throttle);
    if (chasing) throttle = Math.min(throttle, this.throttleCeiling);

    // Terrain has the last word over anything the pilot wanted to do.
    liftAboveTerrain(this.terrain, this.goalTarget, difficulty.terrainMargin);

    this.goal = {
      target: this.goalTarget,
      speed,
      throttle,
      maxBank,
      climbBias: this.avoidance.climbDemand,
      headingBias: this.avoidance.headingOffset,
      aimMode,
    };
  }

  private patrolGoal(self: AircraftState): void {
    if (this.route.length === 0) {
      V.set(this.goalTarget, 0, 0, Math.max(self.position.z, 200));
      return;
    }
    this.waypointIndex = advanceWaypoint(
      this.route,
      this.waypointIndex,
      self.position,
      WAYPOINT_RADIUS,
    );
    V.copy(this.goalTarget, this.route[this.waypointIndex] as Vec3);
  }

  /**
   * Sweeps across the dead-reckoned track rather than flying straight at it:
   * the remembered position is a guess, and a guess is best searched around.
   */
  private searchGoal(self: AircraftState): void {
    if (!this.everSeen) {
      this.patrolGoal(self);
      return;
    }
    V.copy(this.goalTarget, this.lastKnown);

    const sweep = Math.sin(this.timeSinceSeen * 0.35 + this.searchPhase);
    const spread = clamp(this.timeSinceSeen * 22, 60, 700);
    // Offset perpendicular to the remembered heading.
    const heading = Math.atan2(this.lastKnownVelocity.x, this.lastKnownVelocity.y);
    this.goalTarget.x += Math.cos(heading) * sweep * spread;
    this.goalTarget.y += -Math.sin(heading) * sweep * spread;

    containWithin(this.goalTarget, this.missionRadius * 1.15);
  }

  /**
   * Aims at the interception point, with no boundary clamp.
   *
   * A committed chase follows the target wherever it goes. Clamping the aim
   * point to the mission area instead makes an enemy orbit an invisible fence
   * while a target it can plainly see flies away — the leash belongs in the
   * decision to break off, not in the geometry.
   */
  private pursuitGoal(self: AircraftState): void {
    interceptPoint(
      self.position,
      Math.max(
        self.airspeed,
        stallSpeed(self.config, undefined, self.damage.liftFactor) * 1.5,
      ),
      this.lastKnown,
      this.lastKnownVelocity,
      this.difficulty.prediction,
      MAX_INTERCEPT_HORIZON,
      this.aimPoint,
    );
    V.copy(this.goalTarget, this.aimPoint);
  }

  /**
   * Power for a chase, by how close it is to becoming a pass.
   *
   * A stern chase across three kilometres at full throttle is a chase nobody
   * can join: a contact is held to the speed of the aircraft hunting it, so
   * whoever opens the throttle first simply stays where they are relative to
   * the other. Held at
   * a cruise until the geometry is worth spending on, the same chase is one a
   * player can close — and the pilot still has full power for the pass itself.
   */
  private pursuitThrottle(cruise: number): number {
    const terminal = this.difficulty.attackRange * TERMINAL_RANGE_FACTOR;
    const closeness = Number.isFinite(this.rangeToTarget)
      ? clamp(
          (terminal - this.rangeToTarget) /
            Math.max(terminal - this.difficulty.attackRange, 1),
          0,
          1,
        )
      : 0;

    // A chase that is not gaining has to be flown at power, however far off
    // the target is. One that is closing on its own does not, and the power
    // spent on it only makes the pass harder to fly.
    const shortfall = clamp(1 - this.closureRate / USEFUL_CLOSURE, 0, 1);

    const cruising = Math.min(1, cruise + PURSUIT_THROTTLE_BOOST);
    return (
      cruising +
      (this.difficulty.attackThrottle - cruising) * Math.max(closeness, shortfall)
    );
  }

  /**
   * Runs from the contact.
   *
   * Straight away from where the target was last seen, trading a little height
   * for speed where there is height to trade, and curving back inside the
   * mission area rather than simply leaving — a pilot breaking contact is
   * getting away from an aircraft, not from the map.
   */
  private fleeGoal(self: AircraftState): void {
    V.subtract(_away, self.position, this.lastKnown);
    _away.z = 0;
    if (V.lengthSquared(_away) < 1) {
      forwardAxis(_away, self.orientation);
      _away.z = 0;
    }
    V.normalize(_away, _away);

    // Near the edge of the area the run bends back inside, so it turns into a
    // long curve rather than a straight line out of the mission.
    const fromOrigin = Math.hypot(self.position.x, self.position.y);
    const outward = clamp(fromOrigin / Math.max(this.missionRadius, 1) - 0.7, 0, 1);
    if (outward > 0 && fromOrigin > 1) {
      _away.x -= (self.position.x / fromOrigin) * outward * 2;
      _away.y -= (self.position.y / fromOrigin) * outward * 2;
      V.normalize(_away, _away);
    }

    V.addScaled(this.goalTarget, self.position, _away, FLEE_LOOKAHEAD);
    const dive = clamp(
      (self.altitudeAgl - this.difficulty.terrainMargin * 2) * 0.2,
      0,
      MAX_FLEE_DIVE,
    );
    this.goalTarget.z = self.position.z - dive;
    containWithin(this.goalTarget, this.missionRadius * 1.25);
  }

  /**
   * Breaks away and climbs. Height is energy, and energy is what turns a
   * missed pass into another one.
   */
  private evadeGoal(self: AircraftState): void {
    V.subtract(_toTarget, self.position, this.lastKnown);
    if (V.lengthSquared(_toTarget) < 1) {
      forwardAxis(_toTarget, self.orientation);
    }
    V.normalize(_toTarget, _toTarget);
    V.addScaled(this.goalTarget, self.position, _toTarget, 900);
    this.goalTarget.z = self.position.z + 250;
    containWithin(this.goalTarget, this.missionRadius * 1.2);
  }
}
