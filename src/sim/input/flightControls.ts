"use client";

/**
 * The single place the aircraft gets its controls from.
 *
 * The flight model consumes `FlightInput` and knows nothing about where it
 * came from, so keyboard and controller do not need a mode switch between
 * them: whichever the pilot touched last is the one flying. Picking up the
 * controller mid-flight works, and so does dropping it and reaching for the
 * arrow keys.
 *
 * Controller buttons are delivered as the hotkey codes the session already
 * acts on. That keeps one code path for "toggle the camera" whether the
 * request came from a key or a button, rather than a second, differently
 * tested one.
 */

import { clamp } from "../math/scalar";
import type { FlightInput } from "./types";
import { createFlightInput } from "./types";
import { Keyboard } from "./keyboard";
import { KeyboardFlightSource } from "./keyboardFlightSource";
import type { KeyAction, KeyBindings } from "./keyBindings";
import {
  DEFAULT_KEY_BINDINGS,
  FLIGHT_ACTIONS,
  boundKeys,
  flightBindings,
} from "./keyBindings";
import type { GamepadDevice } from "./gamepad";
import { GamepadReader } from "./gamepad";
import type {
  ControllerAction,
  ControllerProfile,
  ControllerSnapshot,
} from "./controllerProfile";
import {
  CONTROLLER_ACTIONS,
  PRESS_THRESHOLD,
  UNBOUND,
  applyProfile,
  channelValue,
} from "./controllerProfile";

export const INPUT_DEVICE = {
  Keyboard: "KEYBOARD",
  Controller: "CONTROLLER",
} as const;

export type InputDevice = (typeof INPUT_DEVICE)[keyof typeof INPUT_DEVICE];

/** Which keyboard action each controller button stands in for. */
const ACTION_KEY_ACTION: Record<ControllerAction, KeyAction> = {
  camera: "camera",
  cycleTarget: "cycleTarget",
  minimap: "minimap",
  pause: "pause",
  flightMode: "flightMode",
  courseHold: "courseHold",
  altitudeHold: "altitudeHold",
  returnHome: "returnHome",
};

/** Stick deflection that counts as flying rather than drift. */
const ACTIVE_DEFLECTION = 0.12;
/** Raw channel movement between polls that counts as a deliberate input. */
const ACTIVE_MOVEMENT = 0.03;

/**
 * The part of a controller `FlightControls` actually needs.
 *
 * `GamepadReader` is the real implementation; the interface exists so the
 * handover between keyboard and controller — the part with the sharpest edges
 * — can be driven from a script of stick positions in Node rather than only
 * by a person with a transmitter.
 */
export interface ControllerReader {
  attach(): void;
  detach(): void;
  poll(): void;
  readonly connected: boolean;
  readonly values: ControllerSnapshot;
  readonly deviceInfo: GamepadDevice | null;
}

export interface FlightControlsOptions {
  readonly flightSensitivity?: number;
  readonly controllerSensitivity?: number;
  readonly bindings?: KeyBindings;
  readonly reader?: ControllerReader;
  /**
   * Supplies the mapping for a device as it appears.
   *
   * Profiles are stored per device and browsers keep a controller hidden
   * until it has been used, so the right mapping frequently cannot be known
   * when a flight starts. Resolving on arrival is also what makes plugging a
   * transmitter in mid-flight work.
   */
  readonly resolveProfile?: (device: GamepadDevice) => ControllerProfile | null;
}

export class FlightControls {
  readonly keyboard: Keyboard;
  readonly gamepad: ControllerReader;

  private readonly keyboardSource: KeyboardFlightSource;
  private bindings: KeyBindings;
  private readonly controllerInput: FlightInput = createFlightInput();
  private readonly pendingPresses = new Set<string>();
  private readonly actionHeld = new Set<ControllerAction>();

  private profile: ControllerProfile | null = null;
  private readonly resolveProfile:
    | ((device: GamepadDevice) => ControllerProfile | null)
    | null;
  private resolvedDeviceId: string | null = null;
  private controllerSensitivity: number;
  private previousChannels: number[] = [];
  private device: InputDevice = INPUT_DEVICE.Keyboard;

