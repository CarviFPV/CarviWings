import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS, createAircraftState } from "../flight/state";
import type { AircraftRole, AircraftState } from "../flight/state";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { RacePilot } from "../ai/racer";
import { DIFFICULTY } from "../ai/types";
import { MissionRunner } from "../mission/missionRunner";
import type { MissionSettings } from "../mission/types";
import {
  DEFAULT_FORMATION,
  DEFAULT_VTX_POWER_MW,
  MISSION_MODE,
  MISSION_OUTCOME,
  interceptorsFor,
} from "../mission/types";
import { DEFAULT_FESTIVAL } from "../mission/festival";
import { DEFAULT_STRIKE } from "../mission/strike";
import { DEFAULT_OPPOSITION } from "../mission/opposition";
import {
  DEFAULT_RACE,
  GRID_GAP,
  RACE_SHAPE,
  MAX_RACE_COMPETITORS,
  MAX_RACE_GATES,
  LEG_CLEARANCE,
  MAX_GATE_CLEARANCE,
  MAX_START_GATE_RANGE,
  MIN_GATE_CLEARANCE,
  MIN_LEG,
  RACE_PROFILES,
  RaceCourse,
  RaceTracker,
  START_GATE_RANGE,
  START_GATE_SCALE,
  buildRaceCourse,
  buildRaceGates,
  formatRaceTime,
  gatePassed,
  racePlacing,
  raceGridSlots,
  settleGateHeights,
} from "../mission/race";
import type { RaceGate, RaceGridSlot } from "../mission/race";
import { WEATHER, TIME_OF_DAY } from "../environment/types";
import { createFlightInput } from "../input/types";
import * as V from "../math/vec3";

const idle = createFlightInput();

function settings(overrides: Partial<MissionSettings> = {}): MissionSettings {
  return {
    mode: MISSION_MODE.Race,
    locationName: "Test",
    latitude: 46.5375,
    longitude: 7.9625,
    missionRadius: 10000,
    spawnAltitudeAgl: 300,
    weather: WEATHER.Clear,
    timeOfDay: TIME_OF_DAY.Day,
    enemyCount: 0,
    difficulty: DIFFICULTY.Normal,
    combat: false,
    formation: DEFAULT_FORMATION,
    race: DEFAULT_RACE,
    festival: DEFAULT_FESTIVAL,
    strike: DEFAULT_STRIKE,
    opposition: DEFAULT_OPPOSITION,
    vtxPowerMw: DEFAULT_VTX_POWER_MW,
    seed: "RACESEED",
    ...overrides,
  };
}

async function flatTerrain(radius = 9000): Promise<TerrainField> {
  return shapedTerrain(() => -500, radius);
}

/** Terrain of any shape, sampled the way the real field samples it. */
async function shapedTerrain(
  height: (x: number, y: number) => number,
  radius = 9000,
): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) =>
      points.map((point) => height(point.x, point.y)),
    { cellSize: 250, warmRadius: 4000, sampleBudget: 200000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

/** Hills a course has to follow rather than fly over. */
async function rollingTerrain(radius = 12000): Promise<TerrainField> {
  return shapedTerrain(
    (x, y) => 400 + Math.sin(x / 900) * 130 + Math.cos(y / 1150) * 95,
    radius,
  );
}

/** Open country: enough shape to follow, never enough to be lifted off. */
async function gentleTerrain(radius = 12000): Promise<TerrainField> {
  return shapedTerrain(
    (x, y) => 400 + Math.sin(x / 2500) * 80 + Math.cos(y / 3000) * 60,
    radius,
  );
}

/** The height of the ground under a gate, as the field reports it. */
function groundUnder(terrain: TerrainField, gate: RaceGate): number {
  return terrain.heightAt(gate.position.x, gate.position.y);
}

/** How high the bottom bar of a gate sits over the ground, metres. */
function gateAgl(terrain: TerrainField, gate: RaceGate): number {
  return gate.position.z - gate.halfHeight - groundUnder(terrain, gate);
}

/** The closest the straight line between two gates comes to the ground. */
function worstLegClearance(
  terrain: TerrainField,
  gates: readonly RaceGate[],
): number {
  let worst = Number.POSITIVE_INFINITY;
  for (let i = 1; i < gates.length; i += 1) {
    const a = (gates[i - 1] as RaceGate).position;
    const b = (gates[i] as RaceGate).position;
    const run = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(Math.ceil(run / 25), 1);
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      worst = Math.min(worst, z - terrain.heightAt(x, y));
    }
  }
  return worst;
}

/** The steepest leg of a course, as a gradient. */
function steepestLeg(gates: readonly RaceGate[]): number {
  let steepest = 0;
  for (let i = 1; i < gates.length; i += 1) {
    const a = (gates[i - 1] as RaceGate).position;
    const b = (gates[i] as RaceGate).position;
    const run = Math.hypot(b.x - a.x, b.y - a.y);
    if (run < 1e-6) continue;
    steepest = Math.max(steepest, Math.abs(b.z - a.z) / run);
  }
  return steepest;
}

/** A straight line of gates, so a test can fly it without any AI at all. */
function straightCourse(count = 4, spacing = 400): RaceCourse {
  const gates: RaceGate[] = [];
  for (let i = 0; i < count; i += 1) {
    gates.push({
      index: i,
      frame: i,
      position: V.vec3(0, spacing * (i + 1), 500),
      headingDeg: 0,
      forward: V.vec3(0, 1, 0),
      right: V.vec3(1, 0, 0),
      halfWidth: 18,
      halfHeight: 14,
    });
  }
  return new RaceCourse(gates);
}

