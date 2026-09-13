/**
 * Aircraft simulation state.
 *
 * This is the single source of truth for where an aircraft is and what it is
 * doing. The renderer reads it; it never writes to it. Player and enemy
 * aircraft use the identical structure so they can share one flight model.
 */

import type { Quat } from "../math/quat";
import { fromHeadingPitchRoll, quat } from "../math/quat";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import { vec3 } from "../math/vec3";
import type { AircraftConfig } from "./config";
import type { AircraftDamage, Warhead } from "./damage";
import { createDamage } from "./damage";
import type { Powerplant } from "./powerplant";

export const FLIGHT_STATUS = {
  Flying: "FLYING",
  /** On its belly and still moving: a landing run, or a take-off roll. */
  Sliding: "SLIDING",
  /** Down, intact and stopped. The pilot can open the throttle and go again. */
  Landed: "LANDED",
  /**
   * In the launcher's hand, waiting for the throttle.
   *
   * A wing has no undercarriage, so it cannot begin a flight by rolling: it
   * begins one by being thrown, and nobody throws it until the pilot has the
   * motor running. Until they do it is simply held — nothing about the
   * airframe moves, and nothing can go wrong with it — and the moment the
   * throttle comes up it is thrown and is flying. See `flight/launch.ts`.
   */
  Held: "HELD",
  /**
   * Wrecked in the air and on its way down.
   *
   * The airframe has lost too much to fly but is still a physical object: the
   * flight model keeps integrating it, without a pilot and without control,
   * until it reaches the ground.
   */
  Disabled: "DISABLED",
  Crashing: "CRASHING",
  Crashed: "CRASHED",
  Destroyed: "DESTROYED",
} as const;

export type FlightStatus = (typeof FLIGHT_STATUS)[keyof typeof FLIGHT_STATUS];

/**
 * True while the pilot still has an aircraft: airborne, sliding to a stop, or
 * sitting on the ground with the motor available.
 *
 * The distinction that matters nearly everywhere is "is there still something
 * to fly", not "are the wheels off" — a wing that has landed is not a wreck,
 * and the throttle, the control surfaces and the sound all keep working.
 */
export function isAirworthy(status: FlightStatus): boolean {
  return (
    status === FLIGHT_STATUS.Flying ||
    status === FLIGHT_STATUS.Sliding ||
    status === FLIGHT_STATUS.Landed ||
    status === FLIGHT_STATUS.Held
  );
}

/**
 * True while the aircraft has not started flying: on the ground undamaged, or
 * still in the hand it is about to be thrown out of.
 *
 * What every caller wants from it is the same either way — there is nothing to
 * stabilise, no attitude to hold and no approach to judge — so the wing on the
 * grass and the wing at head height in front of the launcher answer alike.
 */
export function isGrounded(status: FlightStatus): boolean {
  return (
    status === FLIGHT_STATUS.Sliding ||
    status === FLIGHT_STATUS.Landed ||
    status === FLIGHT_STATUS.Held
  );
}

/** True only for the wing waiting in the launcher's hand. */
export function isHeld(status: FlightStatus): boolean {
  return status === FLIGHT_STATUS.Held;
}

/** True once the airframe is gone: a wreck, or destroyed outright. */
export function isWrecked(status: FlightStatus): boolean {
  return (
    status === FLIGHT_STATUS.Disabled ||
    status === FLIGHT_STATUS.Crashing ||
    status === FLIGHT_STATUS.Crashed ||
    status === FLIGHT_STATUS.Destroyed
  );
}

export const AIRCRAFT_ROLE = {
  Player: "PLAYER",
  Enemy: "ENEMY",
  /** The aircraft a formation is flown on. There is at most one. */
  Lead: "LEAD",
  /** Another aircraft holding a slot in the same formation. */
  Wingman: "WINGMAN",
  /** A rival flying the same gate course as the player. */
  Racer: "RACER",
  /** Somebody else's aircraft, sharing the sky over a festival field. */
  Festival: "FESTIVAL",
} as const;

