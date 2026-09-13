/**
 * Fixed-wing flight dynamics.
 *
 * A force-and-moment model, not a scripted arcade approximation: thrust, lift,
 * drag and side force are integrated into a velocity, and aerodynamic moments
 * are integrated into a body-frame angular velocity through the aircraft's
 * inertia. Everything a pilot expects falls out of that — inertia, stall,
 * mushy controls at low airspeed, weathervaning, banking to turn, and losing
 * altitude when slow.
 *
 * `stepFlightDynamics` is also the door every aircraft in the simulator comes
 * through, wing or not: an airframe carrying a `rotor` block is handed to
 * `multirotor.ts` here rather than at every call site, so the engine, the
 * missions and the AI step a quadcopter without knowing they are. The
 * performance figures below do the same — a stall speed, a top speed and a
 * cruise endurance all mean something for a multirotor, they are simply worked
 * out differently.
 *
 * Runs entirely in the local ENU frame in metres. It has no knowledge of
 * Cesium, React, or where the aircraft is on Earth beyond an altitude used for
 * air density.
 *
 * The caller must drive this at a small fixed timestep (see
 * `PHYSICS_TIMESTEP`): the pitch damping derivative is stiff enough that a
 * variable frame-length step would go unstable in a fast dive.
 */

import { clamp, clampUnit, moveTowards } from "../math/scalar";
import type { Quat } from "../math/quat";
import {
  angularVelocityFromCommands,
  forwardAxis,
  integrateAngularVelocity,
  rightAxis,
  rotateVectorInverse,
} from "../math/quat";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { FlightInput } from "../input/types";
import { airDensity, SEA_LEVEL_DENSITY } from "./atmosphere";
import type { AircraftConfig } from "./config";
import { GRAVITY } from "./config";
import type { AircraftState } from "./state";
import { isAirworthy } from "./state";
import type { BatterySpec, MotorSpec } from "./powerplant";
import {
  AVIONICS_AMPS,
  electricalPower,
  fuelBurn,
  nominalVoltage,
  stepPowerplant,
} from "./powerplant";
import {
  rotorCruiseEndurance,
  rotorCruiseSpeed,
  rotorLevelThrottle,
  rotorMaxLevelSpeed,
  rotorTrim,
  stepRotorDynamics,
} from "./multirotor";

/** Physics runs at a fixed 240 Hz regardless of render rate. */
export const PHYSICS_TIMESTEP = 1 / 240;

export interface FlightEnvironment {
  /** Wind velocity in local ENU m/s. Airspeed is measured relative to this. */
  readonly wind: Vec3;
  /** Ellipsoidal height of the ENU frame origin, for air density. */
  readonly originHeight: number;
}

/** Residual airframe damping so a dead-stick tumble eventually settles. */
const RESIDUAL_ANGULAR_DAMPING = 0.35;

// Scratch vectors — the step function must not allocate.
const _airVelocity = V.vec3();
const _airDir = V.vec3();
const _bodyAir = V.vec3();
const _forward = V.vec3();
const _right = V.vec3();
const _liftDir = V.vec3();
const _force = V.vec3();
const _term = V.vec3();
const _omegaDot = V.vec3();
const _momentBody = V.vec3();
const _inertiaOmega = V.vec3();
const _gyro = V.vec3();

/**
 * The airspeed below which the wing cannot hold level flight.
 *
 * Derived from the same coefficients the flight model uses, so it stays correct
 * if the airframe is retuned. The AI leans on it constantly: an autopilot that
 * does not know where the stall is will fly straight into one.
 */
export function stallSpeed(
  config: AircraftConfig,
  density = SEA_LEVEL_DENSITY,
  liftFactor = 1,
): number {
  // A multirotor has no wing to stall. Zero rather than an exception: every
  // caller of this is asking "how slowly may I fly", and for a quadcopter the
  // honest answer is "stopped".
  if (config.rotor) return 0;
  const clMax = (config.cl0 + config.clAlpha * config.stallAngle) * liftFactor;
  return Math.sqrt(
    (2 * config.mass * GRAVITY) / (density * config.wingArea * clMax),
  );
}

