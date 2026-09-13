/**
 * WGS84 geodetic <-> ECEF conversions.
 *
 * Implemented here rather than delegated to Cesium so that the whole
 * simulation layer (coordinates, physics, AI) stays free of any browser-only
 * dependency and can be unit-tested in plain Node. Cesium consumes the ECEF
 * values produced here; it is never the source of truth for the simulation.
 */

import { DEG_TO_RAD, RAD_TO_DEG } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import { vec3 } from "../math/vec3";

/** Semi-major axis in metres. */
export const WGS84_A = 6378137.0;
/** Flattening. */
export const WGS84_F = 1 / 298.257223563;
/** Semi-minor axis in metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);
/** First eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** Second eccentricity squared. */
export const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

export interface Geodetic {
  /** Degrees, positive north. */
  latitude: number;
  /** Degrees, positive east. */
  longitude: number;
  /** Metres above the WGS84 ellipsoid. */
  height: number;
}

/** Geodetic (degrees, metres) to Earth-centred Earth-fixed metres. */
export function geodeticToEcef(
  latitudeDeg: number,
  longitudeDeg: number,
  height: number,
  out: Vec3 = vec3(),
): Vec3 {
  const lat = latitudeDeg * DEG_TO_RAD;
  const lon = longitudeDeg * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  // Radius of curvature in the prime vertical.
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  out.x = (n + height) * cosLat * cosLon;
  out.y = (n + height) * cosLat * sinLon;
  out.z = (n * (1 - WGS84_E2) + height) * sinLat;
  return out;
}

/**
 * ECEF metres to geodetic degrees/metres using Bowring's closed-form solution,
 * which is accurate to well under a millimetre for any altitude a light
 * aircraft will reach.
 */
export function ecefToGeodetic(ecef: Vec3): Geodetic {
  const { x, y, z } = ecef;
  const p = Math.sqrt(x * x + y * y);
  const longitude = Math.atan2(y, x) * RAD_TO_DEG;

  if (p < 1e-9) {
    // On the polar axis.
    const sign = z >= 0 ? 1 : -1;
    return {
      latitude: sign * 90,
      longitude,
      height: Math.abs(z) - WGS84_B,
    };
  }

  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);

  const lat = Math.atan2(
    z + WGS84_EP2 * WGS84_B * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta,
  );
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  // Near the poles `cos(lat)` collapses, so switch to the z-based form.
  const cosLat = Math.cos(lat);
  const height =
    Math.abs(cosLat) > 0.2
      ? p / cosLat - n
      : z / sinLat - n * (1 - WGS84_E2);

  return { latitude: lat * RAD_TO_DEG, longitude, height };
}

/**
 * Great-circle distance in metres between two geographic points, using the
 * mean Earth radius. Used for map/minimap scale and range readouts where
 * ellipsoidal precision is irrelevant.
 */
export function haversineMetres(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const R = 6371008.8;
  const dLat = (latB - latA) * DEG_TO_RAD;
  const dLon = (lonB - lonA) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(latA * DEG_TO_RAD) *
      Math.cos(latB * DEG_TO_RAD) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
