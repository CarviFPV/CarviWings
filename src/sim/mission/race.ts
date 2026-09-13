/**
 * Gate racing.
 *
 * A course is a chain of gates laid out from the mission seed, and a race is
 * the stopwatch that watches aircraft fly through them in order. Everything
 * here is geometry and bookkeeping — it reads aircraft state and writes
 * nothing back, so the whole timing rule is testable in Node without a
 * renderer, a controller or a globe.
 *
 * The rule the pilot is flying to:
 *
 *   - the clock starts on the first gate and stops on the last one
 *   - gates only count in order, and only when flown through the frame the
 *     right way round
 *   - everybody on the course is timed the same way, so the standings are the
 *     same question asked of every aircraft
 */

import { clamp, DEG_TO_RAD, RAD_TO_DEG } from "../math/scalar";
import { createRng } from "../math/rng";
import type { Rng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { AIRCRAFT_ROLE, isAirworthy } from "../flight/state";
import type { Difficulty } from "../ai/types";
import { DIFFICULTY } from "../ai/types";
import type { TerrainSampler } from "../terrain/types";

export const MIN_RACE_GATES = 3;
export const MAX_RACE_GATES = 24;
/** Fewest rivals the course is ever set up for: nobody, which is a time trial. */
export const MIN_RACE_COMPETITORS = 0;
/** Most rivals the course will ever be asked to hold. */
export const MAX_RACE_COMPETITORS = 7;
/**
 * How far the course runs, metres, before the mission area clamps it.
 *
 * The shortest one is a handful of gates on a field rather than a cross-
 * country; the longest is as far as a course is worth laying out at all.
 */
export const MIN_COURSE_LENGTH = 500;
export const MAX_COURSE_LENGTH = 20000;
export const COURSE_LENGTH_STEP = 500;
/** Shortest and longest leg the layout will build, metres. */
export const MIN_LEG = 220;
export const MAX_LEG = 4000;

/**
 * The two shapes a course comes in.
 *
 * They are different races rather than the same race drawn differently. A
 * sprint is flown once, from a start line to a finish line somewhere else
 * entirely. A circuit comes back to where it started, and its finish *is* its
 * start line — one frame in the sky that the clock starts on and stops on.
 */
export const RACE_SHAPE = {
  /** Start line here, finish line somewhere else. */
  Sprint: "SPRINT",
  /** A closed loop: the last gate is the first one, come back round. */
  Circuit: "CIRCUIT",
} as const;

export type RaceShape = (typeof RACE_SHAPE)[keyof typeof RACE_SHAPE];

export interface RaceSettings {
  /** AI racers flying the course beside the player. */
  readonly competitors: number;
  /** Gates in the course, start and finish included. */
  readonly gateCount: number;
  /** How far the course runs, metres, before the mission area clamps it. */
  readonly courseLength: number;
  readonly shape: RaceShape;
}

export const DEFAULT_RACE: RaceSettings = {
  competitors: 3,
  gateCount: 10,
  courseLength: 5000,
  shape: RACE_SHAPE.Sprint,
};

/**
 * What a difficulty setting changes about a race.
 *
 * Two separate things, and both of them are the pilot rather than the
 * aeroplane: how tight a course is laid out, and how well the rivals fly it.
 * Every aircraft on the course is the identical airframe at every difficulty.
 */
export interface RaceProfile {
  readonly id: Difficulty;
  readonly label: string;
  readonly description: string;

  // --- The course -----------------------------------------------------------
  /** Half the width of a gate opening, metres. */
  readonly gateHalfWidth: number;
  /** Half the height of a gate opening, metres. */
  readonly gateHalfHeight: number;
  /** Shortest and longest leg between two gates, metres. */
  readonly minLeg: number;
  readonly maxLeg: number;
  /** Hardest turn the course asks for between two legs, degrees. */
  readonly turnDeg: number;

  // --- The rivals -----------------------------------------------------------
  /** Airspeed a rival flies the course at, m/s. */
  readonly racerSpeed: number;
  /** Nominal throttle before the speed correction. */
  readonly racerThrottle: number;
  /** Hardest bank a rival will command, degrees. */
  readonly racerMaxBank: number;
  /** How far off the middle of a gate a rival wanders, metres. */
  readonly lineError: number;
  /** Spread of pace between one rival and the next, as a fraction. */
  readonly paceVariation: number;
  /** Range at which a rival starts flying the gate rather than toward it. */
  readonly lookahead: number;
}

export const RACE_PROFILES: Readonly<Record<Difficulty, RaceProfile>> = {
  [DIFFICULTY.Easy]: {
    id: DIFFICULTY.Easy,
    label: "Easy",
    description:
      "Wide gates, long legs and gentle turns. The rivals fly a clean line but never hurry.",
    gateHalfWidth: 26,
    gateHalfHeight: 20,
    minLeg: 700,
    maxLeg: 1000,
    turnDeg: 45,
    racerSpeed: 23,
    racerThrottle: 0.6,
    racerMaxBank: 45,
    lineError: 14,
    paceVariation: 0.1,
    lookahead: 320,
  },
  [DIFFICULTY.Normal]: {
    id: DIFFICULTY.Normal,
    label: "Normal",
    description:
      "Gates you have to aim at, proper turns between them, and rivals who hold a racing line.",
    gateHalfWidth: 18,
    gateHalfHeight: 14,
    minLeg: 520,
    maxLeg: 820,
    turnDeg: 80,
    racerSpeed: 29,
    racerThrottle: 0.72,
    racerMaxBank: 62,
    lineError: 7,
    paceVariation: 0.07,
    lookahead: 260,
  },
  [DIFFICULTY.Hard]: {
    id: DIFFICULTY.Hard,
    label: "Hard",
    description:
      "Tight gates, hard reversals and steep changes of height. The rivals give away nothing.",
    gateHalfWidth: 12,
    gateHalfHeight: 10,
    minLeg: 380,
    maxLeg: 680,
    turnDeg: 115,
    racerSpeed: 30,
    racerThrottle: 0.85,
    racerMaxBank: 74,
    lineError: 3,
    paceVariation: 0.06,
    lookahead: 210,
  },
} as const;

/**
 * One gate.
 *
 * A rectangle in the sky with a direction through it. `forward` is the way the
 * course runs through the frame, `right` is across it; both are horizontal, so
 * a gate is always upright however steeply the leg into it climbs.
 */
export interface RaceGate {
  /** Where this gate comes in the order the course is flown. */
  readonly index: number;
  /**
   * The frame this gate is, when that is not the same thing as its place in
   * the order.
   *
   * On a circuit the finish is not another gate near the start — it is the
   * start, come back round. Both entries in the order point at one frame in
   * the sky, so there is one thing to draw, one thing to light up as the gate
   * being flown at, and no way for the two to drift apart.
   */
  readonly frame: number;
  /** Centre of the opening, local ENU metres. Lifted clear of terrain. */
  readonly position: Vec3;
  /** Direction of flight through the gate, degrees from north. */
  readonly headingDeg: number;
  readonly forward: Readonly<Vec3>;
  readonly right: Readonly<Vec3>;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * A course, and how far along it every gate is.
 *
 * Built once the gate heights are settled: the distances are what the
 * standings are measured against, and they have to describe the course
 * actually flown rather than the one first sketched.
 */
export class RaceCourse {
  readonly gates: readonly RaceGate[];
  /** Distance from the start gate to each gate, metres. */
  readonly distances: readonly number[];
  /** Length of the whole course, metres. */
  readonly length: number;

  constructor(gates: readonly RaceGate[]) {
    this.gates = gates;
    const distances: number[] = [];
    let total = 0;
    for (let i = 0; i < gates.length; i += 1) {
      if (i > 0) {
        total += V.distance(
          (gates[i - 1] as RaceGate).position,
          (gates[i] as RaceGate).position,
        );
      }
      distances.push(total);
    }
    this.distances = distances;
    this.length = total;
  }

  /** Crossings the course is made of, which a lap counts twice. */
  get gateCount(): number {
    return this.gates.length;
  }

  /**
   * Frames in the sky, which is not the same as crossings: a circuit's finish
   * is its start line, so eight gates flown as a circuit are nine crossings of
   * eight frames. This is what the renderer builds.
   */
  get frameCount(): number {
    return new Set(this.gates.map((gate) => gate.frame)).size;
  }

  /** The gates that are their own frame, in order. One per thing to draw. */
  get frames(): readonly RaceGate[] {
    return this.gates.filter((gate) => gate.frame === gate.index);
  }

  gate(index: number): RaceGate | null {
    return this.gates[index] ?? null;
  }

  get start(): RaceGate | null {
    return this.gates[0] ?? null;
  }

  get finish(): RaceGate | null {
    return this.gates[this.gates.length - 1] ?? null;
  }

  /** True when this is the gate the clock stops on. */
  isFinish(index: number): boolean {
    return this.gates.length > 0 && index === this.gates.length - 1;
  }

  /**
   * How far along the course an aircraft heading for `index` has got, metres.
   *
   * Measured to the next gate rather than counted in gates, so two racers on
   * the same leg are still separable — which is what a standings board needs.
   */
  progressAt(index: number, position: Vec3): number {
    if (this.gates.length === 0) return 0;
    if (index >= this.gates.length) return this.length;
    const gate = this.gates[index] as RaceGate;
    const remaining = V.distance(position, gate.position);
    // Before the start line there is no course flown yet, so closing on it is
    // the only thing that separates two aircraft on the grid.
    if (index === 0) return -remaining;

    const reached = this.distances[index - 1] as number;
    const leg = (this.distances[index] as number) - reached;
    // Never credit more than the leg: an aircraft sitting on top of a gate it
    // has not flown through has not passed it.
    return reached + clamp(leg - remaining, 0, leg);
  }
}

export interface RaceCourseOptions {
  /** Drives the whole layout, so one seed is always the same course. */
  readonly seed: string;
  readonly profile: RaceProfile;
  readonly gateCount: number;
  /** How far the course should run, metres, before the area clamps it. */
  readonly courseLength: number;
  readonly shape: RaceShape;
  /** The course stays well inside this, metres. */
  readonly missionRadius: number;
  /** Where the aircraft start, local ENU metres. */
  readonly start: Vec3;
  /** Heading the aircraft start on, degrees. The first gate is on it. */
  readonly startHeadingDeg?: number;
  /**
   * The surface the course is flown over, where it is known.
   *
   * A race is laid out *on* the ground rather than over it: this is what puts
   * every gate at its racing height. Cached and synchronous, so it is only as
   * good as what has been sampled — whoever can do better refines the heights
   * afterwards with `settleGateHeights`.
   */
  readonly terrain?: TerrainSampler;
}

/** How far ahead of the start line the first gate is put, metres. */
export const START_GATE_RANGE = 520;
/**
 * The furthest ahead it is ever put, metres.
 *
 * The run-in is lengthened when the grid launches high above a course flown on
 * the deck, and this is where that stops: past it the start of a race is a
 * transit rather than a run-in, and a pilot who launched at altitude can lose
 * the rest of the height on the approach.
 */
export const MAX_START_GATE_RANGE = 2000;
/**
 * The steepest descent the run-in is laid out for.
 *
 * A wing comes down far more readily than it goes up — this is not the climb
 * limit the course itself is held to — but a race that begins with the nose
 * pointed at the ground is not a race anybody flies well, so the start line is
 * put far enough ahead to be reached at a gradient the airframe glides at.
 */
const MAX_RUN_IN_GRADIENT = 0.35;

/**
 * How high the bottom of a gate sits above the surface under it, metres.
 *
 * This is the whole feel of the mode. A race is flown on the deck: the gates
 * follow the ground, dropping into a valley and climbing over the ridge beyond
 * it, and the only thing between the bottom bar and the grass is a few metres.
 * The spread between the two is jitter, not difficulty — every course at every
 * setting is flown down here.
 *
 * "The surface" is whatever the world actually puts under the gate. Over bare
 * terrain that is the ground; over a city drawn with buildings, or a
 * photogrammetry mesh that carries its own roofs and trees, it is the roof —
 * so a gate over a town sits a few metres above the town, not a few metres
 * above the street it would otherwise be buried in.
 */
export const MIN_GATE_CLEARANCE = 3;
export const MAX_GATE_CLEARANCE = 5;
/**
 * How much wider the start gate is than the rest of the course.
 *
 * A start line is a line, not an obstacle. Left alone the wing wanders tens of
 * metres in pitch — it sinks at the launch throttle and climbs at full power,
 * which is the phugoid doing what a phugoid does — so a normal-sized frame
 * half a kilometre off the grid turns the opening of a race into a trim
 * exercise. This does not hand the gate to a pilot who never touches the
 * stick, and is not meant to; it makes the start something a light touch flies
 * through rather than something that has to be set up. The clock has not
 * started yet either, so there is nothing to be won by making this one tight.
 */
export const START_GATE_SCALE = 1.7;

/**
 * Clear air between two airframes on the grid, metres.
 *
 * A race is decided by tenths, so none of it can be handed out before the
 * clock starts: the whole field lines up abreast on one start line, close
 * enough that everybody crosses it together and the flying is the only thing
 * that separates them. Measured wingtip to wingtip rather than centre to
 * centre — a wing three metres off its neighbour is on the same start line by
 * any measure, and one spawned *inside* its neighbour is a mid-air before the
 * throttle has come up.
 */
export const GRID_GAP = 3;

/** One place on the grid. */
export interface RaceGridSlot {
  /** Where this aircraft launches from, local ENU metres. */
  readonly position: Vec3;
  /**
   * Where on the start line it sits: -1 hard left, 0 the middle, 1 hard right.
   *
   * The field keeps the order it lined up in. A rival that started on the left
   * flies the left of the frames, which is what stops a whole grid aimed at the
   * middle of the same gate arriving there together — the tighter the start
   * line, the more that matters.
   */
  readonly lane: number;
  /**
   * And where up the frames it flies: -1 the bottom of the opening, 1 the top.
   *
   * Neighbours on the line alternate, so a field abreast is stacked as well as
   * spread out. A gate is only so wide, and eight aircraft cannot be lined up
   * across one with a wingspan between each of them — but a gate is also a
   * frame with height in it, and a rival that takes the high line past the one
   * beside it is clear of it whatever the two lanes are worth.
   */
  readonly level: number;
}

export interface RaceGridOptions {
  /** Aircraft on the grid, the player included. */
  readonly count: number;
  /** Where the player launches from, local ENU metres. */
  readonly start: Vec3;
  /** Heading the field launches on, degrees. The start line lies across it. */
  readonly headingDeg: number;
  /** Collision radius of the airframe being lined up, metres. */
  readonly collisionRadius: number;
}

/**
 * Lines the field up on one start line.
 *
 * Everybody abreast, nobody staggered: the first slot is the middle of the
 * line and the rest build outward either side of it, so every aircraft has the
 * same run-in to the start gate and the same height to lose on the way to it.
 * That is the whole rule, and it is the only fair one — a rival put a hundred
 * metres behind the grid is a hundred metres down before anybody has flown
 * anything, which is a place given away rather than won.
 *
 * The line runs across the launch heading, so the distance to a start gate
 * straight ahead of it is the same for every slot to within a fraction of a
 * metre.
 */
export function raceGridSlots(options: RaceGridOptions): RaceGridSlot[] {
  const count = Math.max(Math.round(options.count), 0);
  if (count === 0) return [];

  const heading = options.headingDeg * DEG_TO_RAD;
  // Across the line: ninety degrees right of the nose, the same way round a
  // gate measures its own width.
  const rightX = Math.cos(heading);
  const rightY = -Math.sin(heading);
  const spacing = Math.max(options.collisionRadius, 0) * 2 + GRID_GAP;
  // The end of the line on each side, in slots. A lane is measured against
  // whichever end the slot is on, so the outermost aircraft either side flies
  // the edge of the frames however the field divides up — the first slot is
  // the player's and it holds the middle, which leaves an even field one
  // deeper on the right than on the left.
  const rightMost = Math.floor(count / 2);
  const leftMost = Math.floor((count - 1) / 2);

  const slots: RaceGridSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    // Out from the middle, alternating: right, left, right, left.
    const step = (i % 2 === 1 ? 1 : -1) * Math.floor((i + 1) / 2);
    const offset = step * spacing;
    const end = step >= 0 ? rightMost : leftMost;
    slots.push({
      position: V.vec3(
        options.start.x + rightX * offset,
        options.start.y + rightY * offset,
        options.start.z,
      ),
      lane: end > 0 ? step / end : 0,
      // By place on the line rather than by slot number, so it is always the
      // aircraft *beside* you that is at the other height.
      level: step % 2 === 0 ? 1 : -1,
    });
  }
  return slots;
}

/**
 * How much of the mission area a course is allowed to use.
 *
 * The rest is turning room: a course that runs to the boundary is a course
 * flown half outside it, because nothing turns on a point.
 */
const AREA_FRACTION = 0.72;

/**
 * Lays out a course.
 *
 * Two shapes, one pair of rules. Either way the gates come from the seed, the
 * legs are sized to the distance that was asked for rather than to whatever
 * the difficulty felt like, and each gate is squared up to the course itself —
 * it faces along the bisector of the leg in and the leg out, which is what
 * makes a corner flyable rather than a wall to be hit at an angle.
 *
 * A **sprint** is walked out one leg at a time from the start line, turning by
 * a seeded amount within whatever the difficulty allows, and steered back
 * toward the middle whenever the walk wanders near the edge of the area. It
 * ends wherever it ends.
 *
 * A **circuit** is a closed ring, laid out so that its tangent where the grid
 * meets it is the heading the aircraft launch on — you cross the start line
 * going straight and then turn onto the course, the way a circuit is actually
 * entered. Its last gate is its first one: one frame, crossed twice.
 *
 * Heights are not part of that walk. Where the course goes is a plan view; how
 * high it is, is the ground — so the gates are laid out flat and then seated on
 * whatever surface is known, by the same rule that refines them later.
 */
export function buildRaceGates(options: RaceCourseOptions): RaceGate[] {
  const count = clamp(
    Math.round(options.gateCount),
    MIN_RACE_GATES,
    MAX_RACE_GATES,
  );
  const rng = createRng(`${options.seed}:race`);
  const startHeading = options.startHeadingDeg ?? 0;
  // Room to turn inside the mission area, and never a course so large that
  // half of it is a transit rather than a race.
  const limit = Math.min(options.missionRadius * AREA_FRACTION, 8000);
  // Clamped per leg rather than in total: what a leg has to be is a property
  // of the airframe, and how many of them there are is the pilot's choice.
  const length = Math.max(options.courseLength, 0);

  const runIn = runInRange(options);
  const points =
    options.shape === RACE_SHAPE.Circuit
      ? circuitPoints(options, rng, count, length, limit, startHeading, runIn)
      : sprintPoints(options, rng, count, length, limit, startHeading, runIn);

  const closed = options.shape === RACE_SHAPE.Circuit;
  const gates = points.map((position, index) => {
    const scale = index === 0 ? START_GATE_SCALE : 1;
    return createGate(
      index,
      position,
      // The start line of a circuit is flown twice, from the grid and from the
      // last corner, so it keeps the heading the aircraft launch on rather
      // than a bisector that suits only one of the two.
      closed && index === 0
        ? startHeading
        : gateHeading(points, index, options.start, startHeading, closed),
      options.profile.gateHalfWidth * scale,
      options.profile.gateHalfHeight * scale,
    );
  });

  if (closed) {
    // Round again to the line you started on. Same frame, same heading, same
    // piece of sky — it is only the order that has two entries in it.
    const first = gates[0] as RaceGate;
    gates.push(
      createGate(
        gates.length,
        first.position,
        first.headingDeg,
        first.halfWidth,
        first.halfHeight,
        first.frame,
      ),
    );
  }

  settleGateHeights(
    gates,
    sampleSurfaces(gates, options.terrain),
    options.seed,
    options.terrain,
  );
  return gates;
}

/** The surface under each gate, as far as the cached sampler knows it. */
function sampleSurfaces(
  gates: readonly RaceGate[],
  terrain: TerrainSampler | undefined,
): (number | null)[] {
  return gates.map((gate) => {
    if (!terrain) return null;
    const { x, y } = gate.position;
    return terrain.hasCoverage(x, y) ? terrain.heightAt(x, y) : null;
  });
}

/**
 * How far ahead of the grid the start line goes.
 *
 * Normally the fixed run-in, but a race is flown on the deck and the grid is
 * wherever the pilot asked to launch from — three hundred metres up, if that
 * is what they picked. Half a kilometre is not enough to lose that in, so the
 * start line moves out until the descent onto it is one a wing can fly.
 */
function runInRange(options: RaceCourseOptions): number {
  const terrain = options.terrain;
  if (!terrain || !terrain.hasCoverage(options.start.x, options.start.y)) {
    return START_GATE_RANGE;
  }
  const ground = terrain.heightAt(options.start.x, options.start.y);
  const gateZ =
    ground +
    MAX_GATE_CLEARANCE +
    options.profile.gateHalfHeight * START_GATE_SCALE;
  const drop = options.start.z - gateZ;
  if (drop <= 0) return START_GATE_RANGE;
  return clamp(
    drop / MAX_RUN_IN_GRADIENT,
    START_GATE_RANGE,
    MAX_START_GATE_RANGE,
  );
}

/** A start line, then a walk that ends somewhere else entirely. */
function sprintPoints(
  options: RaceCourseOptions,
  rng: Rng,
  count: number,
  length: number,
  limit: number,
  startHeading: number,
  runIn: number,
): Vec3[] {
  const { profile } = options;
  // The distance asked for, spread over the legs there are to spread it over.
  // A sprint's gates are fenceposts: ten of them make nine legs.
  const nominal = clamp(length / Math.max(count - 1, 1), MIN_LEG, MAX_LEG);

  const points: Vec3[] = [];
  let heading = startHeading;
  let point = V.vec3(
    options.start.x + Math.sin(startHeading * DEG_TO_RAD) * runIn,
    options.start.y + Math.cos(startHeading * DEG_TO_RAD) * runIn,
    options.start.z,
  );
  points.push(point);

  for (let i = 1; i < count; i += 1) {
    // A fresh turn each leg, either way, within what the difficulty allows.
    // Two gates are never closer together than a leg, and a gate the course
    // happens to double back past is harmless: only the next one is ever being
    // looked for, so there is nothing to confuse it with.
    heading = (heading + rng.range(-profile.turnDeg, profile.turnDeg) + 360) % 360;
    heading = steerInside(point, heading, limit);

    const leg = nominal * rng.range(0.8, 1.2);
    // Flat: the ground decides the heights, and it has not been asked yet.
    const next = V.vec3(
      point.x + Math.sin(heading * DEG_TO_RAD) * leg,
      point.y + Math.cos(heading * DEG_TO_RAD) * leg,
      options.start.z,
    );
    points.push(next);
    point = next;
  }
  return points;
}

/**
 * A closed ring the grid sits on the edge of.
 *
 * The centre is put out to one side of the start line rather than ahead of it,
 * so the ring's tangent at the start is the launch heading: the aircraft cross
 * the line going straight and turn onto the course, instead of meeting the
 * first gate side-on.
 */
function circuitPoints(
  options: RaceCourseOptions,
  rng: Rng,
  count: number,
  length: number,
  limit: number,
  startHeading: number,
  runIn: number,
): Vec3[] {
  const heading = startHeading * DEG_TO_RAD;
  const ahead = { x: Math.sin(heading), y: Math.cos(heading) };
  const side = rng.next() < 0.5 ? 1 : -1;
  // Right of the nose, so a positive side turns the circuit to the right.
  const across = { x: ahead.y * side, y: -ahead.x * side };

  const start = V.vec3(
    options.start.x + ahead.x * runIn,
    options.start.y + ahead.y * runIn,
    options.start.z,
  );

  // The length asked for is the distance actually flown, which around a ring
  // of gates is the perimeter of the polygon joining them rather than the
  // circumference of the circle through them. Then shrunk to whatever the
  // area can hold: the far side of the ring sits a full diameter beyond the
  // start line.
  const chord = 2 * Math.sin(Math.PI / count);
  const wanted = length / (count * chord);
  const room = Math.max((limit - runIn) / 2, MIN_LEG);
  // Legs a wing can fly, however short the course was asked to be.
  const floor = MIN_LEG / chord;
  const radius = clamp(wanted, Math.min(floor, room), room);

  const centre = {
    x: start.x + across.x * radius,
    y: start.y + across.y * radius,
  };
  // Where the start sits on the ring, and which way round it is flown.
  const startAngle = Math.atan2(start.x - centre.x, start.y - centre.y);
  const step = (Math.PI * 2) / count;

  const points: Vec3[] = [start];
  for (let i = 1; i < count; i += 1) {
    // Even spacing with jitter in both the angle and the radius, so it reads
    // as a circuit rather than as a geometric circle.
    const angle = startAngle + side * (i * step + rng.range(-step * 0.18, step * 0.18));
    const r = radius * rng.range(0.82, 1.18);
    points.push(
      V.vec3(
        centre.x + Math.sin(angle) * r,
        centre.y + Math.cos(angle) * r,
        options.start.z,
      ),
    );
  }
  return points;
}

/** Turns a heading back toward the middle as the walk nears the boundary. */
function steerInside(point: Vec3, heading: number, limit: number): number {
  const outward = Math.hypot(point.x, point.y);
  if (outward <= limit * 0.6) return heading;
  // Blended rather than clamped: a course that bounces off a boundary flies
  // like one.
  const inward = (Math.atan2(-point.x, -point.y) * RAD_TO_DEG + 360) % 360;
  const pull = clamp((outward - limit * 0.6) / (limit * 0.4), 0, 1);
  const delta = ((inward - heading + 540) % 360) - 180;
  return (heading + delta * pull + 360) % 360;
}

/**
 * The steepest the course itself will climb or descend between two gates.
 *
 * A leg is flown, not jumped: a two-kilometre course over ten gates has legs
 * a couple of hundred metres long, and a hillside that rises eighty metres
 * across one of them would ask for a twenty-degree climb to reach the next
 * gate. The wing will not do that at racing speed, so the course does not
 * ask — it lifts off the ground over ground that steep instead. Tangent of
 * about twelve degrees.
 */
const MAX_COURSE_GRADIENT = 0.21;

/**
 * Clearance the straight line between two gates keeps over the ground, metres.
 *
 * Higher than the gates themselves sit, and deliberately: a gate is a target
 * to be threaded, and the leg between two of them is a line to be flown at
 * racing speed with the ground going past underneath. This is the height that
 * makes the second of those a race rather than a coin toss — and it is what
 * the rivals' own terrain margin is set under, so flying the course is never
 * the same thing as being pulled off it.
 */
export const LEG_CLEARANCE = 15;
/** How finely the ground under a leg is walked, metres. */
const LEG_SAMPLE_STEP = 60;
/** Rounds of leg-clearing and levelling. Both only ever lift, so this settles. */
const LEVEL_PASSES = 3;

/**
 * Puts every gate at its racing height over the surface beneath it.
 *
 * Two rules, in this order, and the order is the point:
 *
 *   1. **The course follows the ground.** Each gate is dropped until the
 *      bottom of its opening is a few metres over whatever is under it, so a
 *      course laid across a valley dives into it and climbs out the far side
 *      rather than sailing over the whole thing at launch height.
 *   2. **The course stays flyable.** Ground can rise faster than a wing
 *      climbs. Where it does, gates are *raised* — never dropped — until no
 *      leg asks for more gradient than the airframe has, which leaves the
 *      clearance rule satisfied everywhere and simply lets the course fly over
 *      the one hillside too steep to hug.
 *
 * Columns with no surface reading are not guesses waiting to happen: they take
 * the height of the nearest gate that does have one, and a course with no
 * readings at all is left exactly as it was laid out.
 *
 * Safe to call twice. The layout seats the gates on whatever the cached
 * sampler knows; whoever can measure the surface properly — the elevation
 * service, or a pick against the mesh the scene is actually drawing — calls it
 * again with better numbers, and the same course comes out.
 *
 * @param surfaces Height of the surface under each gate, metres, index for
 *                 index with `gates`. `null` where it is not known.
 */
export function settleGateHeights(
  gates: readonly RaceGate[],
  surfaces: readonly (number | null | undefined)[],
  seed: string,
  terrain?: TerrainSampler,
): void {
  if (gates.length === 0) return;
  const rng = createRng(`${seed}:race:height`);

  // A circuit's finish is its start line — one frame, and one height, however
  // many times the order crosses it.
  const seated = new Map<number, number>();
  for (let i = 0; i < gates.length; i += 1) {
    const gate = gates[i] as RaceGate;
    const settled = seated.get(gate.frame);
    if (settled !== undefined) {
      gate.position.z = settled;
      continue;
    }
    const surface = surfaces[i];
    if (surface === null || surface === undefined || !Number.isFinite(surface)) {
      continue;
    }
    const clearance = rng.range(MIN_GATE_CLEARANCE, MAX_GATE_CLEARANCE);
    gate.position.z = surface + clearance + gate.halfHeight;
    seated.set(gate.frame, gate.position.z);
  }

  fillUnknownHeights(gates, surfaces);

  // Clearing the ground under the gates is not the same as clearing the ground
  // between them, and the leg is what is actually flown. Alternated with the
  // gradient sweeps because either can undo the other's work, and both only
  // ever lift, so a couple of rounds settle it.
  for (let pass = 0; pass < LEVEL_PASSES; pass += 1) {
    if (terrain) clearLegs(gates, terrain);
    levelForFlight(gates);
  }
}

/**
 * Lifts the gates either end of a leg until the leg clears the ground.
 *
 * A gate a few metres over a hilltop and the next one a few metres over the
 * next hilltop describe a straight line through the valley wall between them.
 * The course is what the whole field is aiming down, so it is the *line* that
 * has to be flyable, not just the frames on the ends of it: the ground under
 * each leg is walked, and both gates come up by whatever the worst of it asks
 * for. Over the rolling country a race is usually laid out on this costs a
 * metre or two; over a ridge it is what puts the course over the ridge.
 */
function clearLegs(gates: readonly RaceGate[], terrain: TerrainSampler): void {
  for (let i = 1; i < gates.length; i += 1) {
    const a = gates[i - 1] as RaceGate;
    const b = gates[i] as RaceGate;
    const run = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y);
    if (run < LEG_SAMPLE_STEP) continue;

    const steps = Math.ceil(run / LEG_SAMPLE_STEP);
    let deficit = 0;
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const x = a.position.x + (b.position.x - a.position.x) * t;
      const y = a.position.y + (b.position.y - a.position.y) * t;
      if (!terrain.hasCoverage(x, y)) continue;
      const wanted = terrain.heightAt(x, y) + LEG_CLEARANCE;
      const flown = a.position.z + (b.position.z - a.position.z) * t;
      deficit = Math.max(deficit, wanted - flown);
    }
    if (deficit <= 0) continue;
    // Both ends, which lifts the whole line by the deficit. Lifting the nearer
    // end alone would be less height in total and a steeper leg, and a leg the
    // airframe cannot fly is not an improvement on one it can.
    a.position.z += deficit;
    b.position.z += deficit;
  }
}

