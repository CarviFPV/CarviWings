/**
 * Choosing a place to fly from, as plain numbers.
 *
 * The globe the player rotates is Cesium's, but every decision made on it is
 * ordinary arithmetic: what a picked point is called, whether something typed
 * into the search box is a coordinate pair rather than a place name, which
 * start altitudes are allowed, and where the ring drawn around the chosen spot
 * goes. All of that lives here, free of Cesium and of the DOM, so it can be
 * tested in Node like the rest of the simulation core.
 */

import { isValidLatitude, isValidLongitude } from "./locations";
import { haversineMetres } from "./wgs84";

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** A point that carries a name: a search hit, a bookmark, or a picked spot. */
export interface NamedPlace extends GeoPoint {
  readonly name: string;
}

/**
 * Start height above the ground. The floor keeps a launch clear of trees and
 * masts the terrain height field knows nothing about; the ceiling is high
 * enough for a mountain start and low enough to still be a wing rather than a
 * satellite.
 *
 * The default sits on that floor: a model is flown at the height a model is
 * actually flown at, and a flight that opens a few hundred metres up has to be
 * brought back down before any of it looks like one. Anybody who wants the
 * altitude has the presets and the slider; nobody who wants to fly low should
 * have to spend the first minute descending. It is read only by the modes that
 * start airborne — the RC ground view begins at the pilot's feet and asks for
 * no start height at all.
 */
export const SPAWN_ALTITUDE_LIMITS = {
  minimum: 50,
  maximum: 3000,
  default: 50,
} as const;

export const SPAWN_ALTITUDE_PRESETS = [50, 100, 200, 500, 1000] as const;

/**
 * Which way the aircraft is pointing when the flight begins, degrees from
 * north.
 *
 * North is the default because it is what the simulator did before the heading
 * could be chosen at all, and because a start point picked off a top-down map
 * is read north-up. Everything laid out around the start — where the pilot is
 * standing, the formation leader, the race grid and the run-in to the first
 * gate — is turned with it, so the choice is "which way am I facing", not
 * "which way is this one aircraft nose-on".
 */
export const DEFAULT_START_HEADING_DEG = 0;

/** The eight compass points, offered as one click each. */
export const START_HEADING_PRESETS = [
  0, 45, 90, 135, 180, 225, 270, 315,
] as const;

/** The sixteen-point compass rose, from north, clockwise. */
const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE",
  "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW",
  "W", "WNW", "NW", "NNW",
] as const;

/**
 * Wraps a heading into 0..360, exclusive of 360.
 *
 * Headings arrive off a slider that runs past the ends, out of arithmetic that
 * added a turn, and out of saved state that predates the control entirely — all
 * three have to come back as a compass bearing.
 */
