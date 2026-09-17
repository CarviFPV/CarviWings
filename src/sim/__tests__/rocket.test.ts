import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  CA35_160_UAV,
  UAVS,
  X10_INTERCEPTOR_UAV,
  batteriesFor,
  deliveredBattery,
  motorOrDefault,
  resolveLoadout,
} from "../flight/uav";
import {
  PHYSICS_TIMESTEP,
  cruiseEndurance,
  cruiseSpeed,
  maxLevelSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import {
  hoverThrottle,
  rotorLevelThrottle,
  rotorTrim,
} from "../flight/multirotor";
import { FlightModeController } from "../flight/flightController";
import { FLIGHT_MODE } from "../flight/flightModes";
import { createPowerplant, fitsMotor } from "../flight/powerplant";
import { CA35_160, GRAVITY, PLAYER_WING, X10_INTERCEPTOR } from "../flight/config";
import type { AircraftConfig } from "../flight/config";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import { ROCKET_GROUND_CONTACT, groundContactFor } from "../flight/ground";
import { groundLaunch } from "../flight/launch";
import type { FlightInput } from "../input/types";
import { MS_TO_KMH } from "../flight/telemetry";
import { DEG_TO_RAD, RAD_TO_DEG } from "../math/scalar";
import { rotateVector, upAxis } from "../math/quat";
import { engineProfileFor, engineSound } from "../audio/soundModel";
import {
  MESH_KIND,
  buildRocketMesh,
  meshKindFor,
} from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The X10 as it is delivered: 2450 kV on the 4.2x7, on the 1100. */
const STOCK = resolveLoadout(X10_INTERCEPTOR_UAV, null);

/** One loadout out of the catalogue, worked out from the hardware. */
function fitted(motorId: string, batteryId: string) {
  return resolveLoadout(X10_INTERCEPTOR_UAV, {
    motor: motorId,
    battery: batteryId,
  });
}

function endurance(motorId: string, batteryId: string): number {
  const loadout = fitted(motorId, batteryId);
  const pack = loadout.battery ?? deliveredBattery(X10_INTERCEPTOR_UAV);
  return cruiseEndurance(loadout.config, loadout.motor, pack);
}

function rocket(
  overrides: Partial<{
    airspeed: number;
    throttle: number;
    altitude: number;
    pitchDeg: number;
    withPack: boolean;
    /** An airframe built without a millimetre of error anywhere on it. */
    perfect: boolean;
  }> = {},
): AircraftState {
  return createAircraftState({
    id: "x10",
    role: AIRCRAFT_ROLE.Player,
    config: STOCK.config,
    position: V.vec3(0, 0, overrides.altitude ?? 300),
    headingDeg: 0,
    pitchDeg: overrides.pitchDeg ?? 0,
    airspeed: overrides.airspeed ?? 0,
    throttle: overrides.throttle ?? hoverThrottle(STOCK.config),
    powerplant:
      overrides.withPack && STOCK.battery
        ? createPowerplant(STOCK.motor, STOCK.battery)
        : null,
    dragCentre: overrides.perfect ? V.vec3() : undefined,
  });
}

function stick(throttle: number, pitch = 0, roll = 0, yaw = 0): FlightInput {
  return { pitch, roll, yaw, throttle };
}

function fly(state: AircraftState, input: FlightInput, seconds: number): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
  }
}

/** How far the lean the trim solve returned is from actually balancing. */
function trimResidual(config: AircraftConfig, speed: number): number {
  const trim = rotorTrim(config, speed);
  const sideways = config.mass * GRAVITY * Math.tan(trim.tilt);
  return Math.abs(sideways - trim.drag);
}

/** The X10 in trimmed level flight at one airspeed, flying due north. */
function dashing(speed: number): AircraftState {
  const state = rocket({
    perfect: true,
    altitude: 3000,
    airspeed: speed,
    pitchDeg: -rotorTrim(STOCK.config, speed).tilt * RAD_TO_DEG,
    throttle: rotorLevelThrottle(STOCK.config, speed),
  });
  // Level, rather than along the body axis the spawn points it down: a
  // multirotor's nose and its flight path are not the same direction, and on
  // this one they are three quarters of a right angle apart.
  V.set(state.velocity, 0, speed, 0);
  return state;
}

