"use client";

/**
 * Player settings, persisted to localStorage.
 *
 * Kept deliberately separate from mission state: settings outlive a flight,
 * mission configuration does not.
 *
 * These are one pilot's settings. Which storage key they are read from and
 * written to is set by the player store when a pilot takes over, and the load
 * itself is deferred until after mount so the server-rendered markup and the
 * first client render always agree.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GraphicsQualityChoice } from "@/lib/cesium/quality";
import {
  GRAPHICS_QUALITY_AUTO,
  isGraphicsQualityChoice,
} from "@/lib/cesium/quality";
import type { WeatherSourceChoice } from "@/sim/environment/types";
import { WEATHER_SOURCE, isWeatherSourceChoice } from "@/sim/environment/types";
import { WORLD_DETAIL, type WorldDetail } from "@/lib/cesium/scenery";
import type { MusicStationChoice } from "@/sim/audio/musicDirector";
import { MUSIC_AUTO, isMusicStationChoice } from "@/sim/audio/musicDirector";
import type { MinimapOrientation } from "@/sim/hud/minimapProjection";
import { MINIMAP_ORIENTATION } from "@/sim/hud/minimapProjection";
import type { OsdElementId, OsdLayout, OsdPlacement } from "@/sim/hud/osdLayout";
import {
  DEFAULT_OSD_LAYOUT,
  OSD_ELEMENT,
  normaliseOsdLayout,
  osdPlacement,
  resetOsdElement,
  withOsdPlacement,
} from "@/sim/hud/osdLayout";
import type { FlightModeSettings, RthSettings } from "@/sim/flight/flightModes";
import {
  DEFAULT_FLIGHT_MODE_SETTINGS,
  normaliseFlightModeSettings,
} from "@/sim/flight/flightModes";
import type { ControlRates } from "@/sim/flight/rates";
import type { Livery } from "@/sim/flight/livery";
import type { UavSettings } from "@/sim/flight/uav";
import {
  DEFAULT_UAV_SETTINGS,
  normaliseUavSettings,
  ratesFor,
  uavOrDefault,
  withBattery,
  withLivery,
  withMotor,
} from "@/sim/flight/uav";
import type { AircraftBuild } from "@/sim/flight/builds";
import {
  applyBuild,
  buildFromSettings,
  buildsFull,
  createBuildId,
  findBuild,
  findStockBuild,
  isStockBuildName,
  normaliseBuildName,
  normaliseBuilds,
} from "@/sim/flight/builds";

export interface Settings {
  /**
   * A preset, or `auto` — the machine picking one from the GPU it has, once,
   * before the flight. Resolved to a real preset by `lib/gpuProbe.ts`.
   */
  graphicsQuality: GraphicsQualityChoice;
  /** 3D geometry laid over the terrain: none, buildings, or photogrammetry. */
  worldDetail: WorldDetail;
  /** Visible distance in kilometres; drives the camera far plane. */
  viewDistanceKm: number;
  /** FPV camera horizontal field of view in degrees. */
  fpvFieldOfView: number;
  /** 0 disables camera shake entirely. */
  cameraShake: number;
  /** Scales pitch/roll/yaw deflection from the keyboard, 0.1..1. */
  flightSensitivity: number;
  /** Scales every controller axis on top of its own calibration, 0.2..1.5. */
  controllerSensitivity: number;
  audioEnabled: boolean;
  /** Master volume, 0..1. */
  audioVolume: number;
  /**
   * Background music, streamed from the internet rather than generated.
   *
   * Under the master sound switch: off there is off here too. On, it plays
   * from the moment the application opens, which is the point of it.
   */
  musicEnabled: boolean;
  /** Music volume, 0..1, set against the aircraft rather than with it. */
  musicVolume: number;
  /** A station the pilot pinned, or `MUSIC_AUTO` to let the mission choose. */
  musicStation: MusicStationChoice;
  showClouds: boolean;
  /** Raymarched cloud you can fly into, rather than billboards. */
  volumetricClouds: boolean;
  showRain: boolean;
  weatherEffects: boolean;
  /**
   * How the pilot last said what the weather is.
   *
   * A preference rather than part of a mission: a pilot who flies the real
   * weather flies the real weather, and should not have to pick it again on
   * every setup screen. The sky it produces is the mission's; which of the
   * four ways of describing one the panel opens on is the pilot's.
   */
  weatherSource: WeatherSourceChoice;
  /** Master switch: off takes the whole display down, layout and all. */
  showOsd: boolean;
  /**
   * Where every readout sits and whether it is drawn.
   *
   * One layout for the pilot rather than one per aircraft: an OSD is how you
   * read a picture, and a pilot who has arranged theirs does not want it back
   * at the factory arrangement because they took a different wing out.
   */
  osdLayout: OsdLayout;
  minimapOrientation: MinimapOrientation;
  /** Ground distance from the minimap centre to its rim, in metres. */
  minimapRangeMetres: number;
  chaseDistance: number;
  chaseHeight: number;
  /**
   * How the wing's flight controller is set up.
   *
   * A property of the aircraft rather than of the view: the bank and pitch
   * limits the assisted modes fly to, and every parameter a return home is
   * flown by.
   */
  flightModes: FlightModeSettings;
  /**
   * Which aircraft is being flown, and how each one is set up.
   *
   * A model memory rather than a preference: the rates and the hardware stay
   * with the airframe they were fitted to, so a second UAV cannot inherit the
   * first one's tune or fly off with its battery.
   */
  uav: UavSettings;
  /**
   * The aircraft the pilot has set up and saved under a name.
   *
   * The hangar above holds one setup per airframe — the aircraft as it stands
   * right now. This is where a setup worth keeping is written down, so the
   * same X8 can be a long-range mapper and a sport wing without either of them
   * having to be rebuilt. Selecting one before a flight lays it back over the
   * hangar, which is where the flight reads the aircraft from.
   */
  builds: readonly AircraftBuild[];
}

