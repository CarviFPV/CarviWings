/**
 * The festival flyer.
 *
 * Somebody else's model aircraft, being flown badly on purpose. It circles the
 * field at its own height and its own radius, drops in for a low pass across
 * the middle every so often, and keeps almost no lookout — which is the whole
 * point. Twenty of these sharing five hundred metres of sky produce exactly
 * what a fly-in produces: near misses all afternoon and, every few minutes,
 * two wings arriving in the same place.
 *
 * Like every other AI here it produces nothing but a normalised `FlightInput`.
 * It flies the identical airframe under the identical flight model, so it
 * stalls, sinks and hits the ground under the same rules the player does, and
 * a wing bent in a mid-air flies as badly for it as it would for anybody.
 *
 * How much lookout a pilot keeps is decided once, per pilot, and varies from
 * "sees you coming and eases away" to "never looks up". Nobody here is trying
 * to hit anybody; the collisions are what happens when several people are
 * flying their own line over one field.
 *
 * Handed a streamer field, the same pilot flies the other event instead: it
 * picks somebody's ribbon, commits to it, and flies at the part of it its own
 * nerve is worth — close to the knot if it is one of the brave ones, out by
 * the tip if it is not. Everything else about it is unchanged, which is the
 * point: it is the same person flying the same aeroplane round the same field,
 * with something to chase.
 */

import { createRng } from "../math/rng";
import { clamp, DEG_TO_RAD } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS, isAirworthy } from "../flight/state";
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
import type { StreamerField, StreamerQuarry } from "../mission/streamer";
import {
  STREAMER_HUNT_RANGE,
  chooseQuarry,
  quarryOf,
} from "../mission/streamer";

/** How often the ground and the traffic are looked at, seconds. */
const THINK_INTERVAL = 0.14;
/** How often the aim point is rebuilt, seconds. */
const AIM_INTERVAL = 0.05;
/** How far ahead on the circuit the aim point sits, radians. */
const LEAD_ANGLE = 0.8;
/** Heights the field's circuits are flown at, spread across the band. */
const CIRCUIT_LEVELS = 3;
/** And the radii they are flown at, as fractions of the field. */
const CIRCUIT_RADII = [0.4, 0.7] as const;
/**
 * How long a flight line gets, metres either side of the middle.
 *
 * Capped rather than proportional, because a flight line is not a property of
 * how much airspace the club has: it is the bit of sky in front of where the
 * pilots are standing, and it is about the same length at a huge site as at a
 * small one. What a bigger field buys is room to get away from everybody, not
 * a longer line — which is exactly the choice the setup screen is offering.
 */
const LINE_REACH_CAP = 320;
/** And the same for the circuits flown off the ends of it. */
const CIRCUIT_RADIUS_CAP = 360;
/** How far either side of the flight line a pass is flown, metres. */
const LINE_SPREAD = 9;
/** And how far above or below the line's own height. */
const LINE_HEIGHT_SPREAD = 6;
/** Clearance a festival aircraft keeps above the ground, metres. */
const TERRAIN_MARGIN = 30;
/** And the clearance a low pass is flown at. */
const PASS_MARGIN = 18;
/** Integrity below which a pilot stops showing off and takes it home. */
const WOUNDED_INTEGRITY = 0.8;
/** How fast an aircraft called down loses height, m/s. */
const LANDING_DESCENT = 2.4;
/**
 * Where the approach is aimed at the end of it, metres above the ground.
 *
 * Slightly into it: an aircraft flown at a point two metres over the grass
 * flies along two metres over the grass for ever. A wing is landed by flying
 * it at the ground and letting the ground stop it, and how gently that happens
 * is decided by the descent above rather than by the number here.
 */
const LANDING_HEIGHT = -1;
/** Below this height the aircraft is landing rather than positioning. */
const FINAL_HEIGHT = 45;
/** How far out another aircraft is worth easing away from, metres. */
const LOOKOUT_RANGE = 140;
/** Hardest heading change a lookout will produce, degrees. */
const LOOKOUT_TURN = 30;
/** And the hardest climb, m/s. */
const LOOKOUT_CLIMB = 4;

