/**
 * Explosions, break-ups and the smoke that comes off a damaged wing.
 *
 * A pool of particles integrated by the same kind of arithmetic the flight
 * model uses, and nothing else: no Cesium, no canvas, no textures. What comes
 * out is a list of positions, sizes and colours, which any renderer can draw
 * however it likes. That is what makes the interesting half of an explosion —
 * how it moves, how long it lives, what colour it is at each moment — testable
 * in Node rather than only judgeable by squinting at a screen.
 *
 * The pool is fixed and allocated once. A burst that arrives with the pool
 * full recycles the particles nearest the end of their lives, so twenty
 * aircraft going up at once degrades into a thinner explosion rather than into
 * an allocation storm or a frame spike.
 *
 * Four kinds of particle, because an explosion is four different things
 * happening on four different clocks:
 *
 *   FLASH   one frame of white, at the instant of detonation
 *   FLAME   a fast radial spray that burns out in half a second
 *   SMOKE   slow, buoyant, wind-blown, and around for seconds afterward
 *   DEBRIS  fragments on plain ballistic arcs, with no interest in any of it
 */

import { clamp } from "../math/scalar";
import type { Rng } from "../math/rng";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import { GRAVITY } from "../flight/config";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS, isAirworthy } from "../flight/state";

export const PARTICLE_KIND = {
  Flash: "FLASH",
  Flame: "FLAME",
  Smoke: "SMOKE",
  Debris: "DEBRIS",
} as const;

export type ParticleKind = (typeof PARTICLE_KIND)[keyof typeof PARTICLE_KIND];

/** What kind of event the burst is drawing. */
export const BLAST_KIND = {
  /** A charge going off: a flash, a fireball, and everything that was a wing. */
  Detonation: "DETONATION",
  /** An airframe coming apart in the air without a charge to help it. */
  BreakUp: "BREAK_UP",
  /** A wreck arriving on the ground: dust, a little fire, and fragments. */
  Impact: "IMPACT",
} as const;

export type BlastKind = (typeof BLAST_KIND)[keyof typeof BLAST_KIND];

export interface Particle {
  kind: ParticleKind;
  /** Local ENU metres. */
  readonly position: Vec3;
  /** Local ENU m/s. */
  readonly velocity: Vec3;
  /** Seconds lived so far. */
  age: number;
  /** Seconds it gets. Zero means the slot is free. */
  life: number;
  /** Radius at birth, metres. */
  size: number;
  /** Metres of radius added per second. */
  growth: number;
  /** Per-particle variation, 0..1, so a burst is not one flat colour. */
  shade: number;
}

/** A colour handed to the renderer: linear RGB and alpha, all 0..1. */
export interface ParticleColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function particleColor(): ParticleColor {
  return { r: 1, g: 1, b: 1, a: 1 };
}

export interface ExplosionOptions {
  /** How many particles may be alive at once. */
  readonly capacity?: number;
  /** Drives every scattered direction, so a burst is reproducible. */
  readonly seed?: string | number;
}

/** Metres per second squared of lift on hot gas. Fire rises; smoke rises less. */
const FLAME_BUOYANCY = 14;
const SMOKE_BUOYANCY = 3.2;
/** Per-second velocity decay. Hot gas stops almost at once; debris does not. */
const FLAME_DRAG = 4.5;
const SMOKE_DRAG = 1.6;
const DEBRIS_DRAG = 0.35;

/** Smoke particles a second from a trailing airframe, at full intensity. */
const TRAIL_RATE = 30;
/**
 * The fewest a trail may emit while it is emitting at all.
 *
 * A wing doing 140 km/h covers ten metres between puffs at four a second, and
 * what that draws is a dotted line rather than a wisp of smoke. Intensity
 * belongs in how big and how dark each puff is; the spacing has to stay closer
 * than the eye can pick apart whatever the damage is.
 */
const TRAIL_MIN_RATE = 12;
/**
 * How far away a trail is still emitted at its full rate, metres, and how far
 * away it drops to the minimum.
 *
 * The high rate exists to keep the puffs closer together than the eye can pick
 * apart — which is a question about the screen, not about the world. At the
 * minimum rate a wing doing 140 km/h leaves three metres between puffs, which
 * is a few pixels at a kilometre, and each puff grows to thirty metres across;
 * out there it draws the same continuous plume the full rate does. It is also
 * where the saving is: half a dozen damaged airframes in one fight otherwise
 * ask for more smoke than the pool holds, and every one of those particles is
 * a large translucent billboard the whole frame is drawn through.
 */
