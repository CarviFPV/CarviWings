import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  CA35_160,
  FOAM_GLIDER,
  FT_BABY_BLENDER,
  FT_C47,
  FT_P38_LIGHTNING,
  FT_TRIPLANE_XL,
  GRAVITY,
  PLAYER_WING,
  SKYEYE_2600,
  SKYWALKER_X8,
} from "../flight/config";
import type { AircraftConfig } from "../flight/config";
import {
  FT_C47_UAV,
  batteriesFor,
  deliveredBattery,
  deliveredMotor,
  resolveLoadout,
} from "../flight/uav";
import {
  PHYSICS_TIMESTEP,
  cruiseEndurance,
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
  BABY_BLENDER_ENGINE,
  C47_ENGINE,
  P38_ENGINE,
  TRIPLANE_ENGINE,
  engineProfileFor,
  engineSound,
} from "../audio/soundModel";
import {
  MESH_C47_SPAN,
  MESH_KIND,
  buildC47Mesh,
  meshKindFor,
} from "../render/aircraftMesh";
import type { MeshPart } from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import { forwardAxis, rightAxis } from "../math/quat";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The aeroplane as the kit asks for it: Power Pack B Twin on a 3S 2200. */
const STOCK = resolveLoadout(FT_C47_UAV, null);

/** The same hardware on the four cells the listing says it will take. */
const FOUR_CELL = resolveLoadout(FT_C47_UAV, {
  motor: "radial2212-1050-9x4.5-4s",
  battery: "4s-2200",
});

function fitted(motorId: string, batteryId: string) {
  return resolveLoadout(FT_C47_UAV, { motor: motorId, battery: batteryId });
}

function endurance(motorId: string, batteryId: string): number {
  const loadout = fitted(motorId, batteryId);
  const pack = loadout.battery ?? deliveredBattery(FT_C47_UAV);
  return cruiseEndurance(loadout.config, loadout.motor, pack);
}

function aspectRatio(config: AircraftConfig): number {
  return (config.wingSpan * config.wingSpan) / config.wingArea;
}

function wingLoading(config: AircraftConfig): number {
  return config.mass / config.wingArea;
}

function thrustToWeight(config: AircraftConfig): number {
  return config.maxThrust / (config.mass * GRAVITY);
}

/** How far behind the neutral point the stability puts the balance. */
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
    id: "c47",
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

interface TakeOff {
  /** Ground covered before the aeroplane is clear of the surface, metres. */
  readonly run: number;
  /** Airspeed as it leaves, m/s. */
  readonly speed: number;
  /** The lowest the nose came down on the roll, radians above level. */
  readonly lowestPitch: number;
}

/**
 * A take-off with the throttle open and the stick left alone.
 *
 * The flight model integrated as the engine integrates it: aerodynamics first,
 * then the constraint that holds the aircraft on the ground. Nothing here knows
 * about taking off, and nothing in it knows that a taildragger's tail comes up
 * on the roll either.
 */
function takeOff(config: AircraftConfig): TakeOff {
  const contact = groundContactFor(config);
  const launch = groundLaunch(config);
  const state = aircraft(config, {
    altitude: launch.altitudeAgl,
    pitchDeg: launch.pitchDeg,
  });
  const open = stick(0, 0, 1);
  const nose = V.vec3();
  let lowestPitch = Infinity;
  const steps = Math.round(30 / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, open, CALM, PHYSICS_TIMESTEP);
    stepGroundContact(state, 0, V.UP, open.pitch, PHYSICS_TIMESTEP, contact);
    if (state.position.z <= contact.restHeight + 1e-6) {
      forwardAxis(nose, state.orientation);
      lowestPitch = Math.min(lowestPitch, Math.asin(nose.z));
    }
    if (state.position.z > contact.restHeight + 0.5) break;
  }
  return {
    run: Math.hypot(state.position.x, state.position.y),
    speed: state.airspeed,
    lowestPitch,
  };
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