/** How long a pilot works one tail before looking for a better one, seconds. */
const QUARRY_COMMIT = 9;
/**
 * How far down a ribbon the bravest and the most careful of them will fly.
 *
 * As a fraction of what is left of the paper, nought being the knot on the
 * tail. The whole spread of a real field is in these two numbers: the pilot at
 * the bottom of it takes streamers off at the root and puts one into the
 * ground every other wave, and the one at the top nibbles at tips all
 * afternoon and never hits anything.
 */
const BOLDEST_AIM = 0.18;
const MOST_CAUTIOUS_AIM = 0.8;
/** How much more speed a pilot carries once it is on somebody, 1 = its own. */
const CHASE_SPEED = 1.12;
/** And how much more bank it will use to stay there. */
const CHASE_BANK = 1.25;

/**
 * How a festival flyer looks at the ground.
 *
 * Low and slow over one field, so the horizon that matters is the next few
 * seconds rather than the next half minute — and the answer to rising ground
 * over a display field is a gentle lift, not a break turn away from the crowd
 * line.
 */
const FESTIVAL_AVOIDANCE: TerrainAvoidanceOptions = {
  horizons: [1.5, 3, 5, 8, 12],
  maxClimbDemand: 9,
  maxHeadingOffset: 18,
};

export interface FestivalPilotOptions {
  readonly id: string;
  /** Centre of the flying area, local ENU metres. */
  readonly centre: Readonly<Vec3>;
  /** Radius of the flying area, metres. */
  readonly areaRadius: number;
  /** Lowest and highest this pilot will fly, metres above the ground. */
  readonly floor: number;
  readonly ceiling: number;
  readonly terrain: TerrainSampler;
  /** Distinct per aircraft, so no two fly the same circuit. */
  readonly seed: string;
  /** Everything else in the sky, for what lookout this pilot keeps. */
  readonly getTraffic: () => readonly AircraftState[];
  /**
   * The fastest this one is flown, m/s.
   *
   * A circuit speed drawn for a 1.4 m delta is not a circuit speed for a 2.1 m
   * survey wing or for a quadcopter, so what the pilot picked is held to what
   * the aeroplane will actually do. Left out, the drawn speed stands.
   */
  readonly speedReference?: number;
  /**
   * The paper in the air, at a streamer event.
   *
   * Left out — which is every fly-in — nobody hunts anybody and this pilot is
   * exactly what it always was.
   */
  readonly streamers?: StreamerField | null;
}

export interface FestivalPilotDebug {
  readonly band: number;
  readonly orbitRadius: number;
  readonly passing: boolean;
  readonly wounded: boolean;
  /** Metres to the nearest other aircraft the last time it looked. */
  readonly nearest: number;
  /** The tail it is working, at a streamer event; null when it is not. */
  readonly quarry: string | null;
  /** How far down that ribbon it is flying, 0 at the knot and 1 at the tip. */
  readonly aimFraction: number;
}

export class FestivalPilot {
  readonly id: string;

  private readonly centre: Readonly<Vec3>;
  private readonly areaRadius: number;
  private readonly floor: number;
  private readonly ceiling: number;
  private readonly terrain: TerrainSampler;
  private readonly terrainAvoidance: TerrainAvoidanceSystem;
  private readonly getTraffic: () => readonly AircraftState[];
  private readonly streamers: StreamerField | null;

  // --- This pilot, decided once ---------------------------------------------
  /** Cruise airspeed, m/s. */
  private readonly speed: number;
  /** The ceiling on it, or null to fly what was drawn. */
  private readonly speedReference: number | null;
  private readonly throttle: number;
  private readonly maxBank: number;
  /** Height above the ground this pilot flies its circuit at, metres. */
  private readonly band: number;
  /** Radius of that circuit, metres. */
  private readonly orbitRadius: number;
  /** Which way round the field it goes. */
  private readonly direction: 1 | -1;
  /** How much notice it takes of anybody else, 0..1. */
  private readonly lookout: number;
  /**
   * How far down somebody's ribbon it is willing to fly, 0..1.
   *
   * This pilot's nerve, drawn once and never revisited — a pilot who goes for
   * roots goes for roots all afternoon, which is why the same one keeps
   * winning the event and keeps writing off aeroplanes.
   */
  private readonly aimFraction: number;
  /** How far out it will cross the field for a tail, metres. */
  private readonly huntRange: number;
  private readonly wanderPhase: number;
  private readonly wanderRate: number;
  /** Seconds between runs down the flight line. */
  private readonly passInterval: number;
  private readonly passDuration: number;
  /**
   * The direction everybody's passes are flown along, radians.
   *
   * Shared by the whole field, because it is a property of the field rather
   * than of the pilot: a flying site has one line, worked out from where the
   * pilots stand and which way the strip runs, and everybody beats up that
   * line and no other. It is also, for the same reason, where the day's
   * mid-airs happen.
   */
  private readonly lineAngle: number;
  /** How far down the line a pass is flown, metres either side of the middle. */
  private readonly lineReach: number;
  /**
   * How far off the middle of that line this pilot flies it.
   *
   * A drift rather than a fixed offset, and that is the whole difference
   * between a fly-in and a display: two people holding two constant offsets
   * never meet however many times they pass each other, because the gap
   * between them is the same gap every time. Real ones wander across the line
   * as they work it, and every so often two of them are wandering through the
   * same part of it at the same moment.
   */
  private readonly lineAmplitude: number;
  private readonly lineDriftRate: number;
  private readonly lineDriftPhase: number;
  /** Which way down the line the current pass is going. */
  private passDirection: 1 | -1;

