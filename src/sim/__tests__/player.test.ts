import { assert, assertClose, suite } from "./harness";
import type { MissionSettings, MissionStatus } from "../mission/types";
import {
  DEFAULT_FORMATION,
  DEFAULT_VTX_POWER_MW,
  MISSION_MODE,
  MISSION_OUTCOME,
} from "../mission/types";
import { DEFAULT_RACE } from "../mission/race";
import { DEFAULT_FESTIVAL } from "../mission/festival";
import { DEFAULT_STRIKE } from "../mission/strike";
import { DEFAULT_OPPOSITION } from "../mission/opposition";
import { WEATHER, TIME_OF_DAY } from "../environment/types";
import { DIFFICULTY } from "../ai/types";
import { createStatistics } from "../flight/telemetry";
import type { FlightStatistics } from "../flight/telemetry";
import type { FlightRecord, PlayerProfile, Roster } from "../player";
import {
  EMPTY_ROSTER,
  MAX_CALLSIGN_LENGTH,
  MAX_LOG_RECORDS,
  MAX_PLAYERS,
  activePlayer,
  addPlayer,
  addRecord,
  callsignRejection,
  createPlayerId,
  createProfile,
  flightRecord,
  normaliseCallsign,
  normaliseLog,
  normaliseRoster,
  personalBests,
  removePlayer,
  renamePlayer,
  rosterFull,
  selectPlayer,
  summariseCareer,
  touchPlayer,
  PILOT_BACKUP_FORMAT,
  backupFileName,
  pilotBackup,
  readPilotBackup,
  uniqueCallsign,
} from "../player";

function withPilots(...callsigns: string[]): Roster {
  let roster = EMPTY_ROSTER;
  callsigns.forEach((callsign, index) => {
    roster = addPlayer(roster, createProfile(`id-${index}`, callsign, 1000 + index));
  });
  return roster;
}

function settings(overrides: Partial<MissionSettings> = {}): MissionSettings {
  return {
    mode: MISSION_MODE.Intercept,
    locationName: "Interlaken",
    latitude: 46.5375,
    longitude: 7.9625,
    missionRadius: 10000,
    spawnAltitudeAgl: 300,
    weather: WEATHER.Clear,
    timeOfDay: TIME_OF_DAY.Day,
    enemyCount: 3,
    difficulty: DIFFICULTY.Normal,
    combat: true,
    formation: DEFAULT_FORMATION,
    race: DEFAULT_RACE,
    festival: DEFAULT_FESTIVAL,
    strike: DEFAULT_STRIKE,
    opposition: DEFAULT_OPPOSITION,
    vtxPowerMw: DEFAULT_VTX_POWER_MW,
    seed: "TESTSEED",
    ...overrides,
  };
}

function status(overrides: Partial<MissionStatus> = {}): MissionStatus {
  return {
    outcome: MISSION_OUTCOME.Complete,
    enemiesRemaining: 0,
    enemiesDestroyed: 3,
    interceptorsRemaining: 2,
    relaunching: false,
    relaunchIn: 0,
    reason: "Area clear.",
    ...overrides,
  };
}

function statistics(overrides: Partial<FlightStatistics> = {}): FlightStatistics {
  return { ...createStatistics(), ...overrides };
}

function record(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    ...flightRecord(settings(), statistics(), status(), 10_000),
    ...overrides,
  };
}

