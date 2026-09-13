/**
 * Learns a controller's layout by watching the pilot use it.
 *
 * The specification is explicit that no particular axis layout may be assumed,
 * and an RC transmitter in game-pad mode is exactly the device that breaks
 * every assumption: the channel order depends on the radio, the firmware and
 * the model the pilot has selected. The only reliable way to find out where
 * pitch lives is to ask for pitch and see what moves.
 *
 * The routine is pure. It is fed snapshots and a time step and produces a
 * profile, so the whole thing runs in Node against synthetic stick movements.
 */

import { clamp } from "../math/scalar";
import type {
  ControllerProfile,
  ControllerSnapshot,
  ControlAxis,
  AxisBinding,
} from "./controllerProfile";
import {
  CONTROLLER_LAYOUT,
  UNBOUND,
  channelCount,
  channelValue,
  controlBinding,
  defaultProfile,
  throttleBinding,
} from "./controllerProfile";

export const CALIBRATION_STEP = {
  /** Everything at rest, so the resting position of each channel is known. */
  Centre: "CENTRE",
  /** Everything swept end to end, so the travel of each channel is known. */
  Travel: "TRAVEL",
  Pitch: "PITCH",
  Roll: "ROLL",
  Yaw: "YAW",
  Throttle: "THROTTLE",
  Done: "DONE",
} as const;

export type CalibrationStep =
  (typeof CALIBRATION_STEP)[keyof typeof CALIBRATION_STEP];

const ORDER: readonly CalibrationStep[] = [
  CALIBRATION_STEP.Centre,
  CALIBRATION_STEP.Travel,
  CALIBRATION_STEP.Pitch,
  CALIBRATION_STEP.Roll,
  CALIBRATION_STEP.Yaw,
  CALIBRATION_STEP.Throttle,
  CALIBRATION_STEP.Done,
];

/** Which control each binding step is asking for. */
const STEP_AXIS: Partial<Record<CalibrationStep, ControlAxis>> = {
  PITCH: "pitch",
  ROLL: "roll",
  YAW: "yaw",
  THROTTLE: "throttle",
};

export const CENTRE_SECONDS = 1.4;
export const TRAVEL_SECONDS = 6;
/** How long a control must stay deflected before its channel is accepted. */
export const HOLD_SECONDS = 0.5;

/** Smallest travel a channel can be credited with, to keep scores finite. */
const MIN_HALF_TRAVEL = 0.15;
/** Fraction of a channel's travel that counts as a deliberate deflection. */
const MOVE_THRESHOLD = 0.4;
/** How far ahead of the runner-up a channel must be to win, so that gimbal
 *  crosstalk on the other axis of the same stick never binds by mistake. */
const DOMINANCE = 1.7;

export interface CalibrationView {
  readonly step: CalibrationStep;
  readonly prompt: string;
  readonly hint: string;
  /** 0..1 through the current step. */
  readonly progress: number;
  /** The channel currently winning this step, or `UNBOUND`. */
  readonly candidate: number;
  readonly complete: boolean;
}

const PROMPTS: Record<CalibrationStep, readonly [string, string]> = {
  CENTRE: [
    "Let go of every control",
    "Leave the sticks where they rest so their neutral positions can be read.",
  ],
  TRAVEL: [
    "Sweep every stick through its full travel",
    "Move all of them corner to corner, including the throttle, then continue.",
  ],
  PITCH: [
    "Pull pitch fully back and hold",
    "Nose up. Hold it until the channel is accepted.",
  ],
  ROLL: ["Roll fully right and hold", "Right wing down."],
  YAW: ["Yaw fully right and hold", "Rudder or the yaw stick, to the right."],
  THROTTLE: [
    "Set the throttle to idle, then open it fully and hold",
    "Any stick, slider or trigger that runs end to end.",
  ],
  DONE: ["Calibration complete", "Every control has been matched to a channel."],
};

export class ControllerCalibration {
  private readonly deviceId: string;
  private readonly axisCount: number;
  private readonly buttonCount: number;
  private readonly total: number;

  private index = 0;
  private elapsed = 0;
  private held = 0;

  /** Resting reading of every channel, from the centring step. */
  private readonly rest: number[];
  private readonly restSum: number[];
  private restSamples = 0;

  /** Extremes seen during the travel step. */
  private readonly low: number[];
  private readonly high: number[];

