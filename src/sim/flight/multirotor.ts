/**
 * Multirotor flight dynamics.
 *
 * The same kind of model as `physics.ts` — forces and moments integrated
 * through a mass and an inertia — for an aircraft that works nothing like a
 * wing.
 *
 * A quadcopter has one force to play with and it points out of the top of the
 * airframe. Everything a pilot does with one follows from that:
 *
 *   - **it hovers.** Thrust equals weight and the aircraft simply stays there,
 *     which no wing here can do, and which is why a quadcopter has no stall
 *     speed and no glide: cut the power and it is a falling object.
 *   - **it goes somewhere by leaning over.** The rotors tilt with the
 *     airframe, so the horizontal part of the thrust is what accelerates it
 *     and the vertical part is what is left to hold it up. Lean further and it
 *     goes faster and sinks unless the throttle comes up with it.
 *   - **it is stopped by its own shape.** There is no polar, only bluff-body
 *     drag, and at speed the aircraft is leaning so far over that the air is
 *     arriving on its belly rather than its nose. That is where the top speed
 *     comes from, along with the second limit underneath it: the further over
 *     it leans, the more of its own airspeed goes straight down the propeller
 *     axis, and a propeller meeting the air at its pitch speed makes no thrust
 *     at all.
 *   - **it is controlled by thrust, not by air.** Roll, pitch and yaw are
 *     differential rotor thrust, so authority is a function of how much thrust
 *     there is and not of how fast the aircraft is going. A quadcopter is
 *     exactly as controllable hovering as it is at 130 km/h, and completely
 *     uncontrollable with a flat pack.
 *   - **and with nothing left it tumbles.** The air pushes on the airframe a
 *     few millimetres below where its weight is and a hair off to one side, so
 *     the drag is a torque as well as a force. Four turning discs above the
 *     centre of gravity absorb all of it while the rotors are carrying the
 *     aircraft, which is every second of ordinary flight; let the thrust go and
 *     nothing is absorbing it any more, so a dead quadcopter rolls off and goes
 *     over rather than falling the way it was left.
 *
 * All five of those are a quadcopter, and one airframe here is not one. A body
 * built along the rotor axis with fins on the tail is flown by these same
 * equations, but two of the numbers they are handed change what comes out:
 *
 *   - **it weathervanes.** The drag couple that is a few millimetres of build
 *     error on a quadcopter is a tail on a six-centimetre arm here, at three
 *     times the airspeed. A rotor disc holds out what a rotor disc is worth and
 *     that is nowhere near it, so the couple reaches the airframe with the
 *     motors running and points the nose at the airflow — which is why a finned
 *     body flies where it is pointing instead of crabbing through its turns,
 *     and why it is damped by the air rather than only by its rotors.
 *   - **and the pilot is not looking down its roll axis.** The camera is on the
 *     nose of a body whose nose *is* the rotor axis, so what banks the picture
 *     is the airframe's yaw and what swings the picture is its roll. That is a
 *     flight-controller problem rather than an aerodynamic one and it is solved
 *     where it belongs, in `flightController.ts`, out of the same `stickMixDeg`
 *     a Betaflight pilot sets as `fpv_angle_mix`.
 *
 * Runs in the same local ENU frame, at the same fixed timestep, and shares the
 * powerplant, the pack and the damage model with the wings. Framework-agnostic
 * and free of I/O.
 */

import { clamp, clampUnit } from "../math/scalar";
import {
  angularVelocityFromCommands,
  forwardAxis,
  integrateAngularVelocity,
  leftAxis,
  rotateVectorInverse,
  upAxis,
} from "../math/quat";
import * as V from "../math/vec3";
import type { FlightInput } from "../input/types";
import { airDensity, SEA_LEVEL_DENSITY } from "./atmosphere";
import type { AircraftConfig, RotorConfig } from "./config";
import { GRAVITY } from "./config";
import type { AircraftState } from "./state";
import { isAirworthy } from "./state";
import type { BatterySpec, MotorSpec } from "./powerplant";
import {
  AVIONICS_AMPS,
  electricalPower,
  nominalVoltage,
  stepPowerplant,
} from "./powerplant";
// Type-only, so this does not make a cycle with the module that calls in here.
import type { FlightEnvironment } from "./physics";

