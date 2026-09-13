import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE } from "../flight/state";
import type { AircraftState } from "../flight/state";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { MissionRunner } from "../mission/missionRunner";
import type { MissionSettings } from "../mission/types";
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
import {
  CLEAN_FRACTION,
  REFERENCE_POWER_MW,
  REFERENCE_RANGE_METRES,
  SIGNAL_LOSS_TIMEOUT,
  VideoLink,
  VTX_POWER_LEVELS,
  VTX_UNLIMITED,
  formatVtxPower,
  videoLinkRange,
  videoSignalQuality,
} from "../environment/videoLink";
import { videoNoiseFrame } from "../hud/videoNoise";
import { createFlightInput } from "../input/types";
import * as V from "../math/vec3";

const idle = createFlightInput();

function settings(overrides: Partial<MissionSettings> = {}): MissionSettings {
  return {
    mode: MISSION_MODE.Intercept,
    locationName: "Test",
    latitude: 46.5375,
    longitude: 7.9625,
    missionRadius: 20000,
    spawnAltitudeAgl: 300,
    weather: WEATHER.Clear,
    timeOfDay: TIME_OF_DAY.Day,
    enemyCount: 1,
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

/** Flat ground well below the aircraft, so nothing blocks anything. */
async function flatTerrain(radius = 12000): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => -500),
    { cellSize: 250, warmRadius: 6000, sampleBudget: 40000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

/** A wall of rock across the northern half of the mission area. */
async function ridgeTerrain(radius = 4000): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) =>
      points.map((p) => (p.y > 400 && p.y < 900 ? 900 : 0)),
    { cellSize: 100, warmRadius: 2500, sampleBudget: 40000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

function player(position: V.Vec3): AircraftState {
  return {
    id: "player",
    role: AIRCRAFT_ROLE.Player,
    status: "FLYING",
    position,
  } as unknown as AircraftState;
}

export async function runVideoLinkTests(): Promise<void> {
  suite("video link range", () => {
    assertClose(
      videoLinkRange(REFERENCE_POWER_MW),
      REFERENCE_RANGE_METRES,
      1,
      "the reference power gives the reference range",
    );
    // Received power falls with the square of distance, so four times the
    // transmitter is exactly twice the reach.
    assertClose(
      videoLinkRange(REFERENCE_POWER_MW * 4),
      REFERENCE_RANGE_METRES * 2,
      1,
      "four times the power is twice the range",
    );
    assert(
      videoLinkRange(VTX_UNLIMITED) === Number.POSITIVE_INFINITY,
      "unlimited power has no range at all",
    );
    // The ladder has to keep climbing, or two settings on the screen would fly
    // the same mission.
    let previous = 0;
    let ascending = true;
    for (const power of VTX_POWER_LEVELS) {
      if (videoLinkRange(power) <= previous) ascending = false;
      previous = videoLinkRange(power);
    }
    assert(ascending, "every power on the ladder reaches further than the last");
    assert(
      formatVtxPower(25) === "25 mW" &&
        formatVtxPower(1000) === "1 W" &&
        formatVtxPower(10000) === "10 W" &&
        formatVtxPower(VTX_UNLIMITED) === "Unlimited",
      "powers read the way they are written on the hardware",
    );
  });

  suite("signal quality", () => {
    const range = 2000;
    assertClose(
      videoSignalQuality(0, range),
      1,
      1e-6,
      "the picture is clean over the pilot's head",
    );
    assertClose(
      videoSignalQuality(range * CLEAN_FRACTION * 0.9, range),
      1,
      1e-6,
      "and still clean short of the break-up point",
    );
    assert(
      videoSignalQuality(range, range) === 0,
      "and gone at the edge of the range",
    );
    assert(
      videoSignalQuality(range * 3, range) === 0,
      "and stays gone beyond it",
    );

    // In between it has to fall, and fall smoothly: the whole point is that
    // the pilot gets a warning before the picture goes.
    let previous = 1;
    let falling = true;
    for (let d = range * CLEAN_FRACTION; d <= range; d += range * 0.02) {
      const quality = videoSignalQuality(d, range);
      if (quality > previous + 1e-9) falling = false;
      previous = quality;
    }
    assert(falling, "quality only ever falls as the aircraft flies out");
    assertBetween(
      videoSignalQuality(range * 0.85, range),
      0.01,
      0.99,
      "the picture is breaking up between the two",
    );

    assert(
      videoSignalQuality(range * 0.3, range, true) <
        videoSignalQuality(range * 0.3, range),
      "terrain in the way costs the link even at close range",
    );
    assertClose(
      videoSignalQuality(500000, Number.POSITIVE_INFINITY),
      1,
      1e-6,
      "an unlimited link is clean anywhere",
    );
  });

  suite("losing the picture", () => {
    const link = new VideoLink({ powerMilliwatts: 25 });
    const range = videoLinkRange(25);

    link.update(player(V.vec3(0, 0, 200)), 0.1);
    assert(link.state.quality === 1, "overhead the link is perfect");
    assert(!link.state.lost && !link.state.failed, "and nothing is counting");

    // Out past the range and the picture is gone, but the airframe is not
    // written off until it has stayed gone.
    const far = player(V.vec3(range * 2, 0, 200));
    link.update(far, 1);
    assert(link.state.lost, "past the range there is no picture");
    assertClose(link.state.lostSeconds, 1, 1e-9, "the clock has started");
    assert(!link.state.failed, "one second out of range is not a lost airframe");

    for (let t = 0; t < SIGNAL_LOSS_TIMEOUT + 1; t += 1) link.update(far, 1);
    assert(
      link.state.failed,
      `${SIGNAL_LOSS_TIMEOUT} seconds without a picture writes the airframe off`,
    );

    // A single frame of picture is a rescue: the clock goes back to zero.
    const recovered = new VideoLink({ powerMilliwatts: 25 });
    recovered.update(far, 10);
    assert(recovered.state.lostSeconds >= 10, "ten seconds of snow");
    recovered.update(player(V.vec3(0, 0, 200)), 0.1);
    assert(
      recovered.state.lostSeconds === 0 && !recovered.state.failed,
      "flying back into range puts the clock back to zero",
    );

    // Nothing at all happens when range is not being simulated.
    const unlimited = new VideoLink({ powerMilliwatts: VTX_UNLIMITED });
    for (let t = 0; t < 60; t += 1) {
      unlimited.update(player(V.vec3(400000, 0, 5000)), 1);
    }
    assert(
      !unlimited.state.enabled &&
        unlimited.state.quality === 1 &&
        !unlimited.state.failed,
      "an unlimited link never breaks up, however far out you fly",
    );
  });

  await suite("terrain across the link", async () => {
    const terrain = await ridgeTerrain();
    // Plenty of power, so range alone can never explain what happens here.
    const link = new VideoLink({ powerMilliwatts: 10000, terrain });

    link.update(player(V.vec3(0, 300, 400)), 0.1);
    assert(
      !link.state.blocked && link.state.quality === 1,
      "on the near side of the ridge the picture is clean",
    );

    link.update(player(V.vec3(0, 1500, 300)), 0.1);
    assert(link.state.blocked, "behind the ridge the sight line is gone");
    assert(
      link.state.quality < 0.4,
      `and the picture with it (${link.state.quality.toFixed(2)})`,
    );

    // Climbing over the ridge line gets the link back, which is exactly the
    // thing a real pilot does about it.
    // High enough that the sight line clears the near face of the ridge, not
    // just its top: from a ground station the line is shallow.
    link.update(player(V.vec3(0, 1500, 4000)), 0.1);
    assert(
      !link.state.blocked && link.state.quality === 1,
      "climbing above the ridge restores it",
    );
  });

  await suite("a mission ends when the picture does", async () => {
    const simulation = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain: await flatTerrain(),
      missionRadius: 20000,
      videoLink: new VideoLink({ powerMilliwatts: 25 }),
    });
    simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        // Well past the range of a 25 mW link, and high enough that the ground
        // cannot end the flight before the video does.
        position: V.vec3(6000, 0, 1500),
        headingDeg: 0,
        airspeed: 25,
        throttle: 0.7,
      },
      () => idle,
    );

    // No contacts are ever put in the air, so nothing but the video link can
    // decide this mission either way.
    const runner = new MissionRunner(settings({ vtxPowerMw: 25 }));

    let failure = "";
    for (let t = 0; t < SIGNAL_LOSS_TIMEOUT + 4; t += 0.25) {
      simulation.update(0.25);
      for (const event of runner.update(simulation, 0.25)) {
        if (event.type === "FAILED") failure = event.reason;
      }
    }

    assert(
      runner.status.outcome === MISSION_OUTCOME.Failed,
      "flying out of range and staying there ends the mission",
    );
    assert(
      failure.toLowerCase().includes("video link"),
      `and says why (${failure})`,
    );
    assert(
      simulation.telemetry().videoQuality === 0 &&
        simulation.telemetry().videoLinkEnabled,
      "the OSD had the link at zero the whole time",
    );

    // The same flight with no transmitter limit is simply a long flight.
    const unlimited = new Simulation({
      frame: new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 }),
      terrain: await flatTerrain(),
      missionRadius: 20000,
      videoLink: new VideoLink({ powerMilliwatts: VTX_UNLIMITED }),
    });
    unlimited.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(6000, 0, 1500),
        headingDeg: 0,
        airspeed: 25,
        throttle: 0.7,
      },
      () => idle,
    );
    const openRunner = new MissionRunner(settings());
    for (let t = 0; t < SIGNAL_LOSS_TIMEOUT + 4; t += 0.25) {
      unlimited.update(0.25);
      openRunner.update(unlimited, 0.25);
    }
    assert(
      openRunner.status.outcome === MISSION_OUTCOME.InProgress,
      "with an unlimited link the same flight carries on",
    );
  });

  suite("interference", () => {
    const clean = videoNoiseFrame(1, 3);
    assert(
      clean.opacity === 0 && !clean.blackout,
      "a clean link draws nothing at all",
    );

    const gone = videoNoiseFrame(0, 3);
    assert(
      gone.opacity === 1 && gone.blackout && gone.snow === 1,
      "a dead link is nothing but snow",
    );

    // In between, the picture has to be visible through the interference, and
    // it has to move: a still frame of noise reads as a texture, not a fault.
    let opaquest = 0;
    let clearest = 1;
    for (let t = 0; t < 12; t += 0.05) {
      const frame = videoNoiseFrame(0.5, t);
      opaquest = Math.max(opaquest, frame.opacity);
      clearest = Math.min(clearest, frame.opacity);
      assertBetweenSilently(frame.bandOffset, 0, 1);
    }
    assertBetween(clearest, 0, 0.95, "a half-lost picture still shows through");
    assert(opaquest > clearest, "and it breaks up in bursts rather than evenly");
    assert(
      videoNoiseFrame(0.2, 4).opacity > videoNoiseFrame(0.8, 4).opacity,
      "a weaker signal is a noisier picture",
    );
  });
}

/** Bounds check with no output; used inside loops that would flood the log. */
function assertBetweenSilently(value: number, min: number, max: number): void {
  if (value >= min && value <= max) return;
  throw new Error(`expected ${min}..${max}, got ${value}`);
}