/** Gives a gate over unsampled ground the height of the nearest one that is. */
function fillUnknownHeights(
  gates: readonly RaceGate[],
  surfaces: readonly (number | null | undefined)[],
): void {
  const known = (index: number): boolean => {
    const surface = surfaces[index];
    return surface !== null && surface !== undefined && Number.isFinite(surface);
  };
  if (!gates.some((_, index) => known(index))) return;

  // Nearest in either direction, which on a course is nearest on the ground:
  // one sweep out from each end, and the closer of the two wins.
  const filled: (number | null)[] = gates.map(() => null);
  const reach: number[] = gates.map(() => Number.POSITIVE_INFINITY);

  let height: number | null = null;
  let since = 0;
  for (let i = 0; i < gates.length; i += 1) {
    if (known(i)) {
      height = (gates[i] as RaceGate).position.z;
      since = 0;
    } else if (height !== null) {
      since += 1;
      filled[i] = height;
      reach[i] = since;
    }
  }
  height = null;
  since = 0;
  for (let i = gates.length - 1; i >= 0; i -= 1) {
    if (known(i)) {
      height = (gates[i] as RaceGate).position.z;
      since = 0;
    } else if (height !== null) {
      since += 1;
      if (since < (reach[i] as number)) filled[i] = height;
    }
  }

  for (let i = 0; i < gates.length; i += 1) {
    const height = filled[i];
    if (height !== null && height !== undefined) {
      (gates[i] as RaceGate).position.z = height;
    }
  }
}

