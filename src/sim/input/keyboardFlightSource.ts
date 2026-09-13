"use client";

/**
 * Turns keyboard state into normalised `FlightInput`.
 *
 * A key is either down or up, but a control surface is not: slamming the
 * elevator to full deflection the instant a key is tapped feels nothing like an
 * aircraft. So the axes ramp toward their commanded position and spring back to
 * centre when released, which is also how a real stick behaves. A gamepad
 * source will skip all of this and hand its analogue axes straight through.
 *
 * Throttle is integrated rather than ramped: holding W raises it and it stays
 * where it is left, exactly like a throttle stick.
 */

import { clamp, moveTowards } from "../math/scalar";
import type { FlightInput } from "./types";
import { createFlightInput } from "./types";
import type { Keyboard } from "./keyboard";
import type { FlightAction, KeyCode } from "./keyBindings";
import { DEFAULT_KEY_BINDINGS, flightBindings } from "./keyBindings";

/** Which key flies each axis. The full table lives in `keyBindings.ts`. */
export type KeyboardFlightBindings = Readonly<Record<FlightAction, KeyCode>>;

export const DEFAULT_FLIGHT_BINDINGS: KeyboardFlightBindings =
  flightBindings(DEFAULT_KEY_BINDINGS);

export interface KeyboardFlightOptions {
  /** Axis units per second while a key is held. */
  readonly rampRate?: number;
  /** Axis units per second while returning to centre. */
  readonly centreRate?: number;
  /** Throttle units per second. */
  readonly throttleRate?: number;
  /** Scales the final pitch/roll/yaw deflection, 0..1. */
  readonly sensitivity?: number;
}

export class KeyboardFlightSource {
  private readonly keyboard: Keyboard;
  private bindings: KeyboardFlightBindings;
  private readonly input: FlightInput = createFlightInput();

  private rampRate: number;
  private centreRate: number;
  private throttleRate: number;
  private sensitivity: number;

  private pitchAxis = 0;
  private rollAxis = 0;
  private yawAxis = 0;
  private throttle = 0;

  constructor(
    keyboard: Keyboard,
    bindings: KeyboardFlightBindings = DEFAULT_FLIGHT_BINDINGS,
    options: KeyboardFlightOptions = {},
  ) {
    this.keyboard = keyboard;
    this.bindings = bindings;
    this.rampRate = options.rampRate ?? 3.2;
    this.centreRate = options.centreRate ?? 4.5;
    this.throttleRate = options.throttleRate ?? 0.8;
    this.sensitivity = options.sensitivity ?? 1;
  }

  /**
   * Swaps the key layout mid-flight.
   *
   * The ramped axis positions are deliberately left where they are: rebinding
   * pitch does not move the elevator, and a key released under the old layout
   * simply springs back to centre like any other.
   */
  setBindings(bindings: KeyboardFlightBindings): void {
    this.bindings = bindings;
  }

  setSensitivity(value: number): void {
    this.sensitivity = clamp(value, 0.1, 1);
  }

  setThrottle(value: number): void {
    this.throttle = clamp(value, 0, 1);
  }

  get throttleValue(): number {
    return this.throttle;
  }

  private axis(
    current: number,
    negative: boolean,
    positive: boolean,
    dt: number,
  ): number {
    const target = (positive ? 1 : 0) - (negative ? 1 : 0);
    if (target === 0) return moveTowards(current, 0, this.centreRate * dt);
    return moveTowards(current, target, this.rampRate * dt);
  }

  sample(dt: number): FlightInput {
    const k = this.keyboard;
    const b = this.bindings;

    this.pitchAxis = this.axis(
      this.pitchAxis,
      k.isDown(b.pitchDown),
      k.isDown(b.pitchUp),
      dt,
    );
    this.rollAxis = this.axis(
      this.rollAxis,
      k.isDown(b.rollLeft),
      k.isDown(b.rollRight),
      dt,
    );
    this.yawAxis = this.axis(
      this.yawAxis,
      k.isDown(b.yawLeft),
      k.isDown(b.yawRight),
      dt,
    );

    if (k.isDown(b.throttleUp)) this.throttle += this.throttleRate * dt;
    if (k.isDown(b.throttleDown)) this.throttle -= this.throttleRate * dt;
    this.throttle = clamp(this.throttle, 0, 1);

    this.input.pitch = this.pitchAxis * this.sensitivity;
    this.input.roll = this.rollAxis * this.sensitivity;
    this.input.yaw = this.yawAxis * this.sensitivity;
    this.input.throttle = this.throttle;
    return this.input;
  }

  reset(throttle = 0): void {
    this.pitchAxis = 0;
    this.rollAxis = 0;
    this.yawAxis = 0;
    this.throttle = clamp(throttle, 0, 1);
  }
}
