import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  CA35_160,
  FOAM_GLIDER,
  FT_BABY_BLENDER,
  FT_C47,
  FT_JENNY_XL,
  FT_P38_LIGHTNING,
  FT_TRIPLANE_XL,
  GRAVITY,
  PLAYER_WING,
  SKYWALKER_X8,
} from "../flight/config";
import type { AircraftConfig } from "../flight/config";
import {
  FT_JENNY_XL_UAV,
  FT_TRIPLANE_XL_UAV,
  UAVS,
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
  TOUCHDOWN_LIMITS,
  WHEELED_TOUCHDOWN_LIMITS,
  groundContactFor,
  stepGroundContact,
  touchdownLimitsFor,
} from "../flight/ground";
import { groundLaunch } from "../flight/launch";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import { MS_TO_KMH } from "../flight/telemetry";
import {
  TRIPLANE_ENGINE,
  engineProfileFor,
  engineSound,
} from "../audio/soundModel";
import {
  MESH_JENNY_SPAN,
  MESH_KIND,
  buildJennyMesh,
  meshKindFor,
} from "../render/aircraftMesh";
import type { MeshPart } from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import { rightAxis } from "../math/quat";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The aeroplane as the kit asks for it: the XL Power Pack and a 3S 3300. */
const STOCK = resolveLoadout(FT_JENNY_XL_UAV, null);

function fitted(motorId: string, batteryId: string) {
  return resolveLoadout(FT_JENNY_XL_UAV, {
    motor: motorId,
    battery: batteryId,
  });
}

function endurance(motorId: string, batteryId: string): number {
  const loadout = fitted(motorId, batteryId);
  const pack = loadout.battery ?? deliveredBattery(FT_JENNY_XL_UAV);
  return cruiseEndurance(loadout.config, loadout.motor, pack);
}

/** Span squared over area, which on a biplane is not one wing's. */
function aspectRatio(config: AircraftConfig): number {
  return (config.wingSpan * config.wingSpan) / config.wingArea;
}

function wingLoading(config: AircraftConfig): number {
  return config.mass / config.wingArea;
}

/** Thrust as a multiple of what the aeroplane weighs. */
function thrustToWeight(config: AircraftConfig): number {
  return config.maxThrust / (config.mass * GRAVITY);
}

function staticMargin(config: AircraftConfig): number {
  return -config.cmAlpha / config.clAlpha;
}