/**
 * Raises whatever the ground made too steep to fly.
 *
 * One sweep forward bounds every descent, one back bounds every climb, and
 * because a gate is only ever lifted the ground clearance underneath it
 * survives both. A circuit's last gate *is* its first — the same point, shared
 * — so the ring closes itself, and the pair of sweeps is run twice to carry a
 * lift the whole way round it.
 */
function levelForFlight(gates: readonly RaceGate[]): void {
  const closed =
    gates.length > 1 &&
    (gates[gates.length - 1] as RaceGate).frame === (gates[0] as RaceGate).frame;
  const passes = closed ? 2 : 1;

  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = 1; i < gates.length; i += 1) {
      liftToward(gates[i] as RaceGate, gates[i - 1] as RaceGate);
    }
    for (let i = gates.length - 2; i >= 0; i -= 1) {
      liftToward(gates[i] as RaceGate, gates[i + 1] as RaceGate);
    }
  }
}

/** Lifts `gate` until the leg from `neighbour` is one the airframe can fly. */
function liftToward(gate: RaceGate, neighbour: RaceGate): void {
  const leg = Math.hypot(
    gate.position.x - neighbour.position.x,
    gate.position.y - neighbour.position.y,
  );
  const floor = neighbour.position.z - leg * MAX_COURSE_GRADIENT;
  if (gate.position.z < floor) gate.position.z = floor;
}

