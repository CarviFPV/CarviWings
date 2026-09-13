import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { LOCATION_PRESETS } from "../geo/locations";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import type { FlightInput } from "../input/types";
import type { AircraftState } from "../flight/state";
import { toHeadingPitchRoll } from "../math/quat";
import { clamp } from "../math/scalar";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { CollisionWorld, initRapier } from "../physics/collisionWorld";
import { WindField } from "../environment/wind";
import * as V from "../math/vec3";

const preset = LOCATION_PRESETS[0]!;

/** A hill that rises to the north, so flying level eventually meets terrain. */
function slopeHeight(x: number, y: number): number {
  return 0 + y * 0.05 + 30 * Math.sin(x / 400);
}

function makeFrame(): EnuFrame {
  return new EnuFrame({
    latitude: preset.latitude,
    longitude: preset.longitude,
    height: 2400,
  });
}

async function makeTerrain(
  height: (x: number, y: number) => number,
  radius = 4000,
): Promise<TerrainField> {
  const probe = async (points: readonly TerrainQuery[]) =>
    points.map((p) => height(p.x, p.y));
  const field = new TerrainField(probe, {
    cellSize: 100,
    warmRadius: 1200,
    sampleBudget: 4096,
  });
  await field.prefill(V.vec3(), radius);
  return field;
}

const level: FlightInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.7 };

/**
 * Holds a target pitch attitude with wings level.
 *
 * A constant down-elevator would fly an outside loop rather than a descent, so
 * a descent has to be commanded the way a pilot or an autopilot would: close
 * the loop on attitude.
 */
function holdPitch(
  state: AircraftState,
  targetPitchDeg: number,
  throttle: number,
): FlightInput {
  const angles = toHeadingPitchRoll(state.orientation);
  return {
    pitch: clamp((targetPitchDeg - angles.pitchDeg) * 0.06, -1, 1),
    roll: clamp(-angles.rollDeg * 0.03, -1, 1),
    yaw: 0,
    throttle,
  };
}

