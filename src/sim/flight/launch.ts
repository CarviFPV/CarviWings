/**
 * How a flight begins.
 *
 * Two ways, and the difference between them is where the pilot is standing.
 *
 * Every mission starts the aircraft already flying, some hundreds of metres
 * over the start point, because the mission is what is being flown and the
 * launch is not part of it. The RC ground view is the other way round: the
 * pilot is on the field with the aircraft, so the flight starts where a real
 * one does — nothing moving, the pilot holding a transmitter, and whoever is
 * holding the wing waiting to be told.
 *
 * Which is the part that has to be got right, because a launch is not an
 * event, it is a handshake. The throttle comes up first and the wing goes
 * second: a wing thrown at a motor that is not running is a wing in the grass,
 * every time, and it is not the pilot's fault. So a flight on a field opens
 * with the aircraft held — motionless, at head height, nose up, waiting — and
 * `HAND_LAUNCH_THROTTLE` on the pilot's own stick is what lets go of it. A
 * multirotor waits the same way and does not need throwing: it sits on the
 * grass until the throttle picks it up off its own rotors.
 *
 * An aeroplane on wheels is the third case, and it is the only one nobody
 * touches. Nothing is going to pick up a 25 kg UAV with an engine turning on
 * the front of it, and nothing has to: it is standing on its undercarriage with
 * the engine idling, and it leaves the ground the way a full-size aeroplane
 * does — throttle open, roll, rotate, fly. There is no throw to wait for and no
 * threshold to cross, so nothing here holds it: it starts on the surface and
 * the ground model and the pilot do the rest between them.
 *
 * The numbers here are the launch itself rather than an airframe property, so
 * they live in one place instead of being spread across whatever puts an
 * aircraft in the air. Everything except the throw speed is a constant: that
 * one is read off the airframe, because a wing has to leave the hand flying
 * and the speed at which it does depends on what it is.
 */

import { clamp, DEG_TO_RAD } from "../math/scalar";
import { forwardAxis } from "../math/quat";
import * as V from "../math/vec3";
import type { AircraftConfig } from "./config";
import { groundContactFor } from "./ground";
import { hoverThrottle } from "./multirotor";
import { stallSpeed } from "./physics";
import { FLIGHT_STATUS } from "./state";
import type { AircraftState } from "./state";

/** Height above the ground a wing leaves the launcher's hand, metres. */
export const HAND_LAUNCH_AGL = 2;

/** The climb it is thrown at, degrees. */
export const HAND_LAUNCH_PITCH_DEG = 20;

/**
 * How hard it is thrown, m/s.
 *
 * A hand launch is somebody taking two steps and letting go, which is around
 * eleven metres a second whatever is being launched — but a wing that leaves
 * the hand below its stall drops out of the throw instead of climbing away
 * from it, so a heavier airframe gets thrown harder. Which is exactly what
 * happens on a field: you throw a wing as hard as it needs.
 */
export const HAND_LAUNCH_SPEED = 11;

/** Margin over the stall a wing has to leave the hand with. */
const HAND_LAUNCH_STALL_MARGIN = 1.2;

/**
 * How far up the throttle has to come before the launcher lets go, 0..1.
 *
 * Not full: a stick is a physical thing and a pilot who means "go" does not
 * always arrive at the stop. Three quarters is unambiguously power on and is
 * nowhere near anything a pilot does by accident, which is the only other
 * thing this number has to be — the wing is in somebody's hand and letting go
 * of it early is the whole failure this exists to prevent.
 */
export const HAND_LAUNCH_THROTTLE = 0.75;

/** Airspeed a mission's aircraft is already flying at when it appears, m/s. */
export const AIRBORNE_LAUNCH_SPEED = 25;

/** The throttle it is holding when it does, 0..1. */
export const AIRBORNE_LAUNCH_THROTTLE = 0.65;

/** Where a standing pilot's eyes are above the ground under them, metres. */
export const PILOT_EYE_HEIGHT = 1.7;

/**
 * How far behind the launch point the pilot stands, metres.
 *
 * Not on it: somebody else is holding the aircraft, and the pilot is the one
 * behind them with the transmitter. A few metres is the difference between
 * watching a wing leave and watching it go past your ear.
 */
export const PILOT_STANDOFF = 4;

/** The state an airframe is handed the flight in. */
export interface Launch {
  /** Height above the surface it starts at, metres. */
  readonly altitudeAgl: number;
  /** Attitude it starts in, degrees, positive nose up. */
  readonly pitchDeg: number;
  /** Airspeed it starts with, m/s. */
  readonly airspeed: number;
  /** Throttle it starts on, 0..1. This is also where the stick begins. */
  readonly throttle: number;
  /**
   * True when it begins resting on the ground rather than flying.
   *
   * An aircraft that starts on its belly has landed rather than arrived: it
   * is on the surface, at rest, with the motor available, and the first thing
   * the flight model does with it is hold it there.
   */
  readonly grounded: boolean;
  /**
   * True when it begins in the launcher's hand rather than in the air.
   *
   * Not the same as resting on the ground: nothing is under it, and nothing
   * about it moves — not the airframe, not the air over it — until the pilot
   * opens the throttle and it is thrown.
   */
  readonly held: boolean;
}

/**
 * A flight that begins in the air, which is every mission.
 *
 * A wing arrives at a cruise it could have climbed to; a multirotor arrives
 * hanging on its own rotors, because one let go at 25 m/s would be a
 * quadcopter thrown across a field.
 */
