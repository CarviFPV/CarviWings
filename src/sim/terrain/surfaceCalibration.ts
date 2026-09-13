/**
 * Reconciling the ground that is flown against with the ground that is drawn.
 *
 * Most of the time these are the same surface: the elevation the terrain probe
 * returns is the elevation the globe is built from, and a wing put down on the
 * grid is a wing put down on the picture. Photogrammetry breaks that. A
 * photorealistic tileset carries its own ground — a mesh reconstructed from
 * imagery, not the bare-earth height field — and the two disagree by a couple
 * of metres in either direction. The globe is not even drawn underneath it, so
 * the pilot has no way to see the surface the physics is using, and a wing that
 * stops three metres above a runway looks exactly like a bug.
 *
 * The fix is to measure the disagreement where the aircraft actually is and
 * offset the field by it. That measurement comes from picking the rendered
 * scene, which is cheap only if it is done rarely — and which reports whatever
 * geometry is under the aircraft, including a roof. So the samples are
 * screened rather than trusted:
 *
 *   - a correction is only adopted once several consecutive samples agree,
 *     which they do over open ground and do not over a town
 *   - it is clamped to a plausible datum difference, so nothing the size of a
 *     building can ever be mistaken for one
 *   - it eases in and decays back to zero when measurements stop arriving
 *
 * The result is a slowly-moving scalar, never a step, so an aircraft's height
 * above ground cannot jump underneath it.
 */

import { clamp } from "../math/scalar";

export interface SurfaceCalibrationOptions {
  /**
   * Largest correction that will ever be applied, metres.
   *
   * A datum or mesh difference is metres; a building is more than that. The
   * clamp is what keeps the second from being mistaken for the first.
   */
  readonly maxBias?: number;
  /** Samples that have to agree before a correction is adopted. */
  readonly window?: number;
  /** How far apart those samples may be and still count as agreeing, metres. */
  readonly agreement?: number;
  /** Time constant for easing toward a new correction, seconds. */
  readonly blendSeconds?: number;
  /** Measurements stopping for this long lets the correction decay out. */
  readonly holdSeconds?: number;
}

const DEFAULTS = {
  maxBias: 3,
  window: 4,
  agreement: 1.5,
  blendSeconds: 1.2,
  holdSeconds: 3,
} as const;

export class SurfaceCalibration {
  private readonly maxBias: number;
  private readonly window: number;
  private readonly agreement: number;
  private readonly blendSeconds: number;
  private readonly holdSeconds: number;

  private readonly samples: number[] = [];
  private target = 0;
  private current = 0;
  private sinceSample = 0;

  constructor(options: SurfaceCalibrationOptions = {}) {
    this.maxBias = options.maxBias ?? DEFAULTS.maxBias;
    this.window = Math.max(2, options.window ?? DEFAULTS.window);
    this.agreement = options.agreement ?? DEFAULTS.agreement;
    this.blendSeconds = options.blendSeconds ?? DEFAULTS.blendSeconds;
    this.holdSeconds = options.holdSeconds ?? DEFAULTS.holdSeconds;
  }

  /** The correction to add to a sampled elevation, metres. */
  get bias(): number {
    return this.current;
  }

  /** True once enough agreeing samples have arrived to trust a correction. */
  get settled(): boolean {
    return this.samples.length >= this.window;
  }

  /**
   * Records one measurement.
   *
   * @param drawn    Height of the surface the renderer is showing, metres.
   * @param sampled  Height the terrain field reports for the same column,
   *                 with any correction already in it removed.
   */
  observe(drawn: number, sampled: number): void {
    if (!Number.isFinite(drawn) || !Number.isFinite(sampled)) return;
    this.sinceSample = 0;

    this.samples.push(drawn - sampled);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.samples.length < this.window) return;

    let low = Infinity;
    let high = -Infinity;
    let sum = 0;
    for (const sample of this.samples) {
      if (sample < low) low = sample;
      if (sample > high) high = sample;
      sum += sample;
    }
    // Samples that disagree are looking at different things — a roof and the
    // street beside it — and nothing can be concluded from them.
    if (high - low > this.agreement) return;

    this.target = clamp(sum / this.samples.length, -this.maxBias, this.maxBias);
  }

  /**
   * Adopts a correction measured before anything is flying.
   *
   * The window above exists to screen a stream of picks taken from a moving
   * aircraft, where a roof can arrive between two readings of the same
   * column. A single deliberate pick of the point an aircraft is about to be
   * put down on has nothing to screen: it is the ground it will be standing
   * on, and it has to be right on the first frame rather than four samples
   * into the flight. Applied outright rather than eased in, because there is
   * nothing on screen yet for it to move.
   */
  prime(drawn: number, sampled: number): void {
    if (!Number.isFinite(drawn) || !Number.isFinite(sampled)) return;
    this.sinceSample = 0;
    this.samples.length = 0;
    this.target = clamp(drawn - sampled, -this.maxBias, this.maxBias);
    this.current = this.target;
  }

  /** Eases the applied correction toward the measured one. */
  update(dt: number): void {
    this.sinceSample += dt;
    if (this.sinceSample > this.holdSeconds) {
      // Nothing has been measured for a while — over water, or with the pick
      // failing. Let the correction fade rather than leaving a stale one on.
      this.samples.length = 0;
      this.target = 0;
    }
    const rate = 1 - Math.exp(-dt / Math.max(this.blendSeconds, 1e-3));
    this.current += (this.target - this.current) * rate;
  }

  reset(): void {
    this.samples.length = 0;
    this.target = 0;
    this.current = 0;
    this.sinceSample = 0;
  }
}
