"use client";

/**
 * One flight, end to end.
 *
 * Brings up Cesium, resolves the mission origin against real terrain, builds
 * the local ENU frame, starts the simulation and drives the frame loop. This is
 * the only place where the Cesium world and the Cesium-free simulation meet.
 *
 * Everything high-frequency lives here rather than in React: the frame loop
 * touches no component state, and the HUD polls a snapshot at its own, far
 * lower, rate.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import { AircraftRenderer } from "./aircraftRenderer";
import { CameraRig, CAMERA_MODE, DEFAULT_CAMERA_SETTINGS } from "./cameraRig";
import type { CameraMode, CameraSettings } from "./cameraRig";
import {
  createDrawnSurfaceProbe,
  createGlobeSurfaceReader,
  createScenePicker,
  createSurfaceProbe,
  createTerrainProbe,
  sampleDetailedHeight,
} from "./terrainProbe";
import type { GraphicsQuality, LoadStage } from "./viewer";
import { createFlightViewer } from "./viewer";
import { ViewDetail } from "./viewDetail";
import type { Scenery, WorldDetail } from "./scenery";
import { WORLD_DETAIL, waitForSceneryStreamed } from "./scenery";
import { EnvironmentController } from "./environment";
import { RaceGateRenderer } from "./raceGateRenderer";
import { ExplosionRenderer } from "./explosionRenderer";

import { EnuFrame } from "@/sim/geo/enuFrame";
import {
  clampLatitude,
  clampStartHeading,
  DEFAULT_START_HEADING_DEG,
  normaliseLongitude,
  SPAWN_ALTITUDE_LIMITS,
} from "@/sim/geo/placePicker";
import { AIRCRAFT_ROLE, FLIGHT_STATUS, isAirworthy } from "@/sim/flight/state";
import type { AircraftState } from "@/sim/flight/state";
import { hoverThrottle } from "@/sim/flight/multirotor";
import { meshKindFor } from "@/sim/render/aircraftMesh";
import type { Launch } from "@/sim/flight/launch";
import {
  PILOT_EYE_HEIGHT,
  PILOT_STANDOFF,
  airborneLaunch,
  groundLaunch,
} from "@/sim/flight/launch";
import type { Warhead } from "@/sim/flight/damage";
import { INTERCEPT_WARHEAD } from "@/sim/flight/damage";
import { ExplosionField, smokeIntensity } from "@/sim/render/explosionField";
import { preloadPlanFor } from "@/sim/render/preloadPlan";
import type { PreloadPlan } from "@/sim/render/preloadPlan";
import type { FlightTelemetry } from "@/sim/flight/telemetry";
import { FlightControls } from "@/sim/input/flightControls";
import type { InputDevice } from "@/sim/input/flightControls";
import type { ControllerProfile } from "@/sim/input/controllerProfile";
import type { KeyAction, KeyBindings } from "@/sim/input/keyBindings";
import { KEY_ACTION } from "@/sim/input/keyBindings";
import type { GamepadDevice } from "@/sim/input/gamepad";
import { SOUND_CUE, Soundscape } from "@/lib/audio/soundscape";
import { engineProfileFor } from "@/sim/audio/soundModel";
import { impactStrength } from "@/sim/audio/soundModel";
import { toHeadingPitchRoll } from "@/sim/math/quat";
import { clamp, DEG_TO_RAD, RAD_TO_DEG } from "@/sim/math/scalar";
import { createRng } from "@/sim/math/rng";
import type { Rng } from "@/sim/math/rng";
import * as V from "@/sim/math/vec3";
import { vec3 } from "@/sim/math/vec3";
import type { Vec3 } from "@/sim/math/vec3";
import {
  clampToViewportEdge,
  isOnScreen,
  targetScreenDirection,
} from "@/sim/hud/targetTracking";
import type { ScreenDirection } from "@/sim/hud/targetTracking";
import type { ContactReport, CrashReport } from "@/sim/engine/simulation";
import { Simulation } from "@/sim/engine/simulation";
import { CollisionWorld, initRapier } from "@/sim/physics/collisionWorld";
import { TerrainField } from "@/sim/terrain/terrainField";
import {
  groundUnderfoot,
  measuredSurface,
  standingSurface,
} from "@/sim/terrain/footing";
import { SurfaceCalibration } from "@/sim/terrain/surfaceCalibration";
import { SurfaceSettling } from "@/sim/terrain/settling";
import type { SurfaceReadings } from "@/sim/terrain/settling";
import type {
  MissionClock,
  TimeOfDay,
  Weather,
  WeatherProfile,
  WeatherState,
} from "@/sim/environment/types";
import {
  TIME_PROFILES,
  TIME_ZONE,
  WEATHER_PROFILES,
  formatInstant,
  resolveWeatherProfile,
  withCloudCover,
} from "@/sim/environment/types";
import { createMissionWind } from "@/sim/environment/wind";
import { VideoLink, VTX_UNLIMITED } from "@/sim/environment/videoLink";
import type { VideoLinkState } from "@/sim/environment/videoLink";
import type { WindField } from "@/sim/environment/wind";
import { VisibilitySystem } from "@/sim/environment/visibility";
import { EnemyController } from "@/sim/ai/enemyController";
import type { EnemyDebugState } from "@/sim/ai/enemyController";
import {
  FORMATION_SLOTS,
  FormationLeadPilot,
  FormationWingPilot,
  MANOEUVRE_LABELS,
  WINGMAN_SLOT_ORDER,
  buildRoutine,
  formationLeadFor,
  formationStation,
} from "@/sim/ai/formation";
import type {
  FormationSlot,
  FormationSlotId,
  Manoeuvre,
} from "@/sim/ai/formation";
import { TerrainAvoidanceSystem } from "@/sim/ai/terrainAvoidance";
import type { FlightModeSettings } from "@/sim/flight/flightModes";
import { DEFAULT_FLIGHT_MODE_SETTINGS } from "@/sim/flight/flightModes";
import { FlightModeController } from "@/sim/flight/flightController";
import type { ControlRates } from "@/sim/flight/rates";
import type { Livery } from "@/sim/flight/livery";
import { normaliseLivery, rgbOf } from "@/sim/flight/livery";
import type { PowerLoadout, Uav, UavLoadout } from "@/sim/flight/uav";
import { resolveLoadout, uavOrDefault } from "@/sim/flight/uav";
import { createPowerplant } from "@/sim/flight/powerplant";
import {
  containWithin,
  generatePatrolRoute,
  generateSpawnPoints,
  generateTransitRoute,
} from "@/sim/ai/patrol";
import { TRANSIT_TERRAIN_MARGIN, TransitPilot } from "@/sim/ai/transitPilot";
import type { TransitPilotDebug } from "@/sim/ai/transitPilot";
import { RacePilot } from "@/sim/ai/racer";
import type { RacePilotDebug } from "@/sim/ai/racer";
import {
  FestivalPilot,
  festivalSpawnHeading,
  festivalSpawnPoint,
} from "@/sim/ai/festivalPilot";
import type { FestivalPilotDebug } from "@/sim/ai/festivalPilot";
import { StreamerRenderer } from "./streamerRenderer";
import type { Difficulty } from "@/sim/ai/types";
import { DIFFICULTY, DIFFICULTY_PROFILES } from "@/sim/ai/types";
import type {
  FestivalSettings,
  FormationSettings,
  MissionEvent,
  MissionMode,
  MissionStatus,
  OppositionSettings,
  RaceGate,
  RaceGridSlot,
  RaceSettings,
  StrikeSettings,
} from "@/sim/mission";
import {
  DEFAULT_FESTIVAL,
  DEFAULT_FORMATION,
  DEFAULT_OPPOSITION,
  DEFAULT_RACE,
  DEFAULT_STRIKE,
  MAX_FLIGHT_SIZE,
  MAX_RACE_COMPETITORS,
  MISSION_MODE,
  MissionRunner,
  RACE_PROFILES,
  RaceCourse,
  STREAMER_LENGTH,
  buildRaceGates,
  clampEscortCount,
  contactSpeedReference,
  isCombatMission,
  oppositionAircraft,
  raceGridSlots,
  settleGateHeights,
  startsOnTheGround,
  streamerColour,
  streamerLabel,
} from "@/sim/mission";
import type { TerrainBatchProbe, TerrainQuery } from "@/sim/terrain/types";

export interface MissionOrigin {
  readonly latitude: number;
  readonly longitude: number;
  /** Terrain elevation at the origin, metres above the ellipsoid. */
  readonly terrainHeight: number;
}

export interface FlightMissionConfig {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  /** Mission radius in metres. */
  readonly missionRadius: number;
  readonly weather: Weather;
  /**
   * How much of the sky the cloud fills, 0..1, overriding the weather's own
   * figure. Left out, the weather decides; at zero the sky is empty and no
   * cloud is drawn, marched or seen through.
   */
  readonly cloudCover?: number;
  /**
   * The whole sky, when the pilot built one.
   *
   * A preset with a cover slider is one way to describe weather and it stays
   * the default; this is the other — every deck, the visibility, what is
   * falling, whether it is thundering and the wind at each height, whether it
   * came from the editor, a report the pilot typed, the nearest real aerodrome
   * or the mission seed. When it is set it is the authority and `weather` is
   * only the word the logbook records.
   */
  readonly sky?: WeatherState;
  readonly timeOfDay: TimeOfDay;
  /** The date and time to fly at. Only read while `timeOfDay` is `Custom`. */
  readonly clock?: MissionClock;
  readonly mode: MissionMode;
  /** Enemies to place at mission start. Ignored in free flight. */
  readonly enemyCount: number;
  readonly difficulty: Difficulty;
  /** False keeps enemies on patrol and makes contact non-lethal. */
  readonly combat: boolean;
  /** The slot, the size of the flight and the routine. Formation flights only. */
  readonly formation?: FormationSettings;
  /** The field and the length of the course. Races only. */
  readonly race?: RaceSettings;
  /** The size of the field, the sky over it and the slot. Festivals only. */
  readonly festival?: FestivalSettings;
  /** How much of the transit is escorted. Strikes only. */
  readonly strike?: StrikeSettings;
  /**
   * Which aircraft the contacts are flying. Interceptions and strikes only.
   *
   * Left out, everything put up against the pilot flies the interceptor wing,
   * which is what every contact flew before it could be chosen.
   */
  readonly opposition?: OppositionSettings;
  /**
   * Video transmitter power in milliwatts. Zero — the default — flies without
   * a range limit and never puts static on the goggles.
   */
  readonly vtxPowerMw?: number;
  /** Drives wind, cloud layout and development contacts. */
  readonly seed: string;
  readonly quality: GraphicsQuality;
  /** 3D scenery laid over the terrain: none, buildings, or photogrammetry. */
  readonly worldDetail?: WorldDetail;
  readonly viewDistanceKm: number;
  /** Spawn height above terrain, metres. */
  readonly spawnAltitudeAgl: number;
  /**
   * Which way the flight faces when it begins, degrees from north.
   *
   * The whole start turns with it — the pilot's aircraft, whoever is standing
   * on the field, the formation leader's station, the race grid and the run-in
   * to the first gate — because they are all laid out around one heading.
   * North when it is not given.
   */
  readonly startHeadingDeg?: number;
  readonly cameraSettings?: Partial<CameraSettings>;
  readonly flightSensitivity?: number;
  readonly controllerSensitivity?: number;
  /**
   * How the wing's flight controller is set up: the bank and pitch limits the
   * assisted modes hold to, and everything a return home is flown by.
   */
  readonly flightModes?: FlightModeSettings;
  /**
   * Which aircraft out of the hangar is being flown. Defaults to the
   * interceptor wing.
   */
  readonly uavId?: string;
  /** The rates that aircraft is tuned on; its own defaults when not given. */
  readonly rates?: ControlRates;
  /**
   * The motor and the pack in it; the delivered pair when not given.
   *
   * A pack of `BATTERY_UNLIMITED` flies the airframe at its delivered weight
   * with nothing draining, which is the setting for a pilot who would rather
   * not have the flight end on a voltage.
   */
  readonly power?: PowerLoadout;
  /**
   * The colours it is painted in; the airframe's delivered ones when not
   * given. Only the pilot's own aircraft wears them — a contact is drawn in
   * the tint that says what it is.
   */
  readonly livery?: Livery;
  /** The pilot's key layout; defaults are used when it is not given. */
  readonly keyBindings?: KeyBindings;
  /** 0..1. Zero is silence; audio is never created when disabled. */
  readonly audioVolume?: number;
  readonly audioEnabled?: boolean;
  /** Supplies the stored mapping for a controller as it is plugged in. */
  readonly resolveControllerProfile?: (
    device: GamepadDevice,
  ) => ControllerProfile | null;
  readonly showClouds?: boolean;
  /** Raymarched cloud instead of billboards, where the hardware allows it. */
  readonly volumetricClouds?: boolean;
  readonly showRain?: boolean;
  readonly weatherEffects?: boolean;
}

export type LoadingPhase =
  | "starting"
  | "cesium"
  | "terrain"
  | "imagery"
  | "viewer"
  | "scenery"
  | "origin"
  | "tiles"
  | "photogrammetry"
  | "physics"
  | "weather"
  | "preload"
  | "overview"
  | "spawn"
  | "enemies"
  | "formation"
  | "course"
  | "festival"
  | "warmup"
  | "ready";

export const LOADING_LABELS: Record<LoadingPhase, string> = {
  starting: "Starting up...",
  cesium: "Loading CesiumJS...",
  terrain: "Connecting to global terrain...",
  imagery: "Loading satellite imagery...",
  viewer: "Creating the world...",
  scenery: "Loading buildings and vegetation...",
  origin: "Surveying the mission area...",
  tiles: "Streaming terrain tiles...",
  photogrammetry: "Streaming photorealistic 3D tiles...",
  physics: "Initializing physics...",
  weather: "Building the weather...",
  preload: "Streaming the sky around the field...",
  overview: "Staging the country around it...",
  spawn: "Spawning aircraft...",
  enemies: "Placing contacts...",
  formation: "Forming up the flight...",
  course: "Setting out the gates...",
  festival: "Filling the sky...",
  warmup: "Warming up the renderer...",
  ready: "Ready",
};

export interface FlightSessionCallbacks {
  /**
   * `detail` is a line about what a slow phase is actually doing — the
   * photogrammetry session being retried, or how much of the mesh around the
   * spawn has arrived — for the loading screen to show under the phase name.
   */
  onPhase?: (phase: LoadingPhase, progress: number, detail?: string) => void;
  onHotkey?: (action: KeyAction) => void;
  onMissionEvent?: (event: MissionEvent, status: MissionStatus) => void;
  onError?: (error: unknown) => void;
}

/**
 * Actions polled every frame.
 *
 * Which key each one sits on is the pilot's business, so the session works in
 * actions: some it acts on itself, and the rest are forwarded to the UI.
 */
const HOTKEY_ACTIONS: readonly KeyAction[] = [
  KEY_ACTION.Camera,
  KEY_ACTION.Minimap,
  KEY_ACTION.CycleTarget,
  KEY_ACTION.Pause,
  KEY_ACTION.Debug,
  KEY_ACTION.ResetAircraft,
  KEY_ACTION.SpawnEnemy,
  KEY_ACTION.FreeCamera,
  KEY_ACTION.FlightMode,
  KEY_ACTION.CourseHold,
  KEY_ACTION.AltitudeHold,
  KEY_ACTION.ReturnHome,
];

/** Marks enemy aircraft apart from the player's airframe. */
const ENEMY_TINT: readonly [number, number, number] = [0.62, 0.11, 0.09];
/**
 * A contact that is only transiting.
 *
 * Deliberately not the interceptor red: on a strike the pilot has to be able to
 * tell, across two kilometres of sky, which of the contacts is going somewhere
 * and which one is coming for them.
 */
const TRANSIT_TINT: readonly [number, number, number] = [0.46, 0.48, 0.34];
/** The aircraft a formation is flown on. */
const LEAD_TINT: readonly [number, number, number] = [0.12, 0.45, 0.72];
/** The other aircraft in the flight. */
const WINGMAN_TINT: readonly [number, number, number] = [0.24, 0.58, 0.55];
/**
 * How high an airborne flight may be started, metres above the ground.
 *
 * The floor is the one the globe screen offers, so a start height picked there
 * is the height flown rather than a number the session quietly raises; the
 * ceiling keeps the aircraft over a piece of ground rather than over a country.
 * A flight begun on the ground is not held to either: it starts where the pilot
 * is standing.
 */
const MIN_SPAWN_AGL = SPAWN_ALTITUDE_LIMITS.minimum;
const MAX_SPAWN_AGL = 1500;
/**
 * How high the camera is parked while the spawn's tiles stream in, metres AGL.
 *
 * Independent of where the flight begins: a camera down at a low start height
 * — or on the grass, in the ground view — streams the hedge in front of it and
 * nothing else, and the tiles worth having ready are the ones the first minute
 * of the flight crosses.
 */
