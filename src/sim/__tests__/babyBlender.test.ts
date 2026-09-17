import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  CA35_160,
  FOAM_GLIDER,
  FT_BABY_BLENDER,
  FT_P38_LIGHTNING,
  FT_TRIPLANE_XL,
  GRAVITY,
  PLAYER_WING,
  SKYEYE_2600,
  SKYWALKER_X8,
} from "../flight/config";
import type { AircraftConfig } from "../flight/config";
import {
  FT_BABY_BLENDER_UAV,
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
  BABY_BLENDER_ENGINE,
  TRIPLANE_ENGINE,
  WING_ENGINE,
  engineProfileFor,
  engineSound,
} from "../audio/soundModel";
import {
  MESH_BABY_BLENDER_SPAN,
  MESH_KIND,
  buildBabyBlenderMesh,
  meshKindFor,
} from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The aeroplane as the kit is sold: Power Pack C on a 10x4.5 and a 3S 1800. */
const STOCK = resolveLoadout(FT_BABY_BLENDER_UAV, null);

function fitted(motorId: string, batteryId: string) {
  return resolveLoadout(FT_BABY_BLENDER_UAV, {
    motor: motorId,
    battery: batteryId,
  });
}

function endurance(motorId: string, batteryId: string): number {
  const loadout = fitted(motorId, batteryId);
  const pack = loadout.battery ?? deliveredBattery(FT_BABY_BLENDER_UAV);
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
    id: "baby-blender",
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

export function runBabyBlenderTests(): void {
  suite("the FT Baby Blender is the aeroplane on the box", () => {
    const config = STOCK.config;

    assertClose(
      config.wingSpan,
      0.61,
      1e-9,
      "24 inches across, which is what the kit is sold by",
    );
    assertClose(
      config.mass,
      0.567,
      0.005,
      "and 567 g with Power Pack C in the pod and the 1800 mAh 3S aboard",
    );
    assertClose(
      deliveredMotor(FT_BABY_BLENDER_UAV).propDiameter,
      10,
      1e-9,
      "on the 10-inch blade Power Pack C comes with",
    );
    assertClose(
      nominalVoltage(deliveredBattery(FT_BABY_BLENDER_UAV)),
      3 * 3.7,
      1e-9,
      "and the three cells the kit asks for",
    );
    assertBetween(
      deliveredBattery(FT_BABY_BLENDER_UAV).capacityMah,
      1300,
      2200,
      "in the capacity range the listing gives",
    );

    // The kit quotes 14 oz without a battery, which is the airframe with the
    // pod's contents in it. Put the motor, controller and blade back and what
    // is left over is the camera and transmitter that make it one of these.
    const KIT_OUNCES = 14 * 0.0283495;
    const withoutPack =
      FT_BABY_BLENDER_UAV.dryMassKg + deliveredMotor(FT_BABY_BLENDER_UAV).massKg;
    assertBetween(
      withoutPack - KIT_OUNCES,
      0.01,
      0.03,
      "which is the kit's 14 ounces plus the FPV gear that makes it one of these",
    );

    assertBetween(
      stallSpeed(config) * MS_TO_KMH,
      23,
      30,
      "it stalls at a brisk walk, which is the gentle stall on the listing",
    );
    assertBetween(
      maxLevelSpeed(config) * MS_TO_KMH,
      58,
      70,
      "and it will not do much over 64 km/h, which is a park to fly it in",
    );
    assert(
      maxLevelSpeed(config) < maxLevelSpeed(FOAM_GLIDER),
      "slower flat out than the 141 g toy glider, at four times its weight",
    );
    assert(
      maxLevelSpeed(config) > maxLevelSpeed(FT_TRIPLANE_XL),
      "though not as slow as the triplane, which is the only thing here it beats",
    );
    assert(
      maxLevelSpeed(config) < config.neverExceedSpeed,
      "and nowhere near fast enough in level flight to pull the struts out of it",
    );

    // Flite Test rate the airframe for a large field and a medium flying
    // level, which is a circuit rather than a hover: several minutes of it.
    assert(
      endurance(
        deliveredMotor(FT_BABY_BLENDER_UAV).id,
        deliveredBattery(FT_BABY_BLENDER_UAV).id,
      ) >
        10 * 60,
      "the 1800 is a flight rather than a sortie",
    );
  });

  suite("all of it is thrust", () => {
    const config = STOCK.config;

    assertBetween(
      thrustToWeight(config),
      2.5,
      3.1,
      "Power Pack C on a 397 g airframe pulls nearly three times its weight",
    );
    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FOAM_GLIDER,
      FT_TRIPLANE_XL,
      FT_P38_LIGHTNING,
      SKYEYE_2600,
    ]) {
      assert(
        thrustToWeight(config) > thrustToWeight(other),
        `which is more than the ${other.name} has`,
      );
    }

    // And it goes nowhere in particular with it, because a 10x4.5 on three
    // cells is a big slow blade: the thrust is there for going up.
    assert(
      config.propPitchSpeed < PLAYER_WING.propPitchSpeed,
      "the propeller screws forward slower than a foam delta's",
    );
    assert(
      maxLevelSpeed(config) < maxLevelSpeed(PLAYER_WING) * 0.75,
      "so the aeroplane with the most thrust here is one of the slowest on it",
    );

    // Which is what a climb is: level flight needs a fraction of the thrust,
    // and everything left over goes into height.
    const climbing = aircraft(config, {
      airspeed: maxLevelSpeed(config) * 0.6,
      throttle: 1,
    });
    const startHeight = climbing.position.z;
    fly(climbing, stick(0, 0, 1), 6);
    assert(
      (climbing.position.z - startHeight) / 6 > 3,
      "hands off at full throttle it goes up rather than along",
    );
  });

  suite("two wings are not one wing of twice the area", () => {
    const config = STOCK.config;

    assertClose(
      config.wingArea,
      2 * 0.61 * 0.16,
      1e-9,
      "0.195 m^2 of wing, which is two 610 mm panels of a 160 mm chord",
    );
    assertClose(
      config.chord,
      0.16,
      1e-9,
      "and the chord is one wing's, not the area over the span",
    );

    assertBetween(
      aspectRatio(config),
      1.8,
      2.05,
      "so the aspect ratio of the cell is under two",
    );
    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FOAM_GLIDER,
      SKYEYE_2600,
      FT_TRIPLANE_XL,
      FT_P38_LIGHTNING,
    ]) {
      assert(
        aspectRatio(config) < aspectRatio(other),
        `which is stubbier than the ${other.name}`,
      );
    }

    // The reason anybody ever stacked wings. Two of them a gap apart shed less
    // vortex between them than a single wing of the same total lift on the
    // same span, and it very nearly cancels what a pair of rectangular foam
    // panels lose for not being elliptical — so a shape this stubby makes its
    // lift for about what an ideal wing of the same span and area would.
    assert(
      config.inducedDragFactor < 1 / (Math.PI * aspectRatio(config)),
      "two stacked wings cost less in induced drag than one of this shape would",
    );
    assert(
      config.inducedDragFactor > FT_TRIPLANE_XL.inducedDragFactor,
      "though more than the triplane's, which has a whole extra wing of span",
    );

    // Light, and only just beaten. Nine and a half ounces to the square foot
    // is what a foam board biplane weighs and why it stalls at a walk.
    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FOAM_GLIDER,
      FT_P38_LIGHTNING,
      SKYEYE_2600,
    ]) {
      assert(
        wingLoading(config) < wingLoading(other),
        `so it is more lightly loaded than the ${other.name}`,
      );
    }
    assert(
      wingLoading(config) > wingLoading(FT_TRIPLANE_XL),
      "and the triplane is still the lightest thing in the hangar",
    );

    for (const other of [
      PLAYER_WING,
      SKYWALKER_X8,
      FOAM_GLIDER,
      FT_TRIPLANE_XL,
      FT_P38_LIGHTNING,
    ]) {
      assert(
        config.cd0 > other.cd0,
        `and it is dirtier than the ${other.name}, as struts and wheels are`,
      );
    }
    assert(
      config.cd0 < SKYEYE_2600.cd0,
      "though not as dirty as the smallest Skyeye, which is the same argument" +
        " again with a petrol engine on the front of it",
    );
  });

  suite("the hardware is the kit's, and the pod is swappable", () => {
    const uav = FT_BABY_BLENDER_UAV;

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
        motor.propDiameter <= 10,
        `${motor.id} swings a blade the undercarriage can keep off the grass`,
      );
      assert(
        (motor.count ?? 1) === 1,
        `${motor.id} is one motor, because a swappable pod holds one`,
      );
    }

    // Power Pack C is the kit's and Power Pack B is the size below it. The
    // smaller pack is the whole difference between an unlimited aerobat and
    // the gentle four-channel trainer the description starts out describing.
    const packB = fitted("radial2212-1050-9x4.5", "3s-1800");
    assert(
      thrustToWeight(packB.config) < thrustToWeight(STOCK.config) * 0.7,
      "Power Pack B is barely half the thrust",
    );
    assert(
      thrustToWeight(packB.config) > 1.2,
      "and it still lifts the aeroplane vertically, because everything here does",
    );
    assert(
      maxLevelSpeed(packB.config) < maxLevelSpeed(STOCK.config),
      "it gives up the top end as well",
    );
    assert(
      endurance("radial2212-1050-9x4.5", "3s-1800") >
        endurance("radial2218-1180-10x4.5", "3s-1800") * 1.2,
      "and buys a much longer flight with what it saves",
    );

    // What limits this aeroplane on the kit's setup is the blade rather than
    // the motor, which is what four cells and a smaller propeller are for.
    const fourCell = fitted("radial2218-1180-9x4.5-4s", "4s-1300");
    assert(
      maxLevelSpeed(fourCell.config) > maxLevelSpeed(STOCK.config) * 1.2,
      "the four-cell conversion is the only way it goes anywhere quickly",
    );
    assert(
      maxLevelSpeed(fourCell.config) < fourCell.config.neverExceedSpeed,
      "and it is still inside what four foam struts will hold together",
    );
    assert(
      endurance("radial2218-1180-9x4.5-4s", "4s-1300") <
        endurance("radial2218-1180-10x4.5", "3s-1800"),
      "which is paid for in minutes, as it always is",
    );

    // The bigger pack in the pod is weight on the lightest thing about this
    // aeroplane, and the arithmetic has to notice.
    assert(
      wingLoading(fitted("radial2218-1180-10x4.5", "3s-2200").config) >
        wingLoading(fitted("radial2218-1180-10x4.5", "3s-1300").config),
      "a bigger pack costs wing loading rather than costing nothing",
    );
    assertClose(
      STOCK.config.maxThrust,
      staticThrust(
        deliveredMotor(uav),
        nominalVoltage(deliveredBattery(uav)),
      ),
      1e-6,
      "and the delivered thrust is the delivered combination's, not a number",
    );
  });

  suite("it stands on a tailwheel rather than a nosewheel", () => {
    const config = STOCK.config;
    const contact = groundContactFor(config);

    assert(
      config.undercarriage === "taildragger",
      "two medium landing gear wires and a thin one is a taildragger",
    );
    assertClose(
      contact.restHeight,
      config.wingSpan / 4.8,
      1e-9,
      "and it stands a fifth of its span up",
    );
    assert(
      contact.friction < GROUND_CONTACT.friction / 4,
      "wheels roll rather than scrub",
    );
    assert(
      contact.friction > wheeledGroundContact(config).friction,
      "though a taildragger is held back a little more than three free wheels",
    );

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

  suite("and it is off the ground before it has really rolled", () => {
    const config = STOCK.config;
    const contact = groundContactFor(config);

    // Sitting still it is already at flying incidence, so the speed it needs
    // is the speed at which that incidence carries it.
    const cl = liftCoefficient(config, contact.restPitch);
    const liftOff = Math.sqrt(
      (2 * config.mass * GRAVITY) / (1.225 * config.wingArea * cl),
    );
    assertBetween(
      liftOff * MS_TO_KMH,
      20,
      32,
      "the wing carries it at about 25 km/h in the attitude it is parked in",
    );

    const run = takeOffRun(config);
    assertBetween(
      run,
      config.wingSpan * 4,
      25,
      `and it is off in a few metres (${run.toFixed(1)} m)`,
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

  suite("it flies like something sold on snap rolls", () => {
    const config = STOCK.config;

    // Thirty degrees of aileron on a 610 mm span is the fastest roll of any
    // aeroplane in the hangar, and it is the airframe rather than a preference.
    const rolling = aircraft(config, { airspeed: 13, throttle: 0.5 });
    fly(rolling, stick(0, 0, 0.5), 2);
    let peakRoll = 0;
    fly(rolling, stick(0, 1, 0.5), 3, (state) => {
      peakRoll = Math.max(peakRoll, Math.abs(state.angularVelocity.x));
    });
    const rollDeg = (peakRoll * 180) / Math.PI;
    assertBetween(
      rollDeg,
      420,
      700,
      `it rolls at better than four hundred degrees a second (${rollDeg.toFixed(
        0,
      )})`,
    );
    assert(
      rollDeg > FT_BABY_BLENDER_UAV.defaultRates.rollRate,
      "so the airframe has more roll in it than it is delivered asking for",
    );

    // Pitch is the other half of it. Full back stick at full throttle from the
    // top speed is a loop small enough to fly in a park.
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
      4,
      30,
      "in a loop small enough to fly in a park",
    );

    // And high alpha is somewhere it is parked rather than somewhere it falls
    // out of, which is the last thing on the listing.
    const slow = aircraft(config, { airspeed: 8 });
    let peakAlpha = 0;
    fly(slow, stick(1, 0, 0.35), 6, (state) => {
      peakAlpha = Math.max(peakAlpha, state.angleOfAttack);
    });
    assert(
      peakAlpha > config.stallAngle * 1.5,
      "high alpha is somewhere it goes rather than somewhere it falls out of",
    );

    // It is balanced well aft on purpose, and the check is that it is still an
    // aeroplane: upset it and it comes back rather than tightening up.
    const upset = aircraft(config, { airspeed: 12, throttle: 0, pitchDeg: 25 });
    let worstAlpha = 0;
    fly(upset, stick(0, 0, 0), 10, (state) => {
      worstAlpha = Math.max(worstAlpha, state.angleOfAttack);
    });
    assert(
      worstAlpha < config.stallAngle * 3,
      "an upset with the motor stopped does not run away in pitch",
    );
    assert(
      upset.airspeed > stallSpeed(config),
      "and it comes out of it flying rather than falling",
    );
  });

  suite("the biplane has geometry of its own", () => {
    assert(
      meshKindFor(FT_BABY_BLENDER) === MESH_KIND.Biplane,
      "the airframe says what it is drawn as",
    );
    assert(
      meshKindFor(FT_TRIPLANE_XL) === MESH_KIND.Triplane &&
        meshKindFor(CA35_160) === MESH_KIND.Quad &&
        meshKindFor(PLAYER_WING) === MESH_KIND.Wing,
      "and nothing else has been dragged along with it",
    );

    const mesh = buildBabyBlenderMesh();
    assert(mesh.kind === MESH_KIND.Biplane, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      FT_BABY_BLENDER.wingSpan,
      1e-9,
      "drawn at the span the airframe actually is, so it scales by one",
    );
    assertClose(
      MESH_BABY_BLENDER_SPAN,
      0.61,
      1e-9,
      "which is the kit's 24 inches",
    );

    // Two wings, and the check is that there are two: sort every vertex on the
    // wing skins by height and there should be two bands of them, a gap apart.
    const skins = mesh.parts.filter(
      (part) => part.name === "blender-top" || part.name === "blender-bottom",
    );
    assert(skins.length === 2, "the wings are lofted top surface and bottom");
    const heights = new Set<number>();
    for (const part of skins) {
      for (let i = 2; i < part.positions.length; i += 3) {
        heights.add(Math.round((part.positions[i] ?? 0) * 100) / 100);
      }
    }
    const bands = [...heights].sort((a, b) => a - b);
    const gaps = bands.filter(
      (z, i) => i > 0 && z - (bands[i - 1] ?? 0) > 0.04,
    ).length;
    assert(
      gaps === 1,
      `the skins fall into two separate wings (${gaps + 1} found)`,
    );

    // Staggered, which is why the kit has to say which wing its centre of
    // gravity is measured from: the two leading edges are not in the same
    // place, and the upper one is the forward one.
    let topLeading = -Infinity;
    let lowerLeading = -Infinity;
    for (const part of skins) {
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const x = part.positions[i] ?? 0;
        const z = part.positions[i + 2] ?? 0;
        if (z > 0.03) topLeading = Math.max(topLeading, x);
        else lowerLeading = Math.max(lowerLeading, x);
      }
    }
    assert(
      topLeading > lowerLeading + 0.02,
      "the top wing's leading edge is ahead of the lower one's",
    );
    assertClose(
      topLeading,
      0.08,
      0.001,
      "and it is 80 mm ahead of the centre of gravity, which is the kit's number",
    );

    // It has to stand on the ground the ground model rests it on, or it is
    // drawn hovering over the field or buried in it.
    const contact = groundContactFor(FT_BABY_BLENDER);
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
      0.003,
      "the two mains and the tailwheel touch the ground exactly where it rests it",
    );

    // Ten inches of propeller on a taildragger with 2.75-inch wheels is the
    // tightest clearance in the hangar, and it has to be a clearance.
    const propeller = mesh.propellers[0];
    assert(
      mesh.propellers.length === 1 && propeller?.axis === "x",
      "one tractor propeller on the pod, turning about the body's forward axis",
    );
    let radius = 0;
    for (const part of propeller?.parts ?? []) {
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const reach = Math.hypot(
          part.positions[i + 1] ?? 0,
          part.positions[i + 2] ?? 0,
        );
        radius = Math.max(radius, reach);
      }
    }
    assertClose(
      radius,
      (10 * 0.0254) / 2,
      0.002,
      "the blade is the ten inches the power pack comes with",
    );
    const hubX = propeller?.origin[0] ?? 0;
    const hubZ = propeller?.origin[2] ?? 0;
    const groundAt =
      (-contact.restHeight - hubX * Math.sin(contact.restPitch)) /
      Math.cos(contact.restPitch);
    const clearance = hubZ - radius - groundAt;
    assertBetween(
      clearance,
      0.015,
      0.07,
      `the blade tips clear the grass, and not by much (${(
        clearance * 1000
      ).toFixed(0)} mm)`,
    );
    assert(
      hubX > 0.16,
      "and the disc is in front of everything else on the aeroplane",
    );

    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "an elevator a side that the flight model moves",
    );
    assert(
      mesh.fpvCamera.offset[0] > 0 && mesh.fpvCamera.offset[2] > 0.03,
      "the camera sits on the decking between the wings, ahead of the gap",
    );
    assert(mesh.triangleCount > 800, "there is an aeroplane there to look at");

    const picture = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.Biplane,
    });
    assert(picture.length > 200, "and the workbench can draw a picture of it");
  });

  suite("and it sounds like the triplane in a hurry", () => {
    assert(
      engineProfileFor(FT_BABY_BLENDER) === BABY_BLENDER_ENGINE,
      "the airframe says what it sounds like",
    );

    const open = engineSound(1, 12, BABY_BLENDER_ENGINE);
    const shut = engineSound(0, 12, BABY_BLENDER_ENGINE);
    assertBetween(
      open.frequency,
      340,
      400,
      `ten inches at eleven thousand is a hum (${open.frequency.toFixed(0)} Hz)`,
    );
    assert(
      open.frequency > engineSound(1, 12, TRIPLANE_ENGINE).frequency,
      "over the triplane's, because the blade is smaller and turns faster",
    );
    assert(
      open.frequency < engineSound(1, 12, WING_ENGINE).frequency,
      "and under a foam wing's, because it is still a ten-inch propeller",
    );
    assert(
      shut.gain < open.gain / 2,
      "with the stick down it is a glider, because the motor has stopped",
    );
  });
}
