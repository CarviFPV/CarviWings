/**
 * Airframe damage.
 *
 * Two wings meeting in the air is rarely a clean binary. A foam interceptor
 * that clips a wingtip in a crossing pass is not the same event as one that
 * takes another aircraft head-on at a hundred and ninety kilometres an hour,
 * and the simulator should not pretend it is. This module decides what a
 * particular contact did to a particular airframe.
 *
 * Two things decide that, and they are the two the pilot actually controls:
 *
 *   how hard    the closing speed *along the line of contact*. A fast pass
 *               that barely touches carries almost none of its speed into the
 *               structure; a square hit carries all of it.
 *   where       which part of the airframe met the other aircraft. A flying
 *               wing has no fuselage to lose: the wing is the lift, the
 *               trailing edge is the control, and the tail is the motor.
 *
 * The result is either a scrape, an airframe that still flies but no longer
 * flies well, an airframe that has stopped being an aircraft and is now
 * falling, or nothing at all left to fall.
 *
 * Damage is cumulative, so three survivable knocks eventually add up to a
 * write-off. Everything here is data driven and framework-free, and the flight
 * model reads the result every step through `AircraftDamage`.
 */

import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import { rotateVectorInverse } from "../math/quat";
import type { AircraftState } from "./state";

/** Which part of the airframe the other aircraft arrived on. */
export const IMPACT_SECTOR = {
  /** Nose-on: the camera, the battery bay and everything behind them. */
  Nose: "NOSE",
  /** A wing panel or a tip, out where the lift and the elevons are. */
  Wing: "WING",
  /** From behind, where a pusher wing keeps its motor and its propeller. */
  Tail: "TAIL",
  /** Belly or spine: a hit square on the centre section. */
  Body: "BODY",
} as const;

export type ImpactSector = (typeof IMPACT_SECTOR)[keyof typeof IMPACT_SECTOR];

/** What a contact did to one airframe. */
export const DAMAGE_OUTCOME = {
  /** Paint and pride. Nothing that changes how it flies. */
  Scrape: "SCRAPE",
  /** Still an aircraft, but not the one that took off. */
  Damaged: "DAMAGED",
  /** No longer an aircraft. It is falling. */
  Disabled: "DISABLED",
  /** Gone, in pieces, in the air. */
  Destroyed: "DESTROYED",
} as const;

export type DamageOutcome = (typeof DAMAGE_OUTCOME)[keyof typeof DAMAGE_OUTCOME];

/**
 * The running condition of one airframe.
 *
 * Every field but `integrity` and `hits` is a factor the flight model applies
 * directly, so a damaged aircraft flies badly because its aerodynamics are
 * worse — not because a special case somewhere is fighting the pilot.
 */
export interface AircraftDamage {
  /** Structural condition: 1 as it left the bench, 0 written off. */
  integrity: number;
  /** Fraction of the wing's lift still being made, 0..1. */
  liftFactor: number;
  /** Multiplier on drag from torn foam and bent surfaces, >= 1. */
  dragFactor: number;
  /** Fraction of the motor's thrust still available, 0..1. */
  thrustFactor: number;
  /** How much of the roll command still reaches the air, 0..1. */
  rollAuthority: number;
  /** How much of the pitch command still reaches the air, 0..1. */
  pitchAuthority: number;
  /** How much of the yaw command still reaches the air, 0..1. */
  yawAuthority: number;
  /**
   * Standing rolling-moment coefficient from an airframe that is no longer
   * symmetric. This is the wing dropping on its own, and the pilot holding
   * opposite stick for the rest of the flight.
   */
  rollBias: number;
  /** Standing yawing-moment coefficient from the drag of a torn panel. */
  yawBias: number;
  /** How many contacts this airframe has taken. */
  hits: number;
}

export function createDamage(): AircraftDamage {
  return {
    integrity: 1,
    liftFactor: 1,
    dragFactor: 1,
    thrustFactor: 1,
    rollAuthority: 1,
    pitchAuthority: 1,
    yawAuthority: 1,
    rollBias: 0,
    yawBias: 0,
    hits: 0,
  };
}

/** Puts an airframe back on the bench. Used when an aircraft is reset. */
export function resetDamage(damage: AircraftDamage): void {
  damage.integrity = 1;
  damage.liftFactor = 1;
  damage.dragFactor = 1;
  damage.thrustFactor = 1;
  damage.rollAuthority = 1;
  damage.pitchAuthority = 1;
  damage.yawAuthority = 1;
  damage.rollBias = 0;
  damage.yawBias = 0;
  damage.hits = 0;
}

/** True once a contact has left a mark that the pilot can feel. */
export function isDamaged(damage: AircraftDamage): boolean {
  return damage.integrity < 1;
}

