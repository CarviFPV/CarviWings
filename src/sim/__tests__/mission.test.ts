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
  OPEN_MODES,
  SPARE_INTERCEPTORS,
  interceptorsFor,
  isOpenFlight,
  startsOnTheGround,
} from "../mission/types";
import { DEFAULT_RACE } from "../mission/race";
import { DEFAULT_FESTIVAL } from "../mission/festival";
import { DEFAULT_STRIKE } from "../mission/strike";
import { DEFAULT_OPPOSITION } from "../mission/opposition";
import { WEATHER } from "../environment/types";
import { TIME_OF_DAY } from "../environment/types";
import { DIFFICULTY } from "../ai/types";
import { generateSpawnPoints } from "../ai/patrol";
import { FORMATION_SLOT, FORMATION_SLOTS, formationStation } from "../ai/formation";
import {
  ABANDON_RANGE,
  ABANDON_SECONDS,
  PASS_FRACTION,
  STATION_TOLERANCE,
  formationGrade,
} from "../mission/formation";
import { createFlightInput } from "../input/types";
import type { FlightInput } from "../input/types";
import * as V from "../math/vec3";

function settings(overrides: Partial<MissionSettings> = {}): MissionSettings {
  return {
    mode: MISSION_MODE.Intercept,
    locationName: "Test",
    latitude: 46.5375,
    longitude: 7.9625,
    missionRadius: 10000,
    spawnAltitudeAgl: 300,
    weather: WEATHER.Clear,
    timeOfDay: TIME_OF_DAY.Day,
    enemyCount: 3,
    difficulty: DIFFICULTY.Normal,
    combat: true,
    formation: DEFAULT_FORMATION,
    race: DEFAULT_RACE,
    festival: DEFAULT_FESTIVAL,
    strike: DEFAULT_STRIKE,
    opposition: DEFAULT_OPPOSITION,
    vtxPowerMw: DEFAULT_VTX_POWER_MW,
    seed: "TESTSEED",
    ...overrides,
  };
}

async function flatTerrain(radius = 6000, height = -500): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => height),
    { cellSize: 250, warmRadius: 3000, sampleBudget: 20000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

async function buildSimulation(
  damage = true,
  groundHeight = -500,
): Promise<Simulation> {
  const rapier = await initRapier();
  return new Simulation({
    frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
    terrain: await flatTerrain(6000, groundHeight),
    missionRadius: 10000,
    collision: new CollisionWorld(rapier),
    contactDamage: damage,
  });
}

const idle = createFlightInput();
/** Level flight with the motor running, for aircraft that have to fly a while. */
const cruise: FlightInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.65 };

function spawnPlayer(simulation: Simulation): AircraftState {
  return simulation.spawn(
    {
      id: "player",
      role: AIRCRAFT_ROLE.Player,
      config: PLAYER_WING,
      position: V.vec3(0, 0, 500),
      headingDeg: 0,
      airspeed: 25,
      throttle: 0.7,
    },
    () => idle,
  );
}

function spawnEnemy(simulation: Simulation, id: string, x: number): AircraftState {
  return simulation.spawn(
    {
      id,
      role: AIRCRAFT_ROLE.Enemy,
      config: PLAYER_WING,
      position: V.vec3(x, 1500, 500),
      headingDeg: 180,
      airspeed: 24,
      throttle: 0.6,
    },
    () => idle,
  );
}

function spawnLead(simulation: Simulation, position: V.Vec3): AircraftState {
  return simulation.spawn(
    {
      id: "lead",
      role: AIRCRAFT_ROLE.Lead,
      config: PLAYER_WING,
      position,
      headingDeg: 0,
      airspeed: 26,
      throttle: 0.6,
    },
    () => idle,
  );
}

function spawnPlayerAt(simulation: Simulation, position: V.Vec3): AircraftState {
  return simulation.spawn(
    {
      id: "player",
      role: AIRCRAFT_ROLE.Player,
      config: PLAYER_WING,
      position,
      headingDeg: 0,
      airspeed: 26,
      throttle: 0.65,
    },
    () => idle,
  );
}