export async function runSimulationTests(): Promise<void> {
  await suite("terrain collision", async () => {
    const frame = makeFrame();
    const terrain = await makeTerrain(slopeHeight);
    const simulation = new Simulation({
      frame,
      terrain,
      missionRadius: 10000,
      groundClearance: 1.5,
    });

    const groundZ = terrain.heightAt(0, 0);
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, groundZ + 300),
        headingDeg: 0,
        airspeed: 25,
        throttle: 0.7,
      },
      (state) => holdPitch(state, -30, 0.25),
    );

    assertClose(player.altitudeAgl, 300, 1, "spawn sits 300 m above the terrain");
    assert(player.status === FLIGHT_STATUS.Flying, "spawns flying");
    assert(player.position.z > terrain.heightAt(0, 0), "never spawns below terrain");

    // Fly it into the ground.
    let crashingAt = -1;
    let crashedAt = -1;
    for (let i = 0; i < 60 * 30 && crashedAt < 0; i += 1) {
      simulation.update(1 / 60);
      if (crashingAt < 0 && player.status === FLIGHT_STATUS.Crashing) {
        crashingAt = simulation.time;
      }
      if (player.status === FLIGHT_STATUS.Crashed) crashedAt = simulation.time;
    }

    assert(crashingAt > 0, `FLYING -> CRASHING at t=${crashingAt.toFixed(1)}s`);
    assert(crashedAt > crashingAt, `CRASHING -> CRASHED at t=${crashedAt.toFixed(1)}s`);
    assertBetween(
      crashedAt - crashingAt,
      1.2,
      1.7,
      "the crash settles for the configured interval",
    );
    assert(simulation.statistics.crashes === 1, "one crash is recorded");
    assertClose(
      player.position.z,
      terrain.heightAt(player.position.x, player.position.y),
      2.5,
      "the wreck settles onto the surface rather than through it",
    );
    assert(
      simulation.statistics.distanceFlown > 100,
      `distance flown recorded (${simulation.statistics.distanceFlown.toFixed(0)} m)`,
    );
    assert(
      simulation.statistics.maxAltitude > 2000,
      "max altitude is geodetic, not local",
    );
  });

  await suite("terrain coverage gating", async () => {
    // A field that never returns data must never destroy an aircraft: missing
    // data is not the ground.
    const frame = makeFrame();
    const empty = new TerrainField(async (points) => points.map(() => null), {
      cellSize: 100,
    });
    const simulation = new Simulation({
      frame,
      terrain: empty,
      missionRadius: 10000,
    });
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 5),
        headingDeg: 0,
        airspeed: 25,
        throttle: 0,
      },
      (state) => holdPitch(state, -30, 0),
    );
    for (let i = 0; i < 60 * 8; i += 1) simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Flying,
      "an aircraft over unsampled terrain keeps flying",
    );
    assert(simulation.statistics.crashes === 0, "no phantom crash is recorded");
  });

  await suite("mission area", async () => {
    const frame = makeFrame();
    const terrain = await makeTerrain(() => -500, 2000);
    const simulation = new Simulation({
      frame,
      terrain,
      missionRadius: 1000,
    });
    simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 300),
        headingDeg: 90,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );

    assert(!simulation.telemetry().outsideMissionArea, "starts inside the area");
    for (let i = 0; i < 60 * 60; i += 1) simulation.update(1 / 60);
    const telemetry = simulation.telemetry();
    assert(
      telemetry.outsideMissionArea,
      `flying east for a minute leaves a 1 km radius (${(telemetry.distanceFromOrigin / 1000).toFixed(2)} km)`,
    );
    assert(telemetry.longitude > preset.longitude, "heading 090 increases longitude");
    assertClose(telemetry.latitude, preset.latitude, 0.02, "heading 090 holds latitude");
  });

  await suite("physical interception", async () => {
    const rapier = await initRapier();
    const frame = makeFrame();
    const terrain = await makeTerrain(() => -1000, 3000);
    const simulation = new Simulation({
      frame,
      terrain,
      missionRadius: 20000,
      collision: new CollisionWorld(rapier),
      contactDamage: true,
    });

    // Two aircraft on a head-on collision course, 600 m apart.
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, -300, 500),
        headingDeg: 0,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );
    const enemy = simulation.spawn(
      {
        id: "enemy-1",
        role: AIRCRAFT_ROLE.Enemy,
        config: PLAYER_WING,
        position: V.vec3(0, 300, 500),
        headingDeg: 180,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );

    let intercepts = 0;
    for (let i = 0; i < 60 * 30 && intercepts === 0; i += 1) {
      simulation.update(1 / 60);
      intercepts += simulation.drainContacts().length;
    }

    assert(intercepts === 1, "a head-on pass produces exactly one interception");
    // Neither wing is carrying a charge, so the impact alone writes both
    // airframes off — and a written-off airframe is a wreck falling out of the
    // sky, not an aircraft that stops existing where it was hit.
    assert(
      player.status === FLIGHT_STATUS.Disabled,
      `the interceptor stops flying (${player.status})`,
    );
    assert(
      enemy.status === FLIGHT_STATUS.Disabled,
      `and so does the target (${enemy.status})`,
    );
    assert(
      simulation.statistics.enemiesDestroyed === 1,
      "one enemy is counted as destroyed",
    );
    assert(simulation.statistics.collisions === 1, "one collision is recorded");
  });

  await suite("contact damage disabled", async () => {
    const rapier = await initRapier();
    const frame = makeFrame();
    const terrain = await makeTerrain(() => -1000, 3000);
    const simulation = new Simulation({
      frame,
      terrain,
      missionRadius: 20000,
      collision: new CollisionWorld(rapier),
      contactDamage: false,
    });
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, -300, 500),
        headingDeg: 0,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );
    simulation.spawn(
      {
        id: "enemy-1",
        role: AIRCRAFT_ROLE.Enemy,
        config: PLAYER_WING,
        position: V.vec3(0, 300, 500),
        headingDeg: 180,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );

    for (let i = 0; i < 60 * 30; i += 1) simulation.update(1 / 60);
    assert(
      simulation.statistics.collisions >= 1,
      "the contact is still detected with damage off",
    );
    assert(
      player.status === FLIGHT_STATUS.Flying,
      "nothing is destroyed when contacts do no damage",
    );
  });

  await suite("wind in the simulation", async () => {
    const frame = makeFrame();
    const terrain = await makeTerrain(() => -2000, 2000);
    const simulation = new Simulation({
      frame,
      terrain,
      missionRadius: 50000,
      // Steady wind from the west, no gusts, so the check is deterministic.
      wind: new WindField({
        seed: "test",
        layers: [{ altitudeAgl: 10, directionDeg: 270, speed: 12 }],
        gustiness: 0,
        variation: 0,
      }),
    });
    simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 1000),
        headingDeg: 0,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );
    for (let i = 0; i < 60 * 20; i += 1) simulation.update(1 / 60);
    const telemetry = simulation.telemetry();
    assert(
      Math.abs(telemetry.groundSpeed - telemetry.airspeed) > 1,
      `crosswind separates ground speed from airspeed (${telemetry.groundSpeed.toFixed(1)} vs ${telemetry.airspeed.toFixed(1)})`,
    );
  });
}
