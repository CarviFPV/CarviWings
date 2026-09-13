import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { LOCATION_PRESETS } from "../geo/locations";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import type { AircraftState } from "../flight/state";
import {
  classifyTouchdown,
  GROUND_CONTACT,
  surfaceNormal,
  TOUCHDOWN_VERDICT,
} from "../flight/ground";
import type { FlightInput } from "../input/types";
import { fromHeadingPitchRoll, quat, toHeadingPitchRoll } from "../math/quat";
import { clamp, DEG_TO_RAD } from "../math/scalar";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import * as V from "../math/vec3";

const preset = LOCATION_PRESETS[0]!;

function makeFrame(): EnuFrame {
  return new EnuFrame({
    latitude: preset.latitude,
    longitude: preset.longitude,
    height: 500,
  });
}

async function makeTerrain(
  height: (x: number, y: number) => number,
): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) =>
      points.map((p) => height(p.x, p.y)),
    { cellSize: 50, warmRadius: 1500, sampleBudget: 8192, detailCellSize: 0 },
  );
  await field.prefill(V.vec3(), 3000);
  return field;
}

function makeSimulation(terrain: TerrainField): Simulation {
  return new Simulation({ frame: makeFrame(), terrain, missionRadius: 10000 });
}

/**
 * A landing approach, flown the way a pilot flies one: the nose holds the
 * speed and the throttle holds the descent. Closing both loops matters — an
 * approach flown on elevator alone arrives either far too fast or stalled.
 */
function approach(
  state: AircraftState,
  targetSink: number,
  targetSpeed: number,
): FlightInput {
  const angles = toHeadingPitchRoll(state.orientation);
  // Too fast, raise the nose; too slow, lower it. Speed is flown on pitch.
  const targetPitch = clamp((state.airspeed - targetSpeed) * 0.8, -8, 8);
  const sink = -state.velocity.z;
  return {
    pitch: clamp((targetPitch - angles.pitchDeg) * 0.06, -1, 1),
    roll: clamp(-angles.rollDeg * 0.03, -1, 1),
    yaw: 0,
    throttle: clamp(0.25 + (sink - targetSink) * 0.35, 0, 1),
  };
}

/** Hands off and throttle closed, which is what a pilot does after touchdown. */
const idle: FlightInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };

/**
 * Flies an approach until the aircraft is no longer flying, then holds the
 * controls still. Returns how long it took to get there.
 */
function flyApproach(
  simulation: Simulation,
  player: AircraftState,
  seconds: number,
): number {
  let touchedDownAt = -1;
  for (let i = 0; i < seconds * 60; i += 1) {
    simulation.update(1 / 60);
    if (touchedDownAt < 0 && player.status !== FLIGHT_STATUS.Flying) {
      touchedDownAt = simulation.time;
    }
    if (player.status === FLIGHT_STATUS.Landed) break;
    if (player.status === FLIGHT_STATUS.Crashed) break;
  }
  return touchedDownAt;
}

