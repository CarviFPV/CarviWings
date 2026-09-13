/**
 * The rival racer.
 *
 * Flies a gate course the way a pilot does: line up on the gate from a long
 * way out, hold the line through the frame, then let the next gate pull the
 * turn. Like every other AI here it produces nothing but a normalised
 * `FlightInput` — it is subject to the same stall, inertia and terrain the
 * player is, and it cannot fly a corner the airframe will not fly.
 *
 * The aim point does the work. Far out it sits short of the gate on the gate's
 * own axis, which turns "get there" into "arrive lined up"; close in it slides
 * through the frame and out the other side, so the aircraft flies through the
 * gate rather than at it and is already pointing at the next leg when it
 * emerges. Between the two it is one continuous blend, which is why a rival
 * carves a corner instead of jinking at it.
 */

import { clamp } from "../math/scalar";
import { createRng } from "../math/rng";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS } from "../flight/state";
import { forwardAxis } from "../math/quat";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import type { TerrainSampler } from "../terrain/types";
import type { AutopilotGoal } from "./autopilot";
import { commandedSpeed, flyToward } from "./autopilot";
import type { AvoidanceCommand, TerrainAvoidanceOptions } from "./terrainAvoidance";
import {
  TerrainAvoidanceSystem,
  createAvoidanceCommand,
  liftAboveTerrain,
} from "./terrainAvoidance";
import type { RaceCourse, RaceGate, RaceProfile } from "../mission/race";

/** How often terrain is re-checked, seconds. */
const THINK_INTERVAL = 0.12;
/** How often the aim point is rebuilt, seconds. */
const AIM_INTERVAL = 0.05;
/** How far short of a gate the approach line is aimed, metres. */
const ENTRY_OFFSET = 140;
/** How far beyond a gate the aim point runs once it is close, metres. */
const EXIT_OFFSET = 110;
/** How far back down the axis a missed gate is re-approached from, metres. */
const REJOIN_OFFSET = 340;
/** How far to the side the re-approach swings, metres. */
const REJOIN_SIDE = 240;
/**
 * Clearance a rival keeps above the ground between gates, metres.
 *
 * A race is flown on the deck. The gates sit a few metres over the surface, so
 * the margin that suits a chase would fly the whole field over the top of the
 * course — this is low enough to leave every gate reachable and high enough
 * that a rival is not skimming the grass to get to one.
 */
const TERRAIN_MARGIN = 16;
/** The lowest it is ever trimmed to for a gate that sits lower still. */
const MIN_TERRAIN_MARGIN = 4;
/** How far under a gate's centre the margin is held, metres. */
const GATE_MARGIN_HEADROOM = 4;
/**
 * And the clearance a rival with the whole course behind it keeps.
 *
 * A finished rival is scenery rather than traffic: nothing is asking it to fly
 * low any more, so it gets a chase aircraft's margin back.
 */
const FINISHED_MARGIN = 60;
/** How quickly a rival's line wanders, radians per second. */
const WANDER_RATE = 0.35;
/**
 * How much of a gate's half width the outermost lane is offset by.
 *
 * The field starts abreast on one start line and every aircraft on it is
 * pointed at the same gate, so without this they would all converge on the
 * middle of the frame and arrive there at once. A lane is a rival's share of
 * the opening: it holds its side of the frames the way it held its side of the
 * grid, which keeps a tight start line flyable and reads like a race rather
 * than a queue.
 */
const LANE_FRACTION = 0.55;
/** And the furthest off the middle of a frame the aim point is ever taken. */
const LANE_LIMIT = 0.8;
/**
 * How much of a gate's half height the high and low lines are flown at.
 *
 * A frame is only so wide, and a full field cannot be laid across one with a
 * wingspan between every aircraft. It has height in it as well, though, so the
 * field is stacked as well as spread: neighbours on the grid take opposite
 * lines through the openings and pass each other with clear air in between
 * even where their lanes are almost the same.
 */
const LEVEL_FRACTION = 0.35;

/**
 * How a racer looks at the ground, which is not how a chase does.
 *
 * A chase is flown wherever the fight goes, so it probes half a minute ahead
 * and turns away from anything it cannot outclimb. A race is flown down a
 * course that has already been laid over the terrain: the line between two
 * gates is known to clear the ground, so the only thing left to react to is
 * the rise immediately in front — and turning off the line to avoid something
 * a hundred metres beyond the next gate loses the gate, which on a race track
 * is worse than the climb. So: a short horizon, and a nudge rather than a
 * break turn.
 */
