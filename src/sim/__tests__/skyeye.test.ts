import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  CA35_160,
  GRAVITY,
  PLAYER_WING,
  SKYEYE_2600,
  SKYEYE_3200,
  SKYEYE_3600,
  SKYEYE_5000,
  SKYEYE_6000,
  SKYWALKER_X8,
} from "../flight/config";
import type { AircraftConfig } from "../flight/config";
import {
  INTERCEPTOR_WING,
  SKYEYE_2600_UAV,
  SKYEYE_3200_UAV,
  SKYEYE_3600_UAV,
  SKYEYE_5000_UAV,
  SKYEYE_6000_UAV,
  UAVS,
  batteriesFor,
  deliveredBattery,
  deliveredMotor,
  resolveLoadout,
} from "../flight/uav";
import type { Uav } from "../flight/uav";
import {
  PHYSICS_TIMESTEP,
  cruiseEndurance,
  cruiseSpeed,
  idleThrust,
  levelThrottle,
  maxLevelSpeed,
  stallSpeed,
  stepFlightDynamics,
  throttleThrust,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import {
  FUEL_DENSITY_KG_PER_LITRE,
  createPowerplant,
  fitsMotor,
  formatBattery,
  fuelBurn,
  idleThrustFraction,
  isCombustion,
  isFuelTank,
  loadedMass,
  staticBurn,
  stepPowerplant,
} from "../flight/powerplant";
import {
  GROUND_CONTACT,
  TOUCHDOWN_LIMITS,
  WHEELED_TOUCHDOWN_LIMITS,
  groundContactFor,
  touchdownLimitsFor,
} from "../flight/ground";
import { groundLaunch } from "../flight/launch";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import { MS_TO_KMH } from "../flight/telemetry";
import { PISTON_ENGINE, engineProfileFor, engineSound } from "../audio/soundModel";
import { MESH_KIND, buildSkyeyeMesh, meshKindFor } from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import { forwardAxis } from "../math/quat";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The five, with the endurance each of them is published on, in hours. */
const SERIES: readonly {
  readonly uav: Uav;
  readonly config: AircraftConfig;
  readonly span: number;
  readonly tankLitres: number;
  readonly quotedHours: number;
}[] = [
  {
    uav: SKYEYE_2600_UAV,
    config: SKYEYE_2600,
    span: 2.6,
    tankLitres: 5,
    quotedHours: 2,
  },
  {
    uav: SKYEYE_3200_UAV,
    config: SKYEYE_3200,
    span: 3.22,
    tankLitres: 6,
    quotedHours: 3,
  },
  {
    uav: SKYEYE_3600_UAV,
    config: SKYEYE_3600,
    span: 3.6,
    tankLitres: 11.5,
    quotedHours: 4.5,
  },
  {
    uav: SKYEYE_5000_UAV,
    config: SKYEYE_5000,
    span: 5,
    tankLitres: 28,
    quotedHours: 7.5,
  },
  {
    uav: SKYEYE_6000_UAV,
    config: SKYEYE_6000,
    span: 6,
    tankLitres: 28,
    quotedHours: 9,
  },
];

/** The 3600 as it is delivered, which is the airframe the series is known as. */
const STOCK = resolveLoadout(SKYEYE_3600_UAV, null);

function fitted(uav: Uav, motorId: string, batteryId: string) {
  return resolveLoadout(uav, { motor: motorId, battery: batteryId });
}

function enduranceHours(uav: Uav, loadout = resolveLoadout(uav, null)): number {
  const tank = loadout.battery ?? deliveredBattery(uav);
  return cruiseEndurance(loadout.config, loadout.motor, tank) / 3600;
}

function aircraft(
  config: AircraftConfig,
  overrides: Partial<{
    airspeed: number;
    throttle: number;
    altitude: number;
    pitchDeg: number;
    withTank: boolean;
  }> = {},
): AircraftState {
  return createAircraftState({
    id: "skyeye",
    role: AIRCRAFT_ROLE.Player,
    config,
    position: V.vec3(0, 0, overrides.altitude ?? 500),
    headingDeg: 0,
    pitchDeg: overrides.pitchDeg ?? 0,
    rollDeg: 0,
    airspeed: overrides.airspeed ?? 0,
    throttle: overrides.throttle ?? 0,
    powerplant: overrides.withTank
      ? createPowerplant(STOCK.motor, deliveredBattery(SKYEYE_3600_UAV))
      : null,
  });
}

const stick = (throttle: number): FlightInput => ({
  ...createFlightInput(),
  throttle,
});

function fly(state: AircraftState, input: FlightInput, seconds: number): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
  }
}