const TILE_PRELOAD_AGL = 300;
/** Clearance an enemy is guaranteed above the terrain it spawns over, metres. */
const ENEMY_SPAWN_CLEARANCE = 220;
/** Floor for an enemy's spawn height in local ENU metres. */
const MIN_ENEMY_ALTITUDE = 120;
/** Clearance the formation is guaranteed above the ground it forms up over. */
const FORMATION_SPAWN_CLEARANCE = 90;
/** Rival racers, so a field of them can still be told apart in the air. */
const RACER_TINTS: readonly (readonly [number, number, number])[] = [
  [0.86, 0.34, 0.08],
  [0.42, 0.24, 0.68],
  [0.16, 0.6, 0.32],
  [0.78, 0.18, 0.46],
  [0.9, 0.72, 0.12],
  [0.1, 0.5, 0.72],
  [0.62, 0.62, 0.66],
];
/**
 * The colours a festival field turns up in.
 *
 * Longer and louder than the racing set on purpose: everybody at a fly-in
 * built their own, and telling one wing from another across five hundred
 * metres is most of what a spectator does.
 */
const FESTIVAL_TINTS: readonly (readonly [number, number, number])[] = [
  [0.88, 0.28, 0.1],
  [0.95, 0.78, 0.16],
  [0.18, 0.62, 0.3],
  [0.14, 0.44, 0.78],
  [0.68, 0.2, 0.6],
  [0.92, 0.52, 0.06],
  [0.2, 0.7, 0.68],
  [0.82, 0.82, 0.86],
  [0.5, 0.3, 0.14],
  [0.36, 0.22, 0.72],
];
/**
 * How high the field flies, as a fraction of its radius.
 *
 * A fly-in is flown over the strip rather than around the district: the sky
 * that is used is roughly as tall as the field is wide, and a 200 m field
 * where everybody is at three hundred metres is not a fly-in.
 */
const FESTIVAL_CEILING_FRACTION = 0.55;
/** And the height band is never taller or shorter than this, metres. */
const FESTIVAL_MIN_CEILING = 90;
const FESTIVAL_MAX_CEILING = 320;
/** The lowest a festival aircraft is asked to fly, metres above the ground. */
const FESTIVAL_FLOOR = 35;
/**
 * How far ahead of the start point the loading camera is parked, degrees of
 * arc.
 *
 * It sits behind the spawn looking along the start heading, so the tiles it
 * pulls in while the loading screen is up are the ones the flight opens over.
 */
const CAMERA_STANDOFF_DEG = 0.012;
/**
 * How long a swept view has to be quiet before the sweep moves on, ms.
 *
 * Shorter than the settle a take-off is gated on, because nothing is about to
 * be drawn from a swept view: what the leg wants is the requests issued and
 * landed, not a guarantee that the picture is complete. Long enough, though,
 * that a lull between two batches of the same view does not end the leg early.
 */
const PRELOAD_SETTLE_MS = 600;
/**
 * How far the overview pass pitches down, degrees.
 *
 * Not straight down: the point of the pass is the ground between the field and
 * the horizon, which is what a climb or a long look ahead uncovers. Pointed at
 * its feet it would stage the field again, which is the one piece of world
 * already in the cache by then.
 */
const OVERVIEW_PITCH_DEG = -32;
/**
 * How many frames the warm-up waits for the aircraft to reach the GPU.
 *
 * One frame is enough — a synchronous primitive does all of its work in the
 * first frame it is updated in — so this is only a stop, not a schedule: a
 * flight is never held up by a primitive that for whatever reason never says
 * it is ready.
 */
const WARMUP_FRAME_LIMIT = 12;
/**
 * How long a wait for an animation frame gives up after, milliseconds.
 *
 * Comfortably longer than a frame on anything that can run this at all, and
 * short enough that a flight started in a background tab still starts.
 */
const FRAME_WAIT_TIMEOUT_MS = 250;
/**
 * How long the warm-up gives the opening view to finish streaming, ms.
 *
 * Short, because the view is a few hundred metres from the one already waited
 * for and most of what it needs is in the cache: this is for the last of it,
 * not for a world that has not arrived.
 */
const OPENING_VIEW_WAIT_MS = 3000;
/** Clearance a rival is guaranteed above the ground it launches over. */
const RACE_SPAWN_CLEARANCE = 80;
/** How far short of the next gate a replacement airframe rejoins, metres. */
const RACE_REJOIN_RANGE = 550;
/**
 * Clearance a replacement airframe rejoins with, metres.
 *
 * Enough height to be flying rather than falling, and little enough that the
 * run-in to a gate on the deck is a shallow descent instead of a dive.
 */
const RACE_REJOIN_CLEARANCE = 60;
/**
 * Where a gate's surface is picked, as a fraction of its half-width across the
 * opening and metres along the way through it.
 *
 * A gate is cleared by the tallest thing under it, and the tallest thing under
 * it is rarely dead centre — a roof under one post, or a block standing right
 * where the run-in crosses, would otherwise be found by a wing rather than by
 * the layout.
 */
const GATE_SURFACE_SAMPLES: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.7, 0],
  [-0.7, 0],
  [0, 35],
  [0, -35],
];
/** How long the course waits for the scene to answer about its gates, ms. */
const COURSE_PICK_TIMEOUT_MS = 12000;
/**
 * How much further in from the rim an off-screen gate marker sits than the
 * target's. The gate and the nearest rival are often behind the same wing, and
 * two arrows clamped to the same point are two labels nobody can read.
 */
const GATE_EDGE_INSET = 2.1;

const PLAYER_ID = "player";
/**
 * Particles the whole mission shares.
 *
 * A single detonation asks for about seventy of them and a wreck trailing
 * smoke for another forty a second, so this covers two aircraft going up at
 * once with room to spare and degrades into a thinner explosion rather than a
 * frame spike when a whole flight does. Six hundred billboards in one
 * collection is one batch, and Cesium does not care.
 */
const EXPLOSION_POOL = 600;
/**
 * How often the drawn surface under the aircraft is picked, seconds.
 *
 * Each pick is a render pass, and what it is measuring — the offset between a
 * photogrammetry mesh and the height field it replaced — changes over
 * kilometres, not metres. Two or three a second is plenty to keep up with it
 * and cheap enough to leave running for a whole flight.
 */
const SURFACE_PICK_INTERVAL = 0.4;
/**
 * Where one stand's drawn surface is measured, metres from the stand itself.
 *
 * A person's own footprint and no further. Measuring one wide patch around the
 * launch point and sharing it between the pilot and the launcher was tried
 * first and is wrong twice over: it misses the ground either of them is
 * actually on, because a stand a few metres off the pattern is never sampled,
 * and it hands each of them the tallest thing anywhere in the patch — which in
 * a city put a pilot forty metres up a tower they were standing beside rather
 * than on. What a stand has to clear is what a stand is *in*: the column under
 * it and the couple of metres its own body occupies. A tree eight metres away
 * is scenery to look past, not ground to be lifted onto.
 *
 * Two rings rather than one, and the outer one denser, because a gap between
 * samples is a thing that was not seen.
 */
const STAND_SURFACE_SAMPLES: readonly (readonly [number, number])[] = (() => {
  const samples: [number, number][] = [[0, 0]];
  for (const [radius, count] of [
    [1.5, 8],
    [3, 12],
  ] as const) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      samples.push([Math.sin(angle) * radius, Math.cos(angle) * radius]);
    }
  }
  return samples;
})();
/** Above this height above ground the surface offset does not matter, metres. */
const SURFACE_PICK_CEILING = 400;
/** Give up waiting for tiles after this long and fly anyway. */
const TILE_WAIT_TIMEOUT_MS = 25000;
/** How long buildings may go without a tile arriving before flight begins. */
const SCENERY_STALL_MS = 8000;
/**
 * The same, for photogrammetry — where the wait is not a nicety.
 *
 * A photogrammetry mesh keeps arriving for as long as it takes, and the flight
 * waits for it: what runs the budget out is tiles that have *stopped* arriving,
 * not tiles that are slow. The ceiling below only bounds a connection that
 * dribbles forever.
 */
const PHOTOGRAMMETRY_STALL_MS = 20000;
const PHOTOGRAMMETRY_WAIT_TIMEOUT_MS = 180000;

export interface FrameStats {
  fps: number;
  frameMs: number;
  simSteps: number;
}

/**
 * Everything the HUD needs to draw the target indicator, recomputed once per
 * rendered frame. The same object is returned every call.
 */
export interface HudTargetView {
  /** False when nothing is being tracked. */
  active: boolean;
  distance: number;
  bearingDeg: number;
  /** True when the target is inside the view with room for a tracking box. */
  onScreen: boolean;
  /** Window coordinates of the target; only meaningful when `onScreen`. */
  screenX: number;
  screenY: number;
  /** Where an off-screen indicator belongs, clamped to the viewport edge. */
  edgeX: number;
  edgeY: number;
  /** Unit direction from the screen centre toward the target, Y down. */
  dirX: number;
  dirY: number;
  /** How clearly the target can be seen through the weather, 0..1. */
  visibility: number;
  /** Which contact this is, 1-based, in the range order the cycle key steps. */
  index: number;
  /** How many contacts there are to cycle between. */
  count: number;
}

/** The screen-space part of a HUD marker, shared by everything projected. */
interface ProjectedPoint {
  onScreen: boolean;
  screenX: number;
  screenY: number;
  edgeX: number;
  edgeY: number;
  dirX: number;
  dirY: number;
}

/**
 * The slot the player is meant to be holding, projected into the view.
 *
 * Formation flying is a positioning problem, and a bearing to the leader does
 * not solve it: what the pilot needs to see is the empty piece of sky the
 * aircraft belongs in.
 */
export interface HudStationView {
  /** False when this is not a formation flight, or nothing is flying. */
  active: boolean;
  /** Metres from the slot. */
  error: number;
  inStation: boolean;
  onScreen: boolean;
  screenX: number;
  screenY: number;
  edgeX: number;
  edgeY: number;
  dirX: number;
  dirY: number;
}

/**
 * The gate the pilot is flying at, projected into the view.
 *
 * A race is flown by looking at the next gate and nothing else, so this is the
 * one marker that has to be right: where the frame is, how far away it is, and
 * — when it is behind you — which way to turn to get back to it.
 */
export interface HudGateView {
  /** False when this is not a race, or the course has been flown. */
  active: boolean;
  /** 1-based gate number, as the OSD counts them. */
  number: number;
  count: number;
  /** Metres to the middle of the frame. */
  distance: number;
  isFinish: boolean;
  onScreen: boolean;
  screenX: number;
  screenY: number;
  edgeX: number;
  edgeY: number;
  dirX: number;
  dirY: number;
}

export class FlightSession {
  readonly cesium: CesiumModule;
  readonly viewer: Cesium.Viewer;
  readonly frame: EnuFrame;
  readonly simulation: Simulation;
  readonly origin: MissionOrigin;
  readonly config: FlightMissionConfig;
  /** The 3D scenery actually in the scene, and why, if it was downgraded. */
  readonly scenery: Scenery;

  private readonly renderer: AircraftRenderer;
  /**
   * How much of the world was fetched before the sticks were handed over.
   *
   * Kept only so the debug overlay can quote it: nothing in flight reads it,
   * because by the time anything is flying the plan has already been carried
   * out. Detail is never lowered afterwards — the preset the pilot chose is
   * what is drawn for the whole flight.
   */
  private readonly preload: PreloadPlan;
  /**
   * Every explosion, break-up, ground impact and smoke trail in the mission.
   *
   * One field for the whole flight rather than one per aircraft: the pool is
   * the budget, and sharing it is what stops a mission that ends with twenty
   * contacts going up at once from costing twenty times a single one.
   */
  private readonly explosions = new ExplosionField({ capacity: EXPLOSION_POOL });
  private readonly explosionRenderer: ExplosionRenderer;
  private readonly cameraRig: CameraRig;
  private readonly controls: FlightControls;
  private readonly sound: Soundscape | null;
  private lastTargetId: string | null = null;
  private readonly terrainField: TerrainField;
  readonly environment: EnvironmentController;
  readonly visibility: VisibilitySystem;
  readonly windField: WindField;
  readonly mission: MissionRunner;
  private readonly callbacks: FlightSessionCallbacks;
  private readonly removeListener: () => void;

  private paused = false;
  private disposed = false;
  /**
   * True once the aircraft is on the field and the flight is a flight.
   *
   * The viewer is already rendering while the world is being assembled around
   * the start point, so this listener starts being called well before there is
   * anything to fly: the terrain is still being sampled, and on a flight that
   * begins on the ground the launch surface is picked out of the rendered
   * scene, which takes frames of its own to answer. Stepping a simulation with
   * no aircraft in it through those frames is not a quiet no-op — an empty sky
   * is exactly what a mission reads as an airframe lost — so nothing runs
   * until there is one.
   */
  private underWay = false;
  /**
   * True while the world is still being assembled around the start point.
   *
   * The viewer renders throughout that, and the aircraft exists for the last
   * of it — the contacts are placed after the player is, the tiles for the
   * opening view are streamed after that, and the primitives are put on the
   * GPU after that again. None of it is flying, and a simulation stepped
   * through it would have the mission clock running, the aircraft drifting off
   * the launch point and the pilot's first frame already several seconds old.
   * So the frame loop stands still until `begin` says the flight is a flight.
   */
  private loading = true;
  /**
   * The weather and the time of day actually being flown in.
   *
   * `config` records how the flight was launched and never changes; both of
   * these can be changed from the pause menu without a restart, so anything
   * asking what the sky is doing now has to read them here.
   */
  private currentWeather: Weather;
  /** Undefined leaves the cover to the weather profile. */
  private currentCloudCover: number | undefined;
  /** The whole sky, when one was given instead of a preset. */
  private currentSky: WeatherState | undefined;
  /** The two above already worked out; what everything downstream reads. */
  private currentProfile: WeatherProfile;
  private currentTimeOfDay: TimeOfDay;
  private currentClock: MissionClock | undefined;
  private enemyCount = 0;
  /**
   * The charge every aircraft in this mission flies with, if any.
   *
   * An interception is flown by putting a wing through another wing, and the
   * wing carries a small contact-fuzed charge to make sure that is the end of
   * it. Nothing else does: a formation display and a race are flown by
   * aircraft with nothing on board but a camera, so a mid-air there is only
   * ever as bad as the impact itself.
   */
  private readonly warhead: Warhead | null;
  private readonly spawnRng: Rng;
  private readonly enemyPilots = new Map<string, EnemyController>();
  private readonly transitPilots = new Map<string, TransitPilot>();
  private transitCount = 0;
  private leadPilot: FormationLeadPilot | null = null;
  private playerSlot: FormationSlot | null = null;
  private readonly racePilots = new Map<string, RacePilot>();
  private readonly festivalPilots = new Map<string, FestivalPilot>();
  private festivalCount = 0;
  /**
   * Draws the paper, at a streamer event and nowhere else.
   *
   * Built lazily rather than in the constructor because a `PolylineCollection`
   * in every flight ever flown is a primitive the other six modes would never
   * put anything into.
   */
  private streamerRenderer: StreamerRenderer | null = null;
  private raceCourse: RaceCourse | null = null;
  private raceGates: RaceGateRenderer | null = null;
  private readonly stationPoint = vec3();
  private readonly terrainAvoidance: TerrainAvoidanceSystem;
  /** The aircraft the pilot is flying, out of the hangar in `sim/flight/uav`. */
  private readonly uav: Uav;
  private readonly loadout: UavLoadout;
  /**
   * How a fresh airframe is put into the flight: where, how fast, on what
   * throttle, and whether it starts flying at all.
   *
   * One object rather than a pair of numbers because a launch off the ground
   * is an attitude and a height as well as a speed, and every airframe the
   * pilot is given during the flight has to arrive the same way the first one
   * did.
   */
  private readonly launch: Launch;
  /**
   * The heading the flight opens on, degrees from north.
   *
   * Chosen on the globe with the start point. Everything laid out around the
   * start reads it rather than assuming north: the pilot's own aircraft, the
   * few metres of field the launcher is standing on, the formation leader's
   * station, the race grid and the direction the course runs off in.
   */
  private readonly startHeadingDeg: number;
  /**
   * Where the pilot is standing, when they are standing anywhere.
   *
   * Only the RC ground view puts them on the field; everything else begins
   * with the aircraft already up. Reused rather than allocated: the ground
   * under them is re-read every frame, because the surface the flight is run
   * against can still be settling onto the one being drawn.
   */
  private readonly pilotStation = vec3();
  /** The paint on the pilot's airframe, replacements included. */
  private readonly livery: Livery;
  /** The modes, the holds and the way home, on the player's airframe. */
  private readonly flightModes: FlightModeController;
  /** True once the launch point has been recorded as home. */
  private homeSet = false;
  private readonly terrainProbe: TerrainBatchProbe;
  /**
   * Keeps the ground the aircraft is flown against on the ground the pilot can
   * see. Null unless the scene is drawing a surface of its own — see
   * `sim/terrain/surfaceCalibration.ts`.
   */
  private readonly surfaceCalibration: SurfaceCalibration | null;
  private readonly pickSurface: (x: number, y: number) => Promise<number | null>;
  /**
   * The drawn surface under a batch of columns — roofs, mesh and all.
   *
   * What a race course is laid out on: the terrain data describes bare earth,
   * and a gate over a town has to clear the town.
   */
  private readonly probeSurface: TerrainBatchProbe;
  /**
   * The drawn surface under a batch of columns, as it stands this moment.
   *
   * The same reading as `probeSurface` without the demand behind it: it takes
   * the scene as it is rather than holding a most-detailed pick open per column
   * until every tileset has streamed the deepest tile it owns there. That is
   * what a re-measurement wants — what has arrived, not what could be made to —
   * and it is the difference between a ground view that streams the grass under
   * the pilot's feet all flight and one that does not. See
   * `createDrawnSurfaceProbe`.
   */
  private readonly observeSurface: TerrainBatchProbe;
  /**
   * The globe mesh as it is currently drawn, under one column.
   *
   * Free and synchronous, unlike the pick above, and used for one thing: the
   * pilot on the field stands on it wherever it is higher than the elevation
   * the flight is run against.
   */
  private readonly readGlobeSurface: (x: number, y: number) => number | null;
  /**
   * The surface the scene draws where the wing is held, in local metres.
   *
   * Null until it has been measured, and measured for every world detail
   * rather than only for photogrammetry: the height field is bare earth
   * everywhere, and everywhere the scene can be drawing something taller.
   */
  private launchSurface: number | null = null;
  /** The same, where the pilot is standing. They are metres apart. */
  private pilotSurface: number | null = null;
  /**
   * How long the launch area goes on being re-measured, and when it stops.
   *
   * Nobody on a field moves, so this is a settling process rather than a poll:
   * see `sim/terrain/settling.ts` for why measuring it forever is the most
   * expensive way to learn nothing.
   */
  private readonly launchSettling = new SurfaceSettling();
  private launchSurfacePending = false;
  private surfacePickTimer = 0;
  private surfacePickPending = false;
  private readonly targetViewSnapshot: HudTargetView = {
    active: false,
    distance: 0,
    bearingDeg: 0,
    onScreen: false,
    screenX: 0,
    screenY: 0,
    edgeX: 0,
    edgeY: 0,
    dirX: 0,
    dirY: 0,
    visibility: 1,
    index: 0,
    count: 0,
  };
  private readonly gateViewSnapshot: HudGateView = {
    active: false,
    number: 0,
    count: 0,
    distance: 0,
    isFinish: false,
    onScreen: false,
    screenX: 0,
    screenY: 0,
    edgeX: 0,
    edgeY: 0,
    dirX: 0,
    dirY: 0,
  };
  private readonly stationViewSnapshot: HudStationView = {
    active: false,
    error: 0,
    inStation: false,
    onScreen: false,
    screenX: 0,
    screenY: 0,
    edgeX: 0,
    edgeY: 0,
    dirX: 0,
    dirY: 0,
  };
  private readonly screenDirection: ScreenDirection = {
    inFront: false,
    x: 0,
    y: 0,
  };
  private readonly edgePoint = { x: 0, y: 0 };
  private readonly relative = vec3();
  private readonly ecefScratch = vec3();
  private readonly targetCartesian: Cesium.Cartesian3;
  private readonly windowScratch: Cesium.Cartesian2;
  private lastFrameTime = 0;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  readonly stats: FrameStats = { fps: 0, frameMs: 0, simSteps: 0 };

