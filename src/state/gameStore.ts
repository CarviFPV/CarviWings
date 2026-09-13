"use client";

/**
 * Screen flow and mission configuration.
 *
 * Only low-frequency state lives here. Nothing in the flight loop writes to
 * this store — telemetry is polled from the session at HUD rate instead, so a
 * running flight never triggers a React render.
 */

import { create } from "zustand";
import type { LocationPreset } from "@/sim/geo/locations";
import { DEFAULT_MISSION_RADIUS, LOCATION_PRESETS } from "@/sim/geo/locations";
import {
  DEFAULT_START_HEADING_DEG,
  SPAWN_ALTITUDE_LIMITS,
} from "@/sim/geo/placePicker";
import type { LoadingPhase } from "@/lib/cesium/flightSession";
import { LOADING_LABELS } from "@/lib/cesium/flightSession";
import type { FlightStatistics } from "@/sim/flight/telemetry";
import type {
  MissionClock,
  TimeOfDay,
  WeatherState,
} from "@/sim/environment/types";
import {
  TIME_OF_DAY,
  WEATHER,
  WEATHER_PROFILES,
  nearestPreset,
} from "@/sim/environment/types";
import { DIFFICULTY } from "@/sim/ai/types";
import type { MissionMode, MissionSettings, MissionStatus } from "@/sim/mission";
import {
  DEFAULT_FESTIVAL,
  DEFAULT_FORMATION,
  DEFAULT_OPPOSITION,
  DEFAULT_RACE,
  DEFAULT_STRIKE,
  DEFAULT_VTX_POWER_MW,
  MISSION_MODE,
} from "@/sim/mission";
import { generateSeed } from "@/sim/math/rng";
import { usePlayerStore } from "./playerStore";

export const SCREEN = {
  Menu: "MENU",
  /** The list of missions, which is everything that is not just going flying. */
  Missions: "MISSIONS",
  Controls: "CONTROLS",
  Controller: "CONTROLLER",
  /** The workbench: the airframe, what is in it, and what it is painted. */
  Aircraft: "AIRCRAFT",
  Settings: "SETTINGS",
  /** The roster: who is flying, and what they have flown. */
  Pilot: "PILOT",
  World: "WORLD",
  Setup: "SETUP",
  Flying: "FLYING",
  Debrief: "DEBRIEF",
} as const;

export type Screen = (typeof SCREEN)[keyof typeof SCREEN];

export type { MissionMode, MissionSettings } from "@/sim/mission";
export { MISSION_MODE } from "@/sim/mission";

/** A mission the player has configured but not yet flown. */
export type MissionConfiguration = MissionSettings;

/** Where the player put the marker on the globe, and how high above it. */
export interface PendingPlace {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  /** Ground elevation in metres, once the globe has sampled the terrain. */
  readonly terrainHeight: number | null;
  readonly spawnAltitudeAgl: number;
  /** Which way the flight faces when it begins, degrees from north. */
  readonly startHeadingDeg: number;
}

export interface AppError {
  readonly title: string;
  readonly detail: string;
  readonly kind: "config" | "runtime" | "scenery";
  /**
   * Whether the ion token is worth offering as the fix on the error screen.
   *
   * A missing token, or an ion that turned the request down, is answered by
   * entering a different token; a browser without WebGL is not, and a field
   * for one there would only send the pilot after the wrong problem.
   */
  readonly tokenSetup?: boolean;
}

interface GameStore {
  screen: Screen;
  mission: MissionConfiguration | null;
  loadingPhase: LoadingPhase;
  loadingProgress: number;
  loadingLabel: string;
  /** A line about what a slow loading phase is doing; null when it is silent. */
  loadingDetail: string | null;
  ready: boolean;
  paused: boolean;
  debugVisible: boolean;
  error: AppError | null;
  debrief: {
    statistics: FlightStatistics;
    status: MissionStatus;
    reason: string;
  } | null;
  /** Bumped to force a full remount of the flight view on restart. */
  flightKey: number;
  /** Which mode the player chose on the main menu or on the globe. */
  pendingMode: MissionMode;
  /** The start point chosen on the globe, kept between visits to it. */
  pendingPlace: PendingPlace | null;
  /**
   * Where the aircraft builder was opened from.
   *
   * It is reached from the main menu and from a mission being set up, and both
   * of them are somewhere the pilot was in the middle of something: the way
   * out has to go back there rather than always to the menu.
   */
  aircraftReturn: Screen;

  goto(screen: Screen): void;
  openWorld(mode: MissionMode): void;
  /** Opens the workbench, remembering the screen to come back to. */
  openAircraft(from: Screen): void;
  choosePlace(place: PendingPlace, mode: MissionMode): void;
  startMission(mission: MissionConfiguration): void;
  restartMission(): void;
  /** The sky being flown, changed from the setup screen or the pause menu. */
  setSky(sky: WeatherState): void;
  /**
   * The light, changed mid-flight.
   *
   * The clock travels with the time of day rather than being set on its own:
   * they are one setting, and applying them separately would swing the sun
   * through an instant nobody asked for on the way.
   */
  setTimeOfDay(timeOfDay: TimeOfDay, clock?: MissionClock): void;
  setLoading(phase: LoadingPhase, progress: number, detail?: string): void;
  setReady(ready: boolean): void;
  setPaused(paused: boolean): void;
  togglePaused(): void;
  toggleDebug(): void;
  setError(error: AppError | null): void;
  showDebrief(
    statistics: FlightStatistics,
    status: MissionStatus,
    reason: string,
  ): void;
  exitToMenu(): void;
}

