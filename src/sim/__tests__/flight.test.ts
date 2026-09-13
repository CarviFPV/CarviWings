import { assert, assertBetween, assertClose, suite } from "./harness";
import { PLAYER_WING } from "../flight/config";
import {
  PHYSICS_TIMESTEP,
  levelThrottle,
  maxLevelSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import type { FlightInput } from "../input/types";
import { toHeadingPitchRoll } from "../math/quat";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 500 };

function spawn(overrides: Partial<{ airspeed: number; throttle: number; altitude: number }> = {}) {
  return createAircraftState({
    id: "test",
    role: AIRCRAFT_ROLE.Player,
    config: PLAYER_WING,
    position: V.vec3(0, 0, overrides.altitude ?? 300),
    headingDeg: 0,
    airspeed: overrides.airspeed ?? 22,
    throttle: overrides.throttle ?? 0.6,
  });
}

function fly(
  state: AircraftState,
  input: FlightInput,
  seconds: number,
  environment: FlightEnvironment = CALM,
): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, environment, PHYSICS_TIMESTEP);
  }
}

/**
 * A minimal altitude-hold autopilot. Doubles as a check that the airframe is
 * controllable by a feedback loop, which is exactly what the enemy AI will do.
 */
function holdAltitude(
  state: AircraftState,
  targetAltitude: number,
  throttle: number,
): FlightInput {
  const altitudeError = targetAltitude - state.position.z;
  const desiredClimb = Math.max(-6, Math.min(6, altitudeError * 0.35));
  const climbError = desiredClimb - state.velocity.z;
  return {
    pitch: Math.max(-1, Math.min(1, climbError * 0.25)),
    roll: 0,
    yaw: 0,
    throttle,
  };
}

const neutral = (throttle: number): FlightInput => ({
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle,
});