export function runC47Tests(): void {
  suite("the FT C-47 is the aeroplane on the box", () => {
    const config = STOCK.config;
    const motor = deliveredMotor(FT_C47_UAV);
    const pack = deliveredBattery(FT_C47_UAV);

    assertClose(
      config.wingSpan,
      60 * 0.0254,
      1e-9,
      "60 inches across, which is the size of the three it is",
    );
    assertClose(
      motor.kv,
      1050,
      1e-9,
      "on the FT Radial 2212 KV1050 that Power Pack B is built around",
    );
    assert(
      (motor.count ?? 1) === 2,
      "two of them, because it is the twin combo",
    );
    assertClose(
      motor.escAmps,
      2 * 25,
      1e-9,
      "with a 25 A controller each, quoted together as what is in the nacelles",
    );
    assertClose(
      motor.propDiameter,
      9,
      1e-9,
      "on the 9x4.5 blades that come with the pack",
    );
    assertClose(
      nominalVoltage(pack),
      3 * 3.7,
      1e-9,
      "and the three cells the listing recommends",
    );
    assertClose(
      pack.capacityMah,
      2200,
      1e-9,
      "in the 2200 mAh it names",
    );
    assertClose(
      config.mass,
      1.511,
      0.005,
      "built up to 1.51 kg, because Flite Test do not publish a weight",
    );

    assertBetween(
      stallSpeed(config) * MS_TO_KMH,
      26,
      34,
      "it stalls at about 30 km/h",
    );
    assertBetween(
      maxLevelSpeed(config) * MS_TO_KMH,
      52,
      64,
      "and on three cells it does not do much over 58, which is a scale speed",
    );
    assert(
      maxLevelSpeed(config) < maxLevelSpeed(FT_P38_LIGHTNING) * 0.75,
      "a long way short of the P-38, which is a fighter",
    );
    assert(
      maxLevelSpeed(FOUR_CELL.config) < config.neverExceedSpeed,
      "and even on four cells it cannot reach a speed that would hurt it",
    );
    assert(
      endurance(motor.id, pack.id) > 15 * 60,
      "a transport flown at part throttle stays up a while on a 2200",
    );
  });

  suite("two motors, and the two cell counts on the box", () => {
    const uav = FT_C47_UAV;

    assert(
      fitsMotor(deliveredMotor(uav), deliveredBattery(uav)),
      "it is delivered with a pack its own motors will run",
    );
    for (const motor of uav.motors) {
      assert(
        (motor.count ?? 1) === 2,
        `${motor.id} is two motors, because it has two nacelles`,
      );
      assert(
        motor.propDiameter <= 10,
        `${motor.id} swings a blade that clears both the fuselage and the grass`,
      );
      for (const pack of batteriesFor(uav, motor)) {
        assert(
          motorDemandAmps(motor, pack) <= motor.escAmps,
          `${motor.id} on a ${pack.id} stays inside the controllers it has`,
        );
      }
    }

    assertBetween(
      thrustToWeight(STOCK.config),
      1.0,
      1.3,
      "on three cells it has a little over its own weight in thrust",
    );
    for (const other of [FT_P38_LIGHTNING, FT_BABY_BLENDER, FT_TRIPLANE_XL]) {
      assert(
        thrustToWeight(STOCK.config) < thrustToWeight(other),
        `which is less than the ${other.name}, as a transport's should be`,
      );
    }
    assertClose(
      STOCK.config.maxThrust,
      staticThrust(deliveredMotor(uav), nominalVoltage(deliveredBattery(uav))),
      1e-6,
      "and the delivered thrust is the delivered combination's, not a number",
    );

    // "4S batteries will enable you to power out of danger when needed": the
    // same motors, controllers and blades, on the other pack.
    const four = FOUR_CELL.motor;
    const three = deliveredMotor(uav);
    assert(
      four.kv === three.kv &&
        four.escAmps === three.escAmps &&
        four.propDiameter === three.propDiameter &&
        four.propPitch === three.propPitch,
      "four cells are the same hardware with a bigger pack behind it",
    );
    assert(
      thrustToWeight(FOUR_CELL.config) > thrustToWeight(STOCK.config) * 1.6,
      "and they nearly double the thrust",
    );
    assert(
      maxLevelSpeed(FOUR_CELL.config) > maxLevelSpeed(STOCK.config) * 1.25,
      "and put a quarter on the top speed",
    );
    assert(
      endurance(four.id, "4s-2200") < endurance(three.id, "3s-2200"),
      "which is paid for in minutes, as it always is",
    );

    assert(
      endurance(three.id, "3s-3300") > endurance(three.id, "3s-2200") * 1.3,
      "the 3300 the listing also quotes is a much longer flight",
    );
    assert(
      wingLoading(fitted(three.id, "3s-3300").config) >
        wingLoading(STOCK.config),
      "and costs wing loading rather than costing nothing",
    );

    // The ten-inch blade on the same motors pulls harder and goes no faster,
    // because the pitch is the same and so is the rpm.
    const tenInch = fitted("radial2212-1050-10x4.5", "3s-2200");
    assert(
      tenInch.config.maxThrust > STOCK.config.maxThrust * 1.3,
      "the ten-inch blade is a lot more pull",
    );
    assertBetween(
      maxLevelSpeed(tenInch.config) / maxLevelSpeed(STOCK.config),
      0.95,
      1.1,
      "and about the same top end",
    );
  });

  suite("the Douglas wing", () => {
    const config = STOCK.config;

    assertBetween(
      aspectRatio(config),
      8,
      8.6,
      "0.28 m^2 on a 1.524 m span is an aspect ratio over eight",
    );
    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FOAM_GLIDER,
      FT_TRIPLANE_XL,
      FT_P38_LIGHTNING,
      FT_BABY_BLENDER,
    ]) {
      assert(
        aspectRatio(config) > aspectRatio(other),
        `the longest, slimmest wing on foam: more than the ${other.name}`,
      );
    }
    assert(
      aspectRatio(config) < aspectRatio(SKYEYE_2600),
      "though not the Skyeyes', which are moulded carbon",
    );
    assert(
      config.inducedDragFactor < FT_P38_LIGHTNING.inducedDragFactor,
      "so it pays less for its lift than anything else on foam",
    );

    assert(
      wingLoading(config) < wingLoading(FT_P38_LIGHTNING),
      "it is more lightly loaded than the P-38's warbird wing",
    );
    for (const other of [FT_TRIPLANE_XL, FT_BABY_BLENDER]) {
      assert(
        wingLoading(config) > wingLoading(other) * 1.5,
        `and far more heavily than the ${other.name}`,
      );
    }

    assert(
      config.cd0 > FT_P38_LIGHTNING.cd0,
      "a metre of round fuselage is dirtier than the P-38's gondola",
    );
    for (const other of [FT_TRIPLANE_XL, FT_BABY_BLENDER]) {
      assert(
        config.cd0 < other.cd0,
        `and cleaner than the ${other.name}, which has struts`,
      );
    }
  });

  suite("it is balanced to be flown by someone who wants it back", () => {
    const config = STOCK.config;

    assertBetween(
      staticMargin(config),
      0.18,
      0.22,
      "a fifth of the chord of static margin",
    );
    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FOAM_GLIDER,
      FT_TRIPLANE_XL,
      FT_P38_LIGHTNING,
      FT_BABY_BLENDER,
      SKYEYE_2600,
    ]) {
      assert(
        staticMargin(config) > staticMargin(other),
        `which is more than the ${other.name} has`,
      );
    }

    // Trimmed for a scale cruise: let go at a part throttle and it settles at
    // the speed the listing calls medium rather than diving or climbing away.
    const cruising = aircraft(config, { airspeed: 14, throttle: 0.6 });
    const startHeight = cruising.position.z;
    fly(cruising, stick(0, 0, 0.6), 12);
    assertBetween(
      cruising.airspeed * MS_TO_KMH,
      42,
      60,
      `hands off it holds about 50 km/h (${(
        cruising.airspeed * MS_TO_KMH
      ).toFixed(0)})`,
    );
    assertBetween(
      cruising.position.z - startHeight,
      -5,
      20,
      "neither diving nor zooming off on its own",
    );

    // Five degrees of dihedral in the outer panels: leave it in a bank and it
    // rolls itself back towards level.
    const banked = aircraft(config, {
      airspeed: 15,
      throttle: 0.6,
      rollDeg: 30,
    });
    fly(banked, stick(0, 0, 0.6), 18);
    assert(
      Math.abs(bankDeg(banked)) < 12,
      `left in a 30 degree bank, it rolls itself out of it (${bankDeg(
        banked,
      ).toFixed(1)})`,
    );

    // And an upset with the motors off is something it recovers from on its
    // own, nose down and flying.
    const upset = aircraft(config, { airspeed: 13, throttle: 0, pitchDeg: 25 });
    let worstAlpha = 0;
    fly(upset, stick(0, 0, 0), 10, (state) => {
      worstAlpha = Math.max(worstAlpha, state.angleOfAttack);
    });
    assert(
      worstAlpha < config.stallAngle,
      "an upset with the motors stopped never gets as far as the stall",
    );
    assert(
      upset.airspeed > stallSpeed(config),
      "and it comes out of it flying",
    );
  });

  suite("and it turns like a transport", () => {
    const config = STOCK.config;
    const roll = peakRollRate(config, 17);
    assertBetween(
      roll,
      100,
      170,
      `about a hundred and thirty degrees a second at cruise (${roll.toFixed(
        0,
      )})`,
    );
    for (const other of [FT_P38_LIGHTNING, FT_BABY_BLENDER]) {
      assert(
        roll < peakRollRate(other, 17),
        `slower than the ${other.name} at the same speed`,
      );
    }
    assert(
      FT_C47_UAV.defaultRates.rollRate <= roll,
      "and full stick is delivered asking for no more than it can give",
    );

    const pulling = aircraft(config, { airspeed: 17, throttle: 0.6 });
    let peakAlpha = 0;
    fly(pulling, stick(1, 0, 0.6), 3, (state) => {
      peakAlpha = Math.max(peakAlpha, state.angleOfAttack);
    });
    assert(
      peakAlpha < config.stallAngle * 1.5,
      "full back stick is a long way short of an aerobat's elevator",
    );
  });

  suite("it stands on a tailwheel", () => {
    const config = STOCK.config;
    const contact = groundContactFor(config);

    assert(
      config.undercarriage === "taildragger",
      "two mains under the nacelles and a wheel under the fin",
    );
    assertClose(
      contact.restHeight,
      0.12,
      1e-9,
      "with its centre of gravity the twelve centimetres up its gear says",
    );
    assert(
      contact.restHeight < config.wingSpan / 4.8 / 2,
      "rather than a fifth of its span, which is a triplane's middle wing",
    );
    assertClose(
      groundContactFor(FT_TRIPLANE_XL).restHeight,
      FT_TRIPLANE_XL.wingSpan / 4.8,
      1e-9,
      "and the taildraggers that say nothing still stand where they did",
    );
    assertClose(
      groundContactFor(FT_P38_LIGHTNING).restHeight,
      FT_P38_LIGHTNING.wingSpan / 12,
      1e-9,
      "as does the P-38 on its nosewheel",
    );
    assertBetween(
      (contact.restPitch * 180) / Math.PI,
      11,
      12.5,
      "parked at about the eleven and a half degrees the full-size one sits at",
    );

    const launch = groundLaunch(config);
    assert(
      launch.grounded && !launch.held,
      "a flight begins on the runway rather than in somebody's hand",
    );
    assertClose(launch.throttle, 0, 1e-9, "with the motors stopped");
    assertClose(
      launch.altitudeAgl,
      0.12,
      1e-9,
      "and standing at the height of its own gear",
    );
  });

  suite("and it wants lots of runway", () => {
    const config = STOCK.config;
    const stock = takeOff(config);

    assertBetween(
      stock.run,
      30,
      80,
      `left alone at full throttle it is off in about fifty metres (${stock.run.toFixed(
        0,
      )} m)`,
    );
    for (const other of [FT_TRIPLANE_XL, FT_BABY_BLENDER]) {
      assert(
        stock.run > takeOff(other).run * 3,
        `several times what the ${other.name} needs`,
      );
    }
    // Nothing in the ground model knows how a taildragger is flown off. The
    // tailplane does: as the speed comes it lifts the tail, the wing goes back
    // to something near level, and the aeroplane leaves at a speed rather than
    // at the attitude it was parked in.
    assert(
      stock.lowestPitch < groundContactFor(config).restPitch / 2,
      "the tail comes up on the roll by itself",
    );
    assert(
      stock.speed > stallSpeed(config) * 1.4,
      "and it flies off well over the stall, as a scale aeroplane should",
    );

    const fourCell = takeOff(FOUR_CELL.config);
    assert(
      fourCell.run < stock.run,
      "four cells shorten the run, which is the other use of the power",
    );
  });

  suite("and it arrives on the wheels it left on", () => {
    const config = STOCK.config;
    assert(
      touchdownLimitsFor(config) === WHEELED_TOUCHDOWN_LIMITS,
      "an undercarriage is an undercarriage, whichever way round it is",
    );
    assert(
      touchdownLimitsFor(config).bank < TOUCHDOWN_LIMITS.bank,
      "and putting a wing down on a landing gear is worse than on a belly",
    );
  });

  suite("the C-47 has geometry of its own", () => {
    assert(
      meshKindFor(FT_C47) === MESH_KIND.C47,
      "the airframe says what it is drawn as",
    );
    assert(
      meshKindFor(FT_P38_LIGHTNING) === MESH_KIND.P38 &&
        meshKindFor(FT_BABY_BLENDER) === MESH_KIND.Biplane &&
        meshKindFor(CA35_160) === MESH_KIND.Quad &&
        meshKindFor(PLAYER_WING) === MESH_KIND.Wing,
      "and nothing else has been dragged along with it",
    );

    const mesh = buildC47Mesh();
    assert(mesh.kind === MESH_KIND.C47, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      FT_C47.wingSpan,
      1e-9,
      "drawn at the span the airframe actually is, so it scales by one",
    );
    assertClose(MESH_C47_SPAN, 1.524, 1e-9, "which is the kit's 60 inches");

    const skins = mesh.parts.filter(
      (part) => part.name === "c47-top" || part.name === "c47-bottom",
    );
    let leading = -Infinity;
    let tip = 0;
    for (const [x, y] of vertices(skins)) {
      leading = Math.max(leading, x);
      tip = Math.max(tip, Math.abs(y));
    }
    assertClose(
      leading,
      0.0635,
      0.001,
      "the wing root's leading edge is 2.5 inches ahead of the centre of gravity",
    );
    assertClose(tip, MESH_C47_SPAN / 2, 0.001, "and it reaches the full span");

    // A low wing: the chord line runs under the cabin floor, so most of the
    // fuselage is above it and only its belly below.
    const body = vertices(
      mesh.parts.filter((part) => part.name === "c47-fuselage"),
    );
    const bodyTop = Math.max(...body.map((p) => p[2]));
    const bodyBottom = Math.min(...body.map((p) => p[2]));
    const bodyFront = Math.max(...body.map((p) => p[0]));
    const bodyHalfWidth = Math.max(...body.map((p) => Math.abs(p[1])));
    assert(
      bodyTop > 0.1 && bodyBottom < 0 && bodyTop > -bodyBottom * 3,
      "the fuselage sits on top of the wing, as a low wing's does",
    );
    assertBetween(
      bodyFront - Math.min(...body.map((p) => p[0])),
      0.95,
      1.1,
      "and it is a metre long",
    );

    // It has to stand on the ground the ground model rests it on.
    const contact = groundContactFor(FT_C47);
    let lowest = Infinity;
    for (const [x, , z] of vertices(mesh.staticParts)) {
      lowest = Math.min(
        lowest,
        x * Math.sin(contact.restPitch) + z * Math.cos(contact.restPitch),
      );
    }
    assertClose(
      lowest,
      -contact.restHeight,
      0.003,
      "the two mains and the tailwheel touch the ground exactly where it rests it",
    );

    assert(
      mesh.propellers.length === 2,
      "two propellers, one on the front of each nacelle",
    );
    assert(
      mesh.propellers.every(
        (group) => group.axis === "x" && group.direction === 1,
      ),
      "both tractors, and both turning the same way, as a C-47's engines did",
    );
    const sides = mesh.propellers.map((group) => Math.sign(group.origin[1]));
    assert(
      sides.includes(1) && sides.includes(-1),
      "one either side of the fuselage",
    );
    for (const group of mesh.propellers) {
      let radius = 0;
      for (const [, y, z] of vertices(group.parts)) {
        radius = Math.max(radius, Math.hypot(y, z));
      }
      assertClose(
        radius,
        (9 * 0.0254) / 2,
        0.002,
        `${group.name} is the nine inches Power Pack B comes with`,
      );
      const [hubX, hubY, hubZ] = group.origin;
      const groundAt =
        (-contact.restHeight - hubX * Math.sin(contact.restPitch)) /
        Math.cos(contact.restPitch);
      const clearance = hubZ - radius - groundAt;
      assertBetween(
        clearance,
        0.03,
        0.08,
        `${group.name}'s tips clear the grass (${(clearance * 1000).toFixed(
          0,
        )} mm)`,
      );
      assert(
        Math.abs(hubY) - radius > bodyHalfWidth + 0.015,
        `and the fuselage, with room to spare`,
      );
      assert(
        bodyFront > hubX + 0.1,
        "and the nose stands well ahead of the discs, as a DC-3's does",
      );
    }

    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "an elevator a side that the flight model moves",
    );
    assert(
      mesh.fpvCamera.offset[0] > 0.2 && mesh.fpvCamera.offset[2] > 0.05,
      "the camera is up in the cockpit, ahead of the wing",
    );
    assert(
      mesh.parts.some((part) => part.name === "c47-stripes") &&
        mesh.parts.some((part) => part.name === "c47-stripes-black"),
      "and it wears its invasion stripes",
    );
    assert(mesh.triangleCount > 1000, "there is an aeroplane there to look at");

    const picture = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.C47,
    });
    assert(picture.length > 200, "and the workbench can draw a picture of it");
  });

  suite("and it hums lower than anything else electric", () => {
    assert(
      engineProfileFor(FT_C47) === C47_ENGINE,
      "the airframe says what it sounds like",
    );

    const open = engineSound(1, 15, C47_ENGINE);
    const shut = engineSound(0, 15, C47_ENGINE);
    assertBetween(
      open.frequency,
      300,
      350,
      `nine inches at ten thousand is a hum (${open.frequency.toFixed(0)} Hz)`,
    );
    for (const other of [TRIPLANE_ENGINE, BABY_BLENDER_ENGINE, P38_ENGINE]) {
      assert(
        open.frequency < engineSound(1, 15, other).frequency,
        "under every other electric aeroplane here",
      );
    }
    assert(
      shut.gain < open.gain / 2,
      "with the stick down it is a glider, because the motors have stopped",
    );
  });
}