  private readonly input: FlightInput = createFlightInput();
  private readonly aimPoint = V.vec3();
  private readonly avoidance: AvoidanceCommand = createAvoidanceCommand();
  private goal: AutopilotGoal;

  private angle: number;
  private clock = 0;
  /** True once the line has been called down and this one is going home. */
  private landing = false;
  /** Height the approach is being flown down from, metres above the ground. */
  private landingHeight = 0;
  private passTimer: number;
  private passing = false;
  /** The airframe whose paper it is working, and how long it has left on it. */
  private quarryId: string | null = null;
  private quarryTimer = 0;
  private quarry: StreamerQuarry | null = null;
  private readonly quarryPoint = V.vec3();
  private wounded = false;
  private nearestRange = Number.POSITIVE_INFINITY;
  private trafficTurn = 0;
  private trafficClimb = 0;
  private thinkAccumulator = THINK_INTERVAL;
  private aimAccumulator = AIM_INTERVAL;

  constructor(options: FestivalPilotOptions) {
    this.id = options.id;
    this.centre = options.centre;
    this.areaRadius = Math.max(options.areaRadius, 60);
    this.floor = options.floor;
    this.ceiling = Math.max(options.ceiling, options.floor + 20);
    this.terrain = options.terrain;
    this.terrainAvoidance = new TerrainAvoidanceSystem(
      options.terrain,
      FESTIVAL_AVOIDANCE,
    );
    this.getTraffic = options.getTraffic;
    this.streamers = options.streamers ?? null;

    // The line belongs to the field, so it is drawn from the mission seed
    // alone: every pilot of a wave works out the same one.
    this.lineAngle = createRng(`${options.seed}:festival:line`).range(
      0,
      Math.PI * 2,
    );
    this.lineReach = Math.min(this.areaRadius * 0.95, LINE_REACH_CAP);

    const rng = createRng(`${options.seed}:festival:${options.id}`);
    // Drawn before it is held to the airframe, so the same pilot flies the
    // same circuit at whatever speed the aeroplane it turned up in will do.
    this.speedReference = options.speedReference ?? null;
    this.speed = rng.range(17, 27);
    this.throttle = rng.range(0.45, 0.68);
    this.maxBank = rng.range(35, 62);
    // Circuits are flown at a handful of shared heights rather than at a
    // height per pilot. That is what a field looks like — everybody keeps to
    // roughly the same few levels because that is where you can see your own
    // aeroplane from — and it is also why two of them occasionally arrive in
    // the same place. Spread continuously over the whole band, nobody would
    // ever meet anybody.
    const level = rng.int(0, CIRCUIT_LEVELS - 1);
    this.band =
      this.floor +
      ((this.ceiling - this.floor) * level) / Math.max(CIRCUIT_LEVELS - 1, 1);
    this.orbitRadius = Math.min(
      this.areaRadius *
        (CIRCUIT_RADII[rng.int(0, CIRCUIT_RADII.length - 1)] as number),
      CIRCUIT_RADIUS_CAP,
    );
    this.direction = rng.next() < 0.5 ? 1 : -1;
    // A third of the field is barely looking where it is going.
    this.lookout = rng.next() < 0.35 ? rng.range(0, 0.25) : rng.range(0.4, 1);
    // Drawn whether or not there is paper today, so a pilot is the same pilot
    // in both events and a field flown on one seed is the same field on the
    // other.
    this.aimFraction = rng.range(BOLDEST_AIM, MOST_CAUTIOUS_AIM);
    this.huntRange = rng.range(STREAMER_HUNT_RANGE * 0.45, STREAMER_HUNT_RANGE);
    this.wanderPhase = rng.range(0, Math.PI * 2);
    this.wanderRate = rng.range(0.12, 0.34);
    // Both measured in crossings of the field rather than in seconds, so a
    // pass on a big site is a long run down a long line instead of a nine
    // second excursion that never gets anywhere: what fills a field is how
    // much of the time everybody spends on the line, and that does not change
    // when the line gets longer.
    const crossing = (2 * this.lineReach) / this.speed;
    this.passInterval = crossing * rng.range(0.4, 0.9);
    this.passDuration = crossing * rng.range(0.55, 1);
    this.lineAmplitude = rng.range(LINE_SPREAD * 0.4, LINE_SPREAD);
    this.lineDriftRate = rng.range(0.05, 0.17);
    this.lineDriftPhase = rng.range(0, Math.PI * 2);
    this.passDirection = rng.next() < 0.5 ? 1 : -1;
    this.angle = rng.range(0, Math.PI * 2);
    // Staggered, so the whole field does not go down the line together in the
    // first minute and then never again.
    this.passTimer = rng.range(0, this.passInterval);

    this.goal = {
      target: this.aimPoint,
      speed: this.speed,
      throttle: this.throttle,
      maxBank: this.maxBank,
      climbBias: 0,
      headingBias: 0,
    };
  }