/** Convenience: lay out a course and measure it in one call. */
export function buildRaceCourse(options: RaceCourseOptions): RaceCourse {
  return new RaceCourse(buildRaceGates(options));
}

function createGate(
  index: number,
  position: Vec3,
  headingDeg: number,
  halfWidth: number,
  halfHeight: number,
  frame = index,
): RaceGate {
  const radians = headingDeg * DEG_TO_RAD;
  const forward = V.vec3(Math.sin(radians), Math.cos(radians), 0);
  return {
    index,
    frame,
    position,
    headingDeg,
    forward,
    // Across the frame, ninety degrees right of the way through it.
    right: V.vec3(forward.y, -forward.x, 0),
    halfWidth,
    halfHeight,
  };
}

/** The heading that squares a gate up to the legs either side of it. */
function gateHeading(
  points: readonly Vec3[],
  index: number,
  start: Vec3,
  startHeadingDeg: number,
  closed = false,
): number {
  const here = points[index] as Vec3;
  // On a ring the gate before the first one is the last one, and the gate
  // after the last one is the first: every corner has two legs to bisect.
  const before =
    index > 0
      ? (points[index - 1] as Vec3)
      : closed
        ? (points[points.length - 1] as Vec3)
        : start;
  const after =
    points[index + 1] ?? (closed ? (points[0] as Vec3) : null);

  const inX = here.x - before.x;
  const inY = here.y - before.y;
  const incoming = Math.hypot(inX, inY);
  if (incoming < 1e-6) return startHeadingDeg;

  if (!after) {
    return (Math.atan2(inX, inY) * RAD_TO_DEG + 360) % 360;
  }

  const outX = after.x - here.x;
  const outY = after.y - here.y;
  const outgoing = Math.hypot(outX, outY);
  if (outgoing < 1e-6) {
    return (Math.atan2(inX, inY) * RAD_TO_DEG + 360) % 360;
  }

  // The bisector of the two legs: a gate on a corner faces halfway round it.
  const bx = inX / incoming + outX / outgoing;
  const by = inY / incoming + outY / outgoing;
  if (Math.hypot(bx, by) < 1e-6) {
    return (Math.atan2(inX, inY) * RAD_TO_DEG + 360) % 360;
  }
  return (Math.atan2(bx, by) * RAD_TO_DEG + 360) % 360;
}

