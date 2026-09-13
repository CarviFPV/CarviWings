/**
 * Flight modes, and the parameters a pilot sets them up with.
 *
 * Everything here is data. It describes what the flight controller in
 * `flightController.ts` is allowed to do — how far it may bank the wing, how
 * fast a stick walks a held course, how a return home decides the height it
 * comes back at — and none of it can move an aircraft on its own.
 *
 * The vocabulary is deliberately the one an INAV wing already uses, because
 * that is the vocabulary the pilots flying this simulator have: manual is the
 * bare airframe, acro holds the rates the sticks ask for, angle self-levels,
 * course hold flies a heading, altitude hold flies a height, the two together
 * are cruise, and RTH brings it home.
 */

import { clamp } from "../math/scalar";

export const FLIGHT_MODE = {
  /**
   * The airframe as it is: the sticks are the control surfaces, and how fast
   * the wing rotates is whatever the aerodynamics make of that at the speed it
   * happens to be doing. The mode this simulator flew in before it had any
   * others, kept because there is nothing more honest to compare the rest to.
   */
  Manual: "MANUAL",
  /**
   * The sticks command a rotation rate and the controller holds it, exactly as
   * a flight controller's acro mode does. Full stick is the aircraft's roll or
   * pitch rate — see `rates.ts` — rather than full elevon, so the wing answers
   * the same at forty metres a second as at twenty. Nothing levels it when the
   * sticks are let go; it simply stops rotating.
   */
  Acro: "ACRO",
  /**
   * The sticks command an attitude instead of a rotation: full roll is the
   * bank limit rather than a roll rate, and centred sticks level the wing.
   */
  Angle: "ANGLE",
} as const;

export type FlightMode = (typeof FLIGHT_MODE)[keyof typeof FLIGHT_MODE];

export const FLIGHT_MODES: readonly FlightMode[] = [
  FLIGHT_MODE.Manual,
  FLIGHT_MODE.Acro,
  FLIGHT_MODE.Angle,
];

export const FLIGHT_MODE_LABEL: Readonly<Record<FlightMode, string>> = {
  MANUAL: "Manual",
  ACRO: "Acro",
  ANGLE: "Angle",
};

/**
 * How a return home picks the height it comes back at.
 *
 * The same four choices INAV offers, and for the same reason: a wing three
 * hundred metres up over a valley and a wing on the deck over a ridge want
 * opposite things from the word "home".
 */
export const RTH_ALTITUDE_MODE = {
  /** Come home at whatever height the return was started at. */
  Current: "CURRENT",
  /** Climb to the return altitude, but never descend to it. */
  AtLeast: "AT_LEAST",
  /** Always fly home at the return altitude, climbing or descending to it. */
  Fixed: "FIXED",
  /** Add the return altitude to the height it was at. */
  Extra: "EXTRA",
} as const;

export type RthAltitudeMode =
  (typeof RTH_ALTITUDE_MODE)[keyof typeof RTH_ALTITUDE_MODE];

export const RTH_ALTITUDE_MODES: readonly RthAltitudeMode[] = [
  RTH_ALTITUDE_MODE.AtLeast,
  RTH_ALTITUDE_MODE.Fixed,
  RTH_ALTITUDE_MODE.Current,
  RTH_ALTITUDE_MODE.Extra,
];

export const RTH_ALTITUDE_MODE_LABEL: Readonly<Record<RthAltitudeMode, string>> =
  {
    AT_LEAST: "At least",
    FIXED: "Fixed",
    CURRENT: "Current",
    EXTRA: "Extra",
  };

/** What the aircraft does once it is over home. */
export const RTH_ARRIVAL = {
  /** Circle overhead and wait for the pilot to take it back. */
  Loiter: "LOITER",
  /** Spiral down and put it on the ground. */
  Land: "LAND",
} as const;

export type RthArrival = (typeof RTH_ARRIVAL)[keyof typeof RTH_ARRIVAL];

