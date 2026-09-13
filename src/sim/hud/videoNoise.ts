/**
 * What a breaking-up analogue picture looks like, as numbers.
 *
 * The goggles are the one instrument the pilot cannot choose to ignore, so the
 * interference is generated the same way everything else in the simulation is:
 * as plain data, from the signal quality and the clock, with the canvas layer
 * doing nothing but drawing it. That keeps the behaviour — how early the snow
 * starts, how hard it bursts, how fast the sync band rolls — testable without
 * a browser.
 *
 * Analogue video does not fade out evenly. It breaks up in bursts as the link
 * budget wanders around the receiver's threshold: a clean second, then half a
 * second of snow, then a rolling band of torn sync tumbling down the frame.
 * Two out-of-phase oscillators are enough to get that without a random number
 * generator, and being a pure function of time it stays reproducible.
 */

import { clamp } from "../math/scalar";

export interface VideoNoiseFrame {
  /** How much of the picture the static covers, 0..1. */
  readonly opacity: number;
  /** How dense the snow itself is, 0..1. */
  readonly snow: number;
  /** Height of the rolling sync band, as a fraction of the screen. */
  readonly bandHeight: number;
  /** Top of the rolling band, 0..1 down the screen. */
  readonly bandOffset: number;
  /** How badly the band tears the picture, 0..1. */
  readonly bandStrength: number;
  /** True once there is no picture behind the static at all. */
  readonly blackout: boolean;
}

const CLEAN: VideoNoiseFrame = {
  opacity: 0,
  snow: 0,
  bandHeight: 0,
  bandOffset: 0,
  bandStrength: 0,
  blackout: false,
};

/** Below this the link is treated as clean and nothing is drawn. */
export const NOISE_THRESHOLD = 0.995;

/**
 * The interference to draw for a given signal quality at a given moment.
 *
 * `quality` is the video link's own 0..1; `time` is any monotonic clock in
 * seconds. Pure, so the same pair always describes the same frame.
 */
export function videoNoiseFrame(
  quality: number,
  time: number,
): VideoNoiseFrame {
  const signal = clamp(quality, 0, 1);
  if (signal >= NOISE_THRESHOLD) return CLEAN;

  const strength = 1 - signal;
  // Two periods that do not divide into each other, so the picture never
  // settles into a rhythm the eye can predict.
  const burst = 0.5 + 0.5 * Math.sin(time * 5.7) * Math.cos(time * 2.3);

  // Squared, so a link only just off perfect is a suggestion of noise rather
  // than a screen full of it, and the last stretch closes in fast.
  const opacity = clamp(strength * strength + strength * 0.38 * burst, 0, 1);

  return {
    opacity: signal <= 0 ? 1 : opacity,
    snow: clamp(0.25 + strength * 0.9, 0, 1),
    bandHeight: 0.05 + 0.2 * strength,
    // The weaker the signal the faster the frame loses sync and the quicker
    // the band tumbles.
    bandOffset: ((time * (0.14 + 0.55 * strength)) % 1 + 1) % 1,
    bandStrength: clamp(strength * (0.55 + 0.45 * burst), 0, 1),
    blackout: signal <= 0,
  };
}
