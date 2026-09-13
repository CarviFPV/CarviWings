/**
 * Cached terrain elevation field.
 *
 * Terrain matters to gameplay every single physics step, but resolving it means
 * fetching tiles over the network. Neither the latency nor the cost belongs in
 * the flight loop, so this sits in between:
 *
 *   - elevation is sampled on a fixed grid, a bounded batch at a time
 *   - lookups bilinearly interpolate the four surrounding grid corners
 *   - cells ahead of the aircraft are filled before it gets there
 *   - the read path is synchronous and never performs I/O
 *
 * ## Why not read the rendered globe?
 *
 * Cesium can report the height of the terrain mesh it is *currently drawing*,
 * which is synchronous and free. It is also wrong: at coarse tile levels the
 * mesh is a chord across the curve of the Earth, sagging tens of kilometres
 * below the real surface wherever high-detail tiles have not streamed in yet.
 * A flight simulator that believed those numbers would report an aircraft at
 * 47 km AGL over the Alps. Sampling the terrain data itself is the only source
 * that is correct regardless of what the renderer happens to have loaded.
 *
 * ## Two grids, not one
 *
 * A single grid has to choose between being accurate and being affordable, and
 * for most of a flight those pull in opposite directions. A hundred-metre grid
 * is all an aircraft at altitude needs — it is only ever asked "is there a
 * mountain ahead" — but between its corners the interpolated surface departs
 * from the real one by metres, and metres are the whole story when a wing is
 * being put down on a field. Sampling the whole warm area at landing accuracy
 * would be a hundred times the requests for detail nobody at altitude can use.
 *
 * So there are two: the coarse grid that covers the warm area, and a close-in
 * grid an order of magnitude finer that is filled only in a small circle around
 * the aircraft, and only while it is low enough for the difference to matter.
 * Reads prefer the fine grid wherever it has resolved, which is exactly the
 * ground the aircraft is about to touch.
 *
 * The field is free of any Cesium dependency so it can be tested against an
 * analytic surface.
 */

import type { Vec3 } from "../math/vec3";
import type { TerrainBatchProbe, TerrainQuery, TerrainSampler } from "./types";

export interface TerrainFieldOptions {
  /** Grid spacing in metres. Smaller is sharper but samples more cells. */
  readonly cellSize?: number;
  /** Radius around the aircraft kept warm, in metres. */
  readonly warmRadius?: number;
  /** Seconds of travel to pre-sample ahead of the aircraft. */
  readonly lookaheadSeconds?: number;
  /**
   * Maximum cells requested per batch.
   *
   * Not a limit on how much work a batch is worth: elevation arrives as tiles,
   * and a batch costs whatever tiles its cells fall in however few cells that
   * is. Splitting one grid's worth of cells over eight batches therefore
   * fetches and decodes the same tiles eight times.
   */
  readonly sampleBudget?: number;
  /** Batches allowed in flight at once. */
  readonly maxConcurrentBatches?: number;
  /** Cells beyond this distance from the aircraft are dropped. */
  readonly pruneRadius?: number;
  /** Used before any real sample has arrived. */
  readonly fallbackHeight?: number;
  /**
   * Spacing of the close-in grid, in metres. Zero or less leaves the field
   * with only its coarse grid, which is what a test against an analytic
   * surface usually wants.
   */
  readonly detailCellSize?: number;
  /** Radius around the aircraft the close-in grid is filled in, metres. */
  readonly detailRadius?: number;
  /** Height above ground below which the close-in grid is filled, metres. */
  readonly detailCeiling?: number;
}

const DEFAULTS = {
  cellSize: 100,
  warmRadius: 900,
  lookaheadSeconds: 4,
  // Enough to fill either grid in a single request: the coarse grid is 19
  // cells across at its default spacing and warm radius, the close-in one 33,
  // and the block a mission prefills is 33 as well. Every one of those is one
  // pass over the tiles it lands in rather than nine passes over the same
  // ones.
  sampleBudget: 1200,
  maxConcurrentBatches: 2,
  pruneRadius: 6000,
  fallbackHeight: 0,
  // Ten metres is about as fine as the underlying elevation data goes, so
  // asking for less would sharpen the grid without sharpening the answer.
  detailCellSize: 10,
  detailRadius: 160,
  // Well above circuit height: a descent from here reaches the ground in tens
  // of seconds, which is far longer than the grid needs to fill.
  detailCeiling: 300,
} as const;

/** How far past its warm radius the close-in grid is allowed to accumulate. */
const DETAIL_PRUNE_FACTOR = 3;

/** Packs a signed cell coordinate pair into one integer key. */
function cellKey(ix: number, iy: number): number {
  // 20 bits each: +/- 500 000 cells, far beyond any mission radius.
  return (ix + 524288) * 1048576 + (iy + 524288);
}