  private constructor(args: {
    cesium: CesiumModule;
    viewer: Cesium.Viewer;
    frame: EnuFrame;
    simulation: Simulation;
    renderer: AircraftRenderer;
    cameraRig: CameraRig;
    controls: FlightControls;
    sound: Soundscape | null;
    terrainField: TerrainField;
    environment: EnvironmentController;
    visibility: VisibilitySystem;
    windField: WindField;
    mission: MissionRunner;
    terrainProbe: TerrainBatchProbe;
    scenery: Scenery;
    preload: PreloadPlan;
    origin: MissionOrigin;
    config: FlightMissionConfig;
    callbacks: FlightSessionCallbacks;
  }) {
    this.cesium = args.cesium;
    this.viewer = args.viewer;
    this.frame = args.frame;
    this.simulation = args.simulation;
    this.renderer = args.renderer;
    this.explosionRenderer = new ExplosionRenderer(
      args.cesium,
      args.viewer.scene,
      args.frame,
      EXPLOSION_POOL,
    );
    this.cameraRig = args.cameraRig;
    this.controls = args.controls;
    this.sound = args.sound;
    this.terrainField = args.terrainField;
    this.environment = args.environment;
    this.visibility = args.visibility;
    this.windField = args.windField;
    this.mission = args.mission;
    this.terrainProbe = args.terrainProbe;
    this.scenery = args.scenery;
    this.preload = args.preload;
    this.origin = args.origin;
    this.config = args.config;
    this.currentWeather = args.config.weather;
    this.currentCloudCover = args.config.cloudCover;
    this.currentSky = args.config.sky;
    this.currentProfile = missionWeather(args.config);
    this.currentTimeOfDay = args.config.timeOfDay;
    this.currentClock = args.config.clock;
    this.callbacks = args.callbacks;
    // Seeded from the mission, so the same mission spawns the same enemies in
    // the same places every time it is flown.
    this.spawnRng = createRng(`${args.config.seed}:enemies`);
    this.warhead = isCombatMission(args.config.mode) ? INTERCEPT_WARHEAD : null;
    this.terrainAvoidance = new TerrainAvoidanceSystem(args.terrainField);
    this.uav = uavOrDefault(args.config.uavId);
    // The airframe is worked out from the hardware in it: what the pack weighs
    // and what the propeller can push are flown, not quoted.
    this.loadout = resolveLoadout(this.uav, args.config.power);
    this.livery = normaliseLivery(args.config.livery, this.uav.defaultLivery);
    // The FPV camera is on the aircraft, so where the view comes from moves
    // with the airframe rather than being the wing's whatever is being flown.
    this.cameraRig.setAirframe(
      meshKindFor(this.loadout.config),
      this.loadout.config.wingSpan,
    );
    // Where the flight begins. A mission hands the pilot an aircraft that is
    // already up; the ground view hands them one on the grass in front of
    // them, and how it leaves the grass is the airframe's business.
    this.launch = startsOnTheGround(args.config.mode)
      ? groundLaunch(this.loadout.config)
      : airborneLaunch(
          this.loadout.config,
          clamp(args.config.spawnAltitudeAgl, MIN_SPAWN_AGL, MAX_SPAWN_AGL),
        );
    this.startHeadingDeg = clampStartHeading(
      args.config.startHeadingDeg ?? DEFAULT_START_HEADING_DEG,
    );
    // The throttle stick starts where the aircraft is: on a multirotor that is
    // the hover and on a hand launch it is wide open, and a stick left at a
    // cruising wing's setting would be neither.
    this.controls.reset(this.launch.throttle);
    this.flightModes = new FlightModeController({
      settings: args.config.flightModes ?? DEFAULT_FLIGHT_MODE_SETTINGS,
      rates: args.config.rates ?? this.uav.defaultRates,
      terrain: args.terrainField,
      // A return home is the flight nobody is watching, so it gets the same
      // look-ahead the AI uses rather than a straight line through a ridge.
      avoidance: this.terrainAvoidance,
    });
    // The aircraft are not scenery: a height sample that found the wing being
    // held over the launch point would raise the launch point, which would
    // raise the wing. Read through a callback rather than captured, because
    // the renderer's primitives come and go with the airframes.
    const notScenery = () => this.renderer.pickExclusions();
    this.pickSurface = createScenePicker(
      args.cesium,
      args.viewer.scene,
      args.frame,
      notScenery,
    );
    this.probeSurface = createSurfaceProbe(
      args.cesium,
      args.viewer.scene,
      args.frame,
      notScenery,
    );
    this.observeSurface = createDrawnSurfaceProbe(
      args.cesium,
      args.viewer.scene,
      args.frame,
      notScenery,
    );
    this.readGlobeSurface = createGlobeSurfaceReader(
      args.cesium,
      args.viewer.scene,
      args.frame,
    );
    // Only photogrammetry puts a surface in the scene that the terrain data
    // does not describe. Everywhere else the globe *is* the height field, so
    // measuring the difference would be measuring nothing.
    this.surfaceCalibration =
      args.scenery.applied === WORLD_DETAIL.Photorealistic
        ? new SurfaceCalibration()
        : null;
    this.targetCartesian = new args.cesium.Cartesian3();
    this.windowScratch = new args.cesium.Cartesian2();

    const onPreUpdate = (): void => this.onFrame();
    this.viewer.scene.preUpdate.addEventListener(onPreUpdate);
    this.removeListener = () => {
      if (!this.viewer.isDestroyed()) {
        this.viewer.scene.preUpdate.removeEventListener(onPreUpdate);
      }
    };
  }

  // --- Construction --------------------------------------------------------

  static async start(
    container: HTMLElement,
    config: FlightMissionConfig,
    callbacks: FlightSessionCallbacks = {},
  ): Promise<FlightSession> {
    const report = (
      phase: LoadingPhase,
      progress: number,
      detail?: string,
    ): void => callbacks.onPhase?.(phase, progress, detail);

    report("starting", 0.02);

    const stageMap: Record<LoadStage, LoadingPhase> = {
      cesium: "cesium",
      terrain: "terrain",
      imagery: "imagery",
      viewer: "viewer",
      scenery: "scenery",
      tiles: "tiles",
    };
    const stageProgress: Record<LoadStage, number> = {
      cesium: 0.12,
      terrain: 0.24,
      imagery: 0.32,
      viewer: 0.4,
      scenery: 0.44,
      tiles: 0.6,
    };

    const { cesium, viewer, scenery } = await createFlightViewer(
      container,
      {
        quality: config.quality,
        worldDetail: config.worldDetail,
      },
      {
        onStage: (stage, detail) =>
          report(stageMap[stage], stageProgress[stage], detail),
      },
    );
    // Scenery that arrived short of what was asked for, or only after being
    // asked twice, is worth knowing about — but it is never a reason to abandon
    // a flight that has a world under it. Photogrammetry that could not be
    // loaded at all does not come through here: it was raised as an error.
    if (scenery.note) console.warn(`[fpv] ${scenery.note}`);

    // --- How much world is fetched before anybody flies ---------------------
    // Worked out here, before the loading screen starts waiting on anything, so
    // every wait below is against one plan. Nothing in it lowers detail: the
    // preset the pilot chose is drawn for the whole flight, and the frames come
    // from having the world in the caches rather than from asking for less of
    // it. The arithmetic is in `sim/render/preloadPlan`.
    const preload = preloadPlanFor({
      missionRadius: config.missionRadius,
      viewDistanceKm: config.viewDistanceKm,
      heavy: scenery.applied === WORLD_DETAIL.Photorealistic,
    });

    // --- Mission origin, resolved against the real terrain ------------------
    report("origin", 0.46);
    const sampled = await sampleDetailedHeight(
      cesium,
      viewer.terrainProvider,
      config.latitude,
      config.longitude,
    );
    const terrainHeight = sampled ?? 0;
    const origin: MissionOrigin = {
      latitude: config.latitude,
      longitude: config.longitude,
      terrainHeight,
    };
    const frame = new EnuFrame({
      latitude: config.latitude,
      longitude: config.longitude,
      height: terrainHeight,
    });

    // --- Weather and light --------------------------------------------------
    report("weather", 0.5);
    const weather = missionWeather(config);
    const timeProfile = TIME_PROFILES[config.timeOfDay];
    const environment = new EnvironmentController(cesium, viewer, frame, {
      weather,
      time: timeProfile,
      clock: config.clock,
      latitude: config.latitude,
      longitude: config.longitude,
      seed: config.seed,
      viewDistanceKm: config.viewDistanceKm,
      quality: config.quality,
      clouds: config.showClouds ?? true,
      volumetricClouds: config.volumetricClouds ?? true,
      rain: config.showRain ?? true,
      effects: config.weatherEffects ?? true,
      stormRadius: Math.max(config.missionRadius, 6000),
    });

    // --- Stream the tiles the aircraft will actually be flying over ---------
    // The camera is parked at the start height or at the preload height,
    // whichever is higher, whether the flight begins there or on the grass:
    // what is wanted is the ground the flight crosses, not the hedge a low
    // start happens to be looking at.
    const spawnAgl = Math.max(
      clamp(config.spawnAltitudeAgl, MIN_SPAWN_AGL, MAX_SPAWN_AGL),
      TILE_PRELOAD_AGL,
    );
    aimCameraAtSpawn(cesium, viewer, config, terrainHeight, spawnAgl);
    report("tiles", 0.55);
    await waitForTiles(viewer, (fraction) =>
      report("tiles", 0.55 + fraction * 0.12),
    );

    // Scenery streams on its own schedule, and it only starts streaming *this*
    // view now that the camera has been aimed at the spawn — everything it
    // fetched before was for wherever the camera happened to be pointing.
    //
    // With photogrammetry that wait is the whole world: the globe is hidden
    // underneath the mesh, so the terrain queue above drains instantly over an
    // empty scene. Nothing else gates the take-off, and a flight that begins
    // early begins over a hole. So it gets its own phase, its own progress, and
    // a budget measured in tiles still arriving rather than in seconds elapsed.
    const photogrammetry = scenery.applied === WORLD_DETAIL.Photorealistic;
    const sceneryPhase: LoadingPhase = photogrammetry ? "photogrammetry" : "tiles";
    report(sceneryPhase, 0.67);
    const sceneryComplete = await waitForSceneryStreamed(scenery, {
      stallMs: photogrammetry ? PHOTOGRAMMETRY_STALL_MS : SCENERY_STALL_MS,
      timeoutMs: photogrammetry
        ? PHOTOGRAMMETRY_WAIT_TIMEOUT_MS
        : TILE_WAIT_TIMEOUT_MS,
      onProgress: (fraction) =>
        report(
          sceneryPhase,
          0.67 + fraction * 0.11,
          photogrammetry
            ? `${Math.round(fraction * 100)}% of the mesh around the spawn has arrived`
            : undefined,
        ),
    });
    if (!sceneryComplete && photogrammetry) {
      // Not a reason to abandon a flight that has a world under it already, but
      // it is why the far side of the valley may be missing.
      console.warn(
        "[fpv] photorealistic 3D tiles stopped arriving before the view was " +
          "complete; taking off over what did arrive",
      );
    }
    report("tiles", 0.74);

    // --- The country behind it, and the rest of the compass -----------------
    // What has streamed so far is the view the flight opens facing. The first
    // climb sees over it and the first turn leaves it, so the distance and then
    // the whole circle are fetched here rather than over the top of a flight
    // already in progress.
    report("preload", 0.75);
    await preloadSurroundings(
      cesium,
      viewer,
      scenery,
      config,
      preload,
      terrainHeight,
      spawnAgl,
      (phase, fraction) => report(phase, 0.75 + fraction * 0.05),
    );

    // --- Physics ------------------------------------------------------------
    report("physics", 0.8);
    let collision: CollisionWorld | null = null;
    try {
      const rapier = await initRapier();
      collision = new CollisionWorld(rapier);
    } catch (error) {
      // Interception detection is a Phase 4 concern; losing it must not stop
      // the flight, but it must not be silent either.
      console.error("[fpv] Rapier failed to initialise", error);
      callbacks.onError?.(error);
    }

    const terrainProbe = createTerrainProbe(cesium, viewer.terrainProvider, frame);
    const terrainField = new TerrainField(terrainProbe, { fallbackHeight: 0 });
    // Resolve the ground around the spawn before anything is allowed to fly
    // over it, so the very first frame already has real terrain underneath —
    // and resolve the whole mission area where it fits, so a flight that stays
    // inside its own airspace, which is nearly every flight, asks the elevation
    // service for nothing at all once it is airborne.
    await terrainField.prefill(
      vec3(),
      // Never less than the field would warm on its own: whatever the plan
      // says, the first refresh of the flight has nothing left to ask for.
      Math.max(preload.terrainRadius, terrainField.warmedRadius),
    );

    // A preset quotes a direction, but a preset is a kind of day rather than a
    // particular one, so the airmass is turned to a seeded bearing. A sky the
    // pilot built, typed or fetched already says where the wind is coming
    // from, and moving it would be inventing weather over an observation.
    const windField = createMissionWind(config.seed, weather.wind, {
      veerBySeed: config.sky === undefined,
    });
    environment.setWindField(windField);
    const visibility = new VisibilitySystem(terrainField, {
      weather,
      daylight: environment.daylight,
      layers: environment.cloudLayers,
    });
    // The pilot stands at the mission origin, so the link is measured from
    // there — and from the terrain field, which is what puts a ridge between
    // the aircraft and the goggles.
    const videoLink = new VideoLink({
      powerMilliwatts: config.vtxPowerMw ?? VTX_UNLIMITED,
      terrain: terrainField,
    });

    const formationFlight = config.mode === MISSION_MODE.Formation;
    const race = config.mode === MISSION_MODE.Race;
    const festival = config.mode === MISSION_MODE.Festival;
    const strike = config.mode === MISSION_MODE.Strike;
    const simulation = new Simulation({
      frame,
      terrain: terrainField,
      collision,
      missionRadius: config.missionRadius,
      // Wings that touch bend, whatever the mission was. A display routine and
      // a race are flown by unarmed aircraft, so a mid-air there is only ever
      // as bad as the impact itself — a brush costs nothing but the moment, a
      // solid knock costs the handling for the rest of the flight, and only a
      // real collision writes the airframe off. What a practice run switches off is
      // the hunting and the charges: an intercept flown with combat off keeps
      // the promise the setup screen makes, that nothing can be destroyed.
      // A festival is the same bargain again, and the one where it matters
      // most: the whole event is wings sharing too little air, and what a
      // touch costs is the only thing that makes it worth flying carefully.
      contactDamage:
        formationFlight || race || festival ? true : (config.combat ?? true),
      wind: windField,
      visibility,
      videoLink,
      // The aircraft worth putting a box around is the one being flown on, in
      // a race the rival you are fighting for a place with, and at a festival
      // whoever is nearest — which is the one about to be a problem.
      trackedRole: formationFlight
        ? AIRCRAFT_ROLE.Lead
        : race
          ? AIRCRAFT_ROLE.Racer
          : festival
            ? AIRCRAFT_ROLE.Festival
            : AIRCRAFT_ROLE.Enemy,
    });

    // --- Aircraft -----------------------------------------------------------
    report("spawn", 0.9);
    const controls = new FlightControls({
      flightSensitivity: config.flightSensitivity ?? 1,
      controllerSensitivity: config.controllerSensitivity ?? 1,
      bindings: config.keyBindings,
      resolveProfile: config.resolveControllerProfile,
    });
    controls.attach();
    controls.reset(0.65);

    // Starting a flight is a click, which is the gesture browsers want before
    // they will run an audio context. Disabled audio builds no graph at all
    // rather than a silent one.
    // The motor tone belongs to the airframe: four three-bladed propellers at
    // forty thousand rpm are a different noise to one two-bladed pusher at
    // twelve, and it is the first thing you notice about flying one.
    const sound =
      config.audioEnabled === false
        ? null
        : Soundscape.create(
            config.audioVolume ?? 0.7,
            engineProfileFor(
              resolveLoadout(uavOrDefault(config.uavId), config.power).config,
            ),
          );

    const renderer = new AircraftRenderer(cesium, viewer.scene, frame);
    const cameraRig = new CameraRig(cesium, viewer, frame);
    cameraRig.setSettings({
      ...DEFAULT_CAMERA_SETTINGS,
      ...(config.cameraSettings ?? {}),
    });
    // What the quality preset asked for, and what a zoom is allowed to do to
    // it. Built after the viewer and the scenery, because it reads the preset
    // back off both rather than keeping a second copy of it. See
    // `viewDetail.ts`; only the ground view's eye ever moves it.
    cameraRig.setDetail(new ViewDetail(viewer.scene, scenery.tilesets));

    const session = new FlightSession({
      cesium,
      viewer,
      frame,
      simulation,
      renderer,
      cameraRig,
      controls,
      sound,
      terrainField,
      environment,
      visibility,
      windField,
      mission: new MissionRunner({
        mode: config.mode,
        locationName: config.name,
        latitude: config.latitude,
        longitude: config.longitude,
        missionRadius: config.missionRadius,
        spawnAltitudeAgl: config.spawnAltitudeAgl,
        weather: config.weather,
        timeOfDay: config.timeOfDay,
        clock: config.clock,
        enemyCount: config.enemyCount,
        difficulty: config.difficulty,
        combat: config.combat,
        formation: config.formation ?? DEFAULT_FORMATION,
        race: config.race ?? DEFAULT_RACE,
        festival: config.festival ?? DEFAULT_FESTIVAL,
        strike: config.strike ?? DEFAULT_STRIKE,
        opposition: config.opposition ?? DEFAULT_OPPOSITION,
        vtxPowerMw: config.vtxPowerMw ?? VTX_UNLIMITED,
        seed: config.seed,
      }),
      terrainProbe,
      scenery,
      preload,
      origin,
      config,
      callbacks,
    });

    // A flight that starts on the ground is the one flight where the couple of
    // metres between the height field and the mesh being drawn over it is the
    // difference between standing on the grass and standing inside it, so the
    // scene is asked what is actually under the launch point before anything
    // is put on it.
    if (startsOnTheGround(config.mode)) await session.levelLaunchSurface();
    session.spawnPlayer();
    // Line of sight is the whole point of the ground view, so that is the view
    // it opens on; everything else opens looking out of the aircraft.
    if (startsOnTheGround(config.mode)) {
      session.placePilotOnTheField();
      cameraRig.setMode(CAMERA_MODE.Ground);
    } else {
      cameraRig.setStation(null);
      cameraRig.setMode(CAMERA_MODE.Fpv);
    }

    if (config.mode === MISSION_MODE.Intercept && config.enemyCount > 0) {
      report("enemies", 0.95);
      await session.placeMissionEnemies();
    } else if (strike) {
      report("enemies", 0.95);
      await session.placeStrikeContacts();
    } else if (formationFlight) {
      report("formation", 0.95);
      session.launchFormation();
    } else if (race) {
      report("course", 0.95);
      await session.layOutRace();
    } else if (festival) {
      report("festival", 0.95);
      session.launchFestival();
    }

    // --- Warm up ------------------------------------------------------------
    report("warmup", 0.98);
    await session.warmUp();

    report("ready", 1);
    session.begin();
    return session;
  }