export const DEFAULT_SETTINGS: Settings = {
  // Not a fixed preset: "High" was the delivered answer for every machine, and
  // it is the wrong one at both ends — too much for a laptop on integrated
  // graphics, and less than a desktop card would happily have drawn. The
  // machine is asked instead, and whatever it says can still be overruled on
  // the menu.
  graphicsQuality: GRAPHICS_QUALITY_AUTO,
  worldDetail: WORLD_DETAIL.Buildings,
  viewDistanceKm: 60,
  fpvFieldOfView: 100,
  cameraShake: 0.6,
  flightSensitivity: 1,
  controllerSensitivity: 1,
  audioEnabled: true,
  audioVolume: 0.7,
  musicEnabled: true,
  // Under the aircraft on purpose: the motor and the airframe rush are how a
  // wing is flown, and the music is what it is flown to.
  musicVolume: 0.45,
  musicStation: MUSIC_AUTO,
  showClouds: true,
  volumetricClouds: true,
  showRain: true,
  weatherEffects: true,
  // The real weather over the start point, so a first flight is flown in the
  // day it is actually being flown on.
  weatherSource: WEATHER_SOURCE.Live,
  showOsd: true,
  osdLayout: DEFAULT_OSD_LAYOUT,
  minimapOrientation: MINIMAP_ORIENTATION.HeadingUp,
  minimapRangeMetres: 2500,
  chaseDistance: 11,
  chaseHeight: 3.2,
  flightModes: DEFAULT_FLIGHT_MODE_SETTINGS,
  uav: DEFAULT_UAV_SETTINGS,
  // Nothing is delivered saved: the first aircraft in the list is one the
  // pilot set up and named themselves.
  builds: [],
};

