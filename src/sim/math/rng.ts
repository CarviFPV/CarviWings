/**
 * Deterministic pseudo-random number generation.
 *
 * Mission generation must be reproducible from a seed, so `Math.random()` is
 * never used for anything that affects gameplay.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** Picks one element; throws only if the array is empty. */
  pick<T>(items: readonly T[]): T;
}

/** FNV-1a; turns a human-typed mission seed into a 32-bit state. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, and good enough for mission layout. */
export function createRng(seed: string | number): Rng {
  let state = (typeof seed === "number" ? seed >>> 0 : hashSeed(seed)) || 1;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) {
        throw new Error("createRng().pick called with an empty array");
      }
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}

const SEED_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Generates a fresh, human-readable mission seed. This is the one place a
 * non-deterministic source is acceptable: it picks the seed, it does not
 * consume it.
 */
export function generateSeed(): string {
  let seed = "";
  for (let i = 0; i < 8; i += 1) {
    seed += SEED_ALPHABET.charAt(
      Math.floor(Math.random() * SEED_ALPHABET.length),
    );
  }
  return seed;
}