  /**
   * Hands the flight over to the pilot.
   *
   * Everything before this ran with the frame loop standing still, so the
   * mission clock starts here, on the first frame the pilot can actually see.
   */
  private begin(): void {
    this.loading = false;
    this.lastFrameTime = 0;
  }

  /**
   * Draws the whole flight once before any of it is flown.
   *
   * A Cesium primitive combines its geometry, uploads it and compiles the
   * shader it is drawn with in the first frame it is updated in. Until now
   * that frame was the first frame of the flight — the same frame the tile
   * queue was draining into and the pilot's first stick input landed in — and
   * with twenty contacts in the sky it is a hitch big enough to be the thing
   * they remember about the take-off. The camera is moved to where the flight
   * opens first, so what warms up is what is about to be drawn, and the tiles
   * that view turns out to need get a moment to arrive with it.
   */
  private async warmUp(): Promise<void> {
    const player = this.simulation.player;
    if (player) {
      if (this.cameraRig.hasStation) this.placePilotOnTheField();
      this.cameraRig.update(player, 0);
    }
    this.drawFlight();
    this.renderer.showEverything();

    // The opening view is a different view from the one the tiles were
    // streamed for — the standoff the loading camera used is behind the spawn
    // and above it — so what it turned out to need gets a moment here rather
    // than a second of stutter after the loading screen goes.
    await nextFrame();
    await waitForTiles(this.viewer, () => {}, OPENING_VIEW_WAIT_MS);
    if (this.disposed) return;

    // At least one frame, whatever the primitives say: a frame that has been
    // drawn is the only proof that anything has been.
    for (let i = 0; i < WARMUP_FRAME_LIMIT; i += 1) {
      await nextFrame();
      if (this.disposed || this.renderer.ready) return;
    }
  }

  // --- Player --------------------------------------------------------------

  /**
   * Finds out what the launch area is actually made of, before anybody stands
   * on it.
   *
   * The height field is bare earth. What the scene draws over it need not be,
   * and on a field that is the whole difference between flying and not: a
   * photorealistic tileset reconstructs the trees, so a wood the elevation data
   * reports as a hillside is drawn as a hillside with fifteen or twenty metres
   * of canopy on top, and a pilot put at head height over the bare earth is
   * standing inside it — blind, with the aircraft buried beside them. The same
   * thing at a smaller scale is a building footprint over the launch point, and
   * at a smaller scale again a globe tile that has not refined yet.
   *
   * So the launch area is picked out of the scene itself, which is the only
   * thing that knows. Not one column: the whole patch the launch happens on,
   * because a canopy is not flat and the tallest thing on it is what has to be
   * cleared. The reading is a measurement rather than a guess, so it is trusted
   * where it stands above the height field and discarded where it falls below
   * it — that is the globe sagging, and a sag is a hole in the picture rather
   * than somewhere to stand.
   *
   * Every world detail, not just photogrammetry. Only the *bias* below is
   * photogrammetry's business: that moves the ground the flight is flown
   * against, and everywhere else the globe already is the height field.
   *
   * Which probe does the picking is the caller's decision and a real one. The
   * round taken under the loading screen asks for the deepest detail the scene
   * can be made to reach, because it is establishing what the launch area *is*
   * and there are no frames to spend. Every round after it observes what has
   * arrived instead — `createDrawnSurfaceProbe` — because that is the question
   * a re-measurement is asking, and asking the other one costs the flight.
   *
   * Returns what each stand read, in the order the stands are measured in, or
   * null when the round did not run.
   */
  private async measureLaunchSurface(
    probe: TerrainBatchProbe,
  ): Promise<SurfaceReadings | null> {
    if (this.launchSurfacePending) return null;
    this.launchSurfacePending = true;
    try {
      // Both stands in one round: the launch point, where somebody is holding
      // the wing, and the few metres behind it where the pilot is standing.
      // They are measured apart because they are apart — one can be in a
      // clearing and the other under the trees.
      const [px, py] = this.pilotColumn();
      const stands: readonly (readonly [number, number])[] = [
        [0, 0],
        [px, py],
      ];
      const points = stands.flatMap(([sx, sy]) =>
        STAND_SURFACE_SAMPLES.map(([dx, dy]) => ({ x: sx + dx, y: sy + dy })),
      );
      const picks = await probe(points);
      if (this.disposed) return null;

      // Corroborated rather than simply the highest: an unsettled height sample
      // comes back finite and absurd, and the highest reading of a batch is the
      // one such an answer wins. See `measuredSurface`.
      const stride = STAND_SURFACE_SAMPLES.length;
      const surfaceOf = (index: number, x: number, y: number): number | null =>
        measuredSurface(
          picks.slice(index * stride, (index + 1) * stride),
          this.terrainField.heightAt(x, y),
        );

      const launch = surfaceOf(0, 0, 0);
      const pilot = surfaceOf(1, px, py);
      if (launch !== null) {
        this.launchSurface = launch;
        // A held wing waits over the ground the launcher is standing on, and
        // the flight loop is what holds it there.
        this.simulation.setLaunchSurface(launch);
      }
      if (pilot !== null) this.pilotSurface = pilot;
      return [launch, pilot];
    } finally {
      this.launchSurfacePending = false;
    }
  }

  /**
   * Where the pilot stands, in local metres.
   *
   * Behind the launch point along the start heading — somebody else is holding
   * the aircraft and the pilot is the one behind them with the transmitter.
   */
  private pilotColumn(): readonly [number, number] {
    const heading = (this.startHeadingDeg * Math.PI) / 180;
    return [
      -Math.sin(heading) * PILOT_STANDOFF,
      -Math.cos(heading) * PILOT_STANDOFF,
    ];
  }

  /**
   * Puts the ground the flight is flown against onto the ground being drawn,
   * before anything is standing on either.
   *
   * Only photogrammetry can tell them apart: a photorealistic tileset carries
   * its own reconstructed surface, the height field describes bare earth, and
   * the two disagree by a couple of metres either way. In the air that is
   * nothing and the running calibration takes care of it. On a field it is the
   * difference between a wing leaving somebody's hand at head height and one
   * leaving it out of a hole, so the launch point is picked once, deliberately,
   * and the correction is adopted before the first frame rather than four
   * samples into the flight.
   *
   * This is the *flight model's* half of the same question — how far the ground
   * it is flown against has to move — and it stays clamped to a datum
   * difference, because moving it further would be flying an aircraft against
   * the treetops for the rest of the mission. Where the launch is standing is
   * `measureLaunchSurface`, which is not clamped to anything of the sort.
   */
  private async levelLaunchSurface(): Promise<void> {
    // The one round that is entitled to force the tiles: it is establishing
    // what the launch area is made of, under a loading screen, with no frames
    // to spend. Everything measured here is what the flight compares against,
    // so the settling is told about it rather than starting from nothing.
    const readings = await this.measureLaunchSurface(this.probeSurface);
    if (readings) this.launchSettling.prime(readings);
    const calibration = this.surfaceCalibration;
    if (!calibration) return;
    const drawn = await this.pickSurface(0, 0);
    if (drawn === null || this.disposed) return;
    // The correction already in the field has to come off the comparison, the
    // same way the in-flight one does.
    const sampled =
      this.terrainField.heightAt(0, 0) - this.terrainField.surfaceBias;
    calibration.prime(drawn, sampled);
    this.terrainField.setSurfaceBias(calibration.bias);
  }

  /**
   * Stands the pilot at the launch point, eyes at their own height over
   * whatever the ground under them is doing this frame.
   *
   * Re-read rather than remembered: the surface the flight is run against can
   * still be settling onto the one being drawn, and a pilot left at the height
   * it had on the first frame would end up buried in it or floating over it.
   *
   * Which is the whole difficulty of this view, and why the ground under the
   * pilot is worked out rather than read off one column. 1.7 m is all the
   * margin a standing pilot has, and on anything but flat ground two separate
   * things eat it: the height field's grid cuts the corner off a rise, and the
   * globe is drawn at whatever tile level has streamed in rather than the one
   * the field sampled. Either is nothing at circuit height and either is the
   * difference between watching a launch and watching the inside of a hill. So
   * the stand clears both — the ground within a couple of paces, and the mesh
   * actually on screen — and is capped, because a launch point on the lip of a
   * cliff is a launch point on the lip of a cliff.
   */
  private placePilotOnTheField(): void {
    // Behind the launch point rather than on it: the aircraft leaves somebody
    // else's hand and goes away from the pilot, which is what a launch looks
    // like from where the transmitter is. Behind is measured along the start
    // heading, so the pilot is always the few metres of field the wing is
    // thrown away from, whichever way that is.
    const [x, y] = this.pilotColumn();
    const column = this.terrainField.heightAt(x, y);
    const underfoot = groundUnderfoot(this.terrainField, x, y);
    // What the scene is drawing where they are standing: the patch measured out
    // of the scene, and the globe as it stands this frame, whichever is higher.
    // The second is free and follows the tiles as they refine; the first is the
    // only one that can see a canopy or a roof.
    const globe = this.readGlobeSurface(x, y);
    const measured =
      this.pilotSurface === null
        ? globe
        : globe === null
          ? this.pilotSurface
          : Math.max(this.pilotSurface, globe);
    const stand = standingSurface(column, underfoot, measured);
    V.set(this.pilotStation, x, y, stand + PILOT_EYE_HEIGHT);
    this.cameraRig.setStation(this.pilotStation);
  }

  private spawnPlayer(): void {
    // The terrain cache is seeded around the origin, so this is the real
    // surface height rather than a guess — the aircraft can never start below
    // the ground. A wing waiting in somebody's hand is measured from the
    // ground that person is standing on instead, which on a slope is a step up
    // from the column under the wing — the same ground `Simulation` holds it
    // over every step after this one, so the first frame is not a jump.
    const groundZ = this.launch.held
      ? standingSurface(
          this.terrainField.heightAt(0, 0),
          groundUnderfoot(this.terrainField, 0, 0),
          this.launchSurface,
        )
      : this.terrainField.heightAt(0, 0);
    const position = vec3(0, 0, groundZ + this.launch.altitudeAgl);
    // Facing the way the start point was set up to face, which is north until
    // the pilot turned the needle on the globe.
    let headingDeg = this.startHeadingDeg;

    // A replacement airframe on a formation flight comes back on station
    // rather than at the origin: the exercise is holding the slot, and a
    // ten-kilometre stern chase to rejoin is not that exercise.
    const lead = this.playerSlot ? this.simulation.lead : null;
    if (lead && this.playerSlot) {
      formationStation(position, lead, this.playerSlot);
      const ground = this.terrainField.heightAt(position.x, position.y);
      position.z = Math.max(position.z, ground + FORMATION_SPAWN_CLEARANCE);
      headingDeg = toHeadingPitchRoll(lead.orientation).headingDeg;
    }

    // A replacement airframe in a race rejoins on the run-in to the gate it
    // still owes, lined up on it. The clock never stopped for the crash, so
    // the cost of one is the time it took — not a five-kilometre transit back
    // to where the course had got to.
    const gate = this.raceRejoinGate();
    if (gate) {
      V.addScaled(position, gate.position, gate.forward, -RACE_REJOIN_RANGE);
      const ground = this.terrainField.heightAt(position.x, position.y);
      // Lined up on the gate at the gate's own height rather than at the
      // altitude the flight launched from: the course is flown on the deck,
      // and a rejoin three hundred metres over it is a dive, not a run-in.
      position.z = Math.max(gate.position.z, ground + RACE_REJOIN_CLEARANCE);
      headingDeg = gate.headingDeg;
    }

    const state = this.simulation.spawn(
      {
        id: PLAYER_ID,
        role: AIRCRAFT_ROLE.Player,
        config: this.loadout.config,
        position,
        headingDeg,
        // Nose up on a hand launch, level on everything else — and everything
        // else about how the airframe arrives is the launch's too: a wing
        // thrown off a field leaves the hand climbing on full throttle, a wing
        // handed a mission arrives at a cruise, and a quadcopter hangs on its
        // own rotors or sits on the grass waiting for the throttle.
        pitchDeg: this.launch.pitchDeg,
        rollDeg: 0,
        airspeed: this.launch.airspeed,
        throttle: this.launch.throttle,
        grounded: this.launch.grounded,
        held: this.launch.held,
        warhead: this.warhead,
        // A replacement airframe arrives with a fresh pack in it, the way the
        // next wing out of the car does.
        powerplant: this.loadout.battery
          ? createPowerplant(this.loadout.motor, this.loadout.battery)
          : null,
      },
      // The sticks reach the airframe through the flight controller, so acro
      // is a passthrough and every other mode is something it does on the way.
      (aircraft, dt) =>
        this.flightModes.update(aircraft, this.controls.sample(dt), dt),
    );
    this.rollPlayerStreamer(state.id);
    // Home is where the flight began, not wherever a replacement airframe
    // appeared: a return that came back to the last crash site is no use.
    if (!this.homeSet) {
      this.flightModes.setHome(state.position);
      this.homeSet = true;
    }
    // Only the aircraft the pilot is actually looking at gets moving elevons,
    // and it is drawn at its own span: a 2.1 m survey wing is not an
    // interceptor, and from the chase camera that is the first thing you see.
    this.renderer.add(
      state.id,
      null,
      true,
      this.loadout.config.wingSpan,
      this.livery,
      meshKindFor(this.loadout.config),
    );
    this.renderer.update(state);
    // There is an aircraft now, so the frame loop has a flight to run. Whoever
    // spawned it finishes putting the view where it belongs before the next
    // frame — nothing between here and there yields.
    this.underWay = true;
  }