interface SettingsStore extends Settings {
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  toggle(
    key:
      | "showOsd"
      | "showClouds"
      | "volumetricClouds"
      | "showRain"
      | "weatherEffects"
      | "audioEnabled"
      | "musicEnabled",
  ): void;
  /** Moves, realigns or switches one OSD element, leaving the rest alone. */
  setOsdPlacement(id: OsdElementId, change: Partial<OsdPlacement>): void;
  /** Switches one OSD element without having to know where it sits. */
  toggleOsdElement(id: OsdElementId): void;
  /** Puts one element back where it is delivered. */
  resetOsdElement(id: OsdElementId): void;
  /** Puts the whole display back to the delivered arrangement. */
  resetOsdLayout(): void;
  /** Changes part of the flight controller setup, leaving the rest alone. */
  setFlightModes(change: Partial<FlightModeSettings>): void;
  /** Changes part of the return-home setup, leaving the rest alone. */
  setRth(change: Partial<RthSettings>): void;
  /** Picks the aircraft to fly. Takes effect on the next flight. */
  selectUav(id: string): void;
  /** Retunes one aircraft's rates, leaving every other aircraft alone. */
  setUavRates(id: string, change: Partial<ControlRates>): void;
  /** Fits a motor, ESC and propeller combination to one aircraft. */
  setUavMotor(id: string, motorId: string): void;
  /** Fits a pack to one aircraft, or takes the range limit off it. */
  setUavBattery(id: string, batteryId: string): void;
  /** Repaints one aircraft, leaving every other aircraft alone. */
  setUavLivery(id: string, change: Partial<Livery>): void;
  /** Puts one aircraft back on the rates it is delivered with. */
  resetUavRates(id: string): void;
  /** Puts one aircraft back in the colours it is delivered in. */
  resetUavLivery(id: string): void;
  /** Saves the aircraft as it currently stands under a name of its own. */
  saveBuild(name: string): void;
  /** Writes the aircraft as it currently stands over a saved one. */
  updateBuild(id: string): void;
  renameBuild(id: string, name: string): void;
  deleteBuild(id: string): void;
  /**
   * Fits an aircraft from the hangar, ready to be flown.
   *
   * Takes a saved aircraft's identifier or a stock one: an airframe as
   * delivered is picked the same way a saved setup is, which is what makes
   * flying one a choice rather than a rebuild.
   */
  selectBuild(id: string): void;
  reset(): void;
}

/** Whether a persisted value still names a world detail the simulator offers. */
function isWorldDetail(value: unknown): value is WorldDetail {
  return (Object.values(WORLD_DETAIL) as string[]).includes(value as string);
}

/**
 * The layout a pilot who last flew before the OSD had one should get.
 *
 * Until version 8 the horizon, the target indicator and the minimap were three
 * booleans of their own. A pilot who switched one off meant it, so the
 * delivered layout is taken and those three elements are switched to whatever
 * the pilot had them on; everything else starts where it is delivered.
 */
