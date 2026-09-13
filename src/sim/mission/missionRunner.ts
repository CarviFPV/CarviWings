/**
 * Mission state.
 *
 * Watches a running simulation and decides when the mission is won, lost, or
 * needs another airframe in the air. It reads the simulation and never writes
 * to it: relaunching is emitted as an event for the session to act on, so the
 * rule ("you have this many airframes") stays separate from the mechanism
 * ("put an aircraft here").
 *
 * Pure of any renderer, so the whole win/lose loop is testable in Node.
 */

import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import type { AircraftState } from "../flight/state";
import { isCrippled } from "../flight/damage";
import type { Simulation } from "../engine/simulation";
import type { MissionOutcome, MissionSettings, MissionStatus } from "./types";
import {
  MISSION_MODE,
  MISSION_OUTCOME,
  interceptorsFor,
  isCombatMission,
  isOpenFlight,
} from "./types";
import { FormationTracker, formationGrade, PASS_FRACTION } from "./formation";
import type { RaceCourse } from "./race";
import { RaceTracker, formatRaceTime, racePlacing } from "./race";
import {
  FESTIVAL_WRECK_SECONDS,
  FestivalTracker,
  festivalLossSummary,
  festivalSummary,
  isStreamerEvent,
} from "./festival";
import { StreamerField } from "./streamer";
import type { StreamerCut } from "./streamer";

export type MissionEvent =
  /** The player's airframe is gone; another is on its way if any remain. */
  | {
      readonly type: "AIRFRAME_LOST";
      readonly reason: string;
      /**
       * Contacts this airframe took with it.
       *
       * On a mission flown with the charge on the wing, arriving on a contact
       * is how the contact is destroyed: the wing is the weapon, and spending
       * it that way is the objective rather than a mistake. Anybody presenting
       * the loss reads this to know which of the two it was.
       */
      readonly kills: number;
    }
  /**
   * The festival field is clear and the next wave should go up.
   *
   * Everything that was in the air is on the ground, which is the one moment
   * anybody is allowed to launch. Whoever can actually put aircraft in the sky
   * acts on it; the rule lives here.
   */
  | { readonly type: "FESTIVAL_WAVE"; readonly wave: number }
  /**
   * The flight line has been called down: everybody still up is to land.
   *
   * The round is over, so the wave that is up makes way for the next one.
   * Whoever is flying those aircraft acts on it.
   */
  | { readonly type: "FESTIVAL_RECALL" }
  /**
   * A length of somebody's paper has come off.
   *
   * Raised for every cut on the field, not only the pilot's: the board on the
   * OSD moves when anybody cuts anything, and whoever is making the noise
   * decides which ones are worth hearing.
   */
  | { readonly type: "STREAMER_CUT"; readonly cut: StreamerCut }
  /** The player flew through a gate on a race course. */
  | {
      readonly type: "GATE";
      readonly gateIndex: number;
      readonly gateCount: number;
      readonly isFinish: boolean;
    }
  /** Put a fresh interceptor in the air. */
  | { readonly type: "RELAUNCH" }
  | { readonly type: "COMPLETE"; readonly reason: string }
  | { readonly type: "FAILED"; readonly reason: string };

/** Seconds between losing an airframe and the replacement being airborne. */
const RELAUNCH_DELAY = 3;

export class MissionRunner {
  readonly settings: MissionSettings;

  private outcome: MissionOutcome = MISSION_OUTCOME.InProgress;
  private interceptorsRemaining: number;
  private relaunchTimer = 0;
  private awaitingRelaunch = false;
  private lossHandled = false;
  /**
   * True once the flight has actually been handed an aircraft.
   *
   * A mission is stepped from the frame loop, and the frame loop starts
   * turning while the world around the start point is still being built — the
   * terrain sampled, the launch surface levelled, the aircraft not yet put on
   * it. An empty sky in those frames is a flight that has not begun rather
   * than one that is already over, and reporting it as a loss ends a flight
   * before the pilot has been given anything to lose.
   */
  private airframeIssued = false;
  /** Contacts already charged to an airframe the pilot has finished with. */
  private killsCredited = 0;
  private reason = "";
  private enemiesEverSpawned = 0;
  private lastContactCount = 0;
  private readonly events: MissionEvent[] = [];

