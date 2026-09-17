import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  FOAM_GLIDER,
  FT_P38_LIGHTNING,
  FT_TRIPLANE_XL,
  GRAVITY,
  PLAYER_WING,
  SKYEYE_2600,
  SKYWALKER_X8,
} from "../flight/config";
import type { AircraftConfig } from "../flight/config";
import {
  FT_P38_LIGHTNING_UAV,
  INTERCEPTOR_WING,
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
  propellerCount,
} from "../flight/powerplant";
import type { MotorSpec } from "../flight/powerplant";
import {
  GROUND_CONTACT,
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
  P38_ENGINE,
  WING_ENGINE,
  engineProfileFor,
  engineSound,
} from "../audio/soundModel";
import {
  MESH_KIND,
  MESH_P38_SPAN,
  buildP38Mesh,
  meshKindFor,
} from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The aeroplane as the kit is sold: two 2218s on 9x4.5 and a 4S 2300. */
const STOCK = resolveLoadout(FT_P38_LIGHTNING_UAV, null);

function fitted(motorId: string, batteryId: string) {
  return resolveLoadout(FT_P38_LIGHTNING_UAV, {
    motor: motorId,
    battery: batteryId,
  });
}

function endurance(motorId: string, batteryId: string): number {
  const loadout = fitted(motorId, batteryId);
  const pack = loadout.battery ?? deliveredBattery(FT_P38_LIGHTNING_UAV);
  return cruiseEndurance(loadout.config, loadout.motor, pack);
}

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
    id: "p38",
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
 * A take-off flown the way a pilot flies one, and what it costs in metres.
 *
 * Full throttle from a standstill, and the nose is rotated to a climb attitude
 * once the aeroplane has a fifth over its stall — which is a take-off rather
 * than a heave, and on a nosewheel it is the only way the aeroplane leaves at
 * all: sitting at three degrees it would accelerate most of the way to its top
 * speed first.
 */
function takeOff(config: AircraftConfig): { run: number; speed: number } {
  const contact = groundContactFor(config);
  const launch = groundLaunch(config);
  const state = aircraft(config, {
    altitude: launch.altitudeAgl,
    pitchDeg: launch.pitchDeg,
  });
  const rotateSpeed = stallSpeed(config) * 1.2;
  const climbAlpha = (8 * Math.PI) / 180;
  const input = stick(0, 0, 1);
  const steps = Math.round(60 / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    input.pitch =
      state.airspeed > rotateSpeed
        ? Math.max(-1, Math.min(1, (climbAlpha - state.angleOfAttack) * 8))
        : 0;
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
    stepGroundContact(state, 0, V.UP, input.pitch, PHYSICS_TIMESTEP, contact);
    if (state.position.z > contact.restHeight + 0.5) break;
  }
  return {
    run: Math.hypot(state.position.x, state.position.y),
    speed: state.airspeed,
  };
}

/** The same take-off with the stick left alone, which is not how one is flown. */
function takeOffUnrotated(config: AircraftConfig): { run: number; speed: number } {
  const contact = groundContactFor(config);
  const launch = groundLaunch(config);
  const state = aircraft(config, {
    altitude: launch.altitudeAgl,
    pitchDeg: launch.pitchDeg,
  });
  const open = stick(0, 0, 1);
  const steps = Math.round(60 / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, open, CALM, PHYSICS_TIMESTEP);
    stepGroundContact(state, 0, V.UP, open.pitch, PHYSICS_TIMESTEP, contact);
    if (state.position.z > contact.restHeight + 0.5) break;
  }
  return {
    run: Math.hypot(state.position.x, state.position.y),
    speed: state.airspeed,
  };
}

