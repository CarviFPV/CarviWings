/**
 * Fly-to-point autopilot.
 *
 * The AI's hands. Given "get to that point at that speed", it produces the same
 * normalised `FlightInput` a pilot's keyboard does — nothing here can move an
 * aircraft, only ask the flight model to.
 *
 * Three channels, each built as a cascade — the way a real autopilot is — so
 * every loop is closed on a rate the airframe can actually deliver rather than
 * on a position it can only overshoot:
 *
 *   - **roll** — heading error commands a turn rate, the turn rate commands the
 *     bank that flies it, and the bank commands a roll rate the ailerons hold
 *   - **pitch** — altitude error commands a climb rate, the climb rate commands
 *     an elevator position damped on pitch rate, with back pressure added for
 *     the bank
 *   - **throttle** — a straight speed controller
 *
 * The cascade is what keeps an AI aircraft steady. An outer loop that commands
 * an *attitude* directly has to wait for the airframe to get there, and while
 * it waits it keeps commanding: by the time the wing is at the bank it asked
 * for, the reason for that bank has gone and the opposite one has taken its
 * place. Left like that a pilot flying a dead-straight leg rocks between thirty
 * degrees of left bank and thirty of right for ever, at full aileron, which is
 * neither what it was asked to do nor anything a wing does. Each loop here is
 * therefore several times slower than the one inside it, and the innermost one
 * is closed on the rate gyros.
 *
 * The whole thing is bounded by the airframe rather than by the AI's wishes: it
 * will not command a bank it lacks the airspeed for, and it stops pulling and
 * pushes the nose down when it approaches the stall. An enemy that flies into a
 * stall in a hard turn is behaving correctly; one that pulls through it is
 * cheating.
 */

import { toHeadingPitchRoll } from "../math/quat";
import { clamp, DEG_TO_RAD, RAD_TO_DEG } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import type { AircraftState } from "../flight/state";
import type { AircraftConfig } from "../flight/config";
import { GRAVITY } from "../flight/config";
import { stallSpeed } from "../flight/physics";
import { tiltAngle, tiltedHoverThrottle } from "../flight/multirotor";
import type { FlightInput } from "../input/types";

export interface AutopilotGoal {
  /** Where to fly, in local ENU metres. */
  readonly target: Vec3;
  /** Desired airspeed, m/s. */
  readonly speed: number;
  /** Nominal throttle before the speed correction. */
  readonly throttle: number;
  /** Hardest bank to command, degrees. */
  readonly maxBank: number;
  /** Additional climb demand, m/s. Terrain avoidance pushes this up. */
  readonly climbBias: number;
  /** Heading offset in degrees. Terrain avoidance steers with this. */
  readonly headingBias: number;
  /**
   * How the vertical channel is flown.
   *
   * `"altitude"` holds the target's height, which is what navigating wants.
   * `"direct"` points the velocity vector straight at the target, which is what
   * arriving at it wants: on a ramming pass the last two seconds need a flight
   * path angle, and a climb-rate loop clamped to a sane cruise figure cannot
   * produce one.
   */
  readonly aimMode?: "altitude" | "direct";
}

/**
 * Control gains.
 *
 * Tuned against the actual airframe rather than guessed, and spaced so the
 * cascade is stable on it: the heading loop settles in a couple of seconds, the
 * bank loop inside it in well under one, and the aileron loop inside that is
 * closed on a roll rate the wing reaches almost at once. Each is roughly three
 * to four times faster than the one outside it, which is what stops them
 * fighting each other.
 */