/**
 * Drag in steady level flight at a given airspeed, newtons.
 *
 * At a constant height the wing has to make exactly the aircraft's weight, so
 * the lift coefficient is fixed by the speed and everything else follows from
 * the same polar the flight model integrates.
 */
function levelDrag(
  config: AircraftConfig,
  speed: number,
  density: number,
  liftFactor = 1,
): number {
  // A multirotor holds height by leaning, not by making lift, so what it is
  // dragging against comes out of its own trim rather than out of a polar.
  if (config.rotor) return rotorTrim(config, speed, density).drag;
  const dynamicPressure = 0.5 * density * speed * speed;
  const qS = dynamicPressure * config.wingArea;
  if (qS < 1e-6) return 0;
  const cl = (config.mass * GRAVITY) / qS / Math.max(liftFactor, 1e-3);
  return qS * (config.cd0 + config.inducedDragFactor * cl * cl);
}

/** Full-throttle thrust at a given airspeed, newtons. */
function fullThrust(config: AircraftConfig, speed: number, thrustFactor = 1): number {
  return (
    config.maxThrust *
    clamp(1 - Math.max(speed, 0) / config.propPitchSpeed, 0, 1) *
    thrustFactor
  );
}

/**
 * Thrust the aircraft is still making with the throttle shut, newtons.
 *
 * Nothing at all on anything electric — a stopped propeller pushes nothing —
 * and on an aeroplane with an engine it is what the engine makes at its idle.
 *
 * It falls away with speed far sooner than full throttle does, and for the
 * reason a real one does: an idling propeller is turning at a quarter of its
 * peaking rpm, so it screws itself forward at a quarter of its pitch speed and
 * has nothing left to give above that. `idleThrust` is the square of that same
 * ratio, so one number gives both — and it is why an aeroplane with an engine
 * on it is still an aeroplane on the approach rather than one being pushed.
 */
export function idleThrust(
  config: AircraftConfig,
  speed: number,
  thrustFactor = 1,
): number {
  const share = config.idleThrust ?? 0;
  if (share <= 0) return 0;
  const idlePitchSpeed = config.propPitchSpeed * Math.sqrt(share);
  if (idlePitchSpeed <= 1e-6) return 0;
  return (
    config.maxThrust *
    share *
    clamp(1 - Math.max(speed, 0) / idlePitchSpeed, 0, 1) *
    thrustFactor
  );
}

/**
 * Thrust at a throttle setting and an airspeed, newtons.
 *
 * A straight line between the two ends of the lever, which is what a throttle
 * is: shut is the idle and open is everything the propeller has. On an electric
 * aircraft the bottom end is zero and this is the plain product it has always
 * been; on an aeroplane with an engine the bottom end is not, and the whole
 * difference between the two is that one number.
 */
export function throttleThrust(
  config: AircraftConfig,
  throttle: number,
  speed: number,
  thrustFactor = 1,
): number {
  const idle = idleThrust(config, speed, thrustFactor);
  const full = fullThrust(config, speed, thrustFactor);
  return idle + clamp(throttle, 0, 1) * (full - idle);
}

/**
 * Fastest the airframe holds in level flight at full throttle, m/s.
 *
 * Thrust decays toward the propeller's pitch speed while drag climbs with the
 * square of airspeed, so the two cross at exactly one speed and that crossing
 * *is* the top speed. Solved from the same coefficients the flight model uses
 * rather than written down as a constant, so retuning the airframe cannot
 * leave the AI's idea of "as fast as the player" quietly wrong.
 *
 * Bisected over `[stall, propPitchSpeed]`, which is guaranteed to bracket it:
 * thrust is zero at the top of that range and exceeds drag at the bottom.
 */