/**
 * Whether the segment `from` -> `to` flies through `gate`.
 *
 * Segment-based rather than point-based on purpose: an aircraft at 35 m/s
 * covers half a metre a frame, and a test that only asks "am I inside the
 * frame right now" misses gates at low frame rates and rewards flying past
 * them at high ones. Crossing the plane of the gate is unambiguous at any
 * frame rate, and the point of crossing is exactly what tells you whether the
 * frame was flown through or missed.
 *
 * Only forward crossings count: doubling back through a gate does not undo it,
 * and flying the course backwards does not fly it.
 */
export function gatePassed(gate: RaceGate, from: Vec3, to: Vec3): boolean {
  const beforeX = from.x - gate.position.x;
  const beforeY = from.y - gate.position.y;
  const afterX = to.x - gate.position.x;
  const afterY = to.y - gate.position.y;

  const before = beforeX * gate.forward.x + beforeY * gate.forward.y;
  const after = afterX * gate.forward.x + afterY * gate.forward.y;
  if (before > 0 || after <= 0) return false;

  const span = after - before;
  const t = span > 1e-9 ? -before / span : 0;

  const x = from.x + (to.x - from.x) * t;
  const y = from.y + (to.y - from.y) * t;
  const z = from.z + (to.z - from.z) * t;

  const lateral =
    (x - gate.position.x) * gate.right.x + (y - gate.position.y) * gate.right.y;
  const vertical = z - gate.position.z;

  return (
    Math.abs(lateral) <= gate.halfWidth && Math.abs(vertical) <= gate.halfHeight
  );
}