/**
 * One regular grid of sampled elevations at a single spacing.
 *
 * Holds no policy: what it covers, how often it is refilled and when it is
 * preferred over another grid are all decided by `TerrainField`.
 */
class HeightGrid {
  readonly cellSize: number;
  private readonly heights = new Map<number, number>();
  private readonly pending = new Set<number>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  get size(): number {
    return this.heights.size;
  }

  private corner(ix: number, iy: number): number | undefined {
    return this.heights.get(cellKey(ix, iy));
  }

  hasCoverage(localX: number, localY: number): boolean {
    const ix = Math.floor(localX / this.cellSize);
    const iy = Math.floor(localY / this.cellSize);
    return (
      this.corner(ix, iy) !== undefined &&
      this.corner(ix + 1, iy) !== undefined &&
      this.corner(ix, iy + 1) !== undefined &&
      this.corner(ix + 1, iy + 1) !== undefined
    );
  }

  /**
   * Bilinear read of the four surrounding corners.
   *
   * Returns null when the column cannot be answered: with `requireFull` that
   * means any missing corner, without it only a completely unknown cell. The
   * partial case averages whatever corners exist rather than snapping to a
   * fallback, which would produce a visible cliff at the edge of the cache.
   */
  sample(localX: number, localY: number, requireFull: boolean): number | null {
    const gx = localX / this.cellSize;
    const gy = localY / this.cellSize;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;

    const h00 = this.corner(ix, iy);
    const h10 = this.corner(ix + 1, iy);
    const h01 = this.corner(ix, iy + 1);
    const h11 = this.corner(ix + 1, iy + 1);

    if (
      h00 !== undefined &&
      h10 !== undefined &&
      h01 !== undefined &&
      h11 !== undefined
    ) {
      const bottom = h00 + (h10 - h00) * fx;
      const top = h01 + (h11 - h01) * fx;
      return bottom + (top - bottom) * fy;
    }
    if (requireFull) return null;

    let sum = 0;
    let count = 0;
    if (h00 !== undefined) { sum += h00; count += 1; }
    if (h10 !== undefined) { sum += h10; count += 1; }
    if (h01 !== undefined) { sum += h01; count += 1; }
    if (h11 !== undefined) { sum += h11; count += 1; }
    return count > 0 ? sum / count : null;
  }

  /**
   * Collects up to `budget` unknown cells within `radius`, nearest first, so
   * the ground directly under the aircraft is always resolved before its
   * surroundings.
   */
  collectMissing(
    focusX: number,
    focusY: number,
    radius: number,
    budget: number,
  ): TerrainQuery[] {
    const rings = Math.ceil(radius / this.cellSize);
    const originIx = Math.floor(focusX / this.cellSize);
    const originIy = Math.floor(focusY / this.cellSize);
    const missing: TerrainQuery[] = [];

    for (let ring = 0; ring <= rings; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const ix = originIx + dx;
          const iy = originIy + dy;
          const key = cellKey(ix, iy);
          if (this.heights.has(key) || this.pending.has(key)) continue;
          missing.push({ x: ix * this.cellSize, y: iy * this.cellSize });
          if (missing.length >= budget) return missing;
        }
      }
    }
    return missing;
  }

  /** Every cell of a rectangle that is not already known, for `prefill`. */
  collectBlock(centre: Vec3, radius: number): TerrainQuery[] {
    const rings = Math.ceil(radius / this.cellSize);
    const originIx = Math.floor(centre.x / this.cellSize);
    const originIy = Math.floor(centre.y / this.cellSize);
    const points: TerrainQuery[] = [];
    for (let dx = -rings; dx <= rings; dx += 1) {
      for (let dy = -rings; dy <= rings; dy += 1) {
        if (this.heights.has(cellKey(originIx + dx, originIy + dy))) continue;
        points.push({
          x: (originIx + dx) * this.cellSize,
          y: (originIy + dy) * this.cellSize,
        });
      }
    }
    return points;
  }

  private keyFor(point: TerrainQuery): number {
    return cellKey(
      Math.round(point.x / this.cellSize),
      Math.round(point.y / this.cellSize),
    );
  }

  markPending(points: readonly TerrainQuery[]): void {
    for (const point of points) this.pending.add(this.keyFor(point));
  }

  clearPending(points: readonly TerrainQuery[]): void {
    for (const point of points) this.pending.delete(this.keyFor(point));
  }

  /** Stores a batch of results. Returns how many were usable. */
  store(
    points: readonly TerrainQuery[],
    heights: readonly (number | null)[],
  ): number {
    let stored = 0;
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i] as TerrainQuery;
      const key = this.keyFor(point);
      this.pending.delete(key);
      const height = heights[i];
      if (height === null || height === undefined || !Number.isFinite(height)) {
        continue;
      }
      this.heights.set(key, height);
      stored += 1;
    }
    return stored;
  }

  prune(centreX: number, centreY: number, radius: number): void {
    const limit = (radius / this.cellSize) ** 2;
    const cx = centreX / this.cellSize;
    const cy = centreY / this.cellSize;
    for (const key of this.heights.keys()) {
      const ix = Math.floor(key / 1048576) - 524288;
      const iy = (key % 1048576) - 524288;
      const dx = ix - cx;
      const dy = iy - cy;
      if (dx * dx + dy * dy > limit) this.heights.delete(key);
    }
  }

  clear(): void {
    this.heights.clear();
    this.pending.clear();
  }
}