  /**
   * The line has been called down: put it on the ground.
   *
   * Not a hand on the aircraft — it is still flown, down a gentle approach at
   * the pilot's own speed, and what the ground makes of the arrival is the
   * same judgement any other landing gets.
   */
  recall(): void {
    this.landing = true;
  }

  get debug(): FestivalPilotDebug {
    return {
      band: this.band,
      orbitRadius: this.orbitRadius,
      passing: this.passing,
      wounded: this.wounded || this.landing,
      nearest: this.nearestRange,
      quarry: this.quarryId,
      aimFraction: this.aimFraction,
    };
  }

  /** The `AircraftController` the simulation calls every physics step. */
  control = (self: AircraftState, dt: number): FlightInput => {
    if (self.status !== FLIGHT_STATUS.Flying) return neutral(this.input);
    this.clock += dt;

    if (this.landing) {
      // The approach starts from wherever the recall found it and comes down
      // at a rate a model actually descends at, rather than being pointed at
      // the ground from two hundred metres.
      if (this.landingHeight <= 0) this.landingHeight = self.altitudeAgl;
      this.landingHeight = Math.max(
        LANDING_HEIGHT,
        this.landingHeight - LANDING_DESCENT * dt,
      );
    }

    this.quarryTimer -= dt;

    this.thinkAccumulator += dt;
    if (this.thinkAccumulator >= THINK_INTERVAL) {
      // On the way down the ground is where it is going, so the only thing
      // still worth avoiding is ground it did not choose.
      const margin = this.landing
        ? Math.min(this.landingHeight, PASS_MARGIN)
        : this.passing
          ? PASS_MARGIN
          : TERRAIN_MARGIN;
      this.terrainAvoidance.evaluate(self, margin, this.avoidance);
      // Picked before the lookout, which needs to know who is being chased:
      // easing away from the tail you are trying to cut is how nobody ever
      // cuts anything.
      this.pickQuarry(self);
      this.lookOut(self);
      this.thinkAccumulator = 0;
    }

    this.advanceCircuit(self, dt);

    this.aimAccumulator += dt;
    if (this.aimAccumulator >= AIM_INTERVAL) {
      this.buildGoal(self);
      this.aimAccumulator = 0;
    }

    return flyToward(self, this.goal, this.input);
  };