  // --- Formation -----------------------------------------------------------

  /**
   * Puts the flight in the air around the player.
   *
   * The leader is placed so that the player begins exactly on station: a
   * formation exercise that opens with a two-kilometre stern chase is a
   * navigation exercise. Everything after that first instant has to be flown.
   *
   * What the flight is flying is the mission's own choice, dealt from the seed
   * like everything else — the leader first, then the slots — so a display can
   * be a flight of interceptors, a flight of survey wings, or the mixed
   * four-ship a club field actually turns out.
   */
  launchFormation(): void {
    const player = this.simulation.player;
    if (!player) return;

    const settings = this.config.formation ?? DEFAULT_FORMATION;
    const slot = FORMATION_SLOTS[settings.slot];
    this.playerSlot = slot;

    // Invert the slot offset: the player spawns on the start heading, wings
    // level, so the leader belongs one station ahead of them along it.
    const leadUav = this.fieldAircraft(0);
    const lead = this.spawnFormationAircraft(
      "lead",
      AIRCRAFT_ROLE.Lead,
      formationLeadFor(vec3(), player.position, this.startHeadingDeg, slot),
      LEAD_TINT,
      leadUav,
    );

    const routine = buildRoutine({
      seed: this.config.seed,
      difficulty: this.config.difficulty,
      seconds: settings.routineSeconds,
    });
    this.leadPilot = new FormationLeadPilot({
      id: lead.id,
      routine,
      terrain: this.terrainField,
      terrainAvoidance: this.terrainAvoidance,
      missionRadius: this.config.missionRadius,
      // The display is flown at the speed the leader's own aeroplane cruises
      // at, and never faster than the one in the slot behind it: a lead that
      // walks away from its own flight is not leading anything.
      speedReference: this.fieldSpeed(leadUav),
    });
    this.simulation.setController(lead.id, this.leadPilot.control);

    // The rest of the flight fills the slots the player is not in.
    const wingmen = Math.max(
      0,
      Math.min(settings.flightSize, MAX_FLIGHT_SIZE) - 1,
    );
    const taken = WINGMAN_SLOT_ORDER.filter((id) => id !== slot.id);
    for (let i = 0; i < wingmen; i += 1) {
      const wingSlot = FORMATION_SLOTS[taken[i % taken.length] as FormationSlotId];
      const position = formationStation(vec3(), lead, wingSlot);
      const uav = this.fieldAircraft(i + 1);
      const state = this.spawnFormationAircraft(
        `wingman-${i + 1}`,
        AIRCRAFT_ROLE.Wingman,
        position,
        WINGMAN_TINT,
        uav,
      );
      const pilot = new FormationWingPilot({
        id: state.id,
        slot: wingSlot,
        terrain: this.terrainField,
        terrainAvoidance: this.terrainAvoidance,
        getLead: () => this.simulation.lead,
        speedReference: this.fieldSpeed(uav),
      });
      this.simulation.setController(state.id, pilot.control);
    }

    // The lead is what the HUD tracks on a formation flight.
    this.simulation.selectTarget(lead.id);
  }

  /** Spawns one aircraft of the flight, clear of the ground it starts over. */
  private spawnFormationAircraft(
    id: string,
    role: typeof AIRCRAFT_ROLE.Lead | typeof AIRCRAFT_ROLE.Wingman,
    position: Vec3,
    tint: readonly [number, number, number],
    uav: Uav,
  ): AircraftState {
    const ground = this.terrainField.heightAt(position.x, position.y);
    position.z = Math.max(position.z, ground + FORMATION_SPAWN_CLEARANCE);

    const state = this.simulation.spawn({
      id,
      role,
      config: uav.config,
      position,
      headingDeg: this.startHeadingDeg,
      // Whatever it takes to already be flying: a wing joins the display at a
      // cruise, a quadcopter is simply sitting on its rotors.
      airspeed: uav.config.rotor ? 0 : 25,
      throttle: uav.config.rotor ? hoverThrottle(uav.config) : 0.65,
    });
    this.addFieldVisual(id, uav, tint);
    this.renderer.update(state);
    return state;
  }

  /** The manoeuvre the leader is flying, or null off a formation flight. */
  get formationManoeuvre(): Manoeuvre | null {
    return this.leadPilot ? this.leadPilot.manoeuvre : null;
  }

  /** A readable name for that manoeuvre. */
  get formationManoeuvreLabel(): string | null {
    const manoeuvre = this.formationManoeuvre;
    return manoeuvre ? MANOEUVRE_LABELS[manoeuvre] : null;
  }

  /** The slot the player has been given, or null off a formation flight. */
  get formationSlot(): FormationSlot | null {
    return this.playerSlot;
  }

  /**
   * Where the slot is on screen. Reused object, like `targetView()`.
   */
  stationView(): HudStationView {
    const view = this.stationViewSnapshot;
    view.active = false;

    const tracker = this.mission.formation;
    const player = this.simulation.player;
    const lead = this.simulation.lead;
    if (!tracker || !player || !lead || !isAirworthy(player.status)) {
      return view;
    }

    tracker.stationPoint(lead, this.stationPoint);
    view.error = V.distance(player.position, this.stationPoint);
    view.inStation = tracker.progress.inStation;
    this.projectWorldPoint(this.stationPoint, view);
    view.active = true;
    return view;
  }

  // --- Race ----------------------------------------------------------------

  /**
   * Lays the course out and puts the field on the grid.
   *
   * The gates come from the mission seed, so the same race is always the same
   * race. Where they sit vertically is not the seed's business at all: a race
   * is flown on the deck, so every gate is seated on the surface actually
   * under it — one batched elevation request for the ground, and, wherever the
   * scene draws something the elevation data does not know about, one batched
   * pick of the mesh on top of it. Only once the heights are settled is the
   * course measured: the distances between gates are what the standings are
   * read from.
   */
  async layOutRace(): Promise<void> {
    const player = this.simulation.player;
    if (!player) return;

    const settings = this.config.race ?? DEFAULT_RACE;
    const profile = RACE_PROFILES[this.config.difficulty];

    const gates = buildRaceGates({
      seed: this.config.seed,
      profile,
      gateCount: settings.gateCount,
      courseLength: settings.courseLength,
      shape: settings.shape,
      missionRadius: this.config.missionRadius,
      start: player.position,
      startHeadingDeg: this.startHeadingDeg,
      terrain: this.terrainField,
    });

    settleGateHeights(
      gates,
      await this.courseSurfaces(gates),
      this.config.seed,
      this.terrainField,
    );

    const course = new RaceCourse(gates);
    this.raceCourse = course;
    const race = this.mission.setRaceCourse(course);
    race.register(PLAYER_ID, "YOU", true);
    this.raceGates = new RaceGateRenderer(
      this.cesium,
      this.viewer.scene,
      this.frame,
      course,
    );

    const rivals = clamp(
      Math.round(settings.competitors),
      0,
      MAX_RACE_COMPETITORS,
    );
    // What the grid is flying, dealt from the seed before the line is measured
    // out: a 2.1 m survey wing needs more of a start line than a 160 mm
    // quadcopter does, so the line is spaced on the widest thing standing on
    // it — the player's own aircraft included.
    const field: Uav[] = [];
    for (let i = 0; i < rivals; i += 1) field.push(this.fieldAircraft(i));
    const collisionRadius = field.reduce(
      (widest, uav) => Math.max(widest, uav.config.collisionRadius),
      this.loadout.config.collisionRadius,
    );
    // One start line for the whole field, the player in the middle of it. The
    // first slot is theirs — they are already sitting on it — and the rivals
    // take the rest, abreast, so nobody is behind before the clock starts.
    const grid = raceGridSlots({
      count: rivals + 1,
      start: player.position,
      headingDeg: this.startHeadingDeg,
      collisionRadius,
    });
    for (let i = 0; i < rivals; i += 1) {
      this.spawnRacer(
        i,
        grid[i + 1] as RaceGridSlot,
        course,
        profile,
        field[i] as Uav,
      );
    }

    // The nearest rival is what the HUD boxes, and there is one from the off.
    this.simulation.cycleTarget();
  }

  /**
   * The height of the surface under each gate, metres.
   *
   * Two sources, because there are two surfaces. The elevation service is
   * asked first: it is the ground the physics flies against, it answers for
   * columns nowhere near the aircraft, and it is what the cached field was
   * only approximating while the course was being sketched. Then, wherever the
   * scene is drawing something the elevation data does not describe — extruded
   * buildings, or a photogrammetry mesh with its own roofs and trees — the
   * scene itself is picked, and the higher of the two wins. That is the whole
   * of the "3 to 5 metres above the buildings" rule: over a field the ground
   * answers, over a town the town does.
   *
   * A gate is a frame, not a point, so each one is picked across its opening
   * and a little either side of it, and the tallest thing found under it is
   * what it clears. Everything is one batched request per source, run while
   * the course is being laid out and never in flight.
   */
  private async courseSurfaces(
    gates: readonly RaceGate[],
  ): Promise<(number | null)[]> {
    const columns = gates.map((gate) => ({
      x: gate.position.x,
      y: gate.position.y,
    }));

    let grounds: readonly (number | null)[];
    try {
      grounds = await this.terrainProbe(columns);
    } catch {
      grounds = gates.map(() => null);
    }
    // The cached field is better than nothing where the request came back
    // empty: it is the same data, sampled more coarsely.
    const surfaces = gates.map((gate, i) => {
      const probed = grounds[i];
      if (probed !== null && probed !== undefined) return probed;
      const { x, y } = gate.position;
      return this.terrainField.hasCoverage(x, y)
        ? this.terrainField.heightAt(x, y) - this.terrainField.surfaceBias
        : null;
    });

    if (this.scenery.applied === WORLD_DETAIL.Flat) return surfaces;

    const samples: TerrainQuery[] = [];
    for (const gate of gates) {
      for (const [across, along] of GATE_SURFACE_SAMPLES) {
        samples.push({
          x:
            gate.position.x +
            gate.right.x * gate.halfWidth * across +
            gate.forward.x * along,
          y:
            gate.position.y +
            gate.right.y * gate.halfWidth * across +
            gate.forward.y * along,
        });
      }
    }

    const drawn = await this.pickCourseSurfaces(samples);
    if (drawn === null) return surfaces;

    const stride = GATE_SURFACE_SAMPLES.length;
    return surfaces.map((surface, i) => {
      let highest = surface;
      for (let s = 0; s < stride; s += 1) {
        const height = drawn[i * stride + s];
        if (height === null || height === undefined) continue;
        if (highest === null || height > highest) highest = height;
      }
      return highest;
    });
  }