const TRAIL_NEAR_RANGE = 250;
const TRAIL_FAR_RANGE = 1200;

const _scratch = V.vec3();

export class ExplosionField {
  readonly particles: readonly Particle[];
  private readonly pool: Particle[];
  private readonly rng: Rng;
  /** Where the next search for a free slot starts. */
  private cursor = 0;
  private live = 0;
  /** Fractional particles owed to each trailing emitter, by aircraft id. */
  private readonly trailDebt = new Map<string, number>();
  /** Where the smoke is being looked at from; null spends the full rate on it. */
  private viewpoint: Vec3 | null = null;

  constructor(options: ExplosionOptions = {}) {
    const capacity = Math.max(1, options.capacity ?? 600);
    this.rng = createRng(options.seed ?? "explosion");
    this.pool = new Array(capacity);
    for (let i = 0; i < capacity; i += 1) {
      this.pool[i] = {
        kind: PARTICLE_KIND.Smoke,
        position: V.vec3(),
        velocity: V.vec3(),
        age: 0,
        life: 0,
        size: 0,
        growth: 0,
        shade: 0,
      };
    }
    this.particles = this.pool;
  }

  get capacity(): number {
    return this.pool.length;
  }

  /** Particles currently alive. */
  get liveCount(): number {
    return this.live;
  }

  /** Throws everything away. Used when a flight is reset or disposed. */
  clear(): void {
    for (const particle of this.pool) particle.life = 0;
    this.trailDebt.clear();
    this.live = 0;
    this.cursor = 0;
    this.viewpoint = null;
  }

  /**
   * Puts a burst in the air.
   *
   * `velocity` is how the wreckage was already moving: an explosion on a wing
   * doing 150 km/h travels with it rather than hanging politely in place.
   * `strength` is 0..1 and scales the count, the speed and the size together,
   * which is what separates a wingtip coming off from a charge going off.
   */
  burst(
    kind: BlastKind,
    position: Vec3,
    velocity: Vec3,
    strength = 1,
  ): void {
    const power = clamp(strength, 0, 1);
    const scale = 0.35 + 0.65 * power;

    if (kind === BLAST_KIND.Detonation) {
      this.emit(PARTICLE_KIND.Flash, 1, position, velocity, {
        speed: 0,
        size: 7 * scale,
        growth: 26 * scale,
        life: 0.14,
      });
      this.emit(PARTICLE_KIND.Flame, Math.round(28 * scale), position, velocity, {
        speed: 38 * scale,
        size: 1.4 * scale,
        growth: 8.5 * scale,
        life: 0.55,
      });
      // Smoke off burning fuel and foam is sooty, and it should not be
      // mistaken at a glance for the pale dust of a wreck hitting a field.
      this.emit(PARTICLE_KIND.Smoke, Math.round(22 * scale), position, velocity, {
        speed: 13 * scale,
        size: 2.2 * scale,
        growth: 4.5 * scale,
        life: 3.4,
        shadeRange: [0, 0.4],
      });
      this.emit(PARTICLE_KIND.Debris, Math.round(20 * scale), position, velocity, {
        speed: 44 * scale,
        size: 0.45,
        growth: 0,
        life: 2.2,
      });
      return;
    }

    if (kind === BLAST_KIND.BreakUp) {
      // No charge: what is seen is an airframe failing, so it is mostly
      // fragments and a little burning battery rather than a fireball.
      this.emit(PARTICLE_KIND.Flame, Math.round(9 * scale), position, velocity, {
        speed: 14 * scale,
        size: 0.9 * scale,
        growth: 3.6 * scale,
        life: 0.4,
      });
      this.emit(PARTICLE_KIND.Smoke, Math.round(12 * scale), position, velocity, {
        speed: 7 * scale,
        size: 1.2 * scale,
        growth: 3.4 * scale,
        life: 2.6,
        shadeRange: [0.05, 0.5],
      });
      this.emit(PARTICLE_KIND.Debris, Math.round(16 * scale), position, velocity, {
        speed: 20 * scale,
        size: 0.36,
        growth: 0,
        life: 2.4,
      });
      return;
    }

    // An arrival on the ground throws dust up and forward rather than out in
    // every direction, and the wreck stops, so nothing inherits its speed.
    V.set(_scratch, velocity.x * 0.15, velocity.y * 0.15, 0);
    this.emit(PARTICLE_KIND.Smoke, Math.round(16 * scale), position, _scratch, {
      speed: 9 * scale,
      size: 1.6 * scale,
      growth: 3.8 * scale,
      life: 2.8,
      upward: 0.55,
      // Ground thrown up is dust, and dust is pale.
      shadeRange: [0.55, 1],
    });
    this.emit(PARTICLE_KIND.Flame, Math.round(5 * scale), position, _scratch, {
      speed: 7 * scale,
      size: 0.8 * scale,
      growth: 2.4 * scale,
      life: 0.35,
      upward: 0.6,
    });
    this.emit(PARTICLE_KIND.Debris, Math.round(14 * scale), position, _scratch, {
      speed: 17 * scale,
      size: 0.34,
      growth: 0,
      life: 1.8,
      upward: 0.7,
    });
  }

