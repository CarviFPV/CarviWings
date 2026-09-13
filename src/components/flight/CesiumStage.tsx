"use client";

/**
 * The Cesium mount point.
 *
 * This module — and everything it imports — only ever runs in the browser: it
 * is reached exclusively through a `dynamic(..., { ssr: false })` boundary in
 * `FlightView`. `window`, `document`, WebGL and `Cesium.Viewer` are therefore
 * never touched during a server render.
 */

import { useEffect, useRef } from "react";

import { FlightSession } from "@/lib/cesium/flightSession";
import type { LoadingPhase } from "@/lib/cesium/flightSession";
import { resolveGraphicsQuality } from "@/lib/gpuProbe";
import type { MissionEvent, MissionStatus } from "@/sim/mission";
import type { Settings } from "@/state/settingsStore";
import type { MissionConfiguration } from "@/state/gameStore";
import type { KeyAction, KeyBindings } from "@/sim/input/keyBindings";
import { activeRates, liveryFor, loadoutFor } from "@/sim/flight/uav";
import {
  profileForDevice,
  useControllerStore,
} from "@/state/controllerStore";

export interface CesiumStageProps {
  mission: MissionConfiguration;
  settings: Settings;
  keyBindings: KeyBindings;
  onSession: (session: FlightSession) => void;
  onPhase: (phase: LoadingPhase, progress: number, detail?: string) => void;
  onHotkey: (action: KeyAction) => void;
  onMissionEvent: (event: MissionEvent, status: MissionStatus) => void;
  onError: (error: unknown) => void;
}

export default function CesiumStage({
  mission,
  settings,
  keyBindings,
  onSession,
  onPhase,
  onHotkey,
  onMissionEvent,
  onError,
}: CesiumStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Callbacks are read through a ref so a re-render never restarts the flight.
  const handlersRef = useRef({
    onSession,
    onPhase,
    onHotkey,
    onMissionEvent,
    onError,
  });
  handlersRef.current = {
    onSession,
    onPhase,
    onHotkey,
    onMissionEvent,
    onError,
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let session: FlightSession | null = null;
    let cancelled = false;

    void FlightSession.start(
      container,
      {
        name: mission.locationName,
        latitude: mission.latitude,
        longitude: mission.longitude,
        missionRadius: mission.missionRadius,
        mode: mission.mode,
        enemyCount: mission.enemyCount,
        difficulty: mission.difficulty,
        combat: mission.combat,
        formation: mission.formation,
        race: mission.race,
        festival: mission.festival,
        strike: mission.strike,
        opposition: mission.opposition,
        vtxPowerMw: mission.vtxPowerMw,
        weather: mission.weather,
        cloudCover: mission.cloudCover,
        sky: mission.sky,
        timeOfDay: mission.timeOfDay,
        clock: mission.clock,
        seed: mission.seed,
        // `auto` becomes a real preset here, in the browser, at the moment the
        // flight is built — the one place the GPU can actually be asked about.
        quality: resolveGraphicsQuality(settings.graphicsQuality),
        worldDetail: settings.worldDetail,
        viewDistanceKm: settings.viewDistanceKm,
        spawnAltitudeAgl: mission.spawnAltitudeAgl,
        startHeadingDeg: mission.startHeadingDeg,
        flightSensitivity: settings.flightSensitivity,
        flightModes: settings.flightModes,
        uavId: settings.uav.active,
        rates: activeRates(settings.uav),
        power: loadoutFor(settings.uav, settings.uav.active),
        livery: liveryFor(settings.uav, settings.uav.active),
        keyBindings,
        controllerSensitivity: settings.controllerSensitivity,
        audioEnabled: settings.audioEnabled,
        audioVolume: settings.audioVolume,
        // Read at the moment a controller appears rather than captured now:
        // a device plugged in mid-flight gets its own stored mapping.
        resolveControllerProfile: (device) =>
          profileForDevice(device, useControllerStore.getState().profiles),
        showClouds: settings.showClouds,
        volumetricClouds: settings.volumetricClouds,
        showRain: settings.showRain,
        weatherEffects: settings.weatherEffects,
        cameraSettings: {
          fpvFieldOfView: settings.fpvFieldOfView,
          cameraShake: settings.cameraShake,
          chaseDistance: settings.chaseDistance,
          chaseHeight: settings.chaseHeight,
        },
      },
      {
        onPhase: (phase, progress, detail) =>
          handlersRef.current.onPhase(phase, progress, detail),
        onHotkey: (action) => handlersRef.current.onHotkey(action),
        onMissionEvent: (event, status) =>
          handlersRef.current.onMissionEvent(event, status),
      },
    )
      .then((started) => {
        if (cancelled) {
          started.dispose();
          return;
        }
        session = started;
        handlersRef.current.onSession(started);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        handlersRef.current.onError(error);
      });

    return () => {
      cancelled = true;
      session?.dispose();
      session = null;
    };
    // The flight is configured once at mount; changing settings mid-flight is
    // applied through the session, and changing the mission remounts the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="absolute inset-0 bg-void" />;
}
