import { assert, assertClose, suite } from "./harness";
import { EnuFrame } from "../geo/enuFrame";
import { ecefToGeodetic, geodeticToEcef, haversineMetres } from "../geo/wgs84";
import {
  DEFAULT_MISSION_RADIUS,
  LOCATION_PRESETS,
  MAX_MISSION_RADIUS,
  MIN_MISSION_RADIUS,
  MISSION_RADIUS_STEP,
} from "../geo/locations";
import {
  clampSpawnAltitude,
  clampStartHeading,
  compassPoint,
  DEFAULT_START_HEADING_DEG,
  formatCoordinates,
  formatHeading,
  normaliseHeading,
  normaliseLongitude,
  parseCoordinateQuery,
  placeNameForPick,
  pointAlongHeading,
  ringAroundDegrees,
  shortPlaceName,
  SPAWN_ALTITUDE_LIMITS,
  SPAWN_ALTITUDE_PRESETS,
} from "../geo/placePicker";
import * as V from "../math/vec3";

export function runGeoTests(): void {
  suite("wgs84", () => {
    // Reference: a point on the equator at the prime meridian sits on the
    // semi-major axis.
    const equator = geodeticToEcef(0, 0, 0);
    assertClose(equator.x, 6378137, 1e-6, "equator/prime meridian x = a");
    assertClose(equator.y, 0, 1e-6, "equator/prime meridian y = 0");
    assertClose(equator.z, 0, 1e-6, "equator/prime meridian z = 0");

    // North pole sits on the semi-minor axis.
    const pole = geodeticToEcef(90, 0, 0);
    assertClose(pole.z, 6356752.314245, 1e-4, "north pole z = b");

    for (const preset of LOCATION_PRESETS) {
      const height = preset.approximateTerrainHeight;
      const ecef = geodeticToEcef(preset.latitude, preset.longitude, height);
      const back = ecefToGeodetic(ecef);
      assertClose(back.latitude, preset.latitude, 1e-8, `${preset.name} latitude round-trip`);
      assertClose(back.longitude, preset.longitude, 1e-8, `${preset.name} longitude round-trip`);
      assertClose(back.height, height, 1e-4, `${preset.name} height round-trip`);
    }
  });

  suite("local ENU frame", () => {
    const preset = LOCATION_PRESETS[0]!;
    const frame = new EnuFrame({
      latitude: preset.latitude,
      longitude: preset.longitude,
      height: preset.approximateTerrainHeight,
    });

    const originLocal = frame.geographicToLocal(
      preset.latitude,
      preset.longitude,
      preset.approximateTerrainHeight,
    );
    assertClose(V.length(originLocal), 0, 1e-6, "frame origin maps to (0,0,0)");

    // Basis vectors must be orthonormal and right-handed.
    assertClose(V.length(frame.east as V.Vec3), 1, 1e-12, "east is unit length");
    assertClose(V.length(frame.north as V.Vec3), 1, 1e-12, "north is unit length");
    assertClose(V.length(frame.up as V.Vec3), 1, 1e-12, "up is unit length");
    assertClose(V.dot(frame.east as V.Vec3, frame.north as V.Vec3), 0, 1e-12, "east . north = 0");
    assertClose(V.dot(frame.north as V.Vec3, frame.up as V.Vec3), 0, 1e-12, "north . up = 0");
    const cross = V.cross(V.vec3(), frame.east as V.Vec3, frame.north as V.Vec3);
    assertClose(V.distance(cross, frame.up as V.Vec3), 0, 1e-12, "east x north = up");

    // Round-trips across the full 50 km mission radius, including altitude.
    for (const point of [
      V.vec3(0, 0, 500),
      V.vec3(1000, -2500, 320),
      V.vec3(-35000, 12000, 4200),
      V.vec3(50000, 50000, 0),
    ]) {
      const geo = frame.localToGeographic(point);
      const back = frame.geographicToLocal(geo.latitude, geo.longitude, geo.height);
      assertClose(V.distance(point, back), 0, 1e-6, `ENU round-trip at ${point.x},${point.y}`);
    }

    // 1 km east must move longitude, not latitude.
    const east1km = frame.localToGeographic(V.vec3(1000, 0, 0));
    assert(east1km.longitude > preset.longitude, "moving east increases longitude");
    assertClose(east1km.latitude, preset.latitude, 2e-3, "moving east barely changes latitude");
    const measured = haversineMetres(
      preset.latitude,
      preset.longitude,
      east1km.latitude,
      east1km.longitude,
    );
    // Haversine uses a mean sphere, so it disagrees with the ellipsoid by ~0.3%.
    assertClose(measured, 1000, 5, "1 km east measures 1 km on the ground");

    // 1 km north must move latitude by roughly 0.009 degrees.
    const north1km = frame.localToGeographic(V.vec3(0, 1000, 0));
    assertClose(north1km.latitude - preset.latitude, 0.008993, 1e-4, "1 km north latitude delta");

    // The tangent plane is not flat Earth: a point 50 km out and level in the
    // local frame must sit measurably *above* the ellipsoid because the Earth
    // curves away underneath it.
    const far = frame.localToGeographic(V.vec3(50000, 0, 0));
    const drop = far.height - preset.approximateTerrainHeight;
    assert(
      drop > 150 && drop < 250,
      `50 km tangent-plane curvature accounted for (${drop.toFixed(1)} m)`,
    );

    // Direction rotation must preserve length and be the inverse of itself.
    const dir = V.normalize(V.vec3(), V.vec3(0.3, -0.5, 0.81));
    const ecefDir = frame.enuVectorToEcef(dir);
    assertClose(V.length(ecefDir), 1, 1e-12, "direction rotation preserves length");
    const backDir = frame.ecefVectorToEnu(ecefDir);
    assertClose(V.distance(dir, backDir), 0, 1e-12, "direction rotation round-trips");
  });

  suite("place picker", () => {
    // Longitudes come off a dragged globe unwrapped: the camera can be spun
    // past the date line any number of times.
    assertClose(normaliseLongitude(190), -170, 1e-12, "190 wraps to -170");
    assertClose(normaliseLongitude(-190), 170, 1e-12, "-190 wraps to 170");
    assertClose(normaliseLongitude(720 + 45), 45, 1e-12, "two turns wrap away");
    assertClose(normaliseLongitude(180), 180, 1e-12, "180 stays on 180");
    assertClose(normaliseLongitude(-180), 180, 1e-12, "the antimeridian reads east");
    assert(!Object.is(normaliseLongitude(0), -0), "zero never comes back negative");

    assert(
      clampSpawnAltitude(10) === SPAWN_ALTITUDE_LIMITS.minimum,
      "spawn altitude is floored",
    );
    assert(
      clampSpawnAltitude(99999) === SPAWN_ALTITUDE_LIMITS.maximum,
      "spawn altitude is capped",
    );
    assert(clampSpawnAltitude(312.4) === 312, "spawn altitude is whole metres");
    assert(
      clampSpawnAltitude(Number.NaN) === SPAWN_ALTITUDE_LIMITS.default,
      "an unparsable altitude falls back to the default",
    );

    // A flight opens where a model is actually flown rather than a few
    // hundred metres up, and the number offered is one the pilot can click
    // back to after moving the slider.
    assert(
      SPAWN_ALTITUDE_LIMITS.default === 50,
      "a flight starts 50 m above the ground by default",
    );
    assert(
      SPAWN_ALTITUDE_LIMITS.default === SPAWN_ALTITUDE_LIMITS.minimum,
      "the default start height sits on the floor of the range",
    );
    assert(
      SPAWN_ALTITUDE_PRESETS.includes(
        SPAWN_ALTITUDE_LIMITS.default as (typeof SPAWN_ALTITUDE_PRESETS)[number],
      ),
      "the default start height is one of the presets",
    );
    assert(
      SPAWN_ALTITUDE_PRESETS.every(
        (metres) =>
          metres >= SPAWN_ALTITUDE_LIMITS.minimum &&
          metres <= SPAWN_ALTITUDE_LIMITS.maximum,
      ),
      "every start-height preset is inside the range",
    );

    assert(
      formatCoordinates(46.5375, 7.9625) === "46.5375\u00b0 N, 7.9625\u00b0 E",
      "northern/eastern coordinates format",
    );
    assert(
      formatCoordinates(-33.8688, -151.2093, 2) === "33.87\u00b0 S, 151.21\u00b0 W",
      "southern/western coordinates format",
    );

    assert(
      shortPlaceName("Zurich, Zurich, Switzerland") === "Zurich",
      "a display name is cut down to the place itself",
    );
    assert(shortPlaceName("Porto") === "Porto", "a bare name is left alone");
    assert(
      shortPlaceName("A".repeat(80)).length === 40,
      "an absurd name is truncated",
    );

    // Coordinate pairs are recognised without troubling the geocoder.
    for (const [query, latitude, longitude] of [
      ["46.5375, 7.9625", 46.5375, 7.9625],
      ["46.5375 7.9625", 46.5375, 7.9625],
      ["-33.8688,151.2093", -33.8688, 151.2093],
      ["46.5375N 7.9625E", 46.5375, 7.9625],
      ["7.9625E, 46.5375N", 46.5375, 7.9625],
      ["N 46.5375, W 7.9625", 46.5375, -7.9625],
      ["46\u00b0 32' 15\" N, 7\u00b0 57' 45\" E", 46.5375, 7.9625],
      ["S33 52 7.7, E151 12 33.5", -33.868806, 151.209306],
    ] as const) {
      const parsed = parseCoordinateQuery(query);
      assert(parsed !== null, `"${query}" parses as a coordinate pair`);
      if (parsed) {
        assertClose(parsed.latitude, latitude, 1e-4, `"${query}" latitude`);
        assertClose(parsed.longitude, longitude, 1e-4, `"${query}" longitude`);
      }
    }

    for (const query of [
      "Zurich",
      "New York",
      "",
      "46.5375",
      "95.0, 7.9625",
      "46.5375, 200.0",
      "46.5375N, 7.9625N",
      "Bern 3011",
    ]) {
      assert(
        parseCoordinateQuery(query) === null,
        `"${query}" is left to the geocoder`,
      );
    }

    // A pick near what was just searched for keeps the name; one that is a
    // long way off reports coordinates instead of borrowing it.
    const zurich = { name: "Zurich", latitude: 47.3769, longitude: 8.5417 };
    assert(
      placeNameForPick({ latitude: 47.39, longitude: 8.52 }, zurich) === "Zurich",
      "a pick over the searched city keeps its name",
    );
    assert(
      placeNameForPick({ latitude: 46.9481, longitude: 7.4474 }, zurich) ===
        formatCoordinates(46.9481, 7.4474),
      "a pick 100 km away is reported as coordinates",
    );
    assert(
      placeNameForPick({ latitude: 12, longitude: 34 }, null) ===
        formatCoordinates(12, 34),
      "a pick with nothing searched is reported as coordinates",
    );

    // The marker ring has to be a ring: right radius, closed, and no runaway
    // longitude near the poles.
    const centre = { latitude: 46.5375, longitude: 7.9625 };
    const ring = ringAroundDegrees(centre, 250, 32);
    assert(ring.length === 32, "the ring has the requested segment count");
    for (const point of ring) {
      const distance = haversineMetres(
        centre.latitude,
        centre.longitude,
        point.latitude,
        point.longitude,
      );
      assertClose(distance, 250, 3, "every ring point sits on the radius");
    }
    for (const point of ringAroundDegrees({ latitude: 89.999, longitude: 10 }, 5000)) {
      assert(
        point.longitude >= -180 && point.longitude <= 180,
        "a polar ring stays on the map",
      );
      assert(
        point.latitude >= -90 && point.latitude <= 90,
        "a polar ring stays on the planet",
      );
    }
  });

  suite("start heading", () => {
    // A heading is a bearing: it comes off a control that runs past the ends,
    // out of arithmetic that added a turn, and out of state that never had one.
    assert(normaliseHeading(360) === 0, "a full turn is north");
    assert(normaliseHeading(-90) === 270, "a negative bearing wraps west");
    assert(normaliseHeading(725) === 5, "two turns wrap away");
    assert(
      normaliseHeading(Number.NaN) === DEFAULT_START_HEADING_DEG,
      "an unparsable heading falls back to the default",
    );
    assert(!Object.is(normaliseHeading(-0), -0), "zero never comes back negative");
    assert(clampStartHeading(44.6) === 45, "a start heading is whole degrees");
    assert(clampStartHeading(359.7) === 0, "rounding past the end wraps to north");

    assert(compassPoint(0) === "N", "zero is north");
    assert(compassPoint(90) === "E", "ninety is east");
    assert(compassPoint(200) === "SSW", "the rose has sixteen points");
    assert(compassPoint(359) === "N", "the rose closes on north");
    assert(formatHeading(45) === "045° NE", "a heading reads as bearing and point");
    assert(formatHeading(-1) === "359° N", "a wrapped heading still reads");

    // The needle drawn on the marker has to point where it says it does.
    const from = { latitude: 46.5375, longitude: 7.9625 };
    for (const [heading, name] of [
      [0, "north"],
      [90, "east"],
      [180, "south"],
      [270, "west"],
    ] as const) {
      const point = pointAlongHeading(from, heading, 1200);
      assertClose(
        haversineMetres(
          from.latitude,
          from.longitude,
          point.latitude,
          point.longitude,
        ),
        1200,
        12,
        `a needle ${name} is the length asked for`,
      );
    }
    assert(
      pointAlongHeading(from, 0, 1000).latitude > from.latitude &&
        Math.abs(pointAlongHeading(from, 0, 1000).longitude - from.longitude) < 1e-9,
      "north is straight up the meridian",
    );
    assert(
      pointAlongHeading(from, 90, 1000).longitude > from.longitude &&
        Math.abs(pointAlongHeading(from, 90, 1000).latitude - from.latitude) < 1e-9,
      "east is straight along the parallel",
    );
    // Out of a start point beside the date line, a needle east stays on the map.
    const edge = pointAlongHeading(
      { latitude: 0, longitude: 179.995 },
      90,
      2000,
    );
    assert(
      edge.longitude >= -180 && edge.longitude <= 180,
      "a needle over the antimeridian stays on the map",
    );
  });

  suite("mission radius", () => {
    // The area a normal flight actually covers, and a floor small enough for
    // a field flown line of sight.
    assert(
      DEFAULT_MISSION_RADIUS === 2000,
      "a mission is flown in a 2 km area by default",
    );
    assert(MIN_MISSION_RADIUS === 500, "the flight area goes down to 500 m");
    assert(
      MIN_MISSION_RADIUS < DEFAULT_MISSION_RADIUS &&
        DEFAULT_MISSION_RADIUS < MAX_MISSION_RADIUS,
      "the default sits inside the range",
    );
    // Every value the slider can reach is a whole step off the floor, so the
    // default is one of them rather than a number the control skips over.
    assert(
      (DEFAULT_MISSION_RADIUS - MIN_MISSION_RADIUS) % MISSION_RADIUS_STEP === 0,
      "the default is a whole number of steps above the minimum",
    );
    assert(
      (MAX_MISSION_RADIUS - MIN_MISSION_RADIUS) % MISSION_RADIUS_STEP === 0,
      "the maximum is a whole number of steps above the minimum",
    );
  });
}