/** One aircraft's race, as the standings board sees it. */
export interface RacerStanding {
  readonly id: string;
  readonly label: string;
  readonly isPlayer: boolean;
  /** 1-based place in the race right now. */
  readonly position: number;
  readonly gatesPassed: number;
  /** The gate this aircraft is flying at. */
  readonly nextGate: number;
  readonly started: boolean;
  readonly finished: boolean;
  /** Mission time the clock started, seconds. */
  readonly startTime: number;
  /** Mission time the finish gate was crossed, seconds. */
  readonly finishTime: number;
  /** Time on the clock: the finished race, or the one being flown. */
  readonly elapsed: number;
  /** Distance flown along the course, metres. */
  readonly courseProgress: number;
  /** False once this aircraft is a wreck. */
  readonly flying: boolean;
}

/** What the OSD and the debrief are shown of a race. */
export interface RaceProgress {
  readonly started: boolean;
  readonly finished: boolean;
  readonly gatesPassed: number;
  readonly gateCount: number;
  readonly nextGate: number;
  /** The player's clock, seconds. */
  readonly elapsed: number;
  /** 1-based place; 1 while nobody has started. */
  readonly position: number;
  readonly racerCount: number;
  /** Course metres between the player and the leader; 0 when leading. */
  readonly gapToLeader: number;
  readonly standings: readonly RacerStanding[];
}