/** Residual airframe damping so a tumbling wreck eventually settles. */
const RESIDUAL_ANGULAR_DAMPING = 0.35;

/**
 * Couple four turning rotors hold out on their own, as a fraction of the
 * thrust they are making times the arm they are on.
 *
 * A disc meeting the air at an angle pushes back on it, and that is what
 * absorbs the drag couple of an ordinary multirotor without the pilot ever
 * knowing it is there: a few millimetres of build error at thirty metres a
 * second is a hundredth of a newton metre, and four discs carrying the
 * aircraft's own weight swallow it whole. What they cannot swallow is a tail.
 * A fin set on a six-centimetre arm at ninety metres a second is two orders of
 * magnitude more than that, and a rotor disc has nothing to say about it — so
 * the couple that reaches the airframe is whatever is left over, which on a
 * quadcopter is nothing and on a finned body is nearly all of it.
 */
const ROTOR_DISC_COUPLE = 0.05;

// Scratch vectors — the step function must not allocate.
const _airVelocity = V.vec3();
const _bodyAir = V.vec3();
const _forward = V.vec3();
const _left = V.vec3();
const _up = V.vec3();
const _force = V.vec3();
const _bodyDrag = V.vec3();
const _dragCouple = V.vec3();
const _term = V.vec3();
const _omegaDot = V.vec3();
const _momentBody = V.vec3();
const _inertiaOmega = V.vec3();
const _gyro = V.vec3();

/** True for an airframe flown by this model rather than by the wing one. */
export function isRotorcraft(config: AircraftConfig): boolean {
  return config.rotor !== undefined;
}

/**
 * Drag area the airframe presents to air arriving from a given direction,
 * `Cd * A` in m^2.
 *
 * The body components are the whole of it: a quadcopter is roughly the same
 * shape from the nose and from a side, and quite a different one from
 * underneath, so two numbers describe it. `speed` is the length of the same
 * vector, passed in because every caller already has it.
 */
export function rotorDragArea(
  rotor: RotorConfig,
  forwardComponent: number,
  leftComponent: number,
  upComponent: number,
  speed: number,
): number {
  if (speed <= 1e-6) return rotor.frontalArea;
  const across = forwardComponent * forwardComponent + leftComponent * leftComponent;
  const along = upComponent * upComponent;
  return (rotor.frontalArea * across + rotor.axialArea * along) / (speed * speed);
}

/** How an airframe sits in steady level flight at one airspeed. */
export interface RotorTrim {
  /** How far the airframe leans out of the horizontal, radians. */
  readonly tilt: number;
  /** Thrust it takes to hold that, newtons. */
  readonly thrust: number;
  /** Drag it is holding against, newtons. */
  readonly drag: number;
  /** Air arriving down the rotor axis at that lean, m/s. */
  readonly inflow: number;
}

/** Steepest lean the trim solve will look at. A hair short of on its nose. */
const MAX_TRIM_TILT = Math.PI / 2 - 1e-6;

/**
 * The lean, thrust and drag of steady level flight at an airspeed.
 *
 * Solved rather than written down: the drag depends on how far the airframe is
 * leaning, and how far it is leaning depends on the drag. Level flight is the
 * lean where the two agree — where the drag at that lean is exactly the
 * sideways part of the thrust holding it, `W tan(tilt)`.
 *
 * Bisected rather than iterated. Feeding the drag back in as a new lean until
 * it settles is the obvious way to write this and it is a contraction only
 * while the airframe is roughly the same shape from every direction, which is
 * true of a quadcopter and emphatically not true of a rocket-bodied one: with
 * a drag area that falls by a factor of eight between broadside and nose-on,
 * the loop hops between a shallow lean that implies enormous drag and a steep
 * one that implies almost none, and never lands. The residual, on the other hand,
 * runs from negative at level to positive on its nose whatever the airframe is
 * shaped like, so halving the interval always finds the crossing.
 */