export type AircraftRole = (typeof AIRCRAFT_ROLE)[keyof typeof AIRCRAFT_ROLE];

export interface AircraftState {
  readonly id: string;
  readonly role: AircraftRole;
  readonly config: AircraftConfig;

  /** Position in local ENU metres. */
  position: Vec3;
  /** Ground velocity in local ENU m/s (includes any wind carried by the air). */
  velocity: Vec3;
  /** Attitude: rotates body-frame vectors into the local ENU frame. */
  orientation: Quat;
  /** Angular velocity in the body frame, rad/s. */
  angularVelocity: Vec3;

  /** Commanded throttle, 0..1. */
  throttleCommand: number;
  /** Actual motor output after spool lag, 0..1. */
  throttle: number;

  status: FlightStatus;
  /** Seconds spent in the CRASHING state. */
  crashTimer: number;

  /**
   * What is left of the airframe after the contacts it has taken.
   *
   * Read every step by the flight model, so a damaged aircraft flies badly
   * because its aerodynamics are worse rather than because anything is
   * fighting the pilot.
   */
  damage: AircraftDamage;
  /**
   * The motor and the pack, if this aircraft is flying a simulated one.
   *
   * Null is not "no motor": it is an aircraft whose electrics are not being
   * simulated at all, which is every AI contact in the sky and the player's
   * own wing whenever the pilot has taken the range limit off. Such an
   * aircraft flies on the thrust its configuration quotes, for as long as the
   * mission lasts.
   */
  powerplant: Powerplant | null;
  /**
   * Where this individual airframe's drag acts, in body metres from the centre
   * of gravity — forward, left and up.
   *
   * Read by the multirotor model, which turns it into the couple that a
   * drag force acting anywhere but through the centre of gravity produces. The
   * axis part of it is the airframe's, out of `RotorConfig.dragCentreOffset`;
   * the two across it are this one aircraft's, a millimetre or so of the
   * asymmetry every real one is built with — one arm a shade heavier, the pack
   * a shade off centre, the camera on one side of the middle. Under power the
   * turning rotors absorb it and the pilot never knows it is there. With a flat
   * pack nothing is absorbing it any more, and it is the whole reason a dead
   * quadcopter rolls off and tumbles instead of falling exactly as it was
   * left.
   */
  readonly dragCentre: Vec3;
  /**
   * The charge on the wing, if this aircraft is carrying one.
   *
   * Mission equipment rather than an airframe property: the same wing flies an
   * intercept armed and a formation display empty.
   */
  warhead: Warhead | null;

  // --- Derived values, refreshed once per physics step ----------------------
  /** True airspeed, m/s. */
  airspeed: number;
  /** Speed over the ground, m/s. */
  groundSpeed: number;
  /** Angle of attack, radians. */
  angleOfAttack: number;
  /** Sideslip angle, radians. */
  sideslip: number;
  /** Load factor in g. */
  loadFactor: number;
  /** True while the wing is past its stall angle. */
  stalled: boolean;
  /** Terrain elevation directly below, metres above the ellipsoid. */
  terrainHeight: number;
  /** Height above terrain, metres. */
  altitudeAgl: number;
  /** Total propeller revolutions, used purely to spin the rendered prop. */
  propAngle: number;
  /**
   * Elevon deflections in radians, positive trailing edge up.
   *
   * Cosmetic, like `propAngle`: the aerodynamic moments come from the control
   * input directly. These follow the same commands through a servo rate so the
   * surfaces on screen are the ones the pilot is actually moving.
   */
  elevonLeft: number;
  elevonRight: number;
}