  /**
   * Where the smoke is being watched from, in local ENU metres.
   *
   * Only the trails read it, and only to decide how finely to draw one: a
   * plume a kilometre off the wing does not need the puff count that one
   * filling the goggles does. Copied rather than retained, so the caller may
   * hand over a buffer it goes on writing to. `null` restores the full rate
   * everywhere, which is what a test or a headless run wants.
   */
  setViewpoint(position: Vec3 | null): void {
    if (!position) {
      this.viewpoint = null;
      return;
    }
    if (!this.viewpoint) this.viewpoint = V.vec3();
    V.copy(this.viewpoint, position);
  }

  /**
   * Trails smoke off something that is still flying.
   *
   * Rate-based rather than per-frame, so the trail is the same density at 30
   * and 144 frames a second. `id` keeps each aircraft's fractional particle
   * owed to it separately, which is what stops a light trail at a high frame
   * rate from rounding down to nothing.
   *
   * The rate also falls away with distance from the viewpoint, down to the
   * minimum that still draws a continuous plume: see `TRAIL_NEAR_RANGE`.
   */
  trail(
    id: string,
    position: Vec3,
    velocity: Vec3,
    intensity: number,
    dt: number,
  ): void {
    const rate = clamp(intensity, 0, 1);
    if (rate <= 0 || dt <= 0) {
      this.trailDebt.delete(id);
      return;
    }

    const perSecond =
      TRAIL_MIN_RATE +
      (TRAIL_RATE - TRAIL_MIN_RATE) * rate * this.nearness(position);
    const owed = (this.trailDebt.get(id) ?? 0) + perSecond * dt;
    const count = Math.floor(owed);
    this.trailDebt.set(id, owed - count);
    if (count <= 0) return;

    // Trailing smoke leaves the airframe slowly and is then left behind by it,
    // so it inherits only part of the aircraft's speed.
    V.scale(_scratch, velocity, 0.25);
    this.emit(PARTICLE_KIND.Smoke, count, position, _scratch, {
      speed: 2.5,
      size: 0.35 + 1.6 * rate,
      growth: 1.2 + 2.8 * rate,
      life: 1 + 2.6 * rate,
      // A wreck pours black smoke; a wing with a dent in it trails a pale
      // wisp, and the shade is the whole of the difference between them.
      shade: 1 - rate,
    });
  }

  /** Forgets one emitter's trail. Called when its aircraft goes away. */
  endTrail(id: string): void {
    this.trailDebt.delete(id);
  }

  /**
   * How close a point is to the viewpoint, 1 near and 0 far.
   *
   * One inside `TRAIL_NEAR_RANGE`, nothing beyond `TRAIL_FAR_RANGE`, and a
   * straight ramp between them — a trail crossing the boundary must not visibly
   * thin out as it goes.
   */
  private nearness(position: Vec3): number {
    const eye = this.viewpoint;
    if (!eye) return 1;
    const distance = V.distance(eye, position);
    if (distance <= TRAIL_NEAR_RANGE) return 1;
    if (distance >= TRAIL_FAR_RANGE) return 0;
    return (TRAIL_FAR_RANGE - distance) / (TRAIL_FAR_RANGE - TRAIL_NEAR_RANGE);
  }