export const AUTOPILOT_GAINS = {
  /**
   * Seconds the heading loop takes to null a heading error.
   *
   * The outermost loop and so the slowest. Shortening it does not turn the
   * aircraft any faster — the turn rate and the bank are both limited below —
   * it only makes the loop chase the bank loop underneath it.
   */
  headingTimeConstant: 2.2,
  /** Fastest turn the heading loop will ask for, degrees per second. */
  maxTurnRate: 30,
  /**
   * Roll rate demanded per degree of bank error, per second.
   *
   * A bank error of thirty degrees therefore asks for about sixty degrees a
   * second of roll, which this wing holds comfortably, rather than for all the
   * aileron it has.
   */
  bankToRollRate: 2.2,
  /** Fastest roll the loop will ask for, degrees per second. */
  maxRollRate: 130,
  /** Aileron per degree per second of roll-rate error. */
  rollRateGain: 0.012,
  /** Climb demand in m/s per metre of altitude error. */
  altitudeGain: 0.11,
  /** Largest climb and descent the autopilot will ask for, m/s. */
  maxClimb: 9,
  maxSink: -9,
  /**
   * Steepest climb the autopilot will fly, degrees of flight path.
   *
   * A climb *rate* means quite different things at different speeds: nine
   * metres a second is a comfortable cruise climb at thirty and a deck angle
   * at fifteen. Capping the rate by an angle instead is what stops a slow
   * aircraft standing on its tail to answer a terrain call it has not got the
   * energy for — and standing on its tail is precisely what "it looks like it
   * is stalling" looks like. A wing that needs more than this to clear a ridge
   * has to turn round it, which is what the escape offset is for.
   */
  maxClimbAngle: 16,
  /** Pitch command per m/s of vertical speed error. */
  climbGain: 0.2,
  /** Elevator damping per degree per second of pitch rate. */
  pitchRateDamping: 0.011,
  /**
   * Climb given up per m/s the aircraft is short of its commanded speed.
   *
   * Total-energy control, and the reason an AI aircraft no longer hangs on the
   * propeller: a wing has one supply of energy and can spend it on height or on
   * speed, so a climb demand it has not got the airspeed for is a climb demand
   * that has to come down. Without this the altitude loop simply keeps pulling,
   * the speed decays to the stall guard, the guard shoves the nose down, and
   * the whole thing repeats — an aircraft porpoising along at a perfectly
   * healthy indicated airspeed, which is exactly what it looks like.
   */
  climbSpeedTrade: 0.7,
  /** Back pressure added for the load factor a bank costs. */
  bankCompensation: 0.16,
  /** Throttle per m/s of speed error. */
  speedGain: 0.09,
  /** Yaw command per degree of sideslip, to keep the turn coordinated. */
  yawCoordination: 0.035,
  /** Airspeed margin over the stall the autopilot protects, as a multiplier. */
  stallMargin: 1.32,
  /**
   * Airspeed band above the guard over which back pressure is given up, m/s.
   *
   * The protection is blended across it rather than switched at the guard
   * itself. A loop that snaps between pulling and pushing as the airspeed
   * crosses one number is a loop that oscillates around that number.
   */
  stallBlendBand: 3.5,
  /** Pitch command per degree of flight-path-angle error, when aiming direct. */
  flightPathGain: 0.055,
} as const;

/**
 * Working margin over the guard that a commanded cruise is held to.
 *
 * The guard is where the autopilot stops flying the aeroplane and starts
 * saving it. Asked for a speed sitting on top of it, the loops spend their
 * whole time in the protection instead of in the navigation — which is not
 * slow flight, it is an aircraft being caught and let go several times a
 * second.
 */
const COMMANDED_SPEED_MARGIN = 1.25;

/**
 * The slowest airspeed it is worth asking this autopilot to hold, m/s.
 *
 * Every AI that flies deliberately slowly — a contact cruising for endurance,
 * an interceptor held below the aircraft chasing it — floors its speed here, so
 * no pilot can ask for a cruise the stall protection would have to fly for it.
 */
export function minimumCommandedSpeed(
  config: AircraftConfig,
  liftFactor = 1,
): number {
  return (
    stallSpeed(config, undefined, liftFactor) *
    AUTOPILOT_GAINS.stallMargin *
    COMMANDED_SPEED_MARGIN
  );
}

/**
 * The cruise a pilot may actually ask this aeroplane to hold, m/s.
 *
 * `want` is what the mission would like — a formation cruise, a racer's pace,
 * a fly-in circuit — written when every aircraft in the sky was the same one.
 * There are four of them now, so what is wanted is held to what is in front of
 * the pilot: never faster than `reference` allows, which is the airframe's own
 * top speed and, where somebody has to be able to stay with it, the top speed
 * of whoever that is; and never slower than the stall protection would have to
 * fly for it, which is what stops a 2.1 m survey wing being asked for a cruise
 * it can only mush through.
 */
export function commandedSpeed(
  config: AircraftConfig,
  want: number,
  reference: number | null = null,
): number {
  const held = reference === null ? want : Math.min(want, reference);
  return Math.max(held, minimumCommandedSpeed(config));
}

/**
 * Turn rate a coordinated bank produces at a given airspeed, degrees per
 * second.
 */
