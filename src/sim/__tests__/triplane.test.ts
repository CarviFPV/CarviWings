import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  CA35_160,
  FOAM_GLIDER,
  FT_TRIPLANE_XL,
  GRAVITY,
  PLAYER_WING,
  SKYEYE_2600,
  SKYWALKER_X8,
} from "../flight/config";
import type { AircraftConfig } from "../flight/config";
import {
  FT_TRIPLANE_XL_UAV,
  INTERCEPTOR_WING,
  batteriesFor,
  deliveredBattery,
  deliveredMotor,
  resolveLoadout,
} from "../flight/uav";
import {
  PHYSICS_TIMESTEP,
  cruiseEndurance,
  liftCoefficient,
  maxLevelSpeed,
  stallSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import {
  fitsMotor,
  motorDemandAmps,
  nominalVoltage,
  staticThrust,
} from "../flight/powerplant";
import {
  GROUND_CONTACT,
  TOUCHDOWN_LIMITS,
  WHEELED_TOUCHDOWN_LIMITS,
  groundContactFor,
  stepGroundContact,
  touchdownLimitsFor,
  wheeledGroundContact,
} from "../flight/ground";
import { groundLaunch } from "../flight/launch";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import { MS_TO_KMH } from "../flight/telemetry";
import {
  TRIPLANE_ENGINE,
  WING_ENGINE,
  engineProfileFor,
  engineSound,
} from "../audio/soundModel";
import {
  MESH_KIND,
  MESH_TRIPLANE_SPAN,
  buildTriplaneMesh,
  meshKindFor,
} from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The aeroplane as the kit is sold: the FT 2814 on a 12x4.5 and a 3S 3300. */
const STOCK = resolveLoadout(FT_TRIPLANE_XL_UAV, null);

function fitted(motorId: string, batteryId: string) {
  return resolveLoadout(FT_TRIPLANE_XL_UAV, {
    motor: motorId,
    battery: batteryId,
  });
}

function endurance(motorId: string, batteryId: string): number {
  const loadout = fitted(motorId, batteryId);
  const pack = loadout.battery ?? deliveredBattery(FT_TRIPLANE_XL_UAV);
  return cruiseEndurance(loadout.config, loadout.motor, pack);
}

/** Span squared over area, which on a triplane is not one wing's. */
function aspectRatio(config: AircraftConfig): number {
  return (config.wingSpan * config.wingSpan) / config.wingArea;
}

function wingLoading(config: AircraftConfig): number {
  return config.mass / config.wingArea;
}

function aircraft(
  config: AircraftConfig,
  overrides: Partial<{
    airspeed: number;
    throttle: number;
    altitude: number;
    pitchDeg: number;
  }> = {},
): AircraftState {
  return createAircraftState({
    id: "triplane",
    role: AIRCRAFT_ROLE.Player,
    config,
    position: V.vec3(0, 0, overrides.altitude ?? 400),
    headingDeg: 0,
    pitchDeg: overrides.pitchDeg ?? 0,
    rollDeg: 0,
    airspeed: overrides.airspeed ?? 0,
    throttle: overrides.throttle ?? 0,
    powerplant: null,
  });
}

function stick(pitch = 0, roll = 0, throttle = 0): FlightInput {
  const input = createFlightInput();
  input.pitch = pitch;
  input.roll = roll;
  input.throttle = throttle;
  return input;
}

function fly(
  state: AircraftState,
  input: FlightInput,
  seconds: number,
  tap?: (state: AircraftState) => void,
): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
    if (tap) tap(state);
  }
}

/**
 * Ground covered before an aeroplane on wheels leaves the surface, metres.
 *
 * The flight model integrated as the engine integrates it: aerodynamics first,
 * then the constraint that holds the aircraft on the ground and scrubs its
 * speed. Nothing here knows about taking off — it is a landing run with the
 * throttle open, which is the whole point.
 */
function takeOffRun(config: AircraftConfig): number {
  const contact = groundContactFor(config);
  const launch = groundLaunch(config);
  const state = aircraft(config, {
    altitude: launch.altitudeAgl,
    pitchDeg: launch.pitchDeg,
  });
  const open = stick(0, 0, 1);
  const steps = Math.round(30 / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, open, CALM, PHYSICS_TIMESTEP);
    stepGroundContact(state, 0, V.UP, open.pitch, PHYSICS_TIMESTEP, contact);
    if (state.position.z > contact.restHeight + 0.5) break;
  }
  return Math.hypot(state.position.x, state.position.y);
}

