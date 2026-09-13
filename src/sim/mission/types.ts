/**
 * Mission configuration and outcome.
 *
 * A mission is fully described by this settings object. Everything generated
 * from it — enemy spawn points, patrol routes, wind, cloud layout — comes from
 * the seed, so the same settings and the same seed produce the same mission
 * every time it is flown.
 */

import type {
  MissionClock,
  Weather,
  TimeOfDay,
  WeatherState,
} from "../environment/types";
import { VTX_UNLIMITED } from "../environment/videoLink";
import { clamp } from "../math/scalar";
import type { Difficulty } from "../ai/types";
import { FORMATION_SLOT } from "../ai/formation";
import type { FormationProgress, FormationSettings } from "./formation";
import type { RaceProgress, RaceSettings } from "./race";
import type { FestivalProgress, FestivalSettings } from "./festival";
import { clampEscortCount, type StrikeSettings } from "./strike";
import type { OppositionSettings } from "./opposition";

export const MISSION_MODE = {
  /** No objectives. Fly wherever you like. */
  FreeFlight: "FREE_FLIGHT",
  /**
   * The same flying, done the way it is done on a field.
   *
   * The pilot is standing at the start point rather than sitting behind a
   * pair of goggles somewhere convenient: the aircraft begins at their feet
   * and waits for the throttle, gets airborne the way it really would — a wing
   * out of somebody's hand, a quadcopter off its own rotors — and is watched
   * from where they are standing, which is the only place they can watch it
   * from.
   */
  GroundView: "GROUND_VIEW",
  /** Destroy every enemy in the mission area. */
  Intercept: "INTERCEPT",
  /**
   * Destroy contacts transiting the area, which are not looking for you.
   *
   * The same aircraft and the same charge as an interception; the difference is
   * entirely in who is hunting whom.
   */
  Strike: "STRIKE",
  /** Hold a slot on a flight of UAVs through a display routine. */
  Formation: "FORMATION",
  /** Fly a gate course against the clock and a field of AI racers. */
  Race: "RACE",
  /** Share one field with a sky full of other people's model aircraft. */
  Festival: "FESTIVAL",
} as const;

/**
 * The modes that are a way of going flying rather than a mission.
 *
 * Nothing here has an objective, a reserve of airframes or anything else in
 * the sky; what separates them is only where the pilot is standing. They are
 * offered on the main menu rather than on the mission list.
 */
export const OPEN_MODES = [
  MISSION_MODE.FreeFlight,
  MISSION_MODE.GroundView,
] as const;

/**
 * The modes that are missions rather than a way of going flying.
 *
 * The menu offers the open flights above and then this list, which is the
 * only place the grouping is written down: a mode added here appears on the
 * mission screen without anything else being told about it.
 */
export const MISSION_MODES = [
  MISSION_MODE.Intercept,
  MISSION_MODE.Strike,
  MISSION_MODE.Race,
  MISSION_MODE.Formation,
  MISSION_MODE.Festival,
] as const;

export type MissionMode = (typeof MISSION_MODE)[keyof typeof MISSION_MODE];

/** What each mode is called, and what it is. */
export interface MissionModeInfo {
  readonly id: MissionMode;
  readonly label: string;
  /** One line, for a menu row or an option button. */
  readonly tagline: string;
  /** A sentence or two, for the screen that offers it. */
  readonly description: string;
}

export const MISSION_MODE_INFO: Readonly<Record<MissionMode, MissionModeInfo>> = {
  [MISSION_MODE.FreeFlight]: {
    id: MISSION_MODE.FreeFlight,
    label: "Free Flight",
    tagline: "Explore the real Earth",
    description:
      "No objectives and nobody else in the sky. Pick anywhere on the globe and go flying.",
  },
  [MISSION_MODE.GroundView]: {
    id: MISSION_MODE.GroundView,
    label: "RC Ground View",
    tagline: "Flown from where you stand",
    description:
      "Line of sight, the way a model is actually flown. The aircraft starts at your feet and waits for you: open the throttle and a wing goes out of a launcher's hand, a quadcopter lifts off its own rotors. You stay put on the field and turn your head to keep it in sight.",
  },
  [MISSION_MODE.Intercept]: {
    id: MISSION_MODE.Intercept,
    label: "Intercept",
    tagline: "Destroy every contact",
    description:
      "Find the contacts in the mission area and bring them down. The charge is on the wing, so every kill costs an airframe.",
  },
  [MISSION_MODE.Strike]: {
    id: MISSION_MODE.Strike,
    label: "Strike",
    tagline: "Contacts that never look back",
    description:
      "Aircraft crossing the area on a route somebody programmed for them before you took off. They fly it waypoint to waypoint and never look for you — nothing here evades, turns to fight, or runs — so the whole mission is the approach. Ask for escorts and some of it will be looking.",
  },
  [MISSION_MODE.Race]: {
    id: MISSION_MODE.Race,
    label: "Race",
    tagline: "Gate course against the clock",
    description:
      "A course of gates laid over the real terrain, flown on the deck against the clock and a field of AI racers.",
  },
  [MISSION_MODE.Formation]: {
    id: MISSION_MODE.Formation,
    label: "Formation",
    tagline: "Fly the slot on a display",
    description:
      "Hold your station on a flight of aircraft through a display routine. Holding it is the whole exercise.",
  },
  [MISSION_MODE.Festival]: {
    id: MISSION_MODE.Festival,
    label: "Festival",
    tagline: "One field, everybody flying at once",
    description:
      "A sky full of other people's models over one field. Fly it as a fly-in — nobody looking where they are going, and a mid-air every few minutes — or as a streamer cut, where everybody tows paper and the afternoon is scored on how much of everybody else's you take off. Either way, anything that goes down stays down until the field is clear, and then the whole lot launches again — but the wing you put in the field is the end of your own day.",
  },
} as const;

