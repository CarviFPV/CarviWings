import { assert, assertBetween, assertClose, suite } from "./harness";
import type { AircraftState } from "../flight/state";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import {
  PHYSICS_TIMESTEP,
  cruiseEndurance,
  cruiseSpeed,
  maxLevelSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import {
  AVIONICS_AMPS,
  BATTERY_UNLIMITED,
  CELL_FULL_VOLTS,
  CELL_NOMINAL_VOLTS,
  cellVoltage,
  createPowerplant,
  electricalPower,
  fitsMotor,
  formatBattery,
  formatEndurance,
  nominalVoltage,
  motorDemandAmps,
  packResistance,
  pitchSpeed,
  POWERTRAIN_EFFICIENCY,
  SAG_KNEE_CHARGE,
  staticThrust,
  stepPowerplant,
} from "../flight/powerplant";
import type { BatterySpec } from "../flight/powerplant";
import {
  INTERCEPTOR_WING,
  SKYWALKER_X8_UAV,
  UAVS,
  batteriesFor,
  deliveredBattery,
  deliveredMotor,
  loadoutFor,
  normaliseUavSettings,
  resolveLoadout,
  withBattery,
  withMotor,
} from "../flight/uav";
import { MS_TO_KMH } from "../flight/telemetry";
import type { FlightInput } from "../input/types";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 500 };

/** An airframe in the air on a given loadout, with a full pack aboard. */
function wing(
  uavId: string,
  motorId: string,
  batteryId: string,
  airspeed = 25,
): AircraftState {
  const uav = UAVS.find((entry) => entry.id === uavId)!;
  const loadout = resolveLoadout(uav, { motor: motorId, battery: batteryId });
  return createAircraftState({
    id: "player",
    role: AIRCRAFT_ROLE.Player,
    config: loadout.config,
    position: V.vec3(0, 0, 600),
    headingDeg: 0,
    airspeed,
    throttle: 0.6,
    powerplant: loadout.battery
      ? createPowerplant(loadout.motor, loadout.battery)
      : null,
  });
}

/** Flies an aircraft on a fixed stick for a while. */
function fly(state: AircraftState, input: FlightInput, seconds: number): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
  }
}

const level = (throttle: number): FlightInput => ({
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle,
});

