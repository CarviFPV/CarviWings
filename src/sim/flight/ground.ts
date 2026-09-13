/**
 * Meeting the ground.
 *
 * A wing arriving at the surface is not one event but two, and which one it is
 * depends entirely on how it got there. Flown into a hillside it is a crash:
 * the airframe stops where it hit and there is nothing left to fly. Flown
 * *onto* a field — wings level, nose up, sinking slowly — it is a landing, and
 * a foam wing has no undercarriage to put down, so a landing is a belly slide:
 * the wing touches, the ground takes its vertical speed away, friction scrubs
 * off the rest over a few dozen metres, and it stops intact.
 *
 * Both are the same collision. What separates them is a handful of numbers
 * taken at the moment of contact, which is what `classifyTouchdown` is:
 *
 *   - **sink rate into the surface.** The one that decides most arrivals. A
 *     foam wing absorbs a firm arrival and breaks on a hard one, and because
 *     the rate is measured against the *surface normal* rather than against
 *     the horizon, a shallow pass down a hillside reads as gentle and flying
 *     level into the same hillside reads as an impact.
 *   - **bank.** A wing down is a wingtip in the ground, which cartwheels.
 *   - **nose attitude relative to the slope.** A nose buried in the dirt digs
 *     in instead of sliding.
 *   - **sideslip.** Arriving crabbed puts the airframe sideways at 70 km/h.
 *   - **ground speed.** Above a certain speed a belly slide is a tumble.
 *
 * An aeroplane with an undercarriage under it changes all of that and none of
 * this. It is the same collision judged against different numbers — wheels take
 * a sink a belly breaks at and are made to roll at speed, and they are far less
 * forgiving of arriving banked or crabbed — and afterwards it is the same
 * constraint with a tenth of the friction, which is the whole reason one can be
 * accelerated to flying speed under its own power and a foam wing cannot.
 *
 * Everything after touchdown is `stepGroundContact`, which is a constraint
 * rather than a scripted animation: the aerodynamic model keeps running
 * underneath it — throttle, elevons, drag and lift all still apply — and this
 * only holds the aircraft on the surface, takes away the speed the ground
 * takes away, and lays the airframe flat. Which means a landing runs backwards
 * just as well: open the throttle on the ground, accelerate along the surface,
 * and the same lift that was holding the wing up before flies it off again.
 */

import { clamp, DEG_TO_RAD } from "../math/scalar";
import {
  forwardAxis,
  fromBasis,
  nlerpQuat,
  quat,
  rightAxis,
  upAxis,
} from "../math/quat";
import type { Quat } from "../math/quat";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftConfig } from "./config";
import { GRAVITY } from "./config";
import type { AircraftState } from "./state";
import type { TerrainSampler } from "../terrain/types";

/** What separates a landing from a crash. */
export interface TouchdownLimits {
  /** Closing speed along the surface normal a belly landing survives, m/s. */
  readonly sinkRate: number;
  /** Bank relative to the surface a belly landing survives, radians. */
  readonly bank: number;
  /** How far below the surface the nose may point on touchdown, radians. */
  readonly noseDown: number;
  /** Sideslip a belly landing survives, radians. */
  readonly sideslip: number;
  /** Ground speed above which a belly slide becomes a tumble, m/s. */
  readonly groundSpeed: number;
}

/**
 * Limits for the foam wing in `config.ts`.
 *
 * Three metres a second is a firm arrival rather than a gentle one — a wing
 * flown onto a field at a normal approach sinks at one to two — and it is
 * deliberately not tighter than that: a landing that only works when flown
 * perfectly is a landing nobody ever makes. The speed ceiling sits above
 * anything the airframe reaches in level flight, so only an arrival out of a
 * dive is refused on speed alone.
 */
export const TOUCHDOWN_LIMITS: TouchdownLimits = {
  sinkRate: 3,
  bank: 25 * DEG_TO_RAD,
  noseDown: 12 * DEG_TO_RAD,
  sideslip: 20 * DEG_TO_RAD,
  groundSpeed: 32,
};

export const TOUCHDOWN_VERDICT = {
  Slide: "SLIDE",
  Crash: "CRASH",
} as const;

export type TouchdownVerdict =
  (typeof TOUCHDOWN_VERDICT)[keyof typeof TOUCHDOWN_VERDICT];

