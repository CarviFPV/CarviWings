import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import type { AircraftState } from "../flight/state";
import { maxLevelSpeed } from "../flight/physics";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { MissionRunner } from "../mission/missionRunner";
import type { MissionEvent } from "../mission/missionRunner";
import type { MissionSettings } from "../mission/types";
import {
  DEFAULT_FORMATION,
  DEFAULT_VTX_POWER_MW,
  MAX_ENEMY_COUNT,
  MIN_ENEMY_COUNT,
  MISSION_MODE,
  MISSION_MODES,
  MISSION_MODE_INFO,
  MISSION_OUTCOME,
  SPARE_INTERCEPTORS,
  clampEnemyCount,
  interceptorsFor,
  isCombatMission,
} from "../mission/types";
import { DEFAULT_RACE } from "../mission/race";
import { DEFAULT_FESTIVAL } from "../mission/festival";
import { DEFAULT_OPPOSITION } from "../mission/opposition";
import {
  DEFAULT_STRIKE,
  MAX_STRIKE_ESCORTS,
  clampEscortCount,
} from "../mission/strike";
import { generateTransitRoute } from "../ai/patrol";
import { TerrainAvoidanceSystem } from "../ai/terrainAvoidance";
import { TRANSIT_SPEED_FACTOR_MAX, TransitPilot } from "../ai/transitPilot";
import { WEATHER, TIME_OF_DAY } from "../environment/types";
import { DIFFICULTY } from "../ai/types";
import { createFlightInput } from "../input/types";
import * as V from "../math/vec3";

const idle = createFlightInput();

function settings(overrides: Partial<MissionSettings> = {}): MissionSettings {
  return {
    mode: MISSION_MODE.Strike,
    locationName: "Test",
    latitude: 46.5375,
    longitude: 7.9625,
    missionRadius: 6000,
    spawnAltitudeAgl: 300,
    weather: WEATHER.Clear,
    timeOfDay: TIME_OF_DAY.Day,
    enemyCount: 4,
    difficulty: DIFFICULTY.Normal,
    combat: true,
    formation: DEFAULT_FORMATION,
    race: DEFAULT_RACE,
    festival: DEFAULT_FESTIVAL,
    strike: DEFAULT_STRIKE,
    opposition: DEFAULT_OPPOSITION,
    vtxPowerMw: DEFAULT_VTX_POWER_MW,
    seed: "STRIKESEED",
    ...overrides,
  };
}

async function flatTerrain(radius = 8000, height = 0): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => height),
    { cellSize: 250, warmRadius: 4000, sampleBudget: 40000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

/** One transiting contact over flat ground, flown by its own pilot. */
async function transitFlight(options: {
  readonly seed: string;
  readonly missionRadius: number;
  /** Dropped into the sky right in front of it, if given. */
  readonly intruder?: V.Vec3;
}): Promise<{
  simulation: Simulation;
  contact: AircraftState;
  pilot: TransitPilot;
  route: V.Vec3[];
}> {
  const terrain = await flatTerrain(options.missionRadius + 2000, 0);
  const simulation = new Simulation({
    frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 1000 }),
    terrain,
    missionRadius: options.missionRadius,
  });

  const route = generateTransitRoute({
    seed: options.seed,
    missionRadius: options.missionRadius,
    baseAltitude: 400,
    terrain,
  });
  const pilot = new TransitPilot({
    id: "transit-1",
    route,
    terrain,
    terrainAvoidance: new TerrainAvoidanceSystem(terrain),
    missionRadius: options.missionRadius,
    seed: options.seed,
    speedReference: maxLevelSpeed(PLAYER_WING),
  });

  const start = V.vec3(0, 0, 400);
  const contact = simulation.spawn(
    {
      id: "transit-1",
      role: AIRCRAFT_ROLE.Enemy,
      config: PLAYER_WING,
      position: start,
      headingDeg: TransitPilot.openingHeadingDeg(start, route),
      airspeed: 22,
      throttle: 0.55,
    },
    pilot.control,
  );

  if (options.intruder) {
    // An interceptor parked on its nose, flying straight and level. A pilot
    // with any perception at all would do something about this.
    simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: options.intruder,
        headingDeg: 180,
        airspeed: 25,
        throttle: 0.65,
      },
      () => idle,
    );
  }

  return { simulation, contact, pilot, route };
}

