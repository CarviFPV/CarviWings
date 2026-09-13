"use client";

/**
 * Polls the running flight for an instrument snapshot.
 *
 * The simulation deliberately does not push into React. The frame loop runs at
 * display rate and would drag the whole component tree with it; instead the HUD
 * samples what it needs a few times a second, and the numbers it reads are a
 * copy so nothing downstream can retain the simulation's reusable buffer.
 */

import { useEffect, useRef, useState } from "react";
import type { FlightSession } from "@/lib/cesium/flightSession";
import type { FlightTelemetry } from "@/sim/flight/telemetry";
import { createTelemetry } from "@/sim/flight/telemetry";

export function useTelemetry(
  session: FlightSession | null,
  hertz = 10,
): FlightTelemetry {
  const [snapshot, setSnapshot] = useState<FlightTelemetry>(createTelemetry);
  const lastRef = useRef(0);

  useEffect(() => {
    if (!session) return;
    let raf = 0;
    const interval = 1000 / hertz;

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (now - lastRef.current < interval) return;
      lastRef.current = now;
      setSnapshot({ ...session.telemetry() });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session, hertz]);

  return snapshot;
}

export interface DebugSnapshot {
  fps: number;
  frameMs: number;
  cameraMode: string;
  inputDevice: string;
  controllerName: string | null;
  status: string;
  terrainCells: number;
  /** Cells in the close-in grid the ground is actually flown against. */
  terrainDetailCells: number;
  /** Offset applied to bring the sampled ground onto the drawn one, metres. */
  terrainSurfaceBias: number;
  /** The 3D scenery actually in the scene, which may be a downgrade. */
  worldDetail: string;
  /**
   * How much of the world was fetched before the flight was handed over: the
   * ground the elevation cache covers, and the height the distance was staged
   * from.
   */
  preloadRadius: number;
  preloadOverview: number;
  aircraftCount: number;
  enemyCount: number;
  targetId: string | null;
  weather: string;
  timeOfDay: string;
  /** The instant being flown at, in the zone the clock was set in. */
  clock: string;
  daylight: number;
  sunElevation: number;
  cloudCount: number;
  cloudMode: string;
  /** How much of the sky the cloud is filling, 0..1. */
  cloudCover: number;
  /** Every deck in flight, as bounds and cover. */
  cloudDecks: string;
  inCloud: boolean;
  /** How bright the sky is from lightning right now, 0..1. */
  lightningFlash: number;
  stormy: boolean;
  sightRange: number;
  rainAvailable: boolean;
  targetAiState: string | null;
  /** The gate the tracked rival is flying at; null off a race. */
  targetGate: string | null;
  targetAiConfidence: number;
  targetAiAvoiding: boolean;
  targetAiClearance: number;
  missionTime: number;
  angleOfAttack: number;
  sideslip: number;
  loadFactor: number;
  originLatitude: number;
  originLongitude: number;
  originHeight: number;
  localX: number;
  localY: number;
  localZ: number;
}

export function useDebugSnapshot(
  session: FlightSession | null,
  enabled: boolean,
  hertz = 5,
): DebugSnapshot | null {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const lastRef = useRef(0);

  useEffect(() => {
    if (!session || !enabled) {
      setSnapshot(null);
      return;
    }
    let raf = 0;
    const interval = 1000 / hertz;

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (now - lastRef.current < interval) return;
      lastRef.current = now;
      const player = session.playerState;
      const targetId = session.simulation.target?.id ?? null;
      const enemy = session.enemyDebug(targetId);
      const racer = session.racerDebug(targetId);
      const flyer = session.festivalDebug(targetId);
      const transit = session.transitDebug(targetId);
      setSnapshot({
        fps: session.stats.fps,
        frameMs: session.stats.frameMs,
        cameraMode: session.cameraMode,
        inputDevice: session.activeInputDevice,
        controllerName: session.controllerName,
        status: player?.status ?? "NONE",
        terrainCells: session.terrainCacheSize,
        terrainDetailCells: session.terrainDetail.cells,
        terrainSurfaceBias: session.terrainDetail.surfaceBias,
        worldDetail: session.scenery.route
          ? `${session.scenery.applied} (${session.scenery.route})`
          : session.scenery.applied,
        preloadRadius: session.preloadStatus.terrainRadius,
        preloadOverview: session.preloadStatus.overviewHeight,
        aircraftCount: session.simulation.aircraft.length,
        enemyCount: session.simulation.enemyCount,
        targetId,
        weather: session.weather,
        timeOfDay: session.timeOfDay,
        clock: session.clockLabel,
        daylight: session.environment.daylight,
        sunElevation: session.environment.sunElevationDegrees,
        cloudCount: session.environment.cloudCount,
        cloudMode: session.environment.cloudMode,
        cloudCover: session.cloudCover,
        cloudDecks: session.environment.deckSummary,
        inCloud: session.environment.inCloud,
        lightningFlash: session.environment.lightningFlash,
        stormy: session.environment.stormy,
        sightRange: session.visibility.sightRange,
        rainAvailable: session.environment.rainAvailable,
        // Whatever the tracked aircraft is doing, in its own terms: an
        // interceptor has an AI state, a contact on a strike is somewhere
        // along its route, and somebody else's model at a fly-in is either
        // working somebody's paper, working the line, going round, or on its
        // way in.
        targetAiState:
          enemy?.state ??
          (transit
            ? `TRANSIT ${transit.waypoint}/${transit.waypointCount}`
            : null) ??
          (flyer
            ? flyer.wounded
              ? "GOING IN"
              : flyer.quarry
                ? `CUTTING ${flyer.quarry} @ ${(flyer.aimFraction * 100).toFixed(0)}%`
                : flyer.passing
                  ? "ON THE LINE"
                  : `CIRCUIT ${flyer.band.toFixed(0)} m`
            : null),
        targetGate: racer
          ? `${Math.min(racer.gate + 1, session.course?.gateCount ?? 0)}/${
              session.course?.gateCount ?? 0
            } · ${
              Number.isFinite(racer.rangeToGate)
                ? `${racer.rangeToGate.toFixed(0)} m`
                : "done"
            }`
          : null,
        targetAiConfidence: enemy?.confidence ?? 0,
        targetAiAvoiding: enemy?.avoiding ?? false,
        targetAiClearance: enemy?.clearanceAhead ?? Number.POSITIVE_INFINITY,
        missionTime: session.simulation.time,
        angleOfAttack: player ? (player.angleOfAttack * 180) / Math.PI : 0,
        sideslip: player ? (player.sideslip * 180) / Math.PI : 0,
        loadFactor: player?.loadFactor ?? 0,
        originLatitude: session.origin.latitude,
        originLongitude: session.origin.longitude,
        originHeight: session.origin.terrainHeight,
        localX: player?.position.x ?? 0,
        localY: player?.position.y ?? 0,
        localZ: player?.position.z ?? 0,
      });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session, enabled, hertz]);

  return snapshot;
}