export function runP38Tests(): void {
  suite("the FT P-38 is the aeroplane on the box", () => {
    const config = STOCK.config;

    assertClose(
      config.wingSpan,
      1.46,
      1e-9,
      "57.5 inches across, which is what the kit is sold by",
    );
    assertClose(
      0.045 / config.chord,
      0.237,
      0.02,
      "and the published centre of gravity, 45 mm back, is a quarter of the chord",
    );
    assertClose(
      config.mass,
      1.75,
      0.005,
      "1.75 kg with both motors on it and the 2300 mAh 4S in it",
    );
    assertClose(
      deliveredBattery(FT_P38_LIGHTNING_UAV).cells,
      4,
      1e-9,
      "on the four-cell pack the kit specifies",
    );
    assertClose(
      deliveredBattery(FT_P38_LIGHTNING_UAV).capacityMah,
      2300,
      1e-9,
      "at the capacity it specifies with it",
    );
    assertClose(
      propellerCount(deliveredMotor(FT_P38_LIGHTNING_UAV)),
      2,
      1e-9,
      "and two of everything in front of it, which is what a twin is",
    );

    assertBetween(
      stallSpeed(config) * MS_TO_KMH,
      30,
      38,
      "twenty-one ounces to the square foot stalls at about 34 km/h",
    );
    assertBetween(
      maxLevelSpeed(config) * MS_TO_KMH,
      80,
      98,
      "and it cruises and tops out where a foam warbird does, near 90 km/h",
    );
    assert(
      maxLevelSpeed(config) < config.neverExceedSpeed,
      "nowhere near fast enough in level flight to unfold the booms",
    );
    assert(
      maxLevelSpeed(config) > maxLevelSpeed(FT_TRIPLANE_XL) * 1.4,
      "half again the triplane's top speed, on an aeroplane built to go somewhere",
    );
    assert(
      config.maxThrust / (config.mass * GRAVITY) >
        PLAYER_WING.maxThrust / (PLAYER_WING.mass * GRAVITY),
      "two motors on a foam airframe out-pull anything here with one",
    );

    assert(
      endurance(
        deliveredMotor(FT_P38_LIGHTNING_UAV).id,
        deliveredBattery(FT_P38_LIGHTNING_UAV).id,
      ) >
        10 * 60,
      "and the kit's own pack is a ten-minute sortie and better",
    );
  });

  suite("two booms are most of what this airframe is", () => {
    const config = STOCK.config;

    // The wing first: long, tapered and loaded like a fighter rather than like
    // a park aeroplane.
    assertBetween(
      aspectRatio(config),
      7.4,
      8.4,
      "an aspect ratio near eight, which is the longest wing here bar a Skyeye",
    );
    for (const other of [PLAYER_WING, SKYWALKER_X8, FOAM_GLIDER, FT_TRIPLANE_XL]) {
      assert(
        aspectRatio(config) > aspectRatio(other),
        `longer and thinner than the ${other.name}`,
      );
      assert(
        wingLoading(config) > wingLoading(other),
        `and more heavily loaded than it, which is why it is flown faster`,
      );
      assert(
        config.inducedDragFactor < other.inducedDragFactor,
        `so it pays less for its lift than the ${other.name} does`,
      );
    }
    assert(
      wingLoading(config) < wingLoading(SKYEYE_2600),
      "though nothing like a 15 kg petrol UAV, which is a different trade again",
    );

    // Then the booms, which is where every moment coefficient here comes from.
    assert(
      config.cnBeta > SKYEYE_2600.cnBeta,
      "two fins on two long arms weathervane harder than anything else here",
    );
    for (const other of [PLAYER_WING, SKYWALKER_X8, FOAM_GLIDER, FT_TRIPLANE_XL]) {
      assert(
        config.cnBeta > other.cnBeta && config.cnR < other.cnR,
        `it holds a heading against the ${other.name} and damps yaw harder`,
      );
    }
    for (const other of [PLAYER_WING, SKYWALKER_X8, FT_TRIPLANE_XL]) {
      assert(
        config.cmQ < other.cmQ,
        `and damps pitch harder than the ${other.name}, having a tail on a boom`,
      );
    }
    assert(
      config.cmQ > FOAM_GLIDER.cmQ,
      "only the 480 mm glider damps pitch harder, and against its own chord" +
        " its tail is further back still",
    );

    // Mass out on the booms rather than along the span, which is the one thing
    // a twin does to its own inertia that a single cannot.
    assert(
      config.inertiaPitch > config.inertiaRoll,
      "a motor on each front corner and a tail on each back one: it resists" +
        " pitching more than rolling",
    );
    for (const other of [PLAYER_WING, SKYWALKER_X8]) {
      assert(
        other.inertiaPitch < other.inertiaRoll,
        `where the ${other.name}, having no fuselage at all, is the other way round`,
      );
    }
    assertClose(
      config.inertiaYaw,
      config.inertiaRoll + config.inertiaPitch,
      0.03,
      "and yawing is the two of them together, as it is on anything flat",
    );

    // The balance the kit quotes, read back out of the coefficients.
    const staticMargin = -config.cmAlpha / config.clAlpha;
    assertBetween(
      staticMargin,
      0.1,
      0.2,
      "a fifteen per cent static margin: stable, and not a trainer",
    );
    assert(
      staticMargin > -FT_TRIPLANE_XL.cmAlpha / FT_TRIPLANE_XL.clAlpha,
      "much more of one than the triplane, which is balanced to be thrown around",
    );
  });

  suite("the hardware is the kit's, and there are two of everything", () => {
    const uav = FT_P38_LIGHTNING_UAV;

    assert(
      fitsMotor(deliveredMotor(uav), deliveredBattery(uav)),
      "it is delivered with a pack its own motors will run",
    );
    for (const motor of uav.motors) {
      assertClose(
        propellerCount(motor),
        2,
        1e-9,
        `${motor.id} is a pair of motors rather than one`,
      );
      for (const pack of batteriesFor(uav, motor)) {
        assert(
          motorDemandAmps(motor, pack) <= motor.escAmps,
          `${motor.id} stays inside the two controllers it is fitted with`,
        );
      }
    }

    // The reason the aeroplane is not delivered on the blades that come in the
    // box. Flite Test's own motor specification is a ten-inch propeller on
    // three cells or a nine-inch one on four, and the arithmetic agrees: the
    // ten-inch blade on the kit's four-cell pack asks for half as much again
    // as the two 40 A controllers in the pack will give.
    const boxBlades: MotorSpec = {
      ...deliveredMotor(uav),
      id: "box-blades-on-four-cells",
      propDiameter: 10,
    };
    assert(
      motorDemandAmps(boxBlades, deliveredBattery(uav)) > boxBlades.escAmps * 1.25,
      "ten-inch blades on four cells would cook the controllers in the box",
    );
    assert(
      motorDemandAmps(deliveredMotor(uav), deliveredBattery(uav)) <=
        deliveredMotor(uav).escAmps,
      "and the nine-inch blade the motor is specified for does not",
    );

    // Four setups, and what separates them is what a twin's catalogue is for:
    // pull against speed against how long the packs last.
    const stockTop = maxLevelSpeed(STOCK.config);
    const threeCell = fitted("radial2218-1180-10x4.5", "3s-3300");
    const quick = fitted("radial2218-1180-9x6", "4s-2300");
    const big = fitted("radial2814-1050-10x5", "4s-2300");

    assert(
      maxLevelSpeed(threeCell.config) < stockTop,
      "the blades in the box on three cells give up a fifth of the top end",
    );
    assert(
      endurance("radial2218-1180-10x4.5", "3s-3300") >
        endurance("radial2218-1180-9x4.5", "4s-2300") * 1.5,
      "and buy half again the flight for it",
    );
    assert(
      maxLevelSpeed(quick.config) > stockTop * 1.15,
      "the 9x6 is the other trade: pitch speed, and the fastest of the four",
    );
    assert(
      endurance("radial2218-1180-9x6", "4s-2300") <
        endurance("radial2218-1180-9x4.5", "4s-2300") / 1.5,
      "bought with most of the flight time",
    );
    assert(
      big.config.maxThrust > quick.config.maxThrust,
      "and the 2814 conversion pulls hardest of all of them",
    );
    assert(
      maxLevelSpeed(big.config) < maxLevelSpeed(quick.config),
      "without being the fastest, because thrust and pitch are not the same thing",
    );

    const light = fitted("radial2218-1180-9x4.5", "4s-2300");
    const heavy = fitted("radial2218-1180-9x4.5", "4s-4000");
    assert(
      heavy.config.mass > light.config.mass,
      "a pack is weight before it is anything else",
    );
    assert(
      stallSpeed(heavy.config) > stallSpeed(light.config) &&
        endurance("radial2218-1180-9x4.5", "4s-4000") >
          endurance("radial2218-1180-9x4.5", "4s-2300"),
      "so the big pack is a longer flight flown a little faster",
    );
  });

  suite("it stands on a nosewheel and has to be rotated off it", () => {
    const config = STOCK.config;
    const contact = groundContactFor(config);

    assert(
      config.undercarriage === "tricycle",
      "the first fighter with a nosewheel, and the airframe says so",
    );
    assertClose(
      contact.restHeight,
      config.wingSpan / 12,
      1e-9,
      "it stands a twelfth of its span up, which is where the propellers clear",
    );
    assert(
      contact.friction < GROUND_CONTACT.friction / 5,
      "three wheels roll rather than scrub, which is why it can take off at all",
    );

    // The whole of what a nosewheel is, and the opposite of the triplane: it
    // sits nearly level and the elevator's job is to pick the nose up.
    assert(
      contact.rotateRange > 0 && contact.pushRange === undefined,
      "back stick is the useful direction on this one",
    );
    assert(
      contact.restPitch < FT_TRIPLANE_XL.stallAngle / 3,
      "because it is parked nearly level rather than at flying incidence",
    );
    assert(
      contact.restPitch + contact.rotateRange > config.stallAngle * 0.9,
      "and the elevator can reach the incidence the wing needs, but only just",
    );

    const launch = groundLaunch(config);
    assert(
      launch.grounded && !launch.held,
      "a flight begins standing on a field rather than in somebody's hand",
    );
    assertClose(
      launch.pitchDeg,
      3,
      0.01,
      "nose barely up, on the gear, before anything has moved",
    );
    assertClose(
      launch.throttle,
      0,
      1e-9,
      "with both motors stopped, which on an electric aeroplane is stopped",
    );
  });

  suite("and the rotation is what gets it off the ground", () => {
    const config = STOCK.config;

    const flown = takeOff(config);
    assertBetween(
      flown.run,
      config.wingSpan * 4,
      60,
      `it uses a runway rather than a step (${flown.run.toFixed(1)} m)`,
    );
    assert(
      flown.speed > stallSpeed(config) * 1.2,
      "and leaves it flying rather than hanging on the propellers",
    );

    // And the rotation is the whole of it. Left alone, three degrees of
    // incidence does not carry twenty-one ounces to the foot until the
    // aeroplane is most of the way to its top speed, so it uses several times
    // the runway and leaves at half again the speed. That is the difference
    // between a nosewheel and the skid on the triplane beside it, which sits
    // at flying incidence before it has moved.
    const ignored = takeOffUnrotated(config);
    assert(
      ignored.run > flown.run * 3,
      `stick untouched it needs several times the strip (${ignored.run.toFixed(
        0,
      )} m against ${flown.run.toFixed(0)})`,
    );
    assert(
      ignored.speed > flown.speed * 1.3,
      "and leaves it far faster, which is a runway being used rather than flown",
    );
  });

  suite("and it arrives on the wheels it left on", () => {
    const config = STOCK.config;
    assert(
      touchdownLimitsFor(config) === WHEELED_TOUCHDOWN_LIMITS,
      "an undercarriage is what it lands on as well as what it leaves on",
    );
    assert(
      WHEELED_TOUCHDOWN_LIMITS.groundSpeed > maxLevelSpeed(config),
      "nothing it can reach in level flight is too fast to put back down",
    );
    assert(
      touchdownLimitsFor(config).bank < TOUCHDOWN_LIMITS.bank,
      "and putting a wingtip down on a landing gear is still worse than on a belly",
    );
  });

  suite("it flies like a fighter rather than like a wing", () => {
    const config = STOCK.config;

    // Modest in roll on purpose: this is the aeroplane whose ailerons were
    // complained about for most of the war.
    const rolling = aircraft(config, { airspeed: 24, throttle: 0.6 });
    fly(rolling, stick(0, 0, 0.6), 2);
    let peakRoll = 0;
    fly(rolling, stick(0, 1, 0.6), 3, (state) => {
      peakRoll = Math.max(peakRoll, Math.abs(state.angularVelocity.x));
    });
    const rollDeg = (peakRoll * 180) / Math.PI;
    assertBetween(
      rollDeg,
      150,
      260,
      `it rolls at about two hundred degrees a second (${rollDeg.toFixed(0)})`,
    );
    assert(
      rollDeg < INTERCEPTOR_WING.defaultRates.rollRate * 0.75,
      "well under a foam delta's rate, which is the airframe and not the tune",
    );

    // And steady everywhere else. Hands off at cruise it holds a trim rather
    // than diverging, which is what a fifteen per cent static margin buys.
    const trimmed = aircraft(config, { airspeed: 24, throttle: 0.5 });
    fly(trimmed, stick(0, 0, 0.5), 12);
    assertBetween(
      trimmed.airspeed * MS_TO_KMH,
      55,
      95,
      "hands off at half throttle it settles into a cruise and stays there",
    );
    assert(
      Math.abs(trimmed.angularVelocity.y) < 0.2,
      "without hunting in pitch, because two long booms damp it",
    );

    // It loops, and in rather more sky than the triplane needs.
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
      "full back stick from the top speed brings it all the way round",
    );
    assertBetween(
      peakHeight - 400,
      10,
      70,
      "in a loop that wants a field rather than a garden",
    );

    // It can be stalled, but it has to be asked to, and it does not live up
    // there the way the aeroplane beside it does. Both flown the same way:
    // full back stick from well below the cruise, and how far past their own
    // stall each of them ends up.
    const heldUp = (subject: AircraftConfig, airspeed: number): number => {
      const slow = aircraft(subject, { airspeed });
      let peakAlpha = 0;
      fly(slow, stick(1, 0, 0), 6, (state) => {
        peakAlpha = Math.max(peakAlpha, state.angleOfAttack);
      });
      return peakAlpha / subject.stallAngle;
    };
    const parked = heldUp(config, 12);
    assert(
      parked > 1,
      "the elevator will take it past the stall if it is held there",
    );
    assert(
      parked < heldUp(FT_TRIPLANE_XL, 8),
      "nowhere near where the triplane parks, which is what a tail is for",
    );
  });

  suite("the P-38 has geometry of its own", () => {
    assert(
      meshKindFor(FT_P38_LIGHTNING) === MESH_KIND.P38,
      "the airframe says what it is drawn as",
    );
    assert(
      meshKindFor(FT_TRIPLANE_XL) === MESH_KIND.Triplane &&
        meshKindFor(PLAYER_WING) === MESH_KIND.Wing,
      "and nothing else has been dragged along with it",
    );

    const mesh = buildP38Mesh();
    assert(mesh.kind === MESH_KIND.P38, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      FT_P38_LIGHTNING.wingSpan,
      1e-9,
      "drawn at the span the airframe actually is, so it scales by one",
    );
    assertClose(MESH_P38_SPAN, 1.46, 1e-9, "which is the kit's 57.5 inches");

    // Two propellers, out on the booms, turning opposite ways.
    assert(mesh.propellers.length === 2, "there are two propellers on it");
    const [left, right] = mesh.propellers;
    assert(
      left !== undefined && right !== undefined,
      "one on each boom",
    );
    assert(
      (left?.axis ?? "z") === "x" && (right?.axis ?? "z") === "x",
      "both turning about the body's forward axis, as tractors do",
    );
    assertClose(
      left?.origin[1] ?? 0,
      -(right?.origin[1] ?? 0),
      1e-9,
      "mirrored about the centreline",
    );
    assert(
      Math.abs(left?.origin[1] ?? 0) > 0.1,
      "out on the booms rather than on the nose",
    );
    assert(
      (left?.direction ?? 1) === -(right?.direction ?? 1),
      "and counter-rotating, as a Lightning's are",
    );
    for (const group of mesh.propellers) {
      assert(
        group.origin[0] > 0.4,
        "each disc ahead of everything else on its boom",
      );
    }

    // It has to stand on the ground the ground model rests it on, in the
    // attitude the ground model holds it at, or it is drawn hovering over the
    // field or with a leg buried in it.
    const contact = groundContactFor(FT_P38_LIGHTNING);
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
      "all three wheels touch the ground exactly where it is rested",
    );

    // And the blades have to clear it, which is the whole reason the kit's
    // ten-inch propellers are not what it is delivered on.
    let lowestBlade = Infinity;
    for (const group of mesh.propellers) {
      for (const part of group.parts) {
        for (let i = 0; i + 2 < part.positions.length; i += 3) {
          const x = (part.positions[i] ?? 0) + group.origin[0];
          const z = (part.positions[i + 2] ?? 0) + group.origin[2];
          lowestBlade = Math.min(
            lowestBlade,
            x * Math.sin(contact.restPitch) + z * Math.cos(contact.restPitch),
          );
        }
      }
    }
    assert(
      lowestBlade > -contact.restHeight + 0.02,
      `the propeller tips clear the grass (${(
        (lowestBlade + contact.restHeight) *
        1000
      ).toFixed(0)} mm)`,
    );

    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "an elevator a side, between the fins, that the flight model moves",
    );
    assert(
      mesh.fpvCamera.offset[0] > 0.05 && mesh.fpvCamera.offset[2] > 0.05,
      "the camera sits in the canopy, ahead of the wing and above the gondola",
    );
    assert(mesh.triangleCount > 800, "there is an aeroplane there to look at");

    const picture = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.P38,
    });
    assert(picture.length > 200, "and the workbench can draw a picture of it");
  });

  suite("and two motors are heard as one", () => {
    assert(
      engineProfileFor(FT_P38_LIGHTNING) === P38_ENGINE,
      "the airframe says what it sounds like",
    );

    const open = engineSound(1, 20, P38_ENGINE);
    const shut = engineSound(0, 20, P38_ENGINE);
    assertBetween(
      open.frequency,
      440,
      540,
      `nine inches at fifteen thousand is a hard buzz (${open.frequency.toFixed(
        0,
      )} Hz)`,
    );
    assert(
      open.frequency > engineSound(1, 20, WING_ENGINE).frequency,
      "over a foam wing's note, because the motors turn faster",
    );
    assert(
      open.roughness === 0,
      "and it is smooth: a beat in this simulator means the airframe has been hit",
    );
    assert(
      shut.gain < open.gain / 2,
      "with the stick down it is a glider, because both motors have stopped",
    );
  });
}