export function airborneLaunch(
  config: AircraftConfig,
  altitudeAgl: number,
): Launch {
  if (config.rotor) {
    return {
      altitudeAgl,
      pitchDeg: 0,
      airspeed: 0,
      throttle: hoverThrottle(config),
      grounded: false,
      held: false,
    };
  }
  return {
    altitudeAgl,
    pitchDeg: 0,
    airspeed: AIRBORNE_LAUNCH_SPEED,
    throttle: AIRBORNE_LAUNCH_THROTTLE,
    grounded: false,
    held: false,
  };
}

/**
 * A flight that begins on the field the pilot is standing on.
 *
 * No airframe is going anywhere until the pilot asks it to, and all of them
 * wait with the throttle where the pilot's stick actually is — which, on a
 * field, is shut. A multirotor waits on its arms on the grass. An aeroplane
 * with an undercarriage waits on its wheels, nose-up on the gear, with the
 * engine idling. A wing waits in the hand that is going to throw it, at head
 * height and nose up, and is thrown by `stepHandLaunch` the moment the motor is
 * running.
 */
export function groundLaunch(config: AircraftConfig): Launch {
  if (config.undercarriage) {
    return {
      // Standing on its own gear, and nose-up on it: the height and the
      // attitude are the undercarriage's, so the first frame is already the
      // frame it would settle into if it had just rolled to a stop there.
      altitudeAgl: groundContactFor(config).restHeight,
      pitchDeg: groundContactFor(config).restPitch / DEG_TO_RAD,
      airspeed: 0,
      // Shut, which on an aeroplane with an engine is not stopped: it is
      // running, the propeller is turning, and the only reason it is not
      // already moving is that the wheels have not been asked to.
      throttle: 0,
      grounded: true,
      held: false,
    };
  }
  if (config.rotor) {
    return {
      // Resting on its arms rather than hovering over them: the height its
      // own ground contact holds it at, so the first frame is already the
      // frame it would settle into.
      altitudeAgl: groundContactFor(config).restHeight,
      pitchDeg: 0,
      airspeed: 0,
      throttle: 0,
      grounded: true,
      held: false,
    };
  }
  return {
    altitudeAgl: HAND_LAUNCH_AGL,
    pitchDeg: HAND_LAUNCH_PITCH_DEG,
    // Still in the hand: it has no speed of its own until the throw gives it
    // one, and the throttle is wherever the pilot is holding it, which is shut.
    airspeed: 0,
    throttle: 0,
    grounded: false,
    held: true,
  };
}

/** How hard this airframe has to be thrown to fly out of the throw, m/s. */
export function handLaunchSpeed(config: AircraftConfig): number {
  return Math.max(
    HAND_LAUNCH_SPEED,
    stallSpeed(config) * HAND_LAUNCH_STALL_MARGIN,
  );
}

// Scratch — the throw happens inside the flight loop, which allocates nothing.
const _throw = V.vec3();

/**
 * One step of a wing waiting in the launcher's hand.
 *
 * Nothing about the airframe moves, because somebody is holding it: no
 * aerodynamics, no weight, nothing to fly into and nothing to be blown off by.
 * The motor is the exception, and it is the whole point of the wait — it
 * answers the pilot's stick and spools exactly as it would in the air, so the
 * launcher hears it come up and the pilot hears what they are asking for.
 *
 * The height is re-taken from the ground every step rather than remembered.
 * The terrain under a launch point can still be settling while the pilot is
 * getting ready, and a wing left at the height the first frame guessed would
 * be thrown out of a hole — or off a ledge that is not there.
 *
 * Returns true once the throttle is open enough to be thrown on.
 */
export function stepHandLaunch(
  state: AircraftState,
  throttle: number,
  terrainHeight: number,
  dt: number,
): boolean {
  state.throttleCommand = clamp(throttle, 0, 1);
  const spool = 1 - Math.exp(-dt / Math.max(state.config.throttleLag, 1e-3));
  state.throttle += (state.throttleCommand - state.throttle) * spool;
  // Cosmetic, and the one moving part on a wing that is being held: a pilot
  // opening the throttle expects to see the propeller answer.
  state.propAngle = (state.propAngle + state.throttle * 260 * dt) % (Math.PI * 2);

  V.set(state.velocity, 0, 0, 0);
  V.set(state.angularVelocity, 0, 0, 0);
  state.terrainHeight = terrainHeight;
  state.position.z = terrainHeight + HAND_LAUNCH_AGL;
  state.altitudeAgl = HAND_LAUNCH_AGL;
  state.airspeed = 0;
  state.groundSpeed = 0;
  state.loadFactor = 1;
  state.stalled = false;

  return state.throttleCommand >= HAND_LAUNCH_THROTTLE;
}

/**
 * The throw.
 *
 * Two steps and let go, along the nose rather than along the horizon: the wing
 * is already sitting at the angle it is thrown at, so where it is pointed is
 * where it goes. From here it is an aircraft like any other, flying out of the
 * throw on the power the pilot asked for.
 */
export function releaseHandLaunch(state: AircraftState): void {
  const speed = handLaunchSpeed(state.config);
  forwardAxis(_throw, state.orientation);
  V.scale(state.velocity, _throw, speed);
  state.airspeed = speed;
  state.groundSpeed = speed;
  state.status = FLIGHT_STATUS.Flying;
}