export const RTH_ARRIVALS: readonly RthArrival[] = [
  RTH_ARRIVAL.Loiter,
  RTH_ARRIVAL.Land,
];

export const RTH_ARRIVAL_LABEL: Readonly<Record<RthArrival, string>> = {
  LOITER: "Loiter",
  LAND: "Land",
};

/** Which part of the return the aircraft is flying. */
export const RTH_STAGE = {
  /** Climbing to the return altitude on the heading it was engaged on. */
  Climb: "CLIMB",
  /** Pointed at home, holding the return altitude. */
  Cruise: "CRUISE",
  /** Circling over home. */
  Loiter: "LOITER",
  /** Spiralling down onto home. */
  Land: "LAND",
} as const;

export type RthStage = (typeof RTH_STAGE)[keyof typeof RTH_STAGE];

export const RTH_STAGE_LABEL: Readonly<Record<RthStage, string>> = {
  CLIMB: "Climb",
  CRUISE: "Home",
  LOITER: "Loiter",
  LAND: "Land",
};

export interface RthSettings {
  readonly altitudeMode: RthAltitudeMode;
  /** Return altitude above the ground at home, metres. */
  readonly altitudeMetres: number;
  /**
   * Climb to the return altitude before turning back.
   *
   * Off, the wing turns for home immediately and climbs on the way, which is
   * quicker and is what you want over flat ground. On, it goes up first, which
   * is the only safe answer when the thing between the aircraft and home is a
   * ridge.
   */
  readonly climbFirst: boolean;
  readonly arrival: RthArrival;
  /** Radius of the circle held over home, metres. */
  readonly loiterRadiusMetres: number;
  /** Airspeed to come home at, m/s. */
  readonly cruiseSpeed: number;
  /** Moving a stick hands the aircraft straight back to the pilot. */
  readonly allowStickOverride: boolean;
}

export interface FlightModeSettings {
  /** The mode a flight starts in. */
  readonly defaultMode: FlightMode;
  /** Hardest bank angle mode and course hold will command, degrees. */
  readonly maxBankDeg: number;
  /** Steepest attitude angle mode will command, degrees. */
  readonly maxPitchDeg: number;
  /** How fast the roll stick walks a held course, degrees per second. */
  readonly courseTrimRate: number;
  /** How fast the pitch stick walks a held altitude, metres per second. */
  readonly altitudeTrimRate: number;
  readonly rth: RthSettings;
}

export const DEFAULT_RTH_SETTINGS: RthSettings = {
  altitudeMode: RTH_ALTITUDE_MODE.AtLeast,
  altitudeMetres: 120,
  climbFirst: true,
  arrival: RTH_ARRIVAL.Loiter,
  loiterRadiusMetres: 120,
  cruiseSpeed: 22,
  allowStickOverride: true,
};

export const DEFAULT_FLIGHT_MODE_SETTINGS: FlightModeSettings = {
  defaultMode: FLIGHT_MODE.Acro,
  maxBankDeg: 45,
  maxPitchDeg: 25,
  courseTrimRate: 45,
  altitudeTrimRate: 4,
  rth: DEFAULT_RTH_SETTINGS,
};

/**
 * Bounds every parameter is held inside.
 *
 * The interface reads them so a slider cannot offer a setting the flight
 * controller would refuse, and `normaliseFlightModeSettings` applies the same
 * numbers to anything that arrives from storage.
 */
export const FLIGHT_MODE_LIMITS = {
  maxBankDeg: { min: 15, max: 75 },
  maxPitchDeg: { min: 10, max: 45 },
  courseTrimRate: { min: 10, max: 120 },
  altitudeTrimRate: { min: 1, max: 12 },
  rthAltitudeMetres: { min: 20, max: 500 },
  rthLoiterRadiusMetres: { min: 50, max: 500 },
  rthCruiseSpeed: { min: 14, max: 34 },
} as const;

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, min, max)
    : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Repairs settings loaded from storage.
 *
 * Settings outlive the version of the simulator that wrote them, exactly as
 * the key layout does: an unknown mode name, a return altitude someone hand
 * edited to a kilometre, or a whole missing block all fall back to the default
 * rather than reaching the flight controller.
 */
