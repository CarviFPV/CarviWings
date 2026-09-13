import type { Vec3 } from "../math/vec3";

/** A local ENU column to sample terrain elevation for. */
export interface TerrainQuery {
  readonly x: number;
  readonly y: number;
}

/**
 * Resolves terrain elevation for a batch of local ENU columns.
 *
 * Results are in **local ENU metres** — the same `z` the aircraft uses — so the
 * hot path never has to run a geodetic conversion. `null` means the elevation
 * could not be determined and the cell should be retried later.
 *
 * This is asynchronous by design: it is the only part of the terrain system
 * allowed to touch the network, and it is never called from the flight loop.
 */
export type TerrainBatchProbe = (
  points: readonly TerrainQuery[],
) => Promise<readonly (number | null)[]>;

export interface TerrainSampler {
  /** True once enough terrain is known to fly over. */
  readonly ready: boolean;
  /** Cached, synchronous, allocation-free. Never performs I/O. */
  heightAt(localX: number, localY: number): number;
  /**
   * True when every grid corner around this column has a real sample.
   *
   * Terrain collision is gated on this: a missing sample must never be
   * mistaken for ground and destroy the aircraft.
   */
  hasCoverage(localX: number, localY: number): boolean;
  /** Refreshes the cache around a position. Cheap; call on a timer, not per frame. */
  refresh(centre: Vec3, velocity: Vec3, dt: number): void;
  /** Number of cells currently cached — surfaced in the debug overlay. */
  readonly cachedCells: number;
}