const defaultPreset = LOCATION_PRESETS[0] as LocationPreset;

export const DEFAULT_MISSION: MissionConfiguration = {
  mode: MISSION_MODE.FreeFlight,
  locationName: defaultPreset.name,
  latitude: defaultPreset.latitude,
  longitude: defaultPreset.longitude,
  missionRadius: DEFAULT_MISSION_RADIUS,
  spawnAltitudeAgl: SPAWN_ALTITUDE_LIMITS.default,
  startHeadingDeg: DEFAULT_START_HEADING_DEG,
  weather: WEATHER.Clear,
  cloudCover: WEATHER_PROFILES[WEATHER.Clear].cloudCoverage,
  timeOfDay: TIME_OF_DAY.Day,
  enemyCount: 5,
  opposition: DEFAULT_OPPOSITION,
  difficulty: DIFFICULTY.Normal,
  combat: true,
  formation: DEFAULT_FORMATION,
  race: DEFAULT_RACE,
  festival: DEFAULT_FESTIVAL,
  strike: DEFAULT_STRIKE,
  vtxPowerMw: DEFAULT_VTX_POWER_MW,
  seed: generateSeed(),
};

export const useGameStore = create<GameStore>()((set, get) => ({
  screen: SCREEN.Menu,
  mission: null,
  loadingPhase: "starting",
  loadingProgress: 0,
  loadingLabel: LOADING_LABELS.starting,
  loadingDetail: null,
  ready: false,
  paused: false,
  debugVisible: false,
  error: null,
  debrief: null,
  flightKey: 0,
  pendingMode: MISSION_MODE.FreeFlight,
  pendingPlace: null,
  aircraftReturn: SCREEN.Menu,

  goto: (screen) => set({ screen }),

  openWorld: (mode) => set({ pendingMode: mode, screen: SCREEN.World }),

  openAircraft: (from) =>
    set({ aircraftReturn: from, screen: SCREEN.Aircraft }),

  choosePlace: (place, mode) =>
    set({ pendingPlace: place, pendingMode: mode, screen: SCREEN.Setup }),

  startMission: (mission) =>
    set((state) => ({
      mission,
      screen: SCREEN.Flying,
      ready: false,
      paused: false,
      error: null,
      debrief: null,
      loadingPhase: "starting",
      loadingProgress: 0,
      loadingLabel: LOADING_LABELS.starting,
      loadingDetail: null,
      flightKey: state.flightKey + 1,
    })),

  restartMission: () => {
    const mission = get().mission;
    if (!mission) return;
    get().startMission(mission);
  },

  // The sky can be changed from the pause menu, and the mission is where the
  // flight reads it from — so it is edited in place rather than restarted. A
  // restart afterwards keeps the weather the pilot is actually flying in.
  //
  // It brings the logbook's one-word summary with it: the debrief still has to
  // be able to say what kind of day it was, whatever the pilot actually built,
  // fetched or drew. The separate cover figure goes, because a sky already says
  // how much cloud is in it by having the decks it has.
  setSky: (sky) =>
    set((state) =>
      state.mission
        ? {
            mission: {
              ...state.mission,
              sky,
              weather: nearestPreset(sky),
              cloudCover: undefined,
            },
          }
        : {},
    ),

  setTimeOfDay: (timeOfDay, clock) =>
    set((state) =>
      state.mission &&
      (state.mission.timeOfDay !== timeOfDay || state.mission.clock !== clock)
        ? { mission: { ...state.mission, timeOfDay, clock } }
        : {},
    ),

  setLoading: (phase, progress, detail) =>
    set({
      loadingPhase: phase,
      loadingProgress: progress,
      loadingLabel: LOADING_LABELS[phase],
      loadingDetail: detail ?? null,
    }),

  setReady: (ready) => set({ ready }),
  setPaused: (paused) => set({ paused }),
  togglePaused: () => set((state) => ({ paused: !state.paused })),
  toggleDebug: () => set((state) => ({ debugVisible: !state.debugVisible })),
  setError: (error) => set({ error }),

  // The debrief is the one place a flight is known to be over, and it is
  // reached exactly once per flight — which makes it the only honest moment to
  // write the logbook. Doing it from the debrief screen instead would log a
  // flight again every time the screen remounted.
  showDebrief: (statistics, status, reason) => {
    const mission = get().mission;
    if (mission) {
      usePlayerStore.getState().logFlight(mission, statistics, status);
    }
    set({
      screen: SCREEN.Debrief,
      debrief: { statistics, status, reason },
      paused: false,
    });
  },

  exitToMenu: () =>
    set({
      screen: SCREEN.Menu,
      mission: null,
      ready: false,
      paused: false,
      debrief: null,
      error: null,
    }),
}));