/** How the airframe answers a contact. */
export interface DamageModel {
  /**
   * Closing speed along the line of contact that writes an airframe off in one
   * hit, m/s. About the wing's own cruise: two aircraft meeting squarely at
   * anything like flying speed do not both walk away.
   *
   * This is also the scale the whole curve is measured against, so it is the
   * one number that decides how sensitive the airframe is. Halving the gap to
   * `scratchSpeed` quadruples what every survivable contact costs.
   */
  readonly writeOffSpeed: number;
  /** Below this a contact is a scrape and nothing more, m/s. */
  readonly scratchSpeed: number;
  /** Integrity at or below which the airframe stops flying. */
  readonly disableIntegrity: number;
  /** How much of the impact each part of the airframe passes into structure. */
  readonly sectorFactor: Readonly<Record<ImpactSector, number>>;
  /** Radians per second of tumble per unit of severity and m/s of impact. */
  readonly tumbleRate: number;
  /** How much of the impact is given back as separation, 0 dead, 1 elastic. */
  readonly restitution: number;
  /** Ceiling on the tumble an impact may impart, rad/s. */
  readonly maxTumble: number;
  /**
   * What is left of the lift once the airframe stops being an aircraft.
   *
   * A wing that has been written off is not a bad glider, it is a bundle of
   * foam: without this a disabled airframe trims itself out and floats down
   * for two minutes, which is not what anybody watching it saw happen.
   */
  readonly wreckLift: number;
  /**
   * Drag of a wrecked airframe, as a multiple of a clean one's.
   *
   * Modest, because most of a falling wreck's drag comes from the flight
   * model's own post-stall term: broadside to the airflow the wing is already
   * a flat plate, and this only accounts for the foam that is now flapping.
   */
  readonly wreckDrag: number;
}

export const DAMAGE_MODEL: DamageModel = {
  // Foam does not have thirty metres a second of crush in it. At 30 the curve
  // was so flat down at formation speeds that a pilot could bump a wingman a
  // dozen times over and still be flying a nearly clean aircraft; 26 puts
  // roughly 38% more of every contact into the structure, at every speed that
  // does anything at all, so a run of knocks adds up in the handful of hits it
  // ought to rather than in twenty.
  writeOffSpeed: 26,
  scratchSpeed: 3,
  disableIntegrity: 0.3,
  sectorFactor: {
    // Nothing in front of the pilot but the airframe itself.
    NOSE: 1,
    // A tip strike loses a panel, not the aircraft — but it loses the roll.
    WING: 0.7,
    // From behind it is mostly the motor and the elevons that are lost.
    TAIL: 0.8,
    BODY: 0.9,
  },
  tumbleRate: 0.12,
  restitution: 0.25,
  maxTumble: 12,
  wreckLift: 0.15,
  wreckDrag: 1.6,
};

/**
 * A charge on the wing.
 *
 * An interceptor sent up to bring another aircraft down does not rely on the
 * airframe surviving the meeting: it carries a small charge with a contact
 * fuze. Below the arming speed the fuze does not fire and the contact is just
 * two aircraft hitting each other; above it there is nothing left of either.
 */
export interface Warhead {
  /** Impact speed along the line of contact that fires the fuze, m/s. */
  readonly armingSpeed: number;
  /** Integrity the blast takes off every airframe in the contact. */
  readonly charge: number;
}

/**
 * What an intercept mission flies with.
 *
 * The fuze is set well below any speed two aircraft could actually meet at on
 * purpose, so an intended interception always detonates; what it will not do is
 * go off when a wingtip brushes past at walking pace. The charge is more than
 * an airframe's worth so there is never a survivor.
 */
export const INTERCEPT_WARHEAD: Warhead = {
  armingSpeed: 8,
  charge: 2,
};

/** One aircraft's view of a contact. */
export interface Impact {
  /** Speed of one aircraft relative to the other, m/s. */
  closingSpeed: number;
  /** The part of that speed carried along the line of contact, m/s. */
  normalSpeed: number;
  /** 0 for a parallel graze, 1 for a square hit. */
  directness: number;
  /** Which part of this airframe the other aircraft arrived on. */
  sector: ImpactSector;
  /** Unit vector toward the other aircraft, in body axes. */
  contact: Vec3;
  /** Unit vector toward the other aircraft, in local ENU. */
  normal: Vec3;
  /** Where the other aircraft was going relative to this one, body axes. */
  approach: Vec3;
}

export function createImpact(): Impact {
  return {
    closingSpeed: 0,
    normalSpeed: 0,
    directness: 0,
    sector: IMPACT_SECTOR.Body,
    contact: V.vec3(1, 0, 0),
    normal: V.vec3(1, 0, 0),
    approach: V.vec3(1, 0, 0),
  };
}

