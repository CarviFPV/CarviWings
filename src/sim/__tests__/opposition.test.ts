import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { CA35_160, PLAYER_WING, SKYWALKER_X8 } from "../flight/config";
import { hoverThrottle } from "../flight/multirotor";
import { maxLevelSpeed } from "../flight/physics";
import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import {
  CA35_160_UAV,
  FOAM_GLIDER_UAV,
  INTERCEPTOR_WING,
  SKYWALKER_X8_UAV,
  UAVS,
  X10_INTERCEPTOR_UAV,
} from "../flight/uav";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { EnemyController } from "../ai/enemyController";
import { TerrainAvoidanceSystem } from "../ai/terrainAvoidance";
import { generatePatrolRoute } from "../ai/patrol";
import { commandedSpeed, minimumCommandedSpeed } from "../ai/autopilot";
import { RacePilot } from "../ai/racer";
import { FestivalPilot } from "../ai/festivalPilot";
import {
  FORMATION_SLOT,
  FORMATION_SLOTS,
  FormationLeadPilot,
  FormationWingPilot,
  MANOEUVRE,
  formationStation,
} from "../ai/formation";
import { RACE_PROFILES, RACE_SHAPE, RaceTracker, buildRaceCourse } from "../mission/race";
import { DIFFICULTY, DIFFICULTY_PROFILES } from "../ai/types";
import {
  DEFAULT_OPPOSITION,
  OPPOSITION_MODE,
  OPPOSITION_MODES,
  OPPOSITION_MODE_INFO,
  contactSpeedReference,
  describeOpposition,
  normaliseOpposition,
  oppositionAircraft,
  oppositionFleet,
} from "../mission/opposition";
import * as V from "../math/vec3";

async function flatTerrain(radius: number, height = 0): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => height),
    { cellSize: 500, warmRadius: 6000, sampleBudget: 60000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

/** A simulation to fly one of somebody else's aircraft in. */
function arena(terrain: TerrainField, missionRadius: number): Simulation {
  return new Simulation({
    frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
    terrain,
    missionRadius,
    groundClearance: 1.5,
  });
}

/** How an aircraft of this kind is put in the air already flying. */
function launched(uav: (typeof UAVS)[number], cruise: number, throttle: number) {
  const rotor = uav.config.rotor !== undefined;
  return {
    config: uav.config,
    airspeed: rotor ? 0 : cruise,
    throttle: rotor ? hoverThrottle(uav.config) : throttle,
  };
}

/** The airframes a whole field of contacts turns out to be flying. */
function dealt(
  settings: Parameters<typeof oppositionAircraft>[0],
  seed: string,
  count: number,
): readonly string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(oppositionAircraft(settings, seed, i).id);
  }
  return ids;
}

