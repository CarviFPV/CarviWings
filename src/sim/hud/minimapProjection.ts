/**
 * Local ENU to minimap pixels.
 *
 * The minimap is a plain canvas, not a second globe: it draws the same local
 * ENU metres the flight model runs in, scaled down. Pure maths so the
 * projection can be tested without a renderer.
 */

import { DEG_TO_RAD } from "../math/scalar";

export const MINIMAP_ORIENTATION = {
  NorthUp: "NORTH_UP",
  HeadingUp: "HEADING_UP",
} as const;

export type MinimapOrientation =
  (typeof MINIMAP_ORIENTATION)[keyof typeof MINIMAP_ORIENTATION];

export interface MinimapProjection {
  /** Player position in local ENU metres; the map is centred on it. */
  readonly playerX: number;
  readonly playerY: number;
  /** Player heading in degrees, 0 = north. */
  readonly headingDeg: number;
  /** Metres of ground per pixel. */
  readonly metresPerPixel: number;
  readonly orientation: MinimapOrientation;
}

export interface MinimapPoint {
  /** Pixels right of the minimap centre. */
  x: number;
  /** Pixels below the minimap centre. */
  y: number;
}

/** Projects a local ENU position into minimap pixels relative to its centre. */
export function projectToMinimap(
  projection: MinimapProjection,
  worldX: number,
  worldY: number,
  out: MinimapPoint = { x: 0, y: 0 },
): MinimapPoint {
  const east = worldX - projection.playerX;
  const north = worldY - projection.playerY;

  if (projection.orientation === MINIMAP_ORIENTATION.NorthUp) {
    out.x = east / projection.metresPerPixel;
    out.y = -north / projection.metresPerPixel;
    return out;
  }

  // Heading up: rotate the world so the nose points at the top of the map.
  const heading = projection.headingDeg * DEG_TO_RAD;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const ahead = east * sin + north * cos;
  const starboard = east * cos - north * sin;

  out.x = starboard / projection.metresPerPixel;
  out.y = -ahead / projection.metresPerPixel;
  return out;
}

/**
 * Rotation to apply to a symbol so it points the right way on the map, in
 * radians clockwise from the top of the canvas.
 */
export function minimapHeadingRotation(
  projection: MinimapProjection,
  headingDeg: number,
): number {
  const relative =
    projection.orientation === MINIMAP_ORIENTATION.NorthUp
      ? headingDeg
      : headingDeg - projection.headingDeg;
  return relative * DEG_TO_RAD;
}

/** Range rings, from the outermost inward, in metres. */
export function minimapRangeRings(rangeMetres: number): number[] {
  return [rangeMetres, rangeMetres * (2 / 3), rangeMetres / 3];
}
