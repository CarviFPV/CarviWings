"use client";

/**
 * Mission setup.
 *
 * Where the flight starts, how high, which way it faces, and what kind of
 * flight it is are all chosen on the globe before this screen; it picks up
 * from the marker and covers everything that is not a place — the area, the
 * sky, the opposition and the seed. Only controls that actually do something
 * are shown: nothing here is decoration.
 */

import { useMemo, useState } from "react";
import {
  DEFAULT_MISSION_RADIUS,
  MAX_MISSION_RADIUS,
  MIN_MISSION_RADIUS,
  MISSION_RADIUS_STEP,
} from "@/sim/geo/locations";
import {
  clampStartHeading,
  DEFAULT_START_HEADING_DEG,
  formatCoordinates,
  formatHeading,
  SPAWN_ALTITUDE_LIMITS,
} from "@/sim/geo/placePicker";
import {
  MISSION_MODE,
  SCREEN,
  useGameStore,
  type MissionConfiguration,
} from "@/state/gameStore";
import { useSettingsStore } from "@/state/settingsStore";
import { UAVS, activeLivery, activeLoadout } from "@/sim/flight/uav";
import {
  describeBuild,
  describeLoadout,
  fittedAircraft,
  formatLoadoutEndurance,
  hangarAircraft,
} from "@/sim/flight/builds";
import { MS_TO_KMH } from "@/sim/flight/telemetry";
import { maxLevelSpeed } from "@/sim/flight/physics";
import { meshKindFor } from "@/sim/render/aircraftMesh";
import {
  COURSE_LENGTH_STEP,
  DEFAULT_FESTIVAL,
  DEFAULT_OPPOSITION,
  DEFAULT_STRIKE,
  FESTIVAL_AREA_RADII,
  FESTIVAL_EVENT,
  FESTIVAL_EVENTS,
  FESTIVAL_EVENT_INFO,
  FESTIVAL_ROUND_SECONDS,
  FESTIVAL_SLOT_STEP_SECONDS,
  FESTIVAL_SLOT_UNLIMITED_POSITION,
  FESTIVAL_UNLIMITED,
  MAX_FESTIVAL_AIRCRAFT,
  MIN_FESTIVAL_AIRCRAFT,
  MIN_FESTIVAL_SLOT_SECONDS,
  MAX_COURSE_LENGTH,
  MAX_ENEMY_COUNT,
  MAX_FLIGHT_SIZE,
  MAX_LEG,
  MAX_RACE_COMPETITORS,
  MAX_RACE_GATES,
  MAX_ROUTINE_SECONDS,
  MAX_STRIKE_ESCORTS,
  MIN_COURSE_LENGTH,
  MIN_ENEMY_COUNT,
  MIN_FLIGHT_SIZE,
  MIN_LEG,
  MIN_RACE_COMPETITORS,
  MIN_RACE_GATES,
  MIN_ROUTINE_SECONDS,
  MIN_STRIKE_ESCORTS,
  MISSION_MODE_INFO,
  OPPOSITION_MODE,
  OPPOSITION_MODES,
  OPPOSITION_MODE_INFO,
  PASS_FRACTION,
  normaliseOpposition,
  oppositionFleet,
  startsOnTheGround,
  RACE_PROFILES,
  RACE_SHAPE,
  ROUTINE_STEP_SECONDS,
  festivalEventOf,
  festivalSlotFromPosition,
  festivalSlotPosition,
  formatFestivalArea,
  formatFestivalSlot,
  interceptorsFor,
} from "@/sim/mission";
import { FORMATION_SLOTS, PLAYER_SLOTS } from "@/sim/ai/formation";
import type { FormationSlotId } from "@/sim/ai/formation";
import type { FestivalEvent, OppositionMode, RaceShape } from "@/sim/mission";
import type { Difficulty } from "@/sim/ai/types";
import { DIFFICULTY, DIFFICULTY_PROFILES } from "@/sim/ai/types";
import { generateSeed } from "@/sim/math/rng";
import {
  CLEAN_FRACTION,
  SIGNAL_LOSS_TIMEOUT,
  VTX_POWER_LEVELS,
  VTX_UNLIMITED,
  formatVtxPower,
  videoLinkRange,
} from "@/sim/environment/videoLink";
import type {
  MissionClock,
  TimeOfDay,
  WeatherState,
} from "@/sim/environment/types";
import {
  TIME_OF_DAY,
  TIME_PROFILES,
  describeClock,
} from "@/sim/environment/types";
import {
  MenuColumns,
  MultiOptionGroup,
  OptionGroup,
  PrimaryButton,
  SectionLabel,
  Slider,
} from "@/components/ui/Primitives";
import { AircraftPreview } from "@/components/ui/AircraftPreview";
import { WeatherEditor, initialSky } from "./WeatherEditor";
import { TimeEditor } from "./TimeEditor";

/** Stands for the aircraft on the bench when it is not one in the hangar. */
const BENCH_AIRCRAFT = "bench";