export function runFlightTests(): void {
  suite("trimmed flight", () => {
    const state = spawn({ airspeed: 24, throttle: 0.7 });
    const start = state.position.z;
    fly(state, neutral(0.7), 30);

    assert(Number.isFinite(state.position.z), "altitude stays finite over 30 s");
    assertBetween(
      state.position.z - start,
      -120,
      120,
      "hands-off cruise holds altitude within 120 m over 30 s",
    );
    assertBetween(state.airspeed, 16, 30, "cruise airspeed settles in a sane band");
    const angles = toHeadingPitchRoll(state.orientation);
    assertBetween(Math.abs(angles.rollDeg), 0, 5, "wings stay level hands-off");
    const headingError = Math.abs(((angles.headingDeg + 180) % 360) - 180);
    assertBetween(headingError, 0, 8, "heading holds hands-off");
    assert(!state.stalled, "trimmed cruise is not stalled");
  });

  suite("throttle and top speed", () => {
    // Level-flight top speed needs an altitude hold: hands-off, surplus thrust
    // goes into a climb instead of speed, which is correct but untestable.
    const fast = spawn({ airspeed: 24, throttle: 1 });
    const target = fast.position.z;
    const steps = Math.round(90 / PHYSICS_TIMESTEP);
    for (let i = 0; i < steps; i += 1) {
      stepFlightDynamics(fast, holdAltitude(fast, target, 1), CALM, PHYSICS_TIMESTEP);
    }
    assertClose(fast.position.z, target, 40, "altitude hold keeps the aircraft level");
    assertBetween(
      fast.airspeed,
      24,
      32,
      `full-throttle level top speed is 86-115 km/h (${(fast.airspeed * 3.6).toFixed(1)} km/h)`,
    );

    // The AI's speed limits are fractions of a figure solved analytically from
    // the same coefficients rather than flown, so the two have to agree: a
    // solve that drifts from the integrator would hold every contact to a
    // fraction of the wrong number, and nothing else would notice.
    assertClose(
      maxLevelSpeed(PLAYER_WING),
      fast.airspeed,
      1.5,
      `the solved top speed matches the flown one (${maxLevelSpeed(PLAYER_WING).toFixed(1)} vs ${fast.airspeed.toFixed(1)} m/s)`,
    );

    // And its inverse agrees with it at the one point they share.
    assertClose(
      levelThrottle(PLAYER_WING, maxLevelSpeed(PLAYER_WING)),
      1,
      0.02,
      "and the throttle that holds it is all of it",
    );

    // Hands off, the pitch trim alone should settle near the design cruise.
    const trimmed = spawn({ airspeed: 18, throttle: 0.7 });
    fly(trimmed, neutral(0.7), 60);
    assertBetween(
      trimmed.airspeed,
      20,
      30,
      `hands-off trim speed is the design cruise (${(trimmed.airspeed * 3.6).toFixed(1)} km/h)`,
    );

    const idle = spawn({ airspeed: 22, throttle: 0 });
    const startAltitude = idle.position.z;
    fly(idle, neutral(0), 20);
    assert(idle.position.z < startAltitude, "engine-off aircraft descends");
    assert(idle.airspeed > 8, "engine-off aircraft glides rather than falling out of the sky");
  });

  suite("stall behaviour", () => {
    const state = spawn({ airspeed: 22, throttle: 0 });
    const holdUp: FlightInput = { pitch: 1, roll: 0, yaw: 0, throttle: 0 };
    let stalledAtSomePoint = false;
    const steps = Math.round(14 / PHYSICS_TIMESTEP);
    let peakAltitude = state.position.z;
    for (let i = 0; i < steps; i += 1) {
      stepFlightDynamics(state, holdUp, CALM, PHYSICS_TIMESTEP);
      if (state.stalled) stalledAtSomePoint = true;
      peakAltitude = Math.max(peakAltitude, state.position.z);
    }
    assert(stalledAtSomePoint, "holding full up elevator with no power stalls the wing");
    assert(
      state.position.z < peakAltitude - 20,
      "a stalled aircraft loses the altitude it zoomed for",
    );
    assert(Number.isFinite(state.airspeed), "stall stays numerically stable");
  });

  suite("control response", () => {
    const state = spawn({ airspeed: 22, throttle: 0.6 });
    const rollRight: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.6 };
    fly(state, rollRight, 0.6);
    const rollRate = (state.angularVelocity.x * 180) / Math.PI;
    assertBetween(rollRate, 180, 520, `full aileron reaches ${rollRate.toFixed(0)} deg/s roll rate`);
    assert(toHeadingPitchRoll(state.orientation).rollDeg > 30, "aircraft is banked to the right");

    // Banked, hands off the elevator, the aircraft must turn rather than fly straight.
    const turning = spawn({ airspeed: 24, throttle: 0.7 });
    fly(turning, { pitch: 0, roll: 1, yaw: 0, throttle: 0.7 }, 0.45);
    const headingBefore = toHeadingPitchRoll(turning.orientation).headingDeg;
    fly(turning, { pitch: 0.45, roll: 0, yaw: 0, throttle: 0.7 }, 4);
    const headingAfter = toHeadingPitchRoll(turning.orientation).headingDeg;
    const turned = (headingAfter - headingBefore + 360) % 360;
    assertBetween(turned, 20, 300, `banked turn changes heading by ${turned.toFixed(0)} deg`);

    // Pitch authority must fall away with airspeed.
    const slow = spawn({ airspeed: 8, throttle: 0 });
    fly(slow, { pitch: 1, roll: 0, yaw: 0, throttle: 0 }, 0.4);
    const slowRate = Math.abs(slow.angularVelocity.y);
    const fastAircraft = spawn({ airspeed: 30, throttle: 1 });
    fly(fastAircraft, { pitch: 1, roll: 0, yaw: 0, throttle: 1 }, 0.4);
    const fastRate = Math.abs(fastAircraft.angularVelocity.y);
    assert(slowRate < fastRate, "controls are mushier slow than fast");
  });

  suite("load factor and structure", () => {
    const state = spawn({ airspeed: 28, throttle: 1 });
    let peak = 0;
    const steps = Math.round(6 / PHYSICS_TIMESTEP);
    for (let i = 0; i < steps; i += 1) {
      stepFlightDynamics(state, { pitch: 1, roll: 0, yaw: 0, throttle: 1 }, CALM, PHYSICS_TIMESTEP);
      peak = Math.max(peak, state.loadFactor);
    }
    assertBetween(peak, 2, 9, `hard pull-up peaks at ${peak.toFixed(1)} g`);
  });

  suite("wind separates airspeed from ground speed", () => {
    const windy: FlightEnvironment = { wind: V.vec3(0, 10, 0), originHeight: 500 };
    const state = spawn({ airspeed: 22, throttle: 0.6 });
    // Fly north into a 10 m/s tailwind from the south.
    fly(state, neutral(0.6), 12, windy);
    assert(
      state.groundSpeed > state.airspeed + 5,
      `tailwind makes ground speed exceed airspeed (${state.groundSpeed.toFixed(1)} vs ${state.airspeed.toFixed(1)})`,
    );
  });

  suite("numerical robustness", () => {
    const state = spawn({ airspeed: 22, throttle: 1 });
    // Thrash the controls for two minutes of simulated time.
    const steps = Math.round(120 / PHYSICS_TIMESTEP);
    for (let i = 0; i < steps; i += 1) {
      const t = i * PHYSICS_TIMESTEP;
      stepFlightDynamics(
        state,
        {
          pitch: Math.sin(t * 3.1),
          roll: Math.sin(t * 1.7),
          yaw: Math.sin(t * 0.9) * 0.5,
          throttle: 0.5 + 0.5 * Math.sin(t * 0.4),
        },
        CALM,
        PHYSICS_TIMESTEP,
      );
    }
    assert(V.isFinite3(state.position), "position stays finite under 2 min of thrashing");
    assert(V.isFinite3(state.velocity), "velocity stays finite under 2 min of thrashing");
    const norm = Math.hypot(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
      state.orientation.w,
    );
    assertClose(norm, 1, 1e-6, "attitude quaternion stays normalised");
    assert(V.length(state.angularVelocity) < 40, "angular rates stay bounded");
  });
}