  constructor(options: FlightControlsOptions = {}) {
    this.keyboard = new Keyboard();
    this.gamepad = options.reader ?? new GamepadReader();
    this.bindings = options.bindings ?? DEFAULT_KEY_BINDINGS;
    this.keyboardSource = new KeyboardFlightSource(
      this.keyboard,
      flightBindings(this.bindings),
      { sensitivity: options.flightSensitivity ?? 1 },
    );
    this.keyboard.setSwallowed(boundKeys(this.bindings));
    this.controllerSensitivity = clamp(
      options.controllerSensitivity ?? 1,
      0.1,
      2,
    );
    this.resolveProfile = options.resolveProfile ?? null;
  }

  attach(): void {
    this.keyboard.attach();
    this.gamepad.attach();
  }

  detach(): void {
    this.keyboard.detach();
    this.gamepad.detach();
    this.pendingPresses.clear();
    this.actionHeld.clear();
  }

  /**
   * Swaps the key layout without interrupting the flight.
   *
   * Queued button edges are dropped with it: they were recorded as the key
   * the old layout had on that action, and delivering them under the new one
   * would fire whatever has since taken that key.
   */
  setBindings(bindings: KeyBindings): void {
    this.bindings = bindings;
    this.keyboardSource.setBindings(flightBindings(bindings));
    this.keyboard.setSwallowed(boundKeys(bindings));
    this.pendingPresses.clear();
  }

  get keyBindings(): KeyBindings {
    return this.bindings;
  }

  setProfile(profile: ControllerProfile | null): void {
    this.profile = profile;
    this.actionHeld.clear();
  }

  get controllerProfile(): ControllerProfile | null {
    return this.profile;
  }

  setControllerSensitivity(value: number): void {
    this.controllerSensitivity = clamp(value, 0.1, 2);
  }

  setFlightSensitivity(value: number): void {
    this.keyboardSource.setSensitivity(value);
  }

  get activeDevice(): InputDevice {
    return this.device;
  }

  get controllerConnected(): boolean {
    return this.gamepad.connected;
  }

  get controllerName(): string | null {
    return this.gamepad.deviceInfo?.id ?? null;
  }

  /**
   * Reads the device: resolves its profile and queues any button edges.
   *
   * Called once at the top of a frame, before hotkeys are polled, and
   * deliberately not tied to the physics step. Flight input is only produced
   * while the simulation is running, but a button has to keep working when it
   * is not — otherwise a pilot flying on a controller could pause and then
   * have no way to resume.
   */
  poll(): void {
    this.gamepad.poll();

    const info = this.gamepad.deviceInfo;
    const deviceId = info?.id ?? null;
    if (deviceId !== this.resolvedDeviceId) {
      this.resolvedDeviceId = deviceId;
      if (this.resolveProfile) {
        this.profile = info ? this.resolveProfile(info) : null;
      }
      this.actionHeld.clear();
      this.previousChannels = [];
    }

    if (this.gamepad.connected && this.profile) {
      this.pollActions(this.gamepad.values);
    }
  }

  /**
   * Produces this frame's control positions.
   *
   * Both sources are advanced every frame whichever is flying, so the
   * keyboard's ramped axes are always current and a handover never starts
   * from a stale position. Which device is flying is decided before either is
   * sampled: the keyboard's throttle has to be handed the controller's
   * setting *before* its axes are advanced, or the frame of the handover
   * flies on a stale power setting.
   */
  sample(dt: number): FlightInput {
    // Polling again is harmless — a held button is already recorded as held,
    // so no edge is invented — and it means a caller driving this on its own
    // still gets a live reading.
    this.poll();

    const usable = this.gamepad.connected && this.profile !== null;
    if (usable && this.profile) {
      const snapshot = this.gamepad.values;
      applyProfile(
        this.controllerInput,
        snapshot,
        this.profile,
        this.controllerSensitivity,
      );
      if (this.controllerIsBeingUsed(snapshot)) {
        this.device = INPUT_DEVICE.Controller;
      }
    } else if (this.device === INPUT_DEVICE.Controller) {
      // The controller went away mid-flight. Hand the throttle over rather
      // than dropping to idle, which would be a dead stick at altitude.
      this.keyboardSource.setThrottle(this.controllerInput.throttle);
      this.device = INPUT_DEVICE.Keyboard;
    }

    if (this.keyboardIsBeingUsed()) {
      if (this.device === INPUT_DEVICE.Controller) {
        // A physical throttle *is* its position, so there is nothing to carry
        // back the other way; the keyboard simply resumes from where the
        // controller left the power.
        this.keyboardSource.setThrottle(this.controllerInput.throttle);
      }
      this.device = INPUT_DEVICE.Keyboard;
    }

    const keyboardInput = this.keyboardSource.sample(dt);
    return this.device === INPUT_DEVICE.Controller
      ? this.controllerInput
      : keyboardInput;
  }