  /**
   * Walks the aim point round the circuit, and decides when to break off and
   * run the flight line instead.
   *
   * The circuit is advanced at the rate the aircraft is actually travelling,
   * so a slow aeroplane is not dragged round the field by a point it can never
   * catch — and a fast one is not left following something crawling.
   */
  private advanceCircuit(self: AircraftState, dt: number): void {
    const speed = Math.max(V.length(self.velocity), 4);
    this.angle += this.direction * (speed / Math.max(this.orbitRadius, 40)) * dt;

    this.passTimer -= dt;
    // A pass ends where the line ends, not when a stopwatch says so: run out
    // of field and you pull up and go round, which is the turn every model
    // flyer does at the end of every beat-up.
    const along =
      ((self.position.x - this.centre.x) * Math.sin(this.lineAngle) +
        (self.position.y - this.centre.y) * Math.cos(this.lineAngle)) *
      this.passDirection;
    if (this.passing && along > this.lineReach * 0.8) this.passTimer = 0;

    if (this.passTimer <= 0) {
      if (this.passing) {
        this.passing = false;
        this.passTimer = this.passInterval;
      } else {
        this.passing = true;
        this.passTimer = this.passDuration;
        // Down the line away from whichever end the aircraft is at: a pass is
        // flown from where you are, not from where the line starts.
        this.passDirection = along * this.passDirection <= 0 ? 1 : -1;
      }
    }
  }

