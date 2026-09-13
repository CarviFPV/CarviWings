/**
 * A pilot's logbook: what they flew, and what it came to.
 *
 * One record per flight that reached a debrief, newest first. A record is a
 * flat set of numbers rather than a reference to the mission that produced it,
 * because the log has to stay readable after the mission modes it describes
 * have changed shape — a race flown last month is still a time at a place, and
 * the career it feeds still has to add up.
 *
 * Everything a screen shows about a pilot's flying is derived from this list.
 * Nothing is stored twice: there is no running total kept alongside the
 * records, so a log that is repaired, trimmed or edited cannot disagree with
 * the career built from it.
 */

import type { Difficulty } from "../ai/types";
import { DIFFICULTY } from "../ai/types";
import type { FlightStatistics } from "../flight/telemetry";
import type { MissionMode, MissionSettings, MissionStatus } from "../mission";
import { MISSION_MODE, MISSION_OUTCOME, isOpenFlight } from "../mission";

/**
 * How many flights a logbook keeps.
 *
 * The log lives in the same small storage as the settings do, so it cannot
 * grow without end. Two hundred flights is more than the career screen shows
 * and more than anybody scrolls; past that the oldest flight goes.
 */
export const MAX_LOG_RECORDS = 200;

/** One flight, as it is written down when the debrief comes up. */
export interface FlightRecord {
  readonly mode: MissionMode;
  readonly locationName: string;
  readonly difficulty: Difficulty;
  /** Epoch milliseconds when the flight ended. */
  readonly flownAt: number;
  /** True when the mission was flown to its objective. */
  readonly complete: boolean;
  readonly flightTime: number;
  readonly distanceFlown: number;
  readonly maxAltitudeAgl: number;
  /** True airspeed, m/s. */
  readonly maxAirspeed: number;
  readonly enemiesDestroyed: number;
  readonly collisions: number;
  readonly crashes: number;
  readonly landings: number;
  /** Seconds, and only on a race that was finished. */
  readonly raceTime: number | null;
  /** Finishing place, and only on a race that was finished. */
  readonly racePosition: number | null;
  /** How many were racing, so a place means something later. */
  readonly raceFieldSize: number | null;
  /** Share of the routine held in station, 0..1, only on a formation flight. */
  readonly formationScore: number | null;
  /** Waves flown, only at a festival. */
  readonly festivalWaves: number | null;
}

/**
 * The flight the debrief is about, as a log entry.
 *
 * Read from the mission status rather than the raw statistics wherever the two
 * both know something: the status is what the debrief screen shows, and a
 * logbook that disagrees with the screen the pilot just read is worse than no
 * logbook.
 */
export function flightRecord(
  settings: MissionSettings,
  statistics: FlightStatistics,
  status: MissionStatus,
  now: number,
): FlightRecord {
  const race = status.race;
  const formation = status.formation;
  const festival = status.festival;

  return {
    mode: settings.mode,
    locationName: settings.locationName,
    difficulty: settings.difficulty,
    flownAt: now,
    complete: status.outcome === MISSION_OUTCOME.Complete,
    flightTime: statistics.flightTime,
    distanceFlown: statistics.distanceFlown,
    maxAltitudeAgl: statistics.maxAltitudeAgl,
    maxAirspeed: statistics.maxAirspeed,
    enemiesDestroyed: status.enemiesDestroyed,
    collisions: statistics.collisions,
    crashes: statistics.crashes,
    landings: statistics.landings,
    // A race that was not finished has no time worth keeping: the clock at the
    // moment the airframe was written off is not a lap, and a personal best
    // built from one would be unbeatable and meaningless.
    raceTime: race && race.finished ? race.elapsed : null,
    racePosition: race && race.finished ? race.position : null,
    raceFieldSize: race && race.finished ? race.racerCount : null,
    formationScore: formation ? formation.score : null,
    festivalWaves: festival ? festival.wavesFlown : null,
  };
}

/** The log with one more flight in it, newest first and held to its limit. */
export function addRecord(
  log: readonly FlightRecord[],
  record: FlightRecord,
  limit: number = MAX_LOG_RECORDS,
): readonly FlightRecord[] {
  return [record, ...log].slice(0, Math.max(1, limit));
}

/** What a pilot has done in total, built from the log every time it is asked. */
export interface CareerTotals {
  readonly flights: number;
  /** Flights that were a mission rather than going flying. */
  readonly missionsFlown: number;
  readonly missionsComplete: number;
  /** Seconds. */
  readonly flightTime: number;
  /** Metres. */
  readonly distanceFlown: number;
  readonly enemiesDestroyed: number;
  readonly collisions: number;
  readonly crashes: number;
  readonly landings: number;
  /** m/s. */
  readonly topSpeed: number;
  /** Metres above the ground. */
  readonly highestAgl: number;
  /** The longest single flight, seconds. */
  readonly longestFlight: number;
}

export const EMPTY_CAREER: CareerTotals = {
  flights: 0,
  missionsFlown: 0,
  missionsComplete: 0,
  flightTime: 0,
  distanceFlown: 0,
  enemiesDestroyed: 0,
  collisions: 0,
  crashes: 0,
  landings: 0,
  topSpeed: 0,
  highestAgl: 0,
  longestFlight: 0,
};

