import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { PLAYER_WING } from "../flight/config";
import {
  PHYSICS_TIMESTEP,
  levelThrottle,
  maxLevelSpeed,
  stallSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import { AIRCRAFT_ROLE, FLIGHT_STATUS, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import { createFlightInput } from "../input/types";
import type { FlightInput } from "../input/types";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { VisibilitySystem } from "../environment/visibility";
import { WEATHER, WEATHER_PROFILES } from "../environment/types";
import { CollisionWorld, initRapier } from "../physics/collisionWorld";
import {
  AUTOPILOT_GAINS,
  flyTo,
  headingErrorForBank,
  minimumCommandedSpeed,
  turnRateForBank,
} from "../ai/autopilot";
import { interceptPoint, interceptTime } from "../ai/interception";
import { EnemyController } from "../ai/enemyController";
import { TerrainAvoidanceSystem, createAvoidanceCommand } from "../ai/terrainAvoidance";
import { advanceWaypoint, containWithin, generatePatrolRoute, generateSpawnPoints } from "../ai/patrol";
import { AI_STATE, DIFFICULTY, DIFFICULTY_PROFILES } from "../ai/types";
import {
  ENEMY_SPEED_FACTOR_MAX,
  ENEMY_SPEED_FACTOR_MIN,
  FLEE_MAX_SECONDS,
  FLEE_MIN_SECONDS,
} from "../ai/enemyController";
import {
  FORMATION_SLOT,
  FORMATION_SLOTS,
  FormationLeadPilot,
  FormationWingPilot,
  JOIN_UP_SECONDS,
  MANOEUVRE,
  PLAYER_SLOTS,
  buildRoutine,
  formationLeadFor,
  formationStation,
  routineSeconds,
} from "../ai/formation";
import { forwardAxis, toHeadingPitchRoll } from "../math/quat";
import { RAD_TO_DEG, clamp } from "../math/scalar";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 500 };

async function terrainField(
  height: (x: number, y: number) => number,
  radius: number,
  cellSize = 250,
): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map((p) => height(p.x, p.y)),
    { cellSize, warmRadius: 6000, sampleBudget: 60000 },
  );
  await field.prefill(V.vec3(), radius);
  return field;
}

function missionFrame(): EnuFrame {
  return new EnuFrame({ latitude: 46.5375, longitude: 7.9625, height: 2000 });
}

/** Keeps the player straight and level so scenarios stay reproducible. */
function holdLevel(state: AircraftState, altitude: number, throttle: number): FlightInput {
  const angles = toHeadingPitchRoll(state.orientation);
  const climb = clamp((altitude - state.position.z) * 0.15, -6, 6);
  return {
    pitch: clamp((climb - state.velocity.z) * 0.22, -0.8, 0.8),
    roll: clamp(-angles.rollDeg * 0.04, -0.6, 0.6),
    yaw: 0,
    throttle,
  };
}