  private candidateChannel = UNBOUND;
  private readonly assigned = new Map<ControlAxis, AxisBinding>();
  private readonly usedChannels = new Set<number>();

  constructor(deviceId: string, axisCount: number, buttonCount: number) {
    this.deviceId = deviceId;
    this.axisCount = axisCount;
    this.buttonCount = buttonCount;
    this.total = axisCount + buttonCount;
    this.rest = new Array<number>(this.total).fill(0);
    this.restSum = new Array<number>(this.total).fill(0);
    this.low = new Array<number>(this.total).fill(Number.POSITIVE_INFINITY);
    this.high = new Array<number>(this.total).fill(Number.NEGATIVE_INFINITY);
  }

  get step(): CalibrationStep {
    return ORDER[this.index] ?? CALIBRATION_STEP.Done;
  }

  get complete(): boolean {
    return this.step === CALIBRATION_STEP.Done;
  }

  get view(): CalibrationView {
    const step = this.step;
    const [prompt, hint] = PROMPTS[step];
    return {
      step,
      prompt,
      hint: this.candidateHint() ?? hint,
      progress: this.progress(),
      candidate: this.candidateChannel,
      complete: this.complete,
    };
  }

  private candidateHint(): string | null {
    if (this.candidateChannel === UNBOUND) return null;
    const label =
      this.candidateChannel < this.axisCount
        ? `axis ${this.candidateChannel}`
        : `button ${this.candidateChannel - this.axisCount}`;
    return `Reading ${label}…`;
  }

  private progress(): number {
    switch (this.step) {
      case CALIBRATION_STEP.Centre:
        return clamp(this.elapsed / CENTRE_SECONDS, 0, 1);
      case CALIBRATION_STEP.Travel:
        return clamp(this.elapsed / TRAVEL_SECONDS, 0, 1);
      case CALIBRATION_STEP.Done:
        return 1;
      default:
        return clamp(this.held / HOLD_SECONDS, 0, 1);
    }
  }

  /** Half the travel of a channel, floored so scores never divide by nothing. */
  private halfTravel(channel: number): number {
    const rest = this.rest[channel] ?? 0;
    const low = this.low[channel];
    const high = this.high[channel];
    const below = low !== undefined && Number.isFinite(low) ? rest - low : 0;
    const above = high !== undefined && Number.isFinite(high) ? high - rest : 0;
    return Math.max(Math.abs(below), Math.abs(above), MIN_HALF_TRAVEL);
  }

