"use client";

/**
 * The in-flight screen.
 *
 * Owns the Cesium boundary, the loading screen, the HUD and the pause menu, and
 * routes UI keys. High-frequency work stays inside `FlightSession`; this
 * component re-renders only on screen-level changes and on the HUD's own slow
 * poll.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FlightSession } from "@/lib/cesium/flightSession";
import { CesiumConfigurationError } from "@/lib/cesium/viewer";
import { PhotorealisticUnavailableError, WORLD_DETAIL } from "@/lib/cesium/scenery";
import type { MissionEvent, MissionStatus } from "@/sim/mission";
import { isOpenFlight } from "@/sim/mission";
import { MISSION_MODE, useGameStore } from "@/state/gameStore";
import { useSettingsStore, readSettings } from "@/state/settingsStore";
import { useKeyBindingStore } from "@/state/keyBindingStore";
import type { KeyAction } from "@/sim/input/keyBindings";
import { KEY_ACTION } from "@/sim/input/keyBindings";
import { OSD_ELEMENT, OSD_VIEW, osdLayoutFor } from "@/sim/hud/osdLayout";
import { CAMERA_MODE } from "@/lib/cesium/cameraRig";
import { ratesFor } from "@/sim/flight/uav";

import { LoadingScreen } from "@/components/screens/LoadingScreen";
import { PauseMenu } from "@/components/screens/PauseMenu";
import { ConfigurationError } from "@/components/screens/ConfigurationError";
import { SceneryUnavailable } from "@/components/screens/SceneryUnavailable";
import { TelemetryPanel } from "@/components/hud/TelemetryPanel";
import { HudLayer } from "@/components/hud/HudLayer";
import { VideoLinkLayer } from "@/components/hud/VideoLinkLayer";
import { DebugOverlay } from "@/components/hud/DebugOverlay";
import { useDebugSnapshot, useTelemetry } from "./useTelemetry";

// Cesium is browser-only: this is the SSR isolation boundary.
const CesiumStage = dynamic(() => import("./CesiumStage"), {
  ssr: false,
});

export function FlightView() {
  const mission = useGameStore((state) => state.mission);
  const flightKey = useGameStore((state) => state.flightKey);
  const loadingPhase = useGameStore((state) => state.loadingPhase);
  const loadingProgress = useGameStore((state) => state.loadingProgress);
  const loadingDetail = useGameStore((state) => state.loadingDetail);
  const ready = useGameStore((state) => state.ready);
  const paused = useGameStore((state) => state.paused);
  const debugVisible = useGameStore((state) => state.debugVisible);
  const error = useGameStore((state) => state.error);
  const setLoading = useGameStore((state) => state.setLoading);
  const setReady = useGameStore((state) => state.setReady);
  const setPaused = useGameStore((state) => state.setPaused);
  const togglePaused = useGameStore((state) => state.togglePaused);
  const toggleDebug = useGameStore((state) => state.toggleDebug);
  const setError = useGameStore((state) => state.setError);
  const showDebrief = useGameStore((state) => state.showDebrief);

  const showOsd = useSettingsStore((state) => state.showOsd);
  const osdLayout = useSettingsStore((state) => state.osdLayout);
  const minimapOrientation = useSettingsStore(
    (state) => state.minimapOrientation,
  );
  const minimapRangeMetres = useSettingsStore(
    (state) => state.minimapRangeMetres,
  );
  const toggleOsdElement = useSettingsStore((state) => state.toggleOsdElement);
  // Settings that take effect mid-flight, subscribed individually so an
  // unrelated setting change does not push work into the session.
  const fpvFieldOfView = useSettingsStore((state) => state.fpvFieldOfView);
  const cameraShake = useSettingsStore((state) => state.cameraShake);
  const chaseDistance = useSettingsStore((state) => state.chaseDistance);
  const chaseHeight = useSettingsStore((state) => state.chaseHeight);
  const flightSensitivity = useSettingsStore((state) => state.flightSensitivity);
  const controllerSensitivity = useSettingsStore(
    (state) => state.controllerSensitivity,
  );
  const flightModeSettings = useSettingsStore((state) => state.flightModes);
  const uavSettings = useSettingsStore((state) => state.uav);
  const audioEnabled = useSettingsStore((state) => state.audioEnabled);
  const audioVolume = useSettingsStore((state) => state.audioVolume);
  const showClouds = useSettingsStore((state) => state.showClouds);
  const volumetricClouds = useSettingsStore((state) => state.volumetricClouds);
  const showRain = useSettingsStore((state) => state.showRain);
  const weatherEffects = useSettingsStore((state) => state.weatherEffects);
  const keyBindings = useKeyBindingStore((state) => state.bindings);
  const [session, setSession] = useState<FlightSession | null>(null);
  const sessionRef = useRef<FlightSession | null>(null);

  // Chosen before the flight and changeable from the pause menu, so they are
  // read off the mission rather than captured when the session was built.
  const weather = mission?.weather;
  const cloudCover = mission?.cloudCover;
  const sky = mission?.sky;
  const timeOfDay = mission?.timeOfDay;
  const clock = mission?.clock;

  const telemetry = useTelemetry(ready ? session : null, 10);
  const debug = useDebugSnapshot(ready ? session : null, debugVisible, 5);

  // --- Session wiring ------------------------------------------------------

  const handleSession = useCallback(
    (started: FlightSession) => {
      sessionRef.current = started;
      setSession(started);
      setReady(true);
    },
    [setReady],
  );

  const handleError = useCallback(
    (raised: unknown) => {
      // The pilot asked to fly the photogrammetry. Substituting a different
      // world for it is their call to make, not this component's, so the
      // failure gets a screen with that choice on it.
      if (raised instanceof PhotorealisticUnavailableError) {
        setError({
          kind: "scenery",
          title: "The photorealistic mesh could not be loaded",
          detail: raised.message,
        });
        console.warn(`[fpv] ${raised.message}`);
        return;
      }
      if (raised instanceof CesiumConfigurationError) {
        setError({
          kind: "config",
          title:
            raised.kind === "missing-token"
              ? "Cesium ion access token is not configured"
              : raised.kind === "webgl-unavailable"
                ? "WebGL is unavailable"
                : "Cesium ion could not be reached",
          detail:
            raised.kind === "missing-token"
              ? "The simulator streams the real Earth from Cesium ion, and this installation has no access token. Without one there is no terrain and no imagery to fly over."
              : raised.message,
          tokenSetup: raised.kind !== "webgl-unavailable",
        });
        return;
      }
      const message =
        raised instanceof Error ? raised.message : String(raised);
      setError({
        kind: "runtime",
        title: "The flight could not be started",
        detail: message,
      });
      console.error("[fpv] flight session failed", raised);
    },
    [setError],
  );

  const [relaunch, setRelaunch] = useState<{
    reason: string;
    remaining: number;
    /** Contacts the airframe took with it, which is what the loss was for. */
    kills: number;
  } | null>(null);
  /**
   * True once the airframe has been lost and the loss has been presented.
   *
   * Read when the mission ends, to know whether the impact has already been
   * given its moment on screen or is still to come.
   */
  const airframeLostRef = useRef(false);

  /**
   * The mission runner decides what a loss means; this only presents it.
   *
   * A short pause before the debrief lets the impact play out rather than
   * cutting straight to a scoreboard.
   */
  const handleMissionEvent = useCallback(
    (event: MissionEvent, status: MissionStatus) => {
      if (event.type === "AIRFRAME_LOST") {
        airframeLostRef.current = true;
        setRelaunch({
          reason: event.reason,
          remaining: status.interceptorsRemaining,
          kills: event.kills,
        });
        return;
      }
      if (event.type === "RELAUNCH") {
        airframeLostRef.current = false;
        setRelaunch(null);
        return;
      }
      // A gate is drawn by the HUD off the session's own state, so there is
      // nothing for a screen-level handler to do with it. The same goes for a
      // festival wave and the recall that precedes it: the session puts the
      // aircraft there, or takes them home, and the OSD counts them — and for
      // a streamer cut, which moves a board the OSD is already reading.
      if (
        event.type === "GATE" ||
        event.type === "FESTIVAL_WAVE" ||
        event.type === "FESTIVAL_RECALL" ||
        event.type === "STREAMER_CUT"
      ) {
        return;
      }

      const reason = event.reason;
      // A day at a festival that ended with the pilot's own wing in the field
      // has already been held open on the ground by the mission runner, and the
      // wreck has been on screen for the whole of it. Holding it again here
      // would only be a pilot with nothing to fly waiting twice over.
      const wreckSeen =
        event.type === "FAILED" &&
        status.festival !== undefined &&
        airframeLostRef.current;
      window.setTimeout(
        () => {
          const active = sessionRef.current;
          if (!active) return;
          setRelaunch(null);
          showDebrief({ ...active.simulation.statistics }, status, reason);
        },
        event.type === "COMPLETE" ? 900 : wreckSeen ? 300 : 1700,
      );
    },
    [showDebrief],
  );


  const handleHotkey = useCallback(
    (action: KeyAction) => {
      if (action === KEY_ACTION.Pause) togglePaused();
      else if (action === KEY_ACTION.Debug) toggleDebug();
      else if (action === KEY_ACTION.Minimap) toggleOsdElement(OSD_ELEMENT.Minimap);
      // The mode switches are acted on inside the session, where the flight
      // controller lives; nothing at screen level has to know about them.
    },
    [toggleDebug, togglePaused, toggleOsdElement],
  );

  // --- Pause propagation ---------------------------------------------------

  useEffect(() => {
    session?.setPaused(paused);
  }, [session, paused]);

  // Live settings that can change mid-flight without a restart.
  useEffect(() => {
    if (!session) return;
    session.setCameraSettings({
      fpvFieldOfView,
      cameraShake,
      chaseDistance,
      chaseHeight,
    });
    session.setFlightSensitivity(flightSensitivity);
    session.setControllerSensitivity(controllerSensitivity);
    session.setFlightModeSettings(flightModeSettings);
    // The airframe cannot be swapped in the air, so only the rates of the one
    // being flown are pushed across — and those are read off the aircraft the
    // flight started on, not off whichever is selected in the hangar now.
    session.setControlRates(ratesFor(uavSettings, session.playerUav.id));
    session.setAudioVolume(audioEnabled ? audioVolume : 0);
  }, [
    session,
    fpvFieldOfView,
    cameraShake,
    chaseDistance,
    chaseHeight,
    flightSensitivity,
    controllerSensitivity,
    flightModeSettings,
    uavSettings,
    audioEnabled,
    audioVolume,
  ]);

  // Rebinding a key takes effect on the aircraft immediately, mid-flight.
  useEffect(() => {
    session?.setKeyBindings(keyBindings);
  }, [session, keyBindings]);

  useEffect(() => {
    session?.setEnvironmentToggles({
      clouds: showClouds,
      volumetricClouds,
      rain: showRain,
      effects: weatherEffects,
    });
  }, [session, showClouds, volumetricClouds, showRain, weatherEffects]);

  // The sky is part of the mission, but changing it is not worth a restart: the
  // pause menu edits the mission and the session re-grades the world in place.
  useEffect(() => {
    if (!session || !weather) return;
    // One call, because picking a weather carries its own cloud cover with it:
    // applied separately, the flight would briefly be in the new weather under
    // the old sky.
    session.setSky(weather, cloudCover, sky);
  }, [session, weather, cloudCover, sky]);

  useEffect(() => {
    if (!session || !timeOfDay) return;
    // One call for the same reason the sky takes one: the date and the time of
    // day are a single setting, and applied separately the flight would swing
    // through an instant nobody chose.
    session.setTimeOfDay(timeOfDay, clock);
  }, [session, timeOfDay, clock]);

  // Pause when the tab loses focus so the aircraft is not flown blind.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) setPaused(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [setPaused]);

  // Before the session exists the keyboard listener lives here, so the pause
  // key still works while the world is still loading.
  useEffect(() => {
    if (session) return;
    const pauseKey = keyBindings.pause;
    if (!pauseKey) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === pauseKey) {
        event.preventDefault();
        togglePaused();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session, togglePaused, keyBindings.pause]);

  useEffect(() => {
    return () => {
      sessionRef.current = null;
    };
  }, [flightKey]);

  if (!mission) return null;
  const settings = readSettings();

  // Which display the flight is being watched on. Only the aircraft's own
  // camera is a video feed with an OSD burnt into it; from the field, or from
  // behind the aircraft, the picture is somebody looking at a model and the
  // numbers belong at the edges of the monitor instead.
  const cameraMode = session?.cameraMode ?? CAMERA_MODE.Fpv;
  const goggles = cameraMode === CAMERA_MODE.Fpv;
  const layout = osdLayoutFor(
    osdLayout,
    goggles ? OSD_VIEW.Goggles : OSD_VIEW.Field,
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-void">
      {!error ? (
        <CesiumStage
          key={flightKey}
          mission={mission}
          settings={settings}
          keyBindings={keyBindings}
          onSession={handleSession}
          onPhase={setLoading}
          onHotkey={handleHotkey}
          onMissionEvent={handleMissionEvent}
          onError={handleError}
        />
      ) : null}

      {ready && session && !error ? (
        <HudLayer
          session={session}
          showOsd={showOsd}
          layout={layout}
          minimapOrientation={minimapOrientation}
          minimapRangeMetres={minimapRangeMetres}
        />
      ) : null}

      {ready && showOsd && !error ? (
        <TelemetryPanel
          telemetry={telemetry}
          layout={layout}
          view={goggles ? OSD_VIEW.Goggles : OSD_VIEW.Field}
          flightTime={session?.simulation.statistics.flightTime ?? 0}
          fps={session?.stats.fps ?? 0}
          cameraMode={cameraMode}
          craftName={session?.playerUav.config.name ?? ""}
          enemyCount={session?.simulation.enemyCount ?? 0}
          hasTarget={Boolean(session?.simulation.target)}
          interceptors={
            // Going flying is one airframe and no reserve, so there is no
            // count worth putting on the instruments.
            isOpenFlight(mission.mode)
              ? undefined
              : session?.mission.status.interceptorsRemaining
          }
          formation={session?.mission.status.formation}
          race={session?.mission.status.race}
          festival={session?.mission.status.festival}
          formationSlot={session?.formationSlot?.label}
          flightSize={
            mission.mode === MISSION_MODE.Formation
              ? session?.simulation.formationCount
              : undefined
          }
          manoeuvre={session?.formationManoeuvreLabel ?? undefined}
        />
      ) : null}

      {/* Above the instruments on purpose: the OSD comes back down the same
          video channel the picture does, so the static takes it too. */}
      {ready && session && !error ? <VideoLinkLayer session={session} /> : null}

      {ready && debug && !error ? (
        <DebugOverlay debug={debug} telemetry={telemetry} />
      ) : null}

      {!ready && !error ? (
        <LoadingScreen
          phase={loadingPhase}
          progress={loadingProgress}
          detail={loadingDetail}
          locationName={mission.locationName}
          photorealistic={settings.worldDetail === WORLD_DETAIL.Photorealistic}
        />
      ) : null}

      {relaunch && ready && !error ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-void/55 backdrop-blur-[2px]">
          {/* An interception is flown with the charge on the wing: the wing is
              spent on the contact, and a wing spent that way is the mission
              working. It is told in green and headed with the kill, not with
              the loss — only an airframe thrown away is a red panel. */}
          <div
            className={`border bg-panel/90 px-8 py-6 text-center ${
              relaunch.kills > 0 ? "border-lime/50" : "border-danger/50"
            }`}
          >
            <p
              className={`text-2xs uppercase tracking-[0.4em] ${
                relaunch.kills > 0 ? "text-lime" : "text-danger"
              }`}
            >
              {relaunch.kills > 0
                ? relaunch.kills === 1
                  ? "Contact destroyed"
                  : `${relaunch.kills} contacts destroyed`
                : "Airframe lost"}
            </p>
            <p className="mt-2 text-sm text-osd">{relaunch.reason}</p>
            <p className="mt-4 text-2xs uppercase tracking-[0.2em] text-osd-dim">
              {/* At a festival nobody counts airframes — there is always
                  another one in the car — but there is no putting it up in the
                  middle of somebody else's slot, so the wing that went in is
                  the end of the day rather than a wait for the next wave. */}
              {!Number.isFinite(relaunch.remaining)
                ? "That is your day"
                : relaunch.remaining > 0
                  ? `Launching replacement · ${relaunch.remaining} airframe${
                      relaunch.remaining === 1 ? "" : "s"
                    } left`
                  : "No airframes left"}
            </p>
          </div>
        </div>
      ) : null}

      {paused && ready && !error ? <PauseMenu /> : null}

      {error ? (
        error.kind === "scenery" ? (
          <SceneryUnavailable title={error.title} detail={error.detail} />
        ) : (
          <ConfigurationError
            title={error.title}
            detail={error.detail}
            tokenSetup={error.tokenSetup ?? false}
          />
        )
      ) : null}
    </div>
  );
}
