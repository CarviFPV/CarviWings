/**
 * Controller mapping: raw device channels to normalised `FlightInput`.
 *
 * Nothing here touches the Gamepad API, the DOM or React. It works on a flat
 * array of channel readings, so the same code maps a game pad, a USB joystick
 * and an RC transmitter, and every part of it can be tested in Node against
 * plain numbers.
 *
 * A "channel" is one continuous reading from the device. Axes come first and
 * buttons follow, because an analogue trigger on a game pad is exposed as a
 * button with a 0..1 pressure value and makes a perfectly good throttle. That
 * flattening is what lets a single index refer to anything the device offers.
 *
 * No layout is assumed to be correct. The defaults below are labelled guesses
 * that let an unconfigured device fly immediately; the calibration in
 * `controllerCalibration.ts` is what establishes the truth for a given device.
 */

import { clamp } from "../math/scalar";
import type { FlightInput } from "./types";

export interface ControllerSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly number[];
}

export const UNBOUND = -1;

/** Smallest calibrated travel that still divides sensibly. */
const MIN_SPAN = 0.05;
const MAX_BIPOLAR_DEADZONE = 0.45;
const MAX_UNIPOLAR_DEADZONE = 0.3;
const MAX_EXPO = 0.9;

export function channelCount(snapshot: ControllerSnapshot): number {
  return snapshot.axes.length + snapshot.buttons.length;
}

export function channelValue(
  snapshot: ControllerSnapshot,
  index: number,
): number {
  if (index < 0) return 0;
  if (index < snapshot.axes.length) return snapshot.axes[index] ?? 0;
  return snapshot.buttons[index - snapshot.axes.length] ?? 0;
}

/** Human-readable name for a flat channel index. */
export function channelLabel(index: number, axisCount: number): string {
  if (index < 0) return "—";
  return index < axisCount ? `AXIS ${index}` : `BTN ${index - axisCount}`;
}

// --- Bindings --------------------------------------------------------------

export const CONTROL_AXIS = {
  Pitch: "pitch",
  Roll: "roll",
  Yaw: "yaw",
  Throttle: "throttle",
} as const;

export type ControlAxis = (typeof CONTROL_AXIS)[keyof typeof CONTROL_AXIS];

export const CONTROL_AXES: readonly ControlAxis[] = [
  CONTROL_AXIS.Pitch,
  CONTROL_AXIS.Roll,
  CONTROL_AXIS.Yaw,
  CONTROL_AXIS.Throttle,
];

/** Pitch, roll and yaw are centred; throttle runs end to end. */
export function isBipolar(axis: ControlAxis): boolean {
  return axis !== CONTROL_AXIS.Throttle;
}

export interface AxisBinding {
  /** Flat channel index, or `UNBOUND`. */
  readonly channel: number;
  readonly inverted: boolean;
  /**
   * Fraction of travel that reads as no input. Centred for a control axis,
   * split between both ends for the throttle so it reliably reaches 0 and 1.
   */
  readonly deadzone: number;
  /** Scales the commanded deflection. Control axes only. */
  readonly sensitivity: number;
  /** Softens the centre of the travel without moving the endpoints, 0..0.9. */
  readonly expo: number;
  /** Raw reading at full negative deflection, or at idle throttle. */
  readonly low: number;
  /** Raw reading at rest. Meaningless for the throttle. */
  readonly centre: number;
  /** Raw reading at full positive deflection, or at full throttle. */
  readonly high: number;
}

export const CONTROLLER_ACTION = {
  Camera: "camera",
  CycleTarget: "cycleTarget",
  Minimap: "minimap",
  Pause: "pause",
  FlightMode: "flightMode",
  CourseHold: "courseHold",
  AltitudeHold: "altitudeHold",
  ReturnHome: "returnHome",
} as const;

export type ControllerAction =
  (typeof CONTROLLER_ACTION)[keyof typeof CONTROLLER_ACTION];