export function summariseCareer(log: readonly FlightRecord[]): CareerTotals {
  let totals = EMPTY_CAREER;

  for (const record of log) {
    const isMission = !isOpenFlight(record.mode);
    totals = {
      flights: totals.flights + 1,
      missionsFlown: totals.missionsFlown + (isMission ? 1 : 0),
      missionsComplete:
        totals.missionsComplete + (isMission && record.complete ? 1 : 0),
      flightTime: totals.flightTime + record.flightTime,
      distanceFlown: totals.distanceFlown + record.distanceFlown,
      enemiesDestroyed: totals.enemiesDestroyed + record.enemiesDestroyed,
      collisions: totals.collisions + record.collisions,
      crashes: totals.crashes + record.crashes,
      landings: totals.landings + record.landings,
      topSpeed: Math.max(totals.topSpeed, record.maxAirspeed),
      highestAgl: Math.max(totals.highestAgl, record.maxAltitudeAgl),
      longestFlight: Math.max(totals.longestFlight, record.flightTime),
    };
  }

  return totals;
}

/** The fastest a course at one place has been flown. */
export interface RaceBest {
  readonly locationName: string;
  /** Seconds. */
  readonly time: number;
  readonly flownAt: number;
  /** The place taken on the run that set it. */
  readonly position: number;
  readonly fieldSize: number;
}

export interface PersonalBests {
  /** Fastest first, one entry per place a course has been finished at. */
  readonly races: readonly RaceBest[];
  /** Best share of a display routine held in station, 0..1; null if never flown. */
  readonly formationScore: number | null;
  /** Most waves flown in one festival slot; null if never flown. */
  readonly festivalWaves: number | null;
  /** Most contacts brought down in one mission; null if none ever were. */
  readonly enemiesInOneFlight: number | null;
}

/**
 * The numbers worth beating.
 *
 * A race time is only comparable against the same course, and a course is laid
 * out from the place it is flown at, so the times are grouped by location
 * rather than reduced to one figure. Everything else is a single best.
 */
export function personalBests(log: readonly FlightRecord[]): PersonalBests {
  const races = new Map<string, RaceBest>();
  let formationScore: number | null = null;
  let festivalWaves: number | null = null;
  let enemiesInOneFlight: number | null = null;

  for (const record of log) {
    if (record.raceTime !== null && record.raceTime > 0) {
      const existing = races.get(record.locationName);
      if (!existing || record.raceTime < existing.time) {
        races.set(record.locationName, {
          locationName: record.locationName,
          time: record.raceTime,
          flownAt: record.flownAt,
          position: record.racePosition ?? 1,
          fieldSize: record.raceFieldSize ?? 1,
        });
      }
    }
    if (record.formationScore !== null) {
      formationScore = Math.max(formationScore ?? 0, record.formationScore);
    }
    if (record.festivalWaves !== null) {
      festivalWaves = Math.max(festivalWaves ?? 0, record.festivalWaves);
    }
    if (record.enemiesDestroyed > 0) {
      enemiesInOneFlight = Math.max(
        enemiesInOneFlight ?? 0,
        record.enemiesDestroyed,
      );
    }
  }

  return {
    races: [...races.values()].sort((a, b) => a.time - b.time),
    formationScore,
    festivalWaves,
    enemiesInOneFlight,
  };
}

const MISSION_MODES_BY_ID = new Set<string>(Object.values(MISSION_MODE));
const DIFFICULTIES_BY_ID = new Set<string>(Object.values(DIFFICULTY));

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normaliseRecord(raw: unknown): FlightRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof FlightRecord, unknown>>;

  // A record naming a mode this build no longer has is not repairable into
  // another one: which mode it was is what every total it feeds is grouped by.
  if (typeof value.mode !== "string" || !MISSION_MODES_BY_ID.has(value.mode)) {
    return null;
  }

  const difficulty =
    typeof value.difficulty === "string" && DIFFICULTIES_BY_ID.has(value.difficulty)
      ? (value.difficulty as Difficulty)
      : DIFFICULTY.Normal;

  return {
    mode: value.mode as MissionMode,
    locationName:
      typeof value.locationName === "string" && value.locationName.trim()
        ? value.locationName
        : "Unknown",
    difficulty,
    flownAt: finiteOr(value.flownAt, 0),
    complete: value.complete === true,
    flightTime: Math.max(0, finiteOr(value.flightTime, 0)),
    distanceFlown: Math.max(0, finiteOr(value.distanceFlown, 0)),
    maxAltitudeAgl: Math.max(0, finiteOr(value.maxAltitudeAgl, 0)),
    maxAirspeed: Math.max(0, finiteOr(value.maxAirspeed, 0)),
    enemiesDestroyed: Math.max(0, Math.round(finiteOr(value.enemiesDestroyed, 0))),
    collisions: Math.max(0, Math.round(finiteOr(value.collisions, 0))),
    crashes: Math.max(0, Math.round(finiteOr(value.crashes, 0))),
    landings: Math.max(0, Math.round(finiteOr(value.landings, 0))),
    raceTime: optionalNumber(value.raceTime),
    racePosition: optionalNumber(value.racePosition),
    raceFieldSize: optionalNumber(value.raceFieldSize),
    formationScore: optionalNumber(value.formationScore),
    festivalWaves: optionalNumber(value.festivalWaves),
  };
}

/**
 * A logbook that can be trusted, from whatever storage handed back.
 *
 * Records are sorted newest first here rather than assumed to be: the order is
 * what every screen reads them in, and a log written by an older build, merged
 * by hand, or half-restored has no reason to already be in it.
 */
export function normaliseLog(
  raw: unknown,
  limit: number = MAX_LOG_RECORDS,
): readonly FlightRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: FlightRecord[] = [];
  for (const entry of raw) {
    const record = normaliseRecord(entry);
    if (record) records.push(record);
  }
  records.sort((a, b) => b.flownAt - a.flownAt);
  return records.slice(0, Math.max(1, limit));
}
