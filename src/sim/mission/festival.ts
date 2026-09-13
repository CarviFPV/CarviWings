/**
 * The festival fly-in.
 *
 * A field, a piece of sky over it, and as many model aircraft in that sky as
 * the pilot asked for. Nobody is hunting anybody: the whole event is a lot of
 * wings sharing very little air, which is exactly why they touch — and what a
 * touch costs is whatever the impact was worth, decided by the damage model
 * like every other contact in this simulator. A brush is a brush; a solid one
 * takes a wing off and the aircraft goes in.
 *
 * The one rule that makes it a festival rather than a free-for-all is the
 * flight line: an aircraft that goes down stays down until the sky is empty,
 * and then the whole field launches again. That is how it is actually flown —
 * nobody walks out to fetch a wreck while there are still aeroplanes overhead.
 * The pilot's own wing is the exception, because they are the one person who
 * would have to sit and watch: putting it in ends their day rather than parking
 * them on the flight line for the rest of somebody else's slot.
 *
 * There are two events flown under that rule. The fly-in above is one of them;
 * the other is the streamer cut, where everybody tows a length of paper and the
 * afternoon is scored on how much of everybody else's came off. The rule, the
 * field, the waves and the clock are the same either way — see `streamer.ts`
 * for the paper itself.
 *
 * Everything here is counting and a stopwatch. It reads aircraft state and
 * writes nothing back, so the whole rule is testable in Node without a
 * renderer, a controller, or a globe.
 */

import type { AircraftState } from "../flight/state";
import { AIRCRAFT_ROLE, FLIGHT_STATUS, isAirworthy } from "../flight/state";
import type { StreamerStandings } from "./streamer";
import { streamerSummary } from "./streamer";

/**
 * What the field has turned up to do.
 *
 * Two ways of flying the same afternoon over the same strip. The fly-in is
 * everybody minding their own aeroplane and the mid-airs happening anyway; the
 * streamer event is everybody towing a ribbon and going after each other's on
 * purpose, which is a different afternoon with the same aircraft in it.
 */
export const FESTIVAL_EVENT = {
  /** Share the sky, keep out of the way, and see how long the day lasts. */
  FlyIn: "FLY_IN",
  /** Everybody tows paper. Cut theirs, keep yours. */
  Streamer: "STREAMER",
} as const;

export type FestivalEvent = (typeof FESTIVAL_EVENT)[keyof typeof FESTIVAL_EVENT];

export const FESTIVAL_EVENTS = [
  FESTIVAL_EVENT.FlyIn,
  FESTIVAL_EVENT.Streamer,
] as const;

/** What each event is called, and what it is. */
export interface FestivalEventInfo {
  readonly id: FestivalEvent;
  readonly label: string;
  /** One line, for an option button. */
  readonly tagline: string;
  /** A sentence or two, for the screen that offers it. */
  readonly description: string;
}

export const FESTIVAL_EVENT_INFO: Readonly<
  Record<FestivalEvent, FestivalEventInfo>
> = {
  [FESTIVAL_EVENT.FlyIn]: {
    id: FESTIVAL_EVENT.FlyIn,
    label: "Fly-in",
    tagline: "Everybody flying their own line",
    description:
      "Nobody is hunting anybody. A sky full of other people's models over one field, each of them flying their own circuit and their own beat-up of the line, and every few minutes two of them arrive in the same piece of it. Staying in the air is the whole exercise.",
  },
  [FESTIVAL_EVENT.Streamer]: {
    id: FESTIVAL_EVENT.Streamer,
    label: "Streamer cut",
    tagline: "Cut their paper, keep yours",
    description:
      "Everybody tows a length of crepe paper off the tail in their own colour. Fly through somebody else's and whatever is beyond your wing falls off and is scored to you. The pilot who has cut the most paper when the slot ends has won it — and a wing put into the field ends your day on whatever the board says at that moment, so the paper you are still towing is worth keeping.",
  },
} as const;