export const CONTROLLER_ACTIONS: readonly ControllerAction[] = [
  CONTROLLER_ACTION.Camera,
  CONTROLLER_ACTION.CycleTarget,
  CONTROLLER_ACTION.Minimap,
  CONTROLLER_ACTION.Pause,
  CONTROLLER_ACTION.FlightMode,
  CONTROLLER_ACTION.CourseHold,
  CONTROLLER_ACTION.AltitudeHold,
  CONTROLLER_ACTION.ReturnHome,
];

/** How a profile's axis assignment came about. */
export const CONTROLLER_LAYOUT = {
  /** The W3C standard game pad mapping, which the browser vouches for. */
  Standard: "STANDARD",
  /** The usual aileron / elevator / throttle / rudder order of an RC radio. */
  Aetr: "AETR",
  /** Established by calibrating this particular device. */
  Calibrated: "CALIBRATED",
  /** Edited by hand. */
  Custom: "CUSTOM",
} as const;

export type ControllerLayout =
  (typeof CONTROLLER_LAYOUT)[keyof typeof CONTROLLER_LAYOUT];

export interface ControllerProfile {
  /** The device string this profile was built for. */
  readonly deviceId: string;
  readonly axisCount: number;
  readonly buttonCount: number;
  readonly layout: ControllerLayout;
  readonly axes: Readonly<Record<ControlAxis, AxisBinding>>;
  readonly actions: Readonly<Record<ControllerAction, number>>;
}

// --- Mapping ---------------------------------------------------------------

/** Signed travel between two calibrated endpoints, never small enough to blow up. */
function span(from: number, to: number): number {
  const delta = to - from;
  if (Math.abs(delta) >= MIN_SPAN) return delta;
  return delta < 0 ? -MIN_SPAN : MIN_SPAN;
}

/** Removes a centred dead band and rescales what is left back to full travel. */
function centredDeadzone(value: number, deadzone: number): number {
  const dz = clamp(deadzone, 0, MAX_BIPOLAR_DEADZONE);
  const magnitude = Math.abs(value);
  if (magnitude <= dz) return 0;
  const scaled = (magnitude - dz) / (1 - dz);
  return value < 0 ? -scaled : scaled;
}

/**
 * The RC expo curve: softer around centre, identical at the endpoints.
 *
 * `expo` 0 is a straight line and 0.9 is very soft, and the curve stays
 * monotonic throughout so a larger stick movement is always a larger command.
 */
export function applyExpo(value: number, expo: number): number {
  const e = clamp(expo, 0, MAX_EXPO);
  return value * (e * value * value + (1 - e));
}

/** Maps one raw reading to a centred -1..1 control command. */
export function mapBipolar(raw: number, binding: AxisBinding): number {
  if (binding.channel === UNBOUND) return 0;
  const offset = raw - binding.centre;
  const travel =
    raw >= binding.centre
      ? span(binding.centre, binding.high)
      : span(binding.low, binding.centre);
  let value = clamp(offset / travel, -1, 1);
  if (binding.inverted) value = -value;
  value = centredDeadzone(value, binding.deadzone);
  value = applyExpo(value, binding.expo);
  return clamp(value * binding.sensitivity, -1, 1);
}

/**
 * Maps one raw reading to a 0..1 throttle setting.
 *
 * Sensitivity and expo are deliberately not applied. A throttle at half
 * sensitivity would simply be an aircraft that cannot reach full power, which
 * is a worse aeroplane rather than a gentler one. The dead band instead sits
 * at both ends of the travel, so a stick that stops a little short of its
 * mechanical limit still commands idle and full power.
 */
export function mapUnipolar(raw: number, binding: AxisBinding): number {
  if (binding.channel === UNBOUND) return 0;
  let value = clamp((raw - binding.low) / span(binding.low, binding.high), 0, 1);
  if (binding.inverted) value = 1 - value;
  const dz = clamp(binding.deadzone, 0, MAX_UNIPOLAR_DEADZONE);
  if (dz > 0) value = clamp((value - dz) / (1 - 2 * dz), 0, 1);
  return value;
}

/**
 * Fills `out` from a device snapshot.
 *
 * `sensitivityScale` is the global controller sensitivity from settings; it
 * multiplies the per-axis figure so one slider can calm the whole device down
 * without disturbing a calibration.
 */