  /**
   * Scores the formation flight, on a formation mission and nowhere else.
   *
   * The runner owns it because holding the slot *is* the objective here, the
   * way destroying the last contact is the objective on an intercept.
   */
  readonly formation: FormationTracker | null;

  /**
   * Times the race, on a race and nowhere else.
   *
   * Null until the course exists: a course is laid out against real terrain
   * while the flight is loading, so unlike a formation slot it cannot be known
   * the moment the mission is configured.
   */
  private raceTracker: RaceTracker | null = null;

  /**
   * Counts the field and runs the slot clock, at a festival and nowhere else.
   *
   * The runner owns it because the festival's whole rule — down until the sky
   * is empty, then everybody goes again — is a mission rule rather than
   * something an aircraft or a renderer could decide.
   */
  readonly festival: FestivalTracker | null;

  /**
   * Every ribbon in the air, at a streamer event and nowhere else.
   *
   * Owned by the runner for the same reason the festival tracker is: what a
   * cut is worth and who it belongs to is a mission rule. Putting the paper on
   * an aircraft is whoever spawned it — the field is told which airframes are
   * towing what, the same way the race is told where its gates are.
   */
  readonly streamers: StreamerField | null;

  /** Contacts already counted into the festival's tally. */
  private lastFieldCollisions = 0;
  /** True while the wave in the air is still waiting to be cleared. */
  private waveLaunched = true;
  /** True once this wave's recall has been passed on. */
  private recallCalled = false;
  /**
   * What ended the pilot's day at a festival, once their wing has ended it.
   *
   * Null while there is still something to fly. Set, it is the reason the
   * airframe was lost, held until the wreck has had its seconds on the grass
   * and the day can be called with it.
   */
  private festivalLoss: string | null = null;
  /** Seconds of those left to run. */
  private festivalWreckTimer = 0;

  constructor(settings: MissionSettings) {
    this.settings = settings;
    this.interceptorsRemaining = interceptorsFor(settings);
    this.formation =
      settings.mode === MISSION_MODE.Formation
        ? new FormationTracker(settings.formation)
        : null;
    this.festival =
      settings.mode === MISSION_MODE.Festival
        ? new FestivalTracker(settings.festival)
        : null;
    this.streamers =
      settings.mode === MISSION_MODE.Festival && isStreamerEvent(settings.festival)
        ? new StreamerField()
        : null;
  }

  /** Hands the runner the course, once it has been laid out and validated. */
  setRaceCourse(course: RaceCourse): RaceTracker {
    const tracker = new RaceTracker(course);
    this.raceTracker = tracker;
    return tracker;
  }

  /** The race being timed, or null off a race. */
  get race(): RaceTracker | null {
    return this.raceTracker;
  }

  /** Called once the mission's enemies are in the air. */
  setEnemyCount(count: number): void {
    this.enemiesEverSpawned = count;
  }

  get status(): MissionStatus {
    return {
      outcome: this.outcome,
      enemiesRemaining: this.lastEnemiesRemaining,
      enemiesDestroyed: this.lastEnemiesDestroyed,
      interceptorsRemaining: this.interceptorsRemaining,
      relaunching: this.awaitingRelaunch,
      relaunchIn: Math.max(0, this.relaunchTimer),
      reason: this.reason,
      formation: this.formation?.progress,
      race: this.raceTracker?.progress,
      festival: this.festival?.progress,
    };
  }

  private lastEnemiesRemaining = 0;
  private lastEnemiesDestroyed = 0;

