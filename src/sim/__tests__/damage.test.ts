import { assert, assertBetween, assertClose, suite } from "./harness";
import { PLAYER_WING } from "../flight/config";
import {
  DAMAGE_MODEL,
  DAMAGE_OUTCOME,
  IMPACT_SECTOR,
  INTERCEPT_WARHEAD,
  applyDamage,
  applyImpactMotion,
  createDamage,
  createImpact,
  detonatingWarhead,
  impactSeverity,
  isCrippled,
  isDamaged,
  resolveImpact,
} from "../flight/damage";
import type { DamageModel, Warhead } from "../flight/damage";
import { PHYSICS_TIMESTEP, stepFlightDynamics } from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import {
  AIRCRAFT_ROLE,
  FLIGHT_STATUS,
  createAircraftState,
} from "../flight/state";
import type { AircraftState } from "../flight/state";
import type { FlightInput } from "../input/types";
import { EnuFrame } from "../geo/enuFrame";
import { LOCATION_PRESETS } from "../geo/locations";
import { Simulation } from "../engine/simulation";
import type { BlastReport, CrashReport } from "../engine/simulation";
import { BLAST_KIND } from "../render/explosionField";
import { CollisionWorld, initRapier } from "../physics/collisionWorld";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { toHeadingPitchRoll } from "../math/quat";
import * as V from "../math/vec3";

const preset = LOCATION_PRESETS[0]!;
const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 500 };
const level: FlightInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.65 };

function makeFrame(): EnuFrame {
  return new EnuFrame({
    latitude: preset.latitude,
    longitude: preset.longitude,
    height: 2400,
  });
}

async function makeTerrain(height: number, radius = 4000): Promise<TerrainField> {
  const probe = async (points: readonly TerrainQuery[]) => points.map(() => height);
  const field = new TerrainField(probe, {
    cellSize: 100,
    warmRadius: 1200,
    fallbackHeight: height,
  });
  await field.prefill(V.vec3(), radius);
  return field;
}

/**
 * An aircraft placed and pointed by hand.
 *
 * The damage model reads position, velocity and attitude and nothing else, so
 * a contact can be posed exactly rather than flown into.
 */
function place(
  id: string,
  position: V.Vec3,
  velocity: V.Vec3,
  headingDeg = 0,
): AircraftState {
  const state = createAircraftState({
    id,
    role: AIRCRAFT_ROLE.Player,
    config: PLAYER_WING,
    position,
    headingDeg,
    airspeed: 0,
    throttle: 0,
  });
  V.copy(state.velocity, velocity);
  return state;
}