export function rotorTrim(
  config: AircraftConfig,
  speed: number,
  density = SEA_LEVEL_DENSITY,
): RotorTrim {
  const rotor = config.rotor;
  const weight = config.mass * GRAVITY;
  if (!rotor || !(speed > 0)) {
    return { tilt: 0, thrust: weight, drag: 0, inflow: 0 };
  }

  const dynamicPressure = 0.5 * density * speed * speed;
  const dragAt = (tilt: number): number => {
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    return (
      dynamicPressure *
      (rotor.frontalArea * cos * cos + rotor.axialArea * sin * sin)
    );
  };

  // Level flight needs some lean at any speed at all, and a lean short of
  // straight down always asks for more sideways thrust than the drag there
  // is, so the crossing is between the two.
  let low = 0;
  let high = MAX_TRIM_TILT;
  for (let i = 0; i < 32; i += 1) {
    const mid = (low + high) / 2;
    if (weight * Math.tan(mid) < dragAt(mid)) low = mid;
    else high = mid;
  }

  const tilt = (low + high) / 2;
  const drag = dragAt(tilt);
  return {
    tilt,
    thrust: Math.hypot(weight, drag),
    drag,
    inflow: speed * Math.sin(tilt),
  };
}

/**
 * Thrust a throttle position is worth, as a fraction of the rotors' full.
 *
 * Square, not straight. A speed controller turns its stick into rpm and a
 * propeller turns rpm into thrust as the square of it, and on a multirotor
 * that is not a detail: it is the reason an airframe pulling seven times its
 * own weight hovers at a bit over a third of the stick rather than at a
 * seventh of it, and the reason the throttle is coarse at the top of its
 * travel and fine at the bottom, where the hover the pilot is holding lives.
 *
 * A wing never notices the difference, which is why the wing model does not
 * carry it: a wing is trimmed to a cruise and left there, while a multirotor
 * is flown on the throttle every second it is airborne.
 */
export function rotorThrustFraction(throttle: number): number {
  const t = clamp(throttle, 0, 1);
  return t * t;
}

/** Thrust the rotors can still make at a given lean and airspeed, newtons. */
function availableThrust(
  config: AircraftConfig,
  inflow: number,
  thrustFactor: number,
): number {
  return (
    config.maxThrust *
    clamp(1 - Math.max(inflow, 0) / config.propPitchSpeed, 0, 1) *
    thrustFactor
  );
}

/**
 * Fastest the airframe holds in level flight at full throttle, m/s.
 *
 * Bisected on whether the rotors can still make the thrust the lean needs. Two
 * things close the envelope from opposite ends and they close it sharply:
 * leaning further to beat the drag costs thrust to the propeller's pitch speed,
 * and needing more thrust means leaning further. Somewhere between the two the
 * aircraft runs out, and that crossing is the top speed.
 */