export function runPlayerTests(): void {
  suite("a callsign is stored the way it reads", () => {
    assert(
      normaliseCallsign("  Carvi   FPV  ") === "Carvi FPV",
      "the spacing people type is not part of the name",
    );
    assert(
      normaliseCallsign("Carvi\n\tFPV") === "Carvi FPV",
      "and neither is anything pasted in with it",
    );
    assert(
      normaliseCallsign("C".repeat(40)).length === MAX_CALLSIGN_LENGTH,
      "a name longer than the field holds is cut to it",
    );

    const roster = withPilots("Carvi");
    assert(
      callsignRejection("Carvi FPV", roster) === null,
      "a free callsign is accepted",
    );
    assert(
      callsignRejection("x", roster) !== null,
      "a single character is not a callsign",
    );
    assert(
      callsignRejection("  carvi ", roster) !== null,
      "and one already flying here is refused whatever its case",
    );
    assert(
      callsignRejection("carvi", roster, "id-0") === null,
      "though a pilot may keep their own name through a rename",
    );
  });

  suite("the roster holds pilots and one of them is flying", () => {
    const roster = withPilots("Carvi", "Nadia");
    assert(roster.players.length === 2, "both pilots are on it");
    assert(
      activePlayer(roster)?.callsign === "Nadia",
      "the pilot just created is the one flying",
    );

    const back = selectPlayer(roster, "id-0");
    assert(activePlayer(back)?.callsign === "Carvi", "and another can be picked");
    assert(
      selectPlayer(back, "nobody") === back,
      "selecting a pilot who is not there changes nothing",
    );

    const renamed = renamePlayer(back, "id-0", "  Carvi FPV ");
    assert(
      activePlayer(renamed)?.callsign === "Carvi FPV",
      "a rename stores the tidied name",
    );
    assert(
      activePlayer(renamed)?.id === "id-0",
      "and leaves the identifier alone, so the logbook follows the pilot",
    );
    assert(
      renamePlayer(back, "id-0", " x ") === back,
      "a rename to something that is not a callsign is refused",
    );

    const flown = touchPlayer(renamed, "id-0", 55_000);
    assert(
      flown.players[0]?.lastFlownAt === 55_000,
      "flying is recorded against the pilot who did it",
    );
    assert(
      flown.players[1]?.lastFlownAt === null,
      "and against nobody else",
    );
  });

  suite("deleting the pilot who is flying leaves somebody flying", () => {
    const roster = withPilots("Carvi", "Nadia", "Theo");

    const middle = removePlayer(selectPlayer(roster, "id-1"), "id-1");
    assert(middle.players.length === 2, "the pilot is gone");
    assert(
      activePlayer(middle)?.id === "id-2",
      "and their neighbour in the list takes the slot",
    );

    const last = removePlayer(roster, "id-2");
    assert(
      activePlayer(last)?.id === "id-1",
      "deleting the last pilot falls back up the list",
    );

    const other = removePlayer(selectPlayer(roster, "id-0"), "id-2");
    assert(
      activePlayer(other)?.id === "id-0",
      "deleting somebody else does not move the active slot",
    );

    const emptied = removePlayer(removePlayer(removePlayer(roster, "id-0"), "id-1"), "id-2");
    assert(
      emptied.players.length === 0 && emptied.activeId === null,
      "and deleting the last of them leaves the first-run roster",
    );
  });

  suite("a pilot identifier is unique even when the draw is not", () => {
    const first = createPlayerId([], () => 0);
    assert(first.length === 10, "an identifier is a fixed length");
    assert(
      createPlayerId([first], () => 0) === "pilot-1",
      "a source that keeps handing back the same draw still yields a free identifier",
    );
    assert(
      createPlayerId([first, "pilot-2", "pilot-3"], () => 0) === "pilot-4",
      "and the fallback keeps counting past the ones already taken",
    );
    assert(
      createPlayerId([], () => 0.999999) !== "",
      "a draw at the top of the range stays inside the alphabet",
    );
  });

  suite("a stored roster is repaired before it is used", () => {
    assert(
      normaliseRoster(undefined).players.length === 0,
      "nothing stored is an empty roster, not a crash",
    );
    assert(
      normaliseRoster({ players: "carvi" }).players.length === 0,
      "and neither is a roster that is not a list",
    );

    const repaired = normaliseRoster({
      players: [
        { id: "a", callsign: "Carvi", createdAt: 1 },
        { id: "a", callsign: "Impostor", createdAt: 2 },
        { id: "b", callsign: " ", createdAt: 3 },
        { callsign: "Nameless", createdAt: 4 },
        { id: "c", callsign: "Nadia", createdAt: 5, lastFlownAt: 9 },
      ],
      activeId: "deleted-pilot",
    });
    assert(
      repaired.players.map((player) => player.id).join(",") === "a,c",
      "a duplicate identifier, an empty callsign and a pilot with no identifier are dropped",
    );
    assert(
      repaired.activeId === "a",
      "an active identifier naming nobody falls back to the first pilot",
    );
    assert(
      repaired.players[0]?.lastFlownAt === null,
      "a pilot who has never flown says so rather than reading as epoch zero",
    );

    const crowded = normaliseRoster({
      players: Array.from({ length: MAX_PLAYERS + 4 }, (_, index) => ({
        id: `p${index}`,
        callsign: `Pilot ${index}`,
        createdAt: index,
      })),
    });
    assert(
      crowded.players.length === MAX_PLAYERS && rosterFull(crowded),
      "and a roster longer than the limit is cut back to it",
    );
  });

  suite("a flight is written down as the debrief showed it", () => {
    const intercept = flightRecord(
      settings(),
      statistics({ flightTime: 240, distanceFlown: 12_500, maxAirspeed: 41, crashes: 1 }),
      status(),
      50_000,
    );
    assert(intercept.complete, "a mission flown to its objective is complete");
    assert(
      intercept.enemiesDestroyed === 3,
      "the kill count comes from the mission, not the raw statistics",
    );
    assert(
      intercept.raceTime === null && intercept.formationScore === null,
      "and nothing is recorded for the modes that were not flown",
    );

    const unfinished = flightRecord(
      settings({ mode: MISSION_MODE.Race }),
      statistics(),
      status({
        outcome: MISSION_OUTCOME.Failed,
        race: {
          started: true,
          finished: false,
          gatesPassed: 4,
          gateCount: 9,
          nextGate: 4,
          elapsed: 61.2,
          position: 3,
          racerCount: 4,
          gapToLeader: 300,
          standings: [],
        },
      }),
      60_000,
    );
    assert(
      unfinished.raceTime === null,
      "a race that was not finished leaves no time behind to beat",
    );

    const finished = flightRecord(
      settings({ mode: MISSION_MODE.Race }),
      statistics(),
      status({
        race: {
          started: true,
          finished: true,
          gatesPassed: 9,
          gateCount: 9,
          nextGate: 9,
          elapsed: 94.5,
          position: 2,
          racerCount: 4,
          gapToLeader: 40,
          standings: [],
        },
      }),
      61_000,
    );
    assertClose(finished.raceTime ?? 0, 94.5, 1e-9, "a finished race keeps its time");
    assert(
      finished.racePosition === 2 && finished.raceFieldSize === 4,
      "with the place taken and the size of the field it was taken in",
    );
  });

  suite("the logbook keeps the flights and stays inside its limit", () => {
    let log: readonly FlightRecord[] = [];
    for (let i = 0; i < MAX_LOG_RECORDS + 25; i += 1) {
      log = addRecord(log, record({ flownAt: i }));
    }
    assert(log.length === MAX_LOG_RECORDS, "the log is held to its limit");
    assert(
      log[0]?.flownAt === MAX_LOG_RECORDS + 24,
      "the newest flight is at the top",
    );
    assert(
      log[log.length - 1]?.flownAt === 25,
      "and the oldest ones are what fell off it",
    );
  });

  suite("a career adds up out of the log", () => {
    const career = summariseCareer([
      record({ flightTime: 300, distanceFlown: 20_000, maxAirspeed: 44, maxAltitudeAgl: 620 }),
      record({
        mode: MISSION_MODE.FreeFlight,
        complete: false,
        flightTime: 640,
        distanceFlown: 30_000,
        maxAirspeed: 38,
        maxAltitudeAgl: 1200,
        enemiesDestroyed: 0,
        landings: 1,
      }),
      record({ complete: false, flightTime: 120, distanceFlown: 8_000, crashes: 1 }),
    ]);

    assert(career.flights === 3, "every flight counts");
    assert(
      career.missionsFlown === 2 && career.missionsComplete === 1,
      "but only a mission can be completed, and free flight is not one",
    );
    assertClose(career.flightTime, 1060, 1e-9, "the hours add up");
    assertClose(career.distanceFlown, 58_000, 1e-9, "and so does the distance");
    assert(career.enemiesDestroyed === 6, "kills across the career are totalled");
    assertClose(career.topSpeed, 44, 1e-9, "the top speed is the best of them");
    assertClose(career.highestAgl, 1200, 1e-9, "and so is the height");
    assertClose(career.longestFlight, 640, 1e-9, "the longest flight is one flight");
    assert(career.crashes === 1 && career.landings === 1, "so are the arrivals");

    const empty = summariseCareer([]);
    assert(
      empty.flights === 0 && empty.topSpeed === 0,
      "a pilot who has not flown has a career of noughts rather than nothing",
    );
  });

  suite("personal bests are only comparable against the same course", () => {
    const bests = personalBests([
      record({ mode: MISSION_MODE.Race, locationName: "Interlaken", raceTime: 96.2, racePosition: 2, raceFieldSize: 4 }),
      record({ mode: MISSION_MODE.Race, locationName: "Interlaken", raceTime: 91.4, racePosition: 1, raceFieldSize: 4 }),
      record({ mode: MISSION_MODE.Race, locationName: "Verbier", raceTime: 140.8, racePosition: 3, raceFieldSize: 4 }),
      record({ mode: MISSION_MODE.Formation, formationScore: 0.62 }),
      record({ mode: MISSION_MODE.Formation, formationScore: 0.81 }),
      record({ mode: MISSION_MODE.Festival, festivalWaves: 3 }),
      record({ enemiesDestroyed: 7 }),
    ]);

    assert(bests.races.length === 2, "one time per course, not one per race");
    assertClose(
      bests.races[0]?.time ?? 0,
      91.4,
      1e-9,
      "the fastest run at a place is the one kept",
    );
    assert(
      bests.races[0]?.locationName === "Interlaken",
      "and the fastest course is listed first",
    );
    assertClose(bests.formationScore ?? 0, 0.81, 1e-9, "the best display is kept");
    assert(bests.festivalWaves === 3, "and the longest slot at a fly-in");
    assert(
      bests.enemiesInOneFlight === 7,
      "the biggest haul is one flight's, not the career's",
    );

    const none = personalBests([record({ mode: MISSION_MODE.FreeFlight, enemiesDestroyed: 0 })]);
    assert(
      none.races.length === 0 &&
        none.formationScore === null &&
        none.festivalWaves === null &&
        none.enemiesInOneFlight === null,
      "a mode never flown has no best, rather than a best of nought",
    );
  });

  suite("a stored logbook is repaired before it is read", () => {
    const log = normaliseLog([
      { mode: "NOT_A_MODE", flownAt: 5 },
      "a flight",
      { mode: MISSION_MODE.Race, flownAt: 10, locationName: "Verbier", raceTime: 88 },
      {
        mode: MISSION_MODE.Intercept,
        flownAt: 30,
        flightTime: Number.NaN,
        distanceFlown: -20,
        enemiesDestroyed: 2.6,
        difficulty: "IMPOSSIBLE",
      },
    ]);

    assert(log.length === 2, "anything that is not a flight is dropped");
    assert(log[0]?.flownAt === 30, "and what is left is newest first");
    assert(
      log[0]?.flightTime === 0 && log[0]?.distanceFlown === 0,
      "a number that is not one reads as nought rather than poisoning the career",
    );
    assert(
      log[0]?.enemiesDestroyed === 3,
      "a count is a whole number of aircraft",
    );
    assert(
      log[0]?.difficulty === DIFFICULTY.Normal,
      "and a difficulty this build no longer has falls back to the middle one",
    );
    assert(
      log[1]?.locationName === "Verbier" && log[1]?.raceTime === 88,
      "a sound record comes back as it was written",
    );
    assert(normaliseLog(null).length === 0, "nothing stored is an empty logbook");
    assert(
      summariseCareer(log).flights === 2,
      "and the career built from a repaired log adds up",
    );
  });

  suite("a pilot is a file, so they outlive the browser they flew in", () => {
    const profile: PlayerProfile = {
      id: "abc123",
      callsign: "Vertigo",
      createdAt: 1_000,
      lastFlownAt: 5_000,
    };
    const log: readonly FlightRecord[] = normaliseLog([
      {
        mode: MISSION_MODE.Race,
        locationName: "Verbier",
        difficulty: DIFFICULTY.Hard,
        flownAt: 4_000,
        complete: true,
        flightTime: 90,
        distanceFlown: 4200,
        maxAltitudeAgl: 180,
        maxAirspeed: 44,
        enemiesDestroyed: 0,
        collisions: 0,
        crashes: 0,
        landings: 1,
        raceTime: 88,
        racePosition: 1,
        raceFieldSize: 4,
        formationScore: null,
        festivalWaves: null,
      },
    ]);
    const stores = {
      "fpv-wing-settings": { state: { audioVolume: 0.3 }, version: 8 },
      "fpv-wing-keybindings": { state: { bindings: {} }, version: 1 },
    };

    // Written out, put through a file, and read back the way a restore does.
    const written = JSON.stringify(pilotBackup(profile, log, stores, 9_000));
    const read = readPilotBackup(JSON.parse(written));

    assert(read.ok, "a backup this build wrote is one it can read");
    if (read.ok) {
      assert(
        read.backup.format === PILOT_BACKUP_FORMAT,
        "and it names itself, so another file cannot be mistaken for one",
      );
      assert(
        read.backup.callsign === "Vertigo" && read.backup.createdAt === 1_000,
        "the pilot comes back as themselves, not as somebody new",
      );
      assert(
        read.backup.log.length === 1 && read.backup.log[0]?.raceTime === 88,
        "with the logbook they earned",
      );
      const settings = read.backup.stores["fpv-wing-settings"] as {
        state?: { audioVolume?: number };
        version?: number;
      };
      assert(
        settings?.state?.audioVolume === 0.3 && settings.version === 8,
        "and each stored block arrives as it was stored, version and all",
      );
    }
  });

  suite("a file that is not a backup is refused, with the reason", () => {
    const foreign = readPilotBackup({ hello: "world" });
    assert(!foreign.ok, "another application's JSON is not a pilot");

    const nothing = readPilotBackup("not even an object");
    assert(!nothing.ok, "and neither is a file that is not an object at all");

    const newer = readPilotBackup({
      format: PILOT_BACKUP_FORMAT,
      version: 99,
      callsign: "Vertigo",
    });
    assert(
      !newer.ok,
      "a backup from a newer build is refused rather than half-read",
    );

    const nameless = readPilotBackup({
      format: PILOT_BACKUP_FORMAT,
      version: 1,
      callsign: "V",
    });
    assert(!nameless.ok, "a backup with no usable callsign names nobody");
    if (!nameless.ok) {
      assert(nameless.reason.length > 0, "and every refusal says why");
    }
  });

  suite("a hand-edited backup is repaired rather than trusted", () => {
    const read = readPilotBackup({
      format: PILOT_BACKUP_FORMAT,
      version: 1,
      exportedAt: "soon",
      callsign: "  ace   pilot  ",
      createdAt: Number.NaN,
      lastFlownAt: "yesterday",
      log: [{ mode: "NOT_A_MODE" }, { mode: MISSION_MODE.FreeFlight, flownAt: 7 }],
      stores: {
        "fpv-wing-settings": { state: {}, version: 3 },
        "fpv-wing-broken": "a string is not a stored block",
      },
    });

    assert(read.ok, "anything repairable is repaired rather than refused");
    if (read.ok) {
      assert(
        read.backup.callsign === "ace pilot",
        "the callsign is stored the way it reads",
      );
      assert(
        read.backup.exportedAt === 0 && read.backup.createdAt === 0,
        "a date that is not one reads as unknown",
      );
      assert(read.backup.lastFlownAt === null, "as does a last flight");
      assert(
        read.backup.log.length === 1,
        "a record naming a mode this build lacks is dropped",
      );
      assert(
        read.backup.stores["fpv-wing-broken"] === undefined,
        "and a block nothing could load never reaches storage",
      );
    }
  });

  suite("a restored pilot never writes over one already flying", () => {
    let roster: Roster = EMPTY_ROSTER;
    roster = addPlayer(roster, createProfile("a", "Vertigo", 1));

    assert(
      uniqueCallsign(roster, "Cirrus") === "Cirrus",
      "a callsign nobody holds is the one that is used",
    );
    const second = uniqueCallsign(roster, "Vertigo");
    assert(
      second === "Vertigo 2",
      "and one that is taken becomes visibly the same pilot, numbered",
    );
    assert(
      uniqueCallsign(roster, "vertigo") === "vertigo 2",
      "a callsign that only differs in case is the same callsign",
    );

    roster = addPlayer(roster, createProfile("b", second, 2));
    assert(
      uniqueCallsign(roster, "Vertigo") === "Vertigo 3",
      "which keeps working as the roster fills up with them",
    );
    assert(
      uniqueCallsign(roster, "A".repeat(MAX_CALLSIGN_LENGTH)).length <=
        MAX_CALLSIGN_LENGTH,
      "a numbered callsign still fits in a callsign",
    );
  });

  suite("a backup is saved under a name a person can find", () => {
    const name = backupFileName("Ace Pilot", Date.UTC(2026, 8, 1, 12));
    assert(
      name.startsWith("carviwings-ace-pilot-") && name.endsWith(".json"),
      "the callsign and the date are both in the file name",
    );
    assert(
      !/[^a-z0-9.-]/.test(name),
      "and nothing in a callsign reaches the file system unfiltered",
    );
  });
}