/** Body axes are forward, left, up; a hit within this cone is on the nose. */
const AXIAL_CONE = 0.5;
/** Lateral component past which a hit is on a wing rather than the centre. */
const WING_CONE = 0.55;

const _separation = V.vec3();
const _relative = V.vec3();

/**
 * Works out what `self` just met, from the two aircraft alone.
 *
 * The collision world reports that two spheres touched and how fast they were
 * closing; the geometry that decides the damage — which way the other aircraft
 * came from and how squarely it arrived — is read back off the states here,
 * where the body frames are.
 *
 * Writes into `out` and returns it; allocation-free, so it can be called from
 * the physics loop.
 */
export function resolveImpact(
  out: Impact,
  self: AircraftState,
  other: AircraftState,
): Impact {
  V.subtract(_separation, other.position, self.position);
  const distance = V.length(_separation);
  if (distance > 1e-6) {
    V.scale(out.normal, _separation, 1 / distance);
  } else {
    // Dead centre overlap: treat it as arriving down the nose, which is the
    // worst case and the one that cannot be argued with.
    V.set(out.normal, 0, 0, 1);
  }

  // How the other aircraft is moving relative to this one. Closing along the
  // line of centres is a negative dot, because the normal points at it.
  V.subtract(_relative, other.velocity, self.velocity);
  out.closingSpeed = V.length(_relative);
  const approachRate = -V.dot(_relative, out.normal);
  out.normalSpeed = Math.max(approachRate, 0);
  out.directness =
    out.closingSpeed > 1e-6 ? clamp(out.normalSpeed / out.closingSpeed, 0, 1) : 0;

  rotateVectorInverse(out.contact, self.orientation, out.normal);
  rotateVectorInverse(out.approach, self.orientation, _relative);
  if (out.closingSpeed > 1e-6) {
    V.scale(out.approach, out.approach, 1 / out.closingSpeed);
  } else {
    V.set(out.approach, -out.contact.x, -out.contact.y, -out.contact.z);
  }

  out.sector = impactSector(out.contact);
  return out;
}

/**
 * Reads a body-frame contact direction as a part of the airframe.
 *
 * The wing is checked first: a flying wing is mostly wing, and a contact a
 * metre out from the centreline is a wing strike whatever else it also is.
 */
export function impactSector(contact: Vec3): ImpactSector {
  if (Math.abs(contact.y) >= WING_CONE) return IMPACT_SECTOR.Wing;
  if (contact.x >= AXIAL_CONE) return IMPACT_SECTOR.Nose;
  if (contact.x <= -AXIAL_CONE) return IMPACT_SECTOR.Tail;
  return IMPACT_SECTOR.Body;
}

/**
 * How much integrity a contact costs, 0..1.
 *
 * Structure absorbs energy, and energy goes as the square of speed, so the
 * curve is quadratic in the part of the closing speed that is actually aimed
 * at the airframe. That is what makes a fast crossing graze survivable and a
 * slow square hit expensive — the speed on the clock is not the speed that
 * arrives.
 */
export function impactSeverity(
  impact: Impact,
  model: DamageModel = DAMAGE_MODEL,
): number {
  const span = model.writeOffSpeed - model.scratchSpeed;
  if (span <= 0) return impact.normalSpeed > model.scratchSpeed ? 1 : 0;
  const excess = (impact.normalSpeed - model.scratchSpeed) / span;
  if (excess <= 0) return 0;
  const energy = Math.min(excess, 1) ** 2;
  return clamp(energy * model.sectorFactor[impact.sector], 0, 1);
}

/**
 * Applies one contact to an airframe and says what is left of it.
 *
 * `severity` is integrity taken off, so a warhead simply passes a number
 * greater than one: the same accounting handles a wingtip brush and a charge
 * going off, and neither needs a special case anywhere else.
 */
