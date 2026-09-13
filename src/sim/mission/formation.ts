/**
 * Formation scoring.
 *
 * Watches one aircraft against one slot and decides how well it is being flown.
 * Everything here is geometry and a stopwatch — it reads the simulation and
 * writes nothing back, so the whole pass/fail rule is testable in Node without
 * a renderer, a controller, or a globe.
 *
 * The rule the player is flying to:
 *
 *   - hold the slot for enough of the routine and the mission is passed
 *   - drift far enough away for long enough and the flight has been abandoned
 *   - touch anybody and you fly on with whatever the contact left you
 *
 * That last one is deliberate. Display pilots do occasionally touch, and what
 * follows is a bent aircraft and a difficult recovery rather than an exercise
 * that stops in mid-air. The cost of a mid-air is therefore the airframe
 * damage the flight model applies and the seconds of the routine that go by
 * while it is being wrestled back into the slot; the count is kept here only
 * so the debrief can say it happened.
 */

import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS } from "../flight/state";
import type { FormationSlot, FormationSlotId } from "../ai/formation";
import { FORMATION_SLOTS, formationStation } from "../ai/formation";

/** Inside this distance of the slot the aircraft counts as in station, metres. */
export const STATION_TOLERANCE = 15;
/** Beyond this the aircraft is out of the formation entirely, metres. */
export const STATION_LIMIT = 55;
/** Fraction of the routine that has to be flown in station to pass. */
export const PASS_FRACTION = 0.6;
/** Further than this from the lead counts as having left the formation. */
export const ABANDON_RANGE = 900;
/** Seconds spent that far out before the flight is called abandoned. */
export const ABANDON_SECONDS = 30;

export interface FormationSettings {
  /** Which slot the player is flying. */
  readonly slot: FormationSlotId;
  /**
   * AI aircraft in the flight, including the leader. One is a pair with the
   * player; more fills the rest of the formation.
   */
  readonly flightSize: number;
  /** Length of the display routine, seconds. */
  readonly routineSeconds: number;
}

/**
 * Aircraft the AI flies in the formation, leader included.
 *
 * One is the leader on their own; the most is the leader plus a wingman in
 * every slot the player is not sitting in.
 */
export const MIN_FLIGHT_SIZE = 1;
export const MAX_FLIGHT_SIZE = 5;

/** How long a display runs, seconds. */
export const MIN_ROUTINE_SECONDS = 60;
export const MAX_ROUTINE_SECONDS = 900;
export const ROUTINE_STEP_SECONDS = 60;

export interface FormationProgress {
  /** Metres from the slot the player is meant to be holding. */
  readonly stationError: number;
  /** True while the player is inside the tolerance. */
  readonly inStation: boolean;
  /** How well the slot is being held right now, 0..1. */
  readonly quality: number;
  /** Seconds spent in station. */
  readonly timeInStation: number;
  /** Seconds of routine flown. */
  readonly elapsed: number;
  /** Length of the whole routine, seconds. */
  readonly total: number;
  /** Share of the routine flown in station so far, 0..1. */
  readonly score: number;
  /** Longest unbroken time in station, seconds. */
  readonly bestStreak: number;
  readonly currentStreak: number;
  /** Metres to the leader, or Infinity when there is no leader flying. */
  readonly rangeToLead: number;
  /** Seconds spent out of contact with the formation. */
  readonly timeSeparated: number;
  /** How many times the player has hit somebody in the flight. */
  readonly midairs: number;
  /** True once the routine has been flown to the end. */
  readonly finished: boolean;
  /** True once the player has been out of contact for too long. */
  readonly abandoned: boolean;
}

/**
 * Scores one formation flight.
 *
 * The clock only runs while there is an aircraft flying the slot: time spent
 * waiting for a replacement airframe is neither credited nor charged, which
 * keeps the score a measure of flying rather than of luck.
 */
export class FormationTracker {
  readonly settings: FormationSettings;
  readonly slot: FormationSlot;
  readonly total: number;

  private elapsed = 0;
  private timeInStation = 0;
  private currentStreak = 0;
  private bestStreak = 0;
  private timeSeparated = 0;
  private midairs = 0;
  private stationError = Number.POSITIVE_INFINITY;
  private rangeToLead = Number.POSITIVE_INFINITY;
  private inStation = false;
  private quality = 0;