export function turnRateForBank(bankDeg: number, airspeed: number): number {
  const speed = Math.max(airspeed, 1);
  return (GRAVITY * Math.tan(bankDeg * DEG_TO_RAD) * RAD_TO_DEG) / speed;
}

/**
 * The standing heading error a sustained bank costs the heading loop, degrees.
 *
 * The inverse of the loop below, and the reason it is worth having: a formation
 * holding a turn needs to know how far the autopilot will point outside it, so
 * the turn can be fed forward and only what is left over corrected.
 */
export function headingErrorForBank(bankDeg: number, airspeed: number): number {
  return (
    clamp(
      turnRateForBank(bankDeg, airspeed),
      -AUTOPILOT_GAINS.maxTurnRate,
      AUTOPILOT_GAINS.maxTurnRate,
    ) * AUTOPILOT_GAINS.headingTimeConstant
  );
}

/**
 * Produces the control input that flies `state` toward `goal`.
 *
 * Writes into `out` and returns it; nothing is allocated.
 */
export function flyTo(
  state: AircraftState,
  goal: AutopilotGoal,
  out: FlightInput,
): FlightInput {
  const g = AUTOPILOT_GAINS;
  const angles = toHeadingPitchRoll(state.orientation);
  const airspeed = state.airspeed;

  // Everything the autopilot is allowed to do is bounded by how much margin it
  // has over the stall — and a wing that has been torn has to be flown faster
  // to make the same weight, so the guard follows the damage on it.
  const guard =
    stallSpeed(state.config, undefined, state.damage.liftFactor) * g.stallMargin;
  const margin = clamp((airspeed - guard) / 8, 0, 1);

  // --- Roll: point the nose at the target ----------------------------------
  const dx = goal.target.x - state.position.x;
  const dy = goal.target.y - state.position.y;
  const horizontal = Math.hypot(dx, dy);

  let headingError = 0;
  if (horizontal > 1) {
    const desiredHeading =
      (Math.atan2(dx, dy) * RAD_TO_DEG + goal.headingBias + 360) % 360;
    headingError = ((desiredHeading - angles.headingDeg + 540) % 360) - 180;
  }

  // A slow aircraft cannot hold a hard bank without descending or stalling, so
  // the commanded bank is scaled by the margin rather than by wishful thinking.
  const bankLimit = goal.maxBank * (0.35 + 0.65 * margin);

  // Heading error asks for a turn rate, and the turn rate asks for the bank
  // that flies it. Going through the rate rather than straight to an angle is
  // what makes the loop behave the same at every speed: the same bank is twice
  // the turn at half the airspeed, so a gain in degrees of bank per degree of
  // error is only ever right at one speed and too hot at all the slower ones.
  const desiredTurnRate = clamp(
    headingError / g.headingTimeConstant,
    -g.maxTurnRate,
    g.maxTurnRate,
  );
  const desiredBank = clamp(
    Math.atan((desiredTurnRate * DEG_TO_RAD * Math.max(airspeed, 1)) / GRAVITY) *
      RAD_TO_DEG,
    -bankLimit,
    bankLimit,
  );

  // Bank error asks for a roll rate, and the ailerons hold that. The rate is
  // what the wing can be held to; the angle is only what it ends up at.
  const rollRateDeg = state.angularVelocity.x * RAD_TO_DEG;
  const desiredRollRate = clamp(
    (desiredBank - angles.rollDeg) * g.bankToRollRate,
    -g.maxRollRate,
    g.maxRollRate,
  );
  out.roll = clamp((desiredRollRate - rollRateDeg) * g.rollRateGain, -1, 1);

  // --- Pitch: get to the target's height, or point straight at it ----------
  const altitudeError = goal.target.z - state.position.z;
  let desiredClimb = clamp(
    altitudeError * g.altitudeGain,
    g.maxSink,
    g.maxClimb,
  );
  desiredClimb = clamp(desiredClimb + goal.climbBias, -12, 14);

  // Energy, not wishes. A wing short of the speed it was asked for has nothing
  // to climb with, and pulling anyway only takes more of the speed it has not
  // got. Terrain is not traded away for speed — a ridge does not care about
  // the energy budget — so the trade is floored at what avoidance is asking
  // for, and it is the climb angle below that decides what the aircraft can
  // actually deliver of it.
  const speedShortfall = Math.max(0, goal.speed - airspeed);
  desiredClimb = Math.max(
    desiredClimb - speedShortfall * g.climbSpeedTrade,
    Math.min(desiredClimb, goal.climbBias),
  );
  // And whatever survives that, it is still flown as a climb rather than as an
  // attitude: the steepest flight path allowed at this speed has the last word
  // over every demand above it, terrain's included.
  desiredClimb = Math.min(
    desiredClimb,
    Math.max(airspeed, 1) * Math.sin(g.maxClimbAngle * DEG_TO_RAD),
  );

  let pitch: number;
  if (goal.aimMode === "direct") {
    // Fly the velocity vector at the target rather than at its altitude.
    const groundSpeed = Math.max(Math.hypot(state.velocity.x, state.velocity.y), 0.5);
    const desiredAngle =
      Math.atan2(altitudeError, Math.max(horizontal, 1)) * RAD_TO_DEG;
    const currentAngle = Math.atan2(state.velocity.z, groundSpeed) * RAD_TO_DEG;
    pitch = (desiredAngle - currentAngle) * g.flightPathGain;
    // Terrain still gets a say, even on a firing pass.
    if (goal.climbBias > 0) {
      pitch = Math.max(pitch, (goal.climbBias - state.velocity.z) * g.climbGain);
    }
  } else {
    pitch = (desiredClimb - state.velocity.z) * g.climbGain;
  }

  // A banked wing has to pull harder just to hold height.
  const bankRadians = angles.rollDeg * DEG_TO_RAD;
  const loadFactor = 1 / Math.max(Math.cos(bankRadians), 0.25);
  pitch += (loadFactor - 1) * g.bankCompensation;

  // Stall protection: give up the back pressure across a band above the guard,
  // then push over below it. Blended rather than switched, so approaching the
  // guard costs the aircraft its climb instead of throwing the elevator.
  const stallBlend = clamp((airspeed - guard) / g.stallBlendBand, 0, 1);
  if (pitch > 0) pitch *= stallBlend;
  if (airspeed < guard) pitch -= (guard - airspeed) * 0.09;

  // Damped on the rate gyro, the same as the roll loop. The elevator on this
  // airframe is powerful and the pitch inertia tiny, so an undamped loop on
  // vertical speed alone answers a hundred metres of altitude error with a
  // zoom, and answers the zoom with a bunt.
  const pitchRateDeg = -state.angularVelocity.y * RAD_TO_DEG;
  out.pitch = clamp(pitch - pitchRateDeg * g.pitchRateDamping, -1, 1);

  // --- Throttle: hold the target speed -------------------------------------
  const speedError = goal.speed - airspeed;
  out.throttle = clamp(
    goal.throttle + speedError * g.speedGain + Math.max(0, desiredClimb) * 0.02,
    0,
    1,
  );

  // --- Yaw: keep the turn coordinated --------------------------------------
  out.yaw = clamp(
    state.sideslip * RAD_TO_DEG * g.yawCoordination,
    -0.5,
    0.5,
  );

  return out;
}