/** A controller in the mode the simulator starts every flight in. */
function acro(): FlightModeController {
  const controller = new FlightModeController({
    rates: X10_INTERCEPTOR_UAV.defaultRates,
  });
  controller.setMode(FLIGHT_MODE.Acro);
  return controller;
}

function flyAssisted(
  state: AircraftState,
  controller: FlightModeController,
  input: FlightInput,
  seconds: number,
): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    const flown = controller.update(state, input, PHYSICS_TIMESTEP);
    stepFlightDynamics(state, flown, CALM, PHYSICS_TIMESTEP);
  }
}

/** Where the pilot is looking, and which way is up in the picture. */
interface View {
  readonly forward: V.Vec3;
  readonly up: V.Vec3;
}

/**
 * Where the pilot is looking and which way is up in the picture.
 *
 * The same two vectors the camera rig builds: the FPV camera is mounted on the
 * nose looking up the body, so what the pilot calls rolling, pitching and
 * yawing are rotations about these and not about the airframe's own axes.
 */
function view(state: AircraftState): View {
  const tilt = buildRocketMesh().fpvCamera.tiltDegrees * DEG_TO_RAD;
  const forward = V.vec3();
  const up = V.vec3();
  rotateVector(
    forward,
    state.orientation,
    V.vec3(Math.cos(tilt), 0, Math.sin(tilt)),
  );
  rotateVector(
    up,
    state.orientation,
    V.vec3(-Math.sin(tilt), 0, Math.cos(tilt)),
  );
  return { forward, up };
}

/** How far the picture banked between two attitudes, degrees. */
function pictureRoll(before: View, after: View): number {
  const upright = V.vec3();
  V.addScaled(upright, after.up, after.forward, -V.dot(after.up, after.forward));
  V.normalize(upright, upright);
  const cross = V.vec3();
  V.cross(cross, before.up, upright);
  return (
    Math.atan2(V.dot(cross, after.forward), V.dot(before.up, upright)) *
    RAD_TO_DEG
  );
}

/** How far the picture swung sideways between two attitudes, degrees. */
function pictureSwing(before: View, after: View): number {
  const cross = V.vec3();
  V.cross(cross, before.forward, after.forward);
  return V.dot(cross, before.up) * RAD_TO_DEG;
}

/** Which way the aircraft is actually travelling, degrees. */
function track(state: AircraftState): number {
  return Math.atan2(state.velocity.x, state.velocity.y) * RAD_TO_DEG;
}

/** How far the airflow is off the nose, degrees. Zero is arriving on it. */
function offTheNose(state: AircraftState): number {
  return Math.hypot(
    state.angleOfAttack * RAD_TO_DEG + 90,
    state.sideslip * RAD_TO_DEG,
  );
}

