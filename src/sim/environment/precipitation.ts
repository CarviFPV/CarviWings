/**
 * How rain looks from the cockpit.
 *
 * Rain drawn as a field of evenly spaced, slowly falling streaks reads as snow
 * no matter what colour it is given. What makes rain look like rain from an
 * aircraft is that the drops are moving *relative to the camera*, and at flight
 * speed that relative motion is almost entirely the aircraft's own: the streaks
 * lean into the flight path, radiate out of the point being flown at, and are
 * shortest near that point and longest at the edges of the frame.
 *
 * All of that follows from a single vector — the velocity of a drop as seen
 * from the camera — so it is worked out here, in plain maths with no renderer
 * attached, and handed to the rain shader as a handful of uniforms. Standing
 * still in calm air the same maths degenerates to near-vertical streaks, which
 * is exactly what rain does when nobody is moving.
 */

import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";

export interface RainStreakInput {
  /** Camera axes, in whatever frame the velocities below are given in. */
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
  /** Camera velocity, m/s. */
  readonly cameraVelocity: Vec3;
  /** Air movement, m/s. */
  readonly wind: Vec3;
  /** Unit vector pointing down. */
  readonly down: Vec3;
  /** Terminal fall speed of a drop, m/s. */
  readonly fallSpeed: number;
  /** Tangent of half the vertical field of view. */
  readonly tanHalfFovY: number;
}

export interface RainStreakField {
  /**
   * Where the streaks converge, in screen units: y spans -1..1 top to bottom of
   * the frame and x is scaled by the aspect ratio, which is the space the rain
   * shader works in.
   */
  readonly focusX: number;
  readonly focusY: number;
  /**
   * How much of the streak direction comes from the vanishing point rather than
   * from the fallback axis, -1..1. The sign is the direction of travel: positive
   * means the drops stream away from the point, negative that they close on it.
   */
  readonly radial: number;
  /** Streak direction where there is no usable vanishing point; unit length. */
  readonly axisX: number;
  readonly axisY: number;
  /** Speed of a drop relative to the camera, m/s. */
  readonly speed: number;
}

/**
 * Past this far off screen a vanishing point stops being one: the streaks it
 * implies are parallel to within a pixel, and the fallback axis says the same
 * thing without the numerical trouble.
 */
const FOCUS_LIMIT = 8;
/** Inside this radius the vanishing point governs the field completely. */
const FOCUS_NEAR = 2;

/** Screen-space geometry of the rain, from the motion of one drop. */
export function rainStreakField(input: RainStreakInput): RainStreakField {
  const { right, up, forward, cameraVelocity, wind, down } = input;

  // The velocity of a drop as the camera sees it: it falls, it is blown along
  // with the air, and the camera is flying through the middle of all of it.
  const relX = wind.x + down.x * input.fallSpeed - cameraVelocity.x;
  const relY = wind.y + down.y * input.fallSpeed - cameraVelocity.y;
  const relZ = wind.z + down.z * input.fallSpeed - cameraVelocity.z;

  // Same vector in camera axes: across the frame, up the frame, and into it.
  const across = relX * right.x + relY * right.y + relZ * right.z;
  const vertical = relX * up.x + relY * up.y + relZ * up.z;
  const depth = relX * forward.x + relY * forward.y + relZ * forward.z;
  const speed = Math.hypot(relX, relY, relZ);

  // At the centre of the frame a drop simply moves the way its velocity points,
  // which is the streak direction everywhere once the vanishing point is too
  // far out to matter.
  const lateral = Math.hypot(across, vertical);
  const axisX = lateral > 1e-6 ? across / lateral : 0;
  const axisY = lateral > 1e-6 ? vertical / lateral : -1;

  let focusX = 0;
  let focusY = 0;
  let radial = 0;

  if (speed > 1e-3 && Math.abs(depth) > 1e-3) {
    // Every drop track projects to a line through this point, so the streaks
    // fan out of it — the whole reason rain seen from a moving aircraft looks
    // nothing like rain seen from the ground.
    const tan = Math.max(input.tanHalfFovY, 1e-3);
    focusX = across / (depth * tan);
    focusY = vertical / (depth * tan);

    const magnitude = Math.hypot(focusX, focusY);
    if (magnitude > FOCUS_LIMIT) {
      const pull = FOCUS_LIMIT / magnitude;
      focusX *= pull;
      focusY *= pull;
    }

    // Two things weaken the vanishing point: drops crossing the view rather
    // than receding down it, and a point so far off screen that the streaks it
    // implies are parallel anyway.
    const along = Math.abs(depth) / speed;
    const reach = clamp(
      (FOCUS_LIMIT - magnitude) / (FOCUS_LIMIT - FOCUS_NEAR),
      0,
      1,
    );
    // Drops receding from the camera stream outward; drops closing on it run
    // the other way.
    radial = clamp(along * 2, 0, 1) * reach * (depth < 0 ? 1 : -1);
  }

  return { focusX, focusY, radial, axisX, axisY, speed };
}