export function runSkyeyeTests(): void {
  suite("the Skyeye series is five aeroplanes rather than one", () => {
    assert(
      SERIES.every(({ uav }) => UAVS.includes(uav)),
      "every one of them is in the hangar",
    );
    for (const { uav, config, span } of SERIES) {
      assertClose(
        config.wingSpan,
        span,
        1e-9,
        `${config.name} is named for its span in millimetres`,
      );
      assert(
        config.undercarriage === "tricycle",
        `${config.name} stands on a nosewheel and two mains`,
      );
      assert(
        isCombustion(deliveredMotor(uav)),
        `${config.name} is delivered with an engine rather than a motor`,
      );
      assert(
        isFuelTank(deliveredBattery(uav)),
        `${config.name} carries a tank rather than a pack`,
      );
    }

    // They are the same aeroplane at seven different weights, and the spread is
    // the whole reason there are five of them: it is wider than the entire rest
    // of the hangar, which runs from 141 g to 2.74 kg.
    const lightest = resolveLoadout(SKYEYE_2600_UAV, null).config.mass;
    const heaviest = resolveLoadout(SKYEYE_6000_UAV, null).config.mass;
    assert(
      heaviest / lightest > 4,
      `the flagship is several times the compact one (${(heaviest / lightest).toFixed(1)}x)`,
    );
    assert(
      lightest > SKYWALKER_X8.mass * 4,
      "and the smallest of them is still several times the biggest wing here",
    );
  });

  suite("each of them is the aeroplane its specification describes", () => {
    for (const { uav, tankLitres, quotedHours } of SERIES) {
      const loadout = resolveLoadout(uav, null);
      const tank = loadout.battery ?? deliveredBattery(uav);
      assertClose(
        tank.fuel?.litres ?? 0,
        tankLitres,
        1e-9,
        `${loadout.config.name} is delivered on its published tank`,
      );

      // The published endurance is a manufacturer's figure at a loiter and this
      // is worked out at a proper cruise, so they are never going to be the
      // same number — but they have to be the same aeroplane, and a model that
      // put four and a half hours at nine or at two would not be.
      const hours = enduranceHours(uav, loadout);
      assertBetween(
        hours,
        quotedHours * 0.75,
        quotedHours * 1.3,
        `${loadout.config.name} stays up for about the ${quotedHours} hours it is sold on (${hours.toFixed(
          2,
        )} h)`,
      );

      const top = maxLevelSpeed(loadout.config) * MS_TO_KMH;
      assertBetween(
        top,
        85,
        145,
        `${loadout.config.name} cruises in the band these platforms fly in (${top.toFixed(
          0,
        )} km/h top)`,
      );
      const margin =
        cruiseSpeed(loadout.config) / stallSpeed(loadout.config);
      assert(
        margin > 1.2,
        `${loadout.config.name} cruises clear of its stall (${margin.toFixed(2)}x)`,
      );
      assertBetween(
        loadout.config.maxThrust / (loadout.config.mass * GRAVITY),
        0.35,
        0.85,
        `${loadout.config.name} has an aeroplane's thrust-to-weight, not a model's`,
      );
    }

    // The one comparison the series exists to make: the flagship is heavier and
    // bigger than the 5000 and stays up longer on the same 28 litres, because
    // the engine in it is injected and the wing under it is better.
    assert(
      enduranceHours(SKYEYE_6000_UAV) > enduranceHours(SKYEYE_5000_UAV),
      "injection buys the heavier aeroplane more hours out of the same tank",
    );
  });

  suite("an engine is hardware, and it is not a motor", () => {
    const engine = deliveredMotor(SKYEYE_3600_UAV);
    const tank = deliveredBattery(SKYEYE_3600_UAV);

    assert(
      engine.kv === 0 && engine.escAmps === 0 && engine.cells.max === 0,
      "it has no windings, no controller and no cells, and says so",
    );
    assert(
      (engine.combustion?.displacementCc ?? 0) > 0,
      "what it has instead is a displacement",
    );
    assert(
      tank.cells === 0 && tank.capacityMah === 0,
      "and a tank has no cells or milliamp-hours either",
    );
    assert(
      formatBattery(tank) === "11.5 L",
      `a tank is written on the label in litres (${formatBattery(tank)})`,
    );

    // The two catalogues never mix, whatever the numbers say.
    const pack = deliveredBattery(INTERCEPTOR_WING);
    assert(
      !fitsMotor(engine, pack),
      "an engine will not run on a battery",
    );
    assert(
      !fitsMotor(deliveredMotor(INTERCEPTOR_WING), tank),
      "and a motor will not run on petrol",
    );
    assert(
      batteriesFor(SKYEYE_3600_UAV, engine).every((entry) => isFuelTank(entry)),
      "so everything a Skyeye offers to fill is a tank",
    );

    // A tank is part of the aeroplane, and most of what it weighs is the fuel.
    assertClose(
      loadedMass(tank),
      tank.massKg + 11.5 * FUEL_DENSITY_KG_PER_LITRE,
      1e-9,
      "eleven and a half litres is eight and a half kilos of aeroplane",
    );
    assert(
      loadedMass(tank) > tank.massKg * 5,
      "and nearly all of it is the petrol rather than the tank",
    );

    // Which engine is on the front decides the aeroplane, far more starkly
    // than a motor does: the 55 cc endurance fit stays up an hour longer than
    // the 100 cc twin it is delivered with, and climbs far worse doing it.
    const frugal = fitted(SKYEYE_3600_UAV, "dle55-3600-20x12", "tank-11.5");
    const delivered = fitted(SKYEYE_3600_UAV, "da100-22x13", "tank-11.5");
    assert(
      enduranceHours(SKYEYE_3600_UAV, frugal) >
        enduranceHours(SKYEYE_3600_UAV, delivered) + 0.5,
      "the smaller engine is worth most of another hour",
    );
    assert(
      delivered.config.maxThrust > frugal.config.maxThrust * 1.2,
      "and the bigger one is worth a great deal more thrust",
    );
    assert(
      staticBurn(delivered.motor) > staticBurn(frugal.motor),
      "which it drinks for",
    );
    assert(
      staticBurn(deliveredMotor(INTERCEPTOR_WING)) === 0,
      "nothing electric burns anything",
    );
  });

  suite("with the throttle shut the engine is running, not stopped", () => {
    const config = STOCK.config;
    const share = config.idleThrust ?? 0;
    assertBetween(
      share,
      0.03,
      0.1,
      `an engine idling at a quarter of its rpm makes a sixteenth of its thrust (${(
        share * 100
      ).toFixed(1)}%)`,
    );
    assertClose(
      share,
      idleThrustFraction(STOCK.motor),
      1e-9,
      "and it is worked out from the engine rather than chosen",
    );
    assert(
      (PLAYER_WING.idleThrust ?? 0) === 0 && (CA35_160.idleThrust ?? 0) === 0,
      "nothing with a motor on it makes anything with the stick down",
    );

    assert(
      idleThrust(config, 0) > 0 && throttleThrust(config, 0, 0) > 0,
      "so a Skyeye standing still with the stick shut is still being pushed",
    );
    assertClose(
      throttleThrust(config, 1, 0),
      config.maxThrust,
      1e-6,
      "and full throttle is still exactly what the engine makes",
    );
    assert(
      throttleThrust(config, 0.5, 0) > config.maxThrust * 0.5,
      "with the lever running from the idle to the top rather than from nothing",
    );

    // The idle falls away long before full throttle does, which is what keeps
    // the aeroplane an aeroplane on the approach instead of one being pushed:
    // above a quarter of the propeller's pitch speed — well below the speed it
    // flies at — a shut throttle is worth nothing at all.
    const idlePitchSpeed = config.propPitchSpeed * Math.sqrt(share);
    assert(
      idlePitchSpeed < stallSpeed(config),
      "so it is gone long before the aeroplane is anywhere near flying speed",
    );
    assert(
      idleThrust(config, idlePitchSpeed * 1.01) === 0,
      "an idling propeller has nothing left above a quarter of its pitch speed",
    );
    assert(
      throttleThrust(config, 1, idlePitchSpeed * 1.01) > 0,
      "while the engine at full throttle plainly has",
    );

    // And the throttle a speed needs knows about it: the aeroplane starts from
    // what the engine is already giving rather than from nothing, so where the
    // idle counts it asks for less lever than the same airframe with a motor.
    const stopped = { ...config, idleThrust: 0 };
    const taxi = idlePitchSpeed * 0.5;
    assert(
      levelThrottle(config, taxi) < levelThrottle(stopped, taxi),
      "slowly, an engine has already done some of the work",
    );
    assertBetween(
      levelThrottle(config, cruiseSpeed(config)),
      0.4,
      1,
      "and a cruise still takes most of the lever",
    );

    // Flown, at the speed a runway is left at: the aeroplane with the engine
    // idling goes on accelerating with the stick shut, and the same airframe
    // with a motor on the front of it does not.
    const running = aircraft(config, { airspeed: 4, altitude: 900 });
    const dead = aircraft(stopped, { airspeed: 4, altitude: 900 });
    for (let i = 0; i < 240; i += 1) {
      stepFlightDynamics(running, stick(0), CALM, PHYSICS_TIMESTEP);
      stepFlightDynamics(dead, stick(0), CALM, PHYSICS_TIMESTEP);
    }
    const forward = (state: AircraftState): number => {
      const nose = V.vec3();
      forwardAxis(nose, state.orientation);
      return V.dot(state.velocity, nose);
    };
    assert(
      forward(running) > forward(dead) + 0.2,
      `the engine is still pushing it along (${forward(running).toFixed(
        2,
      )} against ${forward(dead).toFixed(2)} m/s)`,
    );
  });

  suite("and what runs down is a tank rather than a pack", () => {
    const plant = createPowerplant(
      STOCK.motor,
      deliveredBattery(SKYEYE_3600_UAV),
    );
    assertClose(plant.fuelLitres, 11.5, 1e-9, "it starts full");
    assertClose(plant.charge, 1, 1e-9, "which is the same gauge, full");
    assert(
      plant.voltage === 0 && plant.current === 0,
      "and reads nothing at all on the electrical instruments, honestly",
    );
    assert(
      plant.thrustFactor === 1,
      "an engine pulls what it pulls: there is no pack behind it to sag",
    );

    // Held at a cruise for a minute, and the tank goes down by what the engine
    // actually drinks rather than by anything scheduled.
    const cruise = cruiseSpeed(STOCK.config);
    const drag = STOCK.config.maxThrust * 0.4;
    for (let i = 0; i < 60 / PHYSICS_TIMESTEP; i += 1) {
      stepPowerplant(plant, drag, cruise, 1.225, PHYSICS_TIMESTEP);
    }
    const burn = fuelBurn(STOCK.motor, drag, cruise);
    assertClose(
      11.5 - plant.fuelLitres,
      burn / 60,
      1e-3,
      `a minute at that power costs a minute of that burn (${plant.fuelBurnLitresPerHour.toFixed(
        2,
      )} L/h)`,
    );
    assert(
      plant.thrustFactor === 1,
      "and the aeroplane is exactly as strong a minute later",
    );

    // Idling costs fuel too, which is what makes a long descent and a wait on
    // the runway both worth something.
    const idling = createPowerplant(
      STOCK.motor,
      deliveredBattery(SKYEYE_3600_UAV),
    );
    for (let i = 0; i < 60 / PHYSICS_TIMESTEP; i += 1) {
      stepPowerplant(idling, 0, 0, 1.225, PHYSICS_TIMESTEP);
    }
    assert(
      idling.fuelLitres < 11.5,
      "an engine left running is drinking the tank it is going to fly on",
    );
    assertClose(
      idling.fuelBurnLitresPerHour,
      STOCK.motor.combustion?.idleLitresPerHour ?? 0,
      1e-9,
      "at its idle burn, which is the floor rather than nothing",
    );

    // Run it dry, and unlike a pack it does not come back.
    const dry = createPowerplant(STOCK.motor, deliveredBattery(SKYEYE_3600_UAV));
    dry.fuelLitres = 0.002;
    for (let i = 0; i < 30 / PHYSICS_TIMESTEP; i += 1) {
      stepPowerplant(dry, drag, cruise, 1.225, PHYSICS_TIMESTEP);
    }
    assert(dry.cut, "a dry tank stops the engine");
    assert(
      dry.thrustFactor === 0,
      "and with it the idle, so what is left is a glider",
    );
    for (let i = 0; i < 60 / PHYSICS_TIMESTEP; i += 1) {
      stepPowerplant(dry, 0, cruise, 1.225, PHYSICS_TIMESTEP);
    }
    assert(
      dry.cut,
      "petrol does not recover the way a flat cell does: it stays stopped",
    );

    // Which the flight model reads, so a dry Skyeye is not being pushed along:
    // the same aeroplane with fuel in it walks away from it on the same stick.
    const empty = aircraft(STOCK.config, {
      airspeed: 24,
      altitude: 900,
      withTank: true,
    });
    empty.powerplant!.fuelLitres = 0;
    empty.powerplant!.cut = true;
    empty.powerplant!.thrustFactor = 0;
    const fuelled = aircraft(STOCK.config, {
      airspeed: 24,
      altitude: 900,
      withTank: true,
    });
    fly(empty, stick(1), 5);
    fly(fuelled, stick(1), 5);
    assert(
      fuelled.airspeed > empty.airspeed + 2,
      `full throttle on an empty tank does nothing at all (${empty.airspeed.toFixed(
        1,
      )} against ${fuelled.airspeed.toFixed(1)} m/s)`,
    );
  });

  suite("it stands on wheels, and takes off from a runway", () => {
    for (const { config, span } of SERIES) {
      const contact = groundContactFor(config);
      assertClose(
        contact.restHeight,
        span / 12,
        1e-9,
        `${config.name} sits at the height its undercarriage holds it`,
      );
      assert(
        contact.friction < GROUND_CONTACT.friction / 5,
        `${config.name} rolls rather than scrubbing`,
      );
      assert(
        contact.restPitch > 0 && contact.rotateRange > 0,
        `${config.name} sits nose-up and can be rotated off`,
      );

      const launch = groundLaunch(config);
      assert(
        launch.grounded && !launch.held,
        `${config.name} starts on the ground rather than in somebody's hand`,
      );
      assertClose(
        launch.throttle,
        0,
        1e-9,
        `${config.name} starts with the engine idling, which is where the stick is`,
      );
      assertClose(
        launch.altitudeAgl,
        contact.restHeight,
        1e-9,
        `${config.name} starts standing at the height it rests at`,
      );

      // The idle is deliberately worth less than the wheels cost to roll, so
      // one of these waits on the runway instead of walking off it — and it is
      // the thrust rather than a brake that is doing the waiting.
      const idle = idleThrust(config, 0);
      const rolling = contact.friction * config.mass * GRAVITY;
      assert(
        idle > 0 && idle < rolling,
        `${config.name} idles without running away (${idle.toFixed(
          1,
        )} N against ${rolling.toFixed(1)} N)`,
      );
      assert(
        config.maxThrust > rolling * 5,
        `${config.name} has plenty in hand for the roll once the throttle is opened`,
      );
    }

    assert(
      groundLaunch(PLAYER_WING).held,
      "a wing with nothing under it is still thrown",
    );
  });

  suite("and it arrives on them too", () => {
    const limits = touchdownLimitsFor(STOCK.config);
    assert(
      limits === WHEELED_TOUCHDOWN_LIMITS,
      "the airframe says how it lands rather than being told",
    );
    assert(
      limits.groundSpeed > TOUCHDOWN_LIMITS.groundSpeed,
      "wheels are made to arrive at a speed a belly is not",
    );
    assert(
      limits.groundSpeed > maxLevelSpeed(STOCK.config),
      "so nothing it can reach in level flight is too fast to land",
    );
    assert(
      limits.sinkRate > TOUCHDOWN_LIMITS.sinkRate,
      "and to take a firmer arrival than foam does",
    );
    assert(
      limits.bank < TOUCHDOWN_LIMITS.bank &&
        limits.sideslip < TOUCHDOWN_LIMITS.sideslip,
      "what they will not take is landing on one leg or sideways across them",
    );
    assert(
      touchdownLimitsFor(PLAYER_WING) === TOUCHDOWN_LIMITS,
      "and everything without wheels is judged as it always was",
    );
  });

  suite("the Skyeye has geometry of its own", () => {
    const mesh = buildSkyeyeMesh();

    assert(
      meshKindFor(SKYEYE_3600) === MESH_KIND.Skyeye,
      "an aeroplane is drawn as one",
    );
    assert(
      SERIES.every(({ config }) => meshKindFor(config) === MESH_KIND.Skyeye),
      "all five of them, because they are one aeroplane at five sizes",
    );
    assert(
      meshKindFor(SKYWALKER_X8) === MESH_KIND.X8 &&
        meshKindFor(CA35_160) === MESH_KIND.Quad,
      "and everything else still says what it is",
    );
    assertClose(
      mesh.referenceSpan,
      SKYEYE_3600.wingSpan,
      1e-9,
      "drawn at the size of the airframe it is drawn from",
    );

    let minZ = Infinity;
    let maxSpan = 0;
    let nose = -Infinity;
    for (const part of mesh.parts) {
      for (let i = 0; i < part.positions.length; i += 3) {
        const x = part.positions[i] ?? 0;
        const y = part.positions[i + 1] ?? 0;
        const z = part.positions[i + 2] ?? 0;
        if (z < minZ) minZ = z;
        maxSpan = Math.max(maxSpan, Math.abs(y) * 2);
        nose = Math.max(nose, x);
      }
    }
    assertClose(
      maxSpan,
      SKYEYE_3600.wingSpan,
      0.01,
      "the wing is the span the flight model is given",
    );
    assertClose(
      minZ,
      -groundContactFor(SKYEYE_3600).restHeight,
      1e-6,
      "and the wheels touch exactly where the ground model rests it",
    );
    assert(
      mesh.fpvCamera.offset[0] > nose - 0.05,
      "the camera is in the nose, where a survey aeroplane carries its payload",
    );
    assert(
      mesh.propellers.length === 1 && mesh.propellers[0]!.axis === "x",
      "one pusher, turning about the body axis like any other aeroplane's",
    );
    assert(
      mesh.propellers[0]!.origin[0] < -0.5,
      "and it is behind the aircraft rather than in front of it",
    );
    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "the surfaces that move are on the tail, which is where a pilot watches",
    );
    assert(
      mesh.elevonOrigin[0] < -1,
      "a metre and a third behind the wing, on the end of the booms",
    );

    // Every part that is a closed solid is wound the right way out. A single
    // inverted panel is invisible until something culls back faces, and then
    // it is a hole in the aeroplane. The two wing skins are left out because
    // they are not solids at all — an upper and a lower surface, each open —
    // and they are checked below by which way they face instead.
    const solid = (name: string): boolean =>
      !name.startsWith("skyeye-top") && !name.includes("bottom");
    for (const part of [
      ...mesh.parts.filter((entry) => solid(entry.name)),
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

    // And the two skins face out of the wing rather than into it.
    const facing = (name: string): number => {
      const part = mesh.parts.find((entry) => entry.name === name);
      if (!part) return 0;
      let sum = 0;
      for (let i = 2; i < part.normals.length; i += 3) sum += part.normals[i] ?? 0;
      return sum / (part.normals.length / 3);
    };
    assert(facing("skyeye-top") > 0.3, "the top of the wing looks up");
    assert(facing("skyeye-bottom") < -0.3, "and the underside of it looks down");

    assert(
      previewTriangles({
        width: 320,
        height: 200,
        azimuthDeg: 35,
        elevationDeg: 18,
        kind: MESH_KIND.Skyeye,
      }).length > 0,
      "and the workbench can draw a picture of it",
    );
  });

  suite("and it sounds like a petrol engine, which nothing else here does", () => {
    assert(
      engineProfileFor(SKYEYE_3600) === PISTON_ENGINE,
      "the airframe says what it sounds like",
    );
    const full = engineSound(1, 30, PISTON_ENGINE);
    const wing = engineSound(1, 30, engineProfileFor(PLAYER_WING));
    const quad = engineSound(1, 30, engineProfileFor(CA35_160));
    assert(
      full.frequency < wing.frequency && full.frequency < quad.frequency,
      `a two-bladed propeller at seven thousand is the lowest note here (${full.frequency.toFixed(
        0,
      )} Hz)`,
    );

    // The idle is the part that matters: every other airframe here is silent
    // with the stick down, and this one is unmistakably alive.
    const idling = engineSound(0, 0, PISTON_ENGINE);
    const stopped = engineSound(0, 0, engineProfileFor(PLAYER_WING));
    assert(
      idling.frequency > 0 && idling.gain > 0,
      "with the stick shut it is still turning and still audible",
    );
    assert(
      idling.frequency < full.frequency / 3,
      `and doing it a long way below its full note (${idling.frequency.toFixed(0)} Hz)`,
    );
    assert(
      idling.frequency < stopped.frequency,
      "lower even than a wing's idle, because it is a much bigger propeller",
    );
  });
}