export type RaceEvent =
  | {
      readonly type: "GATE";
      readonly id: string;
      readonly gateIndex: number;
      readonly isPlayer: boolean;
      readonly isFinish: boolean;
    }
  | {
      readonly type: "FINISH";
      readonly id: string;
      readonly isPlayer: boolean;
      readonly position: number;
      readonly time: number;
    };

interface RacerRecord {
  readonly id: string;
  label: string;
  isPlayer: boolean;
  nextGate: number;
  started: boolean;
  finished: boolean;
  startTime: number;
  finishTime: number;
  courseProgress: number;
  flying: boolean;
  /** Where the aircraft was last seen; null while it has no valid history. */
  last: Vec3 | null;
}

/**
 * Distance in one step past which the aircraft is assumed to have been placed
 * rather than flown. A replacement airframe appearing on the course must not
 * be credited with every gate on the line between where it died and where it
 * came back.
 */
const TELEPORT_DISTANCE = 400;

/**
 * Times one race.
 *
 * Fed the whole aircraft list each step, it picks out everybody racing, walks
 * their movement against the gate they are flying at, and keeps the clock.
 * The player is one entry in it and gets no special treatment: the standings
 * are the same measurement applied to everybody on the course.
 */
export class RaceTracker {
  readonly course: RaceCourse;

  private readonly racers = new Map<string, RacerRecord>();
  private readonly order: RacerStanding[] = [];
  private readonly events: RaceEvent[] = [];
  private playerId: string | null = null;
  private finishers = 0;
  private time = 0;

  constructor(course: RaceCourse) {
    this.course = course;
  }

  /** Gives an aircraft a name on the board before it is first seen. */
  register(id: string, label: string, isPlayer = false): void {
    const record = this.racers.get(id);
    if (record) {
      record.label = label;
      record.isPlayer = isPlayer;
    } else {
      this.racers.set(id, blankRecord(id, label, isPlayer));
    }
    if (isPlayer) this.playerId = id;
  }

  get gateCount(): number {
    return this.course.gateCount;
  }

  get racerCount(): number {
    return this.racers.size;
  }