  /**
   * Picks the drawn scene under a batch of columns, or gives up.
   *
   * A pick waits on the tiles under the column arriving, and out at the far
   * end of a twenty-kilometre course they may never arrive at all. Waiting
   * forever would hold the whole flight on the loading screen, so the pick is
   * given a budget and the course falls back to bare terrain if it runs out —
   * a course laid on the ground is worth more than no course.
   */
  private async pickCourseSurfaces(
    samples: readonly TerrainQuery[],
  ): Promise<readonly (number | null)[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), COURSE_PICK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.probeSurface(samples), budget]);
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Puts one rival on its slot on the start line.
   *
   * It gets whichever airframe the mission dealt it, the identical course, the
   * same run-in to the start gate as everybody else, and a pilot that produces
   * nothing but flight input — a rival is beaten by flying a better line, not
   * by out-running something that was given a head start. Nor a faster
   * aeroplane: a rival in a quicker airframe than the player's is still held
   * to what the player's will do, so the grid is what the pilot chose to race
   * against rather than a field that disappears at the first gate.
   */
  private spawnRacer(
    index: number,
    slot: RaceGridSlot,
    course: RaceCourse,
    profile: (typeof RACE_PROFILES)[Difficulty],
    uav: Uav,
  ): void {
    const id = `racer-${index + 1}`;
    const label = `R${index + 1}`;

    const position = vec3(slot.position.x, slot.position.y, slot.position.z);
    // The line is level with the player. This only ever lifts, and on a start
    // line a few tens of metres wide it takes something standing right beside
    // the grid to lift it at all.
    const ground = this.terrainField.heightAt(position.x, position.y);
    position.z = Math.max(position.z, ground + RACE_SPAWN_CLEARANCE);

    const pilot = new RacePilot({
      id,
      course,
      profile,
      terrain: this.terrainField,
      seed: this.config.seed,
      getNextGate: () => this.mission.race?.nextGateFor(id) ?? 0,
      lane: slot.lane,
      level: slot.level,
      speedReference: this.fieldSpeed(uav),
    });
    this.racePilots.set(id, pilot);
    this.mission.race?.register(id, label);

    const state = this.simulation.spawn(
      {
        id,
        role: AIRCRAFT_ROLE.Racer,
        config: uav.config,
        position,
        headingDeg: this.startHeadingDeg,
        airspeed: uav.config.rotor ? 0 : 25,
        throttle: uav.config.rotor ? hoverThrottle(uav.config) : 0.65,
      },
      pilot.control,
    );
    this.addFieldVisual(
      id,
      uav,
      RACER_TINTS[index % RACER_TINTS.length] as readonly [number, number, number],
    );
    this.renderer.update(state);
  }

  /** How one rival is flying the course, for the debug overlay. */
  racerDebug(id: string | null): RacePilotDebug | null {
    if (!id) return null;
    return this.racePilots.get(id)?.debug ?? null;
  }

  /** The course being flown, or null off a race. */
  get course(): RaceCourse | null {
    return this.raceCourse;
  }

  /** The gate the pilot still owes, or null once the course is flown. */
  private raceRejoinGate(): RaceGate | null {
    const race = this.mission.race;
    if (!race || !this.raceCourse) return null;
    return this.raceCourse.gate(race.playerGate);
  }

  /**
   * Where the next gate is on screen. Reused object, like `targetView()`.
   */
  gateView(): HudGateView {
    const view = this.gateViewSnapshot;
    view.active = false;

    const course = this.raceCourse;
    const race = this.mission.race;
    const player = this.simulation.player;
    if (!course || !race || !player || !isAirworthy(player.status)) return view;

    const gate = course.gate(race.playerGate);
    if (!gate) return view;

    view.number = gate.index + 1;
    view.count = course.gateCount;
    view.isFinish = course.isFinish(gate.index);
    view.distance = V.distance(player.position, gate.position);
    this.projectWorldPoint(gate.position, view, GATE_EDGE_INSET);
    view.active = true;
    return view;
  }

  // --- Festival ------------------------------------------------------------

  private get festivalSettings(): FestivalSettings {
    return this.config.festival ?? DEFAULT_FESTIVAL;
  }

  /**
   * The band of sky a festival field uses, metres above the ground.
   *
   * Tied to the size of the field rather than fixed: a two-hundred-metre strip
   * is flown at a couple of hundred feet, and the same aircraft over a
   * kilometre and a half of it has somewhere to go.
   */
  private festivalBand(): { floor: number; ceiling: number } {
    const ceiling = clamp(
      this.festivalSettings.areaRadius * FESTIVAL_CEILING_FRACTION,
      FESTIVAL_MIN_CEILING,
      FESTIVAL_MAX_CEILING,
    );
    return { floor: FESTIVAL_FLOOR, ceiling };
  }

  /** The middle of the field, at the height of the ground under it. */
  private festivalCentre(): Vec3 {
    return vec3(0, 0, this.terrainField.heightAt(0, 0));
  }

  /**
   * Puts the first wave in the air around the player.
   *
   * Everybody launches together, spread round the field on two rings and up
   * the height band, because a wave that starts in one place has its first
   * mid-air before anybody has touched a stick.
   */
  launchFestival(): void {
    const count = Math.max(0, Math.round(this.festivalSettings.aircraftCount));
    const { floor, ceiling } = this.festivalBand();
    const centre = this.festivalCentre();
    for (let i = 0; i < count; i += 1) {
      this.spawnFestivalAircraft(i, count, centre, floor, ceiling);
    }
  }

  /**
   * Clears the wreckage and sends the whole field up again.
   *
   * Called when the mission runner says the sky is empty, which is the only
   * moment anybody at a fly-in is allowed to launch.
   */
  launchFestivalWave(): void {
    for (const id of this.festivalPilots.keys()) {
      this.simulation.remove(id);
      this.renderer.remove(id);
      this.explosions.endTrail(id);
      this.mission.streamers?.detach(id);
    }
    this.festivalPilots.clear();
    // Counted before the aircraft exist, and in that order: the wave number is
    // part of what seeds the pilots, so a wave started afterwards would put
    // the previous wave's pilots back in the identical aeroplanes. The player
    // goes up with it, which is why the count includes them.
    this.mission.festival?.startWave(
      Math.max(0, Math.round(this.festivalSettings.aircraftCount)) + 1,
    );
    this.launchFestival();
    // A pilot who stayed up through the round gets a fresh roll with everybody
    // else. The whole field launches together at a fly-in, and a streamer
    // event where one competitor is flying the second round on what was left
    // of their first ribbon is not the event.
    const player = this.simulation.player;
    if (player && isAirworthy(player.status)) this.rollPlayerStreamer(player.id);
  }

  /**
   * Puts a full roll of paper on the pilot's tail, at a streamer event.
   *
   * Their own accent colour rather than one off the club's roll: it is the
   * colour they painted the aeroplane in, and the whole point of a colour at a
   * fly-in is that everybody already knows whose it is. The scoreline is the
   * pilot's rather than the airframe's, so a replacement wing and a fresh wave
   * both carry on the same afternoon.
   */
  private rollPlayerStreamer(id: string): void {
    this.mission.streamers?.attach(id, {
      competitorId: PLAYER_ID,
      label: "You",
      color: this.livery.accent,
      isPlayer: true,
    });
  }

  /**
   * Puts one of somebody else's aircraft in the air.
   *
   * Whichever airframe the field was asked for, on the identical flight model,
   * flown by somebody who is looking at their own aeroplane and not at yours.
   * A club field is the one place a mixed hangar is simply what a Saturday
   * looks like: wings, gliders and quadcopters sharing the same strip.
   */
  private spawnFestivalAircraft(
    index: number,
    count: number,
    centre: Vec3,
    floor: number,
    ceiling: number,
  ): void {
    // Dealt by how many have been put up today rather than by the position in
    // this wave, so the next wave is a different set of aeroplanes as well as
    // a different set of pilots.
    const uav = this.fieldAircraft(this.festivalCount);
    this.festivalCount += 1;
    const id = `festival-${this.festivalCount}`;
    const radius = this.festivalSettings.areaRadius;

    const position = festivalSpawnPoint(
      vec3(),
      index,
      count,
      centre,
      radius,
      floor,
      ceiling,
    );
    // Never below the ground it is actually being launched over: the ring is
    // laid out around the centre, and a field on a hillside is not flat.
    const ground = this.terrainField.heightAt(position.x, position.y);
    position.z = Math.max(position.z, ground + floor);

    const streamers = this.mission.streamers;
    const pilot = new FestivalPilot({
      id,
      centre,
      areaRadius: radius,
      floor,
      ceiling,
      terrain: this.terrainField,
      // The paper, when there is any. With it this pilot picks a tail and goes
      // after it; without it, it flies its own circuit and its own line.
      streamers,
      // The wave is part of the seed, so the second wave is a different set of
      // pilots rather than the first one again.
      seed: `${this.config.seed}:wave-${this.mission.festival?.wave ?? 1}`,
      getTraffic: () => this.simulation.aircraft,
      // Its own circuit speed, held to the aeroplane it turned up in and to
      // the one the player did: everybody at a fly-in is flying the same
      // piece of sky, and a field nobody can keep up with is a field nobody
      // is sharing anything with.
      speedReference: this.fieldSpeed(uav),
    });
    this.festivalPilots.set(id, pilot);

    const state = this.simulation.spawn(
      {
        id,
        role: AIRCRAFT_ROLE.Festival,
        config: uav.config,
        position,
        headingDeg: festivalSpawnHeading(index, count),
        airspeed: uav.config.rotor ? 0 : 22,
        throttle: uav.config.rotor ? hoverThrottle(uav.config) : 0.6,
      },
      pilot.control,
    );
    // At a streamer event the aeroplane is painted in the colour of the paper
    // it is towing, and the colour is dealt by the slot in the wave rather than
    // by how many have flown today: a competitor keeps their colour, and their
    // scoreline, from one wave to the next.
    const colour = streamers ? streamerColour(index) : null;
    this.addFieldVisual(
      id,
      uav,
      colour
        ? rgbOf(colour.hex)
        : (FESTIVAL_TINTS[
            (this.festivalCount - 1) % FESTIVAL_TINTS.length
          ] as readonly [number, number, number]),
    );
    if (streamers && colour) {
      streamers.attach(id, {
        competitorId: `field-${index}`,
        label: streamerLabel(index),
        color: colour.hex,
        isPlayer: false,
      });
    }
    this.renderer.update(state);
  }

  /** How one festival aircraft is being flown, for the debug overlay. */
  festivalDebug(id: string | null): FestivalPilotDebug | null {
    if (!id) return null;
    return this.festivalPilots.get(id)?.debug ?? null;
  }

  /**
   * Puts one enemy contact in the air at a given point.
   *
   * The airframe is whichever one the mission's opposition setting deals it —
   * another interceptor, a survey wing, a glider, a quadcopter — and it gets a
   * patrol route generated from the mission seed and an `EnemyController` that
   * produces nothing but normalised flight input, the same channel the
   * player's keyboard feeds. Nothing about it is privileged: it stalls, sinks
   * and hits ridges under the same rules, it flies the aeroplane it is
   * actually in, and it cannot see through weather the player cannot see
   * through either.
   */
  private createEnemy(position: Vec3): AircraftState {
    const uav = this.contactAircraft();
    this.enemyCount += 1;
    const id = `enemy-${this.enemyCount}`;
    const difficulty = DIFFICULTY_PROFILES[this.config.difficulty];

    const route = generatePatrolRoute({
      seed: `${this.config.seed}:${id}`,
      missionRadius: this.config.missionRadius,
      baseAltitude: position.z,
      terrain: this.terrainField,
      terrainMargin: difficulty.terrainMargin,
    });

    const pilot = new EnemyController({
      id,
      difficulty,
      route,
      terrainAvoidance: this.terrainAvoidance,
      terrain: this.terrainField,
      visibility: this.visibility,
      missionRadius: this.config.missionRadius,
      seed: this.config.seed,
      aggressive: this.config.combat,
      getTarget: () => this.simulation.player,
      // Its own airframe, held to the one the player is flying: a survey wing
      // is slower than an interceptor and should fly like it, and nothing is
      // allowed to be quicker than the aircraft sent to catch it.
      speedReference: this.fieldSpeed(uav),
    });
    this.enemyPilots.set(id, pilot);

    const state = this.simulation.spawn(
      {
        id,
        role: AIRCRAFT_ROLE.Enemy,
        config: uav.config,
        position: { ...position },
        headingDeg: this.spawnRng.range(0, 360),
        // Enough to be flying whatever it is: a wing arrives at a cruise, and
        // a quadcopter is simply hanging on its rotors.
        airspeed: uav.config.rotor ? 0 : 24,
        throttle: uav.config.rotor
          ? hoverThrottle(uav.config)
          : difficulty.patrolThrottle,
        warhead: this.warhead,
      },
      pilot.control,
    );
    this.addFieldVisual(id, uav, ENEMY_TINT);
    this.renderer.update(state);
    return state;
  }

  /**
   * The airframe the next contact is flying.
   *
   * Dealt from the mission's opposition setting on the mission seed, by the
   * contact's own number — so the same mission always puts the same aircraft
   * up, and a field asked for every type in the hangar gets every type.
   */
  private contactAircraft(): Uav {
    return this.fieldAircraft(this.enemyCount);
  }

  /**
   * The airframe the `index`th of everybody else is flying.
   *
   * One dealer for the whole sky: a contact, a rival on the grid, a slot in
   * the flight, somebody's model at the fly-in. Which mission it is decides
   * what that aircraft is doing up there and nothing else — what it is, is
   * the pilot's choice, dealt on the mission seed.
   */
  private fieldAircraft(index: number): Uav {
    return oppositionAircraft(this.config.opposition, this.config.seed, index);
  }

  /**
   * The speed the pilot of one of them is held to, m/s.
   *
   * Its own airframe, and never more than the one the player is flying: a
   * contact that cannot be caught, a leader that cannot be stayed with and a
   * grid that cannot be seen after the first gate are all the same mission
   * being flown away from.
   */
  private fieldSpeed(uav: Uav): number {
    return contactSpeedReference(uav.config, this.loadout.config);
  }

  /**
   * Draws one of the others as the aircraft it actually is.
   *
   * The tint is what says whose side it is on; the geometry, the size and the
   * paint under the tint are the airframe's own, so a 2.1 m survey wing is
   * recognisable as one at the range you first see it.
   */
  private addFieldVisual(
    id: string,
    uav: Uav,
    tint: readonly [number, number, number],
  ): void {
    this.renderer.add(
      id,
      tint,
      false,
      uav.config.wingSpan,
      uav.defaultLivery,
      meshKindFor(uav.config),
    );
  }

  /**
   * Places the mission's contacts.
   *
   * Positions come from the mission seed, so the same mission always puts the
   * same aircraft in the same places. Each point is then validated against the
   * real terrain — a single batched elevation request rather than a guess —
   * because a contact spawned inside a mountain is not a contact.
   */
  private async placeMissionEnemies(): Promise<void> {
    const player = this.simulation.player;
    if (!player) return;

    const maxRange = Math.min(5000, this.config.missionRadius * 0.85);
    const points = generateSpawnPoints({
      seed: this.config.seed,
      count: this.config.enemyCount,
      centre: player.position,
      minRange: Math.min(600, maxRange * 0.5),
      maxRange,
      baseAltitude: player.position.z,
      altitudeSpread: 260,
    });

    // Validate against the actual ground, not the sparse in-flight cache.
    let grounds: readonly (number | null)[] = [];
    try {
      grounds = await this.terrainProbe(
        points.map((point) => ({ x: point.x, y: point.y })),
      );
    } catch {
      grounds = points.map(() => null);
    }

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i] as Vec3;
      containWithin(point, this.config.missionRadius * 0.92);
      const ground = grounds[i];
      if (ground !== null && ground !== undefined) {
        point.z = Math.max(point.z, ground + ENEMY_SPAWN_CLEARANCE);
      }
      // Never below the player's own launch height either.
      point.z = Math.max(point.z, MIN_ENEMY_ALTITUDE);
      this.createEnemy(point);
    }

    this.mission.setEnemyCount(points.length);
  }

  // --- Strike --------------------------------------------------------------

  /**
   * Puts one transiting contact in the air.
   *
   * Whichever airframe the opposition setting deals it, on the identical
   * flight model, and a route across the mission area generated from the
   * mission seed. What it does not get is a reason to care about the player: a
   * `TransitPilot` has no perception at all, so this contact will fly its route
   * with an interceptor sitting on its tail and never once turn to look at it.
   */
  private createTransitContact(position: Vec3): AircraftState {
    const uav = this.contactAircraft();
    this.enemyCount += 1;
    this.transitCount += 1;
    const id = `transit-${this.transitCount}`;

    const route = generateTransitRoute({
      seed: `${this.config.seed}:${id}`,
      missionRadius: this.config.missionRadius,
      baseAltitude: position.z,
      terrain: this.terrainField,
      terrainMargin: TRANSIT_TERRAIN_MARGIN,
    });

    const pilot = new TransitPilot({
      id,
      route,
      terrain: this.terrainField,
      terrainAvoidance: this.terrainAvoidance,
      missionRadius: this.config.missionRadius,
      seed: this.config.seed,
      // Its own airframe, held to the one the player is flying, so a transit
      // flies at the speed that aeroplane actually cruises at and can still
      // always be run down from behind.
      speedReference: this.fieldSpeed(uav),
    });
    this.transitPilots.set(id, pilot);

    const state = this.simulation.spawn(
      {
        id,
        role: AIRCRAFT_ROLE.Enemy,
        config: uav.config,
        position: { ...position },
        // Already pointing at the first destination: a contact that has been
        // transiting since before the mission started is not still turning
        // onto its route when the pilot arrives.
        headingDeg: TransitPilot.openingHeadingDeg(position, route),
        airspeed: uav.config.rotor ? 0 : 22,
        throttle: uav.config.rotor ? hoverThrottle(uav.config) : 0.55,
        warhead: this.warhead,
      },
      pilot.control,
    );
    this.addFieldVisual(id, uav, TRANSIT_TINT);
    this.renderer.update(state);
    return state;
  }

  /**
   * Places a strike: the transit, and whatever is escorting it.
   *
   * The transit is spread around the mission area rather than around the pilot,
   * because it is crossing the area rather than looking for anybody — finding
   * it is the first half of the mission. The escorts, which are ordinary
   * hunting contacts, are placed the way an interception's are.
   *
   * Both sets of points are validated against the real terrain in one batched
   * elevation request, for the same reason the interception does it: a contact
   * spawned inside a mountain is not a contact.
   */
  private async placeStrikeContacts(): Promise<void> {
    const player = this.simulation.player;
    if (!player) return;

    const settings = this.config.strike ?? DEFAULT_STRIKE;
    const contacts = Math.max(0, Math.round(this.config.enemyCount));
    const escorts = clampEscortCount(settings.escortCount);

    const maxRange = Math.min(6000, this.config.missionRadius * 0.85);
    const transit = generateSpawnPoints({
      seed: `${this.config.seed}:transit`,
      count: contacts,
      centre: player.position,
      // Further out than an interception's ring: these are contacts to be
      // found and closed on, not contacts already overhead.
      minRange: Math.min(1400, maxRange * 0.6),
      maxRange,
      baseAltitude: player.position.z,
      altitudeSpread: 220,
    });
    const guard = generateSpawnPoints({
      seed: `${this.config.seed}:escort`,
      count: escorts,
      centre: player.position,
      minRange: Math.min(900, maxRange * 0.5),
      maxRange,
      baseAltitude: player.position.z,
      altitudeSpread: 260,
    });

    const points = [...transit, ...guard];
    let grounds: readonly (number | null)[] = [];
    try {
      grounds = await this.terrainProbe(
        points.map((point) => ({ x: point.x, y: point.y })),
      );
    } catch {
      grounds = points.map(() => null);
    }

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i] as Vec3;
      containWithin(point, this.config.missionRadius * 0.92);
      const ground = grounds[i];
      if (ground !== null && ground !== undefined) {
        point.z = Math.max(point.z, ground + ENEMY_SPAWN_CLEARANCE);
      }
      point.z = Math.max(point.z, MIN_ENEMY_ALTITUDE);
      if (i < transit.length) this.createTransitContact(point);
      else this.createEnemy(point);
    }

    this.mission.setEnemyCount(points.length);
  }

  /** How one transiting contact is flying its route, for the debug overlay. */
  transitDebug(id: string | null): TransitPilotDebug | null {
    if (!id) return null;
    return this.transitPilots.get(id)?.debug ?? null;
  }

  /** F2 — put one more interceptor up near the player, for development. */
  spawnEnemy(): AircraftState | null {
    const player = this.simulation.player;
    if (!player || !isAirworthy(player.status)) return null;

    const bearing = this.spawnRng.range(0, 360) * DEG_TO_RAD;
    const range = this.spawnRng.range(900, 4000);
    const x = player.position.x + Math.sin(bearing) * range;
    const y = player.position.y + Math.cos(bearing) * range;
    const groundZ = this.terrainField.heightAt(x, y);
    const z = Math.max(
      player.position.z + this.spawnRng.range(-150, 250),
      groundZ + ENEMY_SPAWN_CLEARANCE,
    );

    const state = this.createEnemy(vec3(x, y, z));
    this.mission.setEnemyCount(this.enemyCount);
    return state;
  }

  /** The AI state of one enemy, for the debug overlay. */
  enemyDebug(id: string | null): EnemyDebugState | null {
    if (!id) return null;
    return this.enemyPilots.get(id)?.debug ?? null;
  }

  /**
   * F1, and every replacement airframe — put the player back at the start,
   * launched the same way the first one was.
   */
  resetPlayer(): void {
    // A replacement airframe goes back into the launcher's hand, and the
    // ground under a held wing is what holds it at head height rather than in
    // the hillside. Worth a couple of rounds to be sure of again, however
    // settled the question was when the last one left.
    this.launchSettling.disturb();
    const player = this.simulation.player;
    if (!player) {
      this.spawnPlayer();
      return;
    }
    this.simulation.remove(player.id);
    this.renderer.remove(player.id);
    this.explosions.endTrail(player.id);
    this.mission.streamers?.detach(player.id);
    this.controls.reset(this.launch.throttle);
    this.flightModes.reset();
    this.spawnPlayer();
  }

  // --- Frame loop ----------------------------------------------------------

  private onFrame(): void {
    if (this.disposed) return;
    // Nothing is flown until there is something to fly. Leaving the clock
    // alone as well as the simulation means the first frame of the flight is
    // the first frame of the flight, rather than one carrying however long the
    // world took to finish arriving.
    if (!this.underWay || this.loading) return;

    const now = performance.now();
    const elapsedMs = this.lastFrameTime === 0 ? 16 : now - this.lastFrameTime;
    this.lastFrameTime = now;
    const dt = Math.min(elapsedMs / 1000, 0.25);

    // Read the controller first: its buttons stand in for hotkeys, and they
    // have to work while the simulation is stopped as well as while it runs.
    this.controls.poll();
    this.pollHotkeys();

    if (!this.paused) {
      this.simulation.update(dt);
      this.calibrateSurface(dt);
      this.drainEvents();
      this.runMission(dt);
      this.updateExplosions(dt);
      // The gate being flown at is drawn differently from the rest, so the
      // course itself says which one is next without reading a number.
      if (this.raceGates && this.mission.race) {
        this.raceGates.setNextGate(this.mission.race.playerGate);
      }
    }

    this.drawFlight();

    const player = this.simulation.player;
    if (player) {
      if (!this.paused) {
        this.environment.update(player.position, this.simulation.wind, dt);
        this.visibility.setDaylight(this.environment.daylight);
        this.playThunder();
      }
      // The pilot is standing on ground that may still be settling under them,
      // and on a surface that is still arriving over it: a canopy resolves as
      // its tiles do, so the launch area is re-measured rather than believed
      // once.
      if (this.cameraRig.hasStation) {
        if (!this.paused) this.refreshLaunchSurface(dt);
        this.placePilotOnTheField();
      }
      this.cameraRig.update(player, this.paused ? 0 : dt);
      // You cannot see your own airframe from inside the FPV camera.
      this.renderer.setVisible(player.id, !this.cameraRig.hidesOwnAircraft);
    }

    this.updateSound();
    this.controls.endFrame();
    this.trackFps(elapsedMs);
  }

  /**
   * Puts everything the simulation owns where the simulation says it is.
   *
   * Split out of the frame loop because the warm-up runs it too: whatever a
   * collection has to build the first time it is handed something — the
   * aircraft primitives, the ribbons at a fly-in — is built the first time
   * this runs, and that is worth doing under a loading screen rather than in
   * the pilot's opening frame.
   */
  private drawFlight(): void {
    for (const aircraft of this.simulation.aircraft) {
      if (aircraft.status === FLIGHT_STATUS.Destroyed) {
        this.renderer.setVisible(aircraft.id, false);
        continue;
      }
      this.renderer.update(aircraft);
    }
    // Drawn even while paused, so a fireball is still on screen when the
    // mission-over panel comes up over it. The paper is the same: a slot that
    // ends mid-pass leaves the ribbon where it was.
    this.explosionRenderer.draw(this.explosions);
    const streamers = this.mission.streamers;
    if (streamers) {
      this.streamerRenderer ??= new StreamerRenderer(
        this.cesium,
        this.viewer.scene,
        this.frame,
      );
      this.streamerRenderer.draw(streamers);
    }
  }

  /**
   * The sound of any lightning that has just fired.
   *
   * The flash is instantaneous and the crack is not, so each strike carries
   * the delay its own distance implies and the soundscape schedules the sound
   * that far ahead. Counting the seconds between the two is the oldest
   * instrument in aviation and it works here exactly as it does outside.
   */
  private playThunder(): void {
    if (!this.sound) return;
    for (const strike of this.environment.consumeStrikes()) {
      this.sound.cue(
        SOUND_CUE.Thunder,
        // Distant thunder is a rumble at the edge of hearing; a strike inside
        // a kilometre is the loudest thing in the flight.
        clamp(1 - strike.distance / 14000, 0.12, 1),
        strike.thunderDelay,
      );
    }
  }

  /**
   * Puts the mission's explosions and smoke where they belong.
   *
   * Bursts come from the simulation, which is the only thing that knows a
   * charge went off; the trails are read straight off the airframes, because
   * "how badly is this aircraft burning" is a property of the aircraft and not
   * an event that happened once.
   */
  private updateExplosions(dt: number): void {
    // Trails are drawn as finely as the screen can show them, which depends on
    // where they are being watched from. The aircraft rather than the camera:
    // a chase camera sits a few metres behind it, and nothing here is decided
    // at that scale.
    this.explosions.setViewpoint(this.simulation.player?.position ?? null);

    for (const blast of this.simulation.drainBlasts()) {
      this.explosions.burst(
        blast.kind,
        blast.position,
        blast.velocity,
        blast.strength,
      );
    }

    for (const aircraft of this.simulation.aircraft) {
      const smoke = smokeIntensity(aircraft);
      if (smoke > 0) {
        this.explosions.trail(
          aircraft.id,
          aircraft.position,
          aircraft.velocity,
          smoke,
          dt,
        );
      } else {
        this.explosions.endTrail(aircraft.id);
      }
    }

    // Smoke goes where the air goes; everything else is over too quickly to
    // notice the wind.
    this.explosions.update(dt, this.simulation.wind);
  }

  /**
   * Re-measures the launch area until it stops changing.
   *
   * What this is for has not changed: a canopy resolves as its tiles do, and a
   * pilot left at the height the loading screen went on is standing under the
   * version of the wood that had arrived by then. What has changed is that it
   * stops. Nobody on a field moves — the stand and the launch point are the two
   * fixed things in the whole simulator — so once consecutive rounds return the
   * same surface there is nothing left to find, and going on asking is the most
   * expensive thing in the frame. See `sim/terrain/settling.ts`.
   *
   * Not asked at all where the globe is the only surface there is. The height
   * field *is* the globe on terrain-only scenery, `readGlobeSurface` follows it
   * as it refines for free, every frame, and a pick can only agree with what
   * the free reading already said.
   */
  private refreshLaunchSurface(dt: number): void {
    if (this.scenery.tilesets.length === 0) return;
    if (!this.launchSettling.begin(dt)) return;
    void this.settleLaunchSurface();
  }

  /** One round of the above, reported back to the settling that asked for it. */
  private async settleLaunchSurface(): Promise<void> {
    const readings = await this.measureLaunchSurface(this.observeSurface);
    if (this.disposed) return;
    // A round that never ran — one was already out — is not evidence of
    // anything, so it neither settles the question nor unsettles it.
    if (readings === null) this.launchSettling.abandon();
    else this.launchSettling.finish(readings);
  }

  /**
   * Keeps the flown surface on the drawn one.
   *
   * The terrain field is sampled from elevation data; a photorealistic tileset
   * draws a mesh of its own that sits a metre or two off it, and the globe is
   * not shown underneath to give the difference away. Left alone, an aircraft
   * put down on a runway stops in mid-air above it. So the drawn surface is
   * picked under the aircraft a couple of times a second and the field is
   * offset by the difference — but only where the offset is measurable and
   * consistent, which is what `SurfaceCalibration` decides.
   *
   * One pick is in flight at a time and each is a whole render pass, so this
   * runs on a timer rather than a frame count, and not at all up high where a
   * couple of metres of ground is nothing to anybody.
   */
  private calibrateSurface(dt: number): void {
    const calibration = this.surfaceCalibration;
    if (!calibration) return;
    // Eased every frame, whether or not a measurement arrives, so the offset
    // fades out rather than sticking when picking stops working.
    calibration.update(dt);
    this.terrainField.setSurfaceBias(calibration.bias);

    const player = this.simulation.player;
    if (!player || !isAirworthy(player.status)) return;
    if (player.altitudeAgl > SURFACE_PICK_CEILING) return;

    this.surfacePickTimer += dt;
    if (this.surfacePickTimer < SURFACE_PICK_INTERVAL) return;
    if (this.surfacePickPending) return;
    this.surfacePickTimer = 0;
    this.surfacePickPending = true;

    const x = player.position.x;
    const y = player.position.y;
    // The correction already in the field has to come off the comparison, or
    // each round would measure its own output and the offset would run away.
    const sampled = this.terrainField.heightAt(x, y) - this.terrainField.surfaceBias;

    void this.pickSurface(x, y)
      .then((drawn) => {
        if (this.disposed || drawn === null) return;
        calibration.observe(drawn, sampled);
      })
      .finally(() => {
        this.surfacePickPending = false;
      });
  }

  /**
   * Advances the mission and acts on what it decides.
   *
   * The runner says *what* happened; putting an aircraft in the air is this
   * side's job, which is what keeps the win/lose rules testable without a
   * renderer.
   */
  private runMission(dt: number): void {
    const events = this.mission.update(this.simulation, dt);
    if (events.length === 0) return;
    for (const event of events) {
      if (event.type === "RELAUNCH") {
        this.resetPlayer();
        this.sound?.cue(SOUND_CUE.Launch);
      } else if (event.type === "FESTIVAL_RECALL") {
        // The line is called down. Everybody still up flies an approach and
        // puts it on the field; nothing is taken out of the sky.
        for (const pilot of this.festivalPilots.values()) pilot.recall();
      } else if (event.type === "FESTIVAL_WAVE") {
        // The field is clear, so it goes up again — wreckage cleared away
        // first, the way it is at a real one.
        this.launchFestivalWave();
      } else if (event.type === "STREAMER_CUT") {
        // Only the pilot's own passes make a noise. Fifty aircraft cutting
        // each other's paper all afternoon is the event working, not something
        // to be told about — but taking a piece off somebody yourself is the
        // one thing in the whole slot worth hearing, and how much of it came
        // off decides how bright it is.
        if (event.cut.cutterIsPlayer) {
          this.sound?.cue(
            SOUND_CUE.Gate,
            clamp(event.cut.length / STREAMER_LENGTH, 0, 1),
          );
        }
      } else if (event.type === "GATE") {
        // The finish has the mission-complete fanfare right behind it, so it
        // gets no chirp of its own. The rest ring by how far round the course
        // they are, so a gate says where in the race it was as well as that it
        // was flown through.
        if (!event.isFinish) {
          const along =
            event.gateCount > 1 ? event.gateIndex / (event.gateCount - 1) : 0;
          this.sound?.cue(SOUND_CUE.Gate, along);
        }
      } else if (event.type === "COMPLETE") {
        this.sound?.cue(SOUND_CUE.MissionComplete);
      } else if (event.type === "FAILED") {
        this.sound?.cue(SOUND_CUE.MissionFailed);
      }
      this.callbacks.onMissionEvent?.(event, this.mission.status);
    }
  }

  private pollHotkeys(): void {
    for (const action of HOTKEY_ACTIONS) {
      if (!this.controls.consumeAction(action)) continue;
      if (action === KEY_ACTION.Camera) {
        this.cameraRig.toggle();
      } else if (action === KEY_ACTION.FreeCamera) {
        this.cameraRig.setMode(
          this.cameraRig.getMode() === CAMERA_MODE.Free
            ? CAMERA_MODE.Chase
            : CAMERA_MODE.Free,
        );
      } else if (action === KEY_ACTION.ResetAircraft) {
        this.resetPlayer();
      } else if (action === KEY_ACTION.SpawnEnemy) {
        this.spawnEnemy();
      } else if (action === KEY_ACTION.CycleTarget) {
        this.simulation.cycleTarget();
      } else if (action === KEY_ACTION.FlightMode) {
        this.flightModes.cycleMode();
      } else if (action === KEY_ACTION.CourseHold) {
        this.flightModes.toggleCourseHold();
      } else if (action === KEY_ACTION.AltitudeHold) {
        this.flightModes.toggleAltitudeHold();
      } else if (action === KEY_ACTION.ReturnHome) {
        this.flightModes.toggleReturnHome();
      }
      this.callbacks.onHotkey?.(action);
    }
  }

  /**
   * Clears the simulation's event queues.
   *
   * The mission runner decides what a loss means, so nothing is forwarded from
   * here; draining just stops the queues growing.
   */
  private drainEvents(): void {
    for (const crash of this.simulation.drainCrashes()) {
      // A crash the player did not witness is still worth hearing when it is
      // close: a contact going into a hillside a hundred metres away is
      // information. Distant ones are dropped by the cue cooldown.
      if (crash.aircraftId === PLAYER_ID) {
        this.sound?.cue(SOUND_CUE.Crash, impactStrength(crash.impactSpeed));
      }
    }
    for (const landing of this.simulation.drainLandings()) {
      // A belly landing is a scrape, not a bang: the crash cue at a fraction of
      // its strength is exactly the noise a wing makes arriving on a field.
      if (landing.aircraftId !== PLAYER_ID) continue;
      this.sound?.cue(
        SOUND_CUE.Touchdown,
        impactStrength(landing.touchdownSpeed) * 0.5,
      );
    }
    for (const contact of this.simulation.drainContacts()) {
      // A charge going off and two airframes touching are not the same event
      // and must not sound like it: the fuze is what decides which is heard.
      this.sound?.cue(
        contact.explosion ? SOUND_CUE.Explosion : SOUND_CUE.Collision,
        impactStrength(contact.closingSpeed),
      );
    }
  }

  /**
   * Retunes the motor and the airframe rush.
   *
   * A destroyed aircraft stops its motor but keeps falling, so the rush stays
   * until the wreckage is gone — silence at the moment of impact would read as
   * a bug rather than as a crash.
   *
   * The airframe's condition goes with it, so a machine that has been into
   * another one is heard to have been: the motor loses revs and tone, picks up
   * a wash of broken-blade noise, and beats once per turn of a shaft that is no
   * longer true — more of all of it with every contact.
   */
  private updateSound(): void {
    const sound = this.sound;
    if (!sound) return;
    const player = this.simulation.player;
    sound.update({
      throttle: player?.throttle ?? 0,
      airspeed: player?.airspeed ?? 0,
      powered: player !== null && isAirworthy(player.status),
      condition: player?.damage ?? null,
    });

    const targetId = this.simulation.target?.id ?? null;
    if (targetId !== this.lastTargetId) {
      if (targetId !== null) sound.cue(SOUND_CUE.TargetDetected);
      this.lastTargetId = targetId;
    }
  }

  private trackFps(elapsedMs: number): void {
    this.fpsAccumulator += elapsedMs;
    this.fpsFrames += 1;
    this.stats.frameMs = elapsedMs;
    if (this.fpsAccumulator >= 500) {
      this.stats.fps = (this.fpsFrames * 1000) / this.fpsAccumulator;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
  }

  /**
   * What was fetched before the flight started, for the debug overlay.
   *
   * The rate is measured and shown, and nothing acts on it: a flight draws the
   * preset it was given until the pilot lands. A rate that will not hold is
   * answered with a lower preset before the next flight, by the person flying
   * it, rather than by the scene quietly softening under them.
   */
  get preloadStatus(): PreloadPlan {
    return this.preload;
  }

  // --- Controls ------------------------------------------------------------

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.controls.releaseAll();
    this.sound?.setMuted(paused);
    // Reset the frame clock so unpausing does not simulate the pause away.
    this.lastFrameTime = 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get cameraMode(): CameraMode {
    return this.cameraRig.getMode();
  }

  toggleCamera(): CameraMode {
    return this.cameraRig.toggle();
  }

  setCameraSettings(settings: Partial<CameraSettings>): void {
    this.cameraRig.setSettings(settings);
  }

  setFlightSensitivity(value: number): void {
    this.controls.setFlightSensitivity(value);
  }

  /** Swaps the key layout without interrupting the flight. */
  setKeyBindings(bindings: KeyBindings): void {
    this.controls.setBindings(bindings);
  }

  /**
   * Re-tunes the flight controller mid-flight.
   *
   * Whatever is engaged stays engaged: a pilot who widens the bank limit from
   * the pause menu wants a wider turn, not their altitude hold dropped.
   */
  setFlightModeSettings(settings: FlightModeSettings): void {
    this.flightModes.setSettings(settings);
  }

  /**
   * Retunes the rates mid-flight.
   *
   * Which aircraft is being flown is fixed when it is spawned — an airframe
   * cannot be swapped in the air — but how hard it answers the sticks is a
   * number, and a pilot setting rates wants to feel the change on the flight
   * they are setting them from.
   */
  setControlRates(rates: ControlRates): void {
    this.flightModes.setRates(rates);
  }

  /** The aircraft being flown. */
  get playerUav(): Uav {
    return this.uav;
  }

  /** What the flight controller is doing, for the OSD to report. */
  get flightModeStatus(): ReturnType<FlightModeController["describe"]> {
    return this.flightModes.describe();
  }

  setAudioVolume(volume: number): void {
    this.sound?.setVolume(volume);
  }

  get audioRunning(): boolean {
    return this.sound?.running ?? false;
  }

  /** Retried from an input handler when a browser wanted a gesture first. */
  resumeAudio(): void {
    void this.sound?.resume();
  }

  setControllerSensitivity(value: number): void {
    this.controls.setControllerSensitivity(value);
  }

  /** Swaps the controller mapping without interrupting the flight. */
  setControllerProfile(profile: ControllerProfile | null): void {
    this.controls.setProfile(profile);
  }

  /** Which device is flying the aircraft right now. */
  get activeInputDevice(): InputDevice {
    return this.controls.activeDevice;
  }

  get controllerConnected(): boolean {
    return this.controls.controllerConnected;
  }

  get controllerName(): string | null {
    return this.controls.controllerName;
  }

  telemetry(): FlightTelemetry {
    const t = this.simulation.telemetry();
    const modes = this.flightModes.describe();
    t.flightMode = modes.mode;
    t.courseHold = modes.courseHold;
    t.altitudeHold = modes.altitudeHold;
    t.returnHome = modes.returnHome;
    t.rthStage = modes.rthStage;
    t.heldCourse = modes.heldCourse;
    t.homeDistance = modes.homeDistance;
    t.homeBearing = modes.homeBearing;
    // The controller holds a height in local metres; the instruments read
    // geodetic. The player's own two readings give the offset between them,
    // so the held altitude lands on the same scale as the one beside it.
    const player = this.simulation.player;
    t.heldAltitude = player
      ? modes.heldAltitude + (t.altitude - player.position.z)
      : modes.heldAltitude;
    return t;
  }

  /**
   * Where the tracked target is relative to the view. Recomputed on demand and
   * returned in a reused object, so the HUD can call it every frame without
   * allocating.
   */
  targetView(): HudTargetView {
    const view = this.targetViewSnapshot;
    view.active = false;

    const player = this.simulation.player;
    const target = this.simulation.target;
    if (!player || !target || !isAirworthy(player.status)) {
      return view;
    }

    V.subtract(this.relative, target.position, player.position);
    view.distance = V.length(this.relative);
    view.bearingDeg =
      (Math.atan2(this.relative.x, this.relative.y) * RAD_TO_DEG + 360) % 360;
    view.visibility = this.visibility.targetVisibility(player, target);

    const position = this.simulation.targetPosition();
    view.index = position.index;
    view.count = position.count;

    this.projectWorldPoint(target.position, view);
    view.active = true;
    return view;
  }

  /**
   * Puts one local point on screen: where it is, whether it is in view, and
   * where an off-screen marker for it belongs on the rim.
   *
   * Shared by the target box, the formation slot and the race gate, which are
   * the same question asked about three different points in the sky.
   *
   * `edgeInset` moves an off-screen marker further in from the rim. Two
   * markers pinned to the same edge otherwise land on top of each other, and
   * in a race that is exactly what happens whenever the gate and the rival
   * you are racing are both behind the same wing.
   */
  private projectWorldPoint(
    point: Vec3,
    view: ProjectedPoint,
    edgeInset = 1,
  ): void {
    const pose = this.cameraRig.pose;
    targetScreenDirection(
      pose.position,
      pose.direction,
      pose.up,
      pose.right,
      point,
      this.screenDirection,
    );
    view.dirX = this.screenDirection.x;
    view.dirY = this.screenDirection.y;

    const canvas = this.viewer.scene.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    view.onScreen = false;
    if (this.screenDirection.inFront) {
      this.frame.localToEcef(point, this.ecefScratch);
      this.targetCartesian.x = this.ecefScratch.x;
      this.targetCartesian.y = this.ecefScratch.y;
      this.targetCartesian.z = this.ecefScratch.z;
      const projected = this.cesium.SceneTransforms.worldToWindowCoordinates(
        this.viewer.scene,
        this.targetCartesian,
        this.windowScratch,
      );
      if (projected) {
        view.screenX = projected.x;
        view.screenY = projected.y;
        view.onScreen = isOnScreen(projected.x, projected.y, width, height, 48);
      }
    }

    clampToViewportEdge(
      width,
      height,
      Math.min(width * 0.15, 168) * edgeInset,
      Math.min(height * 0.1, 84) * edgeInset,
      view.dirX,
      view.dirY,
      this.edgePoint,
    );
    view.edgeX = this.edgePoint.x;
    view.edgeY = this.edgePoint.y;
  }

  get viewportSize(): { width: number; height: number } {
    const canvas = this.viewer.scene.canvas;
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  get playerState(): AircraftState | null {
    return this.simulation.player;
  }

  /**
   * What the goggles are showing. Null when range is not being simulated.
   *
   * The same object every call — the overlay reads it once per frame and never
   * retains it.
   */
  get videoLink(): VideoLinkState | null {
    const link = this.simulation.videoLink;
    return link && link.enabled ? link.state : null;
  }

  get playerStatus(): string {
    return this.simulation.player?.status ?? FLIGHT_STATUS.Destroyed;
  }

  setEnvironmentToggles(toggles: {
    clouds?: boolean;
    volumetricClouds?: boolean;
    rain?: boolean;
    effects?: boolean;
  }): void {
    this.environment.setToggles(toggles);
  }

  /** The weather currently being flown in, which may not be the one launched. */
  get weather(): Weather {
    return this.currentWeather;
  }

  /** The time of day currently being flown in. */
  get timeOfDay(): TimeOfDay {
    return this.currentTimeOfDay;
  }

  /** The date and time being flown at, when the mission set one. */
  get clock(): MissionClock | undefined {
    return this.currentClock;
  }

  /**
   * The instant being flown at, written out for the debug panel.
   *
   * Stated in the zone the clock was set in, so a pilot who typed a local time
   * reads back the time they typed rather than having to undo the offset in
   * their head. Without a clock it is the preset's own day, in local time.
   */
  get clockLabel(): string {
    return formatInstant(
      this.environment.time,
      this.currentClock?.zone ?? TIME_ZONE.Local,
      this.config.longitude,
    );
  }

  /** How much of the sky the cloud is filling, 0..1. */
  get cloudCover(): number {
    return this.currentProfile.cloudCoverage;
  }

  /** The whole sky being flown in, when one was given rather than a preset. */
  get sky(): WeatherState | undefined {
    return this.currentSky;
  }

  /**
   * Changes the sky mid-flight: the weather, the cloud in it, or all of it.
   *
   * Weather reaches the flight through three separate paths — the scene, what
   * can be seen through it, and the air the aircraft is flying in — and all
   * three have to move together or the pilot ends up looking at rain while
   * flying in a light summer breeze. Cloud cover travels with them rather than
   * on its own, and for the same reason: picking a weather brings that
   * weather's own cover with it, and applying the two in separate steps would
   * lay out a cloud layer for a sky nobody asked for and throw it away again
   * on the next line.
   *
   * A whole `sky` arrives the same way and takes precedence over both, so the
   * pause menu can hand over a hand-built or freshly fetched day and have the
   * flight simply be in it.
   */
  setSky(
    weather: Weather,
    cloudCover: number | undefined,
    sky?: WeatherState,
  ): void {
    if (
      this.disposed ||
      (weather === this.currentWeather &&
        cloudCover === this.currentCloudCover &&
        sky === this.currentSky)
    ) {
      return;
    }
    this.currentWeather = weather;
    this.currentCloudCover = cloudCover;
    this.currentSky = sky;
    this.applyWeather();
  }

  /** Pushes the weather now being flown in out to everything that reads it. */
  private applyWeather(): void {
    const profile = missionWeather({
      weather: this.currentWeather,
      cloudCover: this.currentCloudCover,
      sky: this.currentSky,
    });
    this.currentProfile = profile;
    this.environment.setWeather(profile);
    this.visibility.setWeather(profile);
    this.visibility.setCloudLayers(this.environment.cloudLayers);
    this.windField.setProfile(profile.wind);
  }

  /**
   * Moves the sun mid-flight, without restarting.
   *
   * The clock travels with the time of day rather than on its own: editing the
   * date is a move of the same sun, and applying the two separately would put
   * the flight through an instant nobody asked for on the way.
   */
  setTimeOfDay(timeOfDay: TimeOfDay, clock?: MissionClock): void {
    if (
      this.disposed ||
      (timeOfDay === this.currentTimeOfDay && clock === this.currentClock)
    ) {
      return;
    }
    this.currentTimeOfDay = timeOfDay;
    this.currentClock = clock;
    this.environment.setTimeOfDay(TIME_PROFILES[timeOfDay], clock);
    this.visibility.setDaylight(this.environment.daylight);
  }

  /** Cells in the close-in grid, and the offset onto the drawn surface. */
  get terrainDetail(): { cells: number; surfaceBias: number } {
    return {
      cells: this.terrainField.detailCells,
      surfaceBias: this.terrainField.surfaceBias,
    };
  }

  get terrainCacheSize(): number {
    return this.terrainField.cachedCells;
  }

  get terrainRequestsInFlight(): number {
    return this.terrainField.requestsInFlight;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeListener();
    this.controls.detach();
    this.sound?.destroy();
    this.environment.destroy();
    this.raceGates?.destroy();
    this.raceGates = null;
    this.streamerRenderer?.destroy();
    this.streamerRenderer = null;
    this.renderer.destroy();
    this.explosionRenderer.destroy();
    this.explosions.clear();
    this.simulation.dispose();
    this.scenery.destroy();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}

// --- Helpers ----------------------------------------------------------------

/**
 * The weather profile a mission is actually flown in.
 *
 * A hand-built sky if there is one, otherwise the preset with the pilot's
 * cloud cover laid over it. One function, because the profile has to come out
 * the same everywhere it is asked for: the scene, the visibility model and the
 * wind all read it, and a sky that is empty in one of them and overcast in
 * another is worse than either.
 */
function missionWeather(config: {
  readonly weather: Weather;
  readonly cloudCover?: number;
  readonly sky?: WeatherState;
}): WeatherProfile {
  if (config.sky) return resolveWeatherProfile(config.sky);
  const profile = WEATHER_PROFILES[config.weather];
  return config.cloudCover === undefined
    ? profile
    : withCloudCover(profile, config.cloudCover);
}

/**
 * Parks the camera where the aircraft will spawn so Cesium prioritises those
 * tiles while the loading screen is still up.
 */
function aimCameraAtSpawn(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
  config: FlightMissionConfig,
  terrainHeight: number,
  heightAgl: number,
  bearingOffsetDeg = 0,
  pitchDeg = -8,
): void {
  // Behind the spawn, looking along the start heading: the tiles worth having
  // ready are the ones the flight opens facing, and on a chosen heading those
  // are no longer the ones due north. An offset swings the same standoff round
  // the field, which is how the preload sweep asks for the rest of the compass;
  // a steeper pitch and a greater height is how it asks for the distance.
  const headingDeg =
    clampStartHeading(config.startHeadingDeg ?? DEFAULT_START_HEADING_DEG) +
    bearingOffsetDeg;
  const heading = cesium.Math.toRadians(headingDeg);
  const latitude = clampLatitude(
    config.latitude - Math.cos(heading) * CAMERA_STANDOFF_DEG,
  );
  const cosine = Math.max(
    1e-6,
    Math.cos(cesium.Math.toRadians(config.latitude)),
  );
  const longitude = normaliseLongitude(
    config.longitude - (Math.sin(heading) * CAMERA_STANDOFF_DEG) / cosine,
  );

  viewer.camera.setView({
    destination: cesium.Cartesian3.fromDegrees(
      longitude,
      latitude,
      terrainHeight + heightAgl,
    ),
    orientation: {
      heading,
      pitch: cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
  });
}

/**
 * Waits until Cesium has finished streaming the tiles around the spawn point,
 * so flight never begins over a blank globe. Times out rather than blocking
 * forever on a slow connection.
 */
function waitForTiles(
  viewer: Cesium.Viewer,
  onProgress: (fraction: number) => void,
  timeoutMs = TILE_WAIT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    if (viewer.isDestroyed()) {
      resolve();
      return;
    }
    const globe = viewer.scene.globe;
    if (globe.tilesLoaded) {
      onProgress(1);
      resolve();
      return;
    }

    let peakQueue = 1;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      // A flight abandoned on the loading screen takes the viewer with it, and
      // the event this was listening to went with it.
      if (!viewer.isDestroyed()) {
        globe.tileLoadProgressEvent.removeEventListener(onQueue);
      }
      clearTimeout(timeout);
      onProgress(1);
      resolve();
    };

    const onQueue = (queued: number): void => {
      peakQueue = Math.max(peakQueue, queued);
      onProgress(1 - queued / peakQueue);
      // Cesium reports 0 when the queue drains.
      if (queued === 0) finish();
    };

    const timeout = setTimeout(finish, timeoutMs);
    globe.tileLoadProgressEvent.addEventListener(onQueue);
  });
}

