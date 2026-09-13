/**
 * The nearest current METAR to a point, as NOAA tells it.
 *
 * NOAA's Aviation Weather Center publishes every current METAR in the world,
 * free and without a key, which is exactly what "fly what it is actually doing
 * over there right now" needs. What it publishes is a bounding box full of
 * reports, though, and the simulator wants one station: this is the part that
 * asks for the box and picks the report out of it.
 *
 * It runs in two quite different places, which is why it takes the `fetch` to
 * use rather than reaching for one:
 *
 *   - on the web, inside `app/api/metar`, so the browser is not asked to trust
 *     a third-party origin with CORS and a hundred reports are not downloaded
 *     to use one of them;
 *   - in the desktop application, where there is no route to call, straight
 *     from the page through the shell's own HTTP client — which is also what
 *     gets it past CORS, since aviationweather.gov sends no allow-origin
 *     header and a webview would otherwise refuse the answer.
 *
 * The report itself is passed through verbatim either way. Decoding it is
 * `sim/environment/metar.ts`'s job and happens on the client, so the same code
 * path serves a fetched report and one the pilot typed in by hand.
 */

const SOURCE = "https://aviationweather.gov/api/data/metar";

/**
 * How far out to look, in degrees of latitude.
 *
 * Widened only when the smaller box came back empty: most flights start
 * somewhere with an aerodrome within a degree, and asking for eight degrees of
 * the planet to serve them would be rude to a free service.
 */
const SEARCH_RADII = [1.5, 4, 9];

/** Reports older than this are stale enough not to be "the real weather". */
const MAX_AGE_HOURS = 3;

const EARTH_RADIUS_KM = 6371;

/** Nothing is reporting anywhere near the mission. */
export const NO_STATION_MESSAGE =
  "No aerodrome within nine degrees is reporting right now.";

/** The service itself is unreachable or unhappy. */
export const SERVICE_UNREACHABLE_MESSAGE =
  "The weather service could not be reached.";

interface AwcReport {
  icaoId?: string;
  name?: string;
  rawOb?: string;
  lat?: number;
  lon?: number;
  elev?: number;
  obsTime?: number;
  reportTime?: string;
}

export interface NearestMetar {
  readonly station: string;
  readonly name: string | null;
  readonly latitude: number;
  readonly longitude: number;
  /** Station elevation, metres above the ellipsoid. */
  readonly elevation: number | null;
  readonly raw: string;
  readonly observedAt: string | null;
  readonly distanceKm: number;
}

/**
 * As much of `fetch` as the lookup uses.
 *
 * Narrow on purpose: the two callers hand over quite different clients — one a
 * server `fetch` with Next's cache hints attached, the other the desktop
 * shell's HTTP plugin — and this is the shape they have in common.
 */
export type MetarFetch = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

function greatCircleKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRadians = Math.PI / 180;
  const dLat = (latitudeB - latitudeA) * toRadians;
  const dLon = (longitudeB - longitudeA) * toRadians;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latitudeA * toRadians) *
      Math.cos(latitudeB * toRadians) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function fetchBox(
  request: MetarFetch,
  latitude: number,
  longitude: number,
  radius: number,
): Promise<AwcReport[]> {
  const box = [
    (latitude - radius).toFixed(3),
    (longitude - radius).toFixed(3),
    (latitude + radius).toFixed(3),
    (longitude + radius).toFixed(3),
  ].join(",");
  const url = `${SOURCE}?bbox=${box}&format=json&hours=${MAX_AGE_HOURS}`;

  const response = await request(url);
  if (!response.ok) {
    throw new Error(`aviationweather.gov returned ${response.status}`);
  }
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as AwcReport[]) : [];
}

/**
 * The closest station to a point that is reporting, or `null` if none is.
 *
 * Throws whatever the `fetch` threw, or an `Error` naming the status, when the
 * service could not be asked at all — the difference between "nobody out there
 * is reporting" and "NOAA is down" is worth keeping.
 */
export async function findNearestMetar(
  latitude: number,
  longitude: number,
  request: MetarFetch,
): Promise<NearestMetar | null> {
  for (const radius of SEARCH_RADII) {
    const reports = await fetchBox(request, latitude, longitude, radius);
    let best: NearestMetar | null = null;

    for (const report of reports) {
      if (!report.rawOb || !report.icaoId) continue;
      if (typeof report.lat !== "number" || typeof report.lon !== "number") {
        continue;
      }
      const distanceKm = greatCircleKm(
        latitude,
        longitude,
        report.lat,
        report.lon,
      );
      if (best && distanceKm >= best.distanceKm) continue;
      best = {
        station: report.icaoId,
        name: report.name ?? null,
        latitude: report.lat,
        longitude: report.lon,
        elevation: typeof report.elev === "number" ? report.elev : null,
        raw: report.rawOb,
        observedAt:
          report.reportTime ??
          (typeof report.obsTime === "number"
            ? new Date(report.obsTime * 1000).toISOString()
            : null),
        distanceKm,
      };
    }

    if (best) return best;
  }

  return null;
}