export function runDamageTests(): void {
  suite("a contact is read from the airframe it happened to", () => {
    const impact = createImpact();

    // Both aircraft head north; the other one is directly ahead.
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 30, 0));
    const ahead = place("b", V.vec3(0, 3, 500), V.vec3(0, 10, 0));
    resolveImpact(impact, self, ahead);
    assert(impact.sector === IMPACT_SECTOR.Nose, "catching one up is a nose hit");
    assertClose(impact.normalSpeed, 20, 0.01, "closing at the speed difference");
    assertClose(impact.directness, 1, 0.01, "and squarely, down the line of centres");

    // The same contact from the other aircraft's point of view.
    resolveImpact(impact, ahead, self);
    assert(
      impact.sector === IMPACT_SECTOR.Tail,
      "and being caught up is a hit from behind",
    );
    assertClose(
      impact.normalSpeed,
      20,
      0.01,
      "with the same speed arriving, whoever was doing the catching",
    );

    // Abeam: same course, same speed, one aircraft to the other's right.
    const abeam = place("c", V.vec3(3, 0, 500), V.vec3(0, 30, 0));
    resolveImpact(impact, self, abeam);
    assert(impact.sector === IMPACT_SECTOR.Wing, "a hit out on the panel is a wing hit");
    assertClose(impact.normalSpeed, 0, 0.01, "and rubbing along costs nothing");

    // Underneath.
    const below = place("d", V.vec3(0, 0, 497), V.vec3(0, 30, 6));
    resolveImpact(impact, self, below);
    assert(impact.sector === IMPACT_SECTOR.Body, "coming up underneath is a body hit");
    assertClose(impact.normalSpeed, 6, 0.01, "at the rate it is coming up");
  });

  suite("severity is the speed that arrives, not the speed on the clock", () => {
    const impact = createImpact();
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 30, 0));

    // A crossing pass: fast relative to each other, barely aimed at anything.
    const crossing = place("b", V.vec3(0.4, 3, 500), V.vec3(0, -30, 0), 180);
    resolveImpact(impact, self, crossing);
    const headOn = impactSeverity(impact);
    assert(headOn >= 0.99, "meeting head-on at cruise writes the airframe off");

    // A pass down the other side at the same speed, with just enough drift
    // across to touch: all of that speed is going past, not into anything.
    const across = place("c", V.vec3(3, 0, 500), V.vec3(-8, -28, 0), 180);
    resolveImpact(impact, self, across);
    assert(
      impact.closingSpeed > 55,
      `the crossing pass is just as fast (${impact.closingSpeed.toFixed(0)} m/s)`,
    );
    assert(
      impact.directness < 0.2,
      `but almost none of it is aimed at the airframe (${impact.directness.toFixed(2)})`,
    );
    assertBetween(
      impactSeverity(impact),
      0.001,
      0.15,
      "so a glance off the panel is survivable",
    );

    // Slow, but squarely.
    const slow = place("d", V.vec3(0, 3, 500), V.vec3(0, 12, 0));
    resolveImpact(impact, self, slow);
    assertBetween(
      impactSeverity(impact),
      0.1,
      0.6,
      "while a slow square hit costs real structure",
    );

    // Below the scratch speed nothing lasting happens at all.
    const nudge = place("e", V.vec3(0, 3, 500), V.vec3(0, 28, 0));
    resolveImpact(impact, self, nudge);
    assert(impactSeverity(impact) === 0, "a nudge at taxi speed is only paint");
  });

  suite("damage is cumulative", () => {
    const damage = createDamage();
    const impact = createImpact();
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 30, 0));
    const ahead = place("b", V.vec3(0, 3, 500), V.vec3(0, 14, 0));
    resolveImpact(impact, self, ahead);
    const severity = impactSeverity(impact);

    assert(!isDamaged(damage), "a fresh airframe is unmarked");
    const first = applyDamage(damage, impact, severity);
    assert(first === DAMAGE_OUTCOME.Damaged, "one hit is survivable");
    assert(isDamaged(damage), "but it leaves a mark");
    assert(!isCrippled(damage), "and the aircraft is still an aircraft");

    let outcome = first;
    let hits = 1;
    while (outcome === DAMAGE_OUTCOME.Damaged && hits < 20) {
      outcome = applyDamage(damage, impact, severity);
      hits += 1;
    }
    assert(
      outcome === DAMAGE_OUTCOME.Disabled,
      `taking the same hit repeatedly eventually stops the aircraft flying (${hits} hits)`,
    );
    assert(isCrippled(damage), "and the airframe reads as crippled");
    assertBetween(hits, 2, 8, "which takes a handful of hits, not dozens");
  });

  suite("a contact carries more of itself into the structure than it used to", () => {
    // The model as it stood, which is the same curve measured against a wider
    // speed band. Everything below is the ratio between the two, because that
    // is what was actually asked for: the same shape, a good third harder.
    const forgiving: DamageModel = { ...DAMAGE_MODEL, writeOffSpeed: 30 };
    const impact = createImpact();
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 26, 0));

    // Every closing rate that does anything at all, from just past the scratch
    // speed up to the one that writes the airframe off on its own.
    for (let speed = 4; speed <= DAMAGE_MODEL.writeOffSpeed; speed += 1) {
      const other = place("b", V.vec3(0, 3, 500), V.vec3(0, 26 - speed, 0));
      resolveImpact(impact, self, other);
      const before = impactSeverity(impact, forgiving);
      const after = impactSeverity(impact);
      assertBetween(
        after / before,
        1.3,
        1.5,
        `${speed} m/s costs a third again what it did (${before.toFixed(3)} -> ${after.toFixed(3)})`,
      );
    }
  });

  suite("bumping a wingman adds up inside a formation flight", () => {
    // Drifting off station and touching the aircraft next to you: abeam, so it
    // lands on a panel, and at the rate a pilot closes a gap rather than the
    // rate they fly a pass.
    const impact = createImpact();
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 26, 0));
    const wingman = place("b", V.vec3(3, 0, 500), V.vec3(-12, 26, 0));
    resolveImpact(impact, self, wingman);
    assert(impact.sector === IMPACT_SECTOR.Wing, "taken out on the panel");
    assertClose(impact.normalSpeed, 12, 0.01, "at the rate it came across");

    const severity = impactSeverity(impact);
    const damage = createDamage();
    let hits = 0;
    while (!isCrippled(damage) && hits < 40) {
      applyDamage(damage, impact, severity);
      hits += 1;
    }
    assertBetween(
      hits,
      4,
      8,
      `a formation flight's worth of knocks stops the aircraft flying (${hits} hits)`,
    );
  });

  suite("where the aircraft is hit decides what it loses", () => {
    const impact = createImpact();
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 30, 0));

    // Taken on the left wing: body y is left.
    const wing = createDamage();
    const onTheLeft = place("b", V.vec3(-3, 0, 500), V.vec3(12, 30, 0));
    resolveImpact(impact, self, onTheLeft);
    assert(impact.sector === IMPACT_SECTOR.Wing, "posed as a wing strike");
    applyDamage(wing, impact, 0.4);
    assert(wing.rollAuthority < 0.75, "a wing strike costs the roll");
    assert(wing.liftFactor < 1, "and some of the lift");
    assert(wing.rollBias < 0, "and the damaged left wing drops on its own");

    // The mirror image rolls the other way.
    const mirrored = createDamage();
    const onTheRight = place("c", V.vec3(3, 0, 500), V.vec3(-12, 30, 0));
    resolveImpact(impact, self, onTheRight);
    applyDamage(mirrored, impact, 0.4);
    assert(mirrored.rollBias > 0, "and a right wing strike drops the right one");

    // Taken from behind, where a pusher keeps its motor.
    const tail = createDamage();
    const behind = place("d", V.vec3(0, -3, 500), V.vec3(0, 45, 0));
    resolveImpact(impact, self, behind);
    assert(impact.sector === IMPACT_SECTOR.Tail, "posed as a hit from behind");
    applyDamage(tail, impact, 0.4);
    assert(tail.thrustFactor < 0.6, "which takes the propeller with it");
    assert(tail.pitchAuthority < 0.8, "and most of the pitch");
    assert(tail.rollAuthority === 1, "but leaves the wing panels alone");
  });

  suite("a damaged airframe flies worse", () => {
    const healthy = place("healthy", V.vec3(0, 0, 500), V.vec3(0, 24, 0));
    const hurt = place("hurt", V.vec3(0, 0, 500), V.vec3(0, 24, 0));
    hurt.damage.liftFactor = 0.6;
    hurt.damage.dragFactor = 2;

    const cruise: FlightInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6 };
    for (let i = 0; i < 240 * 4; i += 1) {
      stepFlightDynamics(healthy, cruise, CALM, PHYSICS_TIMESTEP);
      stepFlightDynamics(hurt, cruise, CALM, PHYSICS_TIMESTEP);
    }
    assert(
      hurt.position.z < healthy.position.z - 2,
      `a torn wing sinks (${(healthy.position.z - hurt.position.z).toFixed(1)} m lower)`,
    );
    assert(hurt.airspeed < healthy.airspeed, "and drags");

    // Half an elevon answers half as far.
    const full = place("full", V.vec3(0, 0, 500), V.vec3(0, 26, 0));
    const half = place("half", V.vec3(0, 0, 500), V.vec3(0, 26, 0));
    half.damage.rollAuthority = 0.4;
    const rollRight: FlightInput = { pitch: 0, roll: 1, yaw: 0, throttle: 0.6 };
    for (let i = 0; i < 60; i += 1) {
      stepFlightDynamics(full, rollRight, CALM, PHYSICS_TIMESTEP);
      stepFlightDynamics(half, rollRight, CALM, PHYSICS_TIMESTEP);
    }
    // Compared as a rate rather than as an angle: a healthy wing is already
    // most of the way round by the time the damaged one has started.
    assert(
      half.angularVelocity.x < full.angularVelocity.x * 0.6,
      `a damaged elevon rolls the aircraft more slowly (${half.angularVelocity.x.toFixed(2)} vs ${full.angularVelocity.x.toFixed(2)} rad/s)`,
    );

    // And an asymmetric airframe rolls with the stick centred.
    const lopsided = place("lopsided", V.vec3(0, 0, 500), V.vec3(0, 26, 0));
    lopsided.damage.rollBias = -0.05;
    for (let i = 0; i < 240 * 2; i += 1) {
      stepFlightDynamics(lopsided, cruise, CALM, PHYSICS_TIMESTEP);
    }
    assert(
      toHeadingPitchRoll(lopsided.orientation).rollDeg < -10,
      "a torn left panel drops the wing with the stick centred",
    );
  });

  suite("an impact throws both aircraft about", () => {
    const impact = createImpact();
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 34, 0));
    const ahead = place("b", V.vec3(0, 3, 500), V.vec3(0, 14, 0));
    resolveImpact(impact, self, ahead);

    const before = self.velocity.y;
    applyImpactMotion(self, impact, impactSeverity(impact));
    assert(
      self.velocity.y < before,
      "the aircraft that ran into the other one is slowed by it",
    );
    assertBetween(
      before - self.velocity.y,
      8,
      16,
      "by roughly half the closing speed, as two equal masses must share it",
    );

    // Off the centreline, the same blow starts the aircraft tumbling.
    const clipped = place("c", V.vec3(0, 0, 500), V.vec3(0, 34, 0));
    const tip = place("d", V.vec3(2.9, 0.6, 500), V.vec3(-6, 34, 0));
    resolveImpact(impact, clipped, tip);
    applyImpactMotion(clipped, impact, 0.5);
    assert(
      V.length(clipped.angularVelocity) > 0.05,
      "a wingtip strike puts it into a tumble",
    );
    assert(
      V.length(clipped.angularVelocity) <= DAMAGE_MODEL.maxTumble,
      "and never past what the integrator can carry",
    );
  });

  suite("a charge only goes off when the fuze fires", () => {
    const armed = { warhead: INTERCEPT_WARHEAD as Warhead | null };
    const empty = { warhead: null as Warhead | null };

    assert(
      detonatingWarhead(empty, empty, 60) === null,
      "two unarmed aircraft just hit each other",
    );
    assert(
      detonatingWarhead(armed, armed, 2) === null,
      "and an armed one brushed at walking pace does not detonate",
    );
    assert(
      detonatingWarhead(armed, armed, 30) === INTERCEPT_WARHEAD,
      "a real interception fires the fuze",
    );
    assert(
      detonatingWarhead(empty, armed, 30) === INTERCEPT_WARHEAD,
      "and an unarmed aircraft is caught in someone else's blast",
    );

    const damage = createDamage();
    const impact = createImpact();
    const self = place("a", V.vec3(0, 0, 500), V.vec3(0, 30, 0));
    resolveImpact(impact, self, place("b", V.vec3(0, 3, 500), V.vec3(0, -30, 0)));
    assert(
      applyDamage(damage, impact, INTERCEPT_WARHEAD.charge) ===
        DAMAGE_OUTCOME.Destroyed,
      "and the charge leaves nothing of either airframe",
    );
  });
}

