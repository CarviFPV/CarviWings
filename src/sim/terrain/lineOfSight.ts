/**
 * Straight-line terrain occlusion.
 *
 * Shared by everything that has to know whether one point can see another: the
 * visibility model the pilot and the enemy AI look through, and the video link
 * the picture comes back over. Sampled from the cached elevation field, so it
 * performs no I/O and can be called freely from the simulation.
 *
 * Columns with no sampled terrain count as clear. Missing data is missing
 * data, not a mountain — the same rule collision works under.
 */

import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { TerrainSampler } from "./types";

/** Points sampled along a sight line when testing terrain. */
export const LINE_OF_SIGHT_SAMPLES = 14;

const _delta = V.vec3();
const _point = V.vec3();

/** True when terrain does not block the straight line between two points. */
export function hasLineOfSight(
  terrain: TerrainSampler,
  from: Vec3,
  to: Vec3,
  samples = LINE_OF_SIGHT_SAMPLES,
): boolean {
  V.subtract(_delta, to, from);
  const distance = V.length(_delta);
  if (distance < 1) return true;

  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    _point.x = from.x + _delta.x * t;
    _point.y = from.y + _delta.y * t;
    _point.z = from.z + _delta.z * t;
    if (!terrain.hasCoverage(_point.x, _point.y)) continue;
    if (terrain.heightAt(_point.x, _point.y) > _point.z) return false;
  }
  return true;
}
