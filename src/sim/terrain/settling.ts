/**
 * Knowing when a measurement of the ground has stopped changing.
 *
 * The RC ground view is the one flight where somebody is standing still. The
 * pilot's feet and the launcher's are on two patches of ground that are
 * measured out of the rendered scene before the flight opens — see
 * `lib/cesium/terrainProbe.ts` for what that costs — and then re-measured
 * while the flight runs, because a canopy resolves as its tiles do and a stand
 * left at the height the first frame had is a stand under the trees.
 *
 * What was missing was the other half of that: a reason to stop. Nothing about
 * either patch moves once the tiles under it have arrived — the pilot does not
 * walk anywhere, and a photogrammetry mesh that has refined does not un-refine
 * — so a re-measurement that keeps returning the same answer is measuring
 * nothing, at the price of a scene pick per column for the whole flight. Left
 * running it is the most expensive thing in the frame and it buys a number
 * that was already known.
 *
 * So the rounds are treated as a settling process rather than a poll. Each
 * waits longer than the one before it, and once consecutive rounds agree the
 * measuring stops until something the readings describe has actually moved —
 * which on a field is one thing only: a wing going back into somebody's hand.
 */

export interface SurfaceSettlingOptions {
  /** Wait before the first round, seconds. */
  readonly firstInterval?: number;
  /** How much longer each wait is than the one before it. */
  readonly backoff?: number;
  /** The longest a wait ever gets, seconds. */
  readonly maxInterval?: number;
  /**
   * How far two rounds may differ and still be the same answer, metres.
   *
   * Tight, because a scene that has stopped arriving returns the identical
   * reading round after round: the same rays against the same geometry. What
   * this has to be loose enough for is a tile refining under a stand and
   * moving a canopy by a fraction of a metre, not for the roughness of the
   * canopy itself — that is inside one round, and `measuredSurface` screens it.
   */
  readonly agreement?: number;
  /** Rounds in a row that have to agree before the measuring stops. */
  readonly quorum?: number;
}

const DEFAULTS = {
  firstInterval: 1,
  backoff: 2,
  maxInterval: 8,
  agreement: 0.25,
  quorum: 2,
} as const;

/** One round's answer: a height per stand, or null where nothing was read. */
export type SurfaceReadings = readonly (number | null)[];

export class SurfaceSettling {
  private readonly firstInterval: number;
  private readonly backoff: number;
  private readonly maxInterval: number;
  private readonly agreement: number;
  private readonly quorum: number;

  private wait: number;
  private timer = 0;
  private running = false;
  private agreeing = 0;
  private previous: SurfaceReadings | null = null;

  constructor(options: SurfaceSettlingOptions = {}) {
    this.firstInterval = Math.max(
      options.firstInterval ?? DEFAULTS.firstInterval,
      1e-3,
    );
    this.backoff = Math.max(options.backoff ?? DEFAULTS.backoff, 1);
    this.maxInterval = Math.max(
      options.maxInterval ?? DEFAULTS.maxInterval,
      this.firstInterval,
    );
    this.agreement = Math.max(options.agreement ?? DEFAULTS.agreement, 0);
    this.quorum = Math.max(options.quorum ?? DEFAULTS.quorum, 1);
    this.wait = this.firstInterval;
  }

  /** True once the readings have stopped changing and nothing more is due. */
  get settled(): boolean {
    return this.agreeing >= this.quorum;
  }

  /** True while a round started by `begin` has not reported back. */
  get measuring(): boolean {
    return this.running;
  }

  /** How long the next wait is, seconds. Useful to tests and to the overlay. */
  get interval(): number {
    return this.wait;
  }

  /**
   * Advances the clock and says whether a round should be started now.
   *
   * Never while one is already running — the clock is stopped for as long as a
   * round is out, so the next wait is measured from the moment the last one
   * came back rather than from the moment it left. A round that takes four
   * seconds to answer is a round that cost four seconds of frames, and the
   * gap after it should be a gap rather than a queue that has already expired.
   */
  begin(dt: number): boolean {
    if (this.settled || this.running) return false;
    this.timer += Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.timer < this.wait) return false;
    this.timer = 0;
    this.running = true;
    return true;
  }

  /**
   * Records what a round came back with, and lengthens the next wait.
   *
   * Null is "not read", not "no ground": it agrees with a null and with
   * nothing else, so a pick that fails over one stand keeps the measuring
   * going rather than settling the question it failed to answer.
   */
  finish(readings: SurfaceReadings): void {
    this.running = false;
    this.wait = Math.min(this.wait * this.backoff, this.maxInterval);
    this.agreeing = this.agrees(readings) ? this.agreeing + 1 : 0;
    this.previous = [...readings];
  }

  /**
   * Gives up on a round that never produced a reading.
   *
   * Nothing was learned, so nothing is concluded: the agreement stands where it
   * stood and the next wait is the one this round was going to be followed by.
   */
  abandon(): void {
    this.running = false;
  }

  /**
   * Adopts a round taken before the flight opened.
   *
   * The launch area is measured once under the loading screen, deliberately
   * and at the deepest detail the scene can be made to reach. That reading is
   * the one everything in flight is compared against, so it is handed over
   * here rather than thrown away — otherwise the first in-flight round has
   * nothing to agree with and the settling costs an extra round for nothing.
   * The clock is untouched: nothing has been spent yet.
   */
  prime(readings: SurfaceReadings): void {
    this.previous = [...readings];
  }

  /**
   * Something the readings describe has moved, so start looking again.
   *
   * On a field that is a replacement airframe going into the launcher's hand:
   * the ground under a held wing is what holds it at head height, and it is
   * worth a couple of rounds to be sure of it again.
   */
  disturb(): void {
    this.wait = this.firstInterval;
    this.timer = 0;
    this.agreeing = 0;
  }

  private agrees(readings: SurfaceReadings): boolean {
    const previous = this.previous;
    if (previous === null) return false;
    if (previous.length !== readings.length) return false;
    for (let i = 0; i < readings.length; i += 1) {
      const now = readings[i] ?? null;
      const before = previous[i] ?? null;
      if (now === null || before === null) {
        if (now !== before) return false;
        continue;
      }
      if (Math.abs(now - before) > this.agreement) return false;
    }
    return true;
  }
}