export function normaliseFlightModeSettings(stored: unknown): FlightModeSettings {
  const raw = (stored ?? {}) as Partial<Record<keyof FlightModeSettings, unknown>>;
  const limits = FLIGHT_MODE_LIMITS;
  const defaults = DEFAULT_FLIGHT_MODE_SETTINGS;
  const rawRth = (raw.rth ?? {}) as Partial<Record<keyof RthSettings, unknown>>;
  const rthDefaults = defaults.rth;

  return {
    defaultMode: isOneOf(raw.defaultMode, FLIGHT_MODES)
      ? raw.defaultMode
      : defaults.defaultMode,
    maxBankDeg: number(
      raw.maxBankDeg,
      defaults.maxBankDeg,
      limits.maxBankDeg.min,
      limits.maxBankDeg.max,
    ),
    maxPitchDeg: number(
      raw.maxPitchDeg,
      defaults.maxPitchDeg,
      limits.maxPitchDeg.min,
      limits.maxPitchDeg.max,
    ),
    courseTrimRate: number(
      raw.courseTrimRate,
      defaults.courseTrimRate,
      limits.courseTrimRate.min,
      limits.courseTrimRate.max,
    ),
    altitudeTrimRate: number(
      raw.altitudeTrimRate,
      defaults.altitudeTrimRate,
      limits.altitudeTrimRate.min,
      limits.altitudeTrimRate.max,
    ),
    rth: {
      altitudeMode: isOneOf(rawRth.altitudeMode, RTH_ALTITUDE_MODES)
        ? rawRth.altitudeMode
        : rthDefaults.altitudeMode,
      altitudeMetres: number(
        rawRth.altitudeMetres,
        rthDefaults.altitudeMetres,
        limits.rthAltitudeMetres.min,
        limits.rthAltitudeMetres.max,
      ),
      climbFirst: boolean(rawRth.climbFirst, rthDefaults.climbFirst),
      arrival: isOneOf(rawRth.arrival, RTH_ARRIVALS)
        ? rawRth.arrival
        : rthDefaults.arrival,
      loiterRadiusMetres: number(
        rawRth.loiterRadiusMetres,
        rthDefaults.loiterRadiusMetres,
        limits.rthLoiterRadiusMetres.min,
        limits.rthLoiterRadiusMetres.max,
      ),
      cruiseSpeed: number(
        rawRth.cruiseSpeed,
        rthDefaults.cruiseSpeed,
        limits.rthCruiseSpeed.min,
        limits.rthCruiseSpeed.max,
      ),
      allowStickOverride: boolean(
        rawRth.allowStickOverride,
        rthDefaults.allowStickOverride,
      ),
    },
  };
}

/**
 * The height a return home should be flown at, in the local vertical frame.
 *
 * `currentZ` is where the aircraft was when the return was engaged and
 * `homeGroundZ` the terrain height under home, so "at least 120 m" means 120
 * above the field rather than 120 above wherever the pilot happened to be.
 */
export function returnAltitude(
  rth: RthSettings,
  currentZ: number,
  homeGroundZ: number,
): number {
  const overHome = homeGroundZ + rth.altitudeMetres;
  switch (rth.altitudeMode) {
    case RTH_ALTITUDE_MODE.Current:
      return currentZ;
    case RTH_ALTITUDE_MODE.Fixed:
      return overHome;
    case RTH_ALTITUDE_MODE.Extra:
      return currentZ + rth.altitudeMetres;
    case RTH_ALTITUDE_MODE.AtLeast:
    default:
      return Math.max(currentZ, overHome);
  }
}