/** Heading error to a point, in degrees, signed left-negative. */
export function headingErrorTo(state: AircraftState, target: Vec3): number {
  const dx = target.x - state.position.x;
  const dy = target.y - state.position.y;
  if (Math.hypot(dx, dy) < 1e-3) return 0;
  const desired = (Math.atan2(dx, dy) * RAD_TO_DEG + 360) % 360;
  const current = toHeadingPitchRoll(state.orientation).headingDeg;
  return ((desired - current + 540) % 360) - 180;
}

/**
 * Control gains for flying a multirotor to a point.
 *
 * A position controller rather than a navigator, because that is what a
 * quadcopter needs and what it makes possible: ask for a velocity toward the
 * target, lean the airframe until it has that velocity, and hold the height on
 * the throttle. A wing has to keep flying and so has to be steered; a
 * quadcopter can simply stop over the place it was sent to, which is why the
 * same loop does the flying, the loitering and the landing.
 */
export const ROTOR_AUTOPILOT_GAINS = {
  /** Approach speed commanded per metre still to run, m/s. */
  approachGain: 0.35,
  /** Degrees of lean commanded per m/s of velocity error. */
  velocityToTilt: 2.5,
  /** Roll or pitch command per degree of attitude error. */
  tiltGain: 0.05,
  /** Attitude damping per degree per second of rotation. */
  tiltRateDamping: 0.006,
  /** Yaw command per degree of heading error. */
  headingGain: 0.02,
  /** Yaw damping per degree per second of yaw rate. */
  yawRateDamping: 0.0035,
  /** Climb demand in m/s per metre of altitude error. */
  altitudeGain: 0.45,
  maxClimb: 6,
  maxSink: -5,
  /** Throttle per m/s of vertical speed error. */
  climbGain: 0.06,
} as const;

