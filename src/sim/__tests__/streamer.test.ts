import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS, createAircraftState } from "../flight/state";
import type { AircraftRole, AircraftState } from "../flight/state";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { CollisionWorld, initRapier } from "../physics/collisionWorld";
import { MissionRunner } from "../mission/missionRunner";
import type { MissionSettings } from "../mission/types";
import {
  DEFAULT_FORMATION,
  DEFAULT_VTX_POWER_MW,
  MISSION_MODE,
} from "../mission/types";
import { DEFAULT_RACE } from "../mission/race";
import { DEFAULT_STRIKE } from "../mission/strike";
import { DEFAULT_OPPOSITION } from "../mission/opposition";
import {
  FESTIVAL_EVENT,
  FESTIVAL_EVENTS,
  FESTIVAL_EVENT_INFO,
  FESTIVAL_UNLIMITED,
  festivalEventOf,
  festivalSummary,
  isStreamerEvent,
  normaliseFestivalEvent,
} from "../mission/festival";
import {
  MIN_STREAMER_CUT,
  STREAMER_COLOURS,
  STREAMER_LENGTH,
  STREAMER_STUB,
  StreamerField,
  chooseQuarry,
  formatStreamerLength,
  ordinal,
  pointAt,
  quarryOf,
  streamerColour,
  streamerLabel,
  streamerSummary,
} from "../mission/streamer";
import { FestivalPilot, festivalSpawnPoint } from "../ai/festivalPilot";
import { WEATHER, TIME_OF_DAY } from "../environment/types";
import { DIFFICULTY } from "../ai/types";
import * as V from "../math/vec3";

/** An aircraft that is simply somewhere, for testing geometry rather than flight. */
function parked(
  id: string,
  position: V.Vec3,
  headingDeg = 0,
  role: AircraftRole = AIRCRAFT_ROLE.Festival,
): AircraftState {
  return createAircraftState({
    id,
    role,
    config: PLAYER_WING,
    position,
    headingDeg,
    airspeed: 0,
    throttle: 0,
  });
}

/** Puts one competitor's paper on one airframe. */
function enter(
  field: StreamerField,
  state: AircraftState,
  index: number,
  isPlayer = false,
): void {
  field.attach(state.id, {
    competitorId: isPlayer ? "player" : `field-${index}`,
    label: isPlayer ? "You" : streamerLabel(index),
    color: streamerColour(index).hex,
    isPlayer,
  });
}

/**
 * Flies one aircraft across a ribbon and returns what came off.
 *
 * Two steps, because a pass is a swept segment: the first says where the wing
 * was, the second where it got to. Anything less and an aircraft covering half
 * a node between frames would fly through the paper without touching it.
 */
function sweep(
  field: StreamerField,
  aircraft: readonly AircraftState[],
  cutter: AircraftState,
  from: V.Vec3,
  to: V.Vec3,
): number {
  V.copy(cutter.position, from);
  field.update(aircraft);
  V.copy(cutter.position, to);
  const cuts = field.update(aircraft);
  let taken = 0;
  for (const cut of cuts) taken += cut.length;
  return taken;
}

function settings(overrides: Partial<MissionSettings> = {}): MissionSettings {
  return {
    mode: MISSION_MODE.Festival,
    locationName: "Test",
    latitude: 46.5375,
    longitude: 7.9625,
    missionRadius: 400,
    spawnAltitudeAgl: 120,
    weather: WEATHER.Clear,
    timeOfDay: TIME_OF_DAY.Day,
    enemyCount: 0,
    difficulty: DIFFICULTY.Normal,
    combat: false,
    formation: DEFAULT_FORMATION,
    race: DEFAULT_RACE,
    festival: {
      areaRadius: 400,
      aircraftCount: 3,
      durationSeconds: FESTIVAL_UNLIMITED,
      event: FESTIVAL_EVENT.Streamer,
    },
    strike: DEFAULT_STRIKE,
    opposition: DEFAULT_OPPOSITION,
    vtxPowerMw: DEFAULT_VTX_POWER_MW,
    seed: "STREAMSEED",
    ...overrides,
  };
}