/** How the airframe behaves once it is on its belly. */
export interface GroundContactOptions {
  /** Height of the aircraft's reference point above the surface at rest, m. */
  readonly restHeight: number;
  /**
   * Sliding friction of a foam belly on ground, dimensionless.
   *
   * Deliberately one number for every surface: the simulator knows the shape
   * of the ground but not what it is made of, and a value between grass and
   * tarmac stops a wing in a believable few dozen metres on either.
   */
  readonly friction: number;
  /** Pitch the airframe rests at relative to the surface, radians. */
  readonly restPitch: number;
  /** How far elevator can rotate that resting pitch, radians. */
  readonly rotateRange: number;
  /** Time constant for the airframe settling flat onto the surface, seconds. */
  readonly settleSeconds: number;
  /** Ground speed below which the aircraft counts as stopped, m/s. */
  readonly stopSpeed: number;
}

/**
 * Two of these decide how a landing looks and feels.
 *
 * `restHeight` is not a safety margin, it is the airframe: the aircraft's
 * reference point sits at the mid-thickness of the wing root and the lowest
 * thing on it — the camera pod — hangs 86 mm below that, so twelve centimetres
 * is a belly on the ground rather than a wing hovering over it.
 *
 * `restPitch` is what decides whether an aircraft that has just touched down
 * stays down. At a degree and a half the wing needs 80 km/h before it makes
 * its own weight in lift, which is faster than any approach, so a landing
 * settles instead of ballooning — and full up-elevator adds enough incidence
 * to fly off again at a little over 40 km/h, which is what makes a take-off
 * roll possible without a single line of code that knows about taking off.
 */
export const GROUND_CONTACT: GroundContactOptions = {
  restHeight: 0.12,
  friction: 0.45,
  restPitch: 1.5 * DEG_TO_RAD,
  rotateRange: 6 * DEG_TO_RAD,
  settleSeconds: 0.22,
  stopSpeed: 0.4,
};

/**
 * How far clear of its resting height an aircraft has to get before it counts
 * as having left the ground, metres.
 *
 * Without a gap between touching and leaving, a wing that floats a handful of
 * centimetres in the flare reads as a landing, a take-off and a second landing
 * in the space of half a second. A climb-out passes through this in a moment,
 * so nothing real is delayed by it.
 */
export const GROUND_RELEASE_MARGIN = 0.75;

/**
 * Limits for the CA35-160 in `config.ts`.
 *
 * A quadcopter arrives at the ground in a completely different way to a wing.
 * It has no approach speed to fly, so it comes down more or less on the spot,
 * and it does not care which way round it is doing it: sideways is a normal
 * landing on a multirotor, not a crash. What it will not survive is arriving
 * with any real horizontal speed — there is no belly to slide on, only four
 * propellers to catch and cartwheel over.
 */
export const ROTOR_TOUCHDOWN_LIMITS: TouchdownLimits = {
  sinkRate: 4,
  bank: 30 * DEG_TO_RAD,
  noseDown: 30 * DEG_TO_RAD,
  // A multirotor has no keel and does not have to be pointed where it is
  // going, so there is no such thing as arriving crabbed on one.
  sideslip: 90 * DEG_TO_RAD,
  groundSpeed: 8,
};

/**
 * How a quadcopter sits once it is down.
 *
 * Flat on its arms rather than nose-up on a belly, forty-five millimetres off
 * the ground on the stack under it, and it stops where it lands: carbon arms
 * on grass do not slide the way a foam wing does.
 */
export const ROTOR_GROUND_CONTACT: GroundContactOptions = {
  restHeight: 0.045,
  friction: 0.9,
  restPitch: 0,
  rotateRange: 0,
  settleSeconds: 0.12,
  stopSpeed: 0.3,
};

/**
 * How the X10 Interceptor sits once it is down.
 *
 * On its tail, which is the whole difference. A quadcopter puts its arms on the
 * grass and its centre of gravity forty-five millimetres up; this one stands on
 * four fins with two hundred and twenty millimetres of aircraft underneath the
 * same point, so a resting height worked out for a racing frame would have half
 * the body buried in the field. Everything else about being on the ground is a
 * multirotor's: it comes down on the spot, it stops where it lands, and it
 * leaves again on its own rotors.
 */
export const ROCKET_GROUND_CONTACT: GroundContactOptions = {
  restHeight: 0.222,
  friction: 0.9,
  restPitch: 0,
  rotateRange: 0,
  settleSeconds: 0.12,
  stopSpeed: 0.3,
};