export async function runStrikeTests(): Promise<void> {
  suite("a strike is a mission of its own", () => {
    assert(
      MISSION_MODES.includes(MISSION_MODE.Strike),
      "the strike is on the mission list",
    );
    assert(
      MISSION_MODES.includes(MISSION_MODE.Intercept),
      "and it is offered alongside the interception rather than in place of it",
    );
    assert(
      MISSION_MODE_INFO[MISSION_MODE.Strike].label.length > 0 &&
        MISSION_MODE_INFO[MISSION_MODE.Strike].description.length > 0,
      "with a name and a description to offer it under",
    );
    assert(
      isCombatMission(MISSION_MODE.Strike) &&
        isCombatMission(MISSION_MODE.Intercept),
      "both combat missions are flown with a charge on the wing",
    );
    assert(
      !isCombatMission(MISSION_MODE.Race) &&
        !isCombatMission(MISSION_MODE.Festival) &&
        !isCombatMission(MISSION_MODE.FreeFlight),
      "and nothing else is",
    );
  });

  suite("counting contacts", () => {
    assertClose(
      clampEnemyCount(7),
      7,
      1e-9,
      "a contact count between the ends is flown as asked",
    );
    assertClose(
      clampEnemyCount(7.4),
      7,
      1e-9,
      "a slider that lands between two contacts picks one of them",
    );
    assertClose(
      clampEnemyCount(0),
      MIN_ENEMY_COUNT,
      1e-9,
      "and a mission is never flown against nobody",
    );
    assertClose(
      clampEnemyCount(500),
      MAX_ENEMY_COUNT,
      1e-9,
      "or against more than the sky holds",
    );
    assertClose(
      clampEscortCount(-3),
      0,
      1e-9,
      "an unescorted transit is unescorted",
    );
    assertClose(
      clampEscortCount(99),
      MAX_STRIKE_ESCORTS,
      1e-9,
      "and an escort is bounded the same way",
    );
  });

  suite("strike economics", () => {
    assertClose(
      interceptorsFor(settings({ enemyCount: 6 })),
      6 + SPARE_INTERCEPTORS,
      1e-9,
      "an unescorted strike costs one airframe per contact, plus the spares",
    );
    assertClose(
      interceptorsFor(settings({ enemyCount: 6, strike: { escortCount: 3 } })),
      9 + SPARE_INTERCEPTORS,
      1e-9,
      "and an escort has to be brought down too, so it is paid for as well",
    );
    assertClose(
      interceptorsFor(settings({ enemyCount: 6, strike: { escortCount: 99 } })),
      6 + MAX_STRIKE_ESCORTS + SPARE_INTERCEPTORS,
      1e-9,
      "an escort nobody could put in the air is not charged for either",
    );
  });

  suite("a strike is won by clearing the sky", () => {
    const runner = new MissionRunner(settings({ enemyCount: 2 }));
    runner.setEnemyCount(2);

    const contacts = [
      { role: AIRCRAFT_ROLE.Enemy, status: FLIGHT_STATUS.Flying },
      { role: AIRCRAFT_ROLE.Enemy, status: FLIGHT_STATUS.Flying },
    ] as unknown as AircraftState[];
    const player = {
      id: "player",
      role: AIRCRAFT_ROLE.Player,
      status: FLIGHT_STATUS.Flying,
    } as unknown as AircraftState;

    const simulation = {
      get enemyCount(): number {
        return contacts.filter(
          (state) => state.status === FLIGHT_STATUS.Flying,
        ).length;
      },
      statistics: { enemiesDestroyed: 0, collisions: 0 },
      player,
      aircraft: [player, ...contacts],
      playerContactCount: 0,
      playerKillCount: 0,
      videoLink: null,
      time: 0,
    } as unknown as Parameters<MissionRunner["update"]>[0];

    const events: MissionEvent[] = [];
    events.push(...runner.update(simulation, 1 / 60));
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "a transit still crossing the area is a mission still running",
    );

    (contacts[0] as AircraftState).status = FLIGHT_STATUS.Destroyed;
    events.push(...runner.update(simulation, 1 / 60));
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "one of two is not the sky cleared",
    );

    (contacts[1] as AircraftState).status = FLIGHT_STATUS.Crashed;
    events.push(...runner.update(simulation, 1 / 60));
    assert(
      runner.status.outcome === MISSION_OUTCOME.Complete,
      "and the last one ends it",
    );
    assert(
      events.some((event) => event.type === "COMPLETE"),
      "with the completion announced",
    );
  });

  suite("a programmed route crosses the area", () => {
    const radius = 6000;
    const route = generateTransitRoute({
      seed: "ROUTE",
      missionRadius: radius,
      baseAltitude: 400,
      legCount: 4,
    });

    assert(route.length === 4, "the route has the destinations it was asked for");
    assert(
      route.every((point) => Math.hypot(point.x, point.y) <= radius),
      "every destination is inside the mission area",
    );
    assert(
      route.every((point) => point.z > 0),
      "and above the ground",
    );

    // Each leg, the closing one included, is a crossing rather than a corner.
    let shortest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < route.length; i += 1) {
      const from = route[i] as V.Vec3;
      const to = route[(i + 1) % route.length] as V.Vec3;
      shortest = Math.min(shortest, Math.hypot(to.x - from.x, to.y - from.y));
    }
    assert(
      shortest > radius,
      `and every leg is a run across the area (${shortest.toFixed(0)} m shortest)`,
    );

    const again = generateTransitRoute({
      seed: "ROUTE",
      missionRadius: radius,
      baseAltitude: 400,
      legCount: 4,
    });
    assert(
      again.every(
        (point, i) => V.distance(point, route[i] as V.Vec3) < 1e-9,
      ),
      "the same seed lays out the same route",
    );
  });

  await suite("a transiting contact flies its route", async () => {
    // A small area on purpose: the legs are crossings of it, so a route laid
    // out over ten kilometres takes longer to fly than a test wants to sit
    // through. Nothing about the pilot changes with the size of the area.
    const radius = 2500;
    const flight = await transitFlight({ seed: "TRANSIT", missionRadius: radius });

    let furthest = 0;
    let lowest = Number.POSITIVE_INFINITY;
    let fastest = 0;
    for (let i = 0; i < 480 * 60; i += 1) {
      flight.simulation.update(1 / 60);
      if (flight.contact.status !== FLIGHT_STATUS.Flying) break;
      furthest = Math.max(
        furthest,
        Math.hypot(flight.contact.position.x, flight.contact.position.y),
      );
      lowest = Math.min(lowest, flight.contact.altitudeAgl);
      fastest = Math.max(fastest, flight.contact.airspeed);
    }

    assert(
      flight.contact.status === FLIGHT_STATUS.Flying,
      `eight minutes later it is still flying (${flight.contact.status})`,
    );
    assert(
      lowest > 20,
      `without putting itself into the ground (${lowest.toFixed(0)} m AGL)`,
    );
    assert(
      furthest < radius * 1.2,
      `and without leaving the area (${furthest.toFixed(0)} m out)`,
    );
    assert(
      flight.pilot.debug.legsFlown >= 2,
      `having reached its destinations and gone on to the next (${flight.pilot.debug.legsFlown} legs)`,
    );
    // The whole reason a transit can be intercepted at all: it cruises, and
    // the aircraft chasing it does not have to. Measured on the speed the
    // pilot actually flies rather than on the highest number the eight minutes
    // contained — a contact descending onto its next destination trades height
    // for speed exactly as the player's wing does, and no cruise setting caps
    // that. What it must never do is *hold* a speed the player cannot beat.
    assert(
      flight.pilot.debug.speed <=
        maxLevelSpeed(PLAYER_WING) * TRANSIT_SPEED_FACTOR_MAX + 1e-6,
      `at a cruise inside the band (${flight.pilot.debug.speed.toFixed(
        1,
      )} m/s against ${maxLevelSpeed(PLAYER_WING).toFixed(1)})`,
    );
    assert(
      fastest < maxLevelSpeed(PLAYER_WING),
      `never even touching the player's top speed (${fastest.toFixed(
        1,
      )} m/s against ${maxLevelSpeed(PLAYER_WING).toFixed(1)})`,
    );
  });

  await suite("a transiting contact never notices the interceptor", async () => {
    // The same contact, the same seed, the same route — flown once alone and
    // once with an aircraft sitting a couple of hundred metres off its nose.
    // An enemy would turn, run, or at least look. This has no perception at
    // all, so the two tracks have to be the identical track.
    const radius = 6000;
    const alone = await transitFlight({ seed: "IGNORE", missionRadius: radius });
    const watched = await transitFlight({
      seed: "IGNORE",
      missionRadius: radius,
      intruder: V.vec3(0, 260, 420),
    });

    let drift = 0;
    for (let i = 0; i < 90 * 60; i += 1) {
      alone.simulation.update(1 / 60);
      watched.simulation.update(1 / 60);
      drift = Math.max(
        drift,
        V.distance(alone.contact.position, watched.contact.position),
      );
    }

    assert(
      drift < 1e-6,
      `it flies the identical route with an interceptor on its nose (${drift.toExponential(1)} m apart)`,
    );
    assert(
      alone.contact.status === FLIGHT_STATUS.Flying,
      "and is still flying it at the end of it",
    );
    assertBetween(
      watched.pilot.debug.waypoint,
      1,
      watched.route.length,
      "somewhere along a route it was given before anybody took off",
    );
  });
}