/** A list of names as a sentence says one: "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function MissionSetup() {
  const goto = useGameStore((state) => state.goto);
  const startMission = useGameStore((state) => state.startMission);
  // The aircraft is the pilot's rather than the mission's: it is chosen here
  // because here is where a flight is started from, and it stays chosen for
  // the next one. Selecting a saved one fits it, which is what the flight
  // reads on its way up.
  const openAircraft = useGameStore((state) => state.openAircraft);
  const uavSettings = useSettingsStore((state) => state.uav);
  const builds = useSettingsStore((state) => state.builds);
  const selectBuild = useSettingsStore((state) => state.selectBuild);
  // Only its value on the way in is read, to seed the sky below. The panel
  // writes the pilot's choice back as they make it, and a screen that re-seeded
  // its sky every time it changed would undo the choice being made.
  const weatherSource = useSettingsStore((state) => state.weatherSource);
  const loadout = activeLoadout(uavSettings);
  const livery = activeLivery(uavSettings);
  const fittedBuild = fittedAircraft(builds, uavSettings);
  const mode = useGameStore((state) => state.pendingMode);
  const place = useGameStore((state) => state.pendingPlace);
  const isIntercept = mode === MISSION_MODE.Intercept;
  const isStrike = mode === MISSION_MODE.Strike;
  // The two combat missions are configured from the same controls: how many
  // contacts, how well they fly, and whether anything is lethal. What a strike
  // adds on top is the escort.
  const isCombat = isIntercept || isStrike;
  const isFormation = mode === MISSION_MODE.Formation;
  const isRace = mode === MISSION_MODE.Race;
  const isFestival = mode === MISSION_MODE.Festival;
  // The RC ground view is flown from the field: the aircraft starts at the
  // pilot's feet, so there is no start height for this screen to report.
  const fromTheGround = startsOnTheGround(mode);

  const [radius, setRadius] = useState<number>(DEFAULT_MISSION_RADIUS);
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>(TIME_OF_DAY.Day);
  // Undefined until the pilot asks to fly a real date; only read while the
  // time of day is `Custom`.
  const [clock, setClock] = useState<MissionClock | undefined>(undefined);
  const chooseTime = (next: TimeOfDay, nextClock?: MissionClock): void => {
    setTimeOfDay(next);
    setClock(nextClock);
  };
  const [enemyCount, setEnemyCount] = useState<number>(5);
  const [escortCount, setEscortCount] = useState<number>(
    DEFAULT_STRIKE.escortCount,
  );
  const [difficulty, setDifficulty] = useState<Difficulty>(DIFFICULTY.Normal);
  // What the contacts are flying: how they are chosen, and — when they are
  // chosen by hand — which airframes out of the hangar. The selection is kept
  // while the other two ways are being looked at, so coming back to it finds
  // the same aircraft ticked.
  const [oppositionMode, setOppositionMode] = useState<OppositionMode>(
    DEFAULT_OPPOSITION.mode,
  );
  const [chosenAircraft, setChosenAircraft] = useState<readonly string[]>(
    DEFAULT_OPPOSITION.aircraft,
  );
  const [combat, setCombat] = useState(true);
  const [slot, setSlot] = useState<FormationSlotId>(PLAYER_SLOTS[1] as FormationSlotId);
  const [flightSize, setFlightSize] = useState<number>(2);
  const [routineSeconds, setRoutineSeconds] = useState<number>(300);
  const [competitors, setCompetitors] = useState<number>(3);
  const [gateCount, setGateCount] = useState<number>(10);
  const [courseLength, setCourseLength] = useState<number>(5000);
  const [shape, setShape] = useState<RaceShape>(RACE_SHAPE.Sprint);
  const [areaRadius, setAreaRadius] = useState<number>(
    DEFAULT_FESTIVAL.areaRadius,
  );
  const [festivalCount, setFestivalCount] = useState<number>(
    DEFAULT_FESTIVAL.aircraftCount,
  );
  const [festivalSeconds, setFestivalSeconds] = useState<number>(
    DEFAULT_FESTIVAL.durationSeconds,
  );
  const [festivalEvent, setFestivalEvent] = useState<FestivalEvent>(() =>
    festivalEventOf(DEFAULT_FESTIVAL),
  );
  const [vtxPowerMw, setVtxPowerMw] = useState<number>(VTX_UNLIMITED);
  // Generated once per visit so a mission is repeatable but not always the same.
  const [seed, setSeed] = useState(() => generateSeed());
  // The day being flown, always spelled out in full: the panel opens on the
  // way of describing one the pilot last used — the live report over the start
  // point until they say otherwise — and fills it in from there.
  const [sky, setSky] = useState<WeatherState>(() =>
    initialSky(weatherSource, { seed, latitude: place?.latitude ?? 0 }),
  );

  const spawnAltitude =
    place?.spawnAltitudeAgl ?? SPAWN_ALTITUDE_LIMITS.default;
  // Both chosen on the globe, and neither is edited here: this screen is what
  // is flown at the start point, not where the start point is.
  const startHeading = clampStartHeading(
    place?.startHeadingDeg ?? DEFAULT_START_HEADING_DEG,
  );

  const opposition = useMemo(
    () => normaliseOpposition({ mode: oppositionMode, aircraft: chosenAircraft }),
    [oppositionMode, chosenAircraft],
  );

  /** What is actually going to be up there, by name. */
  const oppositionNames = useMemo(
    () => oppositionFleet(opposition).map((uav) => uav.config.name),
    [opposition],
  );

  /** The same thing in as few words as the summary line has room for. */
  const oppositionSummary = useMemo(() => {
    if (oppositionMode === OPPOSITION_MODE.Random) return "random types";
    if (oppositionNames.length === 1) return oppositionNames[0] as string;
    return `${oppositionNames.length} types`;
  }, [oppositionMode, oppositionNames]);

  /**
   * Whether there is anybody else in the sky to be flying anything.
   *
   * Every mission that puts somebody up asks the same question, so every one
   * of them gets the same control: contacts, the rest of a flight, a grid, a
   * club field. A time trial and a slot flown on your own do not — there is
   * nothing to choose an aircraft for.
   */
  const hasField =
    isCombat ||
    isFormation ||
    (isRace && competitors > 0) ||
    (isFestival && festivalCount > 0);

  /** What the others are called on this kind of mission. */
  const fieldLabel = isCombat
    ? "Opposition"
    : isFormation
      ? "The flight"
      : isRace
        ? "The grid"
        : "The field";

  /** What the setting is actually going to put up there, in a sentence. */
  const fieldDeal = useMemo(() => {
    if (oppositionMode === OPPOSITION_MODE.Random) {
      if (isFormation) {
        return "Every aircraft in the flight is drawn from the whole hangar on the mission seed, the leader included: you will not know what you are joining until you are close enough to look at it.";
      }
      if (isRace) {
        return "Every rival is drawn from the whole hangar on the mission seed. What you are racing is whatever is sitting beside you when the line goes.";
      }
      if (isFestival) {
        return "Everybody is drawn from the whole hangar on the mission seed, which is what a club field on a Saturday afternoon actually is.";
      }
      return "Every contact is drawn from the whole hangar on the mission seed. You will not know what is up there until you are close enough to see it.";
    }
    if (oppositionNames.length === 1) {
      const only = oppositionNames[0] as string;
      if (isFormation) return `The whole flight flies the ${only}.`;
      if (isRace) return `The whole grid flies the ${only}.`;
      if (isFestival) return `Everybody on the field flies the ${only}.`;
      return `Every contact flies the ${only}.`;
    }
    const from = listNames(oppositionNames);
    const who = isFormation
      ? "The flight is dealt"
      : isRace
        ? "The grid is dealt"
        : isFestival
          ? "The field is dealt"
          : "Contacts are dealt";
    return `${who} from ${from} on the mission seed, so a field big enough to hold all of them holds all of them.`;
  }, [isFestival, isFormation, isRace, oppositionMode, oppositionNames]);

  /**
   * And what flying a mixed field actually costs, which is the half of this
   * nobody expects: the aeroplane decides the speed, and nothing is ever
   * given more of it than the aircraft the pilot is in.
   */
  const fieldSpeedNote = isFormation
    ? "so the display is one you can hold a slot on rather than a stern chase."
    : isRace
      ? "so a race is won and lost on the line rather than on the straight."
      : isFestival
        ? "so the circuit stays a circuit you are sharing."
        : "so whatever is up there can still be run down from behind.";

  /**
   * Ticks or unticks one airframe.
   *
   * The last one cannot be unticked: a mission has to be flown against
   * something, and an empty selection would only be repaired back to the
   * interceptor on the way out — which is a worse answer than leaving the
   * pilot's own last choice showing.
   */
  const toggleOpposition = (id: string): void => {
    setChosenAircraft((current) => {
      if (!current.includes(id)) return [...current, id];
      if (current.length === 1) return current;
      return current.filter((entry) => entry !== id);
    });
  };

  /**
   * The mission as the controls on this screen describe it, with the start
   * point left blank.
   *
   * Built whether or not the globe has a marker on it, so the copy below can
   * ask the mission's own rules — how many airframes a flight launches with,
   * say — instead of repeating the arithmetic and drifting away from them.
   */
  const draft = useMemo<MissionConfiguration>(() => {
    return {
      mode,
      locationName: place?.name ?? "",
      latitude: place?.latitude ?? 0,
      longitude: place?.longitude ?? 0,
      // The festival field *is* the flight area: the sky being shared is the
      // one thing that mission is about, so there is no second radius to pick.
      missionRadius: isFestival ? areaRadius : radius,
      spawnAltitudeAgl: spawnAltitude,
      startHeadingDeg: startHeading,
      // The one-word filing the logbook and the debrief read; the sky itself
      // is what is flown.
      weather: sky.preset,
      sky,
      timeOfDay,
      clock,
      enemyCount,
      opposition,
      difficulty,
      // A formation flight is a training exercise, a race is a race and a
      // festival is a fly-in: nothing on any of them is lethal by design,
      // whatever two wings meeting turns out to cost.
      combat: isFormation || isRace || isFestival ? false : combat,
      formation: { slot, flightSize, routineSeconds },
      race: { competitors, gateCount, courseLength, shape },
      festival: {
        areaRadius,
        aircraftCount: festivalCount,
        durationSeconds: festivalSeconds,
        event: festivalEvent,
      },
      strike: { escortCount },
      vtxPowerMw,
      seed,
    };
  }, [
    place,
    spawnAltitude,
    startHeading,
    radius,
    sky,
    timeOfDay,
    clock,
    mode,
    enemyCount,
    escortCount,
    opposition,
    difficulty,
    combat,
    isFormation,
    isRace,
    isFestival,
    slot,
    flightSize,
    routineSeconds,
    competitors,
    gateCount,
    courseLength,
    shape,
    areaRadius,
    festivalCount,
    festivalSeconds,
    festivalEvent,
    vtxPowerMw,
    seed,
  ]);

  /**
   * The leg the race is actually laid out with, metres.
   *
   * The course is spread over the legs it has to spread over, and then each
   * leg is held to what a wing can fly — so a very short course with a lot of
   * gates comes out longer than it was asked for rather than folded up on
   * itself. Read the same way here so the copy says what the layout will do.
   */
  const raceLeg = useMemo<number>(() => {
    const legs = Math.max(
      shape === RACE_SHAPE.Circuit ? gateCount : gateCount - 1,
      1,
    );
    return Math.round(
      Math.min(Math.max(courseLength / legs, MIN_LEG), MAX_LEG),
    );
  }, [courseLength, gateCount, shape]);

  /** The same thing, once there is somewhere to fly it and a seed to fly it on. */
  const mission = useMemo<MissionConfiguration | null>(() => {
    if (!place) return null;
    const trimmed = seed.trim();
    if (trimmed.length === 0) return null;
    return { ...draft, seed: trimmed };
  }, [draft, place, seed]);

  /**
   * What everybody else is flying.
   *
   * One control, on every mission that puts somebody else in the sky, placed
   * where that mission's own settings are: the aircraft is the same question
   * whether it is hunting you, leading you, racing you or sharing a field
   * with you.
   */
  const fieldSection = hasField ? (
    <section>
      <SectionLabel>{fieldLabel}</SectionLabel>
      <OptionGroup
        columns={3}
        value={oppositionMode}
        onChange={setOppositionMode}
        options={OPPOSITION_MODES.map((id) => ({
          value: id,
          label: OPPOSITION_MODE_INFO[id].label,
          hint: OPPOSITION_MODE_INFO[id].hint,
        }))}
      />
      {oppositionMode === OPPOSITION_MODE.Chosen ? (
        <div className="mt-1.5">
          <MultiOptionGroup
            columns={2}
            values={opposition.aircraft}
            onToggle={toggleOpposition}
            options={UAVS.map((uav) => ({
              value: uav.id,
              label: uav.config.name,
              hint: uav.summary,
            }))}
          />
        </div>
      ) : null}
      <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
        {fieldDeal} Each one flies at the speed its own airframe is actually
        good for — a survey wing cruises well under an interceptor, a
        quadcopter turns inside anything with wings on it — and none of them is
        ever given more speed than the aircraft you are flying, {fieldSpeedNote}
      </p>
    </section>
  ) : null;

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      <div className="mx-auto w-full max-w-[88rem] px-8 py-12">
        <header className="mb-10 flex items-end justify-between border-b border-hairline pb-5">
          <div>
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Mission Setup
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">
              {MISSION_MODE_INFO[mode].label.toUpperCase()}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => goto(SCREEN.Menu)}
            className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
          >
            &larr; Main menu
          </button>
        </header>

        <section>
          <SectionLabel>Start point</SectionLabel>
          <div className="border border-hairline bg-panel px-4 py-3">
            {place ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-lg font-light tracking-[0.04em] text-osd">
                    {place.name}
                  </p>
                  <p className="mt-1 text-2xs tabular-nums text-osd-faint">
                    {formatCoordinates(place.latitude, place.longitude)}
                  </p>
                  <p className="mt-2 text-2xs tabular-nums text-osd-dim">
                    {fromTheGround ? (
                      <>
                        Starting{" "}
                        <span className="text-cyan">on the ground</span>, with
                        you standing beside it
                        {place.terrainHeight !== null
                          ? ` · ${Math.round(place.terrainHeight)} m AMSL`
                          : ""}
                      </>
                    ) : (
                      <>
                        Airborne at{" "}
                        <span className="text-cyan">{spawnAltitude} m</span>{" "}
                        above the ground
                        {place.terrainHeight !== null
                          ? ` · ${Math.round(place.terrainHeight + spawnAltitude)} m AMSL`
                          : ""}
                      </>
                    )}
                    {" · heading "}
                    <span className="text-cyan">{formatHeading(startHeading)}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => goto(SCREEN.World)}
                  className="shrink-0 border border-hairline px-3 py-2 text-2xs uppercase tracking-[0.14em] text-osd-dim transition-colors hover:border-cyan hover:text-cyan"
                >
                  Change on the globe
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-osd-dim">
                  No start point has been chosen yet.
                </p>
                <button
                  type="button"
                  onClick={() => goto(SCREEN.World)}
                  className="shrink-0 border border-cyan/70 px-3 py-2 text-2xs uppercase tracking-[0.14em] text-cyan transition-colors hover:bg-cyan/10"
                >
                  Open the globe
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Everything below is a short section of its own, so the width the
            window has goes into columns rather than into margins. */}
        <MenuColumns minWidth="21rem">
          <section>
            <SectionLabel>Aircraft</SectionLabel>
            <OptionGroup
              columns={2}
              value={fittedBuild ? fittedBuild.id : BENCH_AIRCRAFT}
              onChange={(value) => {
                if (value !== BENCH_AIRCRAFT) selectBuild(value);
              }}
              options={[
                // Only offered while the bench is holding something that is in
                // neither list: once it matches an aircraft in the hangar, that
                // aircraft *is* the bench, and a second button saying so would
                // be a way of selecting what is already selected.
                ...(fittedBuild
                  ? []
                  : [
                      {
                        value: BENCH_AIRCRAFT,
                        label: "Current setup",
                        hint: describeLoadout(loadout),
                      },
                    ]),
                // Every airframe as delivered, then whatever the pilot has
                // saved: there is an aircraft here for each of them from the
                // first flight, without one having to be built first.
                ...hangarAircraft(builds).map((build) => ({
                  value: build.id,
                  label: build.name,
                  hint: describeBuild(build),
                })),
              ]}
            />
            {/* The aircraft is picked here and built elsewhere, so what this
                screen owes the pilot is a look at the one they are picking. */}
            <div className="mt-3 border border-hairline bg-panel">
              <AircraftPreview
                livery={livery}
                kind={meshKindFor(loadout.config)}
                height={150}
              />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-l border-hairline-bright/40 pl-3 text-2xs tabular-nums text-osd-dim">
              <dt className="text-osd-faint">All-up weight</dt>
              <dd>{loadout.config.mass.toFixed(2)} kg</dd>
              <dt className="text-osd-faint">Top level speed</dt>
              <dd>
                {(maxLevelSpeed(loadout.config) * MS_TO_KMH).toFixed(0)} km/h
              </dd>
              <dt className="text-osd-faint">Cruise endurance</dt>
              <dd>{formatLoadoutEndurance(loadout)}</dd>
            </dl>
            <button
              type="button"
              onClick={() => openAircraft(SCREEN.Setup)}
              className="mt-3 w-full border border-hairline px-3 py-2 text-2xs uppercase tracking-[0.14em] text-osd-dim transition-colors hover:border-cyan hover:text-cyan"
            >
              Aircraft builder
            </button>
            <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
              Every airframe as it is delivered, and{" "}
              {builds.length > 0
                ? "the aircraft you have set up and saved"
                : "any aircraft you save on the builder"}
              . Picking one here fits it for this flight and every one after it,
              until you pick another, so a mission can be flown on any airframe
              in the hangar without building anything first. Changing one — the
              airframe, the motor, the pack, the rates, the paint — is done on
              the aircraft builder, and so is saving a modified one; this screen
              only fits what is already in the hangar. The pack is flown down at
              the rate the throttle is actually used, so how long you have is
              what the figures above say and not a minute more.
            </p>
          </section>

          {/* A festival picks its own area below, and it is the same number. */}
          {!isFestival ? (
            <section>
              <SectionLabel>Mission radius</SectionLabel>
              <Slider
                label="Flight area"
                min={MIN_MISSION_RADIUS}
                max={MAX_MISSION_RADIUS}
                step={MISSION_RADIUS_STEP}
                value={radius}
                onChange={setRadius}
                format={formatMetres}
              />
              <p className="mt-2 text-2xs text-osd-faint">
                The flight area is centred on the mission origin. Leaving it
                raises a warning on the OSD.
              </p>
            </section>
          ) : null}

          <TimeEditor
            timeOfDay={timeOfDay}
            clock={clock}
            latitude={place?.latitude ?? 0}
            longitude={place?.longitude ?? 0}
            onTime={chooseTime}
            columns={3}
          />

          <section>
            <SectionLabel>Video link</SectionLabel>
            <OptionGroup
              columns={4}
              value={vtxPowerMw}
              onChange={setVtxPowerMw}
              options={[
                {
                  value: VTX_UNLIMITED,
                  label: "Unlimited",
                  hint: "No range",
                },
                ...VTX_POWER_LEVELS.map((milliwatts) => ({
                  value: milliwatts as number,
                  label: formatVtxPower(milliwatts),
                  hint: formatLinkRange(videoLinkRange(milliwatts)),
                })),
              ]}
            />
            <p className="mt-2 text-2xs text-osd-faint">
              {vtxPowerMw === VTX_UNLIMITED
                ? "The picture comes back from anywhere. Nothing on the goggles ever breaks up, and how far out you fly is your own business."
                : `You are transmitting ${formatVtxPower(vtxPowerMw)} to a ground station standing at the start point. The picture is clean to about ${formatLinkRange(
                    videoLinkRange(vtxPowerMw) * CLEAN_FRACTION,
                  )}, breaks up out to ${formatLinkRange(
                    videoLinkRange(vtxPowerMw),
                  )}, and is gone past it. Put a ridge between the aircraft and the ground station and it goes early. Fly with no picture at all for ${SIGNAL_LOSS_TIMEOUT} seconds and the airframe is not coming back.`}
            </p>
          </section>

          {isCombat ? (
            <>
              <section>
                <SectionLabel>Contacts</SectionLabel>
                <Slider
                  label={isStrike ? "In transit" : "Hunting you"}
                  min={MIN_ENEMY_COUNT}
                  max={MAX_ENEMY_COUNT}
                  step={1}
                  value={enemyCount}
                  onChange={setEnemyCount}
                  format={(value) =>
                    `${value} contact${value === 1 ? "" : "s"}`
                  }
                />
                <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
                  {isStrike
                    ? "Aircraft crossing the area on their own programmed route. None of them is looking for you, none of them will run, and each one still has to be found before it can be flown at."
                    : "Aircraft in the area looking for you, flown by pilots with the same stall, the same inertia and the same weather to see through as you."}{" "}
                  Arriving destroys both aircraft, so you launch with{" "}
                  {interceptorsFor(draft)} airframes — one per contact
                  {isStrike && escortCount > 0 ? ", escort included," : ""} plus
                  two spares.
                </p>
              </section>

              {fieldSection}

              {isStrike ? (
                <section>
                  <SectionLabel>Escort</SectionLabel>
                  <Slider
                    label="Hunting you"
                    min={MIN_STRIKE_ESCORTS}
                    max={MAX_STRIKE_ESCORTS}
                    step={1}
                    value={escortCount}
                    onChange={setEscortCount}
                    format={(value) =>
                      value === 0
                        ? "Unescorted"
                        : `${value} escort${value === 1 ? "" : "s"}`
                    }
                  />
                  <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
                    {escortCount === 0
                      ? "Nothing in the area is looking for you. The whole mission is the approach: find the transit, get behind it, and arrive."
                      : `${escortCount} more aircraft fly with the transit, on top of the contacts above — ordinary hunting contacts out of the same opposition, which will see you, come for you, and have to be brought down like everything else. They are painted the interceptor red; the transit is not.`}
                  </p>
                </section>
              ) : null}

              <section>
                <SectionLabel>Difficulty</SectionLabel>
                <OptionGroup
                  columns={3}
                  value={difficulty}
                  onChange={setDifficulty}
                  options={Object.values(DIFFICULTY_PROFILES).map(
                    (profile) => ({
                      value: profile.id,
                      label: profile.label,
                    }),
                  )}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  {DIFFICULTY_PROFILES[difficulty].description}{" "}
                  {isStrike
                    ? "It decides how the escort flies and nothing else: a transit contact has no lookout to sharpen."
                    : "It changes the pilot rather than the aeroplane: which airframes are up there is the opposition's business, above."}
                </p>
              </section>

              <section>
                <SectionLabel>Combat</SectionLabel>
                <OptionGroup
                  columns={2}
                  value={combat ? "on" : "off"}
                  onChange={(value) => setCombat(value === "on")}
                  options={[
                    {
                      value: "on",
                      label: "On",
                      hint: isStrike
                        ? "The escort hunts you"
                        : "Contacts hunt you",
                    },
                    {
                      value: "off",
                      label: "Off",
                      hint: isStrike
                        ? "The transit flies on; contact is harmless"
                        : "They patrol; contact is harmless",
                    },
                  ]}
                />
                {!combat ? (
                  <p className="mt-2 text-2xs text-amber">
                    Practice run: contacts can be found, tracked and shadowed,
                    but nothing can be destroyed, so the mission cannot be
                    completed.
                  </p>
                ) : null}
              </section>
            </>
          ) : null}

          {isFormation ? (
            <>
              <section>
                <SectionLabel>Your slot</SectionLabel>
                <OptionGroup
                  columns={3}
                  value={slot as string}
                  onChange={(value) => setSlot(value as FormationSlotId)}
                  options={PLAYER_SLOTS.map((id) => ({
                    value: id as string,
                    label: FORMATION_SLOTS[id].label,
                    hint: `${FORMATION_SLOTS[id].aft} m back`,
                  }))}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  You start on station. Holding it is the exercise: the OSD
                  marks where the slot is and how far out of it you are. Touch
                  somebody and you fly on with whatever it did to the airframe.
                </p>
              </section>

              <section>
                <SectionLabel>Flight size</SectionLabel>
                <Slider
                  label="In the flight"
                  min={MIN_FLIGHT_SIZE}
                  max={MAX_FLIGHT_SIZE}
                  step={1}
                  value={flightSize}
                  onChange={setFlightSize}
                  format={(value) =>
                    value === 1 ? "Lead only" : `Lead + ${value - 1}`
                  }
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  Aircraft in the flight besides you. The others fly the slots
                  you are not in, on whatever the flight is flying and on the
                  same flight model as yours.
                </p>
              </section>

              <section>
                <SectionLabel>Routine</SectionLabel>
                <Slider
                  label="Display length"
                  min={MIN_ROUTINE_SECONDS}
                  max={MAX_ROUTINE_SECONDS}
                  step={ROUTINE_STEP_SECONDS}
                  value={routineSeconds}
                  onChange={setRoutineSeconds}
                  format={(value) => `${Math.round(value / 60)} min`}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  The leader opens with a straight leg to join up on, then flies
                  the display. Hold the slot for{" "}
                  {Math.round(PASS_FRACTION * 100)}% of it to pass.
                </p>
              </section>

              <section>
                <SectionLabel>Leader</SectionLabel>
                <OptionGroup
                  columns={3}
                  value={difficulty}
                  onChange={setDifficulty}
                  options={Object.values(DIFFICULTY_PROFILES).map(
                    (profile) => ({
                      value: profile.id,
                      label: profile.label,
                    }),
                  )}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  {difficulty === DIFFICULTY.Easy
                    ? "Gentle turns, shallow climbs and long straight legs."
                    : difficulty === DIFFICULTY.Normal
                      ? "Proper turns, climbs and descents, and wingovers."
                      : "Steep reversals, hard wingovers and aileron rolls. The formation will break around them."}{" "}
                  It changes the pilot rather than the aeroplane: what the
                  flight is flying is its own setting, below. A flight on
                  rotors is not asked for the aileron rolls at all — a
                  quadcopter held at full aileron is a flip, not a roll — and
                  flies those steps as the legs they are.
                </p>
              </section>

              {fieldSection}
            </>
          ) : null}

          {isRace ? (
            <>
              <section>
                <SectionLabel>Shape</SectionLabel>
                <OptionGroup
                  columns={2}
                  value={shape as string}
                  onChange={(value) => setShape(value as RaceShape)}
                  options={[
                    {
                      value: RACE_SHAPE.Sprint as string,
                      label: "Point to point",
                      hint: "Start here, finish elsewhere",
                    },
                    {
                      value: RACE_SHAPE.Circuit as string,
                      label: "Circuit",
                      hint: "A loop back to the start",
                    },
                  ]}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  {shape === RACE_SHAPE.Circuit
                    ? "A closed loop. You cross the start line going straight and turn onto the course; the finish is that same line, come back round."
                    : "A line from here to somewhere else. The clock starts on the first gate and stops on the last, wherever it has taken you."}
                </p>
              </section>

              <section>
                <SectionLabel>Distance</SectionLabel>
                <Slider
                  label="Course length"
                  min={MIN_COURSE_LENGTH}
                  max={MAX_COURSE_LENGTH}
                  step={COURSE_LENGTH_STEP}
                  value={courseLength}
                  onChange={setCourseLength}
                  format={formatMetres}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  How far the course runs,{" "}
                  {shape === RACE_SHAPE.Circuit
                    ? "once round"
                    : "start to finish"}{" "}
                  — about{" "}
                  <span className="text-cyan">{raceLeg} m</span> between gates.
                  No leg is ever laid out shorter than {MIN_LEG} m, so a short
                  course hung with a lot of gates comes out longer than it was
                  asked for. The mission area comes first as well: a course too
                  big for it is laid out to fit.
                </p>
              </section>

              <section>
                <SectionLabel>Gates</SectionLabel>
                <Slider
                  label="In the course"
                  min={MIN_RACE_GATES}
                  max={MAX_RACE_GATES}
                  step={1}
                  value={gateCount}
                  onChange={setGateCount}
                  format={(value) => `${value} gates`}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  The gates are laid out from the seed and squared up to the
                  course, so each one faces the way you are meant to fly through
                  it. More of them over the same distance means shorter legs and
                  more corners. They follow the ground, too: the bottom of every
                  frame sits three to five metres over whatever is under it —
                  the field, or the rooftops where the world is drawn with
                  buildings — so a race is flown down on the deck however high
                  you launch.
                </p>
              </section>

              <section>
                <SectionLabel>Competitors</SectionLabel>
                <Slider
                  label="On the grid"
                  min={MIN_RACE_COMPETITORS}
                  max={MAX_RACE_COMPETITORS}
                  step={1}
                  value={competitors}
                  onChange={setCompetitors}
                  format={(value) =>
                    value === 0
                      ? "Time trial"
                      : `${value} rival${value === 1 ? "" : "s"}`
                  }
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  {competitors === 0
                    ? "Nobody on the course but you and the clock."
                    : `You start on the grid alongside ${competitors} rival${
                        competitors === 1 ? "" : "s"
                      } flying whatever the grid is flying, below. Rubbing wings costs a place; hitting one properly costs the airframe.`}
                </p>
              </section>

              <section>
                <SectionLabel>Difficulty</SectionLabel>
                <OptionGroup
                  columns={3}
                  value={difficulty}
                  onChange={setDifficulty}
                  options={Object.values(RACE_PROFILES).map((profile) => ({
                    value: profile.id,
                    label: profile.label,
                    hint: `${RACE_PROFILES[profile.id].gateHalfWidth * 2} m gates`,
                  }))}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  {RACE_PROFILES[difficulty].description}
                </p>
              </section>

              {fieldSection}
            </>
          ) : null}

          {isFestival ? (
            <>
              <section>
                <SectionLabel>Event</SectionLabel>
                <OptionGroup
                  columns={2}
                  value={festivalEvent}
                  onChange={setFestivalEvent}
                  options={FESTIVAL_EVENTS.map((event) => ({
                    value: event,
                    label: FESTIVAL_EVENT_INFO[event].label,
                    hint: FESTIVAL_EVENT_INFO[event].tagline,
                  }))}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  {FESTIVAL_EVENT_INFO[festivalEvent].description}
                </p>
              </section>

              <section>
                <SectionLabel>Field</SectionLabel>
                <OptionGroup
                  columns={4}
                  value={areaRadius}
                  onChange={setAreaRadius}
                  options={FESTIVAL_AREA_RADII.map((metres) => ({
                    value: metres as number,
                    label: formatFestivalArea(metres),
                    hint:
                      metres <= 200
                        ? "Elbows"
                        : metres <= 500
                          ? "Club field"
                          : metres <= 1000
                            ? "Room"
                            : "Wide open",
                  }))}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  How much sky everybody is sharing, measured out from the start
                  point. This is the flight area too: leaving it raises the
                  usual warning on the OSD, and the field is what you are meant
                  to be flying over. Everyone works the same{" "}
                  <span className="text-cyan">
                    {Math.round(Math.min(Math.max(areaRadius * 0.55, 90), 320))}{" "}
                    m
                  </span>{" "}
                  of height above it, so a smaller field is a busier one in
                  every direction at once.
                </p>
              </section>

              <section>
                <SectionLabel>Aircraft</SectionLabel>
                <Slider
                  label="On the field"
                  min={MIN_FESTIVAL_AIRCRAFT}
                  max={MAX_FESTIVAL_AIRCRAFT}
                  step={1}
                  value={festivalCount}
                  onChange={setFestivalCount}
                  format={(value) =>
                    `${value} aircraft · ${festivalCrowd(value)}`
                  }
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  Other people&rsquo;s models in the air besides yours, on
                  whatever the field is flying and all on the same flight
                  model.{" "}
                  {festivalEvent === FESTIVAL_EVENT.Streamer
                    ? "Every one of them is towing paper in its own colour and every one of them is after somebody else's — some will fly at the knot on your tail, some will not go near anything but a tip. When two touch, what it costs is whatever the impact was worth: a brush and you both fly on, a solid one and a wing comes off and it goes in."
                    : "Nobody is hunting anybody and nobody is really looking either — some of them keep a lookout and ease away, some of them never glance up. When two touch, what it costs is whatever the impact was worth: a brush and you both fly on, a solid one and a wing comes off and it goes in."}{" "}
                  How busy it gets is this against the field above: the same
                  fifty aircraft are a crowd over 1.5 km and a mid-air a minute
                  over 200 m.
                </p>
              </section>

              <section>
                <SectionLabel>Slot</SectionLabel>
                <Slider
                  label="Time on the line"
                  min={MIN_FESTIVAL_SLOT_SECONDS}
                  max={FESTIVAL_SLOT_UNLIMITED_POSITION}
                  step={FESTIVAL_SLOT_STEP_SECONDS}
                  value={festivalSlotPosition(festivalSeconds)}
                  onChange={(position) =>
                    setFestivalSeconds(festivalSlotFromPosition(position))
                  }
                  format={formatFestivalSlot}
                />
                <p className="mt-2 text-2xs text-osd-faint">
                  {festivalSeconds === FESTIVAL_UNLIMITED
                    ? "Wound all the way up the day never ends: fly until you have had enough and leave from the pause menu."
                    : `The slot runs for ${Math.round(
                        festivalSeconds / 60,
                      )} minute${
                        Math.round(festivalSeconds / 60) === 1 ? "" : "s"
                      } and then the day is called, whatever is still in the air.`}{" "}
                  {festivalSeconds !== FESTIVAL_UNLIMITED &&
                  festivalSeconds <= FESTIVAL_ROUND_SECONDS
                    ? "A slot this short is one round: the wave you launch with is the wave you finish on unless somebody puts one in."
                    : `Inside it the day is flown in rounds: a wave goes up, works the line for ${Math.round(
                        FESTIVAL_ROUND_SECONDS / 60,
                      )} minutes, and is called down so the next one can go.`}{" "}
                  Anything of theirs that goes in stays where it is until the sky
                  is empty and the next wave can go. Your own is the end of your
                  day: put a wing in the field and the slot is over for you,
                  with another one to fly or the way back to the menu.
                </p>
              </section>

              {fieldSection}
            </>
          ) : null}

          <section>
            <SectionLabel>Mission seed</SectionLabel>
            <div className="flex gap-2">
              <input
                value={seed}
                onChange={(event) => setSeed(event.target.value.toUpperCase())}
                spellCheck={false}
                maxLength={24}
                className="min-w-0 flex-1 border border-hairline bg-void px-3 py-2 text-sm tracking-[0.2em] text-osd outline-none transition-colors focus:border-cyan"
              />
              <button
                type="button"
                onClick={() => setSeed(generateSeed())}
                className="shrink-0 border border-hairline px-4 text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:border-cyan hover:text-cyan"
              >
                New
              </button>
            </div>
            <p className="mt-2 text-2xs text-osd-faint">
              The seed decides where contacts spawn, the routes they patrol, the
              display the leader flies, and the wind and cloud you will fly
              through. The same seed and the same settings fly the same mission
              every time.
            </p>
          </section>
        </MenuColumns>

        {/* The sky is the one block that wants the whole width: it grows a
            layer editor of its own once the weather is built by hand. */}
        <section className="mb-9">
          <WeatherEditor
            sky={sky}
            latitude={place?.latitude ?? 0}
            longitude={place?.longitude ?? 0}
            terrainHeight={place?.terrainHeight ?? null}
            seed={seed}
            columns={6}
            onSky={setSky}
          />
        </section>

        <PrimaryButton
          tone="accent"
          disabled={!mission}
          onClick={() => mission && startMission(mission)}
        >
          <span className="flex items-baseline justify-between">
            <span>Start Flight</span>
            <span className="text-2xs tracking-[0.12em] text-osd-faint">
              {mission
                ? `${mission.locationName} · ${
                    fittedBuild ? fittedBuild.name : loadout.uav.config.name
                  } · ${
                    timeOfDay === TIME_OF_DAY.Custom && clock
                      ? describeClock(clock, place?.longitude ?? 0)
                      : TIME_PROFILES[timeOfDay].label
                  } · ${sky.label}${
                    vtxPowerMw === VTX_UNLIMITED
                      ? ""
                      : ` · ${formatVtxPower(vtxPowerMw)} VTX`
                  }${
                    isIntercept ? ` · ${enemyCount} contacts` : ""
                  }${
                    isStrike
                      ? ` · ${enemyCount} in transit · ${
                          escortCount === 0
                            ? "unescorted"
                            : `${escortCount} escort${escortCount === 1 ? "" : "s"}`
                        }`
                      : ""
                  }${
                    hasField ? ` · ${oppositionSummary}` : ""
                  }${
                    isFormation
                      ? ` · ${FORMATION_SLOTS[slot].label} · ${Math.round(routineSeconds / 60)} min`
                      : ""
                  }${
                    isRace
                      ? ` · ${courseLength / 1000} km ${
                          shape === RACE_SHAPE.Circuit ? "circuit" : "sprint"
                        } · ${gateCount} gates · ${
                          competitors === 0
                            ? "time trial"
                            : `${competitors} rivals`
                        }`
                      : ""
                  }${
                    isFestival
                      ? ` · ${FESTIVAL_EVENT_INFO[festivalEvent].label} · ${formatFestivalArea(areaRadius)} field · ${festivalCount} aircraft · ${
                          festivalSeconds === FESTIVAL_UNLIMITED
                            ? "unlimited"
                            : `${Math.round(festivalSeconds / 60)} min`
                        }`
                      : ""
                  }`
                : "Choose a start point"}
            </span>
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
}

/** What a festival field of this size feels like from inside it. */
function festivalCrowd(aircraft: number): string {
  if (aircraft <= 4) return "quiet slot";
  if (aircraft <= 8) return "busy";
  if (aircraft <= 15) return "crowded";
  if (aircraft <= 30) return "mayhem";
  return "the whole club at once";
}

/** Metres as a pilot reads them: metres up close, kilometres past a thousand. */
function formatMetres(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres % 1000 === 0 ? 0 : 1)} km`;
}

/** A link range in the units a pilot reads it in. */
function formatLinkRange(metres: number): string {
  if (!Number.isFinite(metres)) return "unlimited";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}