export interface AircraftSpawn {
  readonly id: string;
  readonly role: AircraftRole;
  readonly config: AircraftConfig;
  readonly position: Vec3;
  readonly headingDeg: number;
  readonly pitchDeg?: number;
  readonly rollDeg?: number;
  readonly airspeed: number;
  readonly throttle: number;
  /**
   * True for an aircraft that begins resting on the ground rather than flying.
   *
   * The flight model reads the same state either way — what this changes is
   * only where it starts from, so a quadcopter put down on the grass is not
   * reported as having landed the instant the flight begins.
   */
  readonly grounded?: boolean;
  /**
   * True for an aircraft that begins in the launcher's hand.
   *
   * A wing thrown off a field: held at head height, nose up, motionless, until
   * the pilot opens the throttle. Nothing is airborne and nothing is resting on
   * anything, so it is neither of the two above.
   */
  readonly held?: boolean;
  /** Fitted by missions that arm their aircraft. */
  readonly warhead?: Warhead | null;
  /** The pack and combo aboard. Left out, the electrics are not simulated. */
  readonly powerplant?: Powerplant | null;
  /**
   * This airframe's build tolerance, in body metres. Left out, one is worked
   * out from the aircraft's id, so the same aircraft is always built the same
   * way and no two of them are built alike.
   */
  readonly dragCentre?: Vec3;
}

/**
 * How far off centre an airframe's drag is allowed to act, as a fraction of a
 * rotor arm.
 *
 * A couple of percent of eighty millimetres is a millimetre and a half, which
 * is about what a hand-built quadcopter is out by once the pack is strapped on.
 */
const BUILD_TOLERANCE = 0.02;

/**
 * The drag centre of one individual airframe.
 *
 * Deterministic in the aircraft's id rather than random: a flight replayed from
 * the same mission seed has to come out the same way, and this is exactly the
 * sort of tiny asymmetry that decides which way a dying quadcopter rolls off.
 */
function buildDragCentre(spawn: AircraftSpawn): Vec3 {
  const rotor = spawn.config.rotor;
  if (!rotor) return vec3();
  const rng = createRng(`drag-centre:${spawn.id}`);
  const spread = rotor.armLength * BUILD_TOLERANCE;
  return vec3(
    rng.range(-spread, spread),
    rng.range(-spread, spread),
    rotor.dragCentreOffset,
  );
}

export function createAircraftState(spawn: AircraftSpawn): AircraftState {
  const orientation = fromHeadingPitchRoll(
    quat(),
    spawn.headingDeg,
    spawn.pitchDeg ?? 0,
    spawn.rollDeg ?? 0,
  );

  // Launch along the nose so the aircraft starts in trimmed forward flight.
  const heading = (spawn.headingDeg * Math.PI) / 180;
  const pitch = ((spawn.pitchDeg ?? 0) * Math.PI) / 180;
  const velocity = vec3(
    Math.sin(heading) * Math.cos(pitch) * spawn.airspeed,
    Math.cos(heading) * Math.cos(pitch) * spawn.airspeed,
    Math.sin(pitch) * spawn.airspeed,
  );

  return {
    id: spawn.id,
    role: spawn.role,
    config: spawn.config,
    position: { ...spawn.position },
    velocity,
    orientation,
    angularVelocity: vec3(),
    throttleCommand: spawn.throttle,
    throttle: spawn.throttle,
    status: spawn.held
      ? FLIGHT_STATUS.Held
      : spawn.grounded
        ? FLIGHT_STATUS.Landed
        : FLIGHT_STATUS.Flying,
    crashTimer: 0,
    damage: createDamage(),
    powerplant: spawn.powerplant ?? null,
    dragCentre: spawn.dragCentre ?? buildDragCentre(spawn),
    warhead: spawn.warhead ?? null,
    airspeed: spawn.airspeed,
    groundSpeed: spawn.airspeed,
    angleOfAttack: 0,
    sideslip: 0,
    loadFactor: 1,
    stalled: false,
    terrainHeight: 0,
    altitudeAgl: 0,
    propAngle: 0,
    elevonLeft: 0,
    elevonRight: 0,
  };
}