  private keyboardIsBeingUsed(): boolean {
    for (const action of FLIGHT_ACTIONS) {
      if (this.keyboard.isDown(this.bindings[action])) return true;
    }
    return false;
  }

  /**
   * True while the pilot is holding a stick off centre or has just moved one.
   *
   * Both tests are needed. Deflection alone would ignore a throttle-only
   * device that never centres; movement alone would drop the controller the
   * moment a pilot settled into a steady turn.
   */
  private controllerIsBeingUsed(snapshot: ControllerSnapshot): boolean {
    const deflected =
      Math.abs(this.controllerInput.pitch) > ACTIVE_DEFLECTION ||
      Math.abs(this.controllerInput.roll) > ACTIVE_DEFLECTION ||
      Math.abs(this.controllerInput.yaw) > ACTIVE_DEFLECTION;

    let moved = false;
    const total = snapshot.axes.length + snapshot.buttons.length;
    if (this.previousChannels.length !== total) {
      this.previousChannels = new Array<number>(total).fill(0);
      for (let i = 0; i < total; i += 1) {
        this.previousChannels[i] = channelValue(snapshot, i);
      }
      return deflected;
    }
    for (let i = 0; i < total; i += 1) {
      const value = channelValue(snapshot, i);
      if (Math.abs(value - (this.previousChannels[i] ?? value)) > ACTIVE_MOVEMENT) {
        moved = true;
      }
      this.previousChannels[i] = value;
    }
    return deflected || moved;
  }

  /** Turns button edges into the hotkey codes the session already handles. */
  private pollActions(snapshot: ControllerSnapshot): void {
    if (!this.profile) return;
    for (const action of CONTROLLER_ACTIONS) {
      const channel = this.profile.actions[action];
      if (channel === UNBOUND) {
        this.actionHeld.delete(action);
        continue;
      }
      const pressed = channelValue(snapshot, channel) >= PRESS_THRESHOLD;
      if (pressed && !this.actionHeld.has(action)) {
        this.actionHeld.add(action);
        const code = this.bindings[ACTION_KEY_ACTION[action]];
        if (code) this.pendingPresses.add(code);
      } else if (!pressed) {
        this.actionHeld.delete(action);
      }
    }
  }

  /** True once per press, from either the keyboard or a bound button. */
  consumePress(code: string): boolean {
    if (code === "") return false;
    if (this.pendingPresses.delete(code)) return true;
    return this.keyboard.consumePress(code);
  }

  /**
   * True once per press of whatever key `action` is currently bound to.
   *
   * The session works in actions rather than key codes so that rebinding a
   * control is a change to one table instead of to every place that reacts
   * to it. An unbound action simply never fires.
   */
  consumeAction(action: KeyAction): boolean {
    return this.consumePress(this.bindings[action]);
  }

  /**
   * Drops key press edges nothing consumed.
   *
   * Controller edges are deliberately kept. A key press arrives from a DOM
   * event between frames and is polled at the top of the next one, so an
   * unconsumed one is genuinely stale; a button edge is produced during the
   * frame itself, and clearing it here threw every one of them away before
   * anything could act on it. The queue cannot grow — it holds at most one
   * entry per bound action.
   */
  endFrame(): void {
    this.keyboard.endFrame();
  }

  releaseAll(): void {
    this.keyboard.releaseAll();
    this.pendingPresses.clear();
    // `actionHeld` is the physical state of the buttons, not queued input.
    // Clearing it would make a button still being held look newly pressed,
    // and the press that opened the pause menu would immediately close it.
  }

  reset(throttle = 0): void {
    this.keyboardSource.reset(throttle);
  }
}