/**
 * What an aeroplane on wheels survives arriving at.
 *
 * An undercarriage is not a small improvement on a belly, it is what an
 * aeroplane is meant to arrive on. Wheels and their legs are built to take the
 * sink a foam belly breaks at, and rolling at speed is what they are *for* —
 * a UAV touching down at 90 km/h on the numbers has made a good landing, where
 * a wing sliding onto grass at that speed is a tumble. So the two limits a
 * belly is really judged on both go up a long way.
 *
 * The two that do not are bank and sideslip, and they get tighter rather than
 * looser. A wing down on a belly landing scrapes; a wing down on a landing gear
 * is one leg taking the whole aeroplane, and arriving crabbed on wheels puts a
 * side load through them that they are not braced for. Which is exactly how a
 * real one is written off: not by coming down hard, but by coming down sideways.
 */
export const WHEELED_TOUCHDOWN_LIMITS: TouchdownLimits = {
  sinkRate: 4.5,
  bank: 15 * DEG_TO_RAD,
  noseDown: 8 * DEG_TO_RAD,
  sideslip: 12 * DEG_TO_RAD,
  groundSpeed: 45,
};

/**
 * How an aeroplane with an undercarriage sits, rolls and leaves the ground.
 *
 * Worked out from the airframe rather than written down, because the aircraft
 * that share it are a 2.6 m UAV and a 6 m one and a single set of numbers
 * would bury one of them in the field.
 *
 * `restHeight` is the gear: a tricycle undercarriage holds the wing root about
 * a twelfth of the span off the ground, which is where the propeller clears the
 * grass and where the airframe is actually photographed standing.
 *
 * `friction` is the whole of why an aeroplane on wheels can take off and a wing
 * on its belly cannot. Foam scrubbing on grass is 0.45 and eats most of what a
 * propeller can produce; three inflated wheels rolling is a tenth of that, so
 * nearly all of the thrust goes into accelerating the aeroplane, which is what
 * a take-off run is.
 *
 * `restPitch` and `rotateRange` are the aeroplane sitting nose-up on its
 * mainwheels and the elevator rotating it. Three degrees on the ground and nine
 * more on the stick is a rotation at about 80 km/h on these airframes — fast
 * enough that the aircraft has to be flown off rather than hauled off, and slow
 * enough that the runway does not have to be a mile long.
 */
export function wheeledGroundContact(
  config: AircraftConfig,
): GroundContactOptions {
  return {
    restHeight: config.wingSpan / 12,
    friction: 0.045,
    restPitch: 3 * DEG_TO_RAD,
    rotateRange: 9 * DEG_TO_RAD,
    settleSeconds: 0.25,
    stopSpeed: 0.4,
  };
}

/**
 * How far clear a multirotor has to get before it counts as flying, metres.
 *
 * Much less than a wing's. The margin exists to stop a float in the flare
 * reading as a take-off, and a quadcopter has no flare — while a metre of
 * hovering over the grass is somewhere a multirotor genuinely lives, so a
 * wing's margin would leave one sitting there reported as still on the ground.
 */
export const ROTOR_GROUND_RELEASE_MARGIN = 0.25;

/** The touchdown limits that belong to an airframe. */
export function touchdownLimitsFor(config: AircraftConfig): TouchdownLimits {
  if (config.undercarriage) return WHEELED_TOUCHDOWN_LIMITS;
  return config.rotor ? ROTOR_TOUCHDOWN_LIMITS : TOUCHDOWN_LIMITS;
}

/** How an airframe behaves once it is on the ground. */
export function groundContactFor(config: AircraftConfig): GroundContactOptions {
  if (config.undercarriage) return wheeledGroundContact(config);
  if (config.shape === "rocket") return ROCKET_GROUND_CONTACT;
  return config.rotor ? ROTOR_GROUND_CONTACT : GROUND_CONTACT;
}

/** How far clear of its resting height an airframe has to get to be flying. */
export function groundReleaseMarginFor(config: AircraftConfig): number {
  return config.rotor ? ROTOR_GROUND_RELEASE_MARGIN : GROUND_RELEASE_MARGIN;
}

export interface GroundContactResult {
  /** Speed along the surface after the ground has taken its share, m/s. */
  readonly slideSpeed: number;
  /** True once the airframe has come to rest. */
  readonly stopped: boolean;
  /** False while the aircraft is floating clear inside the release margin. */
  readonly touching: boolean;
}