  /**
   * Advances the mission. Returns the events raised this frame; the array is
   * reused, so consume it before calling again.
   */
  update(simulation: Simulation, dt: number): readonly MissionEvent[] {
    this.events.length = 0;
    this.lastEnemiesRemaining = simulation.enemyCount;
    this.lastEnemiesDestroyed = simulation.statistics.enemiesDestroyed;

    if (this.outcome !== MISSION_OUTCOME.InProgress) {
      this.lastContactCount = simulation.playerContactCount;
      return this.events;
    }

    // Winning is checked first: taking the last enemy with you still wins.
    // A strike is won the same way an interception is — an escort left in the
    // air is still a contact, and the mission is over when the sky is empty.
    if (
      isCombatMission(this.settings.mode) &&
      this.enemiesEverSpawned > 0 &&
      this.lastEnemiesRemaining === 0
    ) {
      this.finish(MISSION_OUTCOME.Complete, "Every contact destroyed.");
      return this.events;
    }

    // A dead video link outranks everything else that could still be decided
    // this frame: whatever the aircraft was in the middle of, it is gone.
    if (this.updateVideoLink(simulation)) {
      return this.events;
    }

    // Before anything that could be waiting on it: the festival's own rule is
    // what decides when an airframe on the ground is allowed back up.
    if (this.festival && this.updateFestival(simulation, dt)) {
      return this.events;
    }

    if (this.formation && this.updateFormation(simulation, dt)) {
      return this.events;
    }

    if (this.raceTracker && this.updateRace(simulation)) {
      return this.events;
    }

    const player = simulation.player;
    // The one thing that has to be remembered about the aircraft: that there
    // has been one. Everything below asks whether it is still there, and until
    // the flight has been given one at all that question has no answer.
    if (player) this.airframeIssued = true;

    if (this.awaitingRelaunch) {
      this.relaunchTimer -= dt;
      if (this.relaunchTimer <= 0) {
        this.awaitingRelaunch = false;
        this.lossHandled = false;
        this.events.push({ type: "RELAUNCH" });
      }
      return this.events;
    }

    if (this.airframeIssued && (!player || isLost(player))) {
      if (this.lossHandled) return this.events;
      this.lossHandled = true;
      this.handleAirframeLost(simulation, player);
    }

    return this.events;
  }

  /**
   * Checks the video link. Returns true once it has ended the mission.
   *
   * The link itself is stepped by the simulation and counts its own seconds of
   * dead picture; the rule here is only what that means — fly beyond the
   * transmitter's reach and stay there long enough, and the airframe is not
   * coming back, whatever else the mission had planned for it.
   */
  private updateVideoLink(simulation: Simulation): boolean {
    const link = simulation.videoLink?.state;
    if (!link || !link.failed) return false;
    this.finish(
      MISSION_OUTCOME.Failed,
      `Video link lost for ${Math.round(link.timeout)} s. The airframe flew on out of range.`,
    );
    return true;
  }

  /**
   * Advances the race. Returns true once it has decided the mission.
   *
   * The clock is the tracker's business; what belongs here is only what the
   * race means for the mission — a gate worth telling the pilot about, and the
   * finish line, which ends it.
   */
  private updateRace(simulation: Simulation): boolean {
    const race = this.raceTracker;
    if (!race) return false;

    for (const event of race.update(simulation.aircraft, simulation.time)) {
      if (!event.isPlayer) continue;
      if (event.type === "GATE") {
        this.events.push({
          type: "GATE",
          gateIndex: event.gateIndex,
          gateCount: race.gateCount,
          isFinish: event.isFinish,
        });
      }
    }

    const progress = race.progress;
    if (!progress.finished) return false;

    // The race is over for the pilot the moment they cross the line, whatever
    // the rest of the field is still doing: the time is set and the place is
    // decided by everyone who was already home.
    const place = racePlacing(progress.position);
    this.finish(
      MISSION_OUTCOME.Complete,
      progress.racerCount > 1
        ? `Finished ${place} of ${progress.racerCount} in ${formatRaceTime(
            progress.elapsed,
          )}.`
        : `Course flown in ${formatRaceTime(progress.elapsed)}.`,
    );
    return true;
  }