export function applyDamage(
  damage: AircraftDamage,
  impact: Impact,
  severity: number,
  model: DamageModel = DAMAGE_MODEL,
): DamageOutcome {
  damage.hits += 1;
  damage.integrity = clamp(damage.integrity - severity, 0, 1);

  const hurt = Math.min(severity, 1);
  switch (impact.sector) {
    case IMPACT_SECTOR.Wing: {
      // Lift and roll both live out here, and what is left of the panel is
      // still bolted on: it drags, and the wing drops toward the damaged side.
      damage.rollAuthority -= 0.8 * hurt;
      damage.liftFactor -= 0.35 * hurt;
      damage.dragFactor += 0.9 * hurt;
      // Body y is left, so a hit taken on the left wing rolls and yaws left,
      // which is negative in both moment coefficients.
      const side = -Math.sign(impact.contact.y || 1);
      damage.rollBias += side * 0.06 * hurt;
      damage.yawBias += side * 0.02 * hurt;
      break;
    }
    case IMPACT_SECTOR.Nose:
      damage.dragFactor += 1.2 * hurt;
      damage.liftFactor -= 0.2 * hurt;
      damage.pitchAuthority -= 0.3 * hurt;
      break;
    case IMPACT_SECTOR.Tail:
      // A pusher keeps the propeller and both elevons back here, so this is
      // the hit that takes the power and the pitch together.
      damage.thrustFactor -= 1.2 * hurt;
      damage.pitchAuthority -= 0.7 * hurt;
      damage.yawAuthority -= 0.5 * hurt;
      damage.dragFactor += 0.5 * hurt;
      break;
    case IMPACT_SECTOR.Body:
      damage.liftFactor -= 0.3 * hurt;
      damage.dragFactor += 1 * hurt;
      damage.pitchAuthority -= 0.4 * hurt;
      break;
  }

  damage.liftFactor = clamp(damage.liftFactor, 0.25, 1);
  damage.dragFactor = clamp(damage.dragFactor, 1, 4);
  damage.thrustFactor = clamp(damage.thrustFactor, 0, 1);
  damage.rollAuthority = clamp(damage.rollAuthority, 0, 1);
  damage.pitchAuthority = clamp(damage.pitchAuthority, 0, 1);
  damage.yawAuthority = clamp(damage.yawAuthority, 0, 1);
  damage.rollBias = clamp(damage.rollBias, -0.12, 0.12);
  damage.yawBias = clamp(damage.yawBias, -0.05, 0.05);

  if (damage.integrity > model.disableIntegrity) {
    return severity > 0 ? DAMAGE_OUTCOME.Damaged : DAMAGE_OUTCOME.Scrape;
  }

  // Past this point the airframe has stopped being an aircraft, and the
  // aerodynamics should stop pretending otherwise: whatever is left falls.
  damage.liftFactor = Math.min(damage.liftFactor, model.wreckLift);
  damage.dragFactor = Math.max(damage.dragFactor, model.wreckDrag);
  damage.thrustFactor = 0;
  damage.rollAuthority = 0;
  damage.pitchAuthority = 0;
  damage.yawAuthority = 0;
  return damage.integrity <= 0
    ? DAMAGE_OUTCOME.Destroyed
    : DAMAGE_OUTCOME.Disabled;
}

/** True once the airframe has taken more than it can still fly with. */
export function isCrippled(
  damage: AircraftDamage,
  model: DamageModel = DAMAGE_MODEL,
): boolean {
  return damage.integrity <= model.disableIntegrity;
}

const _tumble = V.vec3();

/**
 * Kicks an airframe off the one it just hit.
 *
 * Two aircraft of the same mass meeting along the line of contact end up
 * sharing that part of their speed, so each loses half the closing rate plus
 * whatever the foam gives back. Off the centre of mass the same blow also puts
 * the aircraft into a tumble — the wingtip stops and the rest of the aircraft
 * does not — which is what turns a disabled airframe into something that
 * spins down rather than glides down.
 */
export function applyImpactMotion(
  state: AircraftState,
  impact: Impact,
  severity: number,
  model: DamageModel = DAMAGE_MODEL,
): void {
  const share = ((1 + model.restitution) / 2) * impact.normalSpeed;
  V.addScaled(state.velocity, state.velocity, impact.normal, -share);

  // The blow acts where the other aircraft touched and points the way it was
  // travelling; the moment is what is left over once those two disagree, which
  // is exactly zero for a hit straight down the line of centres.
  V.cross(_tumble, impact.contact, impact.approach);
  const kick = Math.min(severity, 1) * impact.normalSpeed * model.tumbleRate;
  V.addScaled(state.angularVelocity, state.angularVelocity, _tumble, kick);

  const spin = V.length(state.angularVelocity);
  if (spin > model.maxTumble) {
    V.scale(state.angularVelocity, state.angularVelocity, model.maxTumble / spin);
  }
}

/**
 * The charge that fires in a contact, if either aircraft is carrying one.
 *
 * A fuze is a fuze whoever it belongs to: an unarmed aircraft brushed by an
 * armed one is caught in the same blast.
 */
export function detonatingWarhead(
  a: { readonly warhead: Warhead | null },
  b: { readonly warhead: Warhead | null },
  normalSpeed: number,
): Warhead | null {
  const first = a.warhead;
  const second = b.warhead;
  const firstFires = first !== null && normalSpeed >= first.armingSpeed;
  const secondFires = second !== null && normalSpeed >= second.armingSpeed;
  if (firstFires && secondFires) {
    // Both go off; the bigger charge is the one that decides the outcome.
    return (first as Warhead).charge >= (second as Warhead).charge
      ? first
      : second;
  }
  if (firstFires) return first;
  if (secondFires) return second;
  return null;
}