export class TerrainField implements TerrainSampler {
  private readonly probe: TerrainBatchProbe;
  private readonly coarse: HeightGrid;
  /** Null when the field was built without a close-in grid. */
  private readonly detail: HeightGrid | null;

  private readonly warmRadius: number;
  private readonly lookaheadSeconds: number;
  private readonly sampleBudget: number;
  private readonly maxConcurrentBatches: number;
  private readonly pruneRadius: number;
  private readonly detailRadius: number;
  private readonly detailCeiling: number;

  private inFlight = 0;
  private fallback: number;
  private hasSample = false;
  private pruneTimer = 0;
  private bias = 0;

  constructor(probe: TerrainBatchProbe, options: TerrainFieldOptions = {}) {
    this.probe = probe;
    this.coarse = new HeightGrid(options.cellSize ?? DEFAULTS.cellSize);
    const detailCellSize = options.detailCellSize ?? DEFAULTS.detailCellSize;
    this.detail = detailCellSize > 0 ? new HeightGrid(detailCellSize) : null;

    this.warmRadius = options.warmRadius ?? DEFAULTS.warmRadius;
    this.lookaheadSeconds = options.lookaheadSeconds ?? DEFAULTS.lookaheadSeconds;
    this.sampleBudget = options.sampleBudget ?? DEFAULTS.sampleBudget;
    this.maxConcurrentBatches =
      options.maxConcurrentBatches ?? DEFAULTS.maxConcurrentBatches;
    this.pruneRadius = options.pruneRadius ?? DEFAULTS.pruneRadius;
    this.fallback = options.fallbackHeight ?? DEFAULTS.fallbackHeight;
    this.detailRadius = options.detailRadius ?? DEFAULTS.detailRadius;
    this.detailCeiling = options.detailCeiling ?? DEFAULTS.detailCeiling;
  }

  get ready(): boolean {
    return this.hasSample;
  }

  get cachedCells(): number {
    return this.coarse.size + (this.detail?.size ?? 0);
  }

  /** Cells held by the close-in grid, surfaced in the debug overlay. */
  get detailCells(): number {
    return this.detail?.size ?? 0;
  }

  get requestsInFlight(): number {
    return this.inFlight;
  }

  /**
   * The radius the coarse grid is kept warm over, metres.
   *
   * Read by whoever prefills the field, so a mission can guarantee it hands
   * the flight at least the ground the first refresh would otherwise ask for.
   */
  get warmedRadius(): number {
    return this.warmRadius;
  }

  /** Seeds the value used where no terrain has been sampled yet. */
  setFallbackHeight(height: number): void {
    this.fallback = height;
  }

  /**
   * A vertical offset applied to every reading, metres.
   *
   * The elevation data and the surface actually drawn are not always the same
   * surface — a photogrammetry mesh carries its own ground, and it sits a
   * couple of metres off the bare-earth height field it replaced. Ground
   * contact has to happen where the pilot can see the ground, so whoever can
   * measure that difference feeds it in here. Nothing else may write it: this
   * is a correction, not a place to store an altitude.
   */
  get surfaceBias(): number {
    return this.bias;
  }

  setSurfaceBias(metres: number): void {
    this.bias = Number.isFinite(metres) ? metres : 0;
  }

  hasCoverage(localX: number, localY: number): boolean {
    // Deliberately the coarse grid: the close-in one is an accuracy
    // improvement, and gating contact on it would leave an aircraft flying
    // through hillsides for as long as it took to fill.
    return this.coarse.hasCoverage(localX, localY);
  }

  /** True where the close-in grid, not just the coarse one, resolves the ground. */
  hasDetail(localX: number, localY: number): boolean {
    return this.detail !== null && this.detail.hasCoverage(localX, localY);
  }