export function applyProfile(
  out: FlightInput,
  snapshot: ControllerSnapshot,
  profile: ControllerProfile,
  sensitivityScale = 1,
): FlightInput {
  const scale = clamp(sensitivityScale, 0.1, 2);
  const axes = profile.axes;
  out.pitch = clamp(
    mapBipolar(channelValue(snapshot, axes.pitch.channel), axes.pitch) * scale,
    -1,
    1,
  );
  out.roll = clamp(
    mapBipolar(channelValue(snapshot, axes.roll.channel), axes.roll) * scale,
    -1,
    1,
  );
  out.yaw = clamp(
    mapBipolar(channelValue(snapshot, axes.yaw.channel), axes.yaw) * scale,
    -1,
    1,
  );
  out.throttle = mapUnipolar(
    channelValue(snapshot, axes.throttle.channel),
    axes.throttle,
  );
  return out;
}

/** True while the channel bound to `action` is pressed. */
export function isActionPressed(
  snapshot: ControllerSnapshot,
  profile: ControllerProfile,
  action: ControllerAction,
): boolean {
  const channel = profile.actions[action];
  if (channel === UNBOUND) return false;
  return channelValue(snapshot, channel) >= PRESS_THRESHOLD;
}

/** A button reads 0 or 1; an analogue trigger sweeps between them. */
export const PRESS_THRESHOLD = 0.5;

// --- Defaults --------------------------------------------------------------

const DEFAULT_CONTROL: Omit<AxisBinding, "channel" | "inverted"> = {
  deadzone: 0.06,
  sensitivity: 1,
  expo: 0.3,
  low: -1,
  centre: 0,
  high: 1,
};

const DEFAULT_THROTTLE: Omit<AxisBinding, "channel" | "inverted"> = {
  deadzone: 0.04,
  sensitivity: 1,
  expo: 0,
  low: -1,
  centre: 0,
  high: 1,
};

export function controlBinding(channel: number, inverted: boolean): AxisBinding {
  return { ...DEFAULT_CONTROL, channel, inverted };
}

export function throttleBinding(
  channel: number,
  inverted: boolean,
): AxisBinding {
  return { ...DEFAULT_THROTTLE, channel, inverted };
}

const NO_ACTIONS: Record<ControllerAction, number> = {
  camera: UNBOUND,
  cycleTarget: UNBOUND,
  minimap: UNBOUND,
  pause: UNBOUND,
  flightMode: UNBOUND,
  courseHold: UNBOUND,
  altitudeHold: UNBOUND,
  returnHome: UNBOUND,
};

/**
 * A first guess at how a freshly connected device is laid out.
 *
 * When the browser reports the W3C standard mapping it is telling us exactly
 * where the sticks are, so that layout is used: right stick flies the aircraft,
 * left stick holds rudder and throttle, and the four face buttons and Start
 * carry the view actions.
 *
 * Anything else — a USB joystick, an RC transmitter in game-pad mode — gets the
 * aileron / elevator / throttle / rudder order that radios conventionally send,
 * flagged as a guess so the interface can say so and ask for a calibration.
 */