function layoutFromHudToggles(persisted: unknown): OsdLayout {
  const stored = (persisted ?? {}) as Record<string, unknown>;
  const carried: readonly [string, OsdElementId][] = [
    ["showHorizon", OSD_ELEMENT.Horizon],
    ["showTargetIndicator", OSD_ELEMENT.TargetIndicator],
    ["showMinimap", OSD_ELEMENT.Minimap],
  ];

  let layout = DEFAULT_OSD_LAYOUT;
  for (const [key, id] of carried) {
    if (stored[key] === false) layout = withOsdPlacement(layout, id, { enabled: false });
  }
  return layout;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
      toggle: (key) => set((state) => ({ [key]: !state[key] }) as Partial<Settings>),
      setOsdPlacement: (id, change) =>
        set((state) => ({
          osdLayout: withOsdPlacement(state.osdLayout, id, change),
        })),
      toggleOsdElement: (id) =>
        set((state) => ({
          osdLayout: withOsdPlacement(state.osdLayout, id, {
            enabled: !osdPlacement(state.osdLayout, id).enabled,
          }),
        })),
      resetOsdElement: (id) =>
        set((state) => ({ osdLayout: resetOsdElement(state.osdLayout, id) })),
      resetOsdLayout: () => set({ osdLayout: DEFAULT_OSD_LAYOUT }),
      setFlightModes: (change) =>
        set((state) => ({ flightModes: { ...state.flightModes, ...change } })),
      setRth: (change) =>
        set((state) => ({
          flightModes: {
            ...state.flightModes,
            rth: { ...state.flightModes.rth, ...change },
          },
        })),
      selectUav: (id) =>
        set((state) => ({ uav: { ...state.uav, active: id } })),
      setUavRates: (id, change) =>
        set((state) => ({
          uav: {
            ...state.uav,
            rates: {
              ...state.uav.rates,
              [id]: { ...ratesFor(state.uav, id), ...change },
            },
          },
        })),
      setUavMotor: (id, motorId) =>
        set((state) => ({ uav: withMotor(state.uav, id, motorId) })),
      setUavBattery: (id, batteryId) =>
        set((state) => ({ uav: withBattery(state.uav, id, batteryId) })),
      setUavLivery: (id, change) =>
        set((state) => ({ uav: withLivery(state.uav, id, change) })),
      resetUavRates: (id) =>
        set((state) => ({
          uav: {
            ...state.uav,
            rates: {
              ...state.uav.rates,
              [id]: ratesFor(DEFAULT_UAV_SETTINGS, id),
            },
          },
        })),
      resetUavLivery: (id) =>
        set((state) => ({
          uav: withLivery(state.uav, id, uavOrDefault(id).defaultLivery),
        })),
      saveBuild: (name) =>
        set((state) => {
          const wanted = normaliseBuildName(name);
          if (wanted.length === 0 || buildsFull(state.builds)) return {};
          // An airframe's own name belongs to the airframe as delivered, which
          // is in the same list and cannot be written over.
          if (isStockBuildName(wanted)) return {};
          const id = createBuildId(state.builds.map((build) => build.id));
          return {
            builds: [...state.builds, buildFromSettings(state.uav, id, wanted)],
          };
        }),
      // Deliberately keeps the saved aircraft's own name and identifier: this
      // is the same aircraft after an afternoon of tuning, not a new one.
      updateBuild: (id) =>
        set((state) => {
          const saved = findBuild(state.builds, id);
          if (!saved) return {};
          const fitted = buildFromSettings(state.uav, id, saved.name);
          return {
            builds: state.builds.map((build) =>
              build.id === id ? fitted : build,
            ),
          };
        }),
      renameBuild: (id, name) =>
        set((state) => {
          const wanted = normaliseBuildName(name);
          if (wanted.length === 0 || isStockBuildName(wanted)) return {};
          return {
            builds: state.builds.map((build) =>
              build.id === id ? { ...build, name: wanted } : build,
            ),
          };
        }),
      // Only the entry in the list goes. What is on the workbench is the
      // aircraft the pilot is looking at, and deleting a bookmark is not a
      // reason to take the wing off the bench.
      deleteBuild: (id) =>
        set((state) => ({
          builds: state.builds.filter((build) => build.id !== id),
        })),
      // A stock aircraft is fitted exactly as a saved one is: it is the same
      // snapshot laid over the bench, worked out from the airframe instead of
      // read out of storage, so putting an airframe back as delivered and
      // recalling a tune are one action.
      selectBuild: (id) =>
        set((state) => {
          const build = findBuild(state.builds, id) ?? findStockBuild(id);
          return build ? { uav: applyBuild(state.uav, build) } : {};
        }),
      // The saved aircraft survive it. Everything else here is a setting with
      // a delivered value to go back to; a named aircraft is the pilot's own
      // work, and there is a delete on each one for when they want it gone.
      reset: () => set((state) => ({ ...DEFAULT_SETTINGS, builds: state.builds })),
    }),
    {
      name: "fpv-wing-settings",
      storage: createJSONStorage(() => localStorage),
      // Loaded by the player store, once it knows whose settings these are.
      skipHydration: true,
      // 2 added `worldDetail`, 3 volumetric cloud; anything stored before
      // either predates the feature and gets the current default rather than
      // an undefined setting. 4 dropped the swisstopo world detail, which is
      // no longer a value `worldDetail` can hold. 5 added the flight
      // controller, 6 the hangar and 7 the power system in it. All three
      // repair a block written by any version — including one from a build
      // with different aircraft, motors or packs in it — so none of them needs
      // a step of its own here. 8 moved the HUD toggles into the OSD layout,
      // which does need one: the three booleans it replaces are the pilot's
      // and have to be carried across rather than dropped. Saved aircraft came
      // later and are the same case as the hangar: a block with none in it is
      // a pilot who has not saved one, and every build that is there is
      // repaired against the catalogue on the way in. Liveries came later
      // again and are that case once more: an aircraft stored without one has
      // never been painted, and is loaded in the colours it is delivered in.
      //
      // Deliberately not bumped when the *default* cells are re-drawn. A
      // layout is arranged by hand in the editor and is the pilot's work, not
      // a setting with a right answer: re-seating it on new defaults would
      // throw that away to fix a picture only a pilot who never opened the
      // editor is looking at. New defaults reach whoever asks for them, with
      // "Restore the default layout".
      version: 8,
      migrate: (persisted, version) => {
        let stored = (persisted ?? {}) as Partial<Settings>;
        if (version < 2) {
          stored = { ...stored, worldDetail: DEFAULT_SETTINGS.worldDetail };
        }
        if (version < 3) {
          stored = {
            ...stored,
            volumetricClouds: DEFAULT_SETTINGS.volumetricClouds,
          };
        }
        if (version < 4 && !isWorldDetail(stored.worldDetail)) {
          stored = { ...stored, worldDetail: DEFAULT_SETTINGS.worldDetail };
        }
        if (version < 8) {
          stored = { ...stored, osdLayout: layoutFromHudToggles(persisted) };
        }
        // The repair pass every block goes through is in `merge` rather than
        // here: a migration only runs when the stored version is behind, and a
        // block written by this very build needs repairing just as much — it
        // may have been written by a build with different aircraft in it, or
        // edited by hand, or truncated by a browser that ran out of quota.
        return stored;
      },
      /**
       * Lays the stored settings over the defaults, repairing them on the way.
       *
       * The default merge is this shallow spread on its own, which trusts
       * whatever is in storage: an OSD layout missing an element the catalogue
       * has since gained would reach the display as an `undefined` placement
       * and take the whole OSD down with it. Running the normalisers here
       * rather than in `migrate` means every load is repaired, not only the
       * first one after a version bump.
       */
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<Settings>;
        return {
          ...current,
          ...stored,
          osdLayout: normaliseOsdLayout(stored.osdLayout),
          // A preset that has since been renamed, or anything else that found
          // its way into the key, lands back on letting the machine choose.
          graphicsQuality: isGraphicsQualityChoice(stored.graphicsQuality)
            ? stored.graphicsQuality
            : DEFAULT_SETTINGS.graphicsQuality,
          // A block written before the panel remembered this carries no
          // source at all, and `PRESET` is a source a *sky* can still be
          // filed under but not one the panel offers. Both land on the
          // delivered choice.
          weatherSource: isWeatherSourceChoice(stored.weatherSource)
            ? stored.weatherSource
            : DEFAULT_SETTINGS.weatherSource,
          // A pinned station is a channel identifier, and the catalogue can
          // lose one: a pilot who pinned a channel that has since gone gets
          // the mission's own choice rather than silence.
          musicStation: isMusicStationChoice(stored.musicStation)
            ? stored.musicStation
            : DEFAULT_SETTINGS.musicStation,
          flightModes: normaliseFlightModeSettings(stored.flightModes),
          uav: normaliseUavSettings(stored.uav),
          builds: normaliseBuilds(stored.builds),
        };
      },
    },
  ),
);

export function readSettings(): Settings {
  const state = useSettingsStore.getState();
  return {
    graphicsQuality: state.graphicsQuality,
    worldDetail: state.worldDetail,
    viewDistanceKm: state.viewDistanceKm,
    fpvFieldOfView: state.fpvFieldOfView,
    cameraShake: state.cameraShake,
    flightSensitivity: state.flightSensitivity,
    controllerSensitivity: state.controllerSensitivity,
    audioEnabled: state.audioEnabled,
    audioVolume: state.audioVolume,
    musicEnabled: state.musicEnabled,
    musicVolume: state.musicVolume,
    musicStation: state.musicStation,
    showClouds: state.showClouds,
    volumetricClouds: state.volumetricClouds,
    showRain: state.showRain,
    weatherEffects: state.weatherEffects,
    weatherSource: state.weatherSource,
    showOsd: state.showOsd,
    osdLayout: state.osdLayout,
    minimapOrientation: state.minimapOrientation,
    minimapRangeMetres: state.minimapRangeMetres,
    chaseDistance: state.chaseDistance,
    chaseHeight: state.chaseHeight,
    flightModes: state.flightModes,
    uav: state.uav,
    builds: state.builds,
  };
}