function racerState(
  id: string,
  role: AircraftRole = AIRCRAFT_ROLE.Player,
): AircraftState {
  return createAircraftState({
    id,
    role,
    config: PLAYER_WING,
    position: V.vec3(0, 0, 500),
    headingDeg: 0,
    airspeed: 28,
    throttle: 0.7,
  });
}

/** Walks an aircraft to a point and lets the tracker see the move. */
function flyTo(
  tracker: RaceTracker,
  aircraft: readonly AircraftState[],
  state: AircraftState,
  x: number,
  y: number,
  z: number,
  time: number,
): void {
  V.set(state.position, x, y, z);
  tracker.update(aircraft, time);
}

export async function runRaceTests(): Promise<void> {
  suite("race course layout", () => {
    const options = {
      seed: "RACESEED",
      profile: RACE_PROFILES[DIFFICULTY.Normal],
      gateCount: 10,
      courseLength: 6000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 10000,
      start: V.vec3(0, 0, 500),
    };
    const a = buildRaceGates(options);
    const b = buildRaceGates(options);
    const c = buildRaceGates({ ...options, seed: "OTHER" });

    assertClose(a.length, 10, 1e-9, "a ten-gate course has ten gates");
    assert(
      a.every((gate, i) => V.distance(gate.position, (b[i] as RaceGate).position) < 1e-9),
      "the same seed lays out the same course",
    );
    assert(
      a.some((gate, i) => V.distance(gate.position, (c[i] as RaceGate).position) > 50),
      "a different seed lays out a different one",
    );

    const start = a[0] as RaceGate;
    assertClose(
      Math.hypot(start.position.x, start.position.y),
      START_GATE_RANGE,
      1e-6,
      "the start gate is straight ahead of the grid",
    );
    assertClose(
      start.position.x,
      0,
      1e-6,
      "on the heading the aircraft launch on",
    );

    assert(
      a.every((gate) => Math.hypot(gate.position.x, gate.position.y) < 10000),
      "every gate stays inside the mission area",
    );

    // Ten gates over six kilometres is nine legs of about 670 m, jittered.
    const nominal = 6000 / 9;
    for (let i = 1; i < a.length; i += 1) {
      const leg = Math.hypot(
        (a[i] as RaceGate).position.x - (a[i - 1] as RaceGate).position.x,
        (a[i] as RaceGate).position.y - (a[i - 1] as RaceGate).position.y,
      );
      assertBetween(
        leg,
        nominal * 0.79,
        nominal * 1.21,
        `leg ${i} is the length the course was asked for`,
      );
    }

    assertClose(
      (a[0] as RaceGate).halfWidth,
      RACE_PROFILES[DIFFICULTY.Normal].gateHalfWidth * START_GATE_SCALE,
      1e-9,
      "by exactly the margin the start line is given",
    );

    const long = buildRaceGates({ ...options, gateCount: 500 });
    assertClose(
      long.length,
      MAX_RACE_GATES,
      1e-9,
      "a course cannot be asked for more gates than it can hold",
    );

    const easy = buildRaceGates({
      ...options,
      profile: RACE_PROFILES[DIFFICULTY.Easy],
    });
    const hard = buildRaceGates({
      ...options,
      profile: RACE_PROFILES[DIFFICULTY.Hard],
    });
    assert(
      (easy[1] as RaceGate).halfWidth > (hard[1] as RaceGate).halfWidth,
      "an easy gate is wider than a hard one",
    );
    assert(
      (a[0] as RaceGate).halfWidth > (a[1] as RaceGate).halfWidth &&
        (a[0] as RaceGate).halfHeight > (a[1] as RaceGate).halfHeight,
      "and the start gate is wider than the gates that are raced through",
    );

    const course = buildRaceCourse(options);
    assert(course.length > 0, "the course has a measured length");
    assert(
      course.isFinish(course.gateCount - 1) && !course.isFinish(0),
      "and the last gate is the finish, not the first",
    );
  });

  suite("the whole field lines up on one start line", () => {
    const radius = PLAYER_WING.collisionRadius;
    const spacing = radius * 2 + GRID_GAP;
    const start = V.vec3(120, -40, 900);
    const slots = raceGridSlots({
      count: MAX_RACE_COMPETITORS + 1,
      start,
      headingDeg: 0,
      collisionRadius: radius,
    });

    assertClose(
      slots.length,
      MAX_RACE_COMPETITORS + 1,
      1e-9,
      "a full field gets a slot each, the player included",
    );
    assert(
      V.distance((slots[0] as RaceGridSlot).position, start) < 1e-9,
      "the first slot is where the player already is",
    );
    assert(
      slots.every((slot) => Math.abs(slot.position.y - start.y) < 1e-9),
      "and nobody is staggered back from it: the line is abreast",
    );
    assert(
      slots.every((slot) => Math.abs(slot.position.z - start.z) < 1e-9),
      "at one height, so nobody has further to descend",
    );

    // The whole point of the issue this fixes: no aircraft may be handed a
    // head start, and none may be spawned inside its neighbour either.
    const across = slots
      .map((slot) => slot.position.x - start.x)
      .sort((a, b) => a - b);
    for (let i = 1; i < across.length; i += 1) {
      const gap = (across[i] as number) - (across[i - 1] as number);
      assertClose(
        gap,
        spacing,
        1e-6,
        `slot ${i} sits ${GRID_GAP} m of clear air off its neighbour`,
      );
      assert(
        gap > radius * 2,
        "which is more than the two airframes take up",
      );
    }
    assert(
      (across[across.length - 1] as number) - (across[0] as number) <
        MAX_RACE_COMPETITORS * spacing + 1e-6,
      "so a full grid is a start line rather than a scattering",
    );

    const lanes = slots.map((slot) => slot.lane).sort((a, b) => a - b);
    assertBetween(
      lanes[0] as number,
      -1,
      -0.99,
      "the aircraft on the far left of the line flies the left of the frames",
    );
    assertBetween(
      lanes[lanes.length - 1] as number,
      0.99,
      1,
      "and the one on the far right flies the right of them",
    );
    assert(
      new Set(lanes).size === lanes.length,
      "every slot gets its own lane through the gates",
    );

    // A gate is narrower than a full field is wide, so the line is stacked as
    // well as spread: whoever is beside you takes the other line through it.
    const online = [...slots].sort(
      (a, b) => a.position.x - b.position.x,
    );
    assert(
      online.every((slot) => Math.abs(Math.abs(slot.level) - 1) < 1e-9),
      "every slot flies one of the two lines through the frames",
    );
    assert(
      online.every(
        (slot, i) => i === 0 || slot.level !== (online[i - 1] as RaceGridSlot).level,
      ),
      "and never the same one as the aircraft next to it on the grid",
    );

    // Every aircraft on the line is the same distance from a start gate laid
    // out straight ahead of the grid, whichever way the grid faces.
    for (const headingDeg of [0, 47, 180, 305]) {
      const turned = raceGridSlots({
        count: MAX_RACE_COMPETITORS + 1,
        start,
        headingDeg,
        collisionRadius: radius,
      });
      const gates = buildRaceGates({
        seed: "GRIDSEED",
        profile: RACE_PROFILES[DIFFICULTY.Normal],
        gateCount: 6,
        courseLength: 4000,
        shape: RACE_SHAPE.Sprint,
        missionRadius: 10000,
        start,
        startHeadingDeg: headingDeg,
      });
      const line = (gates[0] as RaceGate).position;
      const runIns = turned.map((slot) => V.distance(slot.position, line));
      const shortest = Math.min(...runIns);
      const longest = Math.max(...runIns);
      assert(
        longest - shortest < 1,
        `on ${headingDeg}deg the field is within a metre of the same run-in (${(
          longest - shortest
        ).toFixed(2)} m)`,
      );
    }

    const alone = raceGridSlots({
      count: 1,
      start,
      headingDeg: 0,
      collisionRadius: radius,
    });
    assertClose(
      (alone[0] as RaceGridSlot).lane,
      0,
      1e-9,
      "a time trial is flown down the middle of the course",
    );
    assertClose(
      raceGridSlots({ count: 0, start, headingDeg: 0, collisionRadius: radius })
        .length,
      0,
      1e-9,
      "and an empty grid is an empty grid",
    );
  });

  suite("the course is the length you asked for", () => {
    const base = {
      seed: "LENGTH",
      profile: RACE_PROFILES[DIFFICULTY.Normal],
      gateCount: 10,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 25000,
      start: V.vec3(0, 0, 500),
    };

    for (const wanted of [2000, 5000, 10000]) {
      const course = buildRaceCourse({ ...base, courseLength: wanted });
      assertBetween(
        course.length,
        wanted * 0.85,
        wanted * 1.15,
        `a ${wanted / 1000} km course measures about ${wanted / 1000} km`,
      );
    }

    for (const wanted of [3000, 8000]) {
      const ring = buildRaceCourse({
        ...base,
        shape: RACE_SHAPE.Circuit,
        courseLength: wanted,
      });
      assertBetween(
        ring.length,
        wanted * 0.85,
        wanted * 1.15,
        `a ${wanted / 1000} km circuit is ${wanted / 1000} km of flying, once round`,
      );
    }

    // Ask for more than the area can hold and the area wins.
    const penned = buildRaceCourse({
      ...base,
      courseLength: 60000,
      missionRadius: 5000,
    });
    assert(
      penned.gates.every((g) => Math.hypot(g.position.x, g.position.y) < 5000),
      "a course too long for the mission area is kept inside it anyway",
    );

    // And a course asked to be absurdly short still has legs worth flying.
    const tight = buildRaceCourse({ ...base, courseLength: 10 });
    for (let i = 1; i < tight.gateCount; i += 1) {
      assert(
        V.distance(
          (tight.gate(i - 1) as RaceGate).position,
          (tight.gate(i) as RaceGate).position,
        ) >= MIN_LEG * 0.75,
        `leg ${i} of a course asked to be nothing is still a leg`,
      );
    }
  });

  await suite("the gates follow the ground", async () => {
    const terrain = await gentleTerrain();
    const ground = terrain.heightAt(0, 0);
    const options = {
      seed: "DECK",
      profile: RACE_PROFILES[DIFFICULTY.Normal],
      gateCount: 12,
      courseLength: 6000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 12000,
      // Launched from three hundred metres up, which is not where the race is.
      start: V.vec3(0, 0, ground + 300),
      terrain,
    };
    const gates = buildRaceGates(options);
    const clearances = gates.map((gate) => gateAgl(terrain, gate));

    assert(
      clearances.every((agl) => agl >= MIN_GATE_CLEARANCE - 1e-6),
      `no gate is closer to the ground than the clearance (${Math.min(
        ...clearances,
      ).toFixed(1)} m)`,
    );
    assert(
      clearances.every((agl) => agl <= MAX_GATE_CLEARANCE + 1e-6),
      `and over open country none is higher over it (${Math.max(
        ...clearances,
      ).toFixed(1)} m)`,
    );
    assert(
      gates.every((gate) => gate.position.z < options.start.z - 100),
      "so the course is flown down on the deck, not at the height it launched from",
    );

    // Following the ground means changing height with it, which is the whole
    // difference between a course laid on the ground and one laid over it.
    const heights = gates.map((gate) => gate.position.z);
    assert(
      Math.max(...heights) - Math.min(...heights) > 60,
      "the course climbs and descends with the ground under it",
    );

    const flat = buildRaceGates({ ...options, terrain: undefined });
    assert(
      flat.every((gate) => Math.abs(gate.position.z - options.start.z) < 1e-9),
      "and with no surface to follow, a course holds the height it launched from",
    );

    // Rolling country is not open country: a gate here and there comes up to
    // keep the leg over it flyable, and the rest of the course stays down.
    const rolling = await rollingTerrain();
    let total = 0;
    let onTheDeck = 0;
    for (const seed of ["DECK", "A", "B", "C", "D"]) {
      const hilly = buildRaceGates({ ...options, seed, terrain: rolling });
      assert(
        hilly.every((gate) => gateAgl(rolling, gate) >= MIN_GATE_CLEARANCE - 1e-6),
        `over hills the clearance is still a floor no gate goes under (${seed})`,
      );
      total += hilly.length;
      onTheDeck += hilly.filter(
        (gate) => gateAgl(rolling, gate) <= MAX_GATE_CLEARANCE + 1e-6,
      ).length;
    }
    assert(
      onTheDeck >= total * 0.7,
      `and most of a course over them is still on the deck (${onTheDeck} of ${total})`,
    );
  });

  await suite("the legs clear the ground as well as the gates", async () => {
    // A gate a few metres over one hilltop and the next a few metres over the
    // next describes a line through the valley wall between them. What is
    // flown is the line.
    const terrain = await rollingTerrain();
    for (const seed of ["LEGS", "A", "B"]) {
      const gates = buildRaceGates({
        seed,
        profile: RACE_PROFILES[DIFFICULTY.Normal],
        gateCount: 10,
        courseLength: 5000,
        shape: RACE_SHAPE.Sprint,
        missionRadius: 12000,
        start: V.vec3(0, 0, terrain.heightAt(0, 0) + 150),
        terrain,
      });
      const clearance = worstLegClearance(terrain, gates);
      assert(
        clearance >= LEG_CLEARANCE - 1,
        `nothing on course ${seed} passes closer to the ground than the leg clearance (${clearance.toFixed(
          1,
        )} m)`,
      );
    }
  });

  await suite("ground too steep to hug is flown over", async () => {
    // A wall across the course: three hundred metres of cliff in one cell.
    const terrain = await shapedTerrain((x) => (x > 1200 ? 320 : 20));
    const gates = buildRaceGates({
      seed: "CLIFF",
      profile: RACE_PROFILES[DIFFICULTY.Hard],
      gateCount: 8,
      courseLength: 3000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 12000,
      start: V.vec3(0, 0, 120),
      startHeadingDeg: 90,
      terrain,
    });

    assert(
      gates.every((gate) => gateAgl(terrain, gate) >= MIN_GATE_CLEARANCE - 1e-6),
      "every gate still clears the ground under it",
    );
    assert(
      gates.some((gate) => gateAgl(terrain, gate) > MAX_GATE_CLEARANCE),
      "but the ones on the run-up to the cliff are lifted off it",
    );
    assertBetween(
      steepestLeg(gates),
      0,
      0.22,
      "so that no leg asks for a climb the airframe has not got",
    );
  });

  await suite("a course is seated again once the surface is known", async () => {
    const terrain = await rollingTerrain();
    const options = {
      seed: "SEATED",
      profile: RACE_PROFILES[DIFFICULTY.Normal],
      gateCount: 8,
      courseLength: 4000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 12000,
      start: V.vec3(0, 0, terrain.heightAt(0, 0) + 200),
      terrain,
    };
    const gates = buildRaceGates(options);
    const asLaidOut = gates.map((gate) => gate.position.z);

    // The same answer, arriving from a better source: nothing moves.
    settleGateHeights(
      gates,
      gates.map((gate) => groundUnder(terrain, gate)),
      options.seed,
    );
    assert(
      gates.every((gate, i) => Math.abs(gate.position.z - (asLaidOut[i] as number)) < 1e-9),
      "settling a course on the surface it is already on changes nothing",
    );

    // A town under the course: the gates climb onto the roofs.
    const roofs = gates.map((gate) => groundUnder(terrain, gate) + 40);
    settleGateHeights(gates, roofs, options.seed);
    assert(
      gates.every(
        (gate, i) =>
          gate.position.z - gate.halfHeight - (roofs[i] as number) >=
          MIN_GATE_CLEARANCE - 1e-6,
      ),
      "a gate over a building is a few metres over the building",
    );
    assert(
      gates.every((gate, i) => gate.position.z > (asLaidOut[i] as number)),
      "which is higher than the same gate over bare ground",
    );

    // Nothing known about the far half of the course.
    const partial: (number | null)[] = gates.map((gate, i) =>
      i < 4 ? groundUnder(terrain, gate) : null,
    );
    settleGateHeights(gates, partial, options.seed);
    const known = (gates[3] as RaceGate).position.z;
    assert(
      gates.slice(4).every((gate) => Math.abs(gate.position.z - known) < 200),
      "gates over unsampled ground take the height of the last one that was sampled",
    );

    // And a course with nothing under it at all is left exactly as it was.
    const untouched = gates.map((gate) => gate.position.z);
    settleGateHeights(gates, gates.map(() => null), options.seed);
    assert(
      gates.every((gate, i) => Math.abs(gate.position.z - (untouched[i] as number)) < 1e-9),
      "and a course with no surface under it at all is left where it is",
    );
  });

  await suite("the start line is far enough ahead to get down to", async () => {
    const terrain = await shapedTerrain(() => 0);
    const base = {
      seed: "RUNIN",
      profile: RACE_PROFILES[DIFFICULTY.Normal],
      gateCount: 6,
      courseLength: 3000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 20000,
      terrain,
    };

    const low = buildRaceGates({ ...base, start: V.vec3(0, 0, 30) });
    assertClose(
      Math.hypot(
        (low[0] as RaceGate).position.x,
        (low[0] as RaceGate).position.y,
      ),
      START_GATE_RANGE,
      1e-6,
      "a grid already down on the deck gets the usual run-in",
    );

    const high = buildRaceGates({ ...base, start: V.vec3(0, 0, 400) });
    const runIn = Math.hypot(
      (high[0] as RaceGate).position.x,
      (high[0] as RaceGate).position.y,
    );
    assert(
      runIn > START_GATE_RANGE * 1.5,
      `a grid four hundred metres up gets a longer one (${Math.round(runIn)} m)`,
    );
    assert(
      runIn <= MAX_START_GATE_RANGE + 1e-6,
      "though never longer than a run-in that has become a transit",
    );
    assert(
      400 - (high[0] as RaceGate).position.z < runIn * 0.4,
      "and the descent onto the line is one a wing glides",
    );
  });

  suite("a circuit comes back to its own start line", () => {
    const options = {
      seed: "CIRCUIT",
      profile: RACE_PROFILES[DIFFICULTY.Normal],
      gateCount: 8,
      courseLength: 6000,
      shape: RACE_SHAPE.Circuit,
      missionRadius: 20000,
      start: V.vec3(0, 0, 500),
    };
    const course = buildRaceCourse(options);
    const start = course.start as RaceGate;
    const finish = course.finish as RaceGate;

    assertClose(
      course.gateCount,
      9,
      1e-9,
      "eight gates flown as a circuit are nine crossings",
    );
    assert(
      finish.frame === start.frame,
      "and the finish is the start line rather than a gate beside it",
    );
    assertClose(
      V.distance(finish.position, start.position),
      0,
      1e-9,
      "in exactly the same piece of sky",
    );
    assertClose(
      finish.headingDeg,
      start.headingDeg,
      1e-9,
      "flown the same way round",
    );
    assertClose(
      course.frameCount,
      8,
      1e-9,
      "so there are eight frames to draw, not nine",
    );

    // The grid crosses the line going straight, then turns onto the course.
    assertClose(
      start.headingDeg,
      0,
      1e-6,
      "the start line faces the way the aircraft launch",
    );
    assertClose(
      Math.hypot(start.position.x, start.position.y),
      START_GATE_RANGE,
      1e-6,
      "and sits ahead of the grid, like a sprint's",
    );

    const sprint = buildRaceCourse({ ...options, shape: RACE_SHAPE.Sprint });
    assert(
      (sprint.finish as RaceGate).frame !== (sprint.start as RaceGate).frame,
      "a sprint, by contrast, finishes somewhere else entirely",
    );
    assert(
      V.distance(
        (sprint.finish as RaceGate).position,
        (sprint.start as RaceGate).position,
      ) > 1000,
      "a long way from where it started",
    );
  });

  await suite("a circuit is timed lap-fashion", async () => {
    // Two crossings of one frame: the first starts the clock, the second stops
    // it. Nothing in between counts it, because only the next gate is looked
    // for.
    const gates = buildRaceGates({
      seed: "LAPS",
      profile: RACE_PROFILES[DIFFICULTY.Easy],
      gateCount: 4,
      courseLength: 3000,
      shape: RACE_SHAPE.Circuit,
      missionRadius: 20000,
      start: V.vec3(0, 0, 500),
    });
    const course = new RaceCourse(gates);
    const tracker = new RaceTracker(course);
    const player = racerState("player");
    const fleet = [player];
    tracker.register("player", "YOU", true);

    // Walk each gate in turn, crossing squarely through the middle of it.
    let time = 0;
    for (let i = 0; i < course.gateCount; i += 1) {
      const gate = course.gate(i) as RaceGate;
      time += 10;
      const before = V.vec3(
        gate.position.x - gate.forward.x * 60,
        gate.position.y - gate.forward.y * 60,
        gate.position.z,
      );
      const after = V.vec3(
        gate.position.x + gate.forward.x * 60,
        gate.position.y + gate.forward.y * 60,
        gate.position.z,
      );
      V.copy(player.position, before);
      tracker.update(fleet, time);
      V.copy(player.position, after);
      tracker.update(fleet, time + 1);
    }

    assert(tracker.playerFinished, "the lap is completed on the start line");
    assertClose(
      tracker.progress.gatesPassed,
      course.gateCount,
      1e-9,
      "with every crossing counted",
    );
    // Five crossings ten seconds apart: the clock runs from the first to the
    // last, which is four gaps and not five.
    assertBetween(
      tracker.progress.elapsed,
      (course.gateCount - 1) * 10 - 1,
      (course.gateCount - 1) * 10 + 1,
      "and the clock reading first crossing to last",
    );
  });

  suite("flying through a gate", () => {
    const gate = (straightCourse(1).start as RaceGate);

    assert(
      gatePassed(gate, V.vec3(0, 300, 500), V.vec3(0, 500, 500)),
      "crossing the middle of the frame counts",
    );
    assert(
      !gatePassed(gate, V.vec3(0, 300, 500), V.vec3(0, 380, 500)),
      "stopping short of it does not",
    );
    assert(
      !gatePassed(gate, V.vec3(80, 300, 500), V.vec3(80, 500, 500)),
      "passing wide of the posts does not",
    );
    assert(
      !gatePassed(gate, V.vec3(0, 300, 560), V.vec3(0, 500, 560)),
      "flying over the top does not",
    );
    assert(
      !gatePassed(gate, V.vec3(0, 500, 500), V.vec3(0, 300, 500)),
      "and going back through it the wrong way does not",
    );
    assert(
      gatePassed(gate, V.vec3(0, 399, 490), V.vec3(0, 401, 510)),
      "a climbing pass through the frame still counts",
    );
  });

  suite("the clock", () => {
    const course = straightCourse(4, 400);
    const tracker = new RaceTracker(course);
    const player = racerState("player");
    const fleet = [player];
    tracker.register("player", "YOU", true);

    // Run in to the line. Nothing is timed yet.
    flyTo(tracker, fleet, player, 0, 100, 500, 5);
    flyTo(tracker, fleet, player, 0, 300, 500, 8);
    assert(!tracker.progress.started, "the clock does not run before the start gate");
    assertClose(tracker.progress.elapsed, 0, 1e-9, "and reads zero");

    // Gate 1 at y = 400: the clock starts here, at t = 10.
    flyTo(tracker, fleet, player, 0, 500, 500, 10);
    assert(tracker.progress.started, "crossing the first gate starts it");
    assertClose(tracker.progress.gatesPassed, 1, 1e-9, "one gate is behind us");
    assertClose(tracker.progress.elapsed, 0, 1e-9, "with no time on it yet");

    // Skip gate 2 (y = 800) entirely by going round the outside of it.
    flyTo(tracker, fleet, player, 300, 900, 500, 14);
    flyTo(tracker, fleet, player, 0, 1000, 500, 16);
    assertClose(
      tracker.progress.gatesPassed,
      1,
      1e-9,
      "a gate flown round is a gate not flown",
    );
    flyTo(tracker, fleet, player, 0, 1300, 500, 18);
    assertClose(
      tracker.progress.gatesPassed,
      1,
      1e-9,
      "and the gate after it does not count while it is still owed",
    );

    // Back through the missed gate, then on down the course.
    flyTo(tracker, fleet, player, 0, 700, 500, 20);
    flyTo(tracker, fleet, player, 0, 900, 500, 22);
    assertClose(tracker.progress.gatesPassed, 2, 1e-9, "coming back for it works");
    flyTo(tracker, fleet, player, 0, 1300, 500, 24);
    assertClose(tracker.progress.gatesPassed, 3, 1e-9, "and the course resumes");
    assertBetween(
      tracker.progress.elapsed,
      13.9,
      14.1,
      "the clock is running from the start gate",
    );

    // The finish, at t = 30.
    flyTo(tracker, fleet, player, 0, 1700, 500, 30);
    assert(tracker.playerFinished, "the last gate finishes the race");
    assertClose(
      tracker.progress.elapsed,
      20,
      1e-6,
      "and stops the clock at first gate to last",
    );

    flyTo(tracker, fleet, player, 0, 2400, 500, 40);
    assertClose(
      tracker.progress.elapsed,
      20,
      1e-6,
      "carrying on past the line does not add to the time",
    );
  });

  suite("a replaced airframe is not credited with the course", () => {
    const course = straightCourse(4, 400);
    const tracker = new RaceTracker(course);
    const player = racerState("player");
    const fleet = [player];
    tracker.register("player", "YOU", true);

    flyTo(tracker, fleet, player, 0, 300, 500, 1);
    flyTo(tracker, fleet, player, 0, 500, 500, 2);
    assertClose(tracker.progress.gatesPassed, 1, 1e-9, "the start gate is flown");

    // Wrecked between the gates, then put back on the course further along.
    player.status = FLIGHT_STATUS.Crashed;
    tracker.update(fleet, 3);
    V.set(player.position, 0, 1500, 500);
    player.status = FLIGHT_STATUS.Flying;
    tracker.update(fleet, 6);
    tracker.update(fleet, 6.1);
    assertClose(
      tracker.progress.gatesPassed,
      1,
      1e-9,
      "and the gates it was carried past are still owed",
    );
  });

  suite("standings", () => {
    const course = straightCourse(3, 400);
    const tracker = new RaceTracker(course);
    const player = racerState("player");
    const rival = racerState("racer-1", AIRCRAFT_ROLE.Racer);
    const fleet = [player, rival];
    tracker.register("player", "YOU", true);
    tracker.register("racer-1", "R1");

    V.set(rival.position, 60, 0, 500);
    tracker.update(fleet, 0);

    // The rival takes the first gate; the player is still on the run-in.
    V.set(rival.position, 60, 300, 500);
    V.set(player.position, 0, 200, 500);
    tracker.update(fleet, 2);
    V.set(rival.position, 60, 500, 500);
    tracker.update(fleet, 3);
    assertClose(
      tracker.progress.position,
      2,
      1e-9,
      "being a gate down puts you second",
    );
    assert(tracker.progress.gapToLeader > 0, "with a gap to the leader");
    assertClose(
      tracker.standings.length,
      2,
      1e-9,
      "and both aircraft are on the board",
    );
    assert(
      (tracker.standings[0]?.label ?? "") === "R1",
      "the leader is the one in front",
    );

    // The player closes it out and wins on the road.
    for (const y of [400, 600, 900, 1300]) {
      V.set(player.position, 0, y, 500);
      tracker.update(fleet, 4 + y / 100);
    }
    assert(tracker.playerFinished, "the player finishes");
    assertClose(tracker.progress.position, 1, 1e-9, "and finishing first wins it");
  });

  await suite("race mission", async () => {
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain: await flatTerrain(2000),
      missionRadius: 10000,
      contactDamage: false,
    });
    const runner = new MissionRunner(settings());
    const tracker = runner.setRaceCourse(straightCourse(3, 400));
    tracker.register("player", "YOU", true);

    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 500),
        headingDeg: 0,
        airspeed: 28,
        throttle: 0.7,
      },
      () => idle,
    );

    assertClose(
      interceptorsFor(settings()),
      3,
      1e-9,
      "a race launches with a small reserve of airframes",
    );

    runner.update(simulation, 1 / 60);
    assert(
      runner.status.race !== undefined,
      "the mission status carries the race once the course exists",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and the race is running",
    );

    // Walk the aircraft down the course by hand: the timing rule is what is
    // under test here, not the flying.
    const events = [];
    simulation.time = 4;
    V.set(player.position, 0, 300, 500);
    events.push(...runner.update(simulation, 1 / 60));
    simulation.time = 6;
    V.set(player.position, 0, 500, 500);
    events.push(...runner.update(simulation, 1 / 60));
    assert(
      events.some((e) => e.type === "GATE" && e.gateIndex === 0),
      "flying a gate raises an event for it",
    );

    simulation.time = 9;
    V.set(player.position, 0, 900, 500);
    runner.update(simulation, 1 / 60);
    simulation.time = 12;
    V.set(player.position, 0, 1300, 500);
    const finish = runner.update(simulation, 1 / 60);

    assert(
      finish.some((e) => e.type === "GATE" && e.isFinish),
      "the finish gate is flagged as one",
    );
    assert(
      finish.some((e) => e.type === "COMPLETE"),
      "and crossing it completes the mission",
    );
    assert(
      runner.status.reason.includes("0:06"),
      `with the time from first gate to last (${runner.status.reason})`,
    );
    assertClose(
      runner.status.race?.gatesPassed ?? 0,
      3,
      1e-9,
      "and every gate flown",
    );
  });

  await suite("running out of airframes ends the race", async () => {
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain: await flatTerrain(2000),
      missionRadius: 10000,
      contactDamage: false,
    });
    const runner = new MissionRunner(settings());
    runner.setRaceCourse(straightCourse(3, 400));

    const spawn = (): AircraftState =>
      simulation.spawn(
        {
          id: "player",
          role: AIRCRAFT_ROLE.Player,
          config: PLAYER_WING,
          position: V.vec3(0, 0, 500),
          headingDeg: 0,
          airspeed: 28,
          throttle: 0.7,
        },
        () => idle,
      );

    let player = spawn();
    let failed = false;
    for (let round = 0; round < 4 && !failed; round += 1) {
      player.status = FLIGHT_STATUS.Crashed;
      for (let i = 0; i < 5 * 60; i += 1) {
        for (const event of runner.update(simulation, 1 / 60)) {
          if (event.type === "RELAUNCH") {
            simulation.remove("player");
            player = spawn();
          }
          if (event.type === "FAILED") failed = true;
        }
      }
    }
    assert(failed, "the race ends once there is nothing left to fly");
    assert(
      runner.status.reason.includes("No airframes left"),
      `and says why (${runner.status.reason})`,
    );
  });

  await suite("a rival flies the course", async () => {
    const terrain = await flatTerrain(9000);
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain,
      missionRadius: 10000,
    });
    const profile = RACE_PROFILES[DIFFICULTY.Normal];
    const course = buildRaceCourse({
      seed: "RACESEED",
      profile,
      gateCount: 6,
      courseLength: 4000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 10000,
      start: V.vec3(0, 0, 400),
    });
    const tracker = new RaceTracker(course);
    tracker.register("racer-1", "R1");

    const pilot = new RacePilot({
      id: "racer-1",
      course,
      profile,
      terrain,
      seed: "RACESEED",
      getNextGate: () => tracker.nextGateFor("racer-1"),
    });

    const rival = simulation.spawn(
      {
        id: "racer-1",
        role: AIRCRAFT_ROLE.Racer,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 400),
        headingDeg: 0,
        airspeed: 26,
        throttle: 0.7,
      },
      pilot.control,
    );

    // Long enough to fly a six-gate course at racing speed with room to spare.
    for (let i = 0; i < 240 * 60; i += 1) {
      simulation.update(1 / 60);
      tracker.update(simulation.aircraft, simulation.time);
      if (tracker.nextGateFor("racer-1") >= course.gateCount) break;
    }

    assert(
      rival.status === FLIGHT_STATUS.Flying,
      `the rival is still flying (${rival.status})`,
    );
    assertClose(
      tracker.nextGateFor("racer-1"),
      course.gateCount,
      1e-9,
      "and flew every gate on the course",
    );
    const standing = tracker.standings[0];
    assert(standing?.finished === true, "so the race is finished");
    assert(
      (standing?.elapsed ?? 0) > 0,
      `with a time on the clock (${formatRaceTime(standing?.elapsed ?? 0)})`,
    );
  });

  await suite("a full field starts together and races clear", async () => {
    // The grid the mission actually uses, flown by the pilots the mission
    // actually uses: everybody abreast a few metres apart, all pointed at the
    // same start gate half a kilometre ahead. Two things have to come out of
    // it — the field crosses the line together, and it does not meet in the
    // middle of the first frame on the way there.
    const terrain = await flatTerrain(9000);
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain,
      missionRadius: 10000,
    });
    const profile = RACE_PROFILES[DIFFICULTY.Normal];
    const start = V.vec3(0, 0, 400);
    const course = buildRaceCourse({
      seed: "FIELDRACE",
      profile,
      gateCount: 5,
      courseLength: 3000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 10000,
      start,
    });
    const tracker = new RaceTracker(course);

    const rivals = MAX_RACE_COMPETITORS;
    const grid = raceGridSlots({
      count: rivals + 1,
      start,
      headingDeg: 0,
      collisionRadius: PLAYER_WING.collisionRadius,
    });
    const field: AircraftState[] = [];
    for (let i = 0; i < rivals; i += 1) {
      const id = `racer-${i + 1}`;
      const slot = grid[i + 1] as RaceGridSlot;
      tracker.register(id, `R${i + 1}`);
      const pilot = new RacePilot({
        id,
        course,
        profile,
        terrain,
        seed: "FIELDRACE",
        getNextGate: () => tracker.nextGateFor(id),
        lane: slot.lane,
        level: slot.level,
      });
      field.push(
        simulation.spawn(
          {
            id,
            role: AIRCRAFT_ROLE.Racer,
            config: PLAYER_WING,
            position: V.vec3(slot.position.x, slot.position.y, slot.position.z),
            headingDeg: 0,
            airspeed: 25,
            throttle: 0.65,
          },
          pilot.control,
        ),
      );
    }

    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 240 * 60; i += 1) {
      simulation.update(1 / 60);
      tracker.update(simulation.aircraft, simulation.time);
      // Only while the whole field is still racing: a rival with the course
      // behind it is scenery, and scenery is allowed to drift together.
      if (tracker.standings.every((entry) => !entry.finished)) {
        for (let a = 0; a < field.length; a += 1) {
          for (let b = a + 1; b < field.length; b += 1) {
            closest = Math.min(
              closest,
              V.distance(
                (field[a] as AircraftState).position,
                (field[b] as AircraftState).position,
              ),
            );
          }
        }
      }
      if (tracker.standings.every((entry) => entry.finished)) break;
    }

    assert(
      field.every((rival) => rival.status === FLIGHT_STATUS.Flying),
      "every rival on the grid is still flying",
    );
    assert(
      tracker.standings.every((entry) => entry.finished),
      "and every one of them flew the whole course",
    );

    const starts = tracker.standings.map((entry) => entry.startTime);
    const spread = Math.max(...starts) - Math.min(...starts);
    assert(
      spread < 2,
      `the field crossed the start line together (${spread.toFixed(2)} s apart)`,
    );

    const times = tracker.standings.map((entry) => entry.elapsed);
    assert(
      times.every((time) => time > 0),
      "every racer has its own time on the clock",
    );
    assert(
      Math.max(...times) - Math.min(...times) < Math.min(...times) * 0.5,
      "and the race was decided by flying rather than by the grid",
    );

    assert(
      closest > PLAYER_WING.collisionRadius * 2,
      `nobody was flown into anybody on the way (${closest.toFixed(1)} m at the closest)`,
    );
  });

  await suite("a rival flies a course on the deck", async () => {
    // The same test as above with the ground put back: gates that follow the
    // hills, and a rival that has to fly down among them to make them.
    const terrain = await rollingTerrain();
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain,
      missionRadius: 12000,
    });
    const profile = RACE_PROFILES[DIFFICULTY.Normal];
    const ground = terrain.heightAt(0, 0);
    const course = buildRaceCourse({
      seed: "DECKRACE",
      profile,
      gateCount: 6,
      courseLength: 4000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 12000,
      start: V.vec3(0, 0, ground + 120),
      terrain,
    });
    const tracker = new RaceTracker(course);
    tracker.register("racer-1", "R1");

    const pilot = new RacePilot({
      id: "racer-1",
      course,
      profile,
      terrain,
      seed: "DECKRACE",
      getNextGate: () => tracker.nextGateFor("racer-1"),
    });

    const rival = simulation.spawn(
      {
        id: "racer-1",
        role: AIRCRAFT_ROLE.Racer,
        config: PLAYER_WING,
        position: V.vec3(0, 0, ground + 120),
        headingDeg: 0,
        airspeed: 26,
        throttle: 0.7,
      },
      pilot.control,
    );

    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 240 * 60; i += 1) {
      simulation.update(1 / 60);
      tracker.update(simulation.aircraft, simulation.time);
      lowest = Math.min(lowest, rival.altitudeAgl);
      if (tracker.nextGateFor("racer-1") >= course.gateCount) break;
    }

    assert(
      rival.status === FLIGHT_STATUS.Flying,
      `the rival is still flying (${rival.status})`,
    );
    assertClose(
      tracker.nextGateFor("racer-1"),
      course.gateCount,
      1e-9,
      "and flew every gate on a course laid on the ground",
    );
    assert(
      lowest < 60,
      `which took it down among them (${Math.round(lowest)} m at the lowest)`,
    );
  });

  await suite("a circuit on the deck closes on one height", async () => {
    const terrain = await rollingTerrain();
    const gates = buildRaceGates({
      seed: "RING",
      profile: RACE_PROFILES[DIFFICULTY.Normal],
      gateCount: 8,
      courseLength: 6000,
      shape: RACE_SHAPE.Circuit,
      missionRadius: 20000,
      start: V.vec3(0, 0, terrain.heightAt(0, 0) + 250),
      terrain,
    });
    const start = gates[0] as RaceGate;
    const finish = gates[gates.length - 1] as RaceGate;

    assertClose(
      finish.position.z,
      start.position.z,
      1e-9,
      "the line the lap ends on is at the height the lap began at",
    );
    assert(
      gates.every((gate) => gateAgl(terrain, gate) >= MIN_GATE_CLEARANCE - 1e-6),
      "every gate on the ring clears the ground under it",
    );
    assertBetween(
      steepestLeg(gates),
      0,
      0.22,
      "and no leg of it, the one back onto the start line included, is unflyable",
    );
  });

  suite("race presentation", () => {
    assert(racePlacing(1) === "1st", "first place reads as one");
    assert(racePlacing(2) === "2nd", "second too");
    assert(racePlacing(3) === "3rd", "and third");
    assert(racePlacing(11) === "11th", "the rest fall back to a plain ordinal");
    assert(
      formatRaceTime(83.46) === "1:23.5",
      `a race time is shown to a tenth (${formatRaceTime(83.46)})`,
    );
    assert(formatRaceTime(0) === "--:--.-", "and an unset one is shown as unset");
  });
}