export function runPowerplantTests(): void {
  suite("the hangar's hardware is coherent", () => {
    const motorIds = new Set<string>();
    for (const uav of UAVS) {
      assert(
        uav.motors.length > 0 && uav.batteries.length > 0,
        `${uav.id} has something to fly on`,
      );
      for (const motor of uav.motors) {
        assert(
          !motorIds.has(`${uav.id}:${motor.id}`),
          `${uav.id}'s combos each have their own id, since settings store them`,
        );
        motorIds.add(`${uav.id}:${motor.id}`);
        assert(
          batteriesFor(uav, motor).length > 0,
          `${motor.id} has a pack on ${uav.id} that will run it`,
        );
        for (const pack of batteriesFor(uav, motor)) {
          assert(
            motorDemandAmps(motor, pack) <= motor.escAmps,
            `${motor.id} on a ${pack.id} does not ask its own ESC for more than it is rated at`,
          );
        }
      }
      const ids = new Set(uav.batteries.map((pack) => pack.id));
      assert(
        ids.size === uav.batteries.length,
        `${uav.id}'s packs each have their own id`,
      );
      assert(
        fitsMotor(deliveredMotor(uav), deliveredBattery(uav)),
        `${uav.id} is delivered with a pack its own motor will run`,
      );
    }
  });

  suite("an airframe as delivered is the airframe it is written down as", () => {
    // The configuration describes the aircraft with its delivered hardware in
    // it, and the hardware is what is actually flown — so the two have to
    // agree, or the hangar quietly ships a different aeroplane.
    for (const uav of UAVS) {
      const delivered = resolveLoadout(uav, {
        motor: deliveredMotor(uav).id,
        battery: deliveredBattery(uav).id,
      });
      assertClose(
        delivered.config.mass,
        uav.config.mass,
        0.01,
        `${uav.id} weighs what its configuration says with its own pack in it`,
      );
      assertClose(
        delivered.config.maxThrust,
        uav.config.maxThrust,
        uav.config.maxThrust * 0.1,
        `${uav.id}'s delivered combo pulls what the airframe is rated at`,
      );
      assertClose(
        delivered.config.propPitchSpeed,
        uav.config.propPitchSpeed,
        uav.config.propPitchSpeed * 0.1,
        `${uav.id}'s delivered propeller runs out where the airframe says`,
      );
    }
  });

  suite("the catalogue reproduces the aircraft it was taken from", () => {
    // The manufacturer quotes the X8 at 2.5-3.0 kg and 65-70 km/h on the 12x6
    // it is normally flown behind. Neither number is written into the
    // simulator: they fall out of the propeller model and the drag polar, so
    // this is the check that both are still telling the truth.
    const x8 = resolveLoadout(SKYWALKER_X8_UAV, {
      motor: "x4250-500-12x6",
      battery: "6s-5200",
    });
    assertBetween(
      x8.config.mass,
      2.5,
      3.0,
      "an X8 on a 6S 5200 weighs what an X8 weighs",
    );
    assertBetween(
      maxLevelSpeed(x8.config) * MS_TO_KMH,
      63,
      72,
      "and flies at the 65-70 km/h it is sold at",
    );
    assertBetween(
      cruiseEndurance(x8.config, deliveredMotor(SKYWALKER_X8_UAV), {
        id: "6s-5200",
        cells: 6,
        capacityMah: 5200,
        cRating: 25,
        massKg: 0.77,
      }) / 60,
      25,
      60,
      "and stays up for the sort of time an X8 on a 5 Ah pack stays up",
    );

    const interceptor = resolveLoadout(INTERCEPTOR_WING, {
      motor: deliveredMotor(INTERCEPTOR_WING).id,
      battery: deliveredBattery(INTERCEPTOR_WING).id,
    });
    assertBetween(
      maxLevelSpeed(interceptor.config) * MS_TO_KMH,
      88,
      100,
      "and the interceptor still tops out near the 95 km/h it is described as",
    );
  });

  suite("a bigger pack is more flying and more aeroplane", () => {
    const small = resolveLoadout(SKYWALKER_X8_UAV, {
      motor: "x4250-500-12x6",
      battery: "6s-5200",
    });
    const large = resolveLoadout(SKYWALKER_X8_UAV, {
      motor: "x4250-500-12x6",
      battery: "6s-16000",
    });

    assert(
      large.config.mass > small.config.mass + 1,
      "sixteen amp-hours is another kilo of aircraft",
    );
    assert(
      maxLevelSpeed(large.config) < maxLevelSpeed(small.config),
      "which costs a little top speed",
    );
    assert(
      cruiseEndurance(large.config, large.motor, large.battery!) >
        2 * cruiseEndurance(small.config, small.motor, small.battery!),
      "and buys far more than it costs",
    );
  });

  suite("a propeller is a propeller", () => {
    const motor = deliveredMotor(SKYWALKER_X8_UAV);
    const pack = deliveredBattery(SKYWALKER_X8_UAV);
    const volts = nominalVoltage(pack);

    assertClose(
      volts,
      6 * CELL_NOMINAL_VOLTS,
      1e-9,
      "a 6S pack is six cells of nominal voltage",
    );
    assert(
      pitchSpeed(motor, volts * 1.2) > pitchSpeed(motor, volts),
      "more volts is more rpm and a higher pitch speed",
    );
    assert(
      staticThrust(motor, volts * 1.2) > staticThrust(motor, volts) * 1.3,
      "and thrust climbs with the square of it, not with it",
    );
    assertClose(
      staticThrust(motor, 0),
      0,
      1e-9,
      "a motor with no volts on it turns no propeller",
    );

    // Momentum theory. Holding a thrust while moving costs more than holding
    // it standing still, because the propeller is doing real work on the
    // aircraft — but the wasteful part of it, the air the propeller has to
    // throw to make the thrust at all, falls away as the aircraft speeds up.
    // That is why an electric wing is efficient in the cruise and thirsty at
    // walking pace.
    assert(
      electricalPower(motor, 10, 20) > electricalPower(motor, 10, 0),
      "ten newtons at cruise is more watts than ten newtons standing still",
    );
    const wasteAtRest = electricalPower(motor, 10, 0) / 10;
    const wasteAtCruise =
      electricalPower(motor, 10, 20) / 10 - 20 / POWERTRAIN_EFFICIENCY;
    assert(
      wasteAtCruise < wasteAtRest / 2,
      "but hardly any of it goes into throwing air, which at rest is all of it",
    );
    assert(
      electricalPower(motor, 0, 20) === 0,
      "and a propeller making no thrust costs nothing",
    );
  });

  suite("a pack behaves like a pack", () => {
    const big: BatterySpec = {
      id: "big",
      cells: 6,
      capacityMah: 16000,
      cRating: 15,
      massKg: 2.15,
    };
    const small: BatterySpec = {
      id: "small",
      cells: 6,
      capacityMah: 3000,
      cRating: 50,
      massKg: 0.45,
    };

    assertClose(
      cellVoltage(1),
      CELL_FULL_VOLTS,
      1e-9,
      "a full cell is 4.2 volts",
    );
    assert(
      cellVoltage(0.7) > cellVoltage(0.3) &&
        cellVoltage(0.3) > cellVoltage(0.02),
      "and the curve only ever falls as the charge goes",
    );
    assert(
      cellVoltage(0.8) - cellVoltage(0.6) < cellVoltage(0.1) - cellVoltage(0),
      "with a flat plateau in the middle and a cliff at the end",
    );
    assert(
      packResistance(small) > packResistance(big),
      "a small pack has more resistance in it than a big one",
    );
  });

  suite("the pack pays for the flight", () => {
    const idle = wing("interceptor-wing", "x2820-920-9x5", "6s-5000");
    const working = wing("interceptor-wing", "x2820-920-9x5", "6s-5000");

    fly(idle, level(0), 20);
    fly(working, level(1), 20);

    const idlePlant = idle.powerplant!;
    const workingPlant = working.powerplant!;

    assert(
      idlePlant.consumedMah > 0,
      "a wing with the motor off is still drawing its avionics",
    );
    assertClose(
      idlePlant.current,
      AVIONICS_AMPS,
      0.05,
      "and that is all it is drawing",
    );
    assert(
      workingPlant.consumedMah > idlePlant.consumedMah * 5,
      "and full throttle costs many times as much as gliding does",
    );
    assert(
      workingPlant.voltage < workingPlant.restingVoltage,
      "a pack under load reads lower at the terminals than it is",
    );
    assert(
      idlePlant.voltage > workingPlant.voltage,
      "and the harder it is worked the further it sags",
    );
    assert(
      workingPlant.enduranceSeconds < idlePlant.enduranceSeconds,
      "which is why the time remaining is read off what is actually being flown",
    );
  });

  suite("a fresh pack pulls harder than a tired one", () => {
    const state = wing("interceptor-wing", "x2820-920-9x5", "6s-5000");
    const plant = state.powerplant!;
    const fresh = plant.thrustFactor;

    assert(
      fresh > 1,
      "an aircraft straight off the charger is above its rated thrust",
    );

    // Run most of the pack out at cruise, then compare.
    plant.consumedMah = plant.battery.capacityMah * 0.85;
    fly(state, level(0.7), 1);
    assert(
      plant.thrustFactor < fresh,
      "and the same aircraft twenty minutes later is below where it started",
    );
  });

  suite("the emptier the pack the harder it sags", () => {
    const pack: BatterySpec = {
      id: "p",
      cells: 6,
      capacityMah: 5000,
      cRating: 30,
      massKg: 0.72,
    };

    assertClose(
      packResistance(pack, SAG_KNEE_CHARGE),
      packResistance(pack, 1),
      1e-9,
      "for two thirds of the flight a pack is the pack it left the charger as",
    );
    assert(
      packResistance(pack, 0.2) > packResistance(pack, 0.5),
      "past a third of the way down it starts to fight back",
    );
    assert(
      packResistance(pack, 0.03) > packResistance(pack, 0.2) * 1.5,
      "and at the very bottom it is a different pack altogether",
    );

    // Which is felt as thrust rather than read as a voltage: the same wing at
    // the same throttle is softer at the end of the flight than in the middle
    // of it, by more than the resting voltage on its own would account for.
    const held = (charge: number): number => {
      const state = wing("interceptor-wing", "x2820-920-9x5", "6s-5000");
      const plant = state.powerplant!;
      plant.consumedMah = plant.battery.capacityMah * (1 - charge);
      plant.charge = charge;
      fly(state, level(1), 2);
      return plant.thrustFactor;
    };
    const knee = held(SAG_KNEE_CHARGE);
    assert(
      held(0.1) < knee * 0.95,
      "so an aircraft on the last of a pack is a visibly softer aircraft",
    );
    assert(knee < held(0.9), "and one on a fresh pack is the strongest it gets");
  });

  suite("a flat pack is a glider", () => {
    const state = wing("interceptor-wing", "x2820-920-9x5", "4s-5000");
    const plant = state.powerplant!;

    // Two seconds short of empty, so the cut lands inside the test rather than
    // twenty simulated minutes into it.
    plant.consumedMah = plant.battery.capacityMah - 20;
    fly(state, level(1), 12);

    assert(plant.cut, "the ESC stops the motor rather than ruining the pack");
    assertClose(plant.thrustFactor, 0, 1e-9, "so there is no thrust left");
    assertClose(
      plant.current,
      AVIONICS_AMPS,
      0.05,
      "and nothing but the avionics is drawing from it",
    );

    // With the motor gone the aircraft is still an aircraft: it must keep
    // flying, on the wing, rather than stop being simulated.
    const before = { ...state.position };
    fly(state, level(1), 3);
    assert(
      V.distance(before, state.position) > 20,
      "the wing keeps flying, it just has nothing pushing it",
    );
    assert(
      state.position.z < before.z,
      "and it is coming down, because that is what a glider does",
    );
  });

  suite("an unlimited flight has no pack to run out of", () => {
    const state = wing("interceptor-wing", "x2820-920-9x5", BATTERY_UNLIMITED);
    assert(state.powerplant === null, "nothing is being drained");

    const limited = wing("interceptor-wing", "x2820-920-9x5", "6s-5000");
    assertClose(
      state.config.mass,
      limited.config.mass,
      1e-9,
      "but the aircraft still weighs what it weighs: the pack is aboard",
    );

    fly(state, level(1), 30);
    assert(
      state.airspeed > 20,
      "and it is still flying under power half a minute later",
    );
  });

  suite("hardware is stored per aircraft and repaired on the way in", () => {
    const stored = normaliseUavSettings({
      active: INTERCEPTOR_WING.id,
      power: {
        [INTERCEPTOR_WING.id]: { motor: "a-turbine", battery: "6s-8000" },
        [SKYWALKER_X8_UAV.id]: {
          motor: "os5010-810-12x8",
          // A 6S pack on a 4S combo: not a setup, so it cannot be flown.
          battery: "6s-12000",
        },
        "an-aircraft-that-was-removed": { motor: "x", battery: "y" },
      },
    });

    const interceptor = loadoutFor(stored, INTERCEPTOR_WING.id);
    assert(
      interceptor.motor === deliveredMotor(INTERCEPTOR_WING).id,
      "hardware nobody sells falls back to what the airframe is delivered with",
    );
    assert(
      interceptor.battery === "6s-8000",
      "and a pack that does fit is kept",
    );

    const x8 = loadoutFor(stored, SKYWALKER_X8_UAV.id);
    assert(x8.motor === "os5010-810-12x8", "a real combo is kept");
    assert(
      x8.battery !== "6s-12000",
      "but a pack that combo cannot run is replaced with one it can",
    );

    assert(
      !("an-aircraft-that-was-removed" in stored.power),
      "and a loadout stored against an airframe that no longer exists is dropped",
    );

    const unlimited = normaliseUavSettings({
      power: { [INTERCEPTOR_WING.id]: { battery: BATTERY_UNLIMITED } },
    });
    assert(
      loadoutFor(unlimited, INTERCEPTOR_WING.id).battery === BATTERY_UNLIMITED,
      "flying without a limit survives the trip through storage",
    );
  });

  suite("changing the motor takes the pack with it", () => {
    const settings = normaliseUavSettings(undefined);
    const onSix = withBattery(settings, INTERCEPTOR_WING.id, "6s-8000");
    assert(
      loadoutFor(onSix, INTERCEPTOR_WING.id).battery === "6s-8000",
      "a pack the combo runs is fitted as asked",
    );

    const onFour = withMotor(onSix, INTERCEPTOR_WING.id, "x2216-1250-8x6");
    const fitted = loadoutFor(onFour, INTERCEPTOR_WING.id);
    assert(
      fitted.motor === "x2216-1250-8x6",
      "the 4S combo goes on",
    );
    const pack = INTERCEPTOR_WING.batteries.find(
      (entry) => entry.id === fitted.battery,
    );
    assert(
      pack !== undefined && pack.cells === 4,
      "and the 6S pack that cannot run it does not stay in the bay",
    );

    // The other airframe in the hangar is untouched by any of it.
    assert(
      loadoutFor(onFour, SKYWALKER_X8_UAV.id).motor ===
        deliveredMotor(SKYWALKER_X8_UAV).id,
      "and the aircraft in the next bay is left exactly as it was",
    );
  });

  suite("the readouts are the ones a pilot reads", () => {
    const pack: BatterySpec = {
      id: "p",
      cells: 6,
      capacityMah: 12000,
      cRating: 15,
      massKg: 1.72,
    };
    assert(formatBattery(pack) === "6S 12 Ah", "a big pack is quoted in Ah");
    assert(
      formatBattery({ ...pack, capacityMah: 5200 }) === "6S 5200 mAh",
      "and a small one in mAh, the way it is written on the label",
    );
    assert(
      formatEndurance(Number.POSITIVE_INFINITY) === "unlimited",
      "an unlimited flight says so",
    );
    assert(
      formatEndurance(1505) === "25 min 05 s",
      "and a real one is quoted in minutes and seconds",
    );
  });

  suite("the endurance quoted in the hangar is the one that is flown", () => {
    // The hangar works endurance out from the drag polar in one line; the
    // flight works it out by draining the pack a step at a time. They are
    // different calculations of the same thing and they have to agree, or the
    // number a pilot chooses a pack on is a number nothing else believes.
    const uav = SKYWALKER_X8_UAV;
    const loadout = resolveLoadout(uav, {
      motor: "x4250-500-12x6",
      battery: "6s-5200",
    });
    const quoted = cruiseEndurance(
      loadout.config,
      loadout.motor,
      loadout.battery as BatterySpec,
    );

    const speed = cruiseSpeed(loadout.config);
    const plant = createPowerplant(
      loadout.motor,
      loadout.battery as BatterySpec,
    );
    // Hold exactly the cruise: the thrust keeping it there is the drag the
    // hangar quoted against.
    const drag = dragAtCruise(loadout.config, speed);
    // A minute of it, which is long enough for the estimate's own averaging to
    // have caught up with what is actually being drawn.
    for (let i = 0; i < 240 * 60; i += 1) {
      stepPowerplant(plant, drag, speed, 1.225, PHYSICS_TIMESTEP);
    }
    assertClose(
      plant.enduranceSeconds / 60,
      quoted / 60,
      (quoted / 60) * 0.15,
      "the pack empties at the rate the hangar said it would",
    );
  });
}

/** Drag in steady level flight, worked out the way the flight model does. */
function dragAtCruise(
  config: { mass: number; wingArea: number; cd0: number; inducedDragFactor: number },
  speed: number,
): number {
  const qS = 0.5 * 1.225 * speed * speed * config.wingArea;
  const cl = (config.mass * 9.80665) / qS;
  return qS * (config.cd0 + config.inducedDragFactor * cl * cl);
}
