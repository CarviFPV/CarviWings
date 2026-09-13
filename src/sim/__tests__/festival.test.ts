import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import type { AircraftState } from "../flight/state";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { CollisionWorld, initRapier } from "../physics/collisionWorld";
import { MissionRunner } from "../mission/missionRunner";
import type { MissionEvent } from "../mission/missionRunner";
import type { MissionSettings } from "../mission/types";
import {
  DEFAULT_FORMATION,
  DEFAULT_VTX_POWER_MW,
  MISSION_MODE,
  MISSION_MODES,
  MISSION_MODE_INFO,
  MISSION_OUTCOME,
  interceptorsFor,
} from "../mission/types";
import { DEFAULT_RACE } from "../mission/race";
import {
  DEFAULT_FESTIVAL,
  FESTIVAL_ROUND_SECONDS,
  FESTIVAL_SLOT_STEP_SECONDS,
  FESTIVAL_SLOT_UNLIMITED_POSITION,
  FESTIVAL_UNLIMITED,
  FESTIVAL_WRECK_SECONDS,
  FestivalTracker,
  MAX_FESTIVAL_AIRCRAFT,
  MAX_FESTIVAL_SLOT_SECONDS,
  MIN_FESTIVAL_AIRCRAFT,
  MIN_FESTIVAL_SLOT_SECONDS,
  clampFestivalAircraft,
  clampFestivalSlot,
  festivalSlotFromPosition,
  festivalLossSummary,
  festivalSlotPosition,
  festivalSummary,
  formatFestivalArea,
  formatFestivalSlot,
} from "../mission/festival";
import { DEFAULT_STRIKE } from "../mission/strike";
import { DEFAULT_OPPOSITION } from "../mission/opposition";
import {
  FestivalPilot,
  festivalSpawnHeading,
  festivalSpawnPoint,
} from "../ai/festivalPilot";
import { WEATHER, TIME_OF_DAY } from "../environment/types";
import { DIFFICULTY } from "../ai/types";
import { createFlightInput } from "../input/types";
import * as V from "../math/vec3";

const idle = createFlightInput();

function settings(overrides: Partial<MissionSettings> = {}): MissionSettings {
  return {
    mode: MISSION_MODE.Festival,
    locationName: "Test",
    latitude: 46.5375,
    longitude: 7.9625,
    missionRadius: 500,
    spawnAltitudeAgl: 120,
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
    seed: "FESTSEED",
    ...overrides,
  };
}

