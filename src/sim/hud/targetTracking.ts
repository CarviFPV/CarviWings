/**
 * Where a target sits relative to the view.
 *
 * Pure geometry, deliberately free of Cesium: given the camera pose and a
 * target, work out which way the pilot has to look. The renderer decides what
 * to draw with it.
 */

import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";

export interface ScreenDirection {
  /** True when the target is in front of the camera. */
  inFront: boolean;
  /** Unit vector from the screen centre toward the target. Y points down. */
  x: number;
  y: number;
}

const _relative = V.vec3();

/**
 * Direction from the screen centre toward a target, in screen axes.
 *
 * A perspective projection inverts behind the camera, so a target that has
 * slipped past the wing cannot simply be projected — the arrow would point the
 * wrong way at the worst possible moment. Working in camera axes instead keeps
 * the sign correct all the way around: a target behind and to the right still
 * reads as "turn right".
 */
export function targetScreenDirection(
  cameraPosition: Vec3,
  cameraDirection: Vec3,
  cameraUp: Vec3,
  cameraRight: Vec3,
  targetPosition: Vec3,
  out: ScreenDirection = { inFront: false, x: 0, y: 0 },
): ScreenDirection {
  V.subtract(_relative, targetPosition, cameraPosition);

  const forward = V.dot(_relative, cameraDirection);
  const right = V.dot(_relative, cameraRight);
  const up = V.dot(_relative, cameraUp);

  out.inFront = forward > 0;

  const length = Math.hypot(right, up);
  if (length < 1e-6) {
    // Dead ahead or dead astern: there is no meaningful screen direction, so
    // point straight down to mean "behind you".
    out.x = 0;
    out.y = out.inFront ? 0 : 1;
    return out;
  }

  out.x = right / length;
  out.y = -up / length;
  return out;
}

export interface EdgePoint {
  x: number;
  y: number;
}

/**
 * Projects a direction from the centre of the viewport onto an inset
 * rectangle, which is where an off-screen indicator belongs.
 *
 * The horizontal and vertical insets are separate because the OSD is not:
 * airspeed and altitude columns run down the left and right edges, so an
 * indicator pinned hard against the side would sit on top of them.
 */
export function clampToViewportEdge(
  width: number,
  height: number,
  insetX: number,
  insetY: number,
  dirX: number,
  dirY: number,
  out: EdgePoint = { x: 0, y: 0 },
): EdgePoint {
  const centreX = width / 2;
  const centreY = height / 2;
  const halfWidth = Math.max(width / 2 - insetX, 1);
  const halfHeight = Math.max(height / 2 - insetY, 1);

  const scaleX = Math.abs(dirX) > 1e-6 ? halfWidth / Math.abs(dirX) : Infinity;
  const scaleY = Math.abs(dirY) > 1e-6 ? halfHeight / Math.abs(dirY) : Infinity;
  const scale = Math.min(scaleX, scaleY);

  if (!Number.isFinite(scale)) {
    out.x = centreX;
    out.y = centreY;
    return out;
  }

  out.x = centreX + dirX * scale;
  out.y = centreY + dirY * scale;
  return out;
}

/**
 * True when a projected point is inside the viewport with room for the
 * tracking box, which is what decides between a box and an edge arrow.
 */
export function isOnScreen(
  x: number,
  y: number,
  width: number,
  height: number,
  margin: number,
): boolean {
  return (
    x >= margin && x <= width - margin && y >= margin && y <= height - margin
  );
}