  /**
   * Advances every live particle.
   *
   * `wind` is the air the burst is hanging in; smoke is carried by it, flame
   * is over too quickly to care, and debris is too dense to notice.
   */
  update(dt: number, wind?: Vec3): void {
    if (dt <= 0) return;
    let live = 0;

    for (const particle of this.pool) {
      if (particle.life <= 0) continue;

      particle.age += dt;
      if (particle.age >= particle.life) {
        particle.life = 0;
        continue;
      }
      live += 1;

      switch (particle.kind) {
        case PARTICLE_KIND.Flash:
          // A flash is light, not gas. It does not go anywhere.
          break;
        case PARTICLE_KIND.Flame:
          particle.velocity.z += FLAME_BUOYANCY * dt;
          decay(particle.velocity, FLAME_DRAG, dt);
          V.addScaled(particle.position, particle.position, particle.velocity, dt);
          break;
        case PARTICLE_KIND.Smoke:
          particle.velocity.z += SMOKE_BUOYANCY * dt;
          decay(particle.velocity, SMOKE_DRAG, dt);
          V.addScaled(particle.position, particle.position, particle.velocity, dt);
          if (wind) V.addScaled(particle.position, particle.position, wind, dt);
          break;
        case PARTICLE_KIND.Debris:
          particle.velocity.z -= GRAVITY * dt;
          decay(particle.velocity, DEBRIS_DRAG, dt);
          V.addScaled(particle.position, particle.position, particle.velocity, dt);
          break;
      }
    }

    this.live = live;
  }

  /** Current radius of a particle, metres. */
  radius(particle: Particle): number {
    return particle.size + particle.growth * particle.age;
  }

  private emit(
    kind: ParticleKind,
    count: number,
    position: Vec3,
    velocity: Vec3,
    spec: {
      speed: number;
      size: number;
      growth: number;
      life: number;
      /** 0 scatters evenly, 1 throws everything straight up. */
      upward?: number;
      /** Fixed shade, when the caller wants one rather than a random one. */
      shade?: number;
      /** Bounds on the random shade instead. Sooty smoke lives near 0. */
      shadeRange?: readonly [number, number];
    },
  ): void {
    for (let i = 0; i < count; i += 1) {
      const particle = this.take();
      particle.kind = kind;
      particle.age = 0;
      // A burst that all dies on the same frame reads as a light switch, so
      // every particle gets its own clock.
      particle.life = spec.life * this.rng.range(0.7, 1.25);
      particle.size = spec.size * this.rng.range(0.7, 1.3);
      particle.growth = spec.growth * this.rng.range(0.8, 1.2);
      const [shadeLow, shadeHigh] = spec.shadeRange ?? [0, 1];
      particle.shade = spec.shade ?? this.rng.range(shadeLow, shadeHigh);

      V.copy(particle.position, position);
      this.scatter(particle.velocity, spec.speed, spec.upward ?? 0);
      V.add(particle.velocity, particle.velocity, velocity);
      // Nudged along its own direction so a burst starts as a ball rather than
      // as every particle stacked on one point.
      V.addScaled(
        particle.position,
        particle.position,
        particle.velocity,
        0.02,
      );
    }
  }

  /**
   * A random direction at a random fraction of `speed`.
   *
   * Cube-rooted so the particles fill the sphere rather than crowding its
   * surface: a burst wants a fireball, not a soap bubble.
   */
  private scatter(out: Vec3, speed: number, upward: number): void {
    const z = this.rng.range(-1, 1);
    const planar = Math.sqrt(Math.max(1 - z * z, 0));
    const theta = this.rng.range(0, Math.PI * 2);
    const magnitude = speed * Math.cbrt(this.rng.range(0.05, 1));
    V.set(
      out,
      Math.cos(theta) * planar * magnitude,
      Math.sin(theta) * planar * magnitude,
      // Biased upward for a ground impact, where the ground is in the way of
      // half the sphere.
      (z * (1 - upward) + Math.abs(z) * upward) * magnitude,
    );
  }