  /**
   * Advances the festival.
   *
   * Three things happen here and nothing else: the field is counted, when it is
   * empty the next wave is called for, and a pilot whose own wing is in the
   * grass has their day called. Putting the aircraft there is somebody else's
   * job — this only ever says that the sky is clear, which is the same division
   * the relaunch rule has always been written to.
   *
   * Returns true once it has decided the frame: the slot has run out, or the
   * pilot's own wing is in the field and the day is being called on it.
   */
  private updateFestival(simulation: Simulation, dt: number): boolean {
    const festival = this.festival;
    if (!festival) return false;

    festival.update(simulation.aircraft, dt);

    // The paper, before anything that reads the board: a cut in this frame is
    // on the OSD in this frame.
    const streamers = this.streamers;
    if (streamers) {
      for (const cut of streamers.update(simulation.aircraft)) {
        this.events.push({ type: "STREAMER_CUT", cut });
      }
      festival.recordStreamers(streamers.standings());
    }

    // Everything that touched anything, and the pilot's share of it. A day at
    // a fly-in is measured in mid-airs as much as in minutes.
    const collisions = simulation.statistics.collisions;
    const contacts = simulation.playerContactCount;
    festival.recordContacts(
      collisions - this.lastFieldCollisions,
      contacts - this.lastContactCount,
    );
    this.lastFieldCollisions = collisions;
    this.lastContactCount = contacts;

    // The pilot's wing is in the field, so the afternoon is theirs no longer:
    // the wreck lies there for as long as it takes to see where it went, and
    // then the day is called. Nothing else is decided in those seconds — the
    // field flies on around it, but there is no wave to put this pilot in and
    // no slot left for them to fly out.
    if (this.festivalLoss !== null) {
      this.festivalWreckTimer -= dt;
      if (this.festivalWreckTimer <= 0) {
        this.finish(
          MISSION_OUTCOME.Failed,
          festivalLossSummary(festival.progress, this.festivalLoss),
        );
      }
      return true;
    }

    // The line is called down once per wave, and everybody still up is asked
    // to put it on the ground rather than being taken out of the sky.
    if (festival.recalled && !this.recallCalled) {
      this.recallCalled = true;
      this.events.push({ type: "FESTIVAL_RECALL" });
    }

    if (!festival.fieldClear) {
      // Something is up there, so the next launch is owed again.
      this.waveLaunched = true;
    } else if (this.waveLaunched) {
      this.waveLaunched = false;
      this.recallCalled = false;
      this.events.push({ type: "FESTIVAL_WAVE", wave: festival.wave + 1 });
    }

    if (festival.finished) {
      this.finish(MISSION_OUTCOME.Complete, festivalSummary(festival.progress));
      return true;
    }

    return false;
  }

  /**
   * Advances the formation exercise. Returns true once it has decided the
   * mission, so the caller stops looking at anything else this frame.
   */
  private updateFormation(simulation: Simulation, dt: number): boolean {
    const formation = this.formation;
    if (!formation) return false;

    // A mid-air is noted and nothing more. What it costs the pilot is already
    // on the airframe — a wing that no longer holds a slot the way it did on
    // take-off — and the routine goes on for as long as there is something to
    // fly it with.
    const contacts = simulation.playerContactCount;
    formation.recordContacts(contacts - this.lastContactCount);
    this.lastContactCount = contacts;

    const player = simulation.player;
    const flyable = player !== null && !isLost(player) && !this.awaitingRelaunch;
    formation.update(flyable ? player : null, simulation.lead, dt);

    if (formation.abandoned) {
      this.finish(
        MISSION_OUTCOME.Failed,
        "You lost contact with the flight and never rejoined.",
      );
      return true;
    }

    // The routine needs somebody to fly it on, but a leader that has just been
    // knocked out of the sky is still in the air on its way down: the exercise
    // waits for it to arrive rather than ending underneath a falling wreck.
    if (!simulation.lead && leadIsFinished(simulation)) {
      this.finish(MISSION_OUTCOME.Failed, "The leader went down.");
      return true;
    }

    if (formation.finished) {
      const percent = Math.round(formation.score * 100);
      const grade = formationGrade(formation.score);
      const midairs = formation.contacts;
      const contact =
        midairs > 0
          ? ` ${midairs} mid-air${midairs === 1 ? "" : "s"} on the way.`
          : "";
      this.finish(
        formation.passed ? MISSION_OUTCOME.Complete : MISSION_OUTCOME.Failed,
        formation.passed
          ? `${grade}: in station for ${percent}% of the routine.${contact}`
          : `${grade}: in station for ${percent}% of the routine, and ${Math.round(
              PASS_FRACTION * 100,
            )}% is needed.${contact}`,
      );
      return true;
    }

    return false;
  }

