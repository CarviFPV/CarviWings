"use client";

/**
 * The world map's Cesium mount point.
 *
 * Reached only through a `dynamic(..., { ssr: false })` boundary in
 * `WorldView`, so Cesium, WebGL and `window` are never touched in a server
 * render. The globe is brought up once and handed back to the screen above,
 * which drives it: nothing here re-creates a viewer because a prop changed.
 */

import { useEffect, useRef } from "react";

import { WorldMap, type WorldMapPick } from "@/lib/cesium/worldMap";
import type { GraphicsQualityChoice } from "@/lib/cesium/quality";
import { resolveGraphicsQuality } from "@/lib/gpuProbe";
import type { GeoPoint } from "@/sim/geo/placePicker";

/**
 * `quality`, `initial`, `spawnAltitudeAgl` and `startHeadingDeg` are read once,
 * when the globe is built. Everything after that is driven through the
 * `WorldMap` handed back by `onMap` — changing a prop does not rebuild a viewer.
 */
export interface WorldStageProps {
  /** A preset, or `auto`; resolved below, where WebGL exists to be asked. */
  quality: GraphicsQualityChoice;
  /** Where to open the camera: the last chosen place, or the whole globe. */
  initial: GeoPoint | null;
  spawnAltitudeAgl: number;
  /** Which way the marker's needle points, degrees from north. */
  startHeadingDeg: number;
  onMap: (map: WorldMap) => void;
  onPick: (pick: WorldMapPick) => void;
  onError: (error: unknown) => void;
}

export default function WorldStage({
  quality,
  initial,
  spawnAltitudeAgl,
  startHeadingDeg,
  onMap,
  onPick,
  onError,
}: WorldStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Read through a ref so a re-render never rebuilds the globe.
  const handlersRef = useRef({ onMap, onPick, onError });
  handlersRef.current = { onMap, onPick, onError };
  const startRef = useRef({
    quality,
    initial,
    spawnAltitudeAgl,
    startHeadingDeg,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: WorldMap | null = null;
    let cancelled = false;
    const start = startRef.current;

    void WorldMap.start(
      container,
      {
        quality: resolveGraphicsQuality(start.quality),
        initial: start.initial,
      },
      { onPick: (pick) => handlersRef.current.onPick(pick) },
    )
      .then((started) => {
        if (cancelled) {
          started.destroy();
          return;
        }
        map = started;
        started.setSpawnAltitude(start.spawnAltitudeAgl);
        started.setStartHeading(start.startHeadingDeg);
        handlersRef.current.onMap(started);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        handlersRef.current.onError(error);
      });

    return () => {
      cancelled = true;
      map?.destroy();
      map = null;
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0 bg-void" />;
}