export function runRocketTests(): void {
  suite("the X10 Interceptor, as it is delivered", () => {
    const config = STOCK.config;

    assert(
      config.rotor !== undefined,
      "it is flown by the multirotor model: there is no wing on it",
    );
    assertClose(
      config.mass,
      0.45,
      0.002,
      "450 g with four motors and the 1100 in it, which is the specification",
    );
    assertBetween(
      maxLevelSpeed(config),
      100,
      110,
      "and it holds 100-110 m/s in level flight, which is the other one",
    );
    assert(
      maxLevelSpeed(config) < config.neverExceedSpeed,
      "with the structural limit still above anything it will do level",
    );
    assertBetween(
      config.maxThrust / (config.mass * GRAVITY),
      12,
      17,
      "on the far side of twelve times its own weight in thrust",
    );
    assertBetween(
      hoverThrottle(config),
      0.2,
      0.35,
      "so it hovers low on the stick and has the rest of the travel to go",
    );

    // The number the specification sheet is sold on. It is a loiter figure
    // rather than a cruise one, which is what an interceptor's endurance is.
    assertBetween(
      cruiseEndurance(config, STOCK.motor, deliveredBattery(X10_INTERCEPTOR_UAV)) /
        60,
      8.5,
      11,
      "and the 1100 is about the ten minutes it is quoted at",
    );
    assertBetween(
      cruiseSpeed(config) * MS_TO_KMH,
      55,
      85,
      "at the speed one is actually loitered at rather than at half its top speed",
    );
  });

  suite("the fastest thing in the hangar, and the reason is its shape", () => {
    const others = UAVS.filter((uav) => uav.id !== X10_INTERCEPTOR_UAV.id);
    assert(
      others.every(
        (uav) =>
          maxLevelSpeed(resolveLoadout(uav, null).config) <
          maxLevelSpeed(STOCK.config),
      ),
      "nothing else here goes as fast, wing or rotorcraft",
    );
    assert(
      maxLevelSpeed(STOCK.config) >
        maxLevelSpeed(resolveLoadout(CA35_160_UAV, null).config) * 2.5,
      "and it is not close: two and a half times the racing quad's top speed",
    );

    const rotor = X10_INTERCEPTOR.rotor!;
    const quadRotor = CA35_160.rotor!;
    assert(
      rotor.axialArea < rotor.frontalArea / 5,
      "a body lying along the rotor axis is small nose-on and large broadside",
    );
    assert(
      quadRotor.axialArea > quadRotor.frontalArea,
      "where a flat quadcopter is the other way round, and always has been",
    );

    // The claim in one line: it is the shape and not the power system. Give
    // the same airframe a quadcopter's drag signature and it stops being fast.
    const flattened: AircraftConfig = {
      ...STOCK.config,
      rotor: {
        ...rotor,
        frontalArea: rotor.axialArea,
        axialArea: rotor.frontalArea,
      },
    };
    assert(
      maxLevelSpeed(flattened) < maxLevelSpeed(STOCK.config) * 0.65,
      "turn the two areas round and the same motors are worth a third less of it",
    );
  });

  suite("it flies nose-first, which is what the lean is for", () => {
    const slow = rotorTrim(STOCK.config, 15);
    const fast = rotorTrim(STOCK.config, maxLevelSpeed(STOCK.config));

    assert(
      fast.tilt * RAD_TO_DEG > 70,
      "flat out it leans past seventy degrees: it is pointing where it is going",
    );
    assert(
      slow.tilt < fast.tilt,
      "and standing much more upright when it is loitering",
    );
    assert(
      fast.inflow > maxLevelSpeed(STOCK.config) * 0.9,
      "so nearly all of its airspeed arrives straight down the propeller axis",
    );

    // What the trim solve has to get right for an airframe shaped like this.
    // Iterating "the drag, then the lean it implies" does not converge when the
    // two areas are a factor of eight apart — it hops between a shallow lean
    // and a steep one — so level flight has to be solved rather than settled
    // into. At every speed the sideways thrust and the drag agree exactly.
    for (const speed of [5, 12, 20, 35, 50, 70, 90, 100]) {
      assert(
        trimResidual(STOCK.config, speed) < 1e-6,
        `level flight balances at ${speed} m/s rather than nearly balancing`,
      );
    }
    assert(
      trimResidual(resolveLoadout(CA35_160_UAV, null).config, 25) < 1e-6,
      "and the quadcopter, which never had trouble with it, still does",
    );
  });

  suite("what is bolted to it decides which aircraft it is", () => {
    const stockSpeed = maxLevelSpeed(fitted("sr2306-2450-4.2x7", "6s-1100").config);
    const record = maxLevelSpeed(fitted("sr2306-2450-4.2x7.5", "6s-1100").config);
    const loiter = maxLevelSpeed(fitted("sr2306-1900-4.2x7", "6s-1100").config);

    assert(record > stockSpeed, "more pitch is more speed, as it always is");
    assertBetween(
      record * MS_TO_KMH,
      370,
      400,
      "and the record propeller is the top of the quoted band",
    );
    assert(
      loiter < stockSpeed,
      "the same motor turning more slowly is a slower aircraft",
    );
    assert(
      endurance("sr2306-1900-4.2x7", "6s-1100") >
        endurance("sr2306-2450-4.2x7", "6s-1100"),
      "and one that stays up longer, which is the whole point of it",
    );
    assert(
      [stockSpeed, record, loiter].every(
        (speed) => speed < X10_INTERCEPTOR.neverExceedSpeed,
      ),
      "and none of them will pull the pylons off it",
    );

    assert(
      endurance("sr2306-2450-4.2x7", "6s-850") <
        endurance("sr2306-2450-4.2x7", "6s-1300"),
      "a bigger pack is a longer flight, as far as the bay will take one",
    );
    assert(
      endurance("sr2306-2450-4.2x7", "6s-liion-3000") >
        endurance("sr2306-2450-4.2x7", "6s-1300") * 1.8,
      "and the lithium-ion is a different aircraft: twice the loiter",
    );
    assert(
      fitted("sr2306-2450-4.2x7", "6s-liion-3000").config.mass >
        fitted("sr2306-2450-4.2x7", "6s-850").config.mass * 1.25,
      "which is paid for in weight before it is paid for in anything else",
    );

    const sixCell = motorOrDefault(X10_INTERCEPTOR_UAV, "sr2306-2450-4.2x7");
    const eightCell = motorOrDefault(X10_INTERCEPTOR_UAV, "sr2306-1850-4.2x7");
    assert(
      batteriesFor(X10_INTERCEPTOR_UAV, sixCell).every(
        (pack) => pack.cells === 6,
      ),
      "a 6S combination is only offered the 6S packs",
    );
    assert(
      batteriesFor(X10_INTERCEPTOR_UAV, eightCell).every(
        (pack) => pack.cells === 8,
      ),
      "and the high-voltage conversion only the 8S one",
    );
    const eightCellPack = X10_INTERCEPTOR_UAV.batteries.find(
      (pack) => pack.cells === 8,
    )!;
    assert(
      !fitsMotor(sixCell, eightCellPack) && fitsMotor(eightCell, eightCellPack),
      "which is a cell count rather than a rule kept somewhere else",
    );
  });

  suite("and it is flown as what it is", () => {
    // Hovering: the throttle that holds a hover on paper holds one in the air.
    const hovering = rocket({ perfect: true });
    const height = hovering.position.z;
    fly(hovering, stick(hoverThrottle(STOCK.config)), 4);
    assertClose(
      hovering.position.z,
      height,
      2,
      "the hover throttle holds a hover, the way it does on any multirotor",
    );

    // Leaning it over and opening the throttle is the whole of going fast.
    const dash = rocket({ perfect: true, pitchDeg: -72, airspeed: 30 });
    fly(dash, stick(1), 14);
    assert(
      dash.airspeed > 85,
      "leaned over on full throttle it is past 300 km/h inside fifteen seconds",
    );
    assert(
      dash.airspeed < X10_INTERCEPTOR.neverExceedSpeed,
      "and still inside what the airframe is rated for",
    );

    // The fins. A quadcopter's drag couple is a few millimetres of build error
    // and four turning discs hold all of it out; this one's is a tail on an arm
    // fifteen times as long, which no disc is going to absorb.
    assert(
      X10_INTERCEPTOR.rotor!.dragCentreOffset < CA35_160.rotor!.dragCentreOffset,
      "its drag acts far below the weight, because the fins are down there",
    );
    const dead = rocket({ airspeed: 20, altitude: 900 });
    fly(dead, stick(0), 8);
    const nose = V.vec3();
    upAxis(nose, dead.orientation);
    assert(
      dead.velocity.z < -25,
      "with the motors stopped it is a falling object, like any multirotor",
    );
    assert(
      nose.z < -0.8,
      "and one that turns over and puts its nose down, which no quadcopter does",
    );
    assert(
      dead.airspeed > 40,
      "so it arrives nose-first and quickly rather than tumbling down flat",
    );
  });

  suite("the fins are what it flies on, not just what it dies on", () => {
    const rotor = X10_INTERCEPTOR.rotor!;
    assert(
      rotor.finDamping > 0 && CA35_160.rotor!.finDamping === 0,
      "an airframe with a tail is damped by the air; one without is not",
    );

    // The claim: with the motors running and the pilot off the sticks, the
    // nose comes back onto the flight path. Nothing else in the hangar that is
    // not a wing does this, and a quadcopter never does it at all.
    const knocked = dashing(95);
    fly(knocked, stick(rotorLevelThrottle(STOCK.config, 95)), 0.4);
    fly(knocked, stick(1, 0.35), 0.2);
    const thrown = offTheNose(knocked);
    assert(
      thrown > 25,
      "knock the nose well off the airflow with a pull and it is off it",
    );
    fly(knocked, stick(1), 1.2);
    assert(
      offTheNose(knocked) < thrown / 2,
      "and the fins put it back with the motors still running, which is what a weathercock is",
    );
    assert(
      knocked.airspeed > 80,
      "so it keeps its speed instead of crabbing broadside and losing it",
    );

    // And it settles rather than swinging about the airflow: a weathercock
    // without damping is a spring, and a spring rings.
    const kicked = dashing(95);
    fly(kicked, stick(rotorLevelThrottle(STOCK.config, 95)), 0.4);
    kicked.angularVelocity.y = 3;
    let worst = 0;
    for (let i = 0; i < 30; i += 1) {
      fly(kicked, stick(rotorLevelThrottle(STOCK.config, 95)), 0.05);
      if (i > 8) worst = Math.max(worst, V.length(kicked.angularVelocity));
    }
    assert(
      worst < 0.6,
      "a kick in the nose dies out inside a second rather than ringing on",
    );
  });

  suite("the sticks are the ones the pilot is looking down, not the airframe's", () => {
    const rotor = X10_INTERCEPTOR.rotor!;
    assertClose(
      rotor.stickMixDeg,
      buildRocketMesh().fpvCamera.tiltDegrees,
      0.001,
      "the mix is the camera's own mount angle, because that is what it is for",
    );
    assert(
      CA35_160.rotor!.stickMixDeg === 0,
      "and it is zero on a quadcopter, whose camera looks along the nose",
    );

    const throttle = rotorLevelThrottle(STOCK.config, 95);

    // The roll stick banks the horizon. On the raw body axes it would swing
    // the nose sideways instead, which is a rudder and not an aileron.
    const rolling = dashing(95);
    const rollController = acro();
    flyAssisted(rolling, rollController, stick(throttle), 0.5);
    const beforeRoll = view(rolling);
    flyAssisted(rolling, rollController, stick(1, 0, 0.5), 0.4);
    const afterRoll = view(rolling);
    const banked = pictureRoll(beforeRoll, afterRoll);
    assert(
      banked > 20,
      "half a second of roll stick banks the picture, the way it does on anything else",
    );
    assert(
      Math.abs(pictureSwing(beforeRoll, afterRoll)) < Math.abs(banked) / 4,
      "and barely swings it sideways, which is the half that used to be backwards",
    );
    assert(
      Math.abs(rolling.sideslip * RAD_TO_DEG) < 15,
      "so banking it no longer throws it forty degrees sideways through the air",
    );
    assert(
      rolling.airspeed > 90,
      "and the speed the run was made at survives the turn into it",
    );

    // The yaw stick is the other one: it swings the nose across the sky.
    const yawing = dashing(95);
    const yawController = acro();
    flyAssisted(yawing, yawController, stick(throttle), 0.5);
    const beforeYaw = view(yawing);
    const heldTrack = track(yawing);
    flyAssisted(yawing, yawController, stick(1, 0, 0, 0.5), 0.4);
    const afterYaw = view(yawing);
    assert(
      Math.abs(pictureSwing(beforeYaw, afterYaw)) >
        Math.abs(pictureRoll(beforeYaw, afterYaw)) * 2,
      "the rudder swings the nose rather than banking the horizon backwards",
    );
    assert(
      Math.abs(((track(yawing) - heldTrack + 540) % 360) - 180) > 5,
      "and it takes the aircraft with it, which is what a rudder is for",
    );

    // What the pilot asked for on the axis they asked for it about. The rates
    // belong to the aircraft, and the aircraft has to be able to deliver them.
    const rates = X10_INTERCEPTOR_UAV.defaultRates;
    const rated = dashing(95);
    const ratedController = acro();
    flyAssisted(rated, ratedController, stick(throttle), 0.5);
    const mix = rotor.stickMixDeg * DEG_TO_RAD;
    flyAssisted(rated, ratedController, stick(0.95, 0, 1), 1.5);
    const seen =
      rated.angularVelocity.x * RAD_TO_DEG * Math.cos(mix) -
      -rated.angularVelocity.z * RAD_TO_DEG * Math.sin(mix);
    assertClose(
      seen,
      rates.rollRate,
      rates.rollRate * 0.1,
      "acro holds the rate the sticks asked for, measured where the pilot sees it",
    );
  });

  suite("and it comes round a corner the way an aeroplane does", () => {
    const throttle = rotorLevelThrottle(STOCK.config, 95);
    const turning = dashing(95);
    const controller = acro();
    flyAssisted(turning, controller, stick(throttle), 0.5);
    const entry = track(turning);

    // Bank, then pull — which is the only way to turn an airframe whose
    // thrust points out of its nose, and which is what the stick frame above
    // is there to make possible.
    flyAssisted(turning, controller, stick(1, 0, 1), 0.3);
    flyAssisted(turning, controller, stick(1, 0.25), 1.8);
    const turned = Math.abs(((track(turning) - entry + 540) % 360) - 180);
    assert(
      turned > 70,
      "bank and pull and it comes round: seventy degrees of it inside two seconds",
    );
    assert(
      Math.abs(turning.sideslip * RAD_TO_DEG) < 15,
      "with the nose on the flight path rather than crabbed thirty degrees off it",
    );
    assert(
      turning.airspeed > 75,
      "and still fast enough at the end of it to be an interceptor",
    );

    // Pull harder and it comes round tighter, for speed. Which sounds obvious
    // and was not true of an airframe with no fins and the sticks crossed: the
    // turn barely answered the stick at all.
    const radius = (pull: number): number => {
      const state = dashing(95);
      const loop = acro();
      flyAssisted(state, loop, stick(throttle), 0.5);
      const from = track(state);
      const start = { ...state.position };
      flyAssisted(state, loop, stick(1, 0, 1), 0.3);
      for (let i = 0; i < 160; i += 1) {
        flyAssisted(state, loop, stick(1, pull), 0.05);
        if (Math.abs(((track(state) - from + 540) % 360) - 180) >= 89) break;
      }
      return Math.hypot(state.position.x - start.x, state.position.y - start.y);
    };
    assert(
      radius(0.4) < radius(0.15) * 0.8,
      "a harder pull is a tighter corner, which is the whole of flying one",
    );
  });

  suite("it stands on its tail, on the ground as well as in the frame", () => {
    const contact = groundContactFor(STOCK.config);
    assert(
      contact === ROCKET_GROUND_CONTACT,
      "the airframe says how it sits rather than being told",
    );
    assert(
      contact.restHeight > groundContactFor(CA35_160).restHeight * 4,
      "a quadcopter's forty-five millimetres would bury half the body in the field",
    );
    assertClose(
      contact.restHeight,
      0.222,
      0.005,
      "it rests on the fins, which is where the bottom of the aircraft is",
    );

    const launch = groundLaunch(STOCK.config);
    assert(
      launch.grounded && !launch.held && launch.throttle === 0,
      "and it is put down on the grass rather than thrown, like any multirotor",
    );
    assertClose(
      launch.altitudeAgl,
      contact.restHeight,
      1e-9,
      "standing at the height it settles at, so the first frame is the settled one",
    );
  });

  suite("the rocket has geometry of its own", () => {
    const mesh = buildRocketMesh();

    assert(
      meshKindFor(X10_INTERCEPTOR) === MESH_KIND.Rocket,
      "a rotor block says how an aircraft flies, not what it looks like",
    );
    assert(
      meshKindFor(CA35_160) === MESH_KIND.Quad &&
        meshKindFor(PLAYER_WING) === MESH_KIND.Wing,
      "and everything else still says what it is",
    );
    assert(mesh.kind === MESH_KIND.Rocket, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      X10_INTERCEPTOR.wingSpan,
      0.005,
      "drawn at the width the airframe actually is",
    );

    const bounds = (parts: readonly { positions: Float64Array }[]) => {
      let minZ = Infinity;
      let maxZ = -Infinity;
      let widest = 0;
      for (const part of parts) {
        for (let i = 0; i < part.positions.length; i += 3) {
          const x = part.positions[i] ?? 0;
          const y = part.positions[i + 1] ?? 0;
          const z = part.positions[i + 2] ?? 0;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          widest = Math.max(widest, Math.hypot(x, y));
        }
      }
      return { minZ, maxZ, widest };
    };
    const body = bounds(mesh.parts);
    assertClose(
      body.maxZ - body.minZ,
      X10_INTERCEPTOR.chord,
      0.02,
      "560 mm of aircraft from the nose to the fins",
    );
    assert(
      body.maxZ - body.minZ > body.widest * 3,
      "lying along the rotor axis rather than across it, as nothing else here does",
    );
    assertClose(
      -body.minZ,
      ROCKET_GROUND_CONTACT.restHeight,
      0.005,
      "with the fins exactly where the ground model rests it on them",
    );

    assert(mesh.propellers.length === 4, "four rotors, on four pylons");
    assert(
      mesh.propellers.every((group) => group.axis === "z"),
      "all turning about the body axis, the way a multirotor's do",
    );
    assert(
      mesh.propellers.filter((group) => group.direction > 0).length === 2,
      "two each way, so it has no torque to hold out",
    );
    assert(
      mesh.propellers.every(
        (group) =>
          Math.abs(Math.hypot(group.origin[0], group.origin[1]) - 0.115) < 0.001,
      ),
      "out at the arm length the flight model is given",
    );
    assert(
      mesh.elevonParts.left.length === 0 && mesh.elevonParts.right.length === 0,
      "nothing hinges on it: it is steered by its own rotors",
    );
    assert(
      mesh.staticParts === mesh.parts,
      "so the airframe drawn at a distance is the same one",
    );

    assert(
      mesh.fpvCamera.offset[2] > 0.25,
      "the camera is in the nose, where the photographs put it",
    );
    assertBetween(
      mesh.fpvCamera.tiltDegrees,
      55,
      80,
      "looking along the body rather than out of the side of it",
    );
    assert(
      mesh.fpvCamera.tiltDegrees > rotorTrim(STOCK.config, 40).tilt * RAD_TO_DEG,
      "which is a view of the sky in a hover and of the horizon in the dash",
    );

    // Every part is a closed solid wound the right way out. A single inverted
    // panel is invisible until something culls back faces, and then it is a
    // hole in the aircraft.
    for (const part of [
      ...mesh.parts,
      ...mesh.propellers.flatMap((group) => group.parts),
    ]) {
      let volume = 0;
      for (let t = 0; t < part.indices.length; t += 3) {
        const corner = (k: number): [number, number, number] => {
          const i = (part.indices[t + k] ?? 0) * 3;
          return [
            part.positions[i] ?? 0,
            part.positions[i + 1] ?? 0,
            part.positions[i + 2] ?? 0,
          ];
        };
        const [a, b, c] = [corner(0), corner(1), corner(2)];
        volume +=
          (a[0] * (b[1] * c[2] - b[2] * c[1]) -
            a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0])) /
          6;
      }
      assert(volume > 0, `${part.name} is wound outwards rather than inside out`);
    }

    assert(
      previewTriangles({
        kind: MESH_KIND.Rocket,
        width: 320,
        height: 240,
        azimuthDeg: 35,
        elevationDeg: 12,
      }).length > 0,
      "and the workbench can draw a picture of it",
    );
  });

  suite("and it sounds like four two-bladed propellers at forty thousand", () => {
    const profile = engineProfileFor(X10_INTERCEPTOR);
    assert(profile.blades === 2, "two blades, as they are on the propellers");

    const rocketTone = engineSound(1, 0, profile);
    const quadTone = engineSound(1, 0, engineProfileFor(CA35_160));
    const wingTone = engineSound(1, 0, engineProfileFor(PLAYER_WING));
    assert(
      rocketTone.frequency < quadTone.frequency,
      "bigger propellers turning more slowly sit under a racing quad's scream",
    );
    assert(
      rocketTone.frequency > wingTone.frequency * 2,
      "and a long way over any wing's hum",
    );
  });
}
