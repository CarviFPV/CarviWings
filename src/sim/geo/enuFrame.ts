/**
 * Local East-North-Up frame.
 *
 * ## Why this exists
 *
 * Cesium works in Earth-centred, Earth-fixed (ECEF) metres — coordinates in the
 * millions with the interesting digits at the far end of a double. Running a
 * flight model there loses precision and makes every force calculation awkward.
 *
 * Instead each mission builds one ENU frame around its origin, and the entire
 * simulation runs in local metres relative to it:
 *
 *     Earth -> Cesium Cartesian (ECEF) -> Local ENU -> Physics
 *
 *     X = East, Y = North, Z = Up
 *
 * so an aircraft sits at, say, `(350, -120, 280)` rather than
 * `(4331000, 567000, 4633000)`.
 *
 * ## Accuracy note
 *
 * The frame is a true rigid transform, not a flat-Earth approximation:
 * `localToGeographic` round-trips through ECEF, so latitude, longitude and
 * altitude stay correct out to any mission radius. What *is* approximated is
 * the physics assumption that gravity points along local `-Z` everywhere in the
 * frame; at the 50 km mission radius that is a 0.45 degree error, which is far
 * below the fidelity of the aerodynamic model and is the standard trade-off for
 * a local-frame flight simulation.
 */

import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import { DEG_TO_RAD } from "../math/scalar";
import type { Geodetic } from "./wgs84";
import { ecefToGeodetic, geodeticToEcef } from "./wgs84";

export interface EnuFrameOrigin {
  latitude: number;
  longitude: number;
  /** Ellipsoidal height of the frame origin in metres. */
  height: number;
}

const _scratch = V.vec3();

export class EnuFrame {
  readonly origin: Readonly<EnuFrameOrigin>;
  /** Frame origin in ECEF metres. */
  readonly originEcef: Readonly<Vec3>;
  /** ECEF direction of local +X. */
  readonly east: Readonly<Vec3>;
  /** ECEF direction of local +Y. */
  readonly north: Readonly<Vec3>;
  /** ECEF direction of local +Z. */
  readonly up: Readonly<Vec3>;

  constructor(origin: EnuFrameOrigin) {
    this.origin = Object.freeze({ ...origin });

    const lat = origin.latitude * DEG_TO_RAD;
    const lon = origin.longitude * DEG_TO_RAD;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);

    this.originEcef = Object.freeze(
      geodeticToEcef(origin.latitude, origin.longitude, origin.height),
    );
    this.east = Object.freeze(V.vec3(-sinLon, cosLon, 0));
    this.north = Object.freeze(V.vec3(-sinLat * cosLon, -sinLat * sinLon, cosLat));
    this.up = Object.freeze(V.vec3(cosLat * cosLon, cosLat * sinLon, sinLat));
  }

  /** Rotate a local ENU *direction* into ECEF (no translation). */
  enuVectorToEcef(local: Vec3, out: Vec3 = V.vec3()): Vec3 {
    out.x = this.east.x * local.x + this.north.x * local.y + this.up.x * local.z;
    out.y = this.east.y * local.x + this.north.y * local.y + this.up.y * local.z;
    out.z = this.east.z * local.x + this.north.z * local.y + this.up.z * local.z;
    return out;
  }

  /** Rotate an ECEF *direction* into the local ENU frame (no translation). */
  ecefVectorToEnu(ecef: Vec3, out: Vec3 = V.vec3()): Vec3 {
    const x = V.dot(this.east as Vec3, ecef);
    const y = V.dot(this.north as Vec3, ecef);
    const z = V.dot(this.up as Vec3, ecef);
    return V.set(out, x, y, z);
  }

  /** Local ENU position (metres) to an ECEF position — Cesium's Cartesian3. */
  localToEcef(local: Vec3, out: Vec3 = V.vec3()): Vec3 {
    this.enuVectorToEcef(local, out);
    out.x += this.originEcef.x;
    out.y += this.originEcef.y;
    out.z += this.originEcef.z;
    return out;
  }

  /** ECEF position to local ENU metres. */
  ecefToLocal(ecef: Vec3, out: Vec3 = V.vec3()): Vec3 {
    _scratch.x = ecef.x - this.originEcef.x;
    _scratch.y = ecef.y - this.originEcef.y;
    _scratch.z = ecef.z - this.originEcef.z;
    return this.ecefVectorToEnu(_scratch, out);
  }

  /** Geographic degrees / ellipsoidal metres to local ENU metres. */
  geographicToLocal(
    latitude: number,
    longitude: number,
    height: number,
    out: Vec3 = V.vec3(),
  ): Vec3 {
    geodeticToEcef(latitude, longitude, height, _scratch);
    return this.ecefToLocal(_scratch, out);
  }

  /** Local ENU metres to geographic degrees / ellipsoidal metres. */
  localToGeographic(local: Vec3): Geodetic {
    this.localToEcef(local, _scratch);
    return ecefToGeodetic(_scratch);
  }
}