// Scratch — the ground step runs inside the physics loop and must not allocate.
const _forward = V.vec3();
const _right = V.vec3();
const _up = V.vec3();
const _tangent = V.vec3();
const _planeRight = V.vec3();
const _targetForward = V.vec3();
const _targetUp = V.vec3();
const _targetLeft = V.vec3();
const _target: Quat = quat();

/**
 * The up-normal of the terrain surface under a column.
 *
 * Central differences over the sampled field rather than anything the terrain
 * provider knows about itself: the field is what the aircraft is being flown
 * against, so the slope that matters is the slope the field has. `spacing`
 * wants to be around the grid's own resolution — much smaller and it measures
 * the interpolation rather than the ground.
 */
export function surfaceNormal(
  out: Vec3,
  terrain: TerrainSampler,
  localX: number,
  localY: number,
  spacing = 6,
): Vec3 {
  const dzdx =
    (terrain.heightAt(localX + spacing, localY) -
      terrain.heightAt(localX - spacing, localY)) /
    (2 * spacing);
  const dzdy =
    (terrain.heightAt(localX, localY + spacing) -
      terrain.heightAt(localX, localY - spacing)) /
    (2 * spacing);
  V.set(out, -dzdx, -dzdy, 1);
  return V.normalize(out, out);
}

/** Closing speed along the surface normal. Positive is into the ground. */
export function sinkIntoSurface(velocity: Vec3, normal: Vec3): number {
  return -V.dot(velocity, normal);
}

/**
 * Whether an arrival at the surface is a landing or a crash.
 *
 * Every angle is measured against the surface, not against the horizon: on a
 * slope, "wings level" means level with the slope, and that is what a pilot
 * putting a wing down on a hillside field is actually flying.
 */
export function classifyTouchdown(
  state: AircraftState,
  normal: Vec3,
  limits: TouchdownLimits = TOUCHDOWN_LIMITS,
): TouchdownVerdict {
  if (sinkIntoSurface(state.velocity, normal) > limits.sinkRate) {
    return TOUCHDOWN_VERDICT.Crash;
  }
  if (V.length(state.velocity) > limits.groundSpeed) {
    return TOUCHDOWN_VERDICT.Crash;
  }
  if (Math.abs(state.sideslip) > limits.sideslip) {
    return TOUCHDOWN_VERDICT.Crash;
  }

  // A right bank tips the body's right axis below the surface plane, so the
  // normal's component along it is the sine of the bank angle.
  rightAxis(_right, state.orientation);
  const bank = Math.asin(clamp(-V.dot(_right, normal), -1, 1));
  if (Math.abs(bank) > limits.bank) return TOUCHDOWN_VERDICT.Crash;

  // Positive is nose above the surface plane, which is the flare.
  forwardAxis(_forward, state.orientation);
  const noseAngle = Math.asin(clamp(V.dot(_forward, normal), -1, 1));
  if (noseAngle < -limits.noseDown) return TOUCHDOWN_VERDICT.Crash;

  return TOUCHDOWN_VERDICT.Slide;
}

/**
 * Holds an aircraft on the surface for one step and scrubs off its speed.
 *
 * Called after the flight model has already integrated the step, so the forces
 * it applies — thrust, lift, drag, weight — are all in the velocity by the time
 * this runs. What is left is what the ground does: stop the aircraft sinking
 * through it, resist the slide, kill the sideways scrub the keel of the
 * airframe would never allow, and lay the wing flat on the slope.
 *
 * Never lifts the aircraft off, and never holds it down: an aircraft already
 * clear of its resting height is left entirely alone, so lift carries it away
 * the moment there is enough of it. A take-off roll therefore needs no code of
 * its own — it is a landing with the throttle open.
 */