export function defaultProfile(
  deviceId: string,
  mapping: string,
  axisCount: number,
  buttonCount: number,
): ControllerProfile {
  if (mapping === "standard" && axisCount >= 4) {
    return {
      deviceId,
      axisCount,
      buttonCount,
      layout: CONTROLLER_LAYOUT.Standard,
      axes: {
        // Right stick: X banks, Y pitches. The standard mapping reads -1 with
        // the stick forward, which is already nose down, so pitch needs no
        // inversion — a control column pulled back raises the nose.
        roll: controlBinding(2, false),
        pitch: controlBinding(3, false),
        // Left stick: X is rudder, Y is throttle with forward as full power.
        yaw: controlBinding(0, false),
        throttle: throttleBinding(1, true),
      },
      actions: {
        ...NO_ACTIONS,
        camera: buttonCount > 3 ? axisCount + 3 : UNBOUND,
        cycleTarget: buttonCount > 2 ? axisCount + 2 : UNBOUND,
        minimap: buttonCount > 0 ? axisCount + 0 : UNBOUND,
        pause: buttonCount > 9 ? axisCount + 9 : UNBOUND,
        // The shoulders are where a radio puts its mode switches, and they
        // are the two buttons a thumb is not already using to fly.
        flightMode: buttonCount > 4 ? axisCount + 4 : UNBOUND,
        returnHome: buttonCount > 5 ? axisCount + 5 : UNBOUND,
      },
    };
  }

  return {
    deviceId,
    axisCount,
    buttonCount,
    layout: CONTROLLER_LAYOUT.Aetr,
    axes: {
      roll: controlBinding(axisCount > 0 ? 0 : UNBOUND, false),
      pitch: controlBinding(axisCount > 1 ? 1 : UNBOUND, true),
      throttle: throttleBinding(axisCount > 2 ? 2 : UNBOUND, false),
      yaw: controlBinding(axisCount > 3 ? 3 : UNBOUND, false),
    },
    actions: { ...NO_ACTIONS },
  };
}

// --- Editing ---------------------------------------------------------------

/** Returns a copy of `profile` with one field of one axis changed. */
export function withAxisChange(
  profile: ControllerProfile,
  axis: ControlAxis,
  change: Partial<AxisBinding>,
): ControllerProfile {
  return {
    ...profile,
    layout:
      profile.layout === CONTROLLER_LAYOUT.Calibrated
        ? CONTROLLER_LAYOUT.Calibrated
        : CONTROLLER_LAYOUT.Custom,
    axes: { ...profile.axes, [axis]: { ...profile.axes[axis], ...change } },
  };
}

export function withActionChange(
  profile: ControllerProfile,
  action: ControllerAction,
  channel: number,
): ControllerProfile {
  return {
    ...profile,
    actions: { ...profile.actions, [action]: channel },
  };
}

/**
 * Repairs a profile loaded from storage.
 *
 * Settings outlive the hardware they were written for. A profile that names
 * channels a device no longer has would silently command nothing, so anything
 * out of range is unbound and anything non-finite falls back to its default.
 */
export function reconcileProfile(
  profile: ControllerProfile,
  axisCount: number,
  buttonCount: number,
): ControllerProfile {
  const total = axisCount + buttonCount;
  const fix = (binding: AxisBinding, fallback: AxisBinding): AxisBinding => {
    const channel =
      Number.isInteger(binding.channel) &&
      binding.channel >= 0 &&
      binding.channel < total
        ? binding.channel
        : UNBOUND;
    const number = (value: number, spare: number): number =>
      Number.isFinite(value) ? value : spare;
    return {
      channel,
      inverted: binding.inverted === true,
      deadzone: clamp(number(binding.deadzone, fallback.deadzone), 0, 0.45),
      sensitivity: clamp(
        number(binding.sensitivity, fallback.sensitivity),
        0.2,
        1.5,
      ),
      expo: clamp(number(binding.expo, fallback.expo), 0, MAX_EXPO),
      low: number(binding.low, fallback.low),
      centre: number(binding.centre, fallback.centre),
      high: number(binding.high, fallback.high),
    };
  };

  const spare = defaultProfile(
    profile.deviceId,
    "",
    Math.max(axisCount, 4),
    buttonCount,
  );
  const actions: Record<ControllerAction, number> = { ...NO_ACTIONS };
  for (const action of CONTROLLER_ACTIONS) {
    const channel = profile.actions?.[action] ?? UNBOUND;
    actions[action] =
      Number.isInteger(channel) && channel >= 0 && channel < total
        ? channel
        : UNBOUND;
  }

  return {
    deviceId: profile.deviceId,
    axisCount,
    buttonCount,
    layout: profile.layout ?? CONTROLLER_LAYOUT.Custom,
    axes: {
      pitch: fix(profile.axes.pitch, spare.axes.pitch),
      roll: fix(profile.axes.roll, spare.axes.roll),
      yaw: fix(profile.axes.yaw, spare.axes.yaw),
      throttle: fix(profile.axes.throttle, spare.axes.throttle),
    },
    actions,
  };
}
