/**
 * The real weather, from the nearest aerodrome.
 *
 * This route stands between the browser and NOAA's Aviation Weather Center so
 * that the browser is not asked to trust a third-party origin with CORS, one
 * bounding-box query becomes one nearest-station answer, and a service that is
 * slow or down fails as a clean status here instead of as an unhandled fetch in
 * the middle of mission setup. The lookup itself lives in
 * `lib/weather/nearestMetarSource.ts`, because the desktop application has no
 * route to call and does the same thing from the page.
 *
 * `route.web.ts`, not `route.ts`: the desktop build is a static export and
 * cannot carry route handlers, and `pageExtensions` in `next.config.ts` is what
 * leaves this file out of it.
 */

import { NextResponse } from "next/server";

import {
  findNearestMetar,
  NO_STATION_MESSAGE,
  SERVICE_UNREACHABLE_MESSAGE,
} from "@/lib/weather/nearestMetarSource";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const latitude = Number(params.get("lat"));
  const longitude = Number(params.get("lon"));

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return NextResponse.json(
      { error: "lat and lon are required, in degrees" },
      { status: 400 },
    );
  }

  try {
    const nearest = await findNearestMetar(latitude, longitude, (url) =>
      fetch(url, {
        headers: { Accept: "application/json" },
        // The weather changes on the hour, not on the second, and a cached
        // answer is worth far more to the service than a fresh one is to the
        // pilot.
        next: { revalidate: 300 },
      }),
    );

    if (!nearest) {
      return NextResponse.json({ error: NO_STATION_MESSAGE }, { status: 404 });
    }
    return NextResponse.json(nearest);
  } catch (error) {
    console.error("[fpv] METAR lookup failed", error);
    return NextResponse.json(
      { error: SERVICE_UNREACHABLE_MESSAGE },
      { status: 502 },
    );
  }
}