export function stepGroundContact(
  state: AircraftState,
  surfaceHeight: number,
  normal: Vec3,
  pitchCommand: number,
  dt: number,
  options: GroundContactOptions = GROUND_CONTACT,
): GroundContactResult {
  const velocity = state.velocity;
  const restZ = surfaceHeight + options.restHeight;

  if (state.position.z > restZ) {
    // Airborne, if only just: a float in the flare or the first inch of a
    // climb-out. The ground has nothing to say about either.
    return { slideSpeed: V.length(velocity), stopped: false, touching: false };
  }

  // --- The surface pushes back ---------------------------------------------
  state.position.z = restZ;
  const intoSurface = V.dot(velocity, normal);
  if (intoSurface < 0) {
    // Fully inelastic: a foam belly does not bounce, it absorbs.
    V.addScaled(velocity, velocity, normal, -intoSurface);
  }

  // --- Friction and scrub ---------------------------------------------------
  // The slide runs in the surface plane, and along it the airframe is not
  // symmetric: it will slide a long way forward on its belly and almost none
  // sideways, where the fuselage and the wing roots dig in.
  forwardAxis(_forward, state.orientation);
  V.addScaled(_tangent, _forward, normal, -V.dot(_forward, normal));
  if (V.lengthSquared(_tangent) < 1e-8) {
    // Nose straight up or down against the surface: any direction in the plane
    // will do, so take one from the aircraft's own up axis instead.
    upAxis(_up, state.orientation);
    V.addScaled(_tangent, _up, normal, -V.dot(_up, normal));
    if (V.lengthSquared(_tangent) < 1e-8) V.set(_tangent, 0, 1, 0);
  }
  V.normalize(_tangent, _tangent);
  V.cross(_planeRight, _tangent, normal);
  V.normalize(_planeRight, _planeRight);

  const along = V.dot(velocity, _tangent);
  const across = V.dot(velocity, _planeRight);

  // Sliding friction, capped so it can never drag the aircraft backwards.
  const load = GRAVITY * Math.max(V.dot(normal, V.UP as Vec3), 0.2);
  const decelerate = Math.min(options.friction * load * dt, Math.abs(along));
  const alongAfter = along - Math.sign(along) * decelerate;
  // Sideways motion is not scrubbed, it is stopped: nothing about this
  // airframe slides across its own span.
  const acrossAfter = across * Math.exp(-6 * dt);

  V.addScaled(velocity, velocity, _tangent, alongAfter - along);
  V.addScaled(velocity, velocity, _planeRight, acrossAfter - across);

  // --- The airframe lies down ----------------------------------------------
  // Belly on the slope, nose along the current heading, and a few degrees of
  // incidence the pilot can add to with elevator. The heading itself is left
  // alone so the aircraft can still be steered along the ground.
  const restPitch =
    options.restPitch + clamp(pitchCommand, -1, 1) * options.rotateRange;
  const cosP = Math.cos(restPitch);
  const sinP = Math.sin(restPitch);
  V.set(
    _targetForward,
    _tangent.x * cosP + normal.x * sinP,
    _tangent.y * cosP + normal.y * sinP,
    _tangent.z * cosP + normal.z * sinP,
  );
  V.normalize(_targetForward, _targetForward);
  V.set(
    _targetUp,
    normal.x * cosP - _tangent.x * sinP,
    normal.y * cosP - _tangent.y * sinP,
    normal.z * cosP - _tangent.z * sinP,
  );
  // `fromBasis` takes a square root of the matrix trace and is unforgiving of
  // a basis that is even slightly off square, so the axes are re-orthogonalised
  // rather than trusted to two cross products.
  V.addScaled(
    _targetUp,
    _targetUp,
    _targetForward,
    -V.dot(_targetUp, _targetForward),
  );
  V.normalize(_targetUp, _targetUp);
  V.cross(_targetLeft, _targetUp, _targetForward);
  V.normalize(_targetLeft, _targetLeft);
  fromBasis(_target, _targetForward, _targetLeft, _targetUp);

  const settle = 1 - Math.exp(-dt / Math.max(options.settleSeconds, 1e-3));
  nlerpQuat(state.orientation, state.orientation, _target, settle);

  // Roll and pitch are held by the ground; yaw is only damped, so rudder still
  // does something during a landing run.
  const held = Math.exp(-8 * dt);
  state.angularVelocity.x *= held;
  state.angularVelocity.y *= held;
  state.angularVelocity.z *= Math.exp(-2 * dt);

  // Nothing is forced to zero here. Coulomb friction takes the last of the
  // speed away on its own — the cap above lands it exactly on nothing — and a
  // wing that was snapped to a standstill every step could never be driven off
  // that standstill by a propeller, which is the one thing a take-off roll is.
  const slideSpeed = V.length(velocity);
  return {
    slideSpeed,
    stopped: slideSpeed < options.stopSpeed,
    touching: true,
  };
}
