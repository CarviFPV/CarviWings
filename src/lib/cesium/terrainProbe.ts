"use client";

/**
 * Cesium-backed terrain elevation.
 *
 * Elevation is read from the terrain *data* through `sampleTerrainMostDetailed`
 * rather than from the globe mesh Cesium happens to be drawing. The rendered
 * mesh is only as accurate as the tile level currently streamed in: at coarse
 * levels it is a chord across the curvature of the Earth and reads tens of
 * kilometres below the real surface. Sampling the source data is correct
 * regardless of what the renderer has loaded, and because every result is
 * cached by `TerrainField`, each grid cell costs exactly one request.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { TerrainBatchProbe, TerrainQuery } from "@/sim/terrain/types";
import { DEG_TO_RAD } from "@/sim/math/scalar";
import { vec3 } from "@/sim/math/vec3";

/**
 * Builds a batch probe returning terrain elevation in **local ENU metres**.
 *
 * Storing local z rather than ellipsoidal height means the per-step clearance
 * check is a plain subtraction, with no geodetic conversion in the hot path.
 */
/**
 * Level used when a terrain provider publishes no availability metadata.
 * At level 11 a tile spans roughly 9 km, which is ample for terrain following.
 */
const FALLBACK_SAMPLE_LEVEL = 11;

export function createTerrainProbe(
  cesium: CesiumModule,
  terrainProvider: Cesium.TerrainProvider,
  frame: EnuFrame,
): TerrainBatchProbe {
  const query = vec3();
  const result = vec3();

  // `sampleTerrainMostDetailed` picks the best level per point, but it needs
  // the provider to publish tile availability. Providers without it (the plain
  // ellipsoid, or a custom tileset) are sampled at a fixed level instead.
  const hasAvailability = terrainProvider.availability !== undefined;

  return async (points: readonly TerrainQuery[]) => {
    if (points.length === 0) return [];

    // Local column -> geographic, remembering the degrees for the trip back.
    const degrees: { latitude: number; longitude: number }[] = [];
    const cartographics: Cesium.Cartographic[] = [];
    for (const point of points) {
      query.x = point.x;
      query.y = point.y;
      query.z = 0;
      const geo = frame.localToGeographic(query);
      degrees.push({ latitude: geo.latitude, longitude: geo.longitude });
      cartographics.push(
        new cesium.Cartographic(
          geo.longitude * DEG_TO_RAD,
          geo.latitude * DEG_TO_RAD,
          0,
        ),
      );
    }

    let sampled: Cesium.Cartographic[];
    try {
      sampled = hasAvailability
        ? await cesium.sampleTerrainMostDetailed(terrainProvider, cartographics)
        : await cesium.sampleTerrain(
            terrainProvider,
            FALLBACK_SAMPLE_LEVEL,
            cartographics,
          );
    } catch {
      // A partial or failed tile fetch must not break the flight; the cells
      // stay unknown and are retried on a later refresh.
      return points.map(() => null);
    }

    return sampled.map((carto, index) => {
      if (!Number.isFinite(carto.height)) return null;
      const place = degrees[index];
      if (!place) return null;
      frame.geographicToLocal(
        place.latitude,
        place.longitude,
        carto.height,
        result,
      );
      return result.z;
    });
  };
}

/**
 * Reads the height of the surface the scene is actually **drawing** under a
 * batch of local columns, in local ENU metres, or null where it cannot be
 * picked.
 *
 * Every other elevation in the simulator comes from the terrain data, which is
 * the right answer while the globe is what the pilot can see. Buildings and
 * photogrammetry change that: an extruded footprint stands on the height
 * field, a photorealistic tileset carries its own reconstructed ground with
 * the globe switched off underneath it, and either way the thing under the
 * aircraft is not the thing the elevation service described. This is the only
 * way to ask about what is actually there — a depth pick against the rendered
 * scene, which reports whatever geometry is in front of the camera at that
 * column, ground or rooftop alike.
 *
 * It costs a render pass, so it is for laying a course out and for occasional
 * calibration, never for the flight loop. The whole batch is one pass, which
 * is why a course asks for its gates in a single call.
 *
 * `exclude` names geometry that is not scenery — the aircraft, above all. A
 * height sample reports whatever stands at a column, aircraft included:
 * `allowPicking: false` does not hide a primitive from one, and worse, it is
 * what makes a primitive impossible to exclude, because `objectsToExclude` is
 * matched through the pick buffer and geometry with picking off has no entry
 * there. Measured against a real scene: a box fifty metres up reads as fifty
 * metres up either way, and only the pickable one can be excluded back down to
 * the ground. So the aircraft are built pickable and named here.
 *
 * Without this, measuring the ground under a launch measures the wing standing
 * on it, and since the measurement is what decides where the wing stands, the
 * two lift each other a couple of metres a second until the launch is in the
 * sky.
 */