  private handleAirframeLost(
    simulation: Simulation,
    player: AircraftState | null,
  ): void {
    // Three ways to lose a wing, and the pilot deserves to be told which.
    // An airframe crippled in a mid-air reaches the ground like any other
    // wreck, so the damage on it is what says where it really started.
    const destroyed = player?.status === FLIGHT_STATUS.Destroyed;
    const midAir = destroyed || (player !== null && isCrippled(player.damage));

    // What this airframe took with it, counted only when the mid-air is what
    // finished it: a contact brought down on a pass the pilot flew away from
    // was paid for by the airframe that eventually went into a hill, and that
    // is a wing thrown away rather than a wing spent. The wing *is* the weapon
    // on an interception or a strike, so a wing spent on a contact is the
    // mission going to plan, and it is told as one.
    const scored = simulation.playerKillCount - this.killsCredited;
    this.killsCredited = simulation.playerKillCount;
    const kills = midAir ? scored : 0;

    const reason =
      kills > 0
        ? kills === 1
          ? "The contact went down with the wing, which is what the wing is for."
          : `${kills} contacts went down with the wing, which is what the wing is for.`
        : destroyed
          ? "Airframe destroyed in a mid-air collision."
          : midAir
            ? "Airframe crippled in a mid-air collision and went in."
            : "Airframe lost to terrain.";
    this.interceptorsRemaining -= 1;
    this.events.push({ type: "AIRFRAME_LOST", reason, kills });

    // Going flying has no reserve and nothing to come back for.
    if (isOpenFlight(this.settings.mode)) {
      this.finish(MISSION_OUTCOME.Failed, reason);
      return;
    }

    // At a festival there is always another aeroplane in the car, but there is
    // no putting it up in the middle of somebody else's slot — and standing on
    // the flight line watching the rest of the afternoon out is not flying. So
    // the wing that went in ends the day: the wreck is given its seconds on the
    // grass, and then the pilot is asked whether they want another slot.
    if (this.settings.mode === MISSION_MODE.Festival) {
      this.festivalLoss = reason;
      this.festivalWreckTimer = FESTIVAL_WRECK_SECONDS;
      return;
    }

    if (this.interceptorsRemaining <= 0) {
      this.finish(
        MISSION_OUTCOME.Failed,
        `${reason} No airframes left.`,
      );
      return;
    }

    this.awaitingRelaunch = true;
    this.relaunchTimer = RELAUNCH_DELAY;
  }

  private finish(outcome: MissionOutcome, reason: string): void {
    this.outcome = outcome;
    this.reason = reason;
    this.awaitingRelaunch = false;
    this.events.push(
      outcome === MISSION_OUTCOME.Complete
        ? { type: "COMPLETE", reason }
        : { type: "FAILED", reason },
    );
  }
}


function isLost(player: AircraftState): boolean {
  return (
    player.status === FLIGHT_STATUS.Crashed ||
    player.status === FLIGHT_STATUS.Destroyed
  );
}

/**
 * True once the aircraft the routine was flown on is done falling.
 *
 * `Simulation.lead` only reports a leader that is still flying, which is the
 * right answer for scoring and the wrong one for calling the exercise off: a
 * leader hit in a mid-air stops being airworthy long before it stops being in
 * the air. Nothing in this simulator ends while there is still something
 * coming down.
 */
function leadIsFinished(simulation: Simulation): boolean {
  const lead = simulation.aircraft.find(
    (aircraft) => aircraft.role === AIRCRAFT_ROLE.Lead,
  );
  return lead === undefined || isLost(lead);
}
