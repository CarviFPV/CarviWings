import { assert, assertBetween, assertClose, suite } from "./harness";
import type { AircraftState } from "../flight/state";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import { PHYSICS_TIMESTEP, stepFlightDynamics } from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import { FlightModeController } from "../flight/flightController";
import { DEFAULT_FLIGHT_MODE_SETTINGS, FLIGHT_MODE } from "../flight/flightModes";
import { RATE_LIMITS, rateCommand } from "../flight/rates";
import {
  DEFAULT_UAV_SETTINGS,
  INTERCEPTOR_WING,
  UAVS,
  activeRates,
  normaliseUavSettings,
  ratesFor,
  uavOrDefault,
} from "../flight/uav";
import type { FlightInput } from "../input/types";
import { RAD_TO_DEG } from "../math/scalar";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 500 };

function wing(airspeed: number): AircraftState {
  return createAircraftState({
    id: "player",
    role: AIRCRAFT_ROLE.Player,
    config: INTERCEPTOR_WING.config,
    position: V.vec3(0, 0, 600),
    headingDeg: 0,
    airspeed,
    throttle: 0.7,
  });
}

function fly(
  controller: FlightModeController,
  state: AircraftState,
  pilot: FlightInput,
  seconds: number,
): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    const input = controller.update(state, pilot, PHYSICS_TIMESTEP);
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
  }
}

export function runUavTests(): void {
  suite("the hangar is consistent", () => {
    assert(UAVS.length > 0, "there is at least one aircraft to fly");
    assert(
      new Set(UAVS.map((uav) => uav.id)).size === UAVS.length,
      "every aircraft has its own id, since settings are stored against it",
    );
    for (const uav of UAVS) {
      const rates = uav.defaultRates;
      assertBetween(
        rates.rollRate,
        RATE_LIMITS.rate.min,
        RATE_LIMITS.rate.max,
        `${uav.id} is delivered on a roll rate the sliders can reach`,
      );
      assertBetween(
        rates.pitchRate,
        RATE_LIMITS.rate.min,
        RATE_LIMITS.rate.max,
        `${uav.id} is delivered on a pitch rate the sliders can reach`,
      );
    }
    assert(
      uavOrDefault("a-flying-carpet").id === INTERCEPTOR_WING.id,
      "and an aircraft nobody has heard of falls back to the default one",
    );
  });

  suite("the rate curve is degrees per second at the stick", () => {
    assertClose(rateCommand(1, 360, 0), 360, 1e-9, "full stick is the rate");
    assertClose(
      rateCommand(-1, 360, 0.6),
      -360,
      1e-9,
      "and expo does not touch the ends of the travel",
    );
    assertClose(rateCommand(0, 360, 0.6), 0, 1e-9, "centre asks for nothing");
    assertClose(
      rateCommand(0.5, 400, 0),
      200,
      1e-9,
      "without expo the curve is the straight line",
    );
    assert(
      rateCommand(0.5, 400, 0.6) < rateCommand(0.5, 400, 0),
      "with it, half stick asks for less",
    );
    assertClose(
      rateCommand(-0.5, 400, 0.6),
      -rateCommand(0.5, 400, 0.6),
      1e-9,
      "and the curve is the same either side of centre",
    );
    assert(
      rateCommand(4, 300, 0) === 300,
      "a stick beyond its own travel is still only full stick",
    );
  });

  suite("rates are stored per aircraft and repaired on the way in", () => {
    const stored = normaliseUavSettings({
      active: "a-flying-carpet",
      rates: {
        [INTERCEPTOR_WING.id]: { rollRate: 9000, pitchRate: "quick", rollExpo: 0.4 },
        "an-aircraft-that-was-removed": { rollRate: 200 },
      },
    });

    assert(
      stored.active === INTERCEPTOR_WING.id,
      "an aircraft that is not in the hangar falls back to the default",
    );
    assertClose(
      ratesFor(stored, INTERCEPTOR_WING.id).rollRate,
      RATE_LIMITS.rate.max,
      1e-9,
      "an absurd rate is clamped rather than flown",
    );
    assertClose(
      ratesFor(stored, INTERCEPTOR_WING.id).pitchRate,
      INTERCEPTOR_WING.defaultRates.pitchRate,
      1e-9,
      "a word where a number belongs takes the aircraft's own default",
    );
    assertClose(
      ratesFor(stored, INTERCEPTOR_WING.id).rollExpo,
      0.4,
      1e-9,
      "and a sound setting is kept",
    );
    assert(
      !("an-aircraft-that-was-removed" in stored.rates),
      "a tune stored against an airframe that no longer exists is dropped",
    );
    assertClose(
      activeRates(normaliseUavSettings(undefined)).rollRate,
      DEFAULT_UAV_SETTINGS.rates[INTERCEPTOR_WING.id]?.rollRate ?? 0,
      1e-9,
      "and nothing at all is the delivered tune",
    );
  });

  suite("the pitch rate is the one the aircraft flies", () => {
    const controller = new FlightModeController({
      settings: { ...DEFAULT_FLIGHT_MODE_SETTINGS, defaultMode: FLIGHT_MODE.Acro },
      rates: { ...INTERCEPTOR_WING.defaultRates, pitchRate: 60, pitchExpo: 0 },
    });
    const state = wing(30);
    const pulling: FlightInput = { pitch: 1, roll: 0, yaw: 0, throttle: 1 };

    fly(controller, state, pulling, 1.5);
    assertClose(
      -state.angularVelocity.y * RAD_TO_DEG,
      60,
      12,
      "full back stick pitches at the rate it is set to",
    );

    // Half the stick with no expo is half the rate, which is what makes the
    // number on the slider mean something to a pilot.
    const half = new FlightModeController({
      settings: { ...DEFAULT_FLIGHT_MODE_SETTINGS, defaultMode: FLIGHT_MODE.Acro },
      rates: { ...INTERCEPTOR_WING.defaultRates, pitchRate: 60, pitchExpo: 0 },
    });
    const gentle = wing(30);
    fly(half, gentle, { pitch: 0.5, roll: 0, yaw: 0, throttle: 1 }, 1.5);
    assertClose(
      -gentle.angularVelocity.y * RAD_TO_DEG,
      30,
      10,
      "and half the stick is half the rate",
    );
  });

  suite("retuning mid-flight is felt on the next stick movement", () => {
    const controller = new FlightModeController({
      settings: { ...DEFAULT_FLIGHT_MODE_SETTINGS, defaultMode: FLIGHT_MODE.Acro },
      rates: { ...INTERCEPTOR_WING.defaultRates, rollRate: 120, rollExpo: 0 },
    });
    const state = wing(28);
    const pilot: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.7 };

    fly(controller, state, pilot, 2);
    assertClose(
      state.angularVelocity.x * RAD_TO_DEG,
      120,
      20,
      "the wing is rolling at the rate it was set up on",
    );

    controller.setRates({
      ...INTERCEPTOR_WING.defaultRates,
      rollRate: 300,
      rollExpo: 0,
    });
    fly(controller, state, pilot, 2);
    assertClose(
      state.angularVelocity.x * RAD_TO_DEG,
      300,
      35,
      "and follows the new one without the flight being restarted",
    );
  });
}