  /**
   * The channel the pilot is deflecting, if one of them clearly is.
   *
   * Channels already spoken for are skipped: a pitch stick still held back
   * from the previous step must never be able to win the roll step.
   */
  private detect(snapshot: ControllerSnapshot): number {
    let best = UNBOUND;
    let bestScore = 0;
    let runnerUp = 0;
    for (let channel = 0; channel < this.total; channel += 1) {
      if (this.usedChannels.has(channel)) continue;
      const value = channelValue(snapshot, channel);
      const score =
        Math.abs(value - (this.rest[channel] ?? 0)) / this.halfTravel(channel);
      if (score > bestScore) {
        runnerUp = bestScore;
        bestScore = score;
        best = channel;
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    if (bestScore < MOVE_THRESHOLD) return UNBOUND;
    if (bestScore < runnerUp * DOMINANCE) return UNBOUND;
    return best;
  }

  update(snapshot: ControllerSnapshot, dt: number): void {
    if (this.complete) return;
    const step = this.step;
    this.elapsed += dt;

    if (step === CALIBRATION_STEP.Centre) {
      for (let channel = 0; channel < this.total; channel += 1) {
        this.restSum[channel] =
          (this.restSum[channel] ?? 0) + channelValue(snapshot, channel);
      }
      this.restSamples += 1;
      if (this.elapsed >= CENTRE_SECONDS && this.restSamples > 0) {
        for (let channel = 0; channel < this.total; channel += 1) {
          this.rest[channel] = (this.restSum[channel] ?? 0) / this.restSamples;
          // The resting reading is a valid part of the travel, so seed the
          // extremes with it. A channel nobody moves then has zero travel
          // rather than an infinite one.
          this.low[channel] = this.rest[channel] ?? 0;
          this.high[channel] = this.rest[channel] ?? 0;
        }
        this.next();
      }
      return;
    }

    if (step === CALIBRATION_STEP.Travel) {
      for (let channel = 0; channel < this.total; channel += 1) {
        const value = channelValue(snapshot, channel);
        if (value < (this.low[channel] ?? value)) this.low[channel] = value;
        if (value > (this.high[channel] ?? value)) this.high[channel] = value;
      }
      if (this.elapsed >= TRAVEL_SECONDS) this.next();
      return;
    }

    // A binding step: watch for a deflection and require it to be held.
    const detected = this.detect(snapshot);
    if (detected === UNBOUND || detected !== this.candidateChannel) {
      this.candidateChannel = detected;
      this.held = 0;
      return;
    }
    this.held += dt;
    if (this.held < HOLD_SECONDS) return;

    const axis = STEP_AXIS[step];
    if (axis) this.commit(axis, detected, channelValue(snapshot, detected));
    this.next();
  }

  private commit(axis: ControlAxis, channel: number, held: number): void {
    const rest = this.rest[channel] ?? 0;
    const low = Math.min(this.low[channel] ?? rest, held);
    const high = Math.max(this.high[channel] ?? rest, held);

    if (axis === "throttle") {
      // The pilot is holding full power, so whichever calibrated end that
      // reading is nearest is the end that must map to 1.
      const inverted = Math.abs(held - low) < Math.abs(held - high);
      this.assigned.set(axis, {
        ...throttleBinding(channel, inverted),
        low,
        centre: rest,
        high,
      });
    } else {
      // Nose up, right wing down and right rudder are all the positive
      // direction, so a channel that fell when held has to be inverted.
      this.assigned.set(axis, {
        ...controlBinding(channel, held < rest),
        low,
        centre: rest,
        high,
      });
    }
    this.usedChannels.add(channel);
  }

  private next(): void {
    this.index = Math.min(this.index + 1, ORDER.length - 1);
    this.elapsed = 0;
    this.held = 0;
    this.candidateChannel = UNBOUND;
  }

  /** Ends a timed step early, or gives up on a control and leaves it alone. */
  skip(): void {
    if (this.step === CALIBRATION_STEP.Centre && this.restSamples > 0) {
      for (let channel = 0; channel < this.total; channel += 1) {
        this.rest[channel] = (this.restSum[channel] ?? 0) / this.restSamples;
        this.low[channel] = this.rest[channel] ?? 0;
        this.high[channel] = this.rest[channel] ?? 0;
      }
    }
    this.next();
  }

  /**
   * The profile learnt so far, laid over the previous one.
   *
   * A skipped control keeps whatever it had, so a pilot can recalibrate a
   * single sticky axis without losing the rest of a working setup.
   */
  profile(previous?: ControllerProfile): ControllerProfile {
    const base =
      previous ??
      defaultProfile(this.deviceId, "", this.axisCount, this.buttonCount);
    const axes = { ...base.axes };
    for (const [axis, binding] of this.assigned) axes[axis] = binding;
    return {
      deviceId: this.deviceId,
      axisCount: this.axisCount,
      buttonCount: this.buttonCount,
      layout:
        this.assigned.size > 0 ? CONTROLLER_LAYOUT.Calibrated : base.layout,
      axes,
      actions: { ...base.actions },
    };
  }
}

/**
 * The channel a pilot has just pressed, for binding a button to an action.
 *
 * `rest` is what the device reads untouched, so a trigger that idles at zero
 * and a switch that idles closed are both handled without knowing which is
 * which.
 */
export function detectPressedChannel(
  snapshot: ControllerSnapshot,
  rest: readonly number[],
  threshold = 0.6,
): number {
  const total = channelCount(snapshot);
  for (let channel = 0; channel < total; channel += 1) {
    const delta = Math.abs(
      channelValue(snapshot, channel) - (rest[channel] ?? 0),
    );
    if (delta >= threshold) return channel;
  }
  return UNBOUND;
}

/** A snapshot flattened into the plain array `detectPressedChannel` wants. */
export function flattenChannels(snapshot: ControllerSnapshot): number[] {
  const total = channelCount(snapshot);
  const out = new Array<number>(total);
  for (let channel = 0; channel < total; channel += 1) {
    out[channel] = channelValue(snapshot, channel);
  }
  return out;
}