async function flatTerrain(radius = 3000, height = -500): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => height),
    { cellSize: 100, warmRadius: 2000, sampleBudget: 40000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

async function buildSimulation(groundHeight = -500): Promise<Simulation> {
  const rapier = await initRapier();
  return new Simulation({
    frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
    terrain: await flatTerrain(3000, groundHeight),
    missionRadius: 500,
    collision: new CollisionWorld(rapier),
    contactDamage: true,
    trackedRole: AIRCRAFT_ROLE.Festival,
  });
}

function spawnPlayer(simulation: Simulation): AircraftState {
  return simulation.spawn(
    {
      id: "player",
      role: AIRCRAFT_ROLE.Player,
      config: PLAYER_WING,
      position: V.vec3(0, 0, 200),
      headingDeg: 0,
      airspeed: 25,
      throttle: 0.65,
    },
    () => idle,
  );
}

function spawnFlyer(
  simulation: Simulation,
  id: string,
  position: V.Vec3,
): AircraftState {
  return simulation.spawn(
    {
      id,
      role: AIRCRAFT_ROLE.Festival,
      config: PLAYER_WING,
      position,
      headingDeg: 0,
      airspeed: 22,
      throttle: 0.6,
    },
    () => idle,
  );
}

export async function runFestivalTests(): Promise<void> {
  suite("the mission list", () => {
    assert(
      MISSION_MODES.includes(MISSION_MODE.Festival),
      "a festival is one of the missions on the menu",
    );
    assert(
      !(MISSION_MODES as readonly string[]).includes(MISSION_MODE.FreeFlight),
      "and free flight is not, because it is not a mission",
    );
    assert(
      MISSION_MODES.every(
        (mode) => MISSION_MODE_INFO[mode].label.length > 0,
      ) && MISSION_MODE_INFO[MISSION_MODE.FreeFlight].label.length > 0,
      "every mode the menu can offer has a name to offer it under",
    );
  });

  suite("festival economics", () => {
    assert(
      !Number.isFinite(interceptorsFor(settings())),
      "nobody at a fly-in counts airframes",
    );
    assert(
      formatFestivalArea(200) === "200 m" && formatFestivalArea(1500) === "1.5 km",
      "and the field is written the way it is read out",
    );
  });

  suite("asking for a field and a slot", () => {
    assert(
      clampFestivalAircraft(0) === MIN_FESTIVAL_AIRCRAFT &&
        clampFestivalAircraft(999) === MAX_FESTIVAL_AIRCRAFT &&
        clampFestivalAircraft(7.4) === 7,
      "a field is a whole number of aircraft between one and the cap",
    );
    assert(
      clampFestivalSlot(0) === MIN_FESTIVAL_SLOT_SECONDS &&
        clampFestivalSlot(99999) === MAX_FESTIVAL_SLOT_SECONDS &&
        clampFestivalSlot(190) === 180,
      "and a slot is whole minutes between one and the longest one there is",
    );
    assert(
      MIN_FESTIVAL_SLOT_SECONDS === 60 && DEFAULT_FESTIVAL.durationSeconds === 180,
      "the shortest slot is a minute and the one offered first is three",
    );
    assert(
      festivalSlotFromPosition(FESTIVAL_SLOT_UNLIMITED_POSITION) ===
        FESTIVAL_UNLIMITED &&
        festivalSlotPosition(FESTIVAL_UNLIMITED) ===
          FESTIVAL_SLOT_UNLIMITED_POSITION,
      "the endless day sits at the top of the slider and comes back as unlimited",
    );
    assert(
      FESTIVAL_SLOT_UNLIMITED_POSITION ===
        MAX_FESTIVAL_SLOT_SECONDS + FESTIVAL_SLOT_STEP_SECONDS &&
        festivalSlotFromPosition(MAX_FESTIVAL_SLOT_SECONDS) ===
          MAX_FESTIVAL_SLOT_SECONDS,
      "one step below it is the longest slot that ends",
    );
    assert(
      festivalSlotPosition(festivalSlotFromPosition(600)) === 600,
      "and a slot picked off the slider reads back to the same position",
    );
    assert(
      formatFestivalSlot(FESTIVAL_UNLIMITED) === "Unlimited" &&
        formatFestivalSlot(180) === "3 min",
      "the slot is written the way it is read out",
    );
  });

  suite("counting the field", () => {
    const tracker = new FestivalTracker({
      areaRadius: 500,
      aircraftCount: 3,
      durationSeconds: 60,
    });
    assert(
      !tracker.fieldClear,
      "a field that has not been launched yet does not read as cleared",
    );

    const field = [
      { role: AIRCRAFT_ROLE.Player, status: FLIGHT_STATUS.Flying },
      { role: AIRCRAFT_ROLE.Festival, status: FLIGHT_STATUS.Flying },
      { role: AIRCRAFT_ROLE.Festival, status: FLIGHT_STATUS.Flying },
      { role: AIRCRAFT_ROLE.Festival, status: FLIGHT_STATUS.Flying },
    ] as unknown as AircraftState[];

    tracker.update(field, 1);
    assertClose(tracker.progress.flying, 4, 1e-9, "four aircraft are up");
    assertClose(tracker.progress.down, 0, 1e-9, "and none of them are down");
    assert(!tracker.fieldClear, "so the field is not clear");

    // One of them is hit and is on its way down: still in the air, so still in
    // the way of anybody who wanted to launch.
    (field[1] as AircraftState).status = FLIGHT_STATUS.Disabled;
    tracker.update(field, 1);
    assert(
      !tracker.fieldClear,
      "a wreck still falling keeps the field closed",
    );
    assertClose(tracker.progress.flying, 3, 1e-9, "and it is out of the flying count");

    (field[1] as AircraftState).status = FLIGHT_STATUS.Crashed;
    (field[2] as AircraftState).status = FLIGHT_STATUS.Crashed;
    tracker.update(field, 1);
    assert(!tracker.fieldClear, "one still up is still one too many");

    (field[3] as AircraftState).status = FLIGHT_STATUS.Landed;
    tracker.update(field, 1);
    assert(
      tracker.fieldClear,
      "and once everybody has reached the ground the field is clear",
    );
    assert(
      tracker.progress.playerFlying,
      "even with the player still in the air, because they are not the field",
    );
  });

  suite("the slot clock", () => {
    const limited = new FestivalTracker({
      areaRadius: 500,
      aircraftCount: 4,
      durationSeconds: 30,
    });
    limited.update([], 29);
    assert(!limited.finished, "a slot that has not run out has not run out");
    assertClose(limited.remaining, 1, 1e-6, "with a second left on it");
    limited.update([], 2);
    assert(limited.finished, "and it ends when the clock does");

    const unlimited = new FestivalTracker({
      areaRadius: 500,
      aircraftCount: 4,
      durationSeconds: FESTIVAL_UNLIMITED,
    });
    unlimited.update([], 100000);
    assert(unlimited.unlimited, "an unlimited slot says so");
    assert(!unlimited.finished, "and never ends on its own");
    assert(
      !Number.isFinite(unlimited.remaining),
      "with nothing left to count down",
    );
  });

  suite("waves and rounds", () => {
    const tracker = new FestivalTracker({
      areaRadius: 500,
      aircraftCount: 2,
      durationSeconds: FESTIVAL_UNLIMITED,
    });
    assertClose(tracker.wave, 1, 1e-9, "the first wave is the first wave");
    assert(!tracker.recalled, "and the line has not been called down yet");

    tracker.update([], FESTIVAL_ROUND_SECONDS - 1);
    assert(!tracker.recalled, "a round that is still running is still running");
    tracker.update([], 2);
    assert(
      tracker.recalled,
      "and at the end of it the line is called down on its own",
    );

    tracker.startWave(3);
    assertClose(tracker.wave, 2, 1e-9, "launching another one counts it");
    assert(!tracker.recalled, "with a fresh round in front of it");
    assertClose(
      tracker.roundRemaining,
      FESTIVAL_ROUND_SECONDS,
      1e-6,
      "and the whole of that round to fly",
    );
    assert(
      !tracker.fieldClear,
      "and a wave that has just gone up is not a cleared field",
    );
    assert(
      festivalSummary(tracker.progress).includes("2 waves"),
      `the debrief says how many were flown (${festivalSummary(tracker.progress)})`,
    );
  });

  suite("a day called on the pilot's own wing", () => {
    const tracker = new FestivalTracker({
      areaRadius: 500,
      aircraftCount: 2,
      durationSeconds: FESTIVAL_UNLIMITED,
    });
    tracker.update([], 30);

    const clean = festivalLossSummary(
      tracker.progress,
      "Airframe lost to terrain.",
    );
    assert(
      clean.startsWith("Airframe lost to terrain."),
      `the debrief leads with what ended it (${clean})`,
    );
    assert(
      clean.includes("1 wave"),
      `and says how much of the day was behind it (${clean})`,
    );
    assert(
      !clean.includes("mid-air"),
      "without a tally of mid-airs that never happened",
    );

    tracker.recordContacts(3, 2);
    const touched = festivalLossSummary(
      tracker.progress,
      "Airframe crippled in a mid-air collision and went in.",
    );
    assert(
      touched.includes("2 mid-airs of your own"),
      `and counts the pilot's own when there were some (${touched})`,
    );
    assertBetween(
      FESTIVAL_WRECK_SECONDS,
      0.5,
      5,
      "and the wreck lies there for a couple of seconds, not the afternoon",
    );
  });

  await suite("a wing in the field ends the day", async () => {
    const simulation = await buildSimulation();
    const runner = new MissionRunner(
      settings({
        festival: {
          areaRadius: 500,
          aircraftCount: 2,
          durationSeconds: FESTIVAL_UNLIMITED,
        },
      }),
    );
    assert(runner.festival !== null, "a festival mission builds a tracker");

    const player = spawnPlayer(simulation);
    spawnFlyer(simulation, "festival-1", V.vec3(400, 0, 220));
    spawnFlyer(simulation, "festival-2", V.vec3(-400, 0, 260));

    const events: MissionEvent[] = [];
    const step = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds * 60); i += 1) {
        events.push(...runner.update(simulation, 1 / 60));
      }
    };

    step(1);
    assert(
      runner.status.festival !== undefined,
      "and reports the field on the mission status",
    );
    assertClose(
      runner.status.festival?.flying ?? 0,
      3,
      1e-9,
      "with everybody in the air",
    );

    // The pilot goes in while the other two are still flying.
    player.status = FLIGHT_STATUS.Crashed;
    step(FESTIVAL_WRECK_SECONDS - 0.5);
    assert(
      events.some((event) => event.type === "AIRFRAME_LOST"),
      "losing the airframe is reported",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and the wreck is given its seconds on the grass before anything is decided",
    );
    assert(
      runner.status.festival?.playerFlying === false,
      "with the OSD knowing the pilot is on the ground",
    );

    step(1);
    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed,
      "and then the day is over, rather than the rest of the slot being watched out",
    );
    assert(
      events.some((event) => event.type === "FAILED"),
      "which is announced, so another slot can be offered",
    );
    assert(
      runner.status.reason.includes("That is the day"),
      `with the day summed up on the wing that ended it (${runner.status.reason})`,
    );
    assert(
      !events.some((event) => event.type === "RELAUNCH"),
      "and nothing put back in the air, because there is nothing left to fly",
    );
    assertClose(
      events.filter((event) => event.type === "AIRFRAME_LOST").length,
      1,
      1e-9,
      "one crash costing one airframe, not one a frame",
    );

    step(10);
    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed,
      "and it stays over",
    );
    assertClose(
      events.filter((event) => event.type === "FAILED").length,
      1,
      1e-9,
      "said once",
    );
  });

  await suite("the field still goes again when the sky is empty", async () => {
    // The other half of the rule, which the pilot's own crash does not touch:
    // somebody else's wreck holds the whole field on the ground until the sky
    // is empty, and then the next wave goes.
    const simulation = await buildSimulation();
    const runner = new MissionRunner(
      settings({
        festival: {
          areaRadius: 500,
          aircraftCount: 2,
          durationSeconds: FESTIVAL_UNLIMITED,
        },
      }),
    );

    spawnPlayer(simulation);
    const one = spawnFlyer(simulation, "festival-1", V.vec3(400, 0, 220));
    const two = spawnFlyer(simulation, "festival-2", V.vec3(-400, 0, 260));

    const events: MissionEvent[] = [];
    const step = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds * 60); i += 1) {
        events.push(...runner.update(simulation, 1 / 60));
      }
    };

    step(1);
    one.status = FLIGHT_STATUS.Crashed;
    step(1);
    assert(
      !events.some((event) => event.type === "FESTIVAL_WAVE"),
      "one aircraft still up holds the wreckage where it lies",
    );

    two.status = FLIGHT_STATUS.Crashed;
    step(1);
    assert(
      events.some((event) => event.type === "FESTIVAL_WAVE"),
      "an empty sky calls for the next wave",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and the day goes on around it, because the pilot is still flying",
    );

    // Five minutes of it, which is a round: the line is called down on its own
    // so the wave that is up can be replaced by the next one.
    step(FESTIVAL_ROUND_SECONDS);
    assert(
      events.some((event) => event.type === "FESTIVAL_RECALL"),
      "and at the end of a round the line is called down",
    );
  });

  await suite("the slot ends the day", async () => {
    const simulation = await buildSimulation();
    const runner = new MissionRunner(
      settings({
        festival: { areaRadius: 500, aircraftCount: 1, durationSeconds: 20 },
      }),
    );
    spawnPlayer(simulation);
    spawnFlyer(simulation, "festival-1", V.vec3(300, 0, 220));

    const events: MissionEvent[] = [];
    for (let i = 0; i < 25 * 60; i += 1) {
      simulation.update(1 / 60);
      events.push(...runner.update(simulation, 1 / 60));
    }
    assert(
      runner.status.outcome === MISSION_OUTCOME.Complete,
      "flying the slot out completes the mission",
    );
    assert(
      events.some((event) => event.type === "COMPLETE"),
      "and it is announced",
    );
    assert(
      runner.status.reason.includes("wave"),
      `with the day summed up (${runner.status.reason})`,
    );
  });

  await suite("a festival mid-air costs what it was worth", async () => {
    // Two people flying their own line over one field, meeting at a closing
    // speed a fly-in actually produces. Nobody is armed, so what happens is
    // whatever the impact was worth — and the day carries on around it.
    const simulation = await buildSimulation(-500);
    const runner = new MissionRunner(
      settings({
        festival: {
          areaRadius: 500,
          aircraftCount: 2,
          durationSeconds: FESTIVAL_UNLIMITED,
        },
      }),
    );

    const cruise = { pitch: 0, roll: 0, yaw: 0, throttle: 0.65 };
    const player = simulation.spawn(
      {
        id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
        position: V.vec3(0, 0, 200), headingDeg: 0, airspeed: 26, throttle: 0.65,
      },
      () => cruise,
    );
    simulation.spawn(
      {
        id: "festival-1", role: AIRCRAFT_ROLE.Festival, config: PLAYER_WING,
        position: V.vec3(0, 260, 200), headingDeg: 180, airspeed: 26, throttle: 0.65,
      },
      () => cruise,
    );
    // A third aircraft well out of the way, so the field is never empty and
    // the wave rule cannot quietly reset the collision under test.
    spawnFlyer(simulation, "festival-2", V.vec3(-450, -450, 260));

    const events: MissionEvent[] = [];
    for (let i = 0; i < 30 * 60 && simulation.statistics.collisions === 0; i += 1) {
      simulation.update(1 / 60);
      events.push(...runner.update(simulation, 1 / 60));
    }
    assert(simulation.statistics.collisions > 0, "the two aircraft meet");
    assert(
      player.status !== FLIGHT_STATUS.Destroyed,
      "and nothing explodes, because nobody is carrying anything",
    );
    assert(
      player.damage.hits > 0,
      "the contact is on the airframe",
    );
    assertBetween(
      runner.status.festival?.midairs ?? 0,
      1,
      4,
      "and the day's tally has it",
    );
    assertClose(
      runner.status.festival?.playerMidairs ?? 0,
      1,
      1e-9,
      "as one of the pilot's own",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "a mid-air does not end a fly-in",
    );
  });

  suite("a wave is spread out before it is flown", () => {
    const centre = V.vec3(0, 0, 100);
    const points = [0, 1, 2, 3, 4, 5].map((index) =>
      festivalSpawnPoint(V.vec3(), index, 6, centre, 500, 40, 200),
    );

    assert(
      points.every((point) => Math.hypot(point.x, point.y) <= 500),
      "every aircraft of a wave starts inside the field",
    );
    assert(
      points.every((point) => point.z >= 140 && point.z <= 300),
      "and inside the band of sky over it",
    );
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        closest = Math.min(
          closest,
          V.distance(points[i] as V.Vec3, points[j] as V.Vec3),
        );
      }
    }
    assert(
      closest > 60,
      `with room between them at the moment of launch (${closest.toFixed(0)} m)`,
    );
    assertBetween(
      festivalSpawnHeading(1, 6),
      0,
      360,
      "and a heading round the field rather than across it",
    );
  });

  await suite("a festival aircraft flies the field", async () => {
    const terrain = await flatTerrain(3000, 0);
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 500 }),
      terrain,
      missionRadius: 500,
    });

    const centre = V.vec3(0, 0, 0);
    const pilot = new FestivalPilot({
      id: "festival-1",
      centre,
      areaRadius: 500,
      floor: 35,
      ceiling: 275,
      terrain,
      seed: "FESTSEED",
      getTraffic: () => simulation.aircraft,
    });

    const flyer = simulation.spawn(
      {
        id: "festival-1",
        role: AIRCRAFT_ROLE.Festival,
        config: PLAYER_WING,
        position: V.vec3(280, 0, 150),
        headingDeg: 0,
        airspeed: 22,
        throttle: 0.6,
      },
      pilot.control,
    );

    let furthest = 0;
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 180 * 60; i += 1) {
      simulation.update(1 / 60);
      if (flyer.status !== FLIGHT_STATUS.Flying) break;
      furthest = Math.max(furthest, Math.hypot(flyer.position.x, flyer.position.y));
      lowest = Math.min(lowest, flyer.altitudeAgl);
    }

    assert(
      flyer.status === FLIGHT_STATUS.Flying,
      `three minutes later it is still flying (${flyer.status})`,
    );
    assert(
      furthest < 500 * 1.35,
      `and it never left the field (${furthest.toFixed(0)} m out)`,
    );
    assert(
      lowest > 5,
      `without putting itself into the ground (${lowest.toFixed(0)} m AGL)`,
    );
  });

  await suite("a crowded field puts itself down", async () => {
    // The point of the whole mission: aircraft flown round one small piece of
    // sky by people who are not really looking do, on their own, hit each
    // other. This is the busiest setting the setup screen offers, over the
    // smallest field — nothing here is scripted, and nobody is aimed at
    // anybody.
    const field = await festivalField("CROWDED", 25, 200, 110);

    // Ten minutes of it, stopping the moment the point is made. How long a
    // field takes to produce its first mid-air is a matter of who was pointing
    // where when the wave went up — across seeds it runs from a few seconds to
    // several minutes — so the window is long enough that the test measures
    // whether the field does it at all rather than how quickly this one seed
    // got round to it.
    for (let i = 0; i < 600 * 60; i += 1) {
      field.simulation.update(1 / 60);
      if (field.simulation.statistics.collisions >= 2) break;
    }

    const collisions = field.simulation.statistics.collisions;
    assert(
      collisions >= 2,
      `a crowded field produces mid-airs on its own (${collisions} of them)`,
    );

    const marked = field.simulation.aircraft.filter(
      (state) => state.damage.hits > 0,
    );
    assert(
      marked.length > 0,
      `with aircraft carrying the marks of them (${marked.length})`,
    );
    assert(
      field.simulation.aircraft.some(
        (state) => state.status === FLIGHT_STATUS.Flying,
      ),
      "and the day goes on around it",
    );
  });

  await suite("a recalled line lands itself", async () => {
    // The other half of the rule: the wave that is up has to be able to get
    // itself down, or the field would never clear and nobody waiting on it
    // would ever fly again.
    const field = await festivalField("RECALL", 15, 500, 275);
    for (let i = 0; i < 60 * 60; i += 1) field.simulation.update(1 / 60);

    for (const pilot of field.pilots) pilot.recall();

    let seconds = 0;
    for (let i = 0; i < 240 * 60; i += 1) {
      field.simulation.update(1 / 60);
      seconds = i / 60;
      if (field.simulation.aircraft.every((state) => !stillAloft(state))) break;
    }

    assert(
      field.simulation.aircraft.every((state) => !stillAloft(state)),
      `the whole field is on the ground (after ${seconds.toFixed(0)} s)`,
    );
    const landed = field.simulation.aircraft.filter(
      (state) =>
        state.status === FLIGHT_STATUS.Landed ||
        state.status === FLIGHT_STATUS.Sliding,
    ).length;
    assert(
      landed > field.simulation.aircraft.length / 2,
      `and most of it was landed rather than crashed (${landed} of ${field.simulation.aircraft.length})`,
    );
  });
}