export async function runAiTests(): Promise<void> {
  suite("autopilot", () => {
    const cases: readonly (readonly [string, V.Vec3])[] = [
      ["straight ahead", V.vec3(0, 2500, 400)],
      ["hard right", V.vec3(2000, 0, 400)],
      ["reversal", V.vec3(0, -2000, 400)],
      ["climb", V.vec3(0, 2500, 750)],
      ["descend", V.vec3(0, 2500, 150)],
    ];

    for (const [label, target] of cases) {
      const state = createAircraftState({
        id: "ai",
        role: AIRCRAFT_ROLE.Enemy,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 400),
        headingDeg: 0,
        airspeed: 24,
        throttle: 0.6,
      });
      const input = createFlightInput();
      const goal = {
        target,
        speed: 25,
        throttle: 0.6,
        maxBank: 55,
        climbBias: 0,
        headingBias: 0,
      };

      let closest = Infinity;
      let slowest = Infinity;
      let stalledSteps = 0;
      let peakBank = 0;
      const steps = Math.round(120 / PHYSICS_TIMESTEP);
      for (let i = 0; i < steps; i += 1) {
        flyTo(state, goal, input);
        stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
        state.altitudeAgl = state.position.z;
        closest = Math.min(closest, V.distance(state.position, target));
        slowest = Math.min(slowest, state.airspeed);
        peakBank = Math.max(peakBank, Math.abs(toHeadingPitchRoll(state.orientation).rollDeg));
        if (state.stalled) stalledSteps += 1;
      }

      assert(closest < 60, `${label}: reaches the waypoint (${closest.toFixed(0)} m)`);
      assert(stalledSteps === 0, `${label}: never stalls getting there`);
      assert(
        slowest > stallSpeed(PLAYER_WING) * 1.2,
        `${label}: keeps a stall margin (${slowest.toFixed(1)} m/s)`,
      );
      assert(peakBank < 62, `${label}: respects the bank limit (${peakBank.toFixed(0)} deg)`);
    }
  });

  await suite("an AI aircraft is flown steadily", async () => {
    // Issue #88: contacts in the strike and interception missions looked as
    // though they were mushing along on the edge of a stall while the airspeed
    // tape said nothing of the sort. Nothing was stalling. The autopilot was
    // oscillating — rocking a wing between full left and full right aileron on
    // a dead-straight leg, and pulling for climbs it had not got the energy
    // for — and the tests below are the ones that would have caught it.

    // --- The loops themselves ---------------------------------------------
    //
    // A cascade is only stable while each loop is slower than the one inside
    // it. Assert the spacing rather than the numbers, so retuning a gain
    // cannot quietly close that gap again.
    const g = AUTOPILOT_GAINS;
    // The bank loop closes a bank error with a time constant of 1/bankToRollRate.
    const bankTime = 1 / g.bankToRollRate;
    assert(
      g.headingTimeConstant > bankTime * 3,
      `the heading loop is well outside the bank loop (${g.headingTimeConstant.toFixed(
        1,
      )} s against ${bankTime.toFixed(2)} s)`,
    );
    assert(
      minimumCommandedSpeed(PLAYER_WING) >
        stallSpeed(PLAYER_WING) * g.stallMargin + g.stallBlendBand * 0.5,
      `and the slowest cruise on offer clears the stall guard's blend band (${minimumCommandedSpeed(
        PLAYER_WING,
      ).toFixed(1)} m/s)`,
    );

    // The coordinated-turn relation and its inverse have to agree, or a
    // formation feeding its turn forward feeds forward the wrong number.
    assertClose(
      headingErrorForBank(30, 20),
      turnRateForBank(30, 20) * g.headingTimeConstant,
      1e-9,
      "the heading loop's inverse matches the loop itself",
    );

    // --- A straight leg is flown straight ---------------------------------
    for (const [label, target] of [
      ["a distant waypoint", V.vec3(0, 9000, 400)],
      ["one off to the side", V.vec3(4000, 8000, 400)],
      ["one to climb to", V.vec3(0, 9000, 700)],
    ] as const) {
      const state = createAircraftState({
        id: "steady", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(0, 0, 400), headingDeg: 0, airspeed: 20, throttle: 0.6,
      });
      const goal = {
        target, speed: 20, throttle: 0.55, maxBank: 55, climbBias: 0, headingBias: 0,
      };
      const input = createFlightInput();

      let rollRateSum = 0;
      let samples = 0;
      let saturated = 0;
      let stalledSteps = 0;
      const steps = Math.round(120 / PHYSICS_TIMESTEP);
      for (let i = 0; i < steps; i += 1) {
        flyTo(state, goal, input);
        stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
        state.altitudeAgl = state.position.z;
        // The first ten seconds are the turn onto the leg, which is allowed to
        // use the ailerons. What is being measured is the rest.
        if (i * PHYSICS_TIMESTEP < 10) continue;
        samples += 1;
        rollRateSum += Math.abs(state.angularVelocity.x * RAD_TO_DEG);
        if (Math.abs(input.roll) > 0.9) saturated += 1;
        if (state.stalled) stalledSteps += 1;
      }

      const meanRollRate = rollRateSum / samples;
      // Before the fix this sat between thirty and a hundred degrees a second,
      // for ever, on a leg with nothing to turn for.
      assert(
        meanRollRate < 6,
        `${label}: settles instead of rocking (${meanRollRate.toFixed(1)} deg/s of roll)`,
      );
      assert(
        saturated === 0,
        `${label}: without reaching for full aileron (${(
          (saturated / samples) * 100
        ).toFixed(0)}% of the time)`,
      );
      assert(stalledSteps === 0, `${label}: and never stalls`);
    }

    // --- A climb it cannot afford is traded, not pulled for ----------------
    //
    // A terrain climb demanded of an aircraft cruising slowly used to be
    // answered with full elevator, a thirty-degree deck angle and an airspeed
    // walking down to the stall guard — which is what an aeroplane that looks
    // like it is stalling at a healthy airspeed actually is.
    {
      const state = createAircraftState({
        id: "energy", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(0, 0, 400), headingDeg: 0, airspeed: 16, throttle: 0.4,
      });
      const goal = {
        target: V.vec3(0, 9000, 400), speed: 16, throttle: 0.35,
        maxBank: 55, climbBias: 8, headingBias: 0,
      };
      const input = createFlightInput();
      let steepest = 0;
      let slowest = Infinity;
      let stalledSteps = 0;
      const steps = Math.round(60 / PHYSICS_TIMESTEP);
      for (let i = 0; i < steps; i += 1) {
        flyTo(state, goal, input);
        stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
        state.altitudeAgl = state.position.z;
        if (i * PHYSICS_TIMESTEP < 1) continue;
        steepest = Math.max(steepest, toHeadingPitchRoll(state.orientation).pitchDeg);
        slowest = Math.min(slowest, state.airspeed);
        if (state.stalled) stalledSteps += 1;
      }
      assert(
        steepest < 25,
        `a climb demand does not become a zoom (${steepest.toFixed(0)} deg of nose-up)`,
      );
      assert(
        slowest > stallSpeed(PLAYER_WING) * AUTOPILOT_GAINS.stallMargin,
        `and the airspeed stays above the guard (${slowest.toFixed(1)} m/s)`,
      );
      assert(stalledSteps === 0, "so the climb never turns into a stall");
      assert(
        state.position.z > 420,
        `while still gaining the height it was asked for (${state.position.z.toFixed(0)} m)`,
      );
    }

    // --- Terrain avoidance picks a side and keeps it -----------------------
    //
    // Two ways round a ridge are usually within a few metres of each other. A
    // system that re-picks the roomier one six times a second picks a
    // different one six times a second, and the aircraft rocks between them
    // instead of going round either.
    {
      // A wall across the flight path, with a gentle lateral ripple on it, so
      // whichever side is roomier keeps changing by a metre or two.
      const walled = await terrainField(
        (x, y) => (y > 700 ? 900 : 300) + 12 * Math.sin(x / 60),
        6000,
        100,
      );
      const system = new TerrainAvoidanceSystem(walled);
      const command = createAvoidanceCommand();
      const state = createAircraftState({
        id: "ridge", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(0, 0, 500), headingDeg: 0, airspeed: 20, throttle: 0.6,
      });

      let sideChanges = 0;
      let previousSide = 0;
      let offsetReversals = 0;
      let previousOffset = 0;
      for (let i = 0; i < 90; i += 1) {
        system.evaluate(state, 140, command);
        if (command.escapeSide !== 0 && command.escapeSide !== previousSide) {
          if (previousSide !== 0) sideChanges += 1;
          previousSide = command.escapeSide;
        }
        if (
          Math.sign(command.headingOffset) !== Math.sign(previousOffset) &&
          Math.abs(command.headingOffset) > 1
        ) {
          offsetReversals += 1;
        }
        previousOffset = command.headingOffset;
        // Six times a second of closing on it, as the pilot would.
        V.addScaled(state.position, state.position, state.velocity, 1 / 6);
      }
      assert(
        sideChanges <= 1,
        `an escape is committed to rather than re-argued (${sideChanges} changes of mind)`,
      );
      assert(
        offsetReversals <= 1,
        `so the turn it hands the autopilot holds its sign (${offsetReversals} reversals)`,
      );
    }
  });

  suite("interception geometry", () => {
    // Head-on: closing speed is the sum, so the time is the range over it.
    const headOn = interceptTime(V.vec3(0, 0, 0), 30, V.vec3(0, 600, 0), V.vec3(0, -20, 0));
    assertClose(headOn ?? -1, 12, 0.01, "head-on interception time");

    // Stern chase: closing speed is the difference.
    const stern = interceptTime(V.vec3(0, 0, 0), 30, V.vec3(0, 300, 0), V.vec3(0, 20, 0));
    assertClose(stern ?? -1, 30, 0.01, "stern chase interception time");

    // A target running faster than the chaser cannot be caught.
    const hopeless = interceptTime(V.vec3(0, 0, 0), 20, V.vec3(0, 300, 0), V.vec3(0, 40, 0));
    assert(hopeless === null, "an outrunning target has no interception solution");

    // Full lead aims ahead of the target; no lead aims at it.
    const target = V.vec3(500, 0, 0);
    const velocity = V.vec3(0, 25, 0);
    const pure = interceptPoint(V.vec3(), 30, target, velocity, 0, 25);
    assertClose(V.distance(pure, target), 0, 1e-9, "zero lead is pure pursuit");
    const led = interceptPoint(V.vec3(), 30, target, velocity, 1, 25);
    assert(led.y > target.y + 100, `full lead aims well ahead (${led.y.toFixed(0)} m)`);
    const half = interceptPoint(V.vec3(), 30, target, velocity, 0.5, 25);
    assertBetween(half.y, 1, led.y - 1, "partial lead sits between the two");

    // The horizon caps how far ahead it will aim.
    const capped = interceptPoint(V.vec3(), 21, V.vec3(4000, 0, 0), V.vec3(0, 20, 0), 1, 5);
    assertBetween(capped.y, 99, 101, "the aim horizon is capped");
  });

  suite("patrol routes", () => {
    const a = generatePatrolRoute({ seed: "M1", missionRadius: 10000, baseAltitude: 800 });
    const b = generatePatrolRoute({ seed: "M1", missionRadius: 10000, baseAltitude: 800 });
    const c = generatePatrolRoute({ seed: "M2", missionRadius: 10000, baseAltitude: 800 });

    assert(a.length >= 5 && a.length <= 7, `route has ${a.length} waypoints`);
    assert(
      a.every((p, i) => V.distance(p, b[i] as V.Vec3) < 1e-9),
      "the same seed regenerates the same route",
    );
    assert(
      a.some((p, i) => V.distance(p, c[i] as V.Vec3) > 1),
      "a different seed gives a different route",
    );
    assert(
      a.every((p) => Math.hypot(p.x, p.y) < 10000),
      "every waypoint stays inside the mission radius",
    );
    assert(
      a.every((p) => Math.hypot(p.x, p.y) > 1000),
      "and none sits on top of the origin",
    );

    // Waypoints are lifted clear of known terrain.
    const highGround = generatePatrolRoute({
      seed: "M1",
      missionRadius: 10000,
      baseAltitude: 100,
      terrain: {
        ready: true,
        cachedCells: 1,
        heightAt: () => 1500,
        hasCoverage: () => true,
        refresh: () => {},
      },
      terrainMargin: 200,
    });
    assert(
      highGround.every((p) => p.z >= 1700),
      "waypoints are lifted above high ground",
    );

    // Waypoint advance.
    const route = [V.vec3(0, 0, 100), V.vec3(1000, 0, 100)];
    assert(advanceWaypoint(route, 0, V.vec3(900, 0, 100), 200) === 0, "far from the waypoint, hold");
    assert(advanceWaypoint(route, 0, V.vec3(50, 0, 100), 200) === 1, "on arrival, advance");
    assert(advanceWaypoint(route, 1, V.vec3(1050, 0, 100), 200) === 0, "and wrap round");

    const outside = containWithin(V.vec3(20000, 0, 500), 10000);
    assertClose(Math.hypot(outside.x, outside.y), 10000, 1e-6, "containment pulls a point back to the boundary");

    // Spawn rings.
    const spawns = generateSpawnPoints({
      seed: "M1",
      count: 8,
      centre: V.vec3(),
      minRange: 900,
      maxRange: 4000,
      baseAltitude: 600,
    });
    assert(spawns.length === 8, "spawns the requested number");
    assert(
      spawns.every((p) => {
        const r = Math.hypot(p.x, p.y);
        return r >= 900 && r <= 4000;
      }),
      "every spawn lands inside the requested ring",
    );
  });

  await suite("terrain avoidance", async () => {
    // A wall rising to 900 m north of y = 1200.
    const ridge = (_x: number, y: number): number => {
      if (y < 1200) return 0;
      if (y > 2200) return 900;
      return ((y - 1200) / 1000) * 900;
    };
    const terrain = await terrainField(ridge, 12000, 200);
    const avoidance = new TerrainAvoidanceSystem(terrain);

    const clear = createAircraftState({
      id: "a", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
      position: V.vec3(0, -3000, 400), headingDeg: 180, airspeed: 25, throttle: 0.6,
    });
    const away = avoidance.evaluate(clear, 100);
    assert(!away.active, "flying away from the ridge needs no action");

    const closing = createAircraftState({
      id: "b", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
      position: V.vec3(0, 1400, 250), headingDeg: 0, airspeed: 25, throttle: 0.6,
    });
    const command = avoidance.evaluate(closing, 100);
    assert(command.active, "flying at the ridge triggers avoidance");
    assert(command.climbDemand > 0, `and demands a climb (${command.climbDemand.toFixed(1)} m/s)`);
    assert(command.clearanceAhead < 300, "reports the clearance it found");

    // Unsampled ground must never look like a mountain.
    const blind = new TerrainAvoidanceSystem(
      new TerrainField(async (pts: readonly TerrainQuery[]) => pts.map(() => null), { cellSize: 200 }),
    );
    assert(!blind.evaluate(closing, 100).active, "unsampled terrain never triggers avoidance");

    // The whole thing, flown: forced across the ridge and expected to survive.
    const sim = new Simulation({
      frame: missionFrame(), terrain, missionRadius: 10000, groundClearance: 1.5,
    });
    const pilot = new EnemyController({
      id: "e", difficulty: DIFFICULTY_PROFILES[DIFFICULTY.Normal],
      route: [V.vec3(0, 6000, 300), V.vec3(0, -3000, 300)],
      terrainAvoidance: avoidance, terrain, visibility: null,
      missionRadius: 10000, seed: "T", aggressive: false, getTarget: () => null,
    });
    const enemy = sim.spawn({
      id: "e", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
      position: V.vec3(0, -500, 220), headingDeg: 0, airspeed: 25, throttle: 0.6,
    }, pilot.control);

    let lowest = Infinity;
    let avoided = false;
    for (let i = 0; i < 60 * 150; i += 1) {
      sim.update(1 / 60);
      if (enemy.status !== FLIGHT_STATUS.Flying) break;
      lowest = Math.min(lowest, enemy.altitudeAgl);
      if (pilot.debug.avoiding) avoided = true;
    }
    assert(enemy.status === FLIGHT_STATUS.Flying, "the enemy survives the ridge crossing");
    assert(avoided, "and used terrain avoidance to do it");
    assert(lowest > 40, `keeping real clearance throughout (${lowest.toFixed(0)} m)`);
  });

  await suite("enemy engagement", async () => {
    const results = new Map<string, { minRange: number; intercepted: boolean; states: Set<string> }>();

    for (const difficultyId of [DIFFICULTY.Easy, DIFFICULTY.Normal, DIFFICULTY.Hard]) {
      const rapier = await initRapier();
      const terrain = await terrainField(() => 0, 26000, 500);
      const visibility = new VisibilitySystem(terrain, {
        weather: WEATHER_PROFILES[WEATHER.Clear],
        daylight: 1,
        layers: [{ baseZ: 4000, topZ: 4600, opacity: 0.12 }],
      });
      const sim = new Simulation({
        frame: missionFrame(), terrain, missionRadius: 20000,
        collision: new CollisionWorld(rapier), contactDamage: true, visibility,
      });

      const player = sim.spawn({
        id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
        position: V.vec3(0, 0, 600), headingDeg: 0, airspeed: 25, throttle: 0.7,
      }, (s) => holdLevel(s, 600, 0.7));

      const pilot = new EnemyController({
        id: "e", difficulty: DIFFICULTY_PROFILES[difficultyId],
        route: generatePatrolRoute({ seed: "E", missionRadius: 20000, baseAltitude: 600, terrain }),
        terrainAvoidance: new TerrainAvoidanceSystem(terrain), terrain, visibility,
        missionRadius: 20000, seed: "E", aggressive: true, getTarget: () => sim.player,
      });
      // Placed ahead of the player and coming the other way, offset enough
      // that arriving is guidance rather than luck.
      //
      // A contact is held to a fraction of the player's top speed, so a stern
      // chase is no longer something it can win — which is the point of the
      // limit, and means the pass it *can* convert is the merge. That is the
      // geometry worth testing: whether the pilot sees the contact, leads it,
      // and arrives.
      const enemy = sim.spawn({
        id: "e", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(250, 5000, 650), headingDeg: 180, airspeed: 24, throttle: 0.6,
      }, pilot.control);

      let minRange = Infinity;
      let intercepted = false;
      const states = new Set<string>();
      const positions: V.Vec3[] = [];
      for (let i = 0; i < 60 * 200 && !intercepted; i += 1) {
        sim.update(1 / 60);
        if (sim.drainContacts().length > 0) intercepted = true;
        states.add(pilot.debug.state);
        if (enemy.status === FLIGHT_STATUS.Flying) {
          minRange = Math.min(minRange, V.distance(player.position, enemy.position));
          if (i % 60 === 0) positions.push({ ...enemy.position });
        }
      }
      results.set(difficultyId, { minRange, intercepted, states });

      // Nothing may teleport: every one-second step has to be a plausible
      // distance for an aircraft flying at these speeds.
      let biggestJump = 0;
      for (let i = 1; i < positions.length; i += 1) {
        biggestJump = Math.max(
          biggestJump,
          V.distance(positions[i] as V.Vec3, positions[i - 1] as V.Vec3),
        );
      }
      assert(
        biggestJump < 60,
        `${difficultyId}: the enemy is flown, never teleported (${biggestJump.toFixed(0)} m/s)`,
      );
    }

    const hard = results.get(DIFFICULTY.Hard)!;
    const normal = results.get(DIFFICULTY.Normal)!;
    const easy = results.get(DIFFICULTY.Easy)!;

    assert(hard.states.has(AI_STATE.Intercept), "hard runs an intercept");
    assert(hard.states.has(AI_STATE.Attack), "and commits to an attack");
    assert(hard.intercepted, "hard destroys a target flying straight and level");

    // Normal presses the merge home without reliably converting it, which is
    // the difficulty gradient doing its job: it leads the shot less well than
    // hard and commits later, and at a merge that is the whole margin. It is
    // still close enough to be a threat rather than scenery.
    assert(normal.states.has(AI_STATE.Attack), "normal commits to the pass too");
    assert(
      normal.minRange < DIFFICULTY_PROFILES[DIFFICULTY.Normal].attackRange,
      `and presses it inside its attack range (${normal.minRange.toFixed(0)} m)`,
    );
    assert(
      normal.minRange > hard.minRange,
      `but arrives less well than hard (${normal.minRange.toFixed(0)} m vs ${hard.minRange.toFixed(0)} m)`,
    );
    assert(
      !easy.intercepted,
      `easy does not (closest ${easy.minRange.toFixed(0)} m)`,
    );
    assert(
      easy.minRange > normal.minRange,
      `and misses by more than normal (${easy.minRange.toFixed(0)} m vs ${normal.minRange.toFixed(0)} m)`,
    );
  });

  suite("formation geometry", () => {
    const lead = createAircraftState({
      id: "lead", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 0, airspeed: 24, throttle: 0.6,
    });

    const astern = formationStation(V.vec3(), lead, FORMATION_SLOTS[FORMATION_SLOT.Astern]);
    assertClose(astern.x, 0, 1e-6, "line astern sits directly behind the leader");
    assertClose(
      astern.y,
      -FORMATION_SLOTS[FORMATION_SLOT.Astern].aft,
      1e-6,
      "one station back along its heading",
    );
    assert(astern.z < lead.position.z, "and stepped down out of the wake");

    const right = formationStation(V.vec3(), lead, FORMATION_SLOTS[FORMATION_SLOT.Right]);
    assert(right.x > 0, "echelon right is to the leader's right, heading north");
    const left = formationStation(V.vec3(), lead, FORMATION_SLOTS[FORMATION_SLOT.Left]);
    assert(left.x < 0, "and echelon left is to its left");
    assertClose(right.x, -left.x, 1e-6, "symmetrically");

    // Turn the leader east: the whole shape has to turn with it.
    const east = createAircraftState({
      id: "east", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 90, airspeed: 24, throttle: 0.6,
    });
    const easternAstern = formationStation(V.vec3(), east, FORMATION_SLOTS[FORMATION_SLOT.Astern]);
    assertClose(
      easternAstern.x,
      -FORMATION_SLOTS[FORMATION_SLOT.Astern].aft,
      1e-4,
      "the slot follows the leader's heading rather than north",
    );
    assertClose(easternAstern.y, 0, 1e-4, "and nothing is left pointing north");

    // Banked: the slot rolls with the leader, and a wide slot moves a long way.
    const banked = createAircraftState({
      id: "banked", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 0, rollDeg: 45,
      airspeed: 24, throttle: 0.6,
    });
    const bankedRight = formationStation(V.vec3(), banked, FORMATION_SLOTS[FORMATION_SLOT.Right]);
    assert(
      bankedRight.z < right.z - 5,
      "banking right drops the right-hand slot with the wing",
    );

    // Inverted: the station must come back level rather than flipping the
    // formation upside down with the leader.
    const inverted = createAircraftState({
      id: "inverted", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 0, rollDeg: 180,
      airspeed: 24, throttle: 0.6,
    });
    const invertedRight = formationStation(
      V.vec3(), inverted, FORMATION_SLOTS[FORMATION_SLOT.Right],
    );
    assert(
      invertedRight.x > 0,
      "an inverted leader does not throw its wingman to the other side",
    );

    // The flight opens with the player already on station, whichever way the
    // start point was set up to face: place the leader from the player's slot
    // and the slot has to come back to the player.
    for (const headingDeg of [0, 45, 90, 200, 315]) {
      for (const slotId of PLAYER_SLOTS) {
        const slot = FORMATION_SLOTS[slotId];
        const station = V.vec3(1200, -800, 620);
        const placed = createAircraftState({
          id: "placed", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
          position: formationLeadFor(V.vec3(), station, headingDeg, slot),
          headingDeg, airspeed: 24, throttle: 0.6,
        });
        const back = formationStation(V.vec3(), placed, slot);
        assertClose(
          V.distance(back, station),
          0,
          1e-6,
          `${slotId} opens on station on ${headingDeg}°`,
        );
      }
    }
  });

  suite("display routines", () => {
    const options = { seed: "TESTSEED", difficulty: DIFFICULTY.Normal, seconds: 300 };
    const a = buildRoutine(options);
    const b = buildRoutine(options);
    const c = buildRoutine({ ...options, seed: "OTHER" });

    assertClose(routineSeconds(a), 300, 1e-6, "a routine is exactly as long as asked");
    assert(
      a.length === b.length && a.every((step, i) => step.type === b[i]?.type),
      "the same seed flies the same display",
    );
    assert(
      a.length !== c.length || a.some((step, i) => step.type !== c[i]?.type),
      "a different seed flies a different one",
    );
    assert(
      a[0]?.type === MANOEUVRE.Cruise && a[0].seconds >= JOIN_UP_SECONDS,
      "every display opens with a straight leg to join up on",
    );
    assert(
      a.every((step, i) => i === 0 || step.type !== a[i - 1]?.type),
      "and never flies the same manoeuvre twice in a row",
    );

    const easy = buildRoutine({ ...options, difficulty: DIFFICULTY.Easy });
    assert(
      easy.every((step) => step.type !== MANOEUVRE.Roll && Math.abs(step.bankDeg) <= 20),
      "an easy leader never rolls and never banks hard",
    );

    const turns = a.filter((step) => step.bankDeg !== 0);
    assert(
      turns.every((step, i) => i === 0 || Math.sign(step.bankDeg) !== Math.sign(turns[i - 1]?.bankDeg ?? 0)),
      "turns alternate direction, so the display stays over the same ground",
    );
  });

  await suite("flying the formation", async () => {
    const terrain = await terrainField(() => 0, 20000, 400);
    const avoidance = new TerrainAvoidanceSystem(terrain);
    const sim = new Simulation({
      frame: missionFrame(),
      terrain,
      missionRadius: 8000,
      groundClearance: 1.5,
      trackedRole: AIRCRAFT_ROLE.Lead,
    });

    // Two turns and a climb, so the wingman has to work rather than trail.
    const routine = [
      { type: MANOEUVRE.Cruise, seconds: 20, bankDeg: 0, climb: 0 },
      { type: MANOEUVRE.Turn, seconds: 40, bankDeg: 34, climb: 0 },
      { type: MANOEUVRE.Climb, seconds: 20, bankDeg: 0, climb: 4 },
      { type: MANOEUVRE.Turn, seconds: 40, bankDeg: -34, climb: 0 },
    ];
    const leadPilot = new FormationLeadPilot({
      id: "lead", routine, terrain, terrainAvoidance: avoidance, missionRadius: 8000,
    });
    const lead = sim.spawn({
      id: "lead", role: AIRCRAFT_ROLE.Lead, config: PLAYER_WING,
      position: V.vec3(0, 0, 500), headingDeg: 0, airspeed: 25, throttle: 0.65,
    }, leadPilot.control);

    const slot = FORMATION_SLOTS[FORMATION_SLOT.Right];
    const wingPilot = new FormationWingPilot({
      id: "wing", slot, terrain, terrainAvoidance: avoidance,
      getLead: () => sim.lead,
    });
    const wing = sim.spawn({
      id: "wing", role: AIRCRAFT_ROLE.Wingman, config: PLAYER_WING,
      position: formationStation(V.vec3(), lead, slot),
      headingDeg: 0, airspeed: 25, throttle: 0.65,
    }, wingPilot.control);

    assert(sim.lead?.id === "lead", "the simulation knows which aircraft is the leader");

    const station = V.vec3();
    let worst = 0;
    let sum = 0;
    let samples = 0;
    let turned = false;
    for (let i = 0; i < 60 * 120; i += 1) {
      sim.update(1 / 60);
      if (lead.status !== FLIGHT_STATUS.Flying || wing.status !== FLIGHT_STATUS.Flying) {
        break;
      }
      if (Math.abs(toHeadingPitchRoll(lead.orientation).rollDeg) > 20) turned = true;
      // Ignore the first few seconds: everything is settling out of the spawn.
      if (i > 60 * 5) {
        formationStation(station, lead, slot);
        const error = V.distance(wing.position, station);
        worst = Math.max(worst, error);
        sum += error;
        samples += 1;
      }
    }

    assert(lead.status === FLIGHT_STATUS.Flying, "the leader flies the whole display");
    assert(wing.status === FLIGHT_STATUS.Flying, "and the wingman stays with it");
    assert(turned, "the display actually included a banked turn");
    assertBetween(sum / samples, 0, 30, "the wingman holds station on average");
    assert(worst < 90, `never losing the slot badly (worst ${worst.toFixed(0)} m)`);
    assert(
      Math.hypot(lead.position.x, lead.position.y) < 8000,
      "and the whole display stays inside the mission area",
    );
  });

  await suite("power management", async () => {
    const terrain = await terrainField(() => 0, 12000, 500);

    const cruisePilot = (seed: string, getTarget: () => AircraftState | null) =>
      new EnemyController({
        id: "e", difficulty: DIFFICULTY_PROFILES[DIFFICULTY.Normal],
        route: generatePatrolRoute({ seed, missionRadius: 8000, baseAltitude: 600, terrain }),
        terrainAvoidance: new TerrainAvoidanceSystem(terrain), terrain, visibility: null,
        missionRadius: 8000, seed, aggressive: true, getTarget,
      });

    const enemyWing = (seed: string) => createAircraftState({
      id: `e-${seed}`, role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
      position: V.vec3(0, 0, 600), headingDeg: 0, airspeed: 24, throttle: 0.6,
    });

    // Nothing in sight: the pilot has no reason to hurry, and does not.
    const pilot = cruisePilot("cruise", () => null);
    const enemy = enemyWing("cruise");
    let throttleSum = 0;
    let speedSum = 0;
    let samples = 0;
    let peakThrottle = 0;
    const steps = Math.round(120 / PHYSICS_TIMESTEP);
    for (let i = 0; i < steps; i += 1) {
      stepFlightDynamics(enemy, pilot.control(enemy, PHYSICS_TIMESTEP), CALM, PHYSICS_TIMESTEP);
      enemy.altitudeAgl = enemy.position.z;
      if (i > steps / 2) {
        throttleSum += enemy.throttleCommand;
        speedSum += enemy.airspeed;
        samples += 1;
        peakThrottle = Math.max(peakThrottle, enemy.throttleCommand);
      }
    }
    const cruiseThrottle = throttleSum / samples;
    const cruiseSpeed = speedSum / samples;

    // The same airframe, flown flat out, for comparison.
    const chaser = createAircraftState({
      id: "p", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
      position: V.vec3(0, 0, 600), headingDeg: 0, airspeed: 24, throttle: 0.6,
    });
    for (let i = 0; i < steps; i += 1) {
      stepFlightDynamics(chaser, holdLevel(chaser, 600, 1), CALM, PHYSICS_TIMESTEP);
      chaser.altitudeAgl = chaser.position.z;
    }

    // Part power, and now well under it: a contact is held to a fraction of the
    // player's top speed, and the throttle that holds a speed that low is a
    // small one.
    assertBetween(cruiseThrottle, 0.1, 0.65, `an unbothered contact cruises at part power (${cruiseThrottle.toFixed(2)})`);
    assert(peakThrottle < 0.8, `and never opens up (peak ${peakThrottle.toFixed(2)})`);
    assert(
      chaser.airspeed - cruiseSpeed > 3,
      `so a player at full power closes on it (${(chaser.airspeed - cruiseSpeed).toFixed(1)} m/s)`,
    );

    // No two pilots fly the same number, and none of them holds one.
    const seeds = ["a", "b", "c", "d", "e", "f"];
    const cruises = seeds.map((seed) => cruisePilot(seed, () => null).debug.cruiseThrottle);
    assert(
      new Set(cruises.map((t) => t.toFixed(3))).size === seeds.length,
      "six pilots cruise on six different throttles",
    );
    assertBetween(Math.min(...cruises), 0.45, 0.75, `and all of them near cruise (lowest ${Math.min(...cruises).toFixed(2)})`);
    assertBetween(Math.max(...cruises), 0.45, 0.75, `(highest ${Math.max(...cruises).toFixed(2)})`);

    const drifter = cruisePilot("drift", () => null);
    const drifting = enemyWing("drift");
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < Math.round(300 / PHYSICS_TIMESTEP); i += 1) {
      stepFlightDynamics(drifting, drifter.control(drifting, PHYSICS_TIMESTEP), CALM, PHYSICS_TIMESTEP);
      drifting.altitudeAgl = drifting.position.z;
      lowest = Math.min(lowest, drifter.debug.cruiseThrottle);
      highest = Math.max(highest, drifter.debug.cruiseThrottle);
    }
    assert(highest - lowest > 0.01, `a pilot's cruise wanders rather than sitting on one number (${(highest - lowest).toFixed(3)})`);
  });

  await suite("contact speed limits", async () => {
    const terrain = await terrainField(() => 0, 12000, 500);
    const topSpeed = maxLevelSpeed(PLAYER_WING);

    // The airframe's own top level speed has to agree with the airframe, or
    // every limit derived from it is a limit on the wrong number.
    assertBetween(topSpeed, 25, 29, `the wing tops out near 27 m/s (${topSpeed.toFixed(1)})`);
    assertClose(
      levelThrottle(PLAYER_WING, topSpeed),
      1,
      0.02,
      "and needs all of the throttle to hold it",
    );
    assert(
      levelThrottle(PLAYER_WING, topSpeed * 0.7) < 0.5,
      "while seven tenths of it is flown on well under half",
    );

    const limitedPilot = (seed: string, getTarget: () => AircraftState | null) =>
      new EnemyController({
        id: "e", difficulty: DIFFICULTY_PROFILES[DIFFICULTY.Normal],
        route: generatePatrolRoute({ seed, missionRadius: 8000, baseAltitude: 600, terrain }),
        terrainAvoidance: new TerrainAvoidanceSystem(terrain), terrain, visibility: null,
        missionRadius: 8000, seed, aggressive: true, getTarget,
        speedReference: topSpeed,
      });

    // Every pilot draws its own limit, and none of them draws the player's.
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const limits = seeds.map((seed) => {
      const pilot = limitedPilot(seed, () => null);
      const wing = createAircraftState({
        id: `l-${seed}`, role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(0, 0, 600), headingDeg: 0, airspeed: 24, throttle: 0.6,
      });
      pilot.control(wing, PHYSICS_TIMESTEP);
      return pilot.debug.speedLimit;
    });
    assert(
      new Set(limits.map((s) => s.toFixed(3))).size === seeds.length,
      "eight pilots are held to eight different speeds",
    );
    assert(
      Math.max(...limits) <= topSpeed * ENEMY_SPEED_FACTOR_MAX + 1e-6,
      `none of them above ${ENEMY_SPEED_FACTOR_MAX} of the player's top speed (${Math.max(...limits).toFixed(1)} m/s)`,
    );
    // The slowest factors sit below anything the wing can be manoeuvred at, so
    // the bottom of the range is floored by the airframe rather than flown.
    assert(
      Math.min(...limits) > stallSpeed(PLAYER_WING) * 1.3,
      `and none of them below a speed the wing can turn at (${Math.min(...limits).toFixed(1)} m/s)`,
    );
    assert(
      Math.min(...limits) < topSpeed * 0.62,
      `while the slowest is well under the player (${Math.min(...limits).toFixed(1)} m/s)`,
    );

    // The one that matters: a contact running from the player, flown out, must
    // not be able to hold the player's speed.
    const runner = limitedPilot("runner", () => chaser);
    const enemy = createAircraftState({
      id: "runner", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
      position: V.vec3(0, 600, 600), headingDeg: 0, airspeed: 24, throttle: 0.6,
    });
    const chaser = createAircraftState({
      id: "p", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
      position: V.vec3(0, 0, 600), headingDeg: 0, airspeed: 24, throttle: 0.6,
    });

    // Measured only while the contact is chasing or running, which is what the
    // limit governs. The ramming pass is deliberately exempt: it happens
    // inside a few hundred metres and cannot win anyone a chase.
    let peakChasingSpeed = 0;
    let chasingSpeedSum = 0;
    let chasingSamples = 0;
    let peakSpeed = 0;
    const steps = Math.round(150 / PHYSICS_TIMESTEP);
    for (let i = 0; i < steps; i += 1) {
      stepFlightDynamics(enemy, runner.control(enemy, PHYSICS_TIMESTEP), CALM, PHYSICS_TIMESTEP);
      enemy.altitudeAgl = enemy.position.z;
      // The player runs it down in a straight line at full power.
      stepFlightDynamics(chaser, holdLevel(chaser, 600, 1), CALM, PHYSICS_TIMESTEP);
      chaser.altitudeAgl = chaser.position.z;
      if (i > steps / 3) {
        peakSpeed = Math.max(peakSpeed, enemy.airspeed);
        if (runner.currentState !== AI_STATE.Attack) {
          peakChasingSpeed = Math.max(peakChasingSpeed, enemy.airspeed);
          chasingSpeedSum += enemy.airspeed;
          chasingSamples += 1;
        }
      }
    }

    assert(
      enemy.status === FLIGHT_STATUS.Flying,
      "a speed-limited contact still flies rather than mushing into the ground",
    );
    // The limit is on the speed the pilot flies, not on what gravity hands it:
    // a contact diving away trades height for speed exactly as the player's
    // wing does, and no throttle setting caps that. What it cannot do is *hold*
    // the speed, which is what a chase is decided by.
    const chasingSpeed = chasingSpeedSum / Math.max(chasingSamples, 1);
    assert(
      chasingSpeed <= runner.debug.speedLimit + 1,
      `and holds its own limit through a chase (${chasingSpeed.toFixed(1)} m/s against a limit of ${runner.debug.speedLimit.toFixed(1)})`,
    );
    assert(
      peakChasingSpeed < topSpeed,
      `never reaching the player's top speed even in a dive (${peakChasingSpeed.toFixed(1)} m/s vs ${topSpeed.toFixed(1)})`,
    );
    assert(
      peakSpeed < topSpeed,
      `nor on the pass itself (${peakSpeed.toFixed(1)} m/s)`,
    );
    assert(
      chaser.airspeed - chasingSpeed > 3,
      `so the player closes from behind (${(chaser.airspeed - chasingSpeed).toFixed(1)} m/s in hand)`,
    );
    assert(
      ENEMY_SPEED_FACTOR_MIN < ENEMY_SPEED_FACTOR_MAX && ENEMY_SPEED_FACTOR_MAX <= 0.8,
      "the limit band is the one the mission was tuned for",
    );
  });

  await suite("breaking off", async () => {
    const terrain = await terrainField(() => 0, 16000, 500);

    /** What one pressed contact decided to do about it. */
    interface Run {
      readonly fled: boolean;
      /** Seconds the pilot gave itself to break contact. */
      readonly duration: number;
      /** Seconds into the approach before it broke. */
      readonly brokeAt: number;
      /** Where the contact was, relative to the nose, when it broke. */
      readonly aspectAtBreak: number;
      readonly rangeAtBreak: number;
      readonly rangeAtRejoin: number;
      readonly stillFleeing: boolean;
    }

    /**
     * Presses a contact onto the enemy, from in front or from behind.
     *
     * The contact is flown kinematically rather than through the flight model:
     * what is being tested is what the pilot decides, not how well a player
     * flies an attack.
     */
    const press = (seed: string, astern: boolean): Run => {
      const pilot = new EnemyController({
        id: "e", difficulty: DIFFICULTY_PROFILES[DIFFICULTY.Easy],
        route: generatePatrolRoute({ seed, missionRadius: 12000, baseAltitude: 600, terrain }),
        terrainAvoidance: new TerrainAvoidanceSystem(terrain), terrain, visibility: null,
        missionRadius: 12000, seed, aggressive: true, getTarget: () => player,
      });
      const enemy = createAircraftState({
        id: "e", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(0, 0, 600), headingDeg: 0, airspeed: 24, throttle: 0.6,
      });
      // Astern: 900 m behind it, where it is not looking. Head-on: 2 km out in
      // front. Either way the contact flies straight at it.
      const player = createAircraftState({
        id: "p", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
        position: astern ? V.vec3(0, -900, 600) : V.vec3(0, 2000, 600),
        headingDeg: 0, airspeed: 26, throttle: 1,
      });

      const bearing = V.vec3();
      const forward = V.vec3();
      let fled = false;
      let duration = 0;
      let brokeAt = 0;
      let aspectAtBreak = 0;
      let rangeAtBreak = 0;
      let rangeAtRejoin = 0;
      let wasFleeing = false;

      const steps = Math.round(180 / PHYSICS_TIMESTEP);
      for (let i = 0; i < steps; i += 1) {
        V.subtract(bearing, enemy.position, player.position);
        V.normalize(bearing, bearing);
        V.scale(player.velocity, bearing, 26);
        V.addScaled(player.position, player.position, player.velocity, PHYSICS_TIMESTEP);

        stepFlightDynamics(enemy, pilot.control(enemy, PHYSICS_TIMESTEP), CALM, PHYSICS_TIMESTEP);
        enemy.altitudeAgl = enemy.position.z;

        const fleeing = pilot.debug.state === AI_STATE.Flee;
        if (fleeing && !wasFleeing) {
          fled = true;
          duration = pilot.debug.fleeRemaining;
          brokeAt = i * PHYSICS_TIMESTEP;
          rangeAtBreak = V.distance(player.position, enemy.position);
          V.subtract(bearing, player.position, enemy.position);
          V.normalize(bearing, bearing);
          forwardAxis(forward, enemy.orientation);
          aspectAtBreak = V.dot(bearing, forward);
        }
        if (!fleeing && wasFleeing && rangeAtRejoin === 0) {
          rangeAtRejoin = V.distance(player.position, enemy.position);
        }
        wasFleeing = fleeing;
      }

      return {
        fled, duration, brokeAt, aspectAtBreak, rangeAtBreak, rangeAtRejoin,
        stillFleeing: wasFleeing,
      };
    };

    const seeds = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"];
    const headOn = seeds.map((seed) => press(seed, false));
    const astern = seeds.map((seed) => press(seed, true));
    const ran = headOn.filter((r) => r.fled);

    assert(ran.length > 0, `pressed head-on, some contacts run (${ran.length} of ${seeds.length})`);
    assert(
      ran.length < seeds.length,
      `and some turn and fight (${seeds.length - ran.length} of ${seeds.length})`,
    );
    for (const run of ran) {
      assertBetween(
        run.duration, FLEE_MIN_SECONDS, FLEE_MAX_SECONDS,
        `a run lasts between half a minute and a minute and a half (${run.duration.toFixed(0)} s)`,
      );
    }

    // A head-on merge closes at fifty metres a second. Turning and running
    // turns that into a stern chase, which is the whole point of running — but
    // a contact is held to a fraction of the speed of the aircraft chasing it,
    // so the chase is one the player wins rather than one that never ends.
    // Running buys time, and time is all it buys.
    const closure = ran.map((r) => (r.rangeAtBreak - r.rangeAtRejoin) / r.duration);
    assert(
      closure.every((rate) => rate < 20),
      `running turns a merge into a long stern chase (worst closure ${Math.max(...closure).toFixed(1)} m/s against roughly 50 at a merge)`,
    );
    assert(
      closure.every((rate) => rate > 0),
      `and the player gains on it throughout (slowest ${Math.min(...closure).toFixed(1)} m/s)`,
    );
    assert(
      ran.every((r) => r.rangeAtRejoin > DIFFICULTY_PROFILES[DIFFICULTY.Easy].attackRange),
      "and keeps it out of interception range for as long as it lasts",
    );
    assert(
      headOn.every((r) => !r.stillFleeing),
      "every runner is back to normal operations by the end",
    );
    assert(
      [...headOn, ...astern].every((r) => !r.fled || r.aspectAtBreak > 0),
      "nothing ever runs from a contact it has not seen coming",
    );

    // Which is why a stern approach is worth flying: the pilot has to turn
    // around and look at you before it can decide to run from you.
    const sternBreaks = astern.filter((r) => r.fled).map((r) => r.brokeAt);
    const frontalBreaks = ran.map((r) => r.brokeAt);
    assert(
      sternBreaks.length > 0 && Math.min(...sternBreaks) > Math.max(...frontalBreaks),
      `a stern approach takes longer to provoke a break (${Math.min(...sternBreaks).toFixed(0)} s against ${Math.max(...frontalBreaks).toFixed(0)} s)`,
    );
  });

  await suite("detection limits", async () => {
    const terrain = await terrainField(() => 0, 26000, 500);
    const build = (weather: typeof WEATHER.Clear | typeof WEATHER.Fog, aggressive = true) => {
      const visibility = new VisibilitySystem(terrain, {
        weather: WEATHER_PROFILES[weather],
        daylight: 1,
        layers: [{ baseZ: 4000, topZ: 4600, opacity: 0.12 }],
      });
      const sim = new Simulation({
        frame: missionFrame(), terrain, missionRadius: 20000, visibility,
      });
      sim.spawn({
        id: "player", role: AIRCRAFT_ROLE.Player, config: PLAYER_WING,
        position: V.vec3(0, 0, 600), headingDeg: 0, airspeed: 25, throttle: 0.7,
      }, (s) => holdLevel(s, 600, 0.7));
      const pilot = new EnemyController({
        id: "e", difficulty: DIFFICULTY_PROFILES[DIFFICULTY.Normal],
        route: generatePatrolRoute({ seed: "D", missionRadius: 20000, baseAltitude: 600, terrain }),
        terrainAvoidance: new TerrainAvoidanceSystem(terrain), terrain, visibility,
        missionRadius: 20000, seed: "D", aggressive, getTarget: () => sim.player,
      });
      sim.spawn({
        id: "e", role: AIRCRAFT_ROLE.Enemy, config: PLAYER_WING,
        position: V.vec3(2600, 2600, 650), headingDeg: 200, airspeed: 24, throttle: 0.6,
      }, pilot.control);
      return { sim, pilot };
    };

    const clear = build(WEATHER.Clear);
    const foggy = build(WEATHER.Fog);
    for (let i = 0; i < 60 * 90; i += 1) {
      clear.sim.update(1 / 60);
      foggy.sim.update(1 / 60);
    }
    assert(
      clear.pilot.debug.confidence > 0.5,
      `in clear air the enemy finds the player (confidence ${clear.pilot.debug.confidence.toFixed(2)})`,
    );
    assert(
      foggy.pilot.debug.confidence < 0.05,
      `in fog it never does (confidence ${foggy.pilot.debug.confidence.toFixed(2)})`,
    );
    assert(
      foggy.pilot.debug.state === AI_STATE.Patrol,
      "and stays on patrol rather than magically knowing where you are",
    );

    // Combat off: it sees you, and still will not commit.
    const peaceful = build(WEATHER.Clear, false);
    for (let i = 0; i < 60 * 120; i += 1) peaceful.sim.update(1 / 60);
    assert(
      peaceful.pilot.debug.confidence > 0.3,
      "with combat off the enemy still notices you",
    );
    assert(
      peaceful.pilot.debug.state === AI_STATE.Patrol ||
        peaceful.pilot.debug.state === AI_STATE.Search,
      `but never attacks (state ${peaceful.pilot.debug.state})`,
    );
  });
}