/** The event a stored or hand-written setting asks for. */
export function normaliseFestivalEvent(raw: unknown): FestivalEvent {
  return raw === FESTIVAL_EVENT.Streamer
    ? FESTIVAL_EVENT.Streamer
    : FESTIVAL_EVENT.FlyIn;
}

/** How big the piece of sky is, metres of radius. */
export const FESTIVAL_AREA_RADII = [200, 500, 1000, 1500] as const;

/** Fewest other aircraft that still makes it somebody else's sky too. */
export const MIN_FESTIVAL_AIRCRAFT = 1;

/** Most aircraft the field will take besides the player. */
export const MAX_FESTIVAL_AIRCRAFT = 50;

/** A day with no end to it: fly until you have had enough. */
export const FESTIVAL_UNLIMITED = 0;

/** Shortest slot that is still worth launching for, seconds. */
export const MIN_FESTIVAL_SLOT_SECONDS = 60;

/** Longest slot with an end to it, seconds. */
export const MAX_FESTIVAL_SLOT_SECONDS = 1800;

/** The slot is asked for in whole minutes. */
export const FESTIVAL_SLOT_STEP_SECONDS = 60;

/**
 * Where the unlimited day sits on a slider.
 *
 * `FESTIVAL_UNLIMITED` is nought, and a slider that ran from no end at all up
 * through one minute to thirty would read backwards. The endless day is the
 * longest one there is, so it lives one step past the longest slot and is
 * mapped back to nought on the way in and out.
 */
export const FESTIVAL_SLOT_UNLIMITED_POSITION =
  MAX_FESTIVAL_SLOT_SECONDS + FESTIVAL_SLOT_STEP_SECONDS;

/** Holds an aircraft count to a field that can actually be launched. */
export function clampFestivalAircraft(count: number): number {
  if (!Number.isFinite(count)) return MIN_FESTIVAL_AIRCRAFT;
  return Math.min(
    Math.max(Math.round(count), MIN_FESTIVAL_AIRCRAFT),
    MAX_FESTIVAL_AIRCRAFT,
  );
}

/** Holds a slot to whole minutes between the shortest and the longest. */
export function clampFestivalSlot(seconds: number): number {
  if (!Number.isFinite(seconds)) return MIN_FESTIVAL_SLOT_SECONDS;
  const stepped =
    Math.round(seconds / FESTIVAL_SLOT_STEP_SECONDS) *
    FESTIVAL_SLOT_STEP_SECONDS;
  return Math.min(
    Math.max(stepped, MIN_FESTIVAL_SLOT_SECONDS),
    MAX_FESTIVAL_SLOT_SECONDS,
  );
}

/** The slot a slider position asks for; the top position is the endless day. */
export function festivalSlotFromPosition(position: number): number {
  if (!Number.isFinite(position)) return MIN_FESTIVAL_SLOT_SECONDS;
  return position >= FESTIVAL_SLOT_UNLIMITED_POSITION
    ? FESTIVAL_UNLIMITED
    : clampFestivalSlot(position);
}

/** Where a slot sits on the slider, the endless day included. */
export function festivalSlotPosition(durationSeconds: number): number {
  return durationSeconds === FESTIVAL_UNLIMITED
    ? FESTIVAL_SLOT_UNLIMITED_POSITION
    : clampFestivalSlot(durationSeconds);
}

/**
 * How long one round on the flight line lasts, seconds.
 *
 * A fly-in is flown in rounds: a batch goes up, flies its slot, and comes down
 * so the next batch can go. It is also the answer to a wreck on the field —
 * the line is called down, somebody walks out to fetch it, and everybody
 * launches again. Both of those are the same event, which is why there is one
 * timer for it and one way to trigger it early.
 */
export const FESTIVAL_ROUND_SECONDS = 300;

/**
 * How long the pilot's wreck lies on the field before the day is called,
 * seconds.
 *
 * The field's own rule — down until the sky is empty, then everybody goes
 * again — is for the aircraft nobody has to sit and watch. The pilot is not one
 * of those: somebody whose wing is in the grass has nothing left to fly this
 * slot and no reason to watch out the rest of somebody else's afternoon from
 * the ground. Long enough to see where it landed, and then the day is over and
 * the choice is another slot or the clubhouse.
 */
