/**
 * What the simulation costs the CPU, in milliseconds of a frame.
 *
 * Run with `npm run bench:sim [enemies]`. It exists because "optimise the
 * simulation" is not a decision anybody can make without a number: at twenty
 * contacts the whole fixed-step physics, AI and collision pass is a fraction
 * of a millisecond against a 16.7 ms budget, so the frame is spent in the
 * renderer and that is where any work worth doing lives.
 *
 * The collision world is part of that measurement rather than left out of it.
 * It is the one thing here whose cost depends on how close the aircraft are to
 * each other — a pack in a race has every pair in the broad phase at once —
 * and a benchmark that omitted it would answer a question nobody asked. It is
 * stepped at the physics rate, as the engine steps it; a run where Rapier will
 * not initialise says so and measures the rest.
 *
 * The aircraft are also flown twice: once spread around the mission area, once
 * packed into a few hundred metres, because that difference is exactly what a
 * pilot reporting "it slows down when the field bunches up" is describing.
 *
 * Every contact looks for the player through the visibility system, as it does
 * in a flight. That is the one part of thinking that reads the terrain rather
 * than its own state — a sight line is fourteen samples of the height field,
 * and there is one of them per contact per think — so leaving it out would
 * measure the cheap half and report it as the whole.
 *
 * Deliberately not part of `npm run test:sim`: a timing figure varies with the
 * machine, and a test that fails because a laptop is busy is worse than no
 * test at all.
 */
import { Simulation } from "../engine/simulation";
import { CollisionWorld, initRapier } from "../physics/collisionWorld";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE } from "../flight/state";
import { EnuFrame } from "../geo/enuFrame";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import { createFlightInput } from "../input/types";
import { EnemyController } from "../ai/enemyController";
import { DIFFICULTY, DIFFICULTY_PROFILES } from "../ai/types";
import { TerrainAvoidanceSystem } from "../ai/terrainAvoidance";
import { generatePatrolRoute } from "../ai/patrol";
import { VisibilitySystem } from "../environment/visibility";

const FRAMES = 900;
const FRAME_SECONDS = 1 / 60;

/**
 * Flies `enemies` contacts for a while and reports what a frame of it cost.
 *
 * `spacing` is the radius the flight is spread over: a wide ring is traffic
 * scattered across the mission area, a tight one is a race pack.
 */
async function measure(
  enemies: number,
  spacing: number,
  label: string,
): Promise<void> {
  const frame = new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 400 });
  const height = (x: number, y: number) =>
    400 + 30 * Math.sin(x / 900) * Math.cos(y / 1100);
  const probe = async (points: readonly TerrainQuery[]) =>
    points.map((p) => height(p.x, p.y));
  const terrain = new TerrainField(probe, {
    cellSize: 100,
    warmRadius: 1500,
    sampleBudget: 8192,
  });
  await terrain.prefill(V.vec3(), 6000);

  // Detecting a mid-air is the one part of the step whose cost depends on how
  // close the aircraft are, so it is measured rather than assumed.
  let collision: CollisionWorld | null = null;
  try {
    collision = new CollisionWorld(await initRapier());
  } catch (error) {
    console.warn("[bench] Rapier unavailable; measuring without it", error);
  }

  const visibility = new VisibilitySystem(terrain);
  const sim = new Simulation({
    frame,
    terrain,
    collision,
    missionRadius: 10000,
    visibility,
  });
  const avoidance = new TerrainAvoidanceSystem(terrain);
  const input = createFlightInput();
  input.throttle = 0.7;

  sim.spawn(
    { id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
      position: vec3(0, 0, 900), headingDeg: 0, pitchDeg: 0, rollDeg: 0,
      airspeed: 25, throttle: 0.7 },
    () => input,
  );

  for (let i = 0; i < enemies; i += 1) {
    const a = (i / Math.max(enemies, 1)) * Math.PI * 2;
    const state = sim.spawn(
      { id: `e${i}`, role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: vec3(
          Math.cos(a) * spacing,
          Math.sin(a) * spacing,
          900 + i * 12,
        ),
        headingDeg: (i * 37) % 360, pitchDeg: 0, rollDeg: 0,
        airspeed: 24, throttle: 0.6 },
      () => createFlightInput(),
    );
    const pilot = new EnemyController({
      id: state.id,
      difficulty: DIFFICULTY_PROFILES[DIFFICULTY.Normal],
      route: generatePatrolRoute({
        seed: `bench-${i}`, missionRadius: 10000, baseAltitude: 900, terrain,
      }),
      terrainAvoidance: avoidance,
      terrain,
      visibility,
      missionRadius: 10000,
      seed: `bench-${i}`,
      aggressive: true,
      getTarget: () => sim.player,
    });
    sim.setController(state.id, pilot.control);
  }

  for (let i = 0; i < 120; i += 1) sim.update(FRAME_SECONDS);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i += 1) sim.update(FRAME_SECONDS);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(
    `${enemies} enemies ${label}: ${(ms / FRAMES).toFixed(3)} ms/frame  ` +
    `(budget 16.7)  ${((FRAMES * FRAME_SECONDS) / (ms / 1000)).toFixed(0)}x real time`,
  );
  collision?.dispose();
}

async function main(): Promise<void> {
  const enemies = Number(process.argv[2] ?? 20);
  await measure(enemies, 2500, "spread over 2.5 km");
  await measure(enemies, 150, "packed into 150 m");
}

void main();