export function rotorMaxLevelSpeed(
  config: AircraftConfig,
  density = SEA_LEVEL_DENSITY,
  thrustFactor = 1,
): number {
  const reachable = (speed: number): boolean => {
    const trim = rotorTrim(config, speed, density);
    return availableThrust(config, trim.inflow, thrustFactor) >= trim.thrust;
  };
  // Hovering is the one speed a multirotor can always hold, if it can hold
  // anything: an airframe that cannot even do that has no level flight at all.
  if (!reachable(0)) return 0;

  let low = 0;
  let high = config.propPitchSpeed;
  for (let i = 0; i < 48; i += 1) {
    const mid = (low + high) / 2;
    if (reachable(mid)) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Cruising airspeed, m/s: what a multirotor is actually flown between places at. */
export function rotorCruiseSpeed(
  config: AircraftConfig,
  density = SEA_LEVEL_DENSITY,
): number {
  const fraction = config.rotor?.cruiseFraction ?? 0.55;
  return rotorMaxLevelSpeed(config, density) * fraction;
}

/**
 * Throttle that holds a given airspeed in steady level flight, 0..1.
 *
 * Returns 1 for a speed the airframe cannot sustain, exactly as the wing's
 * version does.
 */
export function rotorLevelThrottle(
  config: AircraftConfig,
  speed: number,
  density = SEA_LEVEL_DENSITY,
  thrustFactor = 1,
): number {
  const trim = rotorTrim(config, speed, density);
  const available = availableThrust(config, trim.inflow, thrustFactor);
  if (available <= 1e-6) return 1;
  // The inverse of the throttle curve, so asking for a thrust and asking for
  // the stick that makes it agree instead of being out by its square.
  return Math.sqrt(clamp(trim.thrust / available, 0, 1));
}

/** Throttle that holds a hover. The first number a multirotor pilot learns. */
export function hoverThrottle(
  config: AircraftConfig,
  thrustFactor = 1,
): number {
  return rotorLevelThrottle(config, 0, SEA_LEVEL_DENSITY, thrustFactor);
}

/**
 * Throttle that holds height while the airframe is leaning over, 0..1.
 *
 * Only the upright part of the thrust is holding the aircraft up, so a lean
 * has to be paid for with power or it is paid for with altitude. Every
 * multirotor pilot does this by hand and every assisted mode has to do it for
 * them, which is why it is here rather than written out twice.
 */
export function tiltedHoverThrottle(
  config: AircraftConfig,
  tiltRadians: number,
  thrustFactor = 1,
): number {
  const upright = Math.max(Math.cos(tiltRadians), 0.2);
  // Throttle goes as the square root of thrust, and the thrust needed goes as
  // one over the cosine of the lean.
  return clamp(hoverThrottle(config, thrustFactor) / Math.sqrt(upright), 0, 1);
}

/** How far out of the horizontal an attitude is leaning, radians. */
export function tiltAngle(pitchDeg: number, rollDeg: number): number {
  const upright =
    Math.cos((pitchDeg * Math.PI) / 180) * Math.cos((rollDeg * Math.PI) / 180);
  return Math.acos(clamp(upright, -1, 1));
}

/**
 * How long a pack holds a steady cruise, seconds.
 *
 * The same chain as the wing's, with the airframe's own trim in place of the
 * polar: the lean says what thrust it takes to sit at that speed, the
 * propeller says what that thrust costs in watts at the air arriving down its
 * axis, and the pack says how many of those watt-hours it is carrying.
 */
export function rotorCruiseEndurance(
  config: AircraftConfig,
  motor: MotorSpec,
  battery: BatterySpec,
  density = SEA_LEVEL_DENSITY,
): number {
  const speed = rotorCruiseSpeed(config, density);
  const trim = rotorTrim(config, speed, density);
  const volts = nominalVoltage(battery);
  const amps =
    electricalPower(motor, trim.thrust, trim.inflow, density) / volts +
    AVIONICS_AMPS;
  if (amps <= 1e-6) return Number.POSITIVE_INFINITY;
  return (battery.capacityMah / 1000 / amps) * 3600;
}

/**
 * Advance one multirotor by exactly `dt` seconds.
 *
 * Called by `stepFlightDynamics` for any airframe carrying a `rotor` block, so
 * the engine, the missions and the AI never have to know which kind of
 * aircraft they are stepping.
 */
export function stepRotorDynamics(
  state: AircraftState,
  input: FlightInput,
  environment: FlightEnvironment,
  dt: number,
): void {
  const config = state.config;
  const rotor = config.rotor;
  if (!rotor) return;
  const damage = state.damage;
  // A quadcopter sitting on the ground is still a quadcopter: the motors
  // answer the throttle, which is the whole of what taking off is. Only a
  // wreck stops flying.
  const airworthy = isAirworthy(state.status);

  // --- Motor spool ---------------------------------------------------------
  state.throttleCommand = clamp(input.throttle, 0, 1);
  const target = airworthy ? state.throttleCommand : 0;
  const spool = 1 - Math.exp(-dt / Math.max(config.throttleLag, 1e-3));
  state.throttle += (target - state.throttle) * spool;

  const altitude = environment.originHeight + state.position.z;
  const rho = airDensity(altitude);

  // --- Air-relative velocity ----------------------------------------------
  V.subtract(_airVelocity, state.velocity, environment.wind);
  const airspeed = V.length(_airVelocity);
  state.airspeed = airspeed;
  state.groundSpeed = V.length(state.velocity);

  forwardAxis(_forward, state.orientation);
  leftAxis(_left, state.orientation);
  upAxis(_up, state.orientation);

  // Air velocity in body axes: (forward, left, up).
  rotateVectorInverse(_bodyAir, state.orientation, _airVelocity);
  const vf = _bodyAir.x;
  const vl = _bodyAir.y;
  const vu = _bodyAir.z;

  V.set(_force, 0, 0, -config.mass * GRAVITY);

  // --- Rotor thrust --------------------------------------------------------
  // Air arriving down the rotor axis, which on a leaning airframe is most of
  // its own airspeed. Positive is the discs climbing into it, and that is what
  // takes the thrust away.
  const inflow = Math.max(vu, 0);
  const propFalloff = clamp(1 - inflow / config.propPitchSpeed, 0, 1);
  const plant = state.powerplant;
  const packFactor = plant ? plant.thrustFactor : 1;
  const thrust =
    rotorThrustFraction(state.throttle) *
    config.maxThrust *
    propFalloff *
    damage.thrustFactor *
    packFactor;
  V.addScaled(_force, _force, _up, thrust);

  // --- Body drag -----------------------------------------------------------
  // Quadratic and taken per body axis, so the airframe presents its small face
  // to the air when it is flying nose-first and its large one when it has
  // leaned over to go quickly. Which of the two it is doing is not a mode: it
  // falls out of the attitude, every step.
  if (airspeed > 1e-4) {
    const q = 0.5 * rho * airspeed * damage.dragFactor;
    V.set(
      _bodyDrag,
      -q * rotor.frontalArea * vf,
      -q * rotor.frontalArea * vl,
      -q * rotor.axialArea * vu,
    );
    V.addScaled(_force, _force, _forward, _bodyDrag.x);
    V.addScaled(_force, _force, _left, _bodyDrag.y);
    V.addScaled(_force, _force, _up, _bodyDrag.z);
  } else {
    V.set(_bodyDrag, 0, 0, 0);
  }

  // --- Moments -------------------------------------------------------------
  // Differential thrust and nothing else. What the mixer has to push apart is
  // the thrust the rotors are making, so the authority follows the pack and
  // the throttle rather than the airspeed — which is why a quadcopter answers
  // identically hovering and flat out, and why one at idle in the air can be
  // rolled but only slowly.
  const authority = airworthy ? 1 : 0;
  const mixer = clamp(
    state.throttle / Math.max(rotor.authorityThrottle, 1e-3),
    0,
    1,
  );
  const headroom =
    config.maxThrust *
    damage.thrustFactor *
    packFactor *
    rotor.armLength *
    (0.35 + 0.65 * mixer);

  const rollCmd = clampUnit(input.roll) * damage.rollAuthority * authority;
  const pitchCmd = clampUnit(input.pitch) * damage.pitchAuthority * authority;
  const yawCmd = clampUnit(input.yaw) * damage.yawAuthority * authority;

  // Rates in the pilot-facing sense: roll right, pitch up, yaw right.
  const rollRate = state.angularVelocity.x;
  const pitchRate = -state.angularVelocity.y;
  const yawRate = -state.angularVelocity.z;

  // A tail resists being rotated, and the faster the air is arriving the
  // harder it resists: a fin a body's length behind the weight meets the air
  // at the rotation rate times that length, so what it gives back climbs with
  // the airspeed where the rotors' own damping sits still. Zero on anything
  // without a tail, which is every ordinary multirotor. It is not control and
  // it does not need a pilot or a pack — a dead finned body is damped in
  // exactly the same way, which is half of why it arrives nose-first.
  const finDamping = rotor.finDamping * airspeed * (rho / SEA_LEVEL_DENSITY);

  const rollMoment =
    headroom * rotor.rollAuthority * rollCmd -
    (rotor.rollDamping + finDamping) * rollRate +
    damage.rollBias * headroom;
  const pitchMoment =
    headroom * rotor.pitchAuthority * pitchCmd -
    (rotor.pitchDamping + finDamping) * pitchRate;
  const yawMoment =
    headroom * rotor.yawAuthority * yawCmd -
    rotor.yawDamping * yawRate +
    damage.yawBias * headroom;

  angularVelocityFromCommands(_momentBody, rollMoment, pitchMoment, yawMoment);

  // --- The couple the drag makes on its own ---------------------------------
  // The air does not push through the centre of gravity, so the drag on the
  // airframe is a torque about it as well as a force, `r x F` and nothing
  // more. What `r` is decides what the torque does, and the two airframes here
  // are opposite cases of it.
  //
  // On a quadcopter it is a few millimetres: the pack is on the top plate and
  // the arms, props and camera hang under it, so the air pushes below the
  // weight and the couple is the wrong way round to settle anything — the
  // aircraft leans, leaning puts more of it across the airflow, and that pushes
  // it further over. On a finned body it is the tail, an arm fifteen times as
  // long, and it means the opposite: the couple always swings the end the air
  // is arriving at upwind, and on an airframe that flies nose-first that points
  // the nose at its own flight path.
  //
  // What holds any of it out is the rotors, and not through the mixer: four
  // discs turning above the centre of gravity, and a turning disc meeting the
  // air at an angle pushes back on it. But a disc can only hold out what a disc
  // is worth, and that is the whole of the difference. A quadcopter's couple is
  // far inside it, which is why none of it is felt with a pack in the aircraft
  // and why a dying one tips off and tumbles the moment the thrust goes. A
  // finned body's is two orders of magnitude outside it, so nearly all of it
  // reaches the airframe with the motors running — that is what a weathercock
  // is, and it is why this one flies where it is pointing instead of crabbing
  // through its turns.
  const discCouple = thrust * rotor.armLength * ROTOR_DISC_COUPLE;
  V.cross(_dragCouple, state.dragCentre, _bodyDrag);
  const coupleSize = V.length(_dragCouple);
  if (coupleSize > discCouple) {
    V.addScaled(_momentBody, _momentBody, _dragCouple, 1 - discCouple / coupleSize);
  }

  // The pack pays for the thrust that was actually made, at the speed the air
  // is arriving down the rotor axis — which for a quadcopter hanging in a
  // hover is nothing at all, and that is exactly why hovering is expensive.
  if (plant) stepPowerplant(plant, thrust, inflow, rho, dt);

  // Angle of attack and sideslip are the airflow in the airframe's own frame,
  // measured the same way a wing's are so the instruments read the same. On a
  // multirotor they describe how it is meeting the air rather than how much
  // lift it is making, and it never stalls, because there is no wing to.
  state.angleOfAttack =
    airspeed > 0.25 ? Math.atan2(-vu, Math.hypot(vf, vl) || 1e-3) : 0;
  state.sideslip =
    airspeed > 0.25 ? Math.atan2(-vl, Math.hypot(vf, vu) || 1e-3) : 0;
  state.stalled = false;
  state.loadFactor = thrust / (config.mass * GRAVITY);

  // --- Rigid-body rotation -------------------------------------------------
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

  // --- Propellers ----------------------------------------------------------
  // Purely cosmetic: drives the rendered discs.
  state.propAngle =
    (state.propAngle + state.throttle * 420 * dt + (airworthy ? 20 * dt : 0)) %
    (Math.PI * 2);

  if (!V.isFinite3(state.position) || !V.isFinite3(state.velocity)) {
    // A NaN would silently freeze the aircraft; fail loudly instead.
    throw new Error(
      `Flight dynamics diverged for aircraft "${state.id}" — check the timestep`,
    );
  }
}