  /** True once the player has crossed the finish gate. */
  get playerFinished(): boolean {
    const record = this.playerId ? this.racers.get(this.playerId) : null;
    return record?.finished ?? false;
  }

  get standings(): readonly RacerStanding[] {
    return this.order;
  }

  /** The gate the player is flying at, or the finish once they are done. */
  get playerGate(): number {
    return this.playerId ? this.nextGateFor(this.playerId) : 0;
  }

  /**
   * The gate one aircraft is flying at.
   *
   * This is what a rival's pilot asks the tracker every time it rebuilds its
   * aim point: the race owns which gate is next, so the pilot cannot count
   * itself through a gate it did not fly.
   */
  nextGateFor(id: string): number {
    return this.racers.get(id)?.nextGate ?? 0;
  }

  get progress(): RaceProgress {
    const player = this.order.find((entry) => entry.isPlayer) ?? null;
    const leader = this.order[0] ?? null;
    return {
      started: player?.started ?? false,
      finished: player?.finished ?? false,
      gatesPassed: player?.gatesPassed ?? 0,
      gateCount: this.course.gateCount,
      nextGate: player?.nextGate ?? 0,
      elapsed: player?.elapsed ?? 0,
      position: player?.position ?? 1,
      racerCount: this.order.length,
      gapToLeader:
        player && leader && leader.id !== player.id
          ? Math.max(0, leader.courseProgress - player.courseProgress)
          : 0,
      standings: this.order,
    };
  }

  /**
   * Advances the race by one step.
   *
   * Returns the events raised this call; the array is reused, so consume it
   * before calling again.
   */
  update(aircraft: readonly AircraftState[], time: number): readonly RaceEvent[] {
    this.events.length = 0;
    this.time = time;

    for (const state of aircraft) {
      if (!isRacing(state)) continue;
      const record = this.recordFor(state);
      this.step(record, state);
    }

    this.rank();
    return this.events;
  }

  private recordFor(state: AircraftState): RacerRecord {
    const existing = this.racers.get(state.id);
    if (existing) return existing;
    const isPlayer = state.role === AIRCRAFT_ROLE.Player;
    const record = blankRecord(state.id, state.id.toUpperCase(), isPlayer);
    this.racers.set(state.id, record);
    if (isPlayer) this.playerId = state.id;
    return record;
  }

  private step(record: RacerRecord, state: AircraftState): void {
    record.flying = isAirworthy(state.status);

    // A wreck is out of the race until something is flying again, and the
    // aircraft that comes back has no history worth joining to.
    if (!record.flying) {
      record.last = null;
      return;
    }

    const last = record.last;
    if (!last) {
      record.last = V.clone(state.position);
      return;
    }

    if (
      !record.finished &&
      V.distance(last, state.position) <= TELEPORT_DISTANCE
    ) {
      const gate = this.course.gate(record.nextGate);
      if (gate && gatePassed(gate, last, state.position)) {
        this.creditGate(record, gate);
      }
    }

    V.copy(last, state.position);
    record.courseProgress = record.finished
      ? this.course.length
      : this.course.progressAt(record.nextGate, state.position);
  }

  private creditGate(record: RacerRecord, gate: RaceGate): void {
    const isFinish = this.course.isFinish(gate.index);

    // The clock starts on the first gate, not on the launch: everybody gets
    // the run-in to the start line for free.
    if (!record.started) {
      record.started = true;
      record.startTime = this.time;
    }

    record.nextGate = gate.index + 1;
    this.events.push({
      type: "GATE",
      id: record.id,
      gateIndex: gate.index,
      isPlayer: record.isPlayer,
      isFinish,
    });

    if (!isFinish) return;

    record.finished = true;
    record.finishTime = this.time;
    record.courseProgress = this.course.length;
    this.finishers += 1;
    this.events.push({
      type: "FINISH",
      id: record.id,
      isPlayer: record.isPlayer,
      position: this.finishers,
      time: Math.max(0, record.finishTime - record.startTime),
    });
  }

  /**
   * Orders the board.
   *
   * Finishers first, by the clock. Everybody else by how far round the course
   * they are — distance rather than gates, so two aircraft on the same leg are
   * still in an order.
   */
  private rank(): void {
    this.order.length = 0;
    const entries = [...this.racers.values()];
    entries.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) {
        return elapsedOf(a, this.time) - elapsedOf(b, this.time);
      }
      return b.courseProgress - a.courseProgress;
    });

    for (let i = 0; i < entries.length; i += 1) {
      const record = entries[i] as RacerRecord;
      this.order.push({
        id: record.id,
        label: record.label,
        isPlayer: record.isPlayer,
        position: i + 1,
        gatesPassed: record.nextGate,
        nextGate: record.nextGate,
        started: record.started,
        finished: record.finished,
        startTime: record.startTime,
        finishTime: record.finishTime,
        elapsed: elapsedOf(record, this.time),
        courseProgress: record.courseProgress,
        flying: record.flying,
      });
    }
  }
}

function blankRecord(id: string, label: string, isPlayer: boolean): RacerRecord {
  return {
    id,
    label,
    isPlayer,
    nextGate: 0,
    started: false,
    finished: false,
    startTime: 0,
    finishTime: 0,
    courseProgress: 0,
    flying: true,
    last: null,
  };
}

function elapsedOf(record: RacerRecord, now: number): number {
  if (!record.started) return 0;
  const end = record.finished ? record.finishTime : now;
  return Math.max(0, end - record.startTime);
}

function isRacing(state: AircraftState): boolean {
  return (
    state.role === AIRCRAFT_ROLE.Player || state.role === AIRCRAFT_ROLE.Racer
  );
}

/** How a finished race reads on the debrief. */
export function racePlacing(position: number): string {
  if (position === 1) return "1st";
  if (position === 2) return "2nd";
  if (position === 3) return "3rd";
  return `${position}th`;
}

/** Race time as m:ss.t — a race is won by tenths, so it shows them. */
export function formatRaceTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--.-";
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}