/** True while an aircraft is still part of what is in the air. */
function stillAloft(state: AircraftState): boolean {
  return (
    state.status === FLIGHT_STATUS.Flying ||
    state.status === FLIGHT_STATUS.Disabled ||
    state.status === FLIGHT_STATUS.Crashing
  );
}

/** A field of festival aircraft over flat ground, flown by their own pilots. */
async function festivalField(
  seed: string,
  count: number,
  areaRadius: number,
  ceiling: number,
): Promise<{ simulation: Simulation; pilots: FestivalPilot[] }> {
  const rapier = await initRapier();
  const terrain = await flatTerrain(2500, 0);
  const simulation = new Simulation({
    frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 500 }),
    terrain,
    missionRadius: areaRadius,
    collision: new CollisionWorld(rapier),
    contactDamage: true,
  });

  const centre = V.vec3(0, 0, 0);
  const floor = 35;
  const pilots: FestivalPilot[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `festival-${i + 1}`;
    const pilot = new FestivalPilot({
      id,
      centre,
      areaRadius,
      floor,
      ceiling,
      terrain,
      seed,
      getTraffic: () => simulation.aircraft,
    });
    pilots.push(pilot);
    simulation.spawn(
      {
        id,
        role: AIRCRAFT_ROLE.Festival,
        config: PLAYER_WING,
        position: festivalSpawnPoint(
          V.vec3(),
          i,
          count,
          centre,
          areaRadius,
          floor,
          ceiling,
        ),
        headingDeg: festivalSpawnHeading(i, count),
        airspeed: 22,
        throttle: 0.6,
      },
      pilot.control,
    );
  }

  return { simulation, pilots };
}
