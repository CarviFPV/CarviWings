"use client";

/**
 * Raw Gamepad API polling.
 *
 * Deliberately dumb, in the same way `keyboard.ts` is: it knows which device
 * is attached and what its channels currently read, and nothing whatever about
 * what any of them mean. The meaning lives in `controllerProfile.ts`, which is
 * why that half can be tested without a browser.
 *
 * Browsers hide game pads until the page has seen a gesture from one, so a
 * device can be plugged in and still invisible until a button is pressed. That
 * is not an error state, and the interface says so rather than reporting a
 * fault.
 */

import type { ControllerSnapshot } from "./controllerProfile";

export interface GamepadDevice {
  readonly index: number;
  readonly id: string;
  /** "standard" when the browser vouches for the W3C layout. */
  readonly mapping: string;
  readonly axisCount: number;
  readonly buttonCount: number;
}

const EMPTY: ControllerSnapshot = { axes: [], buttons: [] };

export class GamepadReader {
  private axes: number[] = [];
  private buttons: number[] = [];
  private snapshot: ControllerSnapshot = EMPTY;
  private device: GamepadDevice | null = null;
  private attached = false;
  private changeCount = 0;

  private readonly onChange = (): void => {
    this.changeCount += 1;
  };

  attach(target: Window = window): void {
    if (this.attached) return;
    this.attached = true;
    target.addEventListener("gamepadconnected", this.onChange);
    target.addEventListener("gamepaddisconnected", this.onChange);
  }

  detach(target: Window = window): void {
    if (!this.attached) return;
    this.attached = false;
    target.removeEventListener("gamepadconnected", this.onChange);
    target.removeEventListener("gamepaddisconnected", this.onChange);
    this.device = null;
    this.snapshot = EMPTY;
  }

  /**
   * Bumped whenever a device is plugged in or pulled out.
   *
   * React watches this rather than the snapshot: the readings change sixty
   * times a second and must never cause a render, but the arrival of a new
   * controller genuinely is a change of state.
   */
  get generation(): number {
    return this.changeCount;
  }

  get connected(): boolean {
    return this.device !== null;
  }

  get deviceInfo(): GamepadDevice | null {
    return this.device;
  }

  get values(): ControllerSnapshot {
    return this.snapshot;
  }

  /** Reads the first connected pad. Must be called every frame. */
  poll(): void {
    if (typeof navigator === "undefined" || !navigator.getGamepads) {
      this.device = null;
      this.snapshot = EMPTY;
      return;
    }
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (const candidate of pads) {
      if (candidate && candidate.connected) {
        pad = candidate;
        break;
      }
    }
    if (!pad) {
      if (this.device !== null) {
        this.device = null;
        this.changeCount += 1;
      }
      this.snapshot = EMPTY;
      return;
    }

    if (
      !this.device ||
      this.device.index !== pad.index ||
      this.device.id !== pad.id
    ) {
      this.device = {
        index: pad.index,
        id: pad.id,
        mapping: pad.mapping,
        axisCount: pad.axes.length,
        buttonCount: pad.buttons.length,
      };
      this.axes = new Array<number>(pad.axes.length).fill(0);
      this.buttons = new Array<number>(pad.buttons.length).fill(0);
      this.snapshot = { axes: this.axes, buttons: this.buttons };
      this.changeCount += 1;
    }

    for (let i = 0; i < this.axes.length; i += 1) {
      this.axes[i] = pad.axes[i] ?? 0;
    }
    for (let i = 0; i < this.buttons.length; i += 1) {
      const button = pad.buttons[i];
      this.buttons[i] = button ? button.value : 0;
    }
  }
}

/**
 * A short, readable name for a device.
 *
 * Browsers report identifiers like
 * `RadioMaster TX16S Joystick (Vendor: 1209 Product: 4f54)`; the vendor and
 * product codes matter for storage but not on screen.
 */
export function deviceDisplayName(id: string): string {
  const trimmed = id.replace(/\s*\((?:Vendor|STANDARD GAMEPAD)[^)]*\)\s*$/i, "");
  return (trimmed || id).trim();
}