/**
 * One turn of the browser's render loop.
 *
 * Backstopped by a timer because a backgrounded tab stops handing out
 * animation frames entirely, and a loading screen waiting on one it is never
 * going to get is a hang rather than a wait. Everything that waits on a frame
 * here is warming something up, so a frame that did not happen costs the
 * warm-up and nothing else.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, FRAME_WAIT_TIMEOUT_MS);
    requestAnimationFrame(finish);
  });
}

/**
 * Streams the country around the start point, and then the whole circle of sky
 * the flight is actually flown in.
 *
 * Everything up to here has aimed one view — the one the flight opens facing —
 * and waited for it properly. This climbs once and looks out, which stages the
 * ground between the field and the horizon: a wing that gains three hundred
 * metres sees over the first ridge, and without this everything behind it
 * arrives in the frames of the climb. Then it swings the standoff right round
 * the compass and waits for each of those views in turn, so the tiles the first
 * turn uncovers are in the caches when the pilot turns into them rather than
 * being fetched over the top of a flight in progress.
 *
 * That order is deliberate. The near ground goes last, so if anything is
 * squeezed out of a cache along the way it is the distance rather than the
 * field being flown over.
 *
 * Best-effort by construction: the whole thing shares one budget, each stop
 * takes an even share of whatever is left, and the camera is put back where the
 * flight opens at the end whether or not the sweep finished. A view that did
 * not arrive is a view that streams in flight, which is where every view was
 * coming from before.
 */