export function normaliseHeading(degrees: number): number {
  if (!Number.isFinite(degrees)) return DEFAULT_START_HEADING_DEG;
  const wrapped = ((degrees % 360) + 360) % 360;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** The same thing in whole degrees, which is what a start heading is stored as. */
export function clampStartHeading(degrees: number): number {
  // Rounded, then wrapped again: 359.7 rounds to 360, which is north rather
  // than a heading one degree past the end of the compass.
  return normaliseHeading(Math.round(normaliseHeading(degrees)));
}

/** The compass point a heading falls on: 0 is N, 90 is E, 200 is SSW. */
export function compassPoint(degrees: number): string {
  const index = Math.round(normaliseHeading(degrees) / 22.5) % 16;
  return COMPASS_POINTS[index] as string;
}

/** A heading as it is read out loud: `045° NE`. */
export function formatHeading(degrees: number): string {
  const heading = clampStartHeading(degrees);
  return `${String(heading).padStart(3, "0")}° ${compassPoint(heading)}`;
}

/**
 * A point a given bearing and distance from another one.
 *
 * The same plane approximation as the marker ring, and right for the same
 * reason: it draws the needle that says which way the flight starts off, a few
 * hundred metres long.
 */
export function pointAlongHeading(
  centre: GeoPoint,
  headingDeg: number,
  metres: number,
): GeoPoint {
  const latitude = clampLatitude(centre.latitude);
  const longitude = normaliseLongitude(centre.longitude);
  const heading = (normaliseHeading(headingDeg) * Math.PI) / 180;
  const latitudeSpan = (metres * Math.cos(heading)) / METRES_PER_DEGREE;
  const cosine = Math.max(1e-6, Math.cos((latitude * Math.PI) / 180));
  const longitudeSpan = Math.max(
    -180,
    Math.min(180, (metres * Math.sin(heading)) / METRES_PER_DEGREE / cosine),
  );
  return {
    latitude: clampLatitude(latitude + latitudeSpan),
    longitude: normaliseLongitude(longitude + longitudeSpan),
  };
}

/**
 * How close a picked point has to be to a named place before it inherits that
 * name. Wide enough that clicking around a city still reads as the city,
 * narrow enough that the next valley is reported as coordinates instead.
 */
export const NAMED_PLACE_RADIUS_METRES = 25000;

/** Metres per degree of latitude, near enough for a marker ring. */
const METRES_PER_DEGREE = 111320;

export function clampSpawnAltitude(metres: number): number {
  if (!Number.isFinite(metres)) return SPAWN_ALTITUDE_LIMITS.default;
  return Math.min(
    SPAWN_ALTITUDE_LIMITS.maximum,
    Math.max(SPAWN_ALTITUDE_LIMITS.minimum, Math.round(metres)),
  );
}

/** Wraps a longitude into -180..180, which is what a dragged globe hands back. */
export function normaliseLongitude(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = ((degrees + 180) % 360 + 360) % 360 - 180;
  // The antimeridian is one meridian with two names. Reporting it as 180 East
  // keeps a formatted coordinate from reading as 180 West, and -0 from
  // reading as 0 South's longitudinal twin.
  if (wrapped === -180) return 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function clampLatitude(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return Math.min(90, Math.max(-90, degrees));
}

export function formatLatitude(degrees: number, digits = 4): string {
  const value = clampLatitude(degrees);
  return `${Math.abs(value).toFixed(digits)}° ${value < 0 ? "S" : "N"}`;
}

export function formatLongitude(degrees: number, digits = 4): string {
  const value = normaliseLongitude(degrees);
  return `${Math.abs(value).toFixed(digits)}° ${value < 0 ? "W" : "E"}`;
}

export function formatCoordinates(
  latitude: number,
  longitude: number,
  digits = 4,
): string {
  return `${formatLatitude(latitude, digits)}, ${formatLongitude(longitude, digits)}`;
}

/**
 * The first line of a geocoder's display name.
 *
 * Results come back as "Zurich, Zurich, Switzerland" — correct, and far too
 * long for a HUD readout. The head of the address is the place itself.
 */
export function shortPlaceName(displayName: string, maximum = 40): string {
  const head = displayName.split(",")[0]?.trim() ?? "";
  const name = head.length > 0 ? head : displayName.trim();
  if (name.length <= maximum) return name;
  return `${name.slice(0, maximum - 1).trimEnd()}…`;
}

/**
 * What to call a point the player clicked.
 *
 * Clicking somewhere near a place that was just searched for, or a bookmark
 * just flown to, keeps that name — a spot picked over Zurich is still Zurich.
 * Anywhere else is honestly reported as its coordinates rather than borrowing
 * the name of something a hundred kilometres away.
 */
export function placeNameForPick(
  point: GeoPoint,
  reference: NamedPlace | null,
  radiusMetres = NAMED_PLACE_RADIUS_METRES,
): string {
  if (reference) {
    const distance = haversineMetres(
      point.latitude,
      point.longitude,
      reference.latitude,
      reference.longitude,
    );
    if (distance <= radiusMetres && reference.name.trim().length > 0) {
      return reference.name.trim();
    }
  }
  return formatCoordinates(point.latitude, point.longitude);
}

// One half of a coordinate pair: an optional hemisphere letter on either side
// of a signed degree value, with optional minutes and seconds after it.
const HALF =
  "([NSEW])?\\s*([+-]?\\d+(?:\\.\\d+)?)(?:\\s+(\\d+(?:\\.\\d+)?))?(?:\\s+(\\d+(?:\\.\\d+)?))?\\s*([NSEW])?";
const PAIR = new RegExp(`^${HALF}[\\s,;/]+${HALF}$`, "i");

interface Angle {
  readonly value: number;
  readonly hemisphere: string | null;
}

function toAngle(
  prefix: string | undefined,
  degrees: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  suffix: string | undefined,
): Angle | null {
  if (degrees === undefined) return null;
  const hemisphere = (prefix || suffix || "").toUpperCase() || null;
  // A hemisphere on both ends is a contradiction, not a coordinate.
  if (prefix && suffix) return null;
  const whole = Number(degrees);
  if (!Number.isFinite(whole)) return null;
  const minute = minutes === undefined ? 0 : Number(minutes);
  const second = seconds === undefined ? 0 : Number(seconds);
  if (!Number.isFinite(minute) || !Number.isFinite(second)) return null;
  if (minute >= 60 || second >= 60) return null;
  // Degrees, minutes and seconds only make sense read outward from zero, so
  // the sign is applied once, after the fractional parts are added on.
  const magnitude = Math.abs(whole) + minute / 60 + second / 3600;
  const negative = whole < 0 || hemisphere === "S" || hemisphere === "W";
  return { value: negative ? -magnitude : magnitude, hemisphere };
}

/**
 * Reads a coordinate pair out of the search box.
 *
 * The search field is a place-name search first, but a pair of coordinates is
 * something people paste — out of Google Maps, off a chart, out of a flight
 * log — and asking a geocoder to look up "46.5375, 7.9625" is a request that
 * did not need making. Decimal degrees, degrees and minutes, and full
 * degrees/minutes/seconds are all accepted, with or without hemisphere
 * letters, in either order when the letters say which is which.
 *
 * Returns `null` for anything that is not unambiguously a coordinate pair, so
 * the caller can fall back to a geocoder lookup.
 */
export function parseCoordinateQuery(query: string): GeoPoint | null {
  const cleaned = query
    .trim()
    // Degree, minute and second marks are separators, not data.
    .replace(/[°º′″'"’]/g, " ")
    .replace(/\s+/g, " ");
  if (cleaned.length === 0) return null;

  const match = PAIR.exec(cleaned);
  if (!match) return null;

  const first = toAngle(match[1], match[2], match[3], match[4], match[5]);
  const second = toAngle(match[6], match[7], match[8], match[9], match[10]);
  if (!first || !second) return null;

  // Hemisphere letters, when present, decide which half is which — pasted
  // coordinates are not always latitude first.
  const firstIsLongitude =
    first.hemisphere === "E" ||
    first.hemisphere === "W" ||
    second.hemisphere === "N" ||
    second.hemisphere === "S";
  const latitude = firstIsLongitude ? second : first;
  const longitude = firstIsLongitude ? first : second;

  // A letter that contradicts the axis it landed on is a typo, not a location.
  if (latitude.hemisphere === "E" || latitude.hemisphere === "W") return null;
  if (longitude.hemisphere === "N" || longitude.hemisphere === "S") return null;

  if (!isValidLatitude(latitude.value)) return null;
  if (!isValidLongitude(longitude.value)) return null;

  return { latitude: latitude.value, longitude: longitude.value };
}

/**
 * A ring of points around a centre, for the marker drawn on the ground.
 *
 * A plane approximation is right here and a geodesic would not be: the ring is
 * a few hundred metres across and only has to look circular. The longitude
 * scale is clamped near the poles, where a metre is a great many degrees.
 */
export function ringAroundDegrees(
  centre: GeoPoint,
  radiusMetres: number,
  segments = 64,
): GeoPoint[] {
  const count = Math.max(3, Math.round(segments));
  const latitude = clampLatitude(centre.latitude);
  const longitude = normaliseLongitude(centre.longitude);
  const latitudeSpan = radiusMetres / METRES_PER_DEGREE;
  const cosine = Math.max(1e-6, Math.cos((latitude * Math.PI) / 180));
  const longitudeSpan = Math.min(180, latitudeSpan / cosine);

  const ring: GeoPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    ring.push({
      latitude: clampLatitude(latitude + Math.cos(angle) * latitudeSpan),
      longitude: normaliseLongitude(longitude + Math.sin(angle) * longitudeSpan),
    });
  }
  return ring;
}