const RACE_AVOIDANCE: TerrainAvoidanceOptions = {
  horizons: [1.5, 3, 5, 8],
  maxClimbDemand: 10,
  maxHeadingOffset: 10,
};

export interface RacePilotOptions {
  readonly id: string;
  readonly course: RaceCourse;
  readonly profile: RaceProfile;
  readonly terrain: TerrainSampler;
  /** Distinct per racer, so two rivals do not fly the identical line. */
  readonly seed: string;
  /** The gate this racer is flying at. The race tracker owns the answer. */
  readonly getNextGate: () => number;
  /**
   * Which side of the course this rival flies, -1 to 1. Its grid slot.
   *
   * Defaults to the middle, which is what a single rival with the course to
   * itself should fly.
   */
  readonly lane?: number;
  /** And how high through the frames, -1 to 1. Its grid slot again. */
  readonly level?: number;
  /**
   * The fastest this rival is flown, m/s.
   *
   * The pace on a race profile was written for the interceptor everybody used
   * to fly. A field can be flown on anything in the hangar now, so it is held
   * to what the aeroplane will actually do — and to what the pilot's own will,
   * because a rival nobody can stay with is a demonstration rather than a
   * race. Left out, the profile's pace stands as it always did.
   */
  readonly speedReference?: number;
}

export interface RacePilotDebug {
  readonly gate: number;
  readonly rangeToGate: number;
  readonly pace: number;
  readonly finished: boolean;
}

export class RacePilot {
  readonly id: string;

  private readonly course: RaceCourse;
  private readonly profile: RaceProfile;
  private readonly terrain: TerrainSampler;
  private readonly terrainAvoidance: TerrainAvoidanceSystem;
  private readonly getNextGate: () => number;

  /**
   * This pilot's own pace, decided once: rivals are not clones.
   *
   * One number for the whole pilot rather than a speed alone — a rival who
   * flies slower also banks less hard and starts the corner earlier, which is
   * what actually separates two pilots on a tight course, where nobody is
   * anywhere near the airframe's top speed anyway.
   */
  private readonly pace: number;
  private readonly maxBank: number;
  private readonly lookahead: number;
  private readonly wanderPhase: number;
  private readonly wanderVertical: number;
  /** This rival's side of the course, -1 to 1. */
  private readonly lane: number;
  /** And its line through the frames, -1 the bottom, 1 the top. */
  private readonly level: number;
  /** The ceiling on its pace, or null to fly the profile's own. */
  private readonly speedReference: number | null;

  private readonly input: FlightInput = createFlightInput();
  private readonly aimPoint = V.vec3();
  private readonly avoidance: AvoidanceCommand = createAvoidanceCommand();
  private goal: AutopilotGoal;

  /**
   * Clearance this pilot is currently protecting, metres.
   *
   * Follows the gate being flown at rather than being fixed: a course over
   * rooftops sits higher than one over a field, and the margin that keeps a
   * rival off the ground on one would fly it over the gates on the other.
   */
  private terrainMargin = TERRAIN_MARGIN;

  private thinkAccumulator = THINK_INTERVAL;
  private aimAccumulator = AIM_INTERVAL;
  private clock = 0;
  private rangeToGate = Number.POSITIVE_INFINITY;

  constructor(options: RacePilotOptions) {
    this.id = options.id;
    this.course = options.course;
    this.profile = options.profile;
    this.terrain = options.terrain;
    // Its own rather than the mission's: what a racer wants from the ground is
    // not what an interceptor wants from it.
    this.terrainAvoidance = new TerrainAvoidanceSystem(
      options.terrain,
      RACE_AVOIDANCE,
    );
    this.getNextGate = options.getNextGate;
    this.lane = clamp(options.lane ?? 0, -1, 1);
    this.level = clamp(options.level ?? 0, -1, 1);
    this.speedReference = options.speedReference ?? null;

    const rng = createRng(`${options.seed}:racer:${options.id}`);
    this.pace = 1 + rng.range(-options.profile.paceVariation, options.profile.paceVariation);
    this.maxBank = options.profile.racerMaxBank * this.pace;
    this.lookahead = options.profile.lookahead * (2 - this.pace);
    this.wanderPhase = rng.range(0, Math.PI * 2);
    this.wanderVertical = rng.range(0, Math.PI * 2);

    this.goal = {
      target: this.aimPoint,
      speed: options.profile.racerSpeed * this.pace,
      throttle: options.profile.racerThrottle,
      maxBank: this.maxBank,
      climbBias: 0,
      headingBias: 0,
    };
  }

