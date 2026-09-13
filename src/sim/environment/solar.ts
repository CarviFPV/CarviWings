/**
 * Solar position.
 *
 * The simulation needs to know how much daylight there is: it drives detection
 * ranges, exposure and whether the stars are out. Cesium computes its own sun
 * for rendering, but the gameplay side must not have to ask a renderer what
 * time it is, so the elevation is computed here from first principles.
 *
 * Low-precision NOAA solar position — accurate to a fraction of a degree,
 * which is far better than a visibility model needs.
 */

import { clamp, DEG_TO_RAD, RAD_TO_DEG } from "../math/scalar";

/** Days since the J2000.0 epoch for a UTC instant. */
export function julianCenturiesSinceJ2000(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5 - 2451545.0;
}

export interface SolarPosition {
  /** Degrees above the horizon; negative when the sun has set. */
  elevation: number;
  /** Compass degrees, 0 = north. */
  azimuth: number;
  /** Solar declination in degrees. */
  declination: number;
}

export function solarPosition(
  latitude: number,
  longitude: number,
  date: Date,
): SolarPosition {
  const n = julianCenturiesSinceJ2000(date);

  // Mean longitude and mean anomaly of the sun.
  const meanLongitude = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * DEG_TO_RAD;

  // Ecliptic longitude, corrected for the equation of centre.
  const eclipticLongitude =
    (meanLongitude +
      1.915 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly)) *
    DEG_TO_RAD;

  const obliquity = (23.439 - 0.0000004 * n) * DEG_TO_RAD;

  const declination = Math.asin(
    Math.sin(obliquity) * Math.sin(eclipticLongitude),
  );
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );

  // Greenwich mean sidereal time, then the local hour angle.
  const gmstHours = (18.697374558 + 24.06570982441908 * n) % 24;
  const localSiderealDegrees = gmstHours * 15 + longitude;
  let hourAngle = (localSiderealDegrees - rightAscension * RAD_TO_DEG) % 360;
  if (hourAngle > 180) hourAngle -= 360;
  if (hourAngle < -180) hourAngle += 360;
  const hourAngleRad = hourAngle * DEG_TO_RAD;

  const lat = latitude * DEG_TO_RAD;
  const sinElevation =
    Math.sin(lat) * Math.sin(declination) +
    Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngleRad);
  const elevation = Math.asin(clamp(sinElevation, -1, 1));

  const azimuth = Math.atan2(
    -Math.sin(hourAngleRad),
    Math.tan(declination) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngleRad),
  );

  return {
    elevation: elevation * RAD_TO_DEG,
    azimuth: (azimuth * RAD_TO_DEG + 360) % 360,
    declination: declination * RAD_TO_DEG,
  };
}

/**
 * Daylight as a 0..1 factor.
 *
 * Ramps across the civil twilight band rather than switching at the horizon,
 * so exposure and detection ranges change smoothly through dawn and dusk.
 */
export function daylightFactor(elevationDegrees: number): number {
  return clamp((elevationDegrees + 6) / 12, 0, 1);
}

/**
 * The UTC instant at which a given local solar hour occurs on a date.
 *
 * Uses the longitude offset rather than a civil timezone: the simulator cares
 * where the sun is, not what a clock on the ground would say.
 */
export function utcForLocalSolarHour(
  longitude: number,
  localHour: number,
  reference: Date = new Date(),
): Date {
  const midnight = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
  );
  const utcHour = localHour - longitude / 15;
  return new Date(midnight + utcHour * 3600000);
}
