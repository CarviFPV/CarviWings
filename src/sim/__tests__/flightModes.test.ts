import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { PLAYER_WING } from "../flight/config";
import type { AircraftState } from "../flight/state";
import {
  AIRCRAFT_ROLE,
  FLIGHT_STATUS,
  createAircraftState,
  isGrounded,
} from "../flight/state";
import {
  PHYSICS_TIMESTEP,
  stallSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import { FlightModeController } from "../flight/flightController";
import { TerrainAvoidanceSystem } from "../ai/terrainAvoidance";
import {
  DEFAULT_FLIGHT_MODE_SETTINGS,
  FLIGHT_MODE,
  RTH_ALTITUDE_MODE,
  RTH_ARRIVAL,
  RTH_STAGE,
  normaliseFlightModeSettings,
  returnAltitude,
} from "../flight/flightModes";
import type { FlightModeSettings } from "../flight/flightModes";
import type { ControlRates } from "../flight/rates";
import { INTERCEPTOR_WING } from "../flight/uav";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { toHeadingPitchRoll } from "../math/quat";
import { RAD_TO_DEG } from "../math/scalar";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 500 };

/** Flat ground at sea level, so heights in the tests read as they are written. */
async function flatTerrain(): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => 0),
    { cellSize: 250, warmRadius: 8000, sampleBudget: 40000, detailCellSize: 0 },
  );
  await field.prefill(V.vec3(), 12000);
  return field;
}

function wing(options: {
  position?: { x: number; y: number; z: number };
  headingDeg?: number;
  rollDeg?: number;
  pitchDeg?: number;
  airspeed?: number;
}): AircraftState {
  return createAircraftState({
    id: "player",
    role: AIRCRAFT_ROLE.Player,
    config: PLAYER_WING,
    position: V.vec3(
      options.position?.x ?? 0,
      options.position?.y ?? 0,
      options.position?.z ?? 300,
    ),
    headingDeg: options.headingDeg ?? 0,
    pitchDeg: options.pitchDeg ?? 0,
    rollDeg: options.rollDeg ?? 0,
    airspeed: options.airspeed ?? 24,
    throttle: 0.6,
  });
}

function settings(change: Partial<FlightModeSettings> = {}): FlightModeSettings {
  return { ...DEFAULT_FLIGHT_MODE_SETTINGS, ...change };
}

function rates(change: Partial<ControlRates> = {}): ControlRates {
  return { ...INTERCEPTOR_WING.defaultRates, ...change };
}

/**
 * Flies the aircraft through the controller for `seconds`.
 *
 * The whole point of the flight controller is that it produces stick
 * positions, so every one of these runs them through the real flight model
 * rather than checking a control law in isolation.
 */
function fly(
  controller: FlightModeController,
  state: AircraftState,
  pilot: FlightInput,
  seconds: number,
  terrainHeight = 0,
): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    const input = controller.update(state, pilot, PHYSICS_TIMESTEP);
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
    state.terrainHeight = terrainHeight;
    state.altitudeAgl = state.position.z - terrainHeight;
  }
}