/** Runs the mission for a while, applying relaunches the way the session does. */
function run(
  runner: MissionRunner,
  simulation: Simulation,
  seconds: number,
  onRelaunch: () => void,
): MissionEvent[] {
  const collected: MissionEvent[] = [];
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i += 1) {
    simulation.update(1 / 60);
    for (const event of runner.update(simulation, 1 / 60)) {
      collected.push(event);
      if (event.type === "RELAUNCH") onRelaunch();
    }
  }
  return collected;
}

export async function runMissionTests(): Promise<void> {
  suite("mission economics", () => {
    assertClose(
      interceptorsFor(settings({ enemyCount: 10 })),
      10 + SPARE_INTERCEPTORS,
      1e-9,
      "an intercept mission launches with one airframe per contact plus spares",
    );
    assertClose(
      interceptorsFor(settings({ mode: MISSION_MODE.FreeFlight })),
      1,
      1e-9,
      "free flight has exactly one",
    );
    assertClose(
      interceptorsFor(settings({ mode: MISSION_MODE.Formation, enemyCount: 9 })),
      1 + SPARE_INTERCEPTORS,
      1e-9,
      "a formation flight has its own reserve, whatever the enemy count says",
    );
    assertClose(
      interceptorsFor(settings({ mode: MISSION_MODE.GroundView, enemyCount: 9 })),
      1,
      1e-9,
      "and so does the aircraft you carried onto the field yourself",
    );
  });

  suite("going flying is not a mission", () => {
    assert(
      isOpenFlight(MISSION_MODE.FreeFlight) &&
        isOpenFlight(MISSION_MODE.GroundView),
      "free flight and the ground view are both just going flying",
    );
    assert(
      !isOpenFlight(MISSION_MODE.Intercept) && !isOpenFlight(MISSION_MODE.Race),
      "and everything with a point to it is not",
    );
    assert(
      OPEN_MODES.every(
        (mode) => !(MISSION_MODES as readonly string[]).includes(mode),
      ),
      "so neither of them is offered on the mission list",
    );
    assert(
      OPEN_MODES.every(
        (mode) =>
          MISSION_MODE_INFO[mode].label.length > 0 &&
          MISSION_MODE_INFO[mode].description.length > 0,
      ),
      "both are described well enough to put on a menu",
    );
    assert(
      startsOnTheGround(MISSION_MODE.GroundView),
      "the ground view is the one flight that starts on the ground",
    );
    assert(
      !startsOnTheGround(MISSION_MODE.FreeFlight) &&
        MISSION_MODES.every((mode) => !startsOnTheGround(mode)),
      "and every other flight is handed an aircraft that is already up",
    );
  });

  suite("deterministic placement", () => {
    const options = {
      seed: "TESTSEED",
      count: 8,
      centre: V.vec3(),
      minRange: 600,
      maxRange: 5000,
      baseAltitude: 500,
    };
    const a = generateSpawnPoints(options);
    const b = generateSpawnPoints(options);
    const c = generateSpawnPoints({ ...options, seed: "OTHER" });

    assert(
      a.every((p, i) => V.distance(p, b[i] as V.Vec3) < 1e-9),
      "the same seed places contacts identically",
    );
    assert(
      a.some((p, i) => V.distance(p, c[i] as V.Vec3) > 10),
      "a different seed places them differently",
    );
    assert(
      a.every((p) => {
        const range = Math.hypot(p.x, p.y);
        return range >= 600 && range <= 5000;
      }),
      "every contact starts between 600 m and 5 km from the player",
    );
  });

  await suite("intercept mission", async () => {
    const simulation = await buildSimulation();
    const runner = new MissionRunner(settings({ enemyCount: 3 }));
    spawnPlayer(simulation);
    for (let i = 0; i < 3; i += 1) spawnEnemy(simulation, `enemy-${i}`, i * 400);
    runner.setEnemyCount(3);

    simulation.update(1 / 60);
    runner.update(simulation, 1 / 60);
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "a fresh mission is in progress",
    );
    assertClose(runner.status.enemiesRemaining, 3, 1e-9, "three contacts remain");
    assertClose(
      runner.status.interceptorsRemaining,
      5,
      1e-9,
      "with five airframes available",
    );

    // Take out two contacts.
    for (const id of ["enemy-0", "enemy-1"]) {
      const enemy = simulation.aircraft.find((a) => a.id === id);
      if (enemy) enemy.status = FLIGHT_STATUS.Destroyed;
    }
    simulation.update(1 / 60);
    runner.update(simulation, 1 / 60);
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "the mission continues while a contact is still up",
    );

    const last = simulation.aircraft.find((a) => a.id === "enemy-2");
    if (last) last.status = FLIGHT_STATUS.Destroyed;
    simulation.update(1 / 60);
    const events = runner.update(simulation, 1 / 60);
    assert(
      events.some((e) => e.type === "COMPLETE"),
      "destroying the last contact completes the mission",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.Complete,
      "and the outcome sticks",
    );
  });

  await suite("losing airframes", async () => {
    const simulation = await buildSimulation();
    const runner = new MissionRunner(settings({ enemyCount: 1 }));
    let player = spawnPlayer(simulation);
    spawnEnemy(simulation, "enemy-0", 0);
    runner.setEnemyCount(1);

    const relaunch = (): void => {
      simulation.remove("player");
      player = spawnPlayer(simulation);
    };

    // Lose one airframe: the mission should put another up.
    player.status = FLIGHT_STATUS.Crashed;
    const first = run(runner, simulation, 5, relaunch);
    assert(
      first.some((e) => e.type === "AIRFRAME_LOST"),
      "losing an airframe is reported",
    );
    assert(first.some((e) => e.type === "RELAUNCH"), "and a replacement launches");
    assertClose(
      runner.status.interceptorsRemaining,
      2,
      1e-9,
      "one of three airframes is gone",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "the mission is still running",
    );
    assert(
      simulation.player?.status === FLIGHT_STATUS.Flying,
      "and there is an aircraft in the air again",
    );

    // Burn through the rest.
    for (let i = 0; i < 2; i += 1) {
      const current = simulation.player;
      if (current) current.status = FLIGHT_STATUS.Crashed;
      run(runner, simulation, 5, relaunch);
    }
    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed,
      "running out of airframes fails the mission",
    );
    assert(
      runner.status.enemiesRemaining === 1,
      "with the contact still flying",
    );
    assert(
      runner.status.reason.includes("No airframes left"),
      `and says why (${runner.status.reason})`,
    );
  });

  await suite("an airframe nobody has been given yet", async () => {
    // A flight begins being stepped before it has an aircraft in it. The
    // world is built around the start point first — terrain sampled, and on
    // the ground view the launch surface picked out of the rendered scene,
    // which only answers after a few frames of its own — and the frame loop
    // is already turning while that happens. An empty sky in those frames is
    // a flight that has not begun, not one that is already over.
    const simulation = await buildSimulation();
    const runner = new MissionRunner(
      settings({ mode: MISSION_MODE.GroundView, enemyCount: 0 }),
    );

    const beforeSpawn = run(runner, simulation, 3, () => {});
    assert(
      !beforeSpawn.some((e) => e.type === "AIRFRAME_LOST"),
      "a flight with no aircraft in it yet has not lost one",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and the flight is still ahead of the pilot rather than over",
    );
    assertClose(
      runner.status.interceptorsRemaining,
      1,
      1e-9,
      "with the one airframe it was carried onto the field with",
    );

    // Put it on the field, and the rest of the flight reads as it always did.
    const player = spawnPlayer(simulation);
    run(runner, simulation, 1, () => {});
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "an aircraft that has arrived is flown, not mourned",
    );

    player.status = FLIGHT_STATUS.Crashed;
    const events = run(runner, simulation, 5, () => {});
    assert(
      events.some((e) => e.type === "AIRFRAME_LOST"),
      "and losing that one is still a loss",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed,
      "which ends a flight that was only ever going flying",
    );
  });

  await suite("a contact taken with the wing is the mission working", async () => {
    // The charge is on the wing, so the only way to bring a contact down is to
    // arrive on it: an interception and a strike are both flown by spending
    // airframes on aircraft. A wing spent that way is not a wing thrown away,
    // and the loss says which of the two it was so nobody presenting it has to
    // guess.
    const simulation = await buildSimulation(true, 380);
    const runner = new MissionRunner(settings({ enemyCount: 2 }));
    runner.setEnemyCount(2);

    // Head-on, and neither wing flies away from that.
    simulation.spawn(
      {
        id: "enemy-0", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(0, 300, 500), headingDeg: 180, airspeed: 26, throttle: 0.65,
      },
      () => cruise,
    );
    // A second contact well out of the way, so the pass does not clear the sky
    // and there is still a mission to go back up to.
    simulation.spawn(
      {
        id: "enemy-1", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(2500, 0, 500), headingDeg: 0, airspeed: 26, throttle: 0.65,
      },
      () => cruise,
    );
    simulation.spawn(
      {
        id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
        position: V.vec3(0, 0, 500), headingDeg: 0, airspeed: 26, throttle: 0.65,
      },
      () => cruise,
    );

    const events: MissionEvent[] = [];
    const step = (frames: number, until: () => boolean): void => {
      for (let i = 0; i < frames && !until(); i += 1) {
        simulation.update(1 / 60);
        events.push(...runner.update(simulation, 1 / 60));
      }
    };

    step(30 * 60, () => simulation.statistics.collisions > 0);
    assert(simulation.statistics.collisions > 0, "the two aircraft meet");
    assertClose(
      simulation.playerKillCount,
      1,
      1e-9,
      "the contact is credited to the pilot who arrived on it",
    );

    // The wreck still has to reach the ground before anything is decided.
    step(60 * 60, () => events.some((event) => event.type === "AIRFRAME_LOST"));
    const lost = events.find((event) => event.type === "AIRFRAME_LOST");
    assert(lost !== undefined, "the airframe is counted as lost");
    assert(
      lost?.type === "AIRFRAME_LOST" && lost.kills === 1,
      `with the contact it took with it (${
        lost?.type === "AIRFRAME_LOST" ? lost.kills : "none"
      })`,
    );
    assert(
      lost?.type === "AIRFRAME_LOST" &&
        lost.reason.toLowerCase().includes("contact"),
      `and told as a contact destroyed rather than a wing thrown away (${
        lost?.type === "AIRFRAME_LOST" ? lost.reason : ""
      })`,
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "the mission is not over: there is another contact up there",
    );

    step(10 * 60, () => events.some((event) => event.type === "RELAUNCH"));
    assert(
      events.some((event) => event.type === "RELAUNCH"),
      "and another airframe goes up to go and get it",
    );
  });

  await suite("a wing thrown away is not credited with anything", async () => {
    // The same loss without a contact under it. Nothing was destroyed, so
    // nothing is claimed, and the pilot is told what it really was.
    const simulation = await buildSimulation();
    const runner = new MissionRunner(settings({ enemyCount: 1 }));
    const player = spawnPlayer(simulation);
    spawnEnemy(simulation, "enemy-0", 0);
    runner.setEnemyCount(1);

    player.status = FLIGHT_STATUS.Crashed;
    const events = run(runner, simulation, 5, () => {});
    const lost = events.find((event) => event.type === "AIRFRAME_LOST");
    assert(
      lost?.type === "AIRFRAME_LOST" && lost.kills === 0,
      "a wing flown into the ground brings nothing down with it",
    );
    assert(
      lost?.type === "AIRFRAME_LOST" && lost.reason.includes("terrain"),
      `and says so (${lost?.type === "AIRFRAME_LOST" ? lost.reason : ""})`,
    );
  });

  await suite("free flight", async () => {
    const simulation = await buildSimulation();
    const runner = new MissionRunner(
      settings({ mode: MISSION_MODE.FreeFlight, enemyCount: 0 }),
    );
    const player = spawnPlayer(simulation);
    simulation.update(1 / 60);
    runner.update(simulation, 1 / 60);
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "free flight runs until something goes wrong",
    );

    player.status = FLIGHT_STATUS.Crashed;
    const events = run(runner, simulation, 5, () => {});
    assert(
      events.some((e) => e.type === "FAILED"),
      "a crash ends a free flight",
    );
    assert(
      !events.some((e) => e.type === "RELAUNCH"),
      "and nothing relaunches",
    );
  });

  await suite("formation flight", async () => {
    // Damage off: this is the stopwatch under test, not the flying.
    const simulation = await buildSimulation(false);
    const runner = new MissionRunner(
      settings({
        mode: MISSION_MODE.Formation,
        combat: false,
        formation: {
          slot: FORMATION_SLOT.Right,
          flightSize: 1,
          routineSeconds: 60,
        },
      }),
    );
    const tracker = runner.formation;
    assert(tracker !== null, "a formation mission builds a tracker");
    if (!tracker) return;

    const lead = spawnLead(simulation, V.vec3(0, 0, 500));
    // Put the player exactly on station, then hold it there by hand: the
    // scoring is what is under test here, not the flying.
    const station = formationStation(
      V.vec3(),
      lead,
      FORMATION_SLOTS[FORMATION_SLOT.Right],
    );
    const player = spawnPlayerAt(simulation, station);

    runner.update(simulation, 1 / 60);
    assert(
      runner.status.formation !== undefined,
      "and reports formation progress on the mission status",
    );

    // Forty seconds glued to the slot: two thirds of the routine.
    for (let i = 0; i < 40 * 60; i += 1) {
      formationStation(station, lead, FORMATION_SLOTS[FORMATION_SLOT.Right]);
      V.copy(player.position, station);
      runner.update(simulation, 1 / 60);
    }
    assertClose(
      tracker.progress.score,
      1,
      0.02,
      "sitting in the slot scores the whole time",
    );
    assert(tracker.progress.inStation, "and reads as in station");
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "with the routine still running",
    );

    // The rest a long way out of it — far enough to be out of station, close
    // enough not to count as having left the formation.
    for (let i = 0; i < 25 * 60; i += 1) {
      formationStation(station, lead, FORMATION_SLOTS[FORMATION_SLOT.Right]);
      V.copy(player.position, station);
      player.position.x += STATION_TOLERANCE * 3;
      runner.update(simulation, 1 / 60);
    }
    assert(
      runner.status.outcome === MISSION_OUTCOME.Complete,
      "holding the slot for two thirds of the routine passes",
    );
    assertBetween(
      tracker.progress.score,
      PASS_FRACTION,
      0.72,
      "and the score is the share of the routine actually held",
    );
    assert(
      runner.status.reason.includes("%"),
      `with the percentage in the reason (${runner.status.reason})`,
    );
  });

  await suite("formation flown badly", async () => {
    const simulation = await buildSimulation(false);
    const runner = new MissionRunner(
      settings({
        mode: MISSION_MODE.Formation,
        combat: false,
        formation: {
          slot: FORMATION_SLOT.Astern,
          flightSize: 1,
          routineSeconds: 40,
        },
      }),
    );
    const lead = spawnLead(simulation, V.vec3(0, 0, 500));
    const player = spawnPlayerAt(simulation, V.vec3(300, 0, 500));

    for (let i = 0; i < 45 * 60; i += 1) {
      // Trail the leader, never joining up.
      player.position.x = lead.position.x + 300;
      player.position.y = lead.position.y;
      player.position.z = lead.position.z;
      runner.update(simulation, 1 / 60);
    }
    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed,
      "never taking the slot fails the exercise",
    );
    assertClose(runner.formation?.progress.score ?? 1, 0, 0.02, "with no time held");
    assert(
      runner.status.reason.includes(`${Math.round(PASS_FRACTION * 100)}%`),
      `and says what was needed (${runner.status.reason})`,
    );
  });

  await suite("leaving the formation", async () => {
    const simulation = await buildSimulation(false);
    const runner = new MissionRunner(
      settings({
        mode: MISSION_MODE.Formation,
        combat: false,
        formation: {
          slot: FORMATION_SLOT.Right,
          flightSize: 1,
          routineSeconds: 600,
        },
      }),
    );
    const lead = spawnLead(simulation, V.vec3(0, 0, 500));
    const player = spawnPlayerAt(simulation, V.vec3(0, 0, 500));

    // Sit well outside the abandon range for longer than it allows.
    for (let i = 0; i < (ABANDON_SECONDS + 5) * 60; i += 1) {
      player.position.x = lead.position.x + ABANDON_RANGE * 1.5;
      runner.update(simulation, 1 / 60);
    }
    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed,
      "flying away from the flight ends the exercise",
    );
    assert(
      runner.status.reason.toLowerCase().includes("contact"),
      `and says so (${runner.status.reason})`,
    );
  });

  await suite("a formation mid-air is flown out, not called", async () => {
    // Two display aircraft touching is a bent wing and a difficult minute, not
    // the end of the exercise: the routine runs on with the damage on board.
    const simulation = await buildSimulation();
    const runner = new MissionRunner(
      settings({
        mode: MISSION_MODE.Formation,
        combat: false,
        formation: {
          slot: FORMATION_SLOT.Astern,
          flightSize: 1,
          routineSeconds: 600,
        },
      }),
    );
    // The player overhauls the leader from behind at ten metres a second: a
    // knock, at the speed a slot is actually lost at.
    const lead = simulation.spawn({
      id: "lead", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(0, 9, 500), headingDeg: 0, airspeed: 20, throttle: 0.45,
    }, () => ({ ...cruise, throttle: 0.45 }));
    const player = simulation.spawn({
      id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 0, airspeed: 30, throttle: 0.85,
    }, () => ({ ...cruise, throttle: 0.85 }));

    const events = run(runner, simulation, 6, () => {});
    assert(simulation.statistics.collisions > 0, "the two aircraft do touch");
    assert(
      player.status === FLIGHT_STATUS.Flying,
      `and the pilot still has an aircraft (${player.status})`,
    );
    assert(lead.status === FLIGHT_STATUS.Flying, "so does the leader");
    assert(
      player.damage.hits > 0 && player.damage.integrity < 1,
      `with the knock marked on the airframe (${player.damage.integrity.toFixed(2)})`,
    );
    assert(
      !events.some((event) => event.type === "FAILED"),
      "the exercise is not called off",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and the routine is still running",
    );
    assert(
      (runner.status.formation?.midairs ?? 0) > 0,
      "though the debrief will know it happened",
    );
  });

  await suite("a formation write-off ends on the ground", async () => {
    // Meeting a wingman head-on is the other end of the scale. It writes the
    // airframe off — and a written-off airframe is a wreck that has to reach
    // the ground before anything is decided about it.
    const simulation = await buildSimulation(true, 380);
    const runner = new MissionRunner(
      settings({
        mode: MISSION_MODE.Formation,
        combat: false,
        formation: {
          slot: FORMATION_SLOT.Astern,
          flightSize: 2,
          routineSeconds: 600,
        },
      }),
    );
    simulation.spawn({
      id: "lead", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(60, 0, 500), headingDeg: 0, airspeed: 26, throttle: 0.65,
    }, () => cruise);
    simulation.spawn({
      id: "wingman", role: AIRCRAFT_ROLE.Wingman, config: PLAYER_WING,
      position: V.vec3(0, 300, 500), headingDeg: 180, airspeed: 26, throttle: 0.65,
    }, () => cruise);
    const player = simulation.spawn({
      id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 0, airspeed: 26, throttle: 0.65,
    }, () => cruise);

    const events: MissionEvent[] = [];
    for (let i = 0; i < 30 * 60 && simulation.statistics.collisions === 0; i += 1) {
      simulation.update(1 / 60);
      events.push(...runner.update(simulation, 1 / 60));
    }
    assert(simulation.statistics.collisions > 0, "the two aircraft meet");
    assert(
      player.status === FLIGHT_STATUS.Disabled,
      `which stops the airframe flying (${player.status})`,
    );
    assert(
      player.status !== FLIGHT_STATUS.Destroyed,
      "without it simply ceasing to exist where it was hit",
    );
    assert(player.altitudeAgl > 20, "the wreck is still well clear of the ground");
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and nothing has been decided in mid-air",
    );
    assert(
      !events.some((event) => event.type === "AIRFRAME_LOST"),
      "the airframe is not written out of the mission while it is still falling",
    );

    // Now let it arrive.
    for (
      let i = 0;
      i < 60 * 60 && !events.some((event) => event.type === "AIRFRAME_LOST");
      i += 1
    ) {
      simulation.update(1 / 60);
      events.push(...runner.update(simulation, 1 / 60));
    }
    assert(
      player.status === FLIGHT_STATUS.Crashed,
      `the wreck reaches the ground (${player.status})`,
    );
    const lost = events.find((event) => event.type === "AIRFRAME_LOST");
    assert(lost !== undefined, "and only then is the airframe counted as lost");
    assert(
      lost?.type === "AIRFRAME_LOST" &&
        lost.reason.toLowerCase().includes("mid-air"),
      `with the mid-air named as what did it (${
        lost?.type === "AIRFRAME_LOST" ? lost.reason : ""
      })`,
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and the exercise carries on, because there is another airframe",
    );
  });

  await suite("a falling leader is waited for", async () => {
    // Taking the leader out is the end of the routine, but not the moment it
    // is hit: the exercise is called when the leader is on the ground.
    const simulation = await buildSimulation(true, 380);
    const runner = new MissionRunner(
      settings({
        mode: MISSION_MODE.Formation,
        combat: false,
        formation: {
          slot: FORMATION_SLOT.Astern,
          flightSize: 1,
          routineSeconds: 600,
        },
      }),
    );
    const lead = simulation.spawn({
      id: "lead", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(0, 300, 500), headingDeg: 180, airspeed: 26, throttle: 0.65,
    }, () => cruise);
    simulation.spawn({
      id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 0, airspeed: 26, throttle: 0.65,
    }, () => cruise);

    const events: MissionEvent[] = [];
    for (let i = 0; i < 30 * 60 && simulation.statistics.collisions === 0; i += 1) {
      simulation.update(1 / 60);
      events.push(...runner.update(simulation, 1 / 60));
    }
    assert(simulation.statistics.collisions > 0, "the player hits the leader");
    assert(
      simulation.lead === null,
      "who stops being an aircraft that can be flown on",
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.InProgress,
      "and yet the exercise is still running, because the wreck is still up",
    );

    for (
      let i = 0;
      i < 60 * 60 && runner.status.outcome === MISSION_OUTCOME.InProgress;
      i += 1
    ) {
      simulation.update(1 / 60);
      events.push(...runner.update(simulation, 1 / 60));
    }
    assert(
      lead.status === FLIGHT_STATUS.Crashed,
      `the leader's wreck reaches the ground (${lead.status})`,
    );
    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed &&
        runner.status.reason.toLowerCase().includes("leader"),
      `and that is what ends the exercise (${runner.status.reason})`,
    );
  });

  suite("formation grades", () => {
    assert(formationGrade(0.95) === "Immaculate", "a near-perfect flight is graded as one");
    assert(formationGrade(PASS_FRACTION) === "Passed", "the pass mark reads as a pass");
    assert(formationGrade(0.1) === "Adrift", "and a flight barely flown reads as one");
  });

  await suite("mutual destruction still counts", async () => {
    // A head-on interception destroys both. The mission has to treat that as a
    // kill and an airframe spent, not as a loss.
    const simulation = await buildSimulation();
    const runner = new MissionRunner(settings({ enemyCount: 1 }));
    spawnPlayer(simulation);
    simulation.remove("player");
    let player = simulation.spawn(
      {
        id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
        position: V.vec3(0, -300, 500), headingDeg: 0, airspeed: 26, throttle: 0.7,
      },
      () => idle,
    );
    simulation.spawn(
      {
        id: "enemy-0", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(0, 300, 500), headingDeg: 180, airspeed: 26, throttle: 0.7,
      },
      () => idle,
    );
    runner.setEnemyCount(1);

    const relaunch = (): void => {
      simulation.remove("player");
      player = spawnPlayer(simulation);
    };
    void player;

    const events = run(runner, simulation, 30, relaunch);
    assert(
      simulation.statistics.enemiesDestroyed === 1,
      "the contact is destroyed by the collision",
    );
    assert(
      events.some((e) => e.type === "COMPLETE"),
      "and taking the last one with you still wins the mission",
    );
  });
}
