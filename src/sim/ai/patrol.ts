/**
 * Routes, and where the aircraft flying them start.
 *
 * Generated from the mission seed, so the same mission always produces the same
 * routes — the enemies are somewhere different each mission but somewhere
 * repeatable within one.
 *
 * A patrol route is a ring of waypoints around the mission area at varying
 * radius and height, which reads as a patrol rather than as a circle, and keeps
 * aircraft inside the mission radius without any special-case containment. A
 * transit route is the other shape: destinations on opposite sides of the area,
 * so what gets flown is a long crossing rather than a circuit.
 */

import { createRng } from "../math/rng";
import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import { vec3 } from "../math/vec3";
import type { TerrainSampler } from "../terrain/types";
import { liftAboveTerrain } from "./terrainAvoidance";

export interface PatrolRouteOptions {
  /** Distinct per aircraft, so two enemies do not fly the same circuit. */
  readonly seed: string;
  /** Mission radius in metres; the route stays well inside it. */
  readonly missionRadius: number;
  /** Nominal patrol height in local ENU metres. */
  readonly baseAltitude: number;
  /** How much the height varies between waypoints, metres. */
  readonly altitudeSpread?: number;
  readonly waypointCount?: number;
  /** Used to keep waypoints above the ground where terrain is known. */
  readonly terrain?: TerrainSampler;
  /** Clearance kept above terrain, metres. */
  readonly terrainMargin?: number;
}

export function generatePatrolRoute(options: PatrolRouteOptions): Vec3[] {
  const rng = createRng(`${options.seed}:patrol`);
  const count = options.waypointCount ?? rng.int(5, 7);
  const spread = options.altitudeSpread ?? 220;
  const margin = options.terrainMargin ?? 160;

  // Keep the circuit inside the mission area with room to turn.
  const minRadius = options.missionRadius * 0.28;
  const maxRadius = options.missionRadius * 0.78;
  const startAngle = rng.range(0, Math.PI * 2);
  const direction = rng.next() < 0.5 ? 1 : -1;

  const waypoints: Vec3[] = [];
  for (let i = 0; i < count; i += 1) {
    // Even spacing with jitter: a ring, but not a geometric one.
    const angle =
      startAngle +
      direction * ((i / count) * Math.PI * 2 + rng.range(-0.35, 0.35));
    const radius = rng.range(minRadius, maxRadius);
    const altitude = options.baseAltitude + rng.range(-spread, spread);

    const point = vec3(
      Math.sin(angle) * radius,
      Math.cos(angle) * radius,
      Math.max(altitude, margin),
    );
    if (options.terrain) liftAboveTerrain(options.terrain, point, margin);
    waypoints.push(point);
  }
  return waypoints;
}

export interface TransitRouteOptions {
  /** Distinct per aircraft, so two contacts do not fly the same crossing. */
  readonly seed: string;
  readonly missionRadius: number;
  /** Nominal transit height in local ENU metres. */
  readonly baseAltitude: number;
  /** How much the height varies between destinations, metres. */
  readonly altitudeSpread?: number;
  /** Destinations on the route. It is flown in order and then flown again. */
  readonly legCount?: number;
  readonly terrain?: TerrainSampler;
  readonly terrainMargin?: number;
}

/**
 * A programmed route across the mission area.
 *
 * Not a patrol. A patrol is a ring flown round a piece of sky by somebody who
 * is looking at it; this is a set of destinations somebody was given, and each
 * leg is a crossing of the area rather than a corner of a circuit — which is
 * what makes a transit worth intercepting at all. There is a long straight run
 * between two points, the aircraft flying it is not looking behind itself, and
 * the pilot's problem is getting to that line before it has been flown.
 *
 * The route closes on itself so the contact never leaves and the mission stays
 * winnable: run out of destinations and it starts the list again.
 */
export function generateTransitRoute(options: TransitRouteOptions): Vec3[] {
  const rng = createRng(`${options.seed}:transit`);
  const count = options.legCount ?? rng.int(3, 5);
  const spread = options.altitudeSpread ?? 150;
  const margin = options.terrainMargin ?? 160;

  // Out near the rim, because a destination in the middle of the area makes a
  // short leg and a lot of turning. Never at the rim itself: the aircraft has
  // to turn onto the next leg somewhere, and it does that inside the area.
  const minRadius = options.missionRadius * 0.55;
  const maxRadius = options.missionRadius * 0.9;
  let angle = rng.range(0, Math.PI * 2);

  const waypoints: Vec3[] = [];
  for (let i = 0; i < count; i += 1) {
    const radius = rng.range(minRadius, maxRadius);
    const altitude = options.baseAltitude + rng.range(-spread, spread);
    const point = vec3(
      Math.sin(angle) * radius,
      Math.cos(angle) * radius,
      Math.max(altitude, margin),
    );
    if (options.terrain) liftAboveTerrain(options.terrain, point, margin);
    waypoints.push(point);

    // The next destination is across the area rather than round it: half a
    // turn, wandered enough that the route is a set of crossings and not the
    // same line flown back and forth for the whole mission.
    angle += Math.PI + rng.range(-0.8, 0.8);
  }
  return waypoints;
}

/**
 * Deterministic spawn points around the player.
 *
 * Placed on a ring between `minRange` and `maxRange` so a mission starts with
 * contacts to find rather than contacts already on top of you, and lifted clear
 * of any terrain that has been sampled.
 */
export function generateSpawnPoints(options: {
  readonly seed: string;
  readonly count: number;
  readonly centre: Vec3;
  readonly minRange: number;
  readonly maxRange: number;
  readonly baseAltitude: number;
  readonly altitudeSpread?: number;
  readonly terrain?: TerrainSampler;
  readonly terrainMargin?: number;
}): Vec3[] {
  const rng = createRng(`${options.seed}:spawns`);
  const spread = options.altitudeSpread ?? 200;
  const margin = options.terrainMargin ?? 180;
  const points: Vec3[] = [];

  for (let i = 0; i < options.count; i += 1) {
    // Spread the ring evenly then jitter, so contacts do not clump.
    const angle =
      (i / Math.max(options.count, 1)) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const range = rng.range(options.minRange, options.maxRange);
    const point = vec3(
      options.centre.x + Math.sin(angle) * range,
      options.centre.y + Math.cos(angle) * range,
      options.baseAltitude + rng.range(-spread, spread),
    );
    if (options.terrain) liftAboveTerrain(options.terrain, point, margin);
    points.push(point);
  }
  return points;
}

/** Index of the next waypoint, advancing when the current one is reached. */
export function advanceWaypoint(
  route: readonly Vec3[],
  index: number,
  position: Vec3,
  arrivalRadius: number,
): number {
  if (route.length === 0) return 0;
  const current = route[index % route.length] as Vec3;
  const dx = current.x - position.x;
  const dy = current.y - position.y;
  if (Math.hypot(dx, dy) <= arrivalRadius) {
    return (index + 1) % route.length;
  }
  return index % route.length;
}

/** Clamps a point back inside the mission area. */
export function containWithin(point: Vec3, radius: number): Vec3 {
  const distance = Math.hypot(point.x, point.y);
  if (distance <= radius || distance < 1e-6) return point;
  const scale = clamp(radius / distance, 0, 1);
  point.x *= scale;
  point.y *= scale;
  return point;
}