export const FESTIVAL_WRECK_SECONDS = 2;

export interface FestivalSettings {
  /** Radius of the flying area, metres. */
  readonly areaRadius: number;
  /** AI aircraft sharing the sky with the player. */
  readonly aircraftCount: number;
  /** Length of the slot in seconds; `FESTIVAL_UNLIMITED` never ends it. */
  readonly durationSeconds: number;
  /**
   * What the field is flying. Left out it is a fly-in, which is what a
   * festival was before there was anything else to pick.
   */
  readonly event?: FestivalEvent;
}

export const DEFAULT_FESTIVAL: FestivalSettings = {
  areaRadius: 500,
  aircraftCount: 15,
  durationSeconds: 180,
  event: FESTIVAL_EVENT.FlyIn,
};

/** The event a set of settings asks for, whether or not it says so. */
export function festivalEventOf(settings: FestivalSettings): FestivalEvent {
  return normaliseFestivalEvent(settings.event);
}

/** True when the field is towing paper. */
export function isStreamerEvent(settings: FestivalSettings): boolean {
  return festivalEventOf(settings) === FESTIVAL_EVENT.Streamer;
}

export interface FestivalProgress {
  /** Aircraft still able to fly, the player included. */
  readonly flying: number;
  /** Aircraft of this wave that are out of it. */
  readonly down: number;
  /** Aircraft the wave launched with, the player included. */
  readonly total: number;
  /** Which wave is in the air, counting from one. */
  readonly wave: number;
  /** True while the player still has an aircraft in the air. */
  readonly playerFlying: boolean;
  /**
   * True once every AI aircraft is on the ground, which is when the field is
   * cleared and everybody launches again.
   */
  readonly fieldClear: boolean;
  /** True once the line has been called down and the field is landing. */
  readonly recalled: boolean;
  /** Seconds left of this round before the line is called down. */
  readonly roundRemaining: number;
  /** Seconds flown since the slot opened. */
  readonly elapsed: number;
  /** Length of the slot, seconds. Zero when it is unlimited. */
  readonly duration: number;
  /** Seconds left, or Infinity on an unlimited slot. */
  readonly remaining: number;
  readonly unlimited: boolean;
  /** Mid-airs anywhere on the field since the slot opened. */
  readonly midairs: number;
  /** How many of those the player was part of. */
  readonly playerMidairs: number;
  /** Waves flown, the one in the air included. */
  readonly wavesFlown: number;
  readonly finished: boolean;
  /** What the field turned up to fly. */
  readonly event: FestivalEvent;
  /**
   * The streamer board, at a streamer event and nowhere else.
   *
   * Null at a fly-in, where there is no paper in the air and nothing to score:
   * anything showing a scoreboard asks for it here rather than for the event,
   * so a fly-in cannot accidentally be given one.
   */
  readonly streamer: StreamerStandings | null;
}

/**
 * True while an aircraft is still part of what is in the air.
 *
 * A wreck spinning down is still up there — the field is not cleared while
 * something is on its way to it — and an aircraft that has reached the ground
 * is out of the wave whether it arrived well or badly. A wing sitting on the
 * grass is off the flight line, which is what the rule is actually about.
 */
function stillAloft(state: AircraftState): boolean {
  return (
    state.status === FLIGHT_STATUS.Flying ||
    state.status === FLIGHT_STATUS.Disabled ||
    state.status === FLIGHT_STATUS.Crashing
  );
}

/**
 * Counts the field and runs the slot clock.
 *
 * The wave is owned here and launched by whoever can actually put aircraft in
 * the sky: this only ever says "the field is clear", the same way the mission
 * runner says "relaunch" rather than spawning anything itself.
 */