async function preloadSurroundings(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
  scenery: Scenery,
  config: FlightMissionConfig,
  plan: PreloadPlan,
  terrainHeight: number,
  spawnAgl: number,
  onProgress: (phase: LoadingPhase, fraction: number) => void,
): Promise<void> {
  const deadline = Date.now() + plan.budgetMs;
  // The overview pass, the sweep, and the return to the opening view.
  const stops = plan.bearings.length + 2;
  let done = 0;

  /** One view: aim, let it be drawn, then wait for what it turned out to need. */
  const stage = async (stop: {
    phase: LoadingPhase;
    /** Degrees off the start heading. */
    bearingDeg: number;
    /** Metres above the field. */
    height: number;
    /** How many stops, this one included, still have to share the budget. */
    share: number;
    pitchDeg?: number;
  }): Promise<boolean> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || viewer.isDestroyed()) return false;
    // Whatever is left, shared evenly with the stops still to make.
    const slice = Math.round(remaining / stop.share);

    aimCameraAtSpawn(
      cesium,
      viewer,
      config,
      terrainHeight,
      stop.height,
      stop.bearingDeg,
      stop.pitchDeg,
    );
    // Cesium decides what a view needs while it renders it, so the queue is
    // asked about only once the new view has actually been drawn — read a
    // frame too early and it still reports the old view as fully loaded.
    await nextFrame();
    await nextFrame();

    await waitForTiles(viewer, () => {}, slice);
    await waitForSceneryStreamed(scenery, {
      stallMs: slice,
      timeoutMs: slice,
      // Nothing is about to be drawn from this view, so the stop is over as
      // soon as the queue goes quiet rather than after the long settle a
      // take-off is gated on. A stop over ground that is already cached then
      // costs a moment instead of a second and a half.
      settleMs: PRELOAD_SETTLE_MS,
    });
    done += 1;
    onProgress(stop.phase, done / stops);
    return true;
  };

  await stage({
    phase: "overview",
    bearingDeg: 0,
    height: Math.max(plan.overviewHeight, spawnAgl),
    pitchDeg: OVERVIEW_PITCH_DEG,
    share: stops,
  });

  for (const [index, bearing] of plan.bearings.entries()) {
    const staged = await stage({
      phase: "preload",
      bearingDeg: bearing,
      height: spawnAgl,
      // This stop, the ones after it, and the return to the opening view.
      share: plan.bearings.length - index + 1,
    });
    if (!staged) break;
  }

  // Back to the view the flight opens on, so the last thing streamed is the
  // first thing drawn.
  if (viewer.isDestroyed()) return;
  aimCameraAtSpawn(cesium, viewer, config, terrainHeight, spawnAgl);
  await nextFrame();
  await nextFrame();
  await waitForTiles(viewer, () => {}, Math.max(deadline - Date.now(), 2000));
  onProgress("preload", 1);
}
