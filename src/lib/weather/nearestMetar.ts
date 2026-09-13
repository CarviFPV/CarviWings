"use client";

/**
 * Fetching the real weather.
 *
 * A thin client over `/api/metar`, which is the route that actually talks to
 * NOAA. Everything interesting happens elsewhere: the route finds the nearest
 * reporting aerodrome, and `sim/environment/metar.ts` decodes what it sends
 * back — the same decoder a report typed in by hand goes through, so a live
 * sky and a hand-typed one are the same kind of thing in every respect
 * afterwards.
 *
 * The desktop application has no route to call, so there the same lookup is run
 * from here, through the shell's HTTP client. Both paths end in the same
 * report, and everything below `fetchNearestMetar` is unaware of which one ran.
 *
 * What is added here is the one piece of context the report cannot carry: the
 * aerodrome's elevation. Cloud bases are reported above the *station*, and the
 * flight starts wherever the pilot dropped the marker, which may be two
 * thousand metres higher up a valley. Without the offset a base reported over a
 * sea-level airfield would sit inside the ridge.
 */

import type { WeatherState } from "@/sim/environment/types";
import { WEATHER_SOURCE } from "@/sim/environment/types";
import { parseMetar, weatherStateFromMetar } from "@/sim/environment/metar";
import { desktopFetch, isDesktopRuntime } from "@/lib/desktop/runtime";
import {
  findNearestMetar,
  NO_STATION_MESSAGE,
  SERVICE_UNREACHABLE_MESSAGE,
  type NearestMetar,
} from "@/lib/weather/nearestMetarSource";

export type NearestMetarResult = NearestMetar;

export class MetarLookupError extends Error {}

/** The nearest current report to a point, or a thrown `MetarLookupError`. */
export async function fetchNearestMetar(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<NearestMetarResult> {
  if (isDesktopRuntime()) {
    return fetchNearestMetarFromShell(latitude, longitude, signal);
  }

  const response = await fetch(
    `/api/metar?lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`,
    { signal },
  );
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `The weather service returned ${response.status}.`;
    throw new MetarLookupError(detail);
  }
  if (!body || typeof body !== "object" || !("raw" in body)) {
    throw new MetarLookupError("The weather service sent nothing usable.");
  }
  return body as NearestMetarResult;
}

/**
 * The same lookup the route does, run in the desktop application.
 *
 * The request is made by the shell rather than by the webview, which is what
 * gets it past NOAA sending no allow-origin header. An abort still reaches it:
 * the plugin cancels the native request, and the `AbortError` it throws is left
 * alone so a caller that walked away is not told the weather failed.
 */
async function fetchNearestMetarFromShell(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<NearestMetarResult> {
  let nearest: NearestMetarResult | null;
  try {
    nearest = await findNearestMetar(latitude, longitude, (url) =>
      desktopFetch(url, { headers: { Accept: "application/json" }, signal }),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error("[fpv] METAR lookup failed", error);
    throw new MetarLookupError(SERVICE_UNREACHABLE_MESSAGE);
  }

  if (!nearest) throw new MetarLookupError(NO_STATION_MESSAGE);
  return nearest;
}

export interface LiveWeather {
  readonly state: WeatherState;
  readonly report: NearestMetarResult;
}

/**
 * The real weather at a point, decoded and ready to fly.
 *
 * @param terrainHeight Ground elevation at the mission origin, metres. The
 *   difference between this and the station's elevation is what shifts the
 *   reported cloud bases into the mission's own frame.
 */
export async function fetchLiveWeather(
  latitude: number,
  longitude: number,
  terrainHeight: number | null,
  signal?: AbortSignal,
): Promise<LiveWeather> {
  const report = await fetchNearestMetar(latitude, longitude, signal);
  const parsed = parseMetar(report.raw);
  if (!parsed) {
    throw new MetarLookupError(
      `${report.station} is reporting something this decoder cannot read.`,
    );
  }

  const offset =
    terrainHeight !== null && report.elevation !== null
      ? terrainHeight - report.elevation
      : 0;

  const state = weatherStateFromMetar(parsed, {
    stationElevationOffset: offset,
  });

  return {
    report,
    state: {
      ...state,
      source: WEATHER_SOURCE.Live,
      label: report.name ? `${report.station} — ${report.name}` : report.station,
      description: `Live report from ${report.station}, ${Math.round(
        report.distanceKm,
      )} km away.`,
    },
  };
}