/**
 * How many contacts a mission can be flown against.
 *
 * A range rather than a handful of fixed sizes: the difference between eleven
 * contacts and twelve is a real difference to fly, and there is no reason the
 * pilot should have to pick from somebody else's four numbers to get at it.
 */
export const MIN_ENEMY_COUNT = 1;
export const MAX_ENEMY_COUNT = 20;

/** A contact count, held to what a mission can actually put in the air. */
export function clampEnemyCount(count: number): number {
  return Math.round(clamp(count, MIN_ENEMY_COUNT, MAX_ENEMY_COUNT));
}

/**
 * True for the modes that are simply going flying.
 *
 * Nothing is generated for them, nothing is scored, and there is one airframe:
 * when it is gone the flight is over. Everything that treats going flying
 * differently from flying a mission asks here rather than naming free flight,
 * so a second way of going flying is one entry in `OPEN_MODES` rather than a
 * search for every place the first one was written down.
 */
export function isOpenFlight(mode: MissionMode): boolean {
  return (OPEN_MODES as readonly MissionMode[]).includes(mode);
}

/**
 * True for the modes the aircraft starts on the ground for.
 *
 * The pilot is standing on the field in exactly one of them, and that is the
 * one where the flight has to begin with a launch rather than with an
 * aircraft that is already up.
 */
export function startsOnTheGround(mode: MissionMode): boolean {
  return mode === MISSION_MODE.GroundView;
}

/**
 * True for the modes flown with a charge on the wing, where destroying every
 * contact is the objective.
 *
 * Interception and strike differ in who is hunting whom and in nothing else:
 * the same airframe, the same warhead, the same win condition and the same
 * airframe economy. Everything that treats them alike asks here rather than
 * listing both, so a third combat mode is one line rather than a search.
 */
export function isCombatMission(mode: MissionMode): boolean {
  return mode === MISSION_MODE.Intercept || mode === MISSION_MODE.Strike;
}

export interface MissionSettings {
  readonly mode: MissionMode;
  readonly locationName: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly missionRadius: number;
  readonly spawnAltitudeAgl: number;
  /**
   * Which way the flight faces when it begins, degrees from north.
   *
   * Chosen on the globe along with the start point, and it turns the whole
   * start with it: the pilot's own aircraft, where a launcher is standing, the
   * formation leader's station and the race grid and its run-in. North when it
   * is not given, which is what every flight did before it could be chosen.
   */
  readonly startHeadingDeg?: number;
  readonly weather: Weather;
  /**
   * How much of the sky the cloud fills, 0..1.
   *
   * Overrides the weather profile's own figure, so a clear day can be flown
   * with a genuinely empty sky rather than the handful of cumulus the preset
   * carries. Left unset the preset decides. At zero there is no cloud layer at
   * all: nothing is drawn, nothing is marched, and nothing obscures a contact.
   */
  readonly cloudCover?: number;
  /**
   * The whole sky, when the pilot built one rather than picking a preset.
   *
   * Every deck with its amount, base, depth and genus; the visibility; what is
   * falling; whether it is thundering; and the wind at each height. It arrives
   * from the weather editor, from a report the pilot typed, from the nearest
   * real aerodrome, or from the mission seed — and once it is set it is what
   * the flight is flown in, with `weather` left as the one word the logbook
   * records the day by.
   */
  readonly sky?: WeatherState;
  readonly timeOfDay: TimeOfDay;
  /**
   * The date and time the flight is made at, when one was set.
   *
   * Only read while `timeOfDay` is `Custom`: the presets are a look, not a
   * moment, and place the sun by solar hour on the day the flight is flown.
   * With a clock the sun is instead wherever it really was over this place at
   * that date and time, read as local time at the site or as UTC.
   */
  readonly clock?: MissionClock;
  /**
   * Contacts to put in the air. Ignored in free flight.
   *
   * On an interception these are the aircraft hunting the pilot; on a strike
   * they are the transit, and whatever is hunting is counted separately by
   * `strike.escortCount`.
   */
  readonly enemyCount: number;
  /**
   * Which aircraft those contacts are flying.
   *
   * Read wherever anything is put up against the pilot — the interception's
   * contacts, the strike's transit and its escorts — and ignored by the modes
   * that have no opposition.
   */
  readonly opposition: OppositionSettings;
  readonly difficulty: Difficulty;
  /** False keeps enemies on patrol and makes contact non-lethal. */
  readonly combat: boolean;
  /** Ignored outside a formation flight. */
  readonly formation: FormationSettings;
  /** Ignored outside a race. */
  readonly race: RaceSettings;
  /** Ignored outside a festival. */
  readonly festival: FestivalSettings;
  /** Ignored outside a strike. */
  readonly strike: StrikeSettings;
  /**
   * Video transmitter power in milliwatts, which is what decides how far the
   * aircraft can be flown before the picture goes. `VTX_UNLIMITED` switches
   * range simulation off.
   */
  readonly vtxPowerMw: number;
  /** Drives every generated part of the mission. */
  readonly seed: string;
}

