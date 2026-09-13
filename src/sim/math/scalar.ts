/** Scalar helpers shared across the simulation. */

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp to the range accepted by `Math.asin` / `Math.acos`. */
export function clampUnit(value: number): number {
  return clamp(value, -1, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `smoothing` is the fraction of the remaining error left after one second,
 * so 0.01 means "99% of the way there after one second".
 */
export function damp(
  current: number,
  target: number,
  smoothing: number,
  dt: number,
): number {
  return lerp(target, current, Math.pow(smoothing, dt));
}

/** Wrap an angle in degrees into [0, 360). */
export function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(
  current: number,
  target: number,
  maxDelta: number,
): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}