  private readonly station = V.vec3();

  constructor(settings: FormationSettings) {
    this.settings = settings;
    this.slot = FORMATION_SLOTS[settings.slot];
    this.total = Math.max(settings.routineSeconds, 1);
  }

  get finished(): boolean {
    return this.elapsed >= this.total;
  }

  get abandoned(): boolean {
    return this.timeSeparated >= ABANDON_SECONDS;
  }

  get score(): number {
    return this.elapsed > 0 ? clamp(this.timeInStation / this.elapsed, 0, 1) : 0;
  }

  get passed(): boolean {
    return this.score >= PASS_FRACTION;
  }

  /** How many times the player has hit somebody in the flight. */
  get contacts(): number {
    return this.midairs;
  }

  /**
   * Notes that the player has touched another aircraft.
   *
   * Nothing is scored on it: the aircraft is either still flyable, in which
   * case the routine goes on and the damage speaks for itself, or it is not,
   * in which case the clock has already stopped for a lost airframe.
   */
  recordContacts(count = 1): void {
    if (count > 0) this.midairs += count;
  }

  /** Where the player is meant to be, in local ENU metres. */
  stationPoint(lead: AircraftState, out: Vec3): Vec3 {
    return formationStation(out, lead, this.slot);
  }

  get progress(): FormationProgress {
    return {
      stationError: this.stationError,
      inStation: this.inStation,
      quality: this.quality,
      timeInStation: this.timeInStation,
      elapsed: this.elapsed,
      total: this.total,
      score: this.score,
      bestStreak: this.bestStreak,
      currentStreak: this.currentStreak,
      rangeToLead: this.rangeToLead,
      timeSeparated: this.timeSeparated,
      midairs: this.midairs,
      finished: this.finished,
      abandoned: this.abandoned,
    };
  }

  /**
   * Advances the stopwatch by one step.
   *
   * With no aircraft in the slot or no leader to fly on, nothing is scored and
   * nothing is charged — the routine simply waits.
   */
  update(
    player: AircraftState | null,
    lead: AircraftState | null,
    dt: number,
  ): void {
    const flying =
      player !== null &&
      player.status === FLIGHT_STATUS.Flying &&
      lead !== null &&
      lead.status === FLIGHT_STATUS.Flying;

    if (!flying) {
      this.inStation = false;
      this.quality = 0;
      this.currentStreak = 0;
      this.stationError = Number.POSITIVE_INFINITY;
      this.rangeToLead = Number.POSITIVE_INFINITY;
      return;
    }

    this.elapsed = Math.min(this.elapsed + dt, this.total);

    formationStation(this.station, lead, this.slot);
    this.stationError = V.distance(player.position, this.station);
    this.rangeToLead = V.distance(player.position, lead.position);

    // Graded rather than binary: the OSD needs something that moves as the slot
    // is worked, not a lamp that only lights at the tolerance.
    this.quality = clamp(
      1 - (this.stationError - STATION_TOLERANCE) / (STATION_LIMIT - STATION_TOLERANCE),
      0,
      1,
    );

    this.inStation = this.stationError <= STATION_TOLERANCE;
    if (this.inStation) {
      this.timeInStation += dt;
      this.currentStreak += dt;
      this.bestStreak = Math.max(this.bestStreak, this.currentStreak);
    } else {
      this.currentStreak = 0;
    }

    // Losing contact has to be sustained to count: a wide overshoot on a hard
    // reversal is bad formation flying, not a departure from the exercise.
    if (this.rangeToLead > ABANDON_RANGE) {
      this.timeSeparated += dt;
    } else {
      this.timeSeparated = Math.max(0, this.timeSeparated - dt * 2);
    }
  }
}

/** Plain-language grade for a finished formation flight. */
export function formationGrade(score: number): string {
  if (score >= 0.9) return "Immaculate";
  if (score >= 0.75) return "Tight";
  if (score >= PASS_FRACTION) return "Passed";
  if (score >= 0.35) return "Loose";
  return "Adrift";
}