function aircraft(
  config: AircraftConfig,
  overrides: Partial<{
    airspeed: number;
    throttle: number;
    altitude: number;
    pitchDeg: number;
    rollDeg: number;
  }> = {},
): AircraftState {
  return createAircraftState({
    id: "jenny",
    role: AIRCRAFT_ROLE.Player,
    config,
    position: V.vec3(0, 0, overrides.altitude ?? 400),
    headingDeg: 0,
    pitchDeg: overrides.pitchDeg ?? 0,
    rollDeg: overrides.rollDeg ?? 0,
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

/** Bank angle in degrees, right wing down positive. */
function bankDeg(state: AircraftState): number {
  const right = V.vec3();
  rightAxis(right, state.orientation);
  return (Math.asin(Math.max(-1, Math.min(1, -right.z))) * 180) / Math.PI;
}

/** Roll rate the airframe reaches on full aileron, degrees a second. */
function peakRollRate(config: AircraftConfig, airspeed: number): number {
  const rolling = aircraft(config, { airspeed, throttle: 0.5 });
  fly(rolling, stick(0, 0, 0.5), 2);
  let peak = 0;
  fly(rolling, stick(0, 1, 0.5), 3, (state) => {
    peak = Math.max(peak, Math.abs(state.angularVelocity.x));
  });
  return (peak * 180) / Math.PI;
}

/**
 * Ground covered before an aeroplane on wheels leaves the surface, metres.
 *
 * The flight model integrated as the engine integrates it: aerodynamics first,
 * then the constraint that holds the aircraft on the ground. Nothing here knows
 * about taking off — it is a landing run with the throttle open.
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

function vertices(parts: readonly MeshPart[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const part of parts) {
    for (let i = 0; i + 2 < part.positions.length; i += 3) {
      out.push([
        part.positions[i] ?? 0,
        part.positions[i + 1] ?? 0,
        part.positions[i + 2] ?? 0,
      ]);
    }
  }
  return out;
}

/** Every winged aircraft in the hangar but this one. */
const OTHER_WINGS = UAVS.filter(
  (uav) => uav.id !== FT_JENNY_XL_UAV.id && !uav.config.rotor,
).map((uav) => resolveLoadout(uav, null).config);

export function runJennyTests(): void {
  suite("the FT Jenny XL is the aeroplane on the box", () => {
    const config = STOCK.config;
    const motor = deliveredMotor(FT_JENNY_XL_UAV);
    const pack = deliveredBattery(FT_JENNY_XL_UAV);

    assertClose(
      config.wingSpan,
      58.5 * 0.0254,
      0.001,
      "58.5 inches across, which is what the kit is sold by",
    );
    assert(
      motor.motor === "FT 2814 KV1100" &&
        motor.propDiameter === 12 &&
        motor.propPitch === 4.5,
      "an FT 2814 KV1100 on the 12x4.5 the listing names",
    );
    assert(
      pack.cells === 3 && pack.capacityMah === 3300,
      "and the 3300 mAh three-cell pack it asks for",
    );

    // The kit quotes 2.7 lb with the battery in it. What is left over is the
    // camera and transmitter that make it one of these.
    const KIT = 2.7 * 0.45359237;
    assertBetween(
      config.mass - KIT,
      0.015,
      0.035,
      "which is the kit's 2.7 lb plus the FPV gear that makes it one of these",
    );

    const stall = stallSpeed(config) * MS_TO_KMH;
    assertBetween(
      stall,
      18,
      23,
      `it stalls at about 20 km/h, which is the "delightfully slow" on the box (${stall.toFixed(
        1,
      )})`,
    );
    for (const other of OTHER_WINGS) {
      assert(
        stallSpeed(config) < stallSpeed(other),
        `slower than the ${other.name}, which is every other wing in the hangar`,
      );
    }
    const top = maxLevelSpeed(config) * MS_TO_KMH;
    assertBetween(
      top,
      52,
      62,
      `and it will not do much over 57 km/h on the kit's blade (${top.toFixed(
        1,
      )})`,
    );
    assert(
      maxLevelSpeed(config) < config.neverExceedSpeed,
      "nowhere near fast enough in level flight to pull the wires out of it",
    );

    // Flite Test quote eight to ten minutes, which is a flight flown on the
    // throttle. Held at a steady cruise the same pack goes rather further.
    const minutes = endurance(motor.id, pack.id) / 60;
    assertBetween(
      minutes,
      10,
      25,
      `the 3300 is a long flight at a cruise (${minutes.toFixed(0)} minutes)`,
    );
  });

  suite("it is the triplane's power on half a kilo less aeroplane", () => {
    const config = STOCK.config;
    const ours = deliveredMotor(FT_JENNY_XL_UAV);
    const theirs = deliveredMotor(FT_TRIPLANE_XL_UAV);

    assert(
      ours.motor === theirs.motor &&
        ours.kv === theirs.kv &&
        ours.propDiameter === theirs.propDiameter &&
        ours.propPitch === theirs.propPitch,
      "the XL Power Pack is the triplane's motor on the triplane's blade",
    );
    assertClose(
      config.maxThrust,
      FT_TRIPLANE_XL.maxThrust,
      0.1,
      "so it makes the triplane's thrust",
    );
    assert(
      FT_TRIPLANE_XL.mass - config.mass > 0.45,
      "on an aeroplane half a kilo lighter",
    );
    assertBetween(
      thrustToWeight(config),
      1.9,
      2.3,
      "which is twice its own weight in static thrust",
    );
    assert(
      thrustToWeight(config) > thrustToWeight(FT_TRIPLANE_XL),
      "and more of it than the triplane has",
    );
    assertClose(
      config.maxThrust,
      staticThrust(
        deliveredMotor(FT_JENNY_XL_UAV),
        nominalVoltage(deliveredBattery(FT_JENNY_XL_UAV)),
      ),
      1e-6,
      "and the delivered thrust is the delivered combination's, not a number",
    );

    // Unlimited vertical at full power, which is what the listing promises:
    // climbing straight up at a brisk 8 m/s, the propeller is still pulling
    // more than the whole aeroplane weighs.
    const climbingThrust = config.maxThrust * (1 - 8 / config.propPitchSpeed);
    assert(
      climbingThrust > config.mass * GRAVITY,
      "it has more than its weight in thrust going straight up",
    );
    assert(
      FT_TRIPLANE_XL.maxThrust * (1 - 8 / FT_TRIPLANE_XL.propPitchSpeed) <
        FT_TRIPLANE_XL.mass * GRAVITY,
      "which the triplane, on the same power pack, does not",
    );

    // And hands off at full throttle it goes up rather than along.
    const climbing = aircraft(config, {
      airspeed: maxLevelSpeed(config) * 0.6,
      throttle: 1,
    });
    const startHeight = climbing.position.z;
    fly(climbing, stick(0, 0, 1), 6);
    assert(
      (climbing.position.z - startHeight) / 6 > 3,
      "opened up and left alone, it climbs away",
    );

    // And like the triplane it goes nowhere in particular with it.
    assert(
      maxLevelSpeed(config) < maxLevelSpeed(PLAYER_WING) * 0.75,
      "a big slow blade: the thrust is there for going up, not along",
    );
  });

  suite("two wings, and the lower one is shorter", () => {
    const config = STOCK.config;

    assertBetween(
      config.wingArea,
      0.58,
      0.61,
      "0.6 m^2: a 58.5-inch wing over a 45.5-inch one, both nine inches deep",
    );
    assertClose(
      config.chord,
      9 * 0.0254,
      0.001,
      "and the chord is one wing's, not the area over the span",
    );

    // Lighter loaded than anything else here, which is why it is slow.
    for (const other of OTHER_WINGS) {
      assert(
        wingLoading(config) < wingLoading(other),
        `more lightly loaded than the ${other.name}`,
      );
    }

    // The overhang buys span: nearly twice the Baby Blender's aspect ratio,
    // and the cheapest lift of any aeroplane here with more than one wing.
    assertBetween(aspectRatio(config), 3.4, 4, "an aspect ratio of 3.7");
    for (const other of [FT_BABY_BLENDER, FT_TRIPLANE_XL]) {
      assert(
        aspectRatio(config) > aspectRatio(other),
        `longer for its area than the ${other.name}`,
      );
      assert(
        config.inducedDragFactor < other.inducedDragFactor,
        `so its lift costs less than the ${other.name}'s`,
      );
    }

    // What it gives up is the gap's saving. With the lower wing stopping
    // inboard of the upper one's tips, most of the lift is on the long wing,
    // so the pair save something over one foam wing of the upper's span —
    // but not enough to beat an ideal one, which the Blender's equal wings do.
    const ideal = 1 / (Math.PI * aspectRatio(config));
    assert(
      config.inducedDragFactor > ideal,
      "the short lower wing keeps it above an ideal wing of the same span",
    );
    assert(
      config.inducedDragFactor < ideal / 0.8,
      "and the gap still pays back some of what a foam wing loses",
    );
    assert(
      FT_BABY_BLENDER.inducedDragFactor <
        1 / (Math.PI * aspectRatio(FT_BABY_BLENDER)),
      "which the Blender's two equal wings do get under",
    );

    for (const other of [FT_TRIPLANE_XL, FT_BABY_BLENDER]) {
      assert(
        config.cd0 < other.cd0,
        `cleaner than the ${other.name}`,
      );
    }
    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FOAM_GLIDER,
      FT_P38_LIGHTNING,
      FT_C47,
    ]) {
      assert(
        config.cd0 > other.cd0,
        `and dirtier than the ${other.name}, which has no struts and no wires`,
      );
    }
  });

  suite("the hardware is the kit's", () => {
    const uav = FT_JENNY_XL_UAV;

    assert(
      fitsMotor(deliveredMotor(uav), deliveredBattery(uav)),
      "it is delivered with a pack its own motor will run",
    );
    for (const motor of uav.motors) {
      for (const pack of batteriesFor(uav, motor)) {
        assert(
          motorDemandAmps(motor, pack) <= motor.escAmps,
          `${motor.id} on ${pack.id} stays inside the controller it is fitted with`,
        );
      }
      assert(
        motor.propDiameter <= 12,
        `${motor.id} swings a blade the geometry is drawn to clear`,
      );
      assert((motor.count ?? 1) === 1, `${motor.id} is one motor`);
    }

    // To fly it fast, which is the other half of the box's "fly fast and fly
    // slow": less pull, more top end.
    const fast = fitted("ft2814-1100-11x5.5", "3s-3300");
    assert(
      maxLevelSpeed(fast.config) > maxLevelSpeed(STOCK.config),
      "the 11x5.5 is the fastest it goes on three cells",
    );
    assert(
      thrustToWeight(fast.config) < thrustToWeight(STOCK.config),
      "and it pays in pull",
    );

    // Power Pack C is still more than the aeroplane's weight, and a longer
    // flight.
    const packC = fitted("radial2218-1180-10x4.5", "3s-3300");
    assert(
      thrustToWeight(packC.config) > 1.1,
      "Power Pack C still lifts it vertically, because it is that light",
    );
    assert(
      endurance("radial2218-1180-10x4.5", "3s-3300") >
        endurance("ft2814-1100-12x4.5", "3s-3300"),
      "and stays up for longer",
    );

    const fourCell = fitted("2814-800-12x6-4s", "4s-3300");
    assert(
      maxLevelSpeed(fourCell.config) > maxLevelSpeed(fast.config),
      "the four-cell conversion is the only way it goes faster still",
    );
    assert(
      maxLevelSpeed(fourCell.config) < fourCell.config.neverExceedSpeed,
      "and still inside what the wires will hold",
    );

    assert(
      wingLoading(fitted("ft2814-1100-12x4.5", "3s-5000").config) >
        wingLoading(fitted("ft2814-1100-12x4.5", "3s-2200").config),
      "a bigger pack costs wing loading rather than costing nothing",
    );
    assert(
      endurance("ft2814-1100-12x4.5", "3s-5000") >
        endurance("ft2814-1100-12x4.5", "3s-3300"),
      "and buys time in the air for it",
    );
  });

  suite("it is balanced to fly itself", () => {
    const config = STOCK.config;

    assertBetween(
      staticMargin(config),
      0.15,
      0.2,
      "about seventeen per cent of the chord of static margin",
    );
    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FT_TRIPLANE_XL,
      FT_P38_LIGHTNING,
      FT_BABY_BLENDER,
    ]) {
      assert(
        staticMargin(config) > staticMargin(other),
        `which is more than the ${other.name} has`,
      );
    }
    assert(
      staticMargin(config) < staticMargin(FT_C47),
      "and of the Flite Test aeroplanes, only the C-47 has more",
    );

    // Trimmed for the slow flight on the box: let go on a part throttle and it
    // settles at half again its stall rather than diving or zooming off.
    const cruising = aircraft(config, { airspeed: 12, throttle: 0.2 });
    fly(cruising, stick(0, 0, 0.2), 20);
    const startHeight = cruising.position.z;
    fly(cruising, stick(0, 0, 0.2), 10);
    const settled = cruising.airspeed * MS_TO_KMH;
    assertBetween(
      settled,
      28,
      40,
      `hands off it holds the low thirties (${settled.toFixed(0)} km/h)`,
    );
    assertBetween(
      (cruising.position.z - startHeight) / 10,
      -1,
      1,
      "and neither dives nor climbs away while it does",
    );

    // A degree of dihedral and a wing above the centre of gravity: left in a
    // bank it comes slowly back towards level.
    const banked = aircraft(config, {
      airspeed: 10,
      throttle: 0.2,
      rollDeg: 30,
    });
    fly(banked, stick(0, 0, 0.2), 20);
    assert(
      Math.abs(bankDeg(banked)) < 20,
      `left in a 30 degree bank, it eases itself out of it (${bankDeg(
        banked,
      ).toFixed(1)})`,
    );

    // An upset with the motor stopped is something it recovers from by itself.
    // Anything this light zooms nearly to a stop and is briefly past the stall
    // at the top; what matters is that it does not stay there.
    const upset = aircraft(config, { airspeed: 12, throttle: 0, pitchDeg: 25 });
    let worstAlpha = 0;
    fly(upset, stick(0, 0, 0), 10, (state) => {
      worstAlpha = Math.max(worstAlpha, state.angleOfAttack);
    });
    assert(
      worstAlpha < config.stallAngle * 2,
      "an upset with the motor stopped does not run away in pitch",
    );
    assert(
      upset.angleOfAttack < config.stallAngle,
      "it puts its own nose down and is flying again",
    );
    assert(
      upset.airspeed > stallSpeed(config),
      "and comes out of it with flying speed",
    );
  });

  suite("it turns and loops like a Jenny", () => {
    const config = STOCK.config;

    const roll = peakRollRate(config, 11);
    assertBetween(
      roll,
      100,
      170,
      `about a hundred and thirty degrees a second at a slow cruise (${roll.toFixed(
        0,
      )})`,
    );
    assert(
      roll > peakRollRate(FT_TRIPLANE_XL, 11),
      "a little quicker than the triplane, whose ailerons are on one wing of three",
    );
    assert(
      roll < peakRollRate(FT_BABY_BLENDER, 11) / 2,
      "and well under half the Baby Blender's, which is built to snap roll",
    );
    assert(
      FT_JENNY_XL_UAV.defaultRates.rollRate <= roll,
      "full stick is delivered asking for no more than it can give",
    );

    // A trainer's elevator: full back stick is a little past the stall rather
    // than a snap.
    const pulling = aircraft(config, { airspeed: 12, throttle: 0.5 });
    let peakAlpha = 0;
    fly(pulling, stick(1, 0, 0.5), 3, (state) => {
      peakAlpha = Math.max(peakAlpha, state.angleOfAttack);
    });
    assert(
      peakAlpha < config.stallAngle * 1.5,
      "full back stick is a long way short of an aerobat's elevator",
    );

    // And it loops, because a Jenny barnstorming did.
    const looping = aircraft(config, {
      airspeed: maxLevelSpeed(config),
      throttle: 1,
    });
    let rotated = 0;
    fly(looping, stick(1, 0, 1), 8, (state) => {
      rotated += state.angularVelocity.y * PHYSICS_TIMESTEP;
    });
    assert(
      Math.abs(rotated) > 2 * Math.PI,
      "full back stick at full throttle comes all the way round",
    );
  });

  suite("it stands on its wheels and a skid", () => {
    const config = STOCK.config;
    const contact = groundContactFor(config);

    assert(
      config.undercarriage === "taildragger",
      "two wheels on wire legs and a skid under the rudder",
    );
    assertClose(
      contact.restHeight,
      0.24,
      1e-9,
      "with its centre of gravity the twenty-four centimetres its gear says",
    );
    assert(
      contact.restHeight < config.wingSpan / 4.8,
      "rather than a fifth of a span that is mostly overhang",
    );
    assertClose(
      (contact.restPitch * 180) / Math.PI,
      12,
      0.01,
      "nose-up on the gear before anything has moved",
    );
    assert(
      contact.restPitch > config.stallAngle * 0.7,
      "which is most of the incidence the wing has to give",
    );

    const launch = groundLaunch(config);
    assert(
      launch.grounded && !launch.held,
      "a flight begins standing on a field rather than in somebody's hand",
    );
    assertClose(launch.throttle, 0, 1e-9, "with the motor stopped");

    // Sitting still it is already at flying incidence, and on this wing
    // loading that incidence carries it at a jog.
    const cl = liftCoefficient(config, contact.restPitch);
    const liftOff = Math.sqrt(
      (2 * config.mass * GRAVITY) / (1.225 * config.wingArea * cl),
    );
    assertBetween(
      liftOff * MS_TO_KMH,
      18,
      26,
      "the wing carries it at about 22 km/h in the attitude it is parked in",
    );
    const run = takeOffRun(config);
    assertBetween(
      run,
      2,
      15,
      `and it is off in a few metres (${run.toFixed(1)} m)`,
    );
    assert(
      run < takeOffRun(FT_TRIPLANE_XL),
      "shorter than the triplane, which has the same power and more to lift",
    );

    assert(
      touchdownLimitsFor(config) === WHEELED_TOUCHDOWN_LIMITS,
      "it arrives on the wheels it left on",
    );
    assert(
      touchdownLimitsFor(config).bank < TOUCHDOWN_LIMITS.bank,
      "and putting a wing down on a landing gear is still worse than on a belly",
    );
  });

  suite("the Jenny has geometry of its own", () => {
    assert(
      meshKindFor(FT_JENNY_XL) === MESH_KIND.Jenny,
      "the airframe says what it is drawn as",
    );
    assert(
      meshKindFor(FT_BABY_BLENDER) === MESH_KIND.Biplane &&
        meshKindFor(FT_TRIPLANE_XL) === MESH_KIND.Triplane &&
        meshKindFor(FT_C47) === MESH_KIND.C47 &&
        meshKindFor(CA35_160) === MESH_KIND.Quad &&
        meshKindFor(PLAYER_WING) === MESH_KIND.Wing,
      "and nothing else has been dragged along with it",
    );

    const mesh = buildJennyMesh();
    assert(mesh.kind === MESH_KIND.Jenny, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      FT_JENNY_XL.wingSpan,
      1e-9,
      "drawn at the span the airframe actually is, so it scales by one",
    );
    assertClose(MESH_JENNY_SPAN, 1.486, 1e-9, "which is the kit's 58.5 inches");

    // Two wings, a gap apart, and the upper one is the longer.
    const skins = mesh.parts.filter(
      (part) => part.name === "jenny-top" || part.name === "jenny-bottom",
    );
    assert(skins.length === 2, "the wings are lofted top surface and bottom");
    const skin = vertices(skins);
    const upper = skin.filter(([, , z]) => z > 0.03);
    const lower = skin.filter(([, , z]) => z <= 0.03);
    const heights = [
      ...new Set(skin.map(([, , z]) => Math.round(z * 100))),
    ].sort((a, b) => a - b);
    const gaps = heights.filter(
      (z, i) => i > 0 && z - (heights[i - 1] ?? 0) > 4,
    ).length;
    assert(gaps === 1, `the skins fall into two separate wings (${gaps + 1})`);
    const reach = (points: [number, number, number][]) =>
      Math.max(...points.map(([, y]) => Math.abs(y)));
    assertClose(
      reach(upper) * 2,
      FT_JENNY_XL.wingSpan,
      1e-6,
      "the upper wing is the span the kit is sold by",
    );
    assertBetween(
      reach(lower) / reach(upper),
      0.75,
      0.81,
      "and the lower one is the Jenny's 78% of it",
    );
    const gap =
      Math.min(...upper.map(([, , z]) => z)) -
      Math.max(...lower.map(([, , z]) => z));
    assert(
      gap > 0.18,
      "a little over a chord apart, with room for the cockpits",
    );

    // Staggered, which is why the kit says which wing its centre of gravity is
    // measured from.
    const upperLeading = Math.max(...upper.map(([x]) => x));
    const lowerLeading = Math.max(...lower.map(([x]) => x));
    assertClose(
      upperLeading,
      2.2 * 0.0254,
      0.001,
      "the upper wing's leading edge is 2.2 inches ahead of the centre of gravity",
    );
    assertBetween(
      upperLeading - lowerLeading,
      0.04,
      0.07,
      "and the lower one is staggered a quarter of a chord behind it",
    );

    // A metre long, which is the kit's 41 inches from propeller to rudder.
    const all = vertices([
      ...mesh.staticParts,
      ...mesh.propellers.flatMap((group) =>
        group.parts.map((part) => ({
          ...part,
          positions: part.positions.map((value, i) =>
            i % 3 === 0 ? value + group.origin[0] : value,
          ),
        })),
      ),
    ]);
    const length =
      Math.max(...all.map(([x]) => x)) - Math.min(...all.map(([x]) => x));
    // The listing says 41 inches and the build guide 42, which is the spinner.
    assertBetween(
      length,
      41 * 0.0254 - 0.005,
      42 * 0.0254 + 0.005,
      `41 to 42 inches from spinner to rudder (${(length / 0.0254).toFixed(1)} in)`,
    );

    // It has to stand on the ground the ground model rests it on.
    const contact = groundContactFor(FT_JENNY_XL);
    const height = (x: number, z: number) =>
      x * Math.sin(contact.restPitch) + z * Math.cos(contact.restPitch);
    const lowest = Math.min(
      ...vertices(mesh.staticParts).map(([x, , z]) => height(x, z)),
    );
    assertClose(
      lowest,
      -contact.restHeight,
      0.002,
      "the wheels and the skid touch the ground exactly where it rests it",
    );
    const tyres = mesh.parts.filter((part) => part.name === "jenny-tyres");
    const gear = mesh.parts.filter((part) => part.name === "jenny-gear");
    const tail = vertices(gear).filter(([x]) => x < -0.4);
    assertClose(
      Math.min(...vertices(tyres).map(([x, , z]) => height(x, z))),
      -contact.restHeight,
      0.002,
      "it stands on both wheels",
    );
    assertClose(
      Math.min(...tail.map(([x, , z]) => height(x, z))),
      -contact.restHeight,
      0.002,
      "and on the skid",
    );

    const propeller = mesh.propellers[0];
    assert(
      mesh.propellers.length === 1 && propeller?.axis === "x",
      "one tractor propeller on the nose",
    );
    let radius = 0;
    for (const part of propeller?.parts ?? []) {
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        radius = Math.max(
          radius,
          Math.hypot(part.positions[i + 1] ?? 0, part.positions[i + 2] ?? 0),
        );
      }
    }
    assertClose(
      radius,
      (12 * 0.0254) / 2,
      0.002,
      "the blade is the twelve inches the power pack comes with",
    );
    const hubX = propeller?.origin[0] ?? 0;
    const hubZ = propeller?.origin[2] ?? 0;
    const groundAt =
      (-contact.restHeight - hubX * Math.sin(contact.restPitch)) /
      Math.cos(contact.restPitch);
    const clearance = hubZ - radius - groundAt;
    assertBetween(
      clearance,
      0.08,
      0.2,
      `the blade tips clear the grass on legs this tall (${(
        clearance * 1000
      ).toFixed(0)} mm)`,
    );

    // Two cockpits, and the camera is in the back one, behind the upper wing.
    const cockpits = mesh.parts.find((part) => part.name === "jenny-cockpits");
    assert(cockpits !== undefined, "it has its cockpits");
    assert(
      mesh.fpvCamera.offset[0] < upperLeading - FT_JENNY_XL.chord,
      "the camera is in the rear cockpit, behind the upper wing's trailing edge",
    );
    assert(
      mesh.fpvCamera.offset[2] > 0.05,
      "and up on the decking where the pilot's head was",
    );

    for (const name of ["jenny-struts", "jenny-wires", "jenny-radiator"]) {
      assert(
        mesh.parts.some((part) => part.name === name),
        `it has its ${name.replace("jenny-", "")}`,
      );
    }
    for (const name of ["jenny-red", "jenny-white", "jenny-blue"]) {
      assert(
        mesh.parts.some((part) => part.name === name && part.paint === "fixed"),
        `${name.replace("jenny-", "")} in the markings, whatever it is painted`,
      );
    }
    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "an elevator a side that the flight model moves",
    );
    assert(mesh.triangleCount > 1500, "there is an aeroplane there to look at");

    const picture = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.Jenny,
    });
    assert(picture.length > 200, "and the workbench can draw a picture of it");
  });

  suite("and it sounds like the triplane, because it is the triplane's motor", () => {
    assert(
      engineProfileFor(FT_JENNY_XL) === TRIPLANE_ENGINE,
      "the same motor on the same blade is the same note",
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
      shut.gain < open.gain / 2,
      "with the stick down it is a glider, because the motor has stopped",
    );
  });
}