  heightAt(localX: number, localY: number): number {
    if (this.detail) {
      const fine = this.detail.sample(localX, localY, true);
      if (fine !== null) return fine + this.bias;
    }
    const coarse = this.coarse.sample(localX, localY, false);
    if (coarse !== null) return coarse + this.bias;
    return this.fallback;
  }

  private request(grid: HeightGrid, points: readonly TerrainQuery[]): Promise<void> {
    grid.markPending(points);
    this.inFlight += 1;
    return this.probe(points)
      .then((heights) => {
        if (grid.store(points, heights) > 0) this.hasSample = true;
      })
      .catch(() => {
        // Clear the pending marks so the cells are retried on a later refresh.
        grid.clearPending(points);
      })
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  /** Issues batches for one grid until it is complete or the budget is spent. */
  private fill(
    grid: HeightGrid,
    focusX: number,
    focusY: number,
    radius: number,
  ): void {
    while (this.inFlight < this.maxConcurrentBatches) {
      const missing = grid.collectMissing(
        focusX,
        focusY,
        radius,
        this.sampleBudget,
      );
      if (missing.length === 0) return;
      void this.request(grid, missing);
    }
  }

  refresh(centre: Vec3, velocity: Vec3, dt: number): void {
    this.pruneTimer += dt;
    if (this.pruneTimer >= 5) {
      this.pruneTimer = 0;
      this.prune(centre);
    }

    if (this.inFlight >= this.maxConcurrentBatches) return;

    // Bias the warm area along the flight path so terrain is known before the
    // aircraft arrives, which is what makes a network-free hot path viable.
    const focusX = centre.x + velocity.x * this.lookaheadSeconds * 0.5;
    const focusY = centre.y + velocity.y * this.lookaheadSeconds * 0.5;

    // The close-in grid goes first: it is what a landing is flown on, and at
    // altitude it is not filled at all, so it costs nothing to prefer it.
    if (this.detail && this.needsDetail(centre)) {
      this.fill(this.detail, focusX, focusY, this.detailRadius);
    }
    this.fill(this.coarse, focusX, focusY, this.warmRadius);
  }

  /** Whether the aircraft is low enough for the close-in grid to be worth it. */
  private needsDetail(centre: Vec3): boolean {
    if (!this.hasSample) return false;
    return centre.z - this.heightAt(centre.x, centre.y) <= this.detailCeiling;
  }

  /**
   * Fills both grids around a point and waits for them.
   *
   * Used during mission loading, and it is worth being generous with: every
   * cell resolved here is a request that does not happen in a frame the pilot
   * is flying. A flight covers a kilometre or so in its first minute, and that
   * first minute is exactly when the tile streamer, the scenery and the
   * renderer are all busy with the same main thread — so terrain asked for
   * then is asked for at the worst possible moment.
   *
   * The close-in grid is filled as well as the coarse one, because both ends
   * of a flight are flown on it: a hand launch stands on it before the wing
   * has moved, and an approach comes back to the same field.
   */
  async prefill(
    centre: Vec3,
    radius: number,
    detailRadius = this.detailRadius,
  ): Promise<void> {
    await this.fillBlock(this.coarse, centre, radius);
    if (this.detail && detailRadius > 0) {
      await this.fillBlock(this.detail, centre, detailRadius);
    }
  }

  /**
   * Requests every unknown cell of one grid's block and waits for all of it,
   * a few batches at a time.
   *
   * Concurrent rather than sequential: the batches are independent, the probe
   * behind them is network-bound, and a prefill deep enough to cover the first
   * minute of a flight is several of them.
   */
  private async fillBlock(
    grid: HeightGrid,
    centre: Vec3,
    radius: number,
  ): Promise<void> {
    const points = grid.collectBlock(centre, radius);
    if (points.length === 0) return;

    const batches: TerrainQuery[][] = [];
    for (let i = 0; i < points.length; i += this.sampleBudget) {
      batches.push(points.slice(i, i + this.sampleBudget));
    }

    let next = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const batch = batches[next];
        if (!batch) return;
        next += 1;
        await this.request(grid, batch);
      }
    };
    const lanes = Math.min(this.maxConcurrentBatches, batches.length);
    await Promise.all(Array.from({ length: lanes }, lane));
  }

  private prune(centre: Vec3): void {
    // The close-in grid churns far faster than the coarse one — flying low
    // sweeps a hundred fresh cells a second through it — so it is trimmed on
    // every pass rather than once it has grown large.
    this.detail?.prune(
      centre.x,
      centre.y,
      this.detailRadius * DETAIL_PRUNE_FACTOR,
    );
    if (this.coarse.size < 20000) return;
    this.coarse.prune(centre.x, centre.y, this.pruneRadius);
  }

  clear(): void {
    this.coarse.clear();
    this.detail?.clear();
    this.hasSample = false;
    this.bias = 0;
  }
}
