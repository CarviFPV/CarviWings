/**
 * Stick rates: how fast an airframe answers the sticks.
 *
 * The same idea Betaflight and INAV are set up with, and deliberately the same
 * vocabulary. A rate is the rotation the aircraft is asked for at full stick,
 * in degrees per second, and the expo is how much of the stick's travel is
 * spent being gentle around centre. Nothing here is aerodynamics: the numbers
 * describe what the pilot is asking for, and the flight controller's rate loop
 * is what goes and gets it out of the airframe.
 *
 * Rates belong to an aircraft rather than to a pilot's preferences, because
 * they are the setting that makes two airframes feel different on the same
 * sticks — which is why they are stored per UAV in `uav.ts`.
 */

import { clamp } from "../math/scalar";

export interface ControlRates {
  /** Roll rate commanded at full stick, degrees per second. */
  readonly rollRate: number;
  /** Pitch rate commanded at full stick, degrees per second. */
  readonly pitchRate: number;
  /** How much of the roll stick is spent being gentle around centre, 0..1. */
  readonly rollExpo: number;
  /** The same for pitch. */
  readonly pitchExpo: number;
}

/**
 * Bounds every rate is held inside.
 *
 * The sliders read them so the interface cannot offer a setting the flight
 * controller would refuse, and `normaliseRates` applies the same numbers to
 * anything that arrives from storage.
 */
export const RATE_LIMITS = {
  rate: { min: 30, max: 720 },
  expo: { min: 0, max: 0.9 },
} as const;

/**
 * The rotation a stick position is asking for, degrees per second.
 *
 * Betaflight's curve: a cubic blended against the straight line by the expo,
 * so the ends of the travel are untouched — full stick is always exactly the
 * rate — and only the middle is softened.
 */
export function rateCommand(stick: number, rate: number, expo: number): number {
  const x = clamp(stick, -1, 1);
  const shaped = expo * x * x * x + (1 - expo) * x;
  return shaped * rate;
}

/** Repairs rates loaded from storage, falling back to an aircraft's own. */
export function normaliseRates(
  stored: unknown,
  defaults: ControlRates,
): ControlRates {
  const raw = (stored ?? {}) as Partial<Record<keyof ControlRates, unknown>>;
  return {
    rollRate: number(raw.rollRate, defaults.rollRate, RATE_LIMITS.rate),
    pitchRate: number(raw.pitchRate, defaults.pitchRate, RATE_LIMITS.rate),
    rollExpo: number(raw.rollExpo, defaults.rollExpo, RATE_LIMITS.expo),
    pitchExpo: number(raw.pitchExpo, defaults.pitchExpo, RATE_LIMITS.expo),
  };
}

function number(
  value: unknown,
  fallback: number,
  limit: { readonly min: number; readonly max: number },
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, limit.min, limit.max)
    : fallback;
}