export class FestivalTracker {
  readonly settings: FestivalSettings;
  /** What the field is flying: a fly-in, or paper. */
  readonly event: FestivalEvent;
  /** Length of the slot in seconds; zero on an unlimited one. */
  readonly duration: number;

  private waveNumber = 1;
  private waveSize: number;
  private elapsedSeconds = 0;
  private roundSeconds = 0;
  private recalledField = false;
  private midairCount = 0;
  private playerMidairCount = 0;
  private streamerStandings: StreamerStandings | null = null;

  private airborne: number;
  private flyingCount: number;
  private playerAirworthy = true;

  constructor(settings: FestivalSettings) {
    this.settings = settings;
    this.event = festivalEventOf(settings);
    this.duration = Math.max(settings.durationSeconds, 0);
    this.waveSize = settings.aircraftCount + 1;
    // The field the mission is about to launch, counted before it exists: a
    // tracker that reads as clear in the frame before anybody is spawned would
    // call the first wave over before it began.
    this.airborne = settings.aircraftCount;
    this.flyingCount = this.waveSize;
  }

  get unlimited(): boolean {
    return this.duration <= 0;
  }

  get elapsed(): number {
    return this.elapsedSeconds;
  }

  get remaining(): number {
    return this.unlimited
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.duration - this.elapsedSeconds);
  }

  get finished(): boolean {
    return !this.unlimited && this.elapsedSeconds >= this.duration;
  }

  /** True once nothing of the AI field is left in the air. */
  get fieldClear(): boolean {
    return this.airborne === 0;
  }

  /** True once the line has been called down and the field is landing. */
  get recalled(): boolean {
    return this.recalledField;
  }

  /** Seconds of this round left before the line is called down. */
  get roundRemaining(): number {
    return Math.max(0, FESTIVAL_ROUND_SECONDS - this.roundSeconds);
  }

  /**
   * Calls the line down early.
   *
   * What happens at a real one when somebody puts a model into the field:
   * everybody still up is asked to land so the wreck can be walked out to, and
   * then the whole line goes again. It is the same event as the end of a
   * round, so it is the same flag.
   */
  recall(): void {
    this.recalledField = true;
  }

  get wave(): number {
    return this.waveNumber;
  }

  get playerFlying(): boolean {
    return this.playerAirworthy;
  }

  get midairs(): number {
    return this.midairCount;
  }

  /**
   * Notes contacts the field has had. Both totals are kept: the debrief wants
   * to know how busy the day was, and how much of that was the pilot.
   */
  recordContacts(field: number, player: number): void {
    if (field > 0) this.midairCount += field;
    if (player > 0) this.playerMidairCount += player;
  }

  /**
   * Takes the streamer board as it stands.
   *
   * The paper is counted by the streamer field, which is the only thing that
   * knows where a ribbon is; what the tracker does with it is hand it to the
   * OSD and the debrief along with everything else about the day.
   */
  recordStreamers(standings: StreamerStandings | null): void {
    this.streamerStandings = standings;
  }

  /** The board, or null at a fly-in. */
  get streamer(): StreamerStandings | null {
    return this.streamerStandings;
  }

  /**
   * Starts another wave. `size` is what actually went up, the player included.
   *
   * Called by whoever put the aircraft there, so the count on the OSD is the
   * field that exists rather than the field that was asked for.
   */
  startWave(size: number): void {
    this.waveNumber += 1;
    this.waveSize = Math.max(size, 1);
    this.roundSeconds = 0;
    this.recalledField = false;
    // Nothing has been counted for the new wave yet, and the field must not
    // read as clear in the frame between launching it and seeing it.
    this.airborne = Math.max(size - 1, 0);
    this.flyingCount = size;
  }

  /** Counts what is in the air. */
  update(aircraft: readonly AircraftState[], dt: number): void {
    this.elapsedSeconds += dt;
    this.roundSeconds += dt;
    if (this.roundSeconds >= FESTIVAL_ROUND_SECONDS) this.recalledField = true;

    let airborne = 0;
    let flying = 0;
    let playerAirworthy = false;

    for (const state of aircraft) {
      const isPlayer = state.role === AIRCRAFT_ROLE.Player;
      if (!isPlayer && state.role !== AIRCRAFT_ROLE.Festival) continue;

      if (isAirworthy(state.status)) {
        flying += 1;
        if (isPlayer) playerAirworthy = true;
      }
      // The player is not part of the field the rule waits for: a pilot who
      // stays up all afternoon must not stop everybody else from launching
      // again, and one who is down is waiting on the same clearance as the
      // rest of the wreckage.
      if (!isPlayer && stillAloft(state)) airborne += 1;
    }

    this.airborne = airborne;
    this.flyingCount = flying;
    this.playerAirworthy = playerAirworthy;
  }

  get progress(): FestivalProgress {
    return {
      flying: this.flyingCount,
      down: Math.max(0, this.waveSize - this.flyingCount),
      total: this.waveSize,
      wave: this.waveNumber,
      playerFlying: this.playerAirworthy,
      fieldClear: this.fieldClear,
      recalled: this.recalledField,
      roundRemaining: this.roundRemaining,
      elapsed: this.elapsedSeconds,
      duration: this.duration,
      remaining: this.remaining,
      unlimited: this.unlimited,
      midairs: this.midairCount,
      playerMidairs: this.playerMidairCount,
      wavesFlown: this.waveNumber,
      finished: this.finished,
      event: this.event,
      streamer: this.streamerStandings,
    };
  }
}