export async function runCollisionDamageTests(): Promise<void> {
  await suite("a light contact is survivable", async () => {
    const rapier = await initRapier();
    const simulation = new Simulation({
      frame: makeFrame(),
      terrain: await makeTerrain(-1000),
      missionRadius: 20000,
      collision: new CollisionWorld(rapier),
      contactDamage: true,
    });

    // One aircraft slowly overhauls another on the same course. Nobody is
    // carrying a charge, so this is only as bad as the impact itself.
    const chaser = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 500),
        headingDeg: 0,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );
    const led = simulation.spawn(
      {
        id: "enemy-1",
        role: AIRCRAFT_ROLE.Enemy,
        config: PLAYER_WING,
        position: V.vec3(0, 9, 500),
        headingDeg: 0,
        airspeed: 20,
        throttle: 0.45,
      },
      () => ({ ...level, throttle: 0.45 }),
    );

    let contacts = 0;
    const blasts: BlastReport[] = [];
    for (let i = 0; i < 60 * 5 && contacts === 0; i += 1) {
      simulation.update(1 / 60);
      contacts += simulation.drainContacts().length;
      blasts.push(...simulation.drainBlasts());
    }

    assert(contacts === 1, "the overtake produces one contact");
    assert(blasts.length === 0, "and nothing worth drawing an explosion for");
    assert(
      chaser.status === FLIGHT_STATUS.Flying,
      "and neither aircraft simply stops flying",
    );
    assert(led.status === FLIGHT_STATUS.Flying, "not the one that was hit either");
    assert(chaser.damage.hits === 1, "the airframe carries the hit");
    assertBetween(
      chaser.damage.integrity,
      0.9,
      0.999,
      "with a little structure gone",
    );
    assert(
      simulation.statistics.enemiesDestroyed === 0,
      "and nothing is credited as destroyed",
    );
  });

  await suite("a solid knock leaves an aircraft flying badly", async () => {
    const rapier = await initRapier();
    const simulation = new Simulation({
      frame: makeFrame(),
      terrain: await makeTerrain(-1000),
      missionRadius: 20000,
      collision: new CollisionWorld(rapier),
      contactDamage: true,
    });

    // A rear-end at something near 18 m/s: enough to cost both aircraft real
    // structure, not enough to take either of them out of the sky.
    const rammer = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 500),
        headingDeg: 0,
        airspeed: 38,
        throttle: 1,
      },
      () => ({ ...level, throttle: 1 }),
    );
    const rammed = simulation.spawn(
      {
        id: "enemy-1",
        role: AIRCRAFT_ROLE.Enemy,
        config: PLAYER_WING,
        position: V.vec3(0, 6, 500),
        headingDeg: 0,
        airspeed: 18,
        throttle: 0.4,
      },
      () => ({ ...level, throttle: 0.4 }),
    );

    let report = simulation.drainContacts()[0];
    for (let i = 0; i < 60 * 5 && !report; i += 1) {
      simulation.update(1 / 60);
      report = simulation.drainContacts()[0];
    }

    assert(report !== undefined, "the contact is reported");
    assert(report?.outcome === DAMAGE_OUTCOME.Damaged, "as damage, not a loss");
    assert(
      rammer.status === FLIGHT_STATUS.Flying,
      `both aircraft are still flying (${rammer.status} after ${report?.impactSpeed.toFixed(1)} m/s)`,
    );
    assert(rammed.status === FLIGHT_STATUS.Flying, "including the one that was hit");
    assertBetween(
      rammer.damage.integrity,
      0.4,
      0.85,
      `with a third of the airframe gone (${rammer.damage.integrity.toFixed(2)})`,
    );
    assert(
      rammer.damage.pitchAuthority < 0.95,
      "and less pitch than it took off with",
    );
    // The pusher's propeller is on the trailing edge, so the aircraft that was
    // rear-ended is the one that loses its power.
    assert(
      rammed.damage.thrustFactor < rammer.damage.thrustFactor,
      "the one hit from behind is the one that loses the motor",
    );
    assert(
      simulation.statistics.enemiesDestroyed === 0,
      "and nothing is credited while both are still flying",
    );
  });

  await suite("a hard contact takes the airframe out of the air", async () => {
    const rapier = await initRapier();
    const simulation = new Simulation({
      frame: makeFrame(),
      terrain: await makeTerrain(0),
      missionRadius: 20000,
      collision: new CollisionWorld(rapier),
      contactDamage: true,
    });

    // The same rear-end ten metres a second faster. Neither airframe is left
    // with enough to fly, and neither is blown apart either: they fall.
    const rammer = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 500),
        headingDeg: 0,
        airspeed: 48,
        throttle: 1,
      },
      () => ({ ...level, throttle: 1 }),
    );
    const rammed = simulation.spawn(
      {
        id: "enemy-1",
        role: AIRCRAFT_ROLE.Enemy,
        config: PLAYER_WING,
        position: V.vec3(0, 6, 500),
        headingDeg: 0,
        airspeed: 18,
        throttle: 0.4,
      },
      () => ({ ...level, throttle: 0.4 }),
    );

    let report = simulation.drainContacts()[0];
    const blasts: BlastReport[] = [];
    for (let i = 0; i < 60 * 5 && !report; i += 1) {
      simulation.update(1 / 60);
      report = simulation.drainContacts()[0];
      blasts.push(...simulation.drainBlasts());
    }

    assert(report !== undefined, "the contact is reported");
    assert(report?.explosion === false, "with nothing going off");
    assert(
      blasts.length === 2 &&
        blasts.every((blast) => blast.kind === BLAST_KIND.BreakUp),
      `both airframes are seen coming apart (${blasts.map((b) => b.kind).join(", ")})`,
    );
    assert(report?.sector === IMPACT_SECTOR.Nose, `taken on the nose (${report?.sector})`);
    assert(
      rammer.status === FLIGHT_STATUS.Disabled,
      `the aircraft that did it stops flying (${rammer.status} after ${report?.impactSpeed.toFixed(1)} m/s)`,
    );
    assert(report?.lethal === true, "and is reported as a loss");
    assert(
      rammer.status !== FLIGHT_STATUS.Destroyed,
      "but is a wreck falling out of the sky rather than a puff of nothing",
    );
    assert(
      rammed.status === FLIGHT_STATUS.Disabled,
      `and takes the other aircraft down with it (${rammed.status})`,
    );
    assert(
      simulation.statistics.enemiesDestroyed === 1,
      "a contact that is going down is credited without waiting for it to land",
    );

    // A wreck is out of the collision world, and gravity has the rest of it.
    const startedAt = rammer.position.z;
    const crashes: CrashReport[] = [];
    blasts.length = 0;
    for (let i = 0; i < 60 * 60; i += 1) {
      simulation.update(1 / 60);
      crashes.push(...simulation.drainCrashes());
      blasts.push(...simulation.drainBlasts());
      if (rammer.status === FLIGHT_STATUS.Crashed) break;
    }
    assert(rammer.position.z < startedAt, "a disabled airframe goes down");
    assert(
      rammer.status === FLIGHT_STATUS.Crashed,
      `and reaches the ground (${rammer.status})`,
    );
    assert(simulation.statistics.crashes >= 1, "which is counted as a crash");
    const wreck = crashes.find((crash) => crash.aircraftId === rammer.id);
    assert(
      wreck?.reason === "COLLISION",
      `and is reported as the end of the mid-air rather than a flying accident (${wreck?.reason})`,
    );
    const arrival = blasts.find((blast) => blast.aircraftId === rammer.id);
    assert(
      arrival?.kind === BLAST_KIND.Impact,
      `with something to see where it landed (${arrival?.kind})`,
    );
    assert(
      (arrival?.strength ?? 0) > 0.5,
      "and at the weight the speed it arrived at deserves",
    );
  });

  await suite("an armed interceptor explodes on contact", async () => {
    const rapier = await initRapier();
    const simulation = new Simulation({
      frame: makeFrame(),
      terrain: await makeTerrain(-1000),
      missionRadius: 20000,
      collision: new CollisionWorld(rapier),
      contactDamage: true,
    });

    // The same gentle overtake that was survivable unarmed. With a charge on
    // the wing it is not.
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, 500),
        headingDeg: 0,
        airspeed: 30,
        throttle: 0.85,
        warhead: INTERCEPT_WARHEAD,
      },
      () => ({ ...level, throttle: 0.85 }),
    );
    const enemy = simulation.spawn(
      {
        id: "enemy-1",
        role: AIRCRAFT_ROLE.Enemy,
        config: PLAYER_WING,
        position: V.vec3(0, 9, 500),
        headingDeg: 0,
        airspeed: 18,
        throttle: 0.4,
        warhead: INTERCEPT_WARHEAD,
      },
      () => ({ ...level, throttle: 0.4 }),
    );

    let report = simulation.drainContacts()[0];
    const blasts: BlastReport[] = [];
    for (let i = 0; i < 60 * 8 && !report; i += 1) {
      simulation.update(1 / 60);
      report = simulation.drainContacts()[0];
      blasts.push(...simulation.drainBlasts());
    }

    assert(report !== undefined, "the interception is reported");
    assert(report?.explosion === true, "as an explosion");
    assert(
      blasts.length === 1 && blasts[0]?.kind === BLAST_KIND.Detonation,
      `and raises exactly one fireball (${blasts.length})`,
    );
    assert(
      blasts[0]?.strength === 1,
      "at full strength, which is what a charge is",
    );
    // One charge went off between two aircraft, so that is where it is drawn.
    const gap = V.distance(player.position, enemy.position);
    const blastPosition = blasts[0]?.position ?? V.vec3();
    assert(
      V.distance(blastPosition, player.position) < gap &&
        V.distance(blastPosition, enemy.position) < gap,
      "between the two aircraft rather than on either of them",
    );
    assert(
      report !== undefined && report.impactSpeed < DAMAGE_MODEL.writeOffSpeed,
      `at a speed the airframe alone would have survived (${report?.impactSpeed.toFixed(1)} m/s)`,
    );
    assert(
      player.status === FLIGHT_STATUS.Destroyed,
      `the interceptor is destroyed (${player.status})`,
    );
    assert(
      enemy.status === FLIGHT_STATUS.Destroyed,
      `and so is the contact (${enemy.status})`,
    );
    assert(
      simulation.statistics.enemiesDestroyed === 1,
      "one enemy is credited",
    );
  });

  await suite("training contacts leave the airframes alone", async () => {
    const rapier = await initRapier();
    const simulation = new Simulation({
      frame: makeFrame(),
      terrain: await makeTerrain(-1000),
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
        // Fitted on purpose: with combat off not even a charge does anything.
        warhead: INTERCEPT_WARHEAD,
      },
      () => level,
    );
    simulation.spawn(
      {
        id: "lead",
        role: AIRCRAFT_ROLE.Lead,
        config: PLAYER_WING,
        position: V.vec3(0, 300, 500),
        headingDeg: 180,
        airspeed: 26,
        throttle: 0.7,
      },
      () => level,
    );

    let report = simulation.drainContacts()[0];
    for (let i = 0; i < 60 * 30 && !report; i += 1) {
      simulation.update(1 / 60);
      report = simulation.drainContacts()[0];
    }

    assert(report !== undefined, "the mid-air is still reported");
    assert(report?.lethal === false, "as something nobody lost an aircraft to");
    assert(player.status === FLIGHT_STATUS.Flying, "and the wing flies on");
    assert(!isDamaged(player.damage), "with nothing marked on it");
  });
}