export async function runLandingTests(): Promise<void> {
  await suite("a wing flown onto a field lands on it", async () => {
    const terrain = await makeTerrain(() => 0);
    const simulation = makeSimulation(terrain);

    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 70),
        headingDeg: 0,
        airspeed: 20,
        throttle: 0.4,
      },
      (state) =>
        state.status === FLIGHT_STATUS.Flying
          ? approach(state, 1.5, 19)
          : idle,
    );

    const touchdownX = { value: 0, y: 0, speed: 0 };
    let sawSliding = false;
    for (let i = 0; i < 60 * 120; i += 1) {
      simulation.update(1 / 60);
      if (!sawSliding && player.status === FLIGHT_STATUS.Sliding) {
        sawSliding = true;
        touchdownX.value = player.position.x;
        touchdownX.y = player.position.y;
        touchdownX.speed = V.length(player.velocity);
      }
      if (player.status === FLIGHT_STATUS.Landed) break;
      if (player.status === FLIGHT_STATUS.Crashed) break;
    }

    assert(sawSliding, "the approach ends on the belly, not in a fireball");
    assert(
      player.status === FLIGHT_STATUS.Landed,
      `and comes to a stop (ended ${player.status})`,
    );
    assert(simulation.statistics.crashes === 0, "nothing is recorded as a crash");
    assert(simulation.statistics.landings === 1, "one landing is recorded");

    const landings = simulation.drainLandings();
    assert(landings.length === 1, "and reported exactly once");
    assertBetween(
      landings[0]?.sinkRate ?? -1,
      0,
      3,
      "the touchdown was inside the sink rate the airframe survives",
    );

    const slide = Math.hypot(
      player.position.x - touchdownX.value,
      player.position.y - touchdownX.y,
    );
    assertBetween(
      slide,
      10,
      140,
      `the wing slides a believable distance before stopping (${slide.toFixed(0)} m from ${touchdownX.speed.toFixed(0)} m/s)`,
    );
    assertClose(
      player.position.z,
      terrain.heightAt(player.position.x, player.position.y),
      0.5,
      "and it ends up sitting on the surface, not hovering above it",
    );
    // Left alone it stays where it stopped rather than creeping or sinking.
    for (let i = 0; i < 60 * 5; i += 1) simulation.update(1 / 60);
    assert(player.status === FLIGHT_STATUS.Landed, "and stays down");
    assertClose(V.length(player.velocity), 0, 0.01, "stopped is stopped");
    assertClose(
      player.position.z,
      terrain.heightAt(player.position.x, player.position.y),
      0.5,
      "still resting on the surface five seconds later",
    );

    const angles = toHeadingPitchRoll(player.orientation);
    assertBetween(angles.rollDeg, -3, 3, "lying flat on its belly");
    assertBetween(angles.pitchDeg, -3, 6, "and nose very slightly up");
  });

  await suite("a wing flown into the ground still crashes", async () => {
    const terrain = await makeTerrain(() => 0);
    const simulation = makeSimulation(terrain);

    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 200),
        headingDeg: 0,
        pitchDeg: -35,
        airspeed: 28,
        throttle: 1,
      },
      (state) => {
        const angles = toHeadingPitchRoll(state.orientation);
        return {
          pitch: clamp((-35 - angles.pitchDeg) * 0.06, -1, 1),
          roll: 0,
          yaw: 0,
          throttle: 1,
        };
      },
    );

    for (let i = 0; i < 60 * 40; i += 1) {
      simulation.update(1 / 60);
      if (player.status === FLIGHT_STATUS.Crashed) break;
    }

    assert(
      player.status === FLIGHT_STATUS.Crashed,
      `a dive into the ground is still a crash (ended ${player.status})`,
    );
    assert(simulation.statistics.crashes === 1, "and is recorded as one");
    assert(simulation.statistics.landings === 0, "and never as a landing");
  });

  await suite("a landed wing can take off again", async () => {
    const terrain = await makeTerrain(() => 0);
    const simulation = makeSimulation(terrain);

    // Straight onto the ground: this is the state a pilot is in after a
    // successful landing, and the only way back into the air is the throttle.
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, GROUND_CONTACT.restHeight),
        headingDeg: 0,
        airspeed: 0,
        throttle: 0,
      },
      () => ({ pitch: 1, roll: 0, yaw: 0, throttle: 1 }),
    );
    // `spawn` starts an aircraft in flight; one step puts it on its belly.
    simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Sliding ||
        player.status === FLIGHT_STATUS.Landed,
      "an aircraft placed on the ground is on the ground",
    );

    let airborneAt = -1;
    let rollSpeed = 0;
    for (let i = 0; i < 60 * 60 && airborneAt < 0; i += 1) {
      simulation.update(1 / 60);
      if (player.status === FLIGHT_STATUS.Flying) {
        airborneAt = simulation.time;
        rollSpeed = player.airspeed;
      }
      if (player.status === FLIGHT_STATUS.Crashed) break;
    }

    assert(airborneAt > 0, `full power gets it flying again (t=${airborneAt.toFixed(1)}s)`);
    assertBetween(
      rollSpeed,
      9,
      22,
      `and it rotates near its stall speed (${rollSpeed.toFixed(1)} m/s)`,
    );
    assert(simulation.statistics.crashes === 0, "without breaking anything");

    // Keep flying and it climbs away rather than settling back on.
    for (let i = 0; i < 60 * 8; i += 1) simulation.update(1 / 60);
    assert(
      player.altitudeAgl > 5,
      `and it climbs away (${player.altitudeAgl.toFixed(1)} m AGL)`,
    );
  });

  suite("what a touchdown is judged on", () => {
    const flat = V.vec3(0, 0, 1);
    const state = (
      sinkRate: number,
      rollDeg: number,
      pitchDeg = 2,
      speed = 18,
    ): AircraftState =>
      ({
        orientation: fromHeadingPitchRoll(quat(), 0, pitchDeg, rollDeg),
        velocity: V.vec3(0, Math.sqrt(Math.max(speed * speed - sinkRate * sinkRate, 0)), -sinkRate),
        sideslip: 0,
      }) as AircraftState;

    assert(
      classifyTouchdown(state(1.2, 0), flat) === TOUCHDOWN_VERDICT.Slide,
      "wings level and sinking gently is a landing",
    );
    assert(
      classifyTouchdown(state(6, 0), flat) === TOUCHDOWN_VERDICT.Crash,
      "the same attitude arriving twice as fast down is not",
    );
    assert(
      classifyTouchdown(state(1.2, 45), flat) === TOUCHDOWN_VERDICT.Crash,
      "a wing down digs a wingtip in",
    );
    assert(
      classifyTouchdown(state(1.2, 0, -30), flat) === TOUCHDOWN_VERDICT.Crash,
      "and a nose buried in the dirt does not slide",
    );
    assert(
      classifyTouchdown(state(1.2, 0, 2, 45), flat) === TOUCHDOWN_VERDICT.Crash,
      "nor does an airframe arriving far too fast",
    );

    const crabbed = state(1.2, 0);
    (crabbed as { sideslip: number }).sideslip = 35 * DEG_TO_RAD;
    assert(
      classifyTouchdown(crabbed, flat) === TOUCHDOWN_VERDICT.Crash,
      "arriving sideways is a crash however gently it is done",
    );

    // On a slope, level is level with the slope: the identical aircraft that
    // lands on the flat flies into a hillside.
    const slope = V.normalize(V.vec3(), V.vec3(0, -0.36, 1)); // ~20 degrees up
    assert(
      classifyTouchdown(state(1.2, 0), slope) === TOUCHDOWN_VERDICT.Crash,
      "flying level into rising ground is measured against the ground",
    );
    assert(
      classifyTouchdown(state(1.2, 0), V.normalize(V.vec3(), V.vec3(0, 0.36, 1))) ===
        TOUCHDOWN_VERDICT.Slide,
      "and the same arrival onto ground falling away is still a landing",
    );
  });

  await suite("the surface normal follows the terrain", async () => {
    // A constant 10% slope up to the north.
    const terrain = await makeTerrain((_x, y) => y * 0.1);
    const normal = surfaceNormal(V.vec3(), terrain, 100, 100);
    assertClose(normal.x, 0, 1e-6, "no cross slope, no cross-slope tilt");
    assertClose(
      normal.y,
      -0.1 / Math.sqrt(1.01),
      1e-6,
      "the normal leans back down the slope",
    );
    assert(normal.z > 0.99, "and still points up");
  });

  await suite("a wing put down on a slope lies along it", async () => {
    // Eight degrees, which is steep for a field and well inside what the
    // airframe will accept as a landing surface.
    const grade = Math.tan(8 * DEG_TO_RAD);
    const terrain = await makeTerrain((_x, y) => -y * grade);
    const simulation = makeSimulation(terrain);

    // Flown downhill, so the approach has to out-descend the ground: at 19 m/s
    // the surface itself falls away at 2.7 m/s, and an ordinary 1.5 m/s
    // approach would simply never reach it.
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 25),
        headingDeg: 0,
        airspeed: 20,
        throttle: 0.4,
      },
      (state) =>
        state.status === FLIGHT_STATUS.Flying ? approach(state, 4.5, 19) : idle,
    );

    const touchedDownAt = flyApproach(simulation, player, 200);
    assert(touchedDownAt > 0, "the approach reaches the slope");
    assert(
      simulation.statistics.landings === 1 && simulation.statistics.crashes === 0,
      `landing downhill is a landing (ended ${player.status})`,
    );
    assertClose(
      player.position.z,
      terrain.heightAt(player.position.x, player.position.y),
      0.5,
      "and the airframe ends up lying on the slope",
    );

    const angles = toHeadingPitchRoll(player.orientation);
    assertBetween(
      angles.pitchDeg,
      -10,
      -4,
      `nose down the hill, matching the slope (${angles.pitchDeg.toFixed(1)}°)`,
    );
  });
}