/**
 * Produces the control input that flies a multirotor toward `goal`.
 *
 * Writes into `out` and returns it; nothing is allocated. The nose is pointed
 * at the target because that is where the camera is, but the aircraft is moved
 * by leaning rather than by turning, so it will crab, slide and back up
 * quite happily — which is exactly what a quadcopter does.
 */
export function flyToRotor(
  state: AircraftState,
  goal: AutopilotGoal,
  out: FlightInput,
): FlightInput {
  const g = ROTOR_AUTOPILOT_GAINS;
  const rotor = state.config.rotor;
  const tiltLimit = rotor?.maxTiltDeg ?? 55;
  const angles = toHeadingPitchRoll(state.orientation);

  const dx = goal.target.x - state.position.x;
  const dy = goal.target.y - state.position.y;
  const horizontal = Math.hypot(dx, dy);

  // --- Yaw: put the camera on the target -----------------------------------
  let headingError = 0;
  if (horizontal > 1) {
    const desired =
      (Math.atan2(dx, dy) * RAD_TO_DEG + goal.headingBias + 360) % 360;
    headingError = ((desired - angles.headingDeg + 540) % 360) - 180;
  }
  const yawRateDeg = -state.angularVelocity.z * RAD_TO_DEG;
  out.yaw = clamp(
    headingError * g.headingGain - yawRateDeg * g.yawRateDamping,
    -1,
    1,
  );

  // --- Lean: chase a velocity rather than a heading -------------------------
  // Slower the closer it gets, so arriving is arriving rather than overshooting
  // and coming back. Terrain avoidance steers by turning the bearing it is
  // approaching on, which works here for the same reason it works on a wing.
  const approach = Math.min(horizontal * g.approachGain, Math.max(goal.speed, 0));
  const bearing =
    (Math.atan2(dx, dy) + (goal.headingBias * Math.PI) / 180) as number;
  const wantX = horizontal > 1e-3 ? Math.sin(bearing) * approach : 0;
  const wantY = horizontal > 1e-3 ? Math.cos(bearing) * approach : 0;

  const errX = wantX - state.velocity.x;
  const errY = wantY - state.velocity.y;
  const heading = angles.headingDeg * DEG_TO_RAD;
  const along = errX * Math.sin(heading) + errY * Math.cos(heading);
  const across = errX * Math.cos(heading) - errY * Math.sin(heading);

  // Nose down to go forward, right wing down to go right.
  const pitchTarget = clamp(-along * g.velocityToTilt, -tiltLimit, tiltLimit);
  const rollTarget = clamp(across * g.velocityToTilt, -tiltLimit, tiltLimit);
  const rollRateDeg = state.angularVelocity.x * RAD_TO_DEG;
  const pitchRateDeg = -state.angularVelocity.y * RAD_TO_DEG;
  out.roll = clamp(
    (rollTarget - angles.rollDeg) * g.tiltGain - rollRateDeg * g.tiltRateDamping,
    -1,
    1,
  );
  out.pitch = clamp(
    (pitchTarget - angles.pitchDeg) * g.tiltGain -
      pitchRateDeg * g.tiltRateDamping,
    -1,
    1,
  );

  // --- Throttle: this is the only thing that makes it go up -----------------
  const desiredClimb = clamp(
    (goal.target.z - state.position.z) * g.altitudeGain + goal.climbBias,
    g.maxSink,
    g.maxClimb,
  );
  const packFactor = state.powerplant ? state.powerplant.thrustFactor : 1;
  const hover = tiltedHoverThrottle(
    state.config,
    tiltAngle(angles.pitchDeg, angles.rollDeg),
    packFactor * state.damage.thrustFactor,
  );
  out.throttle = clamp(
    hover + (desiredClimb - state.velocity.z) * g.climbGain,
    0,
    1,
  );

  return out;
}

/** Flies whichever kind of aircraft this is toward `goal`. */
export function flyToward(
  state: AircraftState,
  goal: AutopilotGoal,
  out: FlightInput,
): FlightInput {
  return state.config.rotor ? flyToRotor(state, goal, out) : flyTo(state, goal, out);
}