export async function runFlightModeTests(): Promise<void> {
  suite("manual is the aircraft as it has always been", () => {
    const controller = new FlightModeController({
      settings: settings({ defaultMode: FLIGHT_MODE.Manual }),
    });
    const state = wing({});
    const pilot: FlightInput = { pitch: 0.4, roll: -0.7, yaw: 0.2, throttle: 0.5 };
    const out = controller.update(state, pilot, PHYSICS_TIMESTEP);

    assert(out.pitch === pilot.pitch, "pitch reaches the elevons untouched");
    assert(out.roll === pilot.roll, "so does roll");
    assert(out.yaw === pilot.yaw, "so does yaw");
    assert(out.throttle === pilot.throttle, "and so does the throttle");
    assert(
      controller.describe().mode === FLIGHT_MODE.Manual,
      "and the mode reads manual",
    );
  });

  suite("the mode switch steps through all three and comes back", () => {
    const controller = new FlightModeController({
      settings: settings({ defaultMode: FLIGHT_MODE.Manual }),
    });
    assert(controller.cycleMode() === FLIGHT_MODE.Acro, "manual goes to acro");
    assert(controller.cycleMode() === FLIGHT_MODE.Angle, "acro to angle");
    assert(
      controller.cycleMode() === FLIGHT_MODE.Manual,
      "and angle back to manual",
    );
  });

  suite("acro holds the rate the stick is asking for", () => {
    const controller = new FlightModeController({
      settings: settings(),
      rates: rates({ rollRate: 200 }),
    });
    const state = wing({ airspeed: 28 });
    const pilot: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.7 };

    fly(controller, state, pilot, 2);
    const rolling = state.angularVelocity.x * RAD_TO_DEG;
    assertClose(rolling, 200, 25, "full stick rolls at the rate it is set to");

    // The same stick on half the rate is half the roll, which is the whole
    // reason the setting exists.
    const halved = new FlightModeController({
      settings: settings(),
      rates: rates({ rollRate: 100 }),
    });
    const slower = wing({ airspeed: 28 });
    fly(halved, slower, pilot, 2);
    assertClose(
      slower.angularVelocity.x * RAD_TO_DEG,
      100,
      20,
      "and half the rate is half the roll",
    );
  });

  suite("a rate is held whatever the airspeed is", () => {
    // The point of flying on rates rather than on elevon travel: the same
    // stick at nearly twice the speed is the same roll, where a manual wing
    // would roll half as fast again for the same deflection.
    const setup = { settings: settings(), rates: rates({ rollRate: 180 }) };
    const pilot: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.8 };

    const slow = wing({ airspeed: 22 });
    fly(new FlightModeController(setup), slow, pilot, 2);
    const fast = wing({ airspeed: 40 });
    fly(new FlightModeController(setup), fast, pilot, 2);

    const slowRate = slow.angularVelocity.x * RAD_TO_DEG;
    const fastRate = fast.angularVelocity.x * RAD_TO_DEG;
    assertClose(slowRate, 180, 25, "the slow wing rolls at the set rate");
    assertClose(
      fastRate,
      slowRate,
      30,
      `and the fast one rolls the same (${slowRate.toFixed(0)} vs ${fastRate.toFixed(0)} deg/s)`,
    );
  });

  suite("acro stops rotating when the sticks are centred", () => {
    const controller = new FlightModeController({ settings: settings() });
    // Rolling hard and pitched up when the sticks are let go: a gyro holds
    // what it is given, so the rotation stops even though the wing does not
    // level itself.
    const state = wing({ rollDeg: 40, airspeed: 28 });
    state.angularVelocity.x = 3;
    const centred = createFlightInput();
    centred.throttle = 0.65;

    fly(controller, state, centred, 3);
    assertBetween(
      state.angularVelocity.x * RAD_TO_DEG,
      -20,
      20,
      "the roll is stopped",
    );
    assert(
      Math.abs(toHeadingPitchRoll(state.orientation).rollDeg) > 10,
      "and the bank is left where the pilot put it, because acro does not level",
    );
  });

  suite("angle mode levels the wing when the sticks are let go", () => {
    const controller = new FlightModeController({ settings: settings() });
    controller.setMode(FLIGHT_MODE.Angle);
    const state = wing({ rollDeg: 55, airspeed: 26 });
    const centred = createFlightInput();
    centred.throttle = 0.6;

    fly(controller, state, centred, 4);
    const roll = toHeadingPitchRoll(state.orientation).rollDeg;
    assertBetween(roll, -8, 8, "a 55 degree bank comes back to level");
  });

  suite("angle mode holds the bank the stick asks for", () => {
    const limits = settings({ maxBankDeg: 40 });
    const controller = new FlightModeController({ settings: limits });
    controller.setMode(FLIGHT_MODE.Angle);
    const state = wing({ airspeed: 28 });
    const pilot: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.7 };

    fly(controller, state, pilot, 5);
    const roll = toHeadingPitchRoll(state.orientation).rollDeg;
    assertClose(roll, 40, 8, "full stick settles on the bank limit");

    // The same stick in acro is a roll rate, so it never settles anywhere.
    const acro = new FlightModeController({ settings: limits });
    const rolling = wing({ airspeed: 28 });
    fly(acro, rolling, pilot, 5);
    assert(
      Math.abs(rolling.angularVelocity.x) > 1,
      "and in acro the same stick is still rolling",
    );
  });

  suite("course hold flies the heading it was engaged on", () => {
    const controller = new FlightModeController({ settings: settings() });
    const state = wing({ headingDeg: 90, rollDeg: 30, airspeed: 26 });
    controller.toggleCourseHold();
    const centred = createFlightInput();
    centred.throttle = 0.65;

    fly(controller, state, centred, 12);
    const heading = toHeadingPitchRoll(state.orientation).headingDeg;
    assertClose(heading, 90, 12, "the wing comes back onto its course");
    assert(controller.describe().courseHold, "and the hold stays engaged");
  });

  suite("the roll stick walks a held course instead of banking", () => {
    const controller = new FlightModeController({
      settings: settings({ courseTrimRate: 60 }),
    });
    const state = wing({ headingDeg: 0, airspeed: 26 });
    controller.toggleCourseHold();
    const pilot: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.65 };

    fly(controller, state, pilot, 1.5);
    const held = controller.describe().heldCourse;
    assertClose(held, 90, 6, "a second and a half of full stick is 90 degrees");
  });

  suite("altitude hold gets back to the height it was given", () => {
    const controller = new FlightModeController({ settings: settings() });
    // Nose down and going the wrong way when the hold is engaged.
    const state = wing({
      position: { x: 0, y: 0, z: 400 },
      pitchDeg: -15,
      airspeed: 30,
    });
    controller.toggleAltitudeHold();
    const centred = createFlightInput();
    centred.throttle = 0.6;

    fly(controller, state, centred, 30);
    assertClose(state.position.z, 400, 20, "the descent is caught and reversed");
    assert(
      state.airspeed > stallSpeed(PLAYER_WING) * 1.05,
      "and the height is not held by trading away the speed",
    );
  });

  suite("cruise is a course and a height flown together", () => {
    const controller = new FlightModeController({ settings: settings() });
    controller.setMode(FLIGHT_MODE.Angle);
    const state = wing({
      position: { x: 0, y: 0, z: 400 },
      headingDeg: 120,
      rollDeg: 35,
      airspeed: 26,
    });
    controller.toggleCourseHold();
    controller.toggleAltitudeHold();
    const centred = createFlightInput();
    centred.throttle = 0.65;

    fly(controller, state, centred, 40);
    const heading = toHeadingPitchRoll(state.orientation).headingDeg;
    assertClose(heading, 120, 10, "the course is held");
    assertClose(state.position.z, 400, 30, "and so is the height");
    assert(
      controller.describe().courseHold && controller.describe().altitudeHold,
      "with both engaged at once, which is what cruise is",
    );
  });

  suite("the pitch stick walks a held altitude", () => {
    const controller = new FlightModeController({
      settings: settings({ altitudeTrimRate: 5 }),
    });
    const state = wing({ position: { x: 0, y: 0, z: 300 }, airspeed: 26 });
    controller.toggleAltitudeHold();
    const climbing: FlightInput = { pitch: 1, roll: 0, yaw: 0, throttle: 0.8 };

    fly(controller, state, climbing, 4);
    assertClose(
      controller.describe().heldAltitude,
      320,
      3,
      "four seconds of full up stick asks for twenty metres",
    );
  });

  suite("the assists will not hold the wing in a stall", () => {
    const controller = new FlightModeController({ settings: settings() });
    controller.setMode(FLIGHT_MODE.Angle);
    // Slow, nose high and with no power: the one place a self-levelling mode
    // can quietly kill an aircraft is by holding the attitude it asked for.
    const state = wing({ pitchDeg: 25, airspeed: 8 });
    const pilot: FlightInput = { pitch: 1, roll: 0, yaw: 0, throttle: 0 };

    fly(controller, state, pilot, 6);
    assert(
      !state.stalled,
      "it puts the nose down and gets the speed back instead",
    );
    assert(
      state.airspeed > stallSpeed(PLAYER_WING),
      "and comes out above the stall speed",
    );
  });

  suite("the modes come off with the airframe", () => {
    const controller = new FlightModeController({ settings: settings() });
    controller.setMode(FLIGHT_MODE.Angle);
    controller.toggleCourseHold();
    controller.toggleAltitudeHold();
    controller.toggleReturnHome();

    const state = wing({});
    state.status = FLIGHT_STATUS.Landed;
    const pilot = createFlightInput();
    const out = controller.update(state, pilot, PHYSICS_TIMESTEP);
    const status = controller.describe();

    assert(!status.courseHold, "course hold is dropped on the ground");
    assert(!status.altitudeHold, "so is altitude hold");
    assert(!status.returnHome, "and so is the return");
    assert(out.roll === 0, "with the sticks going straight through again");
  });

  suite("a return altitude is worked out the way it is set up", () => {
    const rth = DEFAULT_FLIGHT_MODE_SETTINGS.rth;
    const atLeast = { ...rth, altitudeMode: RTH_ALTITUDE_MODE.AtLeast, altitudeMetres: 120 };
    assertClose(returnAltitude(atLeast, 500, 200), 500, 1e-6, "at least keeps a height above it");
    assertClose(returnAltitude(atLeast, 250, 200), 320, 1e-6, "and climbs to it from below");
    assertClose(
      returnAltitude({ ...atLeast, altitudeMode: RTH_ALTITUDE_MODE.Fixed }, 500, 200),
      320,
      1e-6,
      "fixed comes down to it as readily as up",
    );
    assertClose(
      returnAltitude({ ...atLeast, altitudeMode: RTH_ALTITUDE_MODE.Current }, 500, 200),
      500,
      1e-6,
      "current keeps what it has",
    );
    assertClose(
      returnAltitude({ ...atLeast, altitudeMode: RTH_ALTITUDE_MODE.Extra }, 500, 200),
      620,
      1e-6,
      "and extra adds to it",
    );
  });

  await suite("a return home climbs first, then comes back", async () => {
    const terrain = await flatTerrain();
    const controller = new FlightModeController({
      settings: settings({
        rth: {
          ...DEFAULT_FLIGHT_MODE_SETTINGS.rth,
          climbFirst: true,
          altitudeMode: RTH_ALTITUDE_MODE.AtLeast,
          altitudeMetres: 250,
          arrival: RTH_ARRIVAL.Loiter,
        },
      }),
      terrain,
    });
    controller.setHome(V.vec3(0, 0, 100));

    // Four kilometres out, low, and pointed away from home.
    const state = wing({
      position: { x: 3000, y: 2500, z: 150 },
      headingDeg: 45,
      airspeed: 26,
    });
    const pilot = createFlightInput();
    pilot.throttle = 0.6;
    controller.toggleReturnHome();

    fly(controller, state, pilot, 2);
    assert(
      controller.describe().rthStage === RTH_STAGE.Climb,
      "it opens on the climb because it is below the return altitude",
    );

    fly(controller, state, pilot, 60);
    assert(
      state.position.z > 200,
      "and gets most of the way up before turning",
    );

    fly(controller, state, pilot, 260);
    const range = Math.hypot(state.position.x, state.position.y);
    assert(range < 400, `it arrives over home (${range.toFixed(0)} m out)`);
    assert(
      controller.describe().rthStage === RTH_STAGE.Loiter,
      "and settles into the loiter it was told to",
    );

    fly(controller, state, pilot, 60);
    const holding = Math.hypot(state.position.x, state.position.y);
    assertBetween(holding, 40, 500, "and stays over the field rather than leaving");
    assert(state.status === FLIGHT_STATUS.Flying, "still flying");
  });

  await suite("a return without the climb turns for home straight away", async () => {
    const terrain = await flatTerrain();
    const controller = new FlightModeController({
      settings: settings({
        rth: {
          ...DEFAULT_FLIGHT_MODE_SETTINGS.rth,
          climbFirst: false,
          altitudeMetres: 250,
        },
      }),
      terrain,
    });
    controller.setHome(V.vec3(0, 0, 100));

    const state = wing({
      position: { x: 2000, y: 0, z: 150 },
      headingDeg: 90,
      airspeed: 26,
    });
    const pilot = createFlightInput();
    pilot.throttle = 0.6;
    controller.toggleReturnHome();

    fly(controller, state, pilot, 1);
    assert(
      controller.describe().rthStage === RTH_STAGE.Cruise,
      "there is no climb stage to open on",
    );

    fly(controller, state, pilot, 25);
    const heading = toHeadingPitchRoll(state.orientation).headingDeg;
    assertClose(heading, 270, 30, "it is pointed at home within half a minute");
    assert(state.position.z > 160, "and is climbing on the way");
  });

  await suite("a return can be taken back by moving a stick", async () => {
    const terrain = await flatTerrain();
    const controller = new FlightModeController({ settings: settings(), terrain });
    controller.setHome(V.vec3(0, 0, 0));
    const state = wing({ position: { x: 2000, y: 0, z: 300 }, airspeed: 26 });
    controller.toggleReturnHome();
    fly(controller, state, createFlightInput(), 1);
    assert(controller.describe().returnHome, "the return is running");

    const nudged: FlightInput = { pitch: 0, roll: 0.6, yaw: 0, throttle: 0.6 };
    const out = controller.update(state, nudged, PHYSICS_TIMESTEP);
    assert(!controller.describe().returnHome, "a roll input cancels it");
    // Acro, so what comes out is the elevon the rate loop wants rather than
    // the stick itself — but it is the pilot's roll being flown, not a
    // navigation loop's.
    assert(out.roll > 0, "and the stick is flying the aircraft again");
  });

  await suite("a return that may not be overridden keeps flying", async () => {
    const terrain = await flatTerrain();
    const controller = new FlightModeController({
      settings: settings({
        rth: { ...DEFAULT_FLIGHT_MODE_SETTINGS.rth, allowStickOverride: false },
      }),
      terrain,
    });
    controller.setHome(V.vec3(0, 0, 0));
    const state = wing({ position: { x: 2000, y: 0, z: 300 }, airspeed: 26 });
    controller.toggleReturnHome();

    const nudged: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.6 };
    fly(controller, state, nudged, 2);
    assert(
      controller.describe().returnHome,
      "the sticks are ignored, which is the point of switching it off",
    );
  });

  await suite("a return set to land puts the aircraft on the ground", async () => {
    const terrain = await flatTerrain();
    const controller = new FlightModeController({
      settings: settings({
        rth: {
          ...DEFAULT_FLIGHT_MODE_SETTINGS.rth,
          climbFirst: false,
          altitudeMode: RTH_ALTITUDE_MODE.Current,
          arrival: RTH_ARRIVAL.Land,
          loiterRadiusMetres: 150,
        },
      }),
      terrain,
      // With the terrain look-ahead attached, the way a real flight has it:
      // the one stage that is deliberately going to the ground must not spend
      // the approach being told to climb away from it.
      avoidance: new TerrainAvoidanceSystem(terrain),
    });
    controller.setHome(V.vec3(0, 0, 0));

    // Flown through the real simulation rather than the bare flight model:
    // a landing is only a landing if the ground is there to meet it.
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 500 }),
      terrain,
      missionRadius: 20000,
    });
    const pilot = createFlightInput();
    pilot.throttle = 0.6;
    const state = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(900, 0, 160),
        headingDeg: 270,
        airspeed: 26,
        throttle: 0.6,
      },
      (aircraft, dt) => controller.update(aircraft, pilot, dt),
    );
    controller.toggleReturnHome();

    for (let i = 0; i < 40 * 60; i += 1) simulation.update(1 / 60);
    assert(
      controller.describe().rthStage === RTH_STAGE.Land,
      "it reaches the field and starts down",
    );

    let seconds = 40;
    while (seconds < 400 && !isGrounded(state.status)) {
      simulation.update(1 / 60);
      seconds += 1 / 60;
    }
    assert(
      isGrounded(state.status),
      `the wing ends up on its belly rather than in a smoking hole (${state.status})`,
    );
    assert(
      !controller.describe().returnHome,
      "and the return puts itself away once it is down",
    );
    assert(
      simulation.statistics.landings > 0,
      "which the mission counts as a landing",
    );
  });

  suite("settings that arrive from storage are repaired", () => {
    const repaired = normaliseFlightModeSettings({
      defaultMode: "TELEPORT",
      maxBankDeg: 400,
      maxPitchDeg: "steep",
      rth: { altitudeMode: "SOMEWHERE", altitudeMetres: 90000, climbFirst: "yes" },
    });

    assert(repaired.defaultMode === FLIGHT_MODE.Acro, "an unknown mode falls back");
    assertClose(repaired.maxBankDeg, 75, 1e-6, "an absurd bank limit is clamped");
    assertClose(
      repaired.maxPitchDeg,
      DEFAULT_FLIGHT_MODE_SETTINGS.maxPitchDeg,
      1e-6,
      "a non-number takes its default",
    );
    assert(
      repaired.rth.altitudeMode === DEFAULT_FLIGHT_MODE_SETTINGS.rth.altitudeMode,
      "and so does an unknown return altitude mode",
    );
    assertClose(repaired.rth.altitudeMetres, 500, 1e-6, "the return height is clamped");
    assert(
      repaired.rth.climbFirst === DEFAULT_FLIGHT_MODE_SETTINGS.rth.climbFirst,
      "a string where a flag belongs takes the default",
    );
    assert(
      normaliseFlightModeSettings(undefined).rth.arrival ===
        DEFAULT_FLIGHT_MODE_SETTINGS.rth.arrival,
      "and nothing at all is the whole default",
    );
  });
}