  /**
   * What a pilot who is looking sees.
   *
   * Only the nearest aircraft, only if it is roughly where this one is going,
   * and only as much of a turn as this pilot's lookout is worth. Nobody here
   * has a collision-avoidance system: this is a person glancing up from the
   * transmitter, which is why it is not enough.
   */
  private lookOut(self: AircraftState): void {
    this.trafficTurn = 0;
    this.trafficClimb = 0;
    this.nearestRange = Number.POSITIVE_INFINITY;
    if (this.lookout <= 0.05) return;

    let nearest: AircraftState | null = null;
    for (const other of this.getTraffic()) {
      if (other.id === self.id) continue;
      // The one it is chasing is not traffic. Nobody who has committed to a
      // streamer keeps a lookout for the aeroplane towing it — that is what
      // makes the event the event.
      if (other.id === this.quarryId) continue;
      if (!isAirworthy(other.status)) continue;
      const range = V.distance(other.position, self.position);
      if (range >= this.nearestRange) continue;
      this.nearestRange = range;
      nearest = other;
    }

    if (!nearest || this.nearestRange > LOOKOUT_RANGE) return;

    // Only what is ahead is worth reacting to: turning away from something
    // already behind the wing is how two aircraft turn into each other.
    V.subtract(_offset, nearest.position, self.position);
    const heading = Math.atan2(self.velocity.x, self.velocity.y);
    const bearing = Math.atan2(_offset.x, _offset.y);
    const relative = ((bearing - heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (Math.abs(relative) > 70 * DEG_TO_RAD) return;

    const urgency =
      this.lookout * clamp(1 - this.nearestRange / LOOKOUT_RANGE, 0, 1);
    // Away from it, and over the top of it: the two together are what a pilot
    // does when something appears in the way.
    this.trafficTurn = (relative >= 0 ? -1 : 1) * LOOKOUT_TURN * urgency;
    this.trafficClimb =
      (_offset.z < 0 ? 1 : -0.6) * LOOKOUT_CLIMB * urgency;
  }

  /**
   * Picks the tail this pilot is working, at a streamer event.
   *
   * Stickiness is the whole of it. A pilot who took the nearest ribbon every
   * tenth of a second would spend the slot swapping between two aircraft
   * passing each other and never get behind either; one that commits flies the
   * thing it committed to until the paper is gone, the aeroplane is gone, or
   * it has spent long enough failing to get near it that somebody else's tail
   * is worth more.
   */
  private pickQuarry(self: AircraftState): void {
    const field = this.streamers;
    if (!field || this.landing) {
      this.quarry = null;
      this.quarryId = null;
      return;
    }

    if (this.quarryId !== null && this.quarryTimer > 0) {
      const held = quarryOf(this.quarryPoint, field, this.quarryId, this.aimFraction);
      if (held) {
        this.quarry = held;
        return;
      }
    }

    const found = chooseQuarry(this.quarryPoint, field, self, {
      aimFraction: this.aimFraction,
      searchRange: this.huntRange,
    });
    this.quarry = found;
    this.quarryId = found ? found.ownerId : null;
    this.quarryTimer = QUARRY_COMMIT;
  }

  /**
   * Flying at somebody's paper.
   *
   * Straight at the point on the ribbon this pilot's nerve picked out, with
   * the speed and the bank a pilot uses when they have decided to have
   * somebody. The only thing held back is the ground: a streamer chased down a
   * hillside is still a streamer chased into a hillside, and the terrain
   * system has the last word here exactly as it does on the circuit.
   */
  private buildChase(self: AircraftState): void {
    const quarry = this.quarry;
    if (!quarry) return;

    V.copy(this.aimPoint, quarry.aim);
    liftAboveTerrain(this.terrain, this.aimPoint, PASS_MARGIN);

    this.goal = {
      target: this.aimPoint,
      speed: this.cruise(self, this.speed * CHASE_SPEED),
      // Chasing a tail is flown on the motor: a pilot who is falling behind
      // does not stay on anybody's paper.
      throttle: Math.min(this.throttle * 1.25, 1),
      maxBank: Math.min(this.maxBank * CHASE_BANK, 75),
      climbBias: this.avoidance.climbDemand,
      headingBias: this.avoidance.headingOffset + this.trafficTurn,
    };
  }

  /**
   * The approach, once the line has been called down.
   *
   * Positioned back toward the field on a shallow descent while there is
   * height to lose, and then flown straight at whatever is in front of it for
   * the last few metres — a wing put down in a turn arrives on one tip, which
   * the ground rules judge as a crash and which is exactly what a pilot avoids
   * by rolling level before the flare.
   */
  private buildApproach(self: AircraftState): void {
    const onFinal = self.altitudeAgl < FINAL_HEIGHT;

    if (onFinal) {
      // Straight ahead and level. Far enough out that the autopilot flies a
      // heading rather than a point it is about to arrive at.
      forwardAxis(_forward, self.orientation);
      V.addScaled(this.aimPoint, self.position, _forward, 600);
    } else {
      // Back over the field, so nobody lands a kilometre out in a wood.
      V.copy(this.aimPoint, this.centre);
    }

    const ground = this.terrain.hasCoverage(this.aimPoint.x, this.aimPoint.y)
      ? this.terrain.heightAt(this.aimPoint.x, this.aimPoint.y)
      : this.centre.z;
    this.aimPoint.z = ground + this.landingHeight;

    this.goal = {
      target: this.aimPoint,
      // Slow, but never so slow that the wing stops flying before the ground
      // has it: the autopilot's own stall guard has the final say anyway.
      speed: this.cruise(self, this.speed * 0.75),
      throttle: onFinal ? 0.12 : this.throttle * 0.6,
      maxBank: onFinal ? 12 : this.maxBank * 0.5,
      climbBias: this.avoidance.climbDemand,
      headingBias: onFinal ? 0 : this.avoidance.headingOffset,
    };
  }

  /** The speed it is asked for, held to the aeroplane it turned up in. */
  private cruise(self: AircraftState, want: number): number {
    return commandedSpeed(self.config, want, this.speedReference);
  }

  private buildGoal(self: AircraftState): void {
    const wounded = self.damage.integrity < WOUNDED_INTEGRITY;
    this.wounded = wounded;
    const range = Math.hypot(
      self.position.x - this.centre.x,
      self.position.y - this.centre.y,
    );

    if (this.landing) {
      this.buildApproach(self);
      return;
    }

    // A wing that has been hit stops hunting: it has an aeroplane to get home
    // rather than a streamer to win, which is also true of the pilot flying it.
    if (this.quarry && !wounded && range <= this.areaRadius * 1.1) {
      this.buildChase(self);
      return;
    }

    // A wing that has been hit is flown home rather than displayed: back off
    // the speed, back off the bank, and let it down onto the field.
    const bank = wounded ? this.maxBank * 0.45 : this.maxBank;
    const speed = this.cruise(self, wounded ? this.speed * 0.8 : this.speed);

    const passing = this.passing && !wounded;

    // The line is flown at the line's height and nobody wanders on it: that is
    // what makes it a line, and it is why a field that all flies the same one
    // eventually has two aircraft in the same piece of it.
    let height = wounded
      ? this.floor * 0.6
      : passing
        ? Math.max(this.floor * 0.7, PASS_MARGIN) +
          LINE_HEIGHT_SPREAD *
            Math.sin(this.clock * this.lineDriftRate * 0.7 + this.lineDriftPhase * 1.7)
        : this.band +
          // Off the line, a slow wander, so nothing sits at exactly one
          // altitude for a whole afternoon and two circuits at the same level
          // are not parallel for ever.
          Math.sin(this.clock * this.wanderRate + this.wanderPhase) *
            (this.ceiling - this.floor) *
            0.18;

    const axisX = Math.sin(this.lineAngle);
    const axisY = Math.cos(this.lineAngle);

    if (range > this.areaRadius * 1.1) {
      // Outside the field. Whatever it was doing, it comes back.
      V.copy(this.aimPoint, this.centre);
    } else if (passing) {
      // Onto the line and then along it, rather than at the far end of it from
      // wherever the circuit had got to: a beat-up is flown down the line, and
      // a diagonal across the field to the end of it is not one.
      const along =
        (self.position.x - this.centre.x) * axisX +
        (self.position.y - this.centre.y) * axisY;
      const reach = clamp(
        along + this.passDirection * this.lineReach * 0.55,
        -this.lineReach,
        this.lineReach,
      );
      const offset =
        this.lineAmplitude *
        Math.sin(this.clock * this.lineDriftRate + this.lineDriftPhase);
      this.aimPoint.x = this.centre.x + axisX * reach + axisY * offset;
      this.aimPoint.y = this.centre.y + axisY * reach - axisX * offset;
    } else {
      const ahead = this.angle + this.direction * LEAD_ANGLE;
      const wobble =
        1 + Math.sin(this.clock * this.wanderRate * 1.7 + this.wanderPhase) * 0.14;
      const radius = clamp(
        this.orbitRadius * wobble,
        this.areaRadius * 0.2,
        this.areaRadius * 0.94,
      );
      this.aimPoint.x = this.centre.x + Math.sin(ahead) * radius;
      this.aimPoint.y = this.centre.y + Math.cos(ahead) * radius;
    }

    const ground = this.terrain.hasCoverage(this.aimPoint.x, this.aimPoint.y)
      ? this.terrain.heightAt(this.aimPoint.x, this.aimPoint.y)
      : this.centre.z;
    this.aimPoint.z = ground + Math.max(height, PASS_MARGIN * 0.6);
    liftAboveTerrain(
      this.terrain,
      this.aimPoint,
      this.passing ? PASS_MARGIN : Math.min(TERRAIN_MARGIN, height),
    );

    this.goal = {
      target: this.aimPoint,
      speed,
      throttle: this.throttle,
      maxBank: bank,
      climbBias: this.avoidance.climbDemand + this.trafficClimb,
      headingBias: this.avoidance.headingOffset + this.trafficTurn,
    };
  }
}

/**
 * Where one aircraft of a festival wave starts.
 *
 * Spread round the field on a ring rather than stacked over the centre: a wave
 * that launches into the same cubic metre has its first mid-air before anybody
 * has touched a stick, which is a bug rather than a fly-in.
 *
 * Writes into `out` and returns it.
 */
export function festivalSpawnPoint(
  out: Vec3,
  index: number,
  count: number,
  centre: Readonly<Vec3>,
  areaRadius: number,
  floor: number,
  ceiling: number,
): Vec3 {
  const total = Math.max(count, 1);
  const angle = (index / total) * Math.PI * 2;
  // Alternating radii, so a big wave is two rings rather than one crowded one.
  const radius = areaRadius * (index % 2 === 0 ? 0.55 : 0.85);
  // And alternating heights up the band, which is what gives a wave somewhere
  // to spread into before anybody starts turning.
  const step = total > 1 ? index / (total - 1) : 0.5;
  out.x = centre.x + Math.sin(angle) * radius;
  out.y = centre.y + Math.cos(angle) * radius;
  out.z = centre.z + floor + (ceiling - floor) * step;
  return out;
}

/** Heading that puts a spawned aircraft round the field rather than across it. */
export function festivalSpawnHeading(index: number, count: number): number {
  const angle = (index / Math.max(count, 1)) * 360;
  // Tangential to the ring, alternating direction with the ring the aircraft
  // was put on.
  return (angle + (index % 2 === 0 ? 90 : 270)) % 360;
}

const _offset = V.vec3();
const _forward = V.vec3();

function neutral(input: FlightInput): FlightInput {
  input.pitch = 0;
  input.roll = 0;
  input.yaw = 0;
  input.throttle = 0;
  return input;
}