export function runTriplaneTests(): void {
  suite("the FT Triplane XL is the aeroplane on the box", () => {
    const config = STOCK.config;

    assertClose(
      config.wingSpan,
      1.232,
      1e-9,
      "48.5 inches across the top wing, which is what the kit is sold by",
    );
    assertClose(
      config.mass,
      1.758,
      0.005,
      "and 1.76 kg with the FT 2814 on the front and the 3300 mAh 3S in it",
    );
    assertClose(
      deliveredMotor(FT_TRIPLANE_XL_UAV).propDiameter,
      12,
      1e-9,
      "on the 12-inch propeller the kit specifies",
    );
    assertClose(
      deliveredBattery(FT_TRIPLANE_XL_UAV).capacityMah,
      3300,
      1e-9,
      "and the 3300 mAh pack it specifies with it",
    );

    assertBetween(
      stallSpeed(config) * MS_TO_KMH,
      21,
      27,
      "it stalls at a walking pace, which is what nine ounces to the foot buys",
    );
    assertBetween(
      maxLevelSpeed(config) * MS_TO_KMH,
      50,
      62,
      "and it is the slowest thing here flat out, at about 55 km/h",
    );
    assert(
      maxLevelSpeed(config) < maxLevelSpeed(FOAM_GLIDER),
      "slower than the 141 g toy beside it, with fourteen times its weight",
    );
    assert(
      maxLevelSpeed(config) < config.neverExceedSpeed,
      "though nowhere near fast enough to pull the struts out of it",
    );
    assertBetween(
      config.maxThrust / (config.mass * GRAVITY),
      1.35,
      1.65,
      "and it is over-powered, as the listing says: half its own weight again in thrust",
    );

    // Flite Test quote over ten minutes on a charge. That is a flight being
    // flown rather than a steady cruise, so the cruise figure is the longer of
    // the two and the published one is the floor.
    assert(
      endurance(
        deliveredMotor(FT_TRIPLANE_XL_UAV).id,
        deliveredBattery(FT_TRIPLANE_XL_UAV).id,
      ) >
        10 * 60,
      "the 3300 is the ten minutes and better that it is sold on",
    );
  });

  suite("three wings are not one wing carried three times", () => {
    const config = STOCK.config;

    assertClose(
      config.wingArea,
      0.66,
      1e-9,
      "0.66 m^2 of wing, which is more than the 2.1 m survey wing has",
    );
    assert(
      config.wingArea > PLAYER_WING.wingArea * 1.5,
      "half again what the 1.4 m delta beside it has, on a shorter span",
    );
    assert(
      config.wingArea / config.wingSpan >
        SKYWALKER_X8.wingArea / SKYWALKER_X8.wingSpan,
      "and more wing per metre of span than the 2.1 m survey wing",
    );
    assertBetween(
      aspectRatio(config),
      2.1,
      2.5,
      "so the aspect ratio of the whole aeroplane is barely two and a half",
    );
    for (const other of [PLAYER_WING, SKYWALKER_X8, FOAM_GLIDER, SKYEYE_2600]) {
      assert(
        aspectRatio(config) < aspectRatio(other),
        `which is stubbier than the ${other.name}`,
      );
    }

    for (const other of [PLAYER_WING, SKYWALKER_X8, FOAM_GLIDER, SKYEYE_2600]) {
      assert(
        wingLoading(config) < wingLoading(other),
        `so it is more lightly loaded than the ${other.name}`,
      );
    }

    // The reason anybody ever built one. Three wings one above another shed
    // less vortex between them than a single wing of the same total area on
    // the same span would, so the induced drag comes out below even the
    // ideal monoplane figure of 1/(pi AR) rather than some way above it.
    assert(
      config.inducedDragFactor < 1 / (Math.PI * aspectRatio(config)),
      "three stacked wings cost less in induced drag than one of this shape would",
    );
    assert(
      config.inducedDragFactor > PLAYER_WING.inducedDragFactor,
      "which is still the most of anything here, because the shape is stubby",
    );

    for (const other of [PLAYER_WING, SKYWALKER_X8, FOAM_GLIDER]) {
      assert(
        config.cd0 > other.cd0,
        `and it is dirtier than the ${other.name}, as struts and wheels are`,
      );
    }
    assert(
      config.cd0 < SKYEYE_2600.cd0,
      "though not as dirty as the smallest Skyeye, which is this much" +
        " fuselage on a third of the wing",
    );
  });

  suite("the hardware is the kit's, and the propeller is the aeroplane", () => {
    const uav = FT_TRIPLANE_XL_UAV;

    assert(
      fitsMotor(deliveredMotor(uav), deliveredBattery(uav)),
      "it is delivered with a pack its own motor will run",
    );
    for (const motor of uav.motors) {
      for (const pack of batteriesFor(uav, motor)) {
        assert(
          motorDemandAmps(motor, pack) <= motor.escAmps,
          `${motor.id} stays inside the controller it is fitted with`,
        );
      }
      assert(
        motor.propDiameter >= 10,
        `${motor.id} swings a propeller a foot across, as this aeroplane does`,
      );
    }

    // Nothing changes on this airframe but the blade, and the blade is what
    // decides whether it is a short-field aeroplane or a fast one.
    const stockTop = maxLevelSpeed(STOCK.config);
    const slow = fitted("ft2814-900-13x4", "3s-3300");
    const quick = fitted("ft2814-1100-11x5.5", "3s-3300");
    const fourCell = fitted("2814-800-12x6-4s", "4s-3300");

    assert(
      maxLevelSpeed(slow.config) < stockTop,
      "the big slow 13x4 gives up the top end",
    );
    assert(
      endurance("ft2814-900-13x4", "3s-3300") >
        endurance("ft2814-1100-12x4.5", "3s-3300"),
      "and buys a much longer flight with what it saves",
    );
    assert(
      maxLevelSpeed(quick.config) > stockTop,
      "the 11x5.5 is the other trade: less pull, more speed",
    );
    assert(
      maxLevelSpeed(fourCell.config) > maxLevelSpeed(quick.config),
      "and the four-cell conversion is the fastest of them",
    );
    assert(
      staticThrust(slow.motor, nominalVoltage(deliveredBattery(uav))) <
        STOCK.config.maxThrust,
      "none of which is the motor getting bigger — it is the same 2814 throughout",
    );

    const light = fitted("ft2814-1100-12x4.5", "3s-2200");
    const heavy = fitted("ft2814-1100-12x4.5", "3s-5000");
    assert(
      light.config.mass < STOCK.config.mass &&
        heavy.config.mass > STOCK.config.mass,
      "a pack is weight before it is anything else",
    );
    assert(
      stallSpeed(light.config) < stallSpeed(heavy.config),
      "so the pack decides how slowly the aeroplane can be flown",
    );
  });

  suite("it stands on a skid rather than a nosewheel", () => {
    const config = STOCK.config;
    const contact = groundContactFor(config);

    assertClose(
      config.undercarriage === "taildragger" ? 1 : 0,
      1,
      1e-9,
      "the airframe says which kind of undercarriage it has",
    );
    assertClose(
      contact.restHeight,
      config.wingSpan / 4.8,
      1e-9,
      "and it stands a fifth of its span up, on the middle wing",
    );
    assert(
      contact.friction < GROUND_CONTACT.friction / 4,
      "two wheels and a skid roll rather than scrub",
    );
    assert(
      contact.friction > wheeledGroundContact(config).friction,
      "though not as freely as three wheels do, because one of the three is a skid",
    );

    // The whole of what a taildragger is: it sits at most of the incidence the
    // wing has, and the elevator has nothing left to pull it up to.
    assertClose(
      contact.rotateRange,
      0,
      1e-9,
      "back stick cannot rotate it any further: it is already on its tail",
    );
    assert(
      (contact.pushRange ?? 0) > 0,
      "forward stick is the useful direction, and it puts the tail up",
    );
    assert(
      contact.restPitch > config.stallAngle * 0.7,
      "so it is parked at most of the incidence the wing has to give",
    );
    assert(
      contact.restPitch > wheeledGroundContact(config).restPitch * 3,
      "which is nothing like the attitude a nosewheel holds an aeroplane at",
    );

    const launch = groundLaunch(config);
    assert(
      launch.grounded && !launch.held,
      "a flight begins standing on a field rather than in somebody's hand",
    );
    assertClose(
      launch.pitchDeg,
      12,
      0.01,
      "nose-up on the gear before anything has moved",
    );
    assertClose(
      launch.throttle,
      0,
      1e-9,
      "with the motor stopped, which on an electric aeroplane is stopped",
    );
  });

  suite("and it is flying before a runway has really begun", () => {
    const config = STOCK.config;
    const contact = groundContactFor(config);

    // Sitting still it is already at flying incidence, so the speed it needs
    // is the speed at which that incidence carries it — not the speed at
    // which somebody can haul the nose up to find it.
    const cl = liftCoefficient(config, contact.restPitch);
    const liftOff = Math.sqrt(
      (2 * config.mass * GRAVITY) / (1.225 * config.wingArea * cl),
    );
    assertBetween(
      liftOff * MS_TO_KMH,
      22,
      32,
      "the wing carries it at about 26 km/h in the attitude it is parked in",
    );
    assert(
      config.maxThrust > contact.friction * config.mass * GRAVITY * 15,
      "and there is fifteen times the thrust the wheels cost to roll",
    );

    const run = takeOffRun(config);
    assertBetween(
      run,
      3,
      25,
      `it is off the ground in a few metres (${run.toFixed(1)} m)`,
    );
    assert(
      run < takeOffRun(SKYEYE_2600) / 5,
      "a fraction of what the smallest aeroplane on a nosewheel needs",
    );
  });

  suite("and it arrives on the wheels it left on", () => {
    const config = STOCK.config;
    assert(
      touchdownLimitsFor(config) === WHEELED_TOUCHDOWN_LIMITS,
      "an undercarriage is an undercarriage, whichever way round it is",
    );
    assert(
      WHEELED_TOUCHDOWN_LIMITS.groundSpeed > maxLevelSpeed(config) * 2,
      "nothing this aeroplane can reach in level flight is too fast to land",
    );
    assert(
      touchdownLimitsFor(config).bank < TOUCHDOWN_LIMITS.bank,
      "and putting a wing down on a landing gear is still worse than on a belly",
    );
  });

  suite("it flies like something from 1917", () => {
    const config = STOCK.config;

    // Deliberate in roll and quick everywhere else, which is what ailerons on
    // one wing of three come to.
    const rolling = aircraft(config, { airspeed: 13, throttle: 0.5 });
    fly(rolling, stick(0, 0, 0.5), 2);
    let peakRoll = 0;
    fly(rolling, stick(0, 1, 0.5), 3, (state) => {
      peakRoll = Math.max(peakRoll, Math.abs(state.angularVelocity.x));
    });
    const rollDeg = (peakRoll * 180) / Math.PI;
    assertBetween(
      rollDeg,
      70,
      150,
      `it rolls at about a hundred degrees a second (${rollDeg.toFixed(0)})`,
    );
    assert(
      rollDeg < INTERCEPTOR_WING.defaultRates.rollRate / 2,
      "less than half what the delta beside it will do, and it is not a fault",
    );

    // Pitch is the other half of the aeroplane. Full back stick at full
    // throttle from the top speed is a loop, in its own length.
    const looping = aircraft(config, {
      airspeed: maxLevelSpeed(config),
      throttle: 1,
    });
    let rotated = 0;
    let peakHeight = -Infinity;
    fly(looping, stick(1, 0, 1), 8, (state) => {
      rotated += state.angularVelocity.y * PHYSICS_TIMESTEP;
      peakHeight = Math.max(peakHeight, state.position.z);
    });
    assert(
      Math.abs(rotated) > 2 * Math.PI,
      "it comes all the way round in a loop and keeps going",
    );
    assertBetween(
      peakHeight - 400,
      6,
      40,
      "in a loop small enough to fly in a park",
    );

    // And it can be parked at an angle of attack that would have put any other
    // wing here on its back an age ago.
    const slow = aircraft(config, { airspeed: 8 });
    let peakAlpha = 0;
    fly(slow, stick(1, 0, 0), 6, (state) => {
      peakAlpha = Math.max(peakAlpha, state.angleOfAttack);
    });
    assert(
      peakAlpha > config.stallAngle * 2,
      "high alpha is somewhere it goes rather than somewhere it falls out of",
    );
  });

  suite("the triplane has geometry of its own", () => {
    assert(
      meshKindFor(FT_TRIPLANE_XL) === MESH_KIND.Triplane,
      "the airframe says what it is drawn as",
    );
    assert(
      meshKindFor(CA35_160) === MESH_KIND.Quad &&
        meshKindFor(PLAYER_WING) === MESH_KIND.Wing,
      "and nothing else has been dragged along with it",
    );

    const mesh = buildTriplaneMesh();
    assert(mesh.kind === MESH_KIND.Triplane, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      FT_TRIPLANE_XL.wingSpan,
      1e-9,
      "drawn at the span the airframe actually is, so it scales by one",
    );
    assertClose(
      MESH_TRIPLANE_SPAN,
      1.232,
      1e-9,
      "which is the 48.5 inches across the top wing",
    );

    // Three wings, and the check is that there are three: sort every vertex on
    // the wing skins by height and there should be three bands of them, one a
    // fifth of a metre above the next.
    const skins = mesh.parts.filter(
      (part) => part.name === "triplane-top" || part.name === "triplane-bottom",
    );
    assert(skins.length === 2, "the wings are lofted top surface and bottom");
    const heights = new Set<number>();
    for (const part of skins) {
      for (let i = 2; i < part.positions.length; i += 3) {
        heights.add(Math.round((part.positions[i] ?? 0) * 20) / 20);
      }
    }
    const bands = [...heights].sort((a, b) => a - b);
    const gaps = bands.filter(
      (z, i) => i > 0 && z - (bands[i - 1] ?? 0) > 0.1,
    ).length;
    assert(
      gaps === 2,
      `the skins fall into three separate wings (${gaps + 1} found)`,
    );

    // It has to stand on the ground the ground model rests it on, or it is
    // drawn hovering over the field or buried in it.
    const contact = groundContactFor(FT_TRIPLANE_XL);
    let lowest = Infinity;
    for (const part of mesh.staticParts) {
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const x = part.positions[i] ?? 0;
        const z = part.positions[i + 2] ?? 0;
        lowest = Math.min(
          lowest,
          x * Math.sin(contact.restPitch) + z * Math.cos(contact.restPitch),
        );
      }
    }
    assertClose(
      lowest,
      -contact.restHeight,
      0.005,
      "the wheels and the skid touch the ground exactly where it is rested",
    );

    assert(
      mesh.propellers.length === 1 && mesh.propellers[0]?.axis === "x",
      "one tractor propeller on the nose, turning about the body's forward axis",
    );
    assert(
      (mesh.propellers[0]?.origin[0] ?? 0) > 0.4,
      "which is in front of everything else on the aeroplane",
    );
    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "and an elevator a side that the flight model moves",
    );
    assert(
      mesh.fpvCamera.offset[0] < 0 && mesh.fpvCamera.offset[2] > 0.08,
      "the camera sits in the cockpit, behind the middle wing and above the decking",
    );
    assert(mesh.triangleCount > 800, "there is an aeroplane there to look at");

    const picture = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.Triplane,
    });
    assert(picture.length > 200, "and the workbench can draw a picture of it");
  });

  suite("and it hums where everything else here buzzes", () => {
    assert(
      engineProfileFor(FT_TRIPLANE_XL) === TRIPLANE_ENGINE,
      "the airframe says what it sounds like",
    );

    const open = engineSound(1, 12, TRIPLANE_ENGINE);
    const shut = engineSound(0, 12, TRIPLANE_ENGINE);
    assertBetween(
      open.frequency,
      320,
      380,
      `a foot of propeller at ten thousand is a hum (${open.frequency.toFixed(
        0,
      )} Hz)`,
    );
    assert(
      open.frequency < engineSound(1, 12, WING_ENGINE).frequency,
      "under a foam wing's note, because the propeller is half again the size",
    );
    assert(
      TRIPLANE_ENGINE.maxRpm < WING_ENGINE.maxRpm,
      "and it gets there by turning more slowly rather than by having fewer blades",
    );
    assert(
      shut.gain < open.gain / 2,
      "with the stick down it is a glider, because the motor has stopped",
    );
  });
}