export async function runOppositionTests(): Promise<void> {
  suite("choosing an opposition", () => {
    assert(
      DEFAULT_OPPOSITION.mode === OPPOSITION_MODE.Chosen &&
        DEFAULT_OPPOSITION.aircraft.length === 1 &&
        DEFAULT_OPPOSITION.aircraft[0] === INTERCEPTOR_WING.id,
      "a mission that says nothing is flown against interceptors, as it always was",
    );
    assert(
      OPPOSITION_MODES.every((id) => OPPOSITION_MODE_INFO[id].label.length > 0),
      "every way of choosing one has something to call it on a menu",
    );

    const repaired = normaliseOpposition({
      mode: "SOMETHING_ELSE",
      aircraft: [
        CA35_160_UAV.id,
        "an-aircraft-nobody-has",
        INTERCEPTOR_WING.id,
        CA35_160_UAV.id,
      ],
    });
    assert(
      repaired.mode === DEFAULT_OPPOSITION.mode,
      "a mode nobody recognises falls back rather than reaching a spawn",
    );
    assert(
      repaired.aircraft.length === 2,
      "an airframe nobody has is dropped, and a repeated one is only there once",
    );
    assert(
      repaired.aircraft[0] === INTERCEPTOR_WING.id,
      "and what is left comes back in hangar order rather than the order it was typed",
    );
    assert(
      normaliseOpposition({ aircraft: [] }).aircraft.length === 1,
      "a selection with nothing left in it is an opposition of interceptors, not of nothing",
    );
    assert(
      normaliseOpposition(undefined).aircraft[0] === INTERCEPTOR_WING.id,
      "and so is no setting at all",
    );

    assert(
      oppositionFleet({
        mode: OPPOSITION_MODE.All,
        aircraft: [CA35_160_UAV.id],
      }).length === UAVS.length,
      "asking for all types puts the whole hangar up whatever was ticked",
    );
    assert(
      oppositionFleet({ mode: OPPOSITION_MODE.Random, aircraft: [] }).length ===
        UAVS.length,
      "and so does asking for anything at all",
    );
    assert(
      describeOpposition({
        mode: OPPOSITION_MODE.Chosen,
        aircraft: [SKYWALKER_X8_UAV.id],
      }) === SKYWALKER_X8.name,
      "one airframe describes itself by name",
    );
  });

  suite("dealing the aircraft out", () => {
    const seed = "OPPOSE01";

    const single = dealt(
      { mode: OPPOSITION_MODE.Chosen, aircraft: [SKYWALKER_X8_UAV.id] },
      seed,
      8,
    );
    assert(
      single.every((id) => id === SKYWALKER_X8_UAV.id),
      "one airframe selected is a field of that airframe and nothing else",
    );

    const everything = dealt(
      { mode: OPPOSITION_MODE.All, aircraft: [] },
      seed,
      UAVS.length,
    );
    assert(
      new Set(everything).size === UAVS.length,
      "asking for every type and flying enough contacts puts every type up",
    );

    const pair = dealt(
      {
        mode: OPPOSITION_MODE.Chosen,
        aircraft: [SKYWALKER_X8_UAV.id, CA35_160_UAV.id],
      },
      seed,
      6,
    );
    assert(
      new Set(pair).size === 2 &&
        pair.every(
          (id) => id === SKYWALKER_X8_UAV.id || id === CA35_160_UAV.id,
        ),
      "two airframes selected is a field of those two and only those two",
    );

    assert(
      dealt(
        { mode: OPPOSITION_MODE.All, aircraft: [] },
        seed,
        UAVS.length + 2,
      ).join() === everything.concat(everything.slice(0, 2)).join(),
      "and the deal repeats rather than running out on a bigger field",
    );

    const again = dealt({ mode: OPPOSITION_MODE.All, aircraft: [] }, seed, 12);
    assert(
      again.slice(0, UAVS.length).join() === everything.join(),
      "the same mission always puts the same aircraft in the same places",
    );

    const drawn = dealt({ mode: OPPOSITION_MODE.Random, aircraft: [] }, seed, 24);
    assert(
      new Set(drawn).size > 1,
      "drawing from the whole hangar puts more than one kind of aircraft up",
    );
    assert(
      drawn.join() ===
        dealt({ mode: OPPOSITION_MODE.Random, aircraft: [] }, seed, 24).join(),
      "and it is drawn from the seed, so the same mission draws the same field",
    );
    assert(
      drawn.join() !==
        dealt({ mode: OPPOSITION_MODE.Random, aircraft: [] }, "OPPOSE02", 24)
          .join(),
      "while another mission draws its own",
    );
  });

  suite("the speed a contact is held to", () => {
    const wing = maxLevelSpeed(PLAYER_WING);
    const survey = maxLevelSpeed(SKYWALKER_X8);
    const quad = maxLevelSpeed(CA35_160);

    assert(
      survey < wing && quad > wing,
      `the hangar really does fly at different speeds (X8 ${survey.toFixed(
        0,
      )}, wing ${wing.toFixed(0)}, quad ${quad.toFixed(0)} m/s)`,
    );

    assertClose(
      contactSpeedReference(SKYWALKER_X8, PLAYER_WING),
      survey,
      1e-6,
      "a contact slower than the pilot's aircraft is held to its own speed",
    );
    assertClose(
      contactSpeedReference(CA35_160, PLAYER_WING),
      wing,
      1e-6,
      "and one faster than it is held to the pilot's, so it can still be caught",
    );
    assert(
      contactSpeedReference(SKYWALKER_X8, PLAYER_WING) <
        contactSpeedReference(PLAYER_WING, PLAYER_WING),
      "so a survey wing in the same mission is genuinely slower than an interceptor",
    );
    assert(
      contactSpeedReference(PLAYER_WING, PLAYER_WING) === wing,
      "and a mission flown against the pilot's own airframe is the mission it always was",
    );
  });

  suite("the speed a pilot may actually ask for", () => {
    assertClose(
      commandedSpeed(PLAYER_WING, 24, null),
      24,
      1e-6,
      "an aircraft that can hold what it was asked for holds what it was asked for",
    );
    assertClose(
      commandedSpeed(PLAYER_WING, 40, 26),
      26,
      1e-6,
      "a cruise past what the mission allows is held to what the mission allows",
    );
    assert(
      commandedSpeed(SKYWALKER_X8, 4, null) > 4,
      "and one under the stall protection is lifted off it rather than mushed",
    );
    assertClose(
      commandedSpeed(SKYWALKER_X8, 4, 6),
      minimumCommandedSpeed(SKYWALKER_X8),
      1e-6,
      "the floor wins over the ceiling: nothing is ever commanded into a stall",
    );
    assertClose(
      commandedSpeed(CA35_160, 3, null),
      3,
      1e-6,
      "a quadcopter has no stall to protect, so slow is simply slow",
    );
  });

  await suite("a rival races the aeroplane it was dealt", async () => {
    const terrain = await flatTerrain(9000, -500);
    const profile = RACE_PROFILES[DIFFICULTY.Normal];
    const start = V.vec3(0, 0, 400);
    const course = buildRaceCourse({
      seed: "OPPOSE-RACE",
      profile,
      gateCount: 5,
      courseLength: 3000,
      shape: RACE_SHAPE.Sprint,
      missionRadius: 10000,
      start,
    });

    /** One rival, in whatever airframe the grid dealt it, given four minutes. */
    const race = (uav: (typeof UAVS)[number]) => {
      const simulation = arena(terrain, 10000);
      const id = "racer-1";
      const tracker = new RaceTracker(course);
      tracker.register(id, "R1");
      const pilot = new RacePilot({
        id,
        course,
        profile,
        terrain,
        seed: "OPPOSE-RACE",
        getNextGate: () => tracker.nextGateFor(id),
        speedReference: contactSpeedReference(uav.config, PLAYER_WING),
      });
      const rival = simulation.spawn(
        {
          id,
          role: AIRCRAFT_ROLE.Racer,
          position: V.vec3(start.x, start.y, start.z),
          headingDeg: 0,
          ...launched(uav, 26, 0.7),
        },
        pilot.control,
      );
      for (let i = 0; i < 240 * 60; i += 1) {
        simulation.update(1 / 60);
        tracker.update(simulation.aircraft, simulation.time);
        if (rival.status !== FLIGHT_STATUS.Flying) break;
        if (tracker.nextGateFor(id) >= course.gateCount) break;
      }
      return { rival, gates: tracker.nextGateFor(id) };
    };

    for (const uav of [
      SKYWALKER_X8_UAV,
      FOAM_GLIDER_UAV,
      CA35_160_UAV,
      X10_INTERCEPTOR_UAV,
    ]) {
      const flown = race(uav);
      assert(
        flown.rival.status === FLIGHT_STATUS.Flying,
        `a ${uav.config.name} rival is still flying at the end of the course`,
      );
      assert(
        flown.gates >= course.gateCount,
        `and flew every gate of it (${flown.gates} of ${course.gateCount})`,
      );
    }
  });

  await suite("a flight displays on the aeroplanes it was dealt", async () => {
    const terrain = await flatTerrain(12000);
    const avoidance = new TerrainAvoidanceSystem(terrain);
    const routine = [
      { type: MANOEUVRE.Cruise, seconds: 20, bankDeg: 0, climb: 0 },
      { type: MANOEUVRE.Turn, seconds: 40, bankDeg: 30, climb: 0 },
      { type: MANOEUVRE.Climb, seconds: 20, bankDeg: 0, climb: 3 },
      { type: MANOEUVRE.Turn, seconds: 40, bankDeg: -30, climb: 0 },
    ];

    /** A two-ship on one airframe, flown for two minutes of the display. */
    const display = (uav: (typeof UAVS)[number]) => {
      const simulation = arena(terrain, 8000);
      const reference = contactSpeedReference(uav.config, PLAYER_WING);
      const leadPilot = new FormationLeadPilot({
        id: "lead",
        routine,
        terrain,
        terrainAvoidance: avoidance,
        missionRadius: 8000,
        speedReference: reference,
      });
      const lead = simulation.spawn(
        {
          id: "lead",
          role: AIRCRAFT_ROLE.Lead,
          position: V.vec3(0, 0, 500),
          headingDeg: 0,
          ...launched(uav, 25, 0.65),
        },
        leadPilot.control,
      );
      const slot = FORMATION_SLOTS[FORMATION_SLOT.Right];
      const wingPilot = new FormationWingPilot({
        id: "wing",
        slot,
        terrain,
        terrainAvoidance: avoidance,
        getLead: () => simulation.lead,
        speedReference: reference,
      });
      const wing = simulation.spawn(
        {
          id: "wing",
          role: AIRCRAFT_ROLE.Wingman,
          position: formationStation(V.vec3(), lead, slot),
          headingDeg: 0,
          ...launched(uav, 25, 0.65),
        },
        wingPilot.control,
      );

      const station = V.vec3();
      let worst = 0;
      for (let i = 0; i < 60 * 120; i += 1) {
        simulation.update(1 / 60);
        if (
          lead.status !== FLIGHT_STATUS.Flying ||
          wing.status !== FLIGHT_STATUS.Flying
        ) {
          break;
        }
        if (i > 60 * 8) {
          formationStation(station, lead, slot);
          worst = Math.max(worst, V.distance(wing.position, station));
        }
      }
      return { lead, wing, worst, speed: leadPilot.debug };
    };

    for (const uav of [
      SKYWALKER_X8_UAV,
      FOAM_GLIDER_UAV,
      CA35_160_UAV,
      X10_INTERCEPTOR_UAV,
    ]) {
      const flown = display(uav);
      assert(
        flown.lead.status === FLIGHT_STATUS.Flying,
        `a ${uav.config.name} leader flies the display`,
      );
      assert(
        flown.wing.status === FLIGHT_STATUS.Flying,
        "and the slot behind it stays with it",
      );
      assert(
        flown.worst < 160,
        `without ever losing the station altogether (worst ${flown.worst.toFixed(
          0,
        )} m)`,
      );
    }

    // A quadcopter held at full aileron does not roll, it flips, and a flip
    // held for the length of a display step arrives in the field.
    const simulation = arena(terrain, 8000);
    const rollPilot = new FormationLeadPilot({
      id: "lead",
      routine: [{ type: MANOEUVRE.Roll, seconds: 40, bankDeg: 360, climb: 0 }],
      terrain,
      terrainAvoidance: avoidance,
      missionRadius: 8000,
      speedReference: contactSpeedReference(CA35_160, PLAYER_WING),
    });
    const quad = simulation.spawn(
      {
        id: "lead",
        role: AIRCRAFT_ROLE.Lead,
        position: V.vec3(0, 0, 500),
        headingDeg: 0,
        ...launched(CA35_160_UAV, 25, 0.65),
      },
      rollPilot.control,
    );
    let steepest = 0;
    for (let i = 0; i < 60 * 40; i += 1) {
      simulation.update(1 / 60);
      if (quad.status !== FLIGHT_STATUS.Flying) break;
      steepest = Math.max(steepest, Math.abs(quad.position.z - 500));
    }
    assert(
      quad.status === FLIGHT_STATUS.Flying,
      "a quadcopter leader is not asked for an aileron roll, and survives the step",
    );
    assert(
      steepest < 300,
      `flying it as the leg it is instead (${steepest.toFixed(0)} m off height)`,
    );
  });

  await suite("a fly-in field flies what turned up", async () => {
    const terrain = await flatTerrain(3000);

    /** One aircraft round a 500 m field for three minutes. */
    const festival = (uav: (typeof UAVS)[number]) => {
      const simulation = arena(terrain, 500);
      const centre = V.vec3(0, 0, 0);
      const pilot = new FestivalPilot({
        id: "festival-1",
        centre,
        areaRadius: 500,
        floor: 35,
        ceiling: 275,
        terrain,
        seed: "OPPOSE-FEST",
        getTraffic: () => simulation.aircraft,
        speedReference: contactSpeedReference(uav.config, PLAYER_WING),
      });
      const flyer = simulation.spawn(
        {
          id: "festival-1",
          role: AIRCRAFT_ROLE.Festival,
          position: V.vec3(280, 0, 150),
          headingDeg: 0,
          ...launched(uav, 22, 0.6),
        },
        pilot.control,
      );
      let furthest = 0;
      let lowest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 180 * 60; i += 1) {
        simulation.update(1 / 60);
        if (flyer.status !== FLIGHT_STATUS.Flying) break;
        furthest = Math.max(
          furthest,
          Math.hypot(flyer.position.x, flyer.position.y),
        );
        lowest = Math.min(lowest, flyer.altitudeAgl);
      }
      return { flyer, furthest, lowest };
    };

    for (const uav of [
      SKYWALKER_X8_UAV,
      FOAM_GLIDER_UAV,
      CA35_160_UAV,
      X10_INTERCEPTOR_UAV,
    ]) {
      const flown = festival(uav);
      assert(
        flown.flyer.status === FLIGHT_STATUS.Flying,
        `a ${uav.config.name} is still flying the field three minutes in`,
      );
      assertBetween(
        flown.furthest,
        0,
        900,
        "and stayed over the field rather than leaving it",
      );
      assert(
        flown.lowest > 5,
        `and off the ground while it did (${flown.lowest.toFixed(0)} m)`,
      );
    }
  });

  await suite("flying the aeroplane it is actually in", async () => {
    const terrain = await flatTerrain(12000);
    const difficulty = DIFFICULTY_PROFILES[DIFFICULTY.Normal];

    /** One contact, on patrol, in whatever airframe it was given. */
    const patrol = async (uav: (typeof UAVS)[number]) => {
      const sim = new Simulation({
        frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
        terrain,
        missionRadius: 10000,
        groundClearance: 1.5,
      });
      const pilot = new EnemyController({
        id: "e",
        difficulty,
        route: generatePatrolRoute({
          seed: "OPPOSE",
          missionRadius: 8000,
          baseAltitude: 500,
          terrain,
        }),
        terrainAvoidance: new TerrainAvoidanceSystem(terrain),
        terrain,
        visibility: null,
        missionRadius: 10000,
        seed: "OPPOSE",
        aggressive: false,
        getTarget: () => null,
        speedReference: contactSpeedReference(uav.config, PLAYER_WING),
      });
      const rotor = uav.config.rotor !== undefined;
      const contact = sim.spawn(
        {
          id: "e",
          role: AIRCRAFT_ROLE.Enemy,
          config: uav.config,
          position: V.vec3(0, 0, 500),
          headingDeg: 0,
          airspeed: rotor ? 0 : 24,
          throttle: rotor ? hoverThrottle(uav.config) : difficulty.patrolThrottle,
        },
        pilot.control,
      );

      let travelled = 0;
      let lowest = Infinity;
      const start = { ...contact.position };
      for (let i = 0; i < 60 * 90; i += 1) {
        sim.update(1 / 60);
        if (contact.status !== FLIGHT_STATUS.Flying) break;
        lowest = Math.min(lowest, contact.altitudeAgl);
      }
      travelled = V.distance(start, contact.position);
      return { contact, pilot, travelled, lowest };
    };

    for (const uav of [
      SKYWALKER_X8_UAV,
      FOAM_GLIDER_UAV,
      CA35_160_UAV,
      X10_INTERCEPTOR_UAV,
    ]) {
      const flown = await patrol(uav);
      assert(
        flown.contact.status === FLIGHT_STATUS.Flying,
        `a ${uav.config.name} contact is still flying an hour and a half of minutes later`,
      );
      assert(
        flown.lowest > 20,
        `and never came near the ground doing it (${flown.lowest.toFixed(0)} m)`,
      );
      assert(
        flown.travelled > 200,
        `and went somewhere rather than sitting where it was put (${flown.travelled.toFixed(
          0,
        )} m)`,
      );
    }

    const survey = await patrol(SKYWALKER_X8_UAV);
    const interceptor = await patrol(INTERCEPTOR_WING);
    assert(
      survey.pilot.debug.speedLimit < interceptor.pilot.debug.speedLimit,
      `and a survey wing is flown slower than an interceptor is (${survey.pilot.debug.speedLimit.toFixed(
        1,
      )} against ${interceptor.pilot.debug.speedLimit.toFixed(1)} m/s)`,
    );
  });
}