export function maxLevelSpeed(
  config: AircraftConfig,
  density = SEA_LEVEL_DENSITY,
  thrustFactor = 1,
  liftFactor = 1,
): number {
  if (config.rotor) return rotorMaxLevelSpeed(config, density, thrustFactor);
  let low = stallSpeed(config, density, liftFactor);
  let high = config.propPitchSpeed;
  if (fullThrust(config, low, thrustFactor) <= levelDrag(config, low, density, liftFactor)) {
    // Cannot even hold the stall speed: there is no level flight to speak of.
    return low;
  }
  for (let i = 0; i < 48; i += 1) {
    const mid = (low + high) / 2;
    const excess =
      fullThrust(config, mid, thrustFactor) - levelDrag(config, mid, density, liftFactor);
    if (excess > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * The speed a wing is actually flown at between the places it is going.
 *
 * Not the fastest it will go: a wing held at full throttle is a wing being
 * flown for ten minutes. A little under the top speed is where a pilot leaves
 * it, and it is the honest speed to quote an endurance at.
 */
export const CRUISE_FRACTION = 0.85;

/** Cruising airspeed, m/s. */
export function cruiseSpeed(
  config: AircraftConfig,
  density = SEA_LEVEL_DENSITY,
): number {
  if (config.rotor) return rotorCruiseSpeed(config, density);
  return maxLevelSpeed(config, density) * CRUISE_FRACTION;
}

/**
 * How long a pack holds a steady cruise, seconds.
 *
 * The whole chain in one line: the airframe's own polar says what it costs to
 * stay up at that speed, the propeller says what that thrust costs in watts,
 * and the pack says how many of those watt-hours it is carrying. Quoted for
 * the hangar, where a pilot is choosing hardware and wants the number the
 * choice is actually about — the flight itself works it out again, minute by
 * minute, from what the pilot is really doing with the throttle.
 */
export function cruiseEndurance(
  config: AircraftConfig,
  motor: MotorSpec,
  battery: BatterySpec,
  density = SEA_LEVEL_DENSITY,
): number {
  if (config.rotor) return rotorCruiseEndurance(config, motor, battery, density);
  const speed = cruiseSpeed(config, density);
  const drag = levelDrag(config, speed, density);
  // Same chain, different currency: an engine's cruise is measured in litres an
  // hour against what is in the tank rather than in amps against what is in the
  // pack, and the aerodynamics either side of it are identical.
  const fuel = battery.fuel;
  if (fuel) {
    const burn = fuelBurn(motor, drag, speed, density);
    if (burn <= 1e-6) return Number.POSITIVE_INFINITY;
    return (fuel.litres / burn) * 3600;
  }
  const volts = nominalVoltage(battery);
  const amps =
    electricalPower(motor, drag, speed, density) / volts + AVIONICS_AMPS;
  if (amps <= 1e-6) return Number.POSITIVE_INFINITY;
  return (battery.capacityMah / 1000 / amps) * 3600;
}

/**
 * Throttle that holds a given airspeed in steady level flight, 0..1.
 *
 * The inverse of `maxLevelSpeed` at a single point, and what lets a pilot be
 * given a speed limit rather than a throttle limit: asking for the throttle
 * and asking for the speed then agree instead of fighting each other.
 * Returns 1 for a speed the airframe cannot sustain.
 */
export function levelThrottle(
  config: AircraftConfig,
  speed: number,
  density = SEA_LEVEL_DENSITY,
  thrustFactor = 1,
  liftFactor = 1,
): number {
  if (config.rotor) {
    return rotorLevelThrottle(config, speed, density, thrustFactor);
  }
  const available = fullThrust(config, speed, thrustFactor);
  if (available <= 1e-6) return 1;
  const needed = levelDrag(config, speed, density, liftFactor);
  // An aeroplane that is already making thrust with the stick shut needs less
  // of the lever to hold a speed than one starting from nothing, so the lever
  // is inverted from the idle rather than from zero. A speed the idle alone
  // would hold takes none of it — which is taxiing speed on the airframes this
  // applies to, not flying speed, because the idle is gone long before either.
  const idle = idleThrust(config, speed, thrustFactor);
  if (needed <= idle) return 0;
  return clamp((needed - idle) / (available - idle), 0, 1);
}

/**
 * Lift coefficient across the full angle-of-attack range.
 *
 * Below the stall it is the usual linear curve. Past it the wing blends into
 * flat-plate behaviour, so pulling too hard costs lift instead of granting
 * unlimited turn rate.
 */
export function liftCoefficient(config: AircraftConfig, alpha: number): number {
  const magnitude = Math.abs(alpha);
  const linear = config.cl0 + config.clAlpha * alpha;
  if (magnitude <= config.stallAngle) return linear;

  const blend = clamp((magnitude - config.stallAngle) / config.stallBlend, 0, 1);
  const sign = Math.sign(alpha) || 1;
  const peak = config.cl0 * sign + config.clAlpha * config.stallAngle * sign;
  const flatPlate = 2 * Math.sin(alpha) * Math.cos(alpha);
  return peak + (flatPlate - peak) * blend;
}

/** Drag coefficient, including the separation drag that appears past the stall. */
export function dragCoefficient(
  config: AircraftConfig,
  alpha: number,
  cl: number,
): number {
  const magnitude = Math.abs(alpha);
  const parasitic = config.cd0 + config.inducedDragFactor * cl * cl;
  if (magnitude <= config.stallAngle) return parasitic;

  const blend = clamp((magnitude - config.stallAngle) / config.stallBlend, 0, 1);
  const separated = 2 * Math.sin(alpha) * Math.sin(alpha);
  return parasitic + separated * blend;
}

/**
 * Advance one aircraft by exactly `dt` seconds.
 *
 * `dt` should be `PHYSICS_TIMESTEP`; the engine handles accumulating real time
 * into whole steps.
 */
/** Full elevon travel, radians. About 22 degrees, as the servos are set. */
const ELEVON_MAX_DEFLECTION = 0.384;
/** Full travel in a fifth of a second, which is a fast digital servo. */
const ELEVON_SERVO_RATE = 5;

export function stepFlightDynamics(
  state: AircraftState,
  input: FlightInput,
  environment: FlightEnvironment,
  dt: number,
): void {
  // An airframe with rotors on it is flown by a different set of equations
  // entirely. Dispatching here rather than at every call site is what lets the
  // engine, the missions and the AI step a quadcopter without knowing they are.
  if (state.config.rotor) {
    stepRotorDynamics(state, input, environment, dt);
    return;
  }
  const config = state.config;
  const damage = state.damage;
  // An aircraft on its belly is still an aircraft: the motor answers the
  // throttle and the elevons still move, which is what makes a take-off roll
  // fall out of the same model as a landing. Only a wreck stops flying.
  const airworthy = isAirworthy(state.status);

  // --- Motor spool ---------------------------------------------------------
  state.throttleCommand = clamp(input.throttle, 0, 1);
  const target = airworthy ? state.throttleCommand : 0;
  const spool = 1 - Math.exp(-dt / Math.max(config.throttleLag, 1e-3));
  state.throttle += (target - state.throttle) * spool;

  const altitude = environment.originHeight + state.position.z;
  const rho = airDensity(altitude);

  // --- Air-relative velocity ----------------------------------------------
  // Aerodynamics only ever sees this; ground velocity carries the wind, which
  // is exactly why airspeed and ground speed diverge when it is blowing.
  V.subtract(_airVelocity, state.velocity, environment.wind);
  const airspeed = V.length(_airVelocity);
  state.airspeed = airspeed;
  state.groundSpeed = V.length(state.velocity);

  forwardAxis(_forward, state.orientation);
  rightAxis(_right, state.orientation);

  V.set(_force, 0, 0, -config.mass * GRAVITY);

  let alpha = 0;
  let beta = 0;
  let lift = 0;
  /** Air arriving down the propeller's axis, m/s. Zero at rest. */
  let inflow = 0;

  if (airspeed > 0.25) {
    V.scale(_airDir, _airVelocity, 1 / airspeed);

    // Air velocity in body axes: (forward, left, up).
    rotateVectorInverse(_bodyAir, state.orientation, _airVelocity);
    const vf = _bodyAir.x;
    const vl = _bodyAir.y;
    const vu = _bodyAir.z;

    // Positive alpha = airflow arriving from below the wing.
    alpha = Math.atan2(-vu, Math.abs(vf) < 1e-3 ? 1e-3 : vf);
    // Positive beta = the aircraft is slipping toward its right wing.
    beta = Math.atan2(-vl, Math.sqrt(vf * vf + vu * vu) || 1e-3);

    // Flying backwards through a tumble would otherwise invert the model.
    if (vf < 0) {
      alpha = Math.sign(alpha) * (Math.PI - Math.abs(alpha));
    }

    const dynamicPressure = 0.5 * rho * airspeed * airspeed;
    const qS = dynamicPressure * config.wingArea;

    // Damage is applied to the coefficients rather than to the forces, so a
    // torn wing changes the shape of the whole envelope — the stall speed, the
    // best glide and the top speed all move together, as they would.
    const cl = liftCoefficient(config, alpha) * damage.liftFactor;
    const cd = dragCoefficient(config, alpha, cl) * damage.dragFactor;
    const cy = config.cyBeta * beta;

    // Lift acts perpendicular to the relative wind, in the aircraft's own
    // vertical plane: right x airflow points "up" for the airframe.
    V.cross(_liftDir, _right, _airDir);
    const liftDirLength = V.length(_liftDir);
    if (liftDirLength > 1e-6) {
      V.scale(_liftDir, _liftDir, 1 / liftDirLength);
      lift = qS * cl;
      V.addScaled(_force, _force, _liftDir, lift);
    }

    V.addScaled(_force, _force, _airDir, -qS * cd);
    V.addScaled(_force, _force, _right, qS * cy);

    // --- Aerodynamic moments ----------------------------------------------
    // Stability and damping are physics: they act on anything moving through
    // the air, a wreck included, which is what makes a disabled airframe
    // drop its nose and go down instead of parachuting flat. What a wreck no
    // longer has is a pilot, and that is what `authority` takes away.
    const authority = airworthy ? 1 : 0;

    // Rates in the pilot-facing sense: roll right, pitch up, yaw right.
    const rollRate = state.angularVelocity.x;
    const pitchRate = -state.angularVelocity.y;
    const yawRate = -state.angularVelocity.z;

    const halfSpanOverV = config.wingSpan / (2 * Math.max(airspeed, 1));
    const halfChordOverV = config.chord / (2 * Math.max(airspeed, 1));
    const pHat = rollRate * halfSpanOverV;
    const qHat = pitchRate * halfChordOverV;
    const rHat = yawRate * halfSpanOverV;

    // Only as much of each command as still reaches the air. A wing with
    // half an elevon left answers half as far, and the pilot finds that out
    // by running out of stick rather than by being told.
    const rollCmd = clampUnit(input.roll) * damage.rollAuthority * authority;
    const pitchCmd = clampUnit(input.pitch) * damage.pitchAuthority * authority;
    const yawCmd = clampUnit(input.yaw) * damage.yawAuthority * authority;

    const clMoment =
      config.clAileron * rollCmd +
      config.clP * pHat +
      config.clBeta * beta +
      // An airframe that is no longer symmetric drops a wing on its own.
      damage.rollBias;
    const cmMoment =
      config.cm0 +
      config.cmAlpha * alpha +
      config.cmQ * qHat +
      config.cmElevator * pitchCmd;
    const cnMoment =
      config.cnBeta * beta +
      config.cnR * rHat +
      config.cnRudder * yawCmd +
      config.cnAileron * rollCmd +
      damage.yawBias;

    const rollMoment = qS * config.wingSpan * clMoment;
    const pitchMoment = qS * config.chord * cmMoment;
    const yawMoment = qS * config.wingSpan * cnMoment;

    angularVelocityFromCommands(
      _momentBody,
      rollMoment,
      pitchMoment,
      yawMoment,
    );

    inflow = Math.max(vf, 0);
  } else {
    V.set(_momentBody, 0, 0, 0);
  }

  // --- Thrust --------------------------------------------------------------
  // Thrust decays toward the propeller's pitch speed, which is what bounds
  // level-flight top speed without inventing extra drag. It is applied outside
  // the airspeed test above because a propeller standing still is a propeller
  // at its most effective, not its least: static thrust is the whole of what
  // accelerates an aircraft down a take-off roll.
  //
  // What the pack is worth right now. An aircraft flown without a simulated
  // battery is on the thrust its configuration quotes and stays there; one
  // with a pack in it pulls a little harder off the charger, less as the
  // flight goes on, and nothing at all once the ESC has cut the motor — or,
  // on an aeroplane with an engine, once the tank has run dry, which is also
  // what takes the idle away and turns it back into a glider.
  const plant = state.powerplant;
  const thrust = throttleThrust(
    config,
    state.throttle,
    inflow,
    damage.thrustFactor * (plant ? plant.thrustFactor : 1),
  );
  V.addScaled(_force, _force, _forward, thrust);

  // The pack pays for the thrust that was actually made, at the speed the air
  // is arriving down the propeller: the same stick costs a fraction as much in
  // a dive as it does hanging off the propeller at walking pace.
  if (plant) stepPowerplant(plant, thrust, inflow, rho, dt);

  state.angleOfAttack = alpha;
  state.sideslip = beta;
  state.stalled = airworthy && Math.abs(alpha) > config.stallAngle;
  state.loadFactor = lift / (config.mass * GRAVITY);

  // --- Rigid-body rotation -------------------------------------------------
  // Euler's equations: I w' = M - w x (I w). The gyroscopic term is what makes
  // a hard rolling pull feel coupled rather than like three independent axes.
  const omega = state.angularVelocity;
  V.set(
    _inertiaOmega,
    config.inertiaRoll * omega.x,
    config.inertiaPitch * omega.y,
    config.inertiaYaw * omega.z,
  );
  V.cross(_gyro, omega, _inertiaOmega);
  V.set(
    _omegaDot,
    (_momentBody.x - _gyro.x) / config.inertiaRoll,
    (_momentBody.y - _gyro.y) / config.inertiaPitch,
    (_momentBody.z - _gyro.z) / config.inertiaYaw,
  );

  V.addScaled(omega, omega, _omegaDot, dt);
  const residual = Math.exp(-RESIDUAL_ANGULAR_DAMPING * dt);
  V.scale(omega, omega, residual);
  integrateAngularVelocity(state.orientation, state.orientation, omega, dt);

  // --- Linear motion -------------------------------------------------------
  V.scale(_term, _force, 1 / config.mass);
  V.addScaled(state.velocity, state.velocity, _term, dt);
  V.addScaled(state.position, state.position, state.velocity, dt);

  // --- Propeller -----------------------------------------------------------
  // Purely cosmetic: drives the rendered prop disc.
  state.propAngle =
    (state.propAngle + state.throttle * 260 * dt + (airworthy ? 4 * dt : 0)) %
    (Math.PI * 2);

  // --- Control surfaces ----------------------------------------------------
  // Also cosmetic. One surface per side does both jobs on a flying wing:
  // together for pitch, apart for roll. Positive is trailing edge up, which is
  // what commands nose up, so a right roll raises the right surface.
  const pitchDeflection = airworthy
    ? clampUnit(input.pitch) * damage.pitchAuthority
    : 0;
  const rollDeflection = airworthy
    ? clampUnit(input.roll) * damage.rollAuthority
    : 0;
  const travel = ELEVON_MAX_DEFLECTION * dt * ELEVON_SERVO_RATE;
  state.elevonLeft = moveTowards(
    state.elevonLeft,
    clamp(
      (pitchDeflection - rollDeflection) * ELEVON_MAX_DEFLECTION,
      -ELEVON_MAX_DEFLECTION,
      ELEVON_MAX_DEFLECTION,
    ),
    travel,
  );
  state.elevonRight = moveTowards(
    state.elevonRight,
    clamp(
      (pitchDeflection + rollDeflection) * ELEVON_MAX_DEFLECTION,
      -ELEVON_MAX_DEFLECTION,
      ELEVON_MAX_DEFLECTION,
    ),
    travel,
  );

  if (!V.isFinite3(state.position) || !V.isFinite3(state.velocity)) {
    // A NaN would silently freeze the aircraft; fail loudly instead.
    throw new Error(
      `Flight dynamics diverged for aircraft "${state.id}" — check the timestep`,
    );
  }
}