  get debug(): RacePilotDebug {
    return {
      gate: this.getNextGate(),
      rangeToGate: this.rangeToGate,
      pace: this.pace,
      finished: this.getNextGate() >= this.course.gateCount,
    };
  }

  /** The `AircraftController` the simulation calls every physics step. */
  control = (self: AircraftState, dt: number): FlightInput => {
    if (self.status !== FLIGHT_STATUS.Flying) return neutral(this.input);
    this.clock += dt;

    this.thinkAccumulator += dt;
    if (this.thinkAccumulator >= THINK_INTERVAL) {
      this.terrainAvoidance.evaluate(self, this.terrainMargin, this.avoidance);
      this.thinkAccumulator = 0;
    }

    this.aimAccumulator += dt;
    if (this.aimAccumulator >= AIM_INTERVAL) {
      this.buildGoal(self);
      this.aimAccumulator = 0;
    }

    return flyToward(self, this.goal, this.input);
  };

  /** The pace it is asked for, held to the aeroplane it is sitting in. */
  private cruise(self: AircraftState, want: number): number {
    return commandedSpeed(self.config, want, this.speedReference);
  }

  private buildGoal(self: AircraftState): void {
    const gate = this.course.gate(this.getNextGate());

    if (!gate) {
      // The race is flown. Hold the heading and the height rather than press
      // on across the mission area: a finished rival is scenery, not traffic.
      forwardAxis(_forward, self.orientation);
      V.addScaled(this.aimPoint, self.position, _forward, 800);
      this.aimPoint.z = self.position.z;
      this.terrainMargin = FINISHED_MARGIN;
      liftAboveTerrain(this.terrain, this.aimPoint, this.terrainMargin);
      this.rangeToGate = Number.POSITIVE_INFINITY;
      this.goal = {
        target: this.aimPoint,
        speed: this.cruise(self, this.profile.racerSpeed * 0.7),
        throttle: this.profile.racerThrottle * 0.7,
        maxBank: this.maxBank * 0.6,
        climbBias: this.avoidance.climbDemand,
        headingBias: this.avoidance.headingOffset,
      };
      return;
    }

    const range = V.distance(self.position, gate.position);
    this.rangeToGate = range;
    this.terrainMargin = marginFor(this.terrain, gate);

    V.subtract(_offset, self.position, gate.position);
    const axial = _offset.x * gate.forward.x + _offset.y * gate.forward.y;
    const lateral = _offset.x * gate.right.x + _offset.y * gate.right.y;

    // Past the plane with the gate still owed: it was missed. Going straight
    // back at it does not work — the gate only counts flown the right way
    // round, so the aircraft has to be taken back behind it first. The
    // re-approach swings out to whichever side it is already on, which makes
    // the recovery one turn rather than a reversal, and stops a rival that
    // clipped a corner from orbiting the post it missed.
    if (axial > 0) {
      const side = lateral >= 0 ? 1 : -1;
      V.addScaled(this.aimPoint, gate.position, gate.forward, -REJOIN_OFFSET);
      V.addScaled(this.aimPoint, this.aimPoint, gate.right, side * REJOIN_SIDE);
      liftAboveTerrain(this.terrain, this.aimPoint, this.terrainMargin);
      this.goal = {
        target: this.aimPoint,
        speed: this.cruise(self, this.profile.racerSpeed * this.pace * 0.85),
        throttle: this.profile.racerThrottle,
        maxBank: this.maxBank,
        climbBias: this.avoidance.climbDemand,
        headingBias: this.avoidance.headingOffset,
      };
      return;
    }

    // One blend from "line up on the gate" to "fly out the far side of it".
    const closeness = clamp(1 - range / this.lookahead, 0, 1);
    const along = -ENTRY_OFFSET + closeness * (ENTRY_OFFSET + EXIT_OFFSET);

    V.addScaled(this.aimPoint, gate.position, gate.forward, along);

    // A rival that flies the exact centre of every gate reads as a machine.
    // The scatter is a slow wander rather than noise, so it costs a line
    // rather than the aircraft's composure — and it shrinks to nothing at the
    // frame itself, because clipping a gate is not a difficulty setting.
    //
    // The lane underneath it does not shrink: it is the rival's side of the
    // opening, and it is what keeps a field that started abreast from meeting
    // in the middle of the first frame. Both together are held well inside the
    // frame, because a lane flown into a post is not a lane.
    const wander = this.profile.lineError * (1 - closeness * 0.85);
    const across = clamp(
      this.lane * LANE_FRACTION * gate.halfWidth +
        Math.sin(this.clock * WANDER_RATE + this.wanderPhase) * wander,
      -gate.halfWidth * LANE_LIMIT,
      gate.halfWidth * LANE_LIMIT,
    );
    V.addScaled(this.aimPoint, this.aimPoint, gate.right, across);
    // The level is the other half of the same idea, and the half that does the
    // work where a frame is narrower than the field is wide: one aircraft takes
    // the high line through the opening and the one beside it the low one.
    const up = this.level * LEVEL_FRACTION * gate.halfHeight;
    this.aimPoint.z +=
      up +
      Math.sin(this.clock * WANDER_RATE * 0.7 + this.wanderVertical) *
        wander *
        0.5;

    liftAboveTerrain(this.terrain, this.aimPoint, this.terrainMargin);
    // Never above the frame being aimed at — the high line included, which is
    // why the ceiling is the rival's own line rather than the middle of the
    // gate. The floor is there to keep a rival off the ground on the way to a
    // gate, and on a course flown on the deck the ground on the way to a gate
    // is often higher than the gate — left to itself the floor would lift the
    // aim point over the top bar and the gate would be missed from above,
    // every lap, for a reason that looks like nothing. The leg is what keeps
    // this safe: the course is laid out so the line between two gates clears
    // the ground, so flying no higher than the gate cannot fly into anything.
    const ceiling = gate.position.z + Math.max(up, 0);
    if (this.aimPoint.z > ceiling) this.aimPoint.z = ceiling;

    // Straighten up for the frame: aiming down the gate's own axis only works
    // if the aircraft is not still banked when it gets there, and a rival that
    // arrives at ninety degrees of bank puts a wing through the post.
    const bankLimit =
      range < this.lookahead * 0.35 ? this.maxBank * 0.75 : this.maxBank;

    // On the run-in the gate *is* the answer to the ground: it was put where
    // it is by a layout that had the terrain in front of it, and a climb or a
    // turn taken now is a gate missed for a hill the course has already been
    // laid over. So the last few seconds are flown at the frame and nothing
    // else, which is what a pilot does.
    const committed = range < this.lookahead * 0.45;

    this.goal = {
      target: this.aimPoint,
      speed: this.cruise(self, this.profile.racerSpeed * this.pace),
      throttle: this.profile.racerThrottle,
      maxBank: bankLimit,
      climbBias: committed ? 0 : this.avoidance.climbDemand,
      headingBias: committed ? 0 : this.avoidance.headingOffset,
      // Close in, the gate is a point in the sky to be flown at rather than an
      // altitude to be held — the same reason an interception aims direct.
      aimMode: range < this.lookahead * 0.6 ? "direct" : "altitude",
    };
  }
}

/**
 * The clearance to protect while flying at one gate.
 *
 * The gate itself is the ceiling on it. A gate whose centre sits fifteen
 * metres over a rooftop cannot be flown by an aircraft holding sixteen, so the
 * margin is trimmed to pass under the frame — never below the floor, because a
 * rival that flies into a hillside to make a gate has not made it either.
 */
function marginFor(terrain: TerrainSampler, gate: RaceGate): number {
  const { x, y } = gate.position;
  if (!terrain.hasCoverage(x, y)) return TERRAIN_MARGIN;
  const agl = gate.position.z - terrain.heightAt(x, y);
  return clamp(
    Math.min(TERRAIN_MARGIN, agl - GATE_MARGIN_HEADROOM),
    MIN_TERRAIN_MARGIN,
    TERRAIN_MARGIN,
  );
}

const _forward = V.vec3();
const _offset = V.vec3();

function neutral(input: FlightInput): FlightInput {
  input.pitch = 0;
  input.roll = 0;
  input.yaw = 0;
  input.throttle = 0;
  return input;
}