/** Range simulation is opt-in: a mission that says nothing about it has none. */
export const DEFAULT_VTX_POWER_MW = VTX_UNLIMITED;

export const DEFAULT_FORMATION: FormationSettings = {
  slot: FORMATION_SLOT.Right,
  flightSize: 2,
  routineSeconds: 300,
};

/**
 * Spare airframes beyond one per enemy.
 *
 * An interception destroys both aircraft — the charge is on the wing, and the
 * wing is the weapon. A flight of interceptors therefore trades one airframe
 * per kill, and this is the margin for the ones that go wrong.
 */
export const SPARE_INTERCEPTORS = 2;

export function interceptorsFor(settings: MissionSettings): number {
  // Going flying is one airframe: there is no mission to come back for, and
  // nothing waiting in the car that the pilot did not put there.
  if (isOpenFlight(settings.mode)) return 1;
  // Nobody at a fly-in counts airframes. There is always another one in the
  // car; what there is not is a way of putting it up in the middle of somebody
  // else's slot, so a wing in the field ends the day rather than spending one
  // of a reserve. That is the festival's own rule, not an economy.
  if (settings.mode === MISSION_MODE.Festival) return Number.POSITIVE_INFINITY;
  // A formation flight destroys nothing, so the reserve is only there to let a
  // pilot who flew into the ground rejoin and carry on with the exercise.
  if (settings.mode === MISSION_MODE.Formation) return 1 + SPARE_INTERCEPTORS;
  // A race is the same bargain: putting a wing through a gate post costs an
  // airframe and the time it takes to get another one on the course, and the
  // clock never stops for it.
  if (settings.mode === MISSION_MODE.Race) return 1 + SPARE_INTERCEPTORS;
  // A strike is the same bargain as an interception, and the escorts are part
  // of it: anything with the red tint on it has to be brought down, and each
  // one of them costs a wing.
  if (settings.mode === MISSION_MODE.Strike) {
    return (
      settings.enemyCount +
      clampEscortCount(settings.strike.escortCount) +
      SPARE_INTERCEPTORS
    );
  }
  return settings.enemyCount + SPARE_INTERCEPTORS;
}

export const MISSION_OUTCOME = {
  InProgress: "IN_PROGRESS",
  Complete: "COMPLETE",
  Failed: "FAILED",
} as const;

export type MissionOutcome =
  (typeof MISSION_OUTCOME)[keyof typeof MISSION_OUTCOME];

export interface MissionStatus {
  readonly outcome: MissionOutcome;
  /** Enemies still flying. */
  readonly enemiesRemaining: number;
  readonly enemiesDestroyed: number;
  /** Airframes left, including the one currently being flown. */
  readonly interceptorsRemaining: number;
  /** True while a replacement airframe is on its way up. */
  readonly relaunching: boolean;
  /** Seconds until the replacement is airborne. */
  readonly relaunchIn: number;
  /** Set once the mission has ended. */
  readonly reason: string;
  /** Only present on a formation flight. */
  readonly formation?: FormationProgress;
  /** Only present on a race, and only once the course has been laid out. */
  readonly race?: RaceProgress;
  /** Only present at a festival. */
  readonly festival?: FestivalProgress;
}
