/**
 * Interception geometry.
 *
 * Finding where to aim so that two aircraft arrive at the same place at the
 * same time. Solving it properly matters: aiming at where a target *is*
 * guarantees arriving where it *was*, which is why a pure-pursuit chase never
 * closes on a target of similar speed.
 */

import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";

const _relative = V.vec3();

/**
 * Time until interception, or `null` when the chaser cannot catch the target.
 *
 * Solves `|targetPosition + targetVelocity·t − chaserPosition| = chaserSpeed·t`
 * for the earliest positive `t`. The quadratic has no positive root when the
 * target is faster and running, which is a real answer, not a failure.
 */
export function interceptTime(
  chaserPosition: Vec3,
  chaserSpeed: number,
  targetPosition: Vec3,
  targetVelocity: Vec3,
): number | null {
  V.subtract(_relative, targetPosition, chaserPosition);

  const a = V.lengthSquared(targetVelocity) - chaserSpeed * chaserSpeed;
  const b = 2 * V.dot(_relative, targetVelocity);
  const c = V.lengthSquared(_relative);

  if (Math.abs(a) < 1e-6) {
    // Equal speeds: the quadratic collapses to a linear equation.
    if (Math.abs(b) < 1e-9) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);

  const positives = [t1, t2].filter((t) => t > 0);
  if (positives.length === 0) return null;
  return Math.min(...positives);
}

/**
 * Where to point the nose.
 *
 * `lead` blends between aiming at the target (0) and at the full interception
 * solution (1), which is how difficulty changes an enemy's marksmanship without
 * changing its aircraft.
 */
export function interceptPoint(
  chaserPosition: Vec3,
  chaserSpeed: number,
  targetPosition: Vec3,
  targetVelocity: Vec3,
  lead: number,
  maxHorizon: number,
  out: Vec3 = V.vec3(),
): Vec3 {
  V.copy(out, targetPosition);
  if (lead <= 0) return out;

  const time = interceptTime(
    chaserPosition,
    chaserSpeed,
    targetPosition,
    targetVelocity,
  );
  // No solution means the target is outrunning the chase; aim where it is and
  // let the pursuit close if the target ever turns.
  if (time === null) return out;

  const horizon = clamp(time, 0, maxHorizon);
  out.x += targetVelocity.x * horizon * lead;
  out.y += targetVelocity.y * horizon * lead;
  out.z += targetVelocity.z * horizon * lead;
  return out;
}