async function flatTerrain(radius = 3000, height = 0): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => height),
    { cellSize: 100, warmRadius: 2000, sampleBudget: 40000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

export async function runStreamerTests(): Promise<void> {
  suite("what the field turned up to fly", () => {
    assert(
      FESTIVAL_EVENTS.length === 2 &&
        FESTIVAL_EVENTS.includes(FESTIVAL_EVENT.FlyIn) &&
        FESTIVAL_EVENTS.includes(FESTIVAL_EVENT.Streamer),
      "a festival is flown as a fly-in or as a streamer cut",
    );
    assert(
      FESTIVAL_EVENTS.every(
        (event) =>
          FESTIVAL_EVENT_INFO[event].label.length > 0 &&
          FESTIVAL_EVENT_INFO[event].description.length > 0,
      ),
      "and both of them have a name and a description to be offered under",
    );
    assert(
      normaliseFestivalEvent(undefined) === FESTIVAL_EVENT.FlyIn &&
        normaliseFestivalEvent("nonsense") === FESTIVAL_EVENT.FlyIn &&
        normaliseFestivalEvent(FESTIVAL_EVENT.Streamer) ===
          FESTIVAL_EVENT.Streamer,
      "settings that say nothing about it are the fly-in they always were",
    );
    assert(
      !isStreamerEvent({ areaRadius: 500, aircraftCount: 4, durationSeconds: 60 }) &&
        isStreamerEvent({
          areaRadius: 500,
          aircraftCount: 4,
          durationSeconds: 60,
          event: FESTIVAL_EVENT.Streamer,
        }),
      "and the paper is only in the air when it was asked for",
    );
    assert(
      festivalEventOf({
        areaRadius: 500,
        aircraftCount: 4,
        durationSeconds: 60,
        event: FESTIVAL_EVENT.Streamer,
      }) === FESTIVAL_EVENT.Streamer,
      "which is what the settings read back as",
    );
  });

  suite("the paper on the roll", () => {
    const labels = new Set(STREAMER_COLOURS.map((colour) => colour.label));
    assert(
      labels.size === STREAMER_COLOURS.length && STREAMER_COLOURS.length >= 12,
      `every colour on the roll is its own colour (${STREAMER_COLOURS.length})`,
    );
    assert(
      STREAMER_COLOURS.every((colour) => /^#[0-9a-f]{6}$/.test(colour.hex)),
      "and each of them is a colour a renderer can be handed",
    );
    assert(
      streamerLabel(0) === (STREAMER_COLOURS[0]?.label ?? "") &&
        streamerColour(STREAMER_COLOURS.length).id === STREAMER_COLOURS[0]?.id,
      "a big field goes round the roll again",
    );
    assert(
      streamerLabel(STREAMER_COLOURS.length).endsWith(" 2"),
      `and the second one of a colour says so (${streamerLabel(
        STREAMER_COLOURS.length,
      )})`,
    );
  });

  suite("a ribbon in the air", () => {
    const field = new StreamerField();
    const owner = parked("owner", V.vec3(0, 0, 100));
    enter(field, owner, 0);
    field.update([owner]);

    const streamer = field.streamerOf("owner");
    assert(streamer !== null, "an aircraft entered for the event tows paper");
    assertClose(
      streamer?.length ?? 0,
      STREAMER_LENGTH,
      1e-6,
      "a full roll of it from the first frame, so there is something to cut",
    );
    assert(
      (streamer?.points.length ?? 0) > 5,
      `laid out as a line rather than a point (${streamer?.points.length} nodes)`,
    );

    // Heading north, so the paper trails away to the south and slightly behind
    // the airframe rather than through it.
    const head = streamer?.points[0] as V.Vec3;
    const tip = streamer?.points[(streamer?.points.length ?? 1) - 1] as V.Vec3;
    assert(
      head.y < 0 && tip.y < head.y,
      `the ribbon is tied behind the aircraft and runs back from it (${tip.y.toFixed(1)} m)`,
    );
    assertClose(
      V.distance(head, tip),
      STREAMER_LENGTH,
      0.5,
      "and it is as long as it says it is",
    );
    assertClose(
      pointAt(V.vec3(), streamer!, 10).y,
      head.y - 10,
      0.3,
      "with a point ten metres down it ten metres down it",
    );
  });

  suite("cutting somebody's paper", () => {
    const field = new StreamerField();
    const owner = parked("owner", V.vec3(0, 0, 100));
    const cutter = parked("cutter", V.vec3(-40, -40, 100));
    enter(field, owner, 0);
    enter(field, cutter, 1);
    field.update([owner, cutter]);

    // Across the ribbon twenty metres behind the tail: five metres of paper
    // beyond the wing, give or take the span of the wing itself.
    const taken = sweep(
      field,
      [owner, cutter],
      cutter,
      V.vec3(-6, -21.5, 100),
      V.vec3(6, -21.5, 100),
    );
    assertBetween(taken, 4, 9, `a pass near the tip takes the tip (${taken.toFixed(1)} m)`);

    const board = field.standings();
    const scorer = board.standings.find((entry) => entry.competitorId === "field-1");
    const victim = board.standings.find((entry) => entry.competitorId === "field-0");
    assertClose(
      scorer?.cut ?? 0,
      taken,
      1e-6,
      "the metres are scored to whoever flew through it",
    );
    assertClose(
      victim?.lost ?? 0,
      taken,
      1e-6,
      "and off whoever was towing it",
    );
    assertClose(
      victim?.remaining ?? 0,
      STREAMER_LENGTH - taken,
      1e-6,
      "which is what is left on the tail",
    );
    assertClose(scorer?.position ?? 0, 1, 1e-9, "the cut leads the board");
    assertClose(scorer?.cuts ?? 0, 1, 1e-9, "and it took one pass to do it");
  });

  suite("how close you fly is what it is worth", () => {
    const tip = new StreamerField();
    const tipOwner = parked("owner", V.vec3(0, 0, 100));
    const tipCutter = parked("cutter", V.vec3(-40, 0, 100));
    enter(tip, tipOwner, 0);
    enter(tip, tipCutter, 1);
    tip.update([tipOwner, tipCutter]);
    const nibble = sweep(
      tip,
      [tipOwner, tipCutter],
      tipCutter,
      V.vec3(-6, -24, 100),
      V.vec3(6, -24, 100),
    );

    const root = new StreamerField();
    const rootOwner = parked("owner", V.vec3(0, 0, 100));
    const rootCutter = parked("cutter", V.vec3(-40, 0, 100));
    enter(root, rootOwner, 0);
    enter(root, rootCutter, 1);
    root.update([rootOwner, rootCutter]);
    const scalp = sweep(
      root,
      [rootOwner, rootCutter],
      rootCutter,
      V.vec3(-6, -4, 100),
      V.vec3(6, -4, 100),
    );

    assert(
      scalp > nibble * 3,
      `a pass at the knot is worth far more than one at the tip (${scalp.toFixed(
        1,
      )} m against ${nibble.toFixed(1)} m)`,
    );
    assertClose(
      root.streamerOf("owner")?.length ?? 0,
      STREAMER_STUB,
      0.01,
      "and the knot itself never comes off: the stub stays on the tail",
    );

    // Nothing there to cut any more, and flying through where it used to be is
    // not worth anything.
    const again = sweep(
      root,
      [rootOwner, rootCutter],
      rootCutter,
      V.vec3(-6, -4, 100),
      V.vec3(6, -4, 100),
    );
    assertClose(again, 0, 1e-9, "a second pass through a bare stub takes nothing");
  });

  suite("missing it entirely", () => {
    const field = new StreamerField();
    const owner = parked("owner", V.vec3(0, 0, 100));
    const cutter = parked("cutter", V.vec3(-40, 0, 100));
    enter(field, owner, 0);
    enter(field, cutter, 1);
    field.update([owner, cutter]);

    const past = sweep(
      field,
      [owner, cutter],
      cutter,
      V.vec3(-6, -34, 100),
      V.vec3(6, -34, 100),
    );
    assertClose(past, 0, 1e-9, "a pass behind the tip is a miss");

    const under = sweep(
      field,
      [owner, cutter],
      cutter,
      V.vec3(-6, -12, 80),
      V.vec3(6, -12, 80),
    );
    assertClose(under, 0, 1e-9, "and so is one twenty metres under it");
    assertClose(
      field.streamerOf("owner")?.length ?? 0,
      STREAMER_LENGTH,
      1e-6,
      "with the ribbon still whole",
    );
  });

  suite("a wreck takes its paper down with it", () => {
    const field = new StreamerField();
    const owner = parked("owner", V.vec3(0, 0, 100));
    const cutter = parked("cutter", V.vec3(-40, 0, 100));
    enter(field, owner, 0);
    enter(field, cutter, 1);
    field.update([owner, cutter]);

    owner.status = FLIGHT_STATUS.Disabled;
    field.update([owner, cutter]);
    assert(
      field.streamerOf("owner") === null,
      "an airframe that has stopped being an aircraft is out of the event",
    );

    const taken = sweep(
      field,
      [owner, cutter],
      cutter,
      V.vec3(-6, -12, 100),
      V.vec3(6, -12, 100),
    );
    assertClose(taken, 0, 1e-9, "and there is nothing left of it to cut");
    assert(
      field.standings().standings.some((entry) => !entry.flying),
      "the board says who is down",
    );
  });

  suite("the day is longer than the airframe", () => {
    const field = new StreamerField();
    const owner = parked("owner", V.vec3(0, 0, 100));
    const cutter = parked("cutter", V.vec3(-40, 0, 100));
    enter(field, owner, 0);
    enter(field, cutter, 1);
    field.update([owner, cutter]);
    sweep(
      field,
      [owner, cutter],
      cutter,
      V.vec3(-6, -12, 100),
      V.vec3(6, -12, 100),
    );
    const before = field.standings().standings.find((e) => e.isPlayer === false && e.competitorId === "field-1");
    assert((before?.cut ?? 0) > 0, "a pilot has cut something");

    // The wave ends: everybody comes down, everybody goes up in a fresh
    // airframe with a fresh roll of paper.
    field.clear();
    const second = parked("cutter-wave-2", V.vec3(0, 200, 100));
    field.attach(second.id, {
      competitorId: "field-1",
      label: streamerLabel(1),
      color: streamerColour(1).hex,
      isPlayer: false,
    });
    field.update([second]);

    const after = field.standings().standings.find((e) => e.competitorId === "field-1");
    assertClose(
      after?.cut ?? 0,
      before?.cut ?? 0,
      1e-9,
      "and what they cut in the last wave is still theirs in this one",
    );
    assertClose(
      after?.remaining ?? 0,
      STREAMER_LENGTH,
      1e-6,
      "on a fresh roll of paper",
    );
    assert(after?.flying === true, "and back in the air");
  });

  suite("the board", () => {
    const field = new StreamerField();
    const you = parked("player", V.vec3(0, 0, 100), 0, AIRCRAFT_ROLE.Player);
    const rival = parked("rival", V.vec3(200, 0, 100));
    const third = parked("third", V.vec3(-200, 0, 100));
    enter(field, you, 0, true);
    enter(field, rival, 1);
    enter(field, third, 2);
    field.update([you, rival, third]);

    // The rival takes a good piece out of the third aircraft; the pilot takes
    // a little out of the rival.
    sweep(
      field,
      [you, rival, third],
      rival,
      V.vec3(-206, -8, 100),
      V.vec3(-194, -8, 100),
    );
    V.copy(rival.position, V.vec3(200, 0, 100));
    field.update([you, rival, third]);
    sweep(
      field,
      [you, rival, third],
      you,
      V.vec3(194, -23, 100),
      V.vec3(206, -23, 100),
    );

    const board = field.standings();
    assertClose(board.standings.length, 3, 1e-9, "everybody entered is on it");
    assert(
      board.standings[0]?.competitorId === "field-1",
      "and it is led by whoever has cut the most",
    );
    assert(
      board.player !== null && board.player.isPlayer && board.player.position === 2,
      `with the pilot's own line on it (${board.player?.position})`,
    );
    assertBetween(
      board.cutTotal,
      board.best,
      board.best * 3,
      "the day's total is at least what the leader has",
    );
    assert(
      streamerSummary(board).includes("2nd"),
      `and the debrief line says where the pilot came (${streamerSummary(board)})`,
    );
    assert(
      formatStreamerLength(4.25).includes("4.3") && formatStreamerLength(42) === "42 m",
      "paper is written short and readable",
    );
    assert(
      ordinal(1) === "1st" && ordinal(2) === "2nd" && ordinal(3) === "3rd" &&
        ordinal(4) === "4th" && ordinal(11) === "11th" && ordinal(21) === "21st",
      "and a place is written the way it is said",
    );
  });

  suite("picking somebody to chase", () => {
    const field = new StreamerField();
    const hunter = parked("hunter", V.vec3(0, 0, 100));
    const near = parked("near", V.vec3(0, 120, 100));
    const far = parked("far", V.vec3(0, 600, 100));
    enter(field, hunter, 0);
    enter(field, near, 1);
    enter(field, far, 2);
    field.update([hunter, near, far]);

    const aim = V.vec3();
    const quarry = chooseQuarry(aim, field, hunter, { aimFraction: 0.5 });
    assert(quarry?.ownerId === "near", "a pilot goes after the nearest tail");
    assert(
      quarry !== null && quarry.range < V.distance(hunter.position, near.position),
      "aimed at the paper rather than at the aeroplane towing it",
    );
    assertBetween(
      aim.y,
      near.position.y - STREAMER_LENGTH,
      near.position.y,
      "somewhere along the ribbon",
    );

    const nobody = chooseQuarry(aim, field, hunter, {
      aimFraction: 0.5,
      searchRange: 10,
    });
    assert(nobody === null, "and nothing at all when everybody is too far away");

    const held = quarryOf(aim, field, "far", 0.5);
    assert(
      held?.ownerId === "far",
      "a pilot already committed to a tail is given that tail",
    );
    assert(
      quarryOf(aim, field, "nobody", 0.5) === null,
      "and nothing when the aircraft it committed to has gone",
    );

    const knot = V.vec3();
    const tip = V.vec3();
    quarryOf(knot, field, "near", 0);
    quarryOf(tip, field, "near", 1);
    assert(
      V.distance(knot, near.position) < V.distance(tip, near.position),
      "the braver the pilot the closer to the aeroplane it flies",
    );
  });

  await suite("a streamer event is scored as one", async () => {
    const rapier = await initRapier();
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain: await flatTerrain(3000, -500),
      missionRadius: 400,
      collision: new CollisionWorld(rapier),
      contactDamage: true,
    });
    const runner = new MissionRunner(settings());
    assert(
      runner.streamers !== null,
      "a festival flown as a streamer cut puts paper in the air",
    );
    assert(
      new MissionRunner(
        settings({
          festival: {
            areaRadius: 400,
            aircraftCount: 3,
            durationSeconds: FESTIVAL_UNLIMITED,
            event: FESTIVAL_EVENT.FlyIn,
          },
        }),
      ).streamers === null,
      "and a fly-in does not",
    );

    const you = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, -18, 200),
        headingDeg: 0,
        airspeed: 24,
        throttle: 0.6,
      },
      () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0.6 }),
    );
    const rival = simulation.spawn(
      {
        id: "festival-1",
        role: AIRCRAFT_ROLE.Festival,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 200),
        headingDeg: 0,
        airspeed: 24,
        throttle: 0.6,
      },
      () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0.6 }),
    );
    runner.streamers?.attach(you.id, {
      competitorId: "player",
      label: "You",
      color: streamerColour(0).hex,
      isPlayer: true,
    });
    runner.streamers?.attach(rival.id, {
      competitorId: "field-1",
      label: streamerLabel(1),
      color: streamerColour(1).hex,
      isPlayer: false,
    });

    // The pilot is eighteen metres behind the rival on the same heading,
    // which is exactly where its paper is.
    let cuts = 0;
    for (let i = 0; i < 20 * 60; i += 1) {
      simulation.update(1 / 60);
      for (const event of runner.update(simulation, 1 / 60)) {
        if (event.type === "STREAMER_CUT") cuts += 1;
      }
      if (cuts > 0) break;
    }

    assert(cuts > 0, "flying up the back of somebody takes their paper off");
    const progress = runner.status.festival;
    assert(
      progress?.event === FESTIVAL_EVENT.Streamer,
      "the OSD is told which event this is",
    );
    const board = progress?.streamer ?? null;
    assert(board !== null, "and is given the board");
    assert(
      (board?.player?.cut ?? 0) > MIN_STREAMER_CUT,
      `with the pilot's own metres on it (${(board?.player?.cut ?? 0).toFixed(1)} m)`,
    );
    assert(
      festivalSummary(progress!).toLowerCase().includes("streamer"),
      `and the day is summed up by the paper (${festivalSummary(progress!)})`,
    );
  });

  await suite("a field with paper on it goes hunting", async () => {
    // Nothing here is scripted. Ten of somebody else's models over a small
    // field, each towing a ribbon, each flown by a pilot that has picked a
    // tail and committed to it — and left alone, they take paper off each
    // other.
    const terrain = await flatTerrain(2500, 0);
    const rapier = await initRapier();
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 500 }),
      terrain,
      missionRadius: 300,
      collision: new CollisionWorld(rapier),
      contactDamage: true,
    });
    const field = new StreamerField();

    const centre = V.vec3(0, 0, 0);
    const count = 10;
    for (let i = 0; i < count; i += 1) {
      const id = `festival-${i + 1}`;
      const pilot = new FestivalPilot({
        id,
        centre,
        areaRadius: 300,
        floor: 35,
        ceiling: 165,
        terrain,
        seed: "CUTSEED",
        getTraffic: () => simulation.aircraft,
        streamers: field,
      });
      simulation.spawn(
        {
          id,
          role: AIRCRAFT_ROLE.Festival,
          config: PLAYER_WING,
          position: festivalSpawnPoint(V.vec3(), i, count, centre, 300, 35, 165),
          headingDeg: (i * 360) / count,
          airspeed: 22,
          throttle: 0.6,
        },
        pilot.control,
      );
      field.attach(id, {
        competitorId: `field-${i}`,
        label: streamerLabel(i),
        color: streamerColour(i).hex,
        isPlayer: false,
      });
    }

    let cuts = 0;
    let seconds = 0;
    for (let i = 0; i < 300 * 60; i += 1) {
      simulation.update(1 / 60);
      cuts += field.update(simulation.aircraft).length;
      seconds = i / 60;
      if (cuts >= 3) break;
    }

    assert(
      cuts >= 3,
      `a field towing paper cuts it without being told to (${cuts} cuts in ${seconds.toFixed(
        0,
      )} s)`,
    );
    const board = field.standings();
    assert(
      board.best > MIN_STREAMER_CUT,
      `with somebody leading it (${board.standings[0]?.label} on ${board.best.toFixed(
        1,
      )} m)`,
    );
    assert(
      board.standings.every(
        (entry) => entry.remaining <= STREAMER_LENGTH + 1e-6 && entry.remaining >= 0,
      ),
      "and nobody's ribbon longer than the roll it came off",
    );
  });
}