/** How the day reads once the slot is over. */
export function festivalSummary(progress: FestivalProgress): string {
  const waves = `${progress.wavesFlown} wave${progress.wavesFlown === 1 ? "" : "s"}`;
  // A streamer event is scored on paper rather than on how quiet the day was,
  // so it is summed up by the board and the mid-airs come after it.
  if (progress.event === FESTIVAL_EVENT.Streamer && progress.streamer) {
    const midairs =
      progress.playerMidairs > 0
        ? ` ${progress.playerMidairs} mid-air${
            progress.playerMidairs === 1 ? "" : "s"
          } of your own on the way.`
        : "";
    return `${streamerSummary(progress.streamer)} ${waves} flown.${midairs}`;
  }
  if (progress.midairs === 0) {
    return `Slot flown: ${waves}, and nobody touched anybody.`;
  }
  const midairs = `${progress.midairs} mid-air${progress.midairs === 1 ? "" : "s"}`;
  const yours =
    progress.playerMidairs > 0
      ? ` — ${progress.playerMidairs} of them yours.`
      : ", none of them yours.";
  return `Slot flown: ${waves} and ${midairs}${yours}`;
}

/**
 * How the day reads when the pilot's own wing ended it.
 *
 * The slot was not flown out, so it is not summed up as one: what there is to
 * say is what went wrong, how much of the day was behind it, and — at a
 * streamer event — what that leaves on the board, because the paper already cut
 * is still cut.
 */
export function festivalLossSummary(
  progress: FestivalProgress,
  loss: string,
): string {
  const waves = `${progress.wavesFlown} wave${progress.wavesFlown === 1 ? "" : "s"}`;
  const midairs =
    progress.playerMidairs > 0
      ? `, and ${progress.playerMidairs} mid-air${
          progress.playerMidairs === 1 ? "" : "s"
        } of your own on the way`
      : "";
  const board =
    progress.event === FESTIVAL_EVENT.Streamer && progress.streamer
      ? ` ${streamerSummary(progress.streamer)}`
      : "";
  return `${loss} That is the day: ${waves} flown${midairs}.${board}`;
}

/** The area radius written the way the setup screen and the OSD say it. */
export function formatFestivalArea(metres: number): string {
  return metres < 1000 ? `${metres} m` : `${metres / 1000} km`;
}

/** The slot written the way the setup screen says it. */
export function formatFestivalSlot(seconds: number): string {
  return seconds === FESTIVAL_UNLIMITED
    ? "Unlimited"
    : `${Math.round(seconds / 60)} min`;
}