export function createSurfaceProbe(
  cesium: CesiumModule,
  scene: Cesium.Scene,
  frame: EnuFrame,
  exclude?: () => readonly object[],
): TerrainBatchProbe {
  const query = vec3();
  const result = vec3();

  return async (points: readonly TerrainQuery[]) => {
    if (points.length === 0) return [];
    if (!scene.sampleHeightSupported) return points.map(() => null);

    const degrees: { latitude: number; longitude: number }[] = [];
    const cartographics: Cesium.Cartographic[] = [];
    for (const point of points) {
      query.x = point.x;
      query.y = point.y;
      query.z = 0;
      const geo = frame.localToGeographic(query);
      degrees.push({ latitude: geo.latitude, longitude: geo.longitude });
      cartographics.push(
        new cesium.Cartographic(
          geo.longitude * DEG_TO_RAD,
          geo.latitude * DEG_TO_RAD,
          0,
        ),
      );
    }

    try {
      const excluded = exclude?.() ?? [];
      const sampled = await scene.sampleHeightMostDetailed(
        cartographics,
        excluded as object[],
      );
      return sampled.map((carto, index) => {
        const height = carto?.height;
        if (height === undefined || !Number.isFinite(height)) return null;
        const place = degrees[index];
        if (!place) return null;
        frame.geographicToLocal(place.latitude, place.longitude, height, result);
        return result.z;
      });
    } catch {
      // A pick can fail while tiles are still streaming, or where there is
      // simply nothing under the column. Neither is worth reporting.
      return points.map(() => null);
    }
  };
}

/**
 * Reads the height of the globe mesh the renderer **currently has loaded**
 * under one local column, in local ENU metres, or null where no tile covers
 * it yet.
 *
 * This is the number `TerrainField` deliberately refuses to fly on, and for
 * good reason: it is only as good as the tile level that has streamed in, and
 * at coarse levels it is a chord across the curve of the Earth that reads far
 * below the real surface. What it is exactly right for is the opposite
 * question — not "how high is the ground" but "how high is the ground the
 * pilot can see". Where it reads *above* the sampled surface, the mesh being
 * drawn is standing over the elevation the flight is run against, and anything
 * put at eye height over that elevation is inside a hillside. Sag never
 * matters, because a reading below the sampled surface is discarded.
 *
 * Synchronous and free, unlike a scene pick: it walks the loaded tile tree
 * rather than costing a render pass, so it can be asked every frame.
 */
export function createGlobeSurfaceReader(
  cesium: CesiumModule,
  scene: Cesium.Scene,
  frame: EnuFrame,
): (localX: number, localY: number) => number | null {
  const query = vec3();
  const result = vec3();
  const carto = new cesium.Cartographic();

  return (localX: number, localY: number) => {
    const globe = scene.globe;
    if (!globe) return null;
    query.x = localX;
    query.y = localY;
    query.z = 0;
    const geo = frame.localToGeographic(query);
    carto.longitude = geo.longitude * DEG_TO_RAD;
    carto.latitude = geo.latitude * DEG_TO_RAD;
    carto.height = 0;
    const height = globe.getHeight(carto);
    if (height === undefined || !Number.isFinite(height)) return null;
    frame.geographicToLocal(geo.latitude, geo.longitude, height, result);
    return result.z;
  };
}

/**
 * The same question asked about one column, which is how the surface
 * calibration asks it: see `sim/terrain/surfaceCalibration.ts` for the
 * screening that keeps a rooftop from being mistaken for the ground.
 */
export function createScenePicker(
  cesium: CesiumModule,
  scene: Cesium.Scene,
  frame: EnuFrame,
  exclude?: () => readonly object[],
): (localX: number, localY: number) => Promise<number | null> {
  const probe = createSurfaceProbe(cesium, scene, frame, exclude);
  return async (localX: number, localY: number) => {
    const [height] = await probe([{ x: localX, y: localY }]);
    return height ?? null;
  };
}

/**
 * Precise terrain elevation for one geographic point, in metres above the
 * ellipsoid. Used for the mission origin.
 */
export async function sampleDetailedHeight(
  cesium: CesiumModule,
  terrainProvider: Cesium.TerrainProvider,
  latitude: number,
  longitude: number,
): Promise<number | null> {
  try {
    const point = cesium.Cartographic.fromDegrees(longitude, latitude);
    const [sampled] =
      terrainProvider.availability !== undefined
        ? await cesium.sampleTerrainMostDetailed(terrainProvider, [point])
        : await cesium.sampleTerrain(terrainProvider, FALLBACK_SAMPLE_LEVEL, [
            point,
          ]);
    if (!sampled || !Number.isFinite(sampled.height)) return null;
    return sampled.height;
  } catch {
    return null;
  }
}
