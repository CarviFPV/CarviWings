/**
 * Weather and time-of-day definitions.
 *
 * Time of day lives here, in full. The weather does not: it grew from a table
 * of four presets into a model of cloud decks, visibility, precipitation and
 * layered wind, which is now `weather.ts` (what the sky *is*) over `sky.ts`
 * (what a cloud deck is). This module re-exports all of it, so everything that
 * already asks `environment/types` for a weather profile keeps working and
 * there is still one obvious place to import the environment's vocabulary
 * from.
 */

export * from "./sky";
export * from "./weather";
export * from "./skyProfile";
export * from "./clock";

import type { MissionClock } from "./clock";
import { missionInstant } from "./clock";
import { utcForLocalSolarHour } from "./solar";

export const TIME_OF_DAY = {
  Morning: "MORNING",
  Day: "DAY",
  Evening: "EVENING",
  Night: "NIGHT",
  Dynamic: "DYNAMIC",
  Custom: "CUSTOM",
} as const;

export type TimeOfDay = (typeof TIME_OF_DAY)[keyof typeof TIME_OF_DAY];

export interface TimeOfDayProfile {
  readonly id: TimeOfDay;
  readonly label: string;
  readonly description: string;
  /**
   * Local solar hour the mission starts at.
   *
   * Ignored by `Custom`, which starts at the date and time the mission's own
   * clock names instead of at an hour of an unspecified day.
   */
  readonly startHour: number;
  /** How fast the clock runs; 1 is real time. */
  readonly clockMultiplier: number;
}

export const TIME_PROFILES: Readonly<Record<TimeOfDay, TimeOfDayProfile>> = {
  [TIME_OF_DAY.Morning]: {
    id: TIME_OF_DAY.Morning,
    label: "Morning",
    description: "Low sun, long shadows down the valleys.",
    startHour: 7.5,
    clockMultiplier: 1,
  },
  [TIME_OF_DAY.Day]: {
    id: TIME_OF_DAY.Day,
    label: "Day",
    description: "High sun. Everything is visible, including you.",
    startHour: 13,
    clockMultiplier: 1,
  },
  [TIME_OF_DAY.Evening]: {
    id: TIME_OF_DAY.Evening,
    label: "Evening",
    description: "Sun on the horizon, colour draining out of the terrain.",
    startHour: 19.5,
    clockMultiplier: 1,
  },
  [TIME_OF_DAY.Night]: {
    id: TIME_OF_DAY.Night,
    label: "Night",
    description: "Stars, moonlight and very little else.",
    startHour: 23,
    clockMultiplier: 1,
  },
  [TIME_OF_DAY.Dynamic]: {
    id: TIME_OF_DAY.Dynamic,
    label: "Dynamic",
    description: "The sun moves. A full day passes in about six minutes.",
    startHour: 9,
    clockMultiplier: 240,
  },
  [TIME_OF_DAY.Custom]: {
    id: TIME_OF_DAY.Custom,
    label: "Date & time",
    description: "A real date and time, with the sun where it actually was.",
    // Only a fallback: a mission set to this and carrying no clock is flown at
    // midday rather than at whatever hour an unset field happens to mean.
    startHour: 12,
    clockMultiplier: 1,
  },
} as const;

/**
 * The instant a mission starts, which is what the sun is computed from.
 *
 * The presets are answers to "what should the light look like", so they are
 * placed by local solar hour on the reference day and the calendar never comes
 * into it. A mission with a clock is the other question — "what did the sky
 * over this place look like then" — and is placed at the instant that clock
 * names. Everything downstream only sees a `Date`.
 */
export function missionStartTime(
  time: TimeOfDayProfile,
  longitude: number,
  clock?: MissionClock,
  reference: Date = new Date(),
): Date {
  if (time.id === TIME_OF_DAY.Custom && clock) {
    return missionInstant(clock, longitude, reference);
  }
  return utcForLocalSolarHour(longitude, time.startHour, reference);
}