  /**
   * Finds a slot, preferring a free one and otherwise taking whichever
   * particle is nearest the end of its life.
   */
  private take(): Particle {
    const pool = this.pool;
    for (let i = 0; i < pool.length; i += 1) {
      const index = (this.cursor + i) % pool.length;
      const particle = pool[index] as Particle;
      if (particle.life <= 0) {
        this.cursor = (index + 1) % pool.length;
        this.live += 1;
        return particle;
      }
    }

    let oldest = pool[0] as Particle;
    let mostSpent = -1;
    for (const particle of pool) {
      const spent = particle.age / particle.life;
      if (spent > mostSpent) {
        mostSpent = spent;
        oldest = particle;
      }
    }
    return oldest;
  }
}

/** Exponential velocity decay, which is drag on something small and light. */
function decay(velocity: Vec3, rate: number, dt: number): void {
  V.scale(velocity, velocity, Math.exp(-rate * dt));
}

/**
 * The colour of a particle right now.
 *
 * Fire cools as it burns: a flame starts near white, drops through yellow and
 * orange into a dull red and goes out. Smoke is the opposite — it leaves the
 * fire dark and thins toward the sky as it spreads. Both are written into
 * `out` rather than returned, so drawing a full pool allocates nothing.
 */
export function colorOf(
  out: ParticleColor,
  particle: Particle,
): ParticleColor {
  const t = particle.life > 0 ? clamp(particle.age / particle.life, 0, 1) : 1;

  switch (particle.kind) {
    case PARTICLE_KIND.Flash: {
      out.r = 1;
      out.g = 0.97;
      out.b = 0.85;
      // Gone almost as fast as it arrived.
      out.a = (1 - t) ** 0.6;
      return out;
    }
    case PARTICLE_KIND.Flame: {
      // White-hot, then yellow, then a red that fades into its own smoke.
      out.r = 1;
      out.g = clamp(0.95 - 0.85 * t, 0.08, 1) * (0.85 + 0.15 * particle.shade);
      out.b = clamp(0.75 - 1.5 * t, 0, 1);
      out.a = t < 0.75 ? 1 : (1 - t) / 0.25;
      return out;
    }
    case PARTICLE_KIND.Smoke: {
      // `shade` is what separates the black smoke off a burning airframe from
      // the pale wisp coming off a wing that has only been dented.
      const tone = 0.1 + 0.62 * particle.shade + 0.3 * t;
      out.r = tone;
      out.g = tone * 0.98;
      out.b = tone * 0.96;
      // Thickest just after it leaves the fire, then it thins out.
      out.a = 0.72 * Math.min(t * 8, 1) * (1 - t) ** 1.3;
      return out;
    }
    case PARTICLE_KIND.Debris: {
      // A scorched fragment of foam, still glowing at the moment it leaves.
      const glow = clamp(1 - t * 5, 0, 1);
      out.r = 0.16 + 0.84 * glow;
      out.g = 0.14 + 0.56 * glow;
      out.b = 0.13 + 0.17 * glow;
      out.a = t < 0.8 ? 1 : (1 - t) / 0.2;
      return out;
    }
  }
}

/**
 * Integrity below which an airframe starts trailing smoke.
 *
 * A wing that has been dented does not smoke. One that has lost a quarter of
 * itself has something burning on it, and the pilot of the aircraft chasing it
 * should be able to see that without reading an instrument.
 */
const SMOKE_THRESHOLD = 0.75;
/** The most a wing that is still flying will trail. */
const DAMAGED_SMOKE = 0.8;
/** What a wreck smoulders at in the seconds after it arrives. */
const SETTLING_SMOKE = 0.5;

/**
 * How hard an airframe should be trailing smoke, 0..1.
 *
 * The one number the trail needs, and the reason it belongs here rather than
 * in a renderer: it is a statement about the aircraft, and it should read the
 * same whoever is drawing it.
 */
export function smokeIntensity(state: AircraftState): number {
  // A wreck on its way down pours it. Nothing else comes close.
  if (state.status === FLIGHT_STATUS.Disabled) return 1;
  // And goes on smouldering for the second or so it takes to settle, so the
  // pilot can see where a contact went in.
  if (state.status === FLIGHT_STATUS.Crashing) return SETTLING_SMOKE;
  if (!isAirworthy(state.status)) return 0;

  const lost = 1 - state.damage.integrity;
  if (lost <= 1 - SMOKE_THRESHOLD) return 0;
  return (
    clamp((lost - (1 - SMOKE_THRESHOLD)) / SMOKE_THRESHOLD, 0, 1) * DAMAGED_SMOKE
  );
}
