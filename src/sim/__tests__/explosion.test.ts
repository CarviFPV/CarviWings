import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  BLAST_KIND,
  ExplosionField,
  PARTICLE_KIND,
  colorOf,
  particleColor,
  smokeIntensity,
} from "../render/explosionField";
import type { Particle, ParticleKind } from "../render/explosionField";
import { PLAYER_WING } from "../flight/config";
import {
  AIRCRAFT_ROLE,
  FLIGHT_STATUS,
  createAircraftState,
} from "../flight/state";
import * as V from "../math/vec3";

function live(field: ExplosionField, kind?: ParticleKind): Particle[] {
  return field.particles.filter(
    (p) => p.life > 0 && (kind === undefined || p.kind === kind),
  );
}

/** Mean of one component over a set of particles. */
function mean(particles: readonly Particle[], read: (p: Particle) => number): number {
  if (particles.length === 0) return NaN;
  let sum = 0;
  for (const particle of particles) sum += read(particle);
  return sum / particles.length;
}

/** Runs a field forward in whole 120 Hz steps. */
function run(field: ExplosionField, seconds: number, wind?: V.Vec3): void {
  const dt = 1 / 120;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) field.update(dt, wind);
}

export function runExplosionTests(): void {
  suite("a detonation is four things happening at once", () => {
    const field = new ExplosionField({ capacity: 400, seed: "test" });
    assert(field.liveCount === 0, "nothing is burning to begin with");

    field.burst(BLAST_KIND.Detonation, V.vec3(0, 0, 500), V.vec3(), 1);

    assert(live(field, PARTICLE_KIND.Flash).length === 1, "one flash");
    assert(live(field, PARTICLE_KIND.Flame).length > 10, "a fireball");
    assert(live(field, PARTICLE_KIND.Smoke).length > 10, "smoke behind it");
    assert(live(field, PARTICLE_KIND.Debris).length > 10, "and fragments");
    assert(
      field.liveCount === live(field).length,
      "and the field knows how many it has",
    );

    // A burst that all dies on one frame reads as a light switch.
    const lifetimes = new Set(live(field).map((p) => p.life.toFixed(4)));
    assert(lifetimes.size > 10, "no two particles share a clock");

    // Everything goes out, and the pool comes back.
    run(field, 6);
    assert(field.liveCount === 0, "and six seconds later it is all gone");
  });

  suite("a burst travels with what exploded", () => {
    const field = new ExplosionField({ capacity: 400, seed: "test" });
    // A wing doing 40 m/s north when the charge went off.
    field.burst(
      BLAST_KIND.Detonation,
      V.vec3(0, 0, 500),
      V.vec3(0, 40, 0),
      1,
    );
    const flame = live(field, PARTICLE_KIND.Flame);
    assertBetween(
      mean(flame, (p) => p.velocity.y),
      28,
      52,
      "the fireball is carried along by the airframe it came off",
    );
    assertClose(
      mean(flame, (p) => p.velocity.x),
      0,
      8,
      "and is not thrown sideways on average",
    );
  });

  suite("fire rises and fragments fall", () => {
    const field = new ExplosionField({ capacity: 400, seed: "rise" });
    field.burst(BLAST_KIND.Detonation, V.vec3(0, 0, 500), V.vec3(), 1);
    run(field, 0.35);

    const flame = mean(live(field, PARTICLE_KIND.Flame), (p) => p.position.z);
    const debris = mean(live(field, PARTICLE_KIND.Debris), (p) => p.position.z);
    assert(flame > 500, `the fireball climbs (${flame.toFixed(1)} m)`);
    assert(debris < flame, "and the fragments do not go with it");
    assert(
      mean(live(field, PARTICLE_KIND.Smoke), (p) => p.position.z) > 500,
      "smoke climbs too, more slowly",
    );

    // Debris keeps falling once the fire is out.
    run(field, 1.2);
    assert(
      mean(live(field, PARTICLE_KIND.Debris), (p) => p.position.z) < 500,
      "and eventually they are below where the aircraft was",
    );
  });

  suite("smoke goes where the air goes", () => {
    const still = new ExplosionField({ capacity: 200, seed: "wind" });
    const blown = new ExplosionField({ capacity: 200, seed: "wind" });
    for (const field of [still, blown]) {
      field.burst(BLAST_KIND.BreakUp, V.vec3(0, 0, 500), V.vec3(), 1);
    }
    run(still, 1.5);
    run(blown, 1.5, V.vec3(12, 0, 0));

    const stillX = mean(live(still, PARTICLE_KIND.Smoke), (p) => p.position.x);
    const blownX = mean(live(blown, PARTICLE_KIND.Smoke), (p) => p.position.x);
    assert(
      blownX > stillX + 10,
      `a 12 m/s wind carries the smoke downwind (${blownX.toFixed(1)} vs ${stillX.toFixed(1)} m)`,
    );

    const stillDebris = mean(
      live(still, PARTICLE_KIND.Debris),
      (p) => p.position.x,
    );
    const blownDebris = mean(
      live(blown, PARTICLE_KIND.Debris),
      (p) => p.position.x,
    );
    assertClose(
      blownDebris,
      stillDebris,
      0.001,
      "and leaves the fragments where they were: they are too dense to care",
    );
  });

  suite("a break-up is not a detonation", () => {
    const blast = new ExplosionField({ capacity: 400, seed: "kind" });
    const failure = new ExplosionField({ capacity: 400, seed: "kind" });
    blast.burst(BLAST_KIND.Detonation, V.vec3(), V.vec3(), 1);
    failure.burst(BLAST_KIND.BreakUp, V.vec3(), V.vec3(), 1);

    assert(
      live(failure, PARTICLE_KIND.Flash).length === 0,
      "an airframe coming apart has no flash",
    );
    assert(
      live(failure, PARTICLE_KIND.Flame).length <
        live(blast, PARTICLE_KIND.Flame).length,
      "and far less fire",
    );
    assert(live(failure, PARTICLE_KIND.Debris).length > 5, "but plenty of pieces");

    // A weaker blast is a smaller one.
    const weak = new ExplosionField({ capacity: 400, seed: "kind" });
    weak.burst(BLAST_KIND.Detonation, V.vec3(), V.vec3(), 0.2);
    assert(
      weak.liveCount < blast.liveCount,
      "and strength scales the whole thing",
    );
    assert(
      mean(live(weak, PARTICLE_KIND.Flame), (p) => V.length(p.velocity)) <
        mean(live(blast, PARTICLE_KIND.Flame), (p) => V.length(p.velocity)),
      "including how far it is thrown",
    );
  });

  suite("a ground impact throws upward", () => {
    const field = new ExplosionField({ capacity: 400, seed: "ground" });
    // A wreck arriving at 40 m/s, mostly downward.
    field.burst(
      BLAST_KIND.Impact,
      V.vec3(0, 0, 100),
      V.vec3(0, 20, -35),
      1,
    );
    const debris = live(field, PARTICLE_KIND.Debris);
    assert(
      mean(debris, (p) => p.velocity.z) > 0,
      "the debris comes back up out of the hole rather than following the wreck in",
    );
    assert(
      mean(debris, (p) => p.velocity.y) < 8,
      "and keeps only a little of the wreck's speed",
    );
  });

  suite("the pool is the budget", () => {
    const field = new ExplosionField({ capacity: 120, seed: "pool" });
    for (let i = 0; i < 30; i += 1) {
      field.burst(BLAST_KIND.Detonation, V.vec3(i, 0, 500), V.vec3(), 1);
    }
    assert(field.particles.length === 120, "the pool never grows");
    assert(field.liveCount <= 120, "and never has more alive than it holds");
    assert(field.liveCount > 100, "but is well used");

    field.clear();
    assert(field.liveCount === 0, "and can be emptied");
  });

  suite("a trail is a rate, not a frame count", () => {
    const slow = new ExplosionField({ capacity: 400, seed: "trail" });
    const fast = new ExplosionField({ capacity: 400, seed: "trail" });
    const position = V.vec3(0, 0, 400);
    const velocity = V.vec3(0, 26, 0);

    // The same second of flight, at 30 and at 240 frames a second.
    for (let i = 0; i < 30; i += 1) {
      slow.trail("a", position, velocity, 1, 1 / 30);
    }
    for (let i = 0; i < 240; i += 1) {
      fast.trail("a", position, velocity, 1, 1 / 240);
    }
    assert(
      Math.abs(slow.liveCount - fast.liveCount) <= 1,
      `the frame rate does not change the trail (${slow.liveCount} vs ${fast.liveCount})`,
    );
    assertBetween(slow.liveCount, 24, 36, "and it is about the intended rate");

    // A trail too thin to make a whole particle in one frame still makes one
    // eventually rather than rounding away to nothing.
    const faint = new ExplosionField({ capacity: 400, seed: "trail" });
    for (let i = 0; i < 240; i += 1) {
      faint.trail("a", position, velocity, 0.1, 1 / 240);
    }
    assert(faint.liveCount > 0, "a faint trail is still a trail");
    assert(faint.liveCount < slow.liveCount, "just a thinner one");
    // Thinner in what it draws, not in how far apart the puffs are: a trail
    // spaced out enough to count reads as a fault rather than as smoke.
    assert(
      faint.liveCount > slow.liveCount * 0.3,
      `and never so sparse that it becomes a dotted line (${faint.liveCount})`,
    );
    const faintSize = mean(live(faint), (p) => p.size);
    const heavySize = mean(live(slow), (p) => p.size);
    assert(faintSize < heavySize * 0.5, "the puffs are what get smaller");

    // Two aircraft do not share one emitter's arithmetic.
    const pair = new ExplosionField({ capacity: 400, seed: "trail" });
    for (let i = 0; i < 240; i += 1) {
      pair.trail("a", position, velocity, 0.1, 1 / 240);
      pair.trail("b", position, velocity, 0.1, 1 / 240);
    }
    assertClose(
      pair.liveCount,
      faint.liveCount * 2,
      2,
      "two trailing aircraft trail twice as much",
    );

    // And it stops.
    const stopped = new ExplosionField({ capacity: 400, seed: "trail" });
    for (let i = 0; i < 240; i += 1) {
      stopped.trail("a", position, velocity, 0, 1 / 240);
    }
    assert(stopped.liveCount === 0, "an undamaged wing trails nothing");
    assert(
      live(slow, PARTICLE_KIND.Smoke).length === slow.liveCount,
      "a trail is smoke and only smoke",
    );
  });

  suite("a trail is drawn as finely as the screen can show it", () => {
    const velocity = V.vec3(0, 26, 0);
    const eye = V.vec3(0, 0, 400);

    /** A second of full-intensity trail from an aircraft `range` metres out. */
    const trailAt = (range: number | null): number => {
      const field = new ExplosionField({ capacity: 600, seed: "trail" });
      if (range === null) field.setViewpoint(null);
      else field.setViewpoint(eye);
      const position = V.vec3(0, range ?? 0, 400);
      for (let i = 0; i < 240; i += 1) {
        field.trail("a", position, velocity, 1, 1 / 240);
      }
      return field.liveCount;
    };

    const overhead = trailAt(0);
    const far = trailAt(4000);
    assert(overhead > far, "a plume a long way out costs fewer particles");
    assertBetween(
      far,
      10,
      14,
      `and never fewer than the rate that still draws a plume (${far})`,
    );
    assertClose(
      trailAt(200),
      overhead,
      2,
      "close in, nothing is given up at all",
    );
    assert(
      trailAt(700) > far && trailAt(700) < overhead,
      "and it is one ramp between the two, not a switch",
    );
    assertClose(
      trailAt(null),
      overhead,
      2,
      "with nobody watching, everything is drawn in full",
    );
  });

  suite("particles are coloured by what they are and how old", () => {
    const field = new ExplosionField({ capacity: 400, seed: "color" });
    field.burst(BLAST_KIND.Detonation, V.vec3(), V.vec3(), 1);
    const color = particleColor();

    const flash = live(field, PARTICLE_KIND.Flash)[0] as Particle;
    colorOf(color, flash);
    assert(color.a > 0.9, "a flash arrives at full brightness");
    flash.age = flash.life;
    colorOf(color, flash);
    assertClose(color.a, 0, 0.001, "and is gone by the end of its life");

    const flame = live(field, PARTICLE_KIND.Flame)[0] as Particle;
    flame.age = 0;
    colorOf(color, flame);
    const youngGreen = color.g;
    assert(color.b > 0.4, "a new flame is nearly white");
    flame.age = flame.life * 0.7;
    colorOf(color, flame);
    assert(color.g < youngGreen, "and reddens as it burns");
    assert(color.b < 0.05, "with the blue gone entirely");
    flame.age = flame.life;
    colorOf(color, flame);
    assertClose(color.a, 0, 0.001, "before going out");

    const smoke = live(field, PARTICLE_KIND.Smoke)[0] as Particle;
    smoke.age = smoke.life * 0.02;
    colorOf(color, smoke);
    const thin = color.a;
    smoke.age = smoke.life * 0.25;
    colorOf(color, smoke);
    assert(color.a > thin, "smoke thickens as it leaves the fire");
    smoke.age = smoke.life;
    colorOf(color, smoke);
    assertClose(color.a, 0, 0.001, "and thins away to nothing");

    // Dark smoke off a fire, pale smoke off a trailing wing.
    const dark = { ...smoke, shade: 0, age: smoke.life * 0.3 };
    const pale = { ...smoke, shade: 1, age: smoke.life * 0.3 };
    colorOf(color, dark);
    const darkTone = color.r;
    colorOf(color, pale);
    assert(color.r > darkTone, "and a shade that separates the two");
  });

  suite("particles grow as they spread", () => {
    const field = new ExplosionField({ capacity: 400, seed: "size" });
    field.burst(BLAST_KIND.Detonation, V.vec3(), V.vec3(), 1);
    const smoke = live(field, PARTICLE_KIND.Smoke)[0] as Particle;
    const born = field.radius(smoke);
    smoke.age = smoke.life;
    assert(field.radius(smoke) > born * 2, "a puff of smoke spreads out");

    const debris = live(field, PARTICLE_KIND.Debris)[0] as Particle;
    const size = field.radius(debris);
    debris.age = debris.life;
    assertClose(field.radius(debris), size, 0.001, "a fragment does not");
  });

  suite("the same burst twice is the same burst", () => {
    const a = new ExplosionField({ capacity: 200, seed: "seeded" });
    const b = new ExplosionField({ capacity: 200, seed: "seeded" });
    a.burst(BLAST_KIND.Detonation, V.vec3(1, 2, 3), V.vec3(4, 5, 6), 0.8);
    b.burst(BLAST_KIND.Detonation, V.vec3(1, 2, 3), V.vec3(4, 5, 6), 0.8);
    run(a, 0.4);
    run(b, 0.4);

    const left = live(a);
    const right = live(b);
    assert(left.length === right.length, "the same number of particles");
    const matched = left.every((particle, i) => {
      const other = right[i] as Particle;
      return (
        V.distance(particle.position, other.position) < 1e-9 &&
        Math.abs(particle.life - other.life) < 1e-9
      );
    });
    assert(matched, "in exactly the same places");

    const other = new ExplosionField({ capacity: 200, seed: "different" });
    other.burst(BLAST_KIND.Detonation, V.vec3(1, 2, 3), V.vec3(4, 5, 6), 0.8);
    assert(
      V.distance(
        (live(other, PARTICLE_KIND.Flame)[0] as Particle).velocity,
        (live(a, PARTICLE_KIND.Flame)[0] as Particle).velocity,
      ) > 1e-6,
      "and another seed is another explosion",
    );
  });

  suite("an airframe smokes in proportion to what is wrong with it", () => {
    const state = createAircraftState({
      id: "smoker",
      role: AIRCRAFT_ROLE.Player,
      config: PLAYER_WING,
      position: V.vec3(0, 0, 400),
      headingDeg: 0,
      airspeed: 26,
      throttle: 0.6,
    });

    assert(smokeIntensity(state) === 0, "a clean wing trails nothing");

    state.damage.integrity = 0.8;
    assert(smokeIntensity(state) === 0, "and a dented one still does not");

    state.damage.integrity = 0.6;
    const light = smokeIntensity(state);
    assert(light > 0, "a wing that has lost a panel starts to smoke");
    state.damage.integrity = 0.35;
    assert(smokeIntensity(state) > light, "and smokes harder as it gets worse");
    assert(smokeIntensity(state) < 1, "but never as hard as a wreck");

    state.status = FLIGHT_STATUS.Disabled;
    assert(smokeIntensity(state) === 1, "a wreck on its way down pours it");

    state.status = FLIGHT_STATUS.Crashing;
    assertBetween(
      smokeIntensity(state),
      0.1,
      0.9,
      "and goes on smouldering where it went in",
    );

    state.status = FLIGHT_STATUS.Crashed;
    assert(smokeIntensity(state) === 0, "until it has settled");

    state.status = FLIGHT_STATUS.Destroyed;
    assert(
      smokeIntensity(state) === 0,
      "and an airframe blown apart leaves nothing behind to smoke",
    );
  });
}
