/**
 * The date and time a flight is made at.
 *
 * Everything the light does follows from where the sun is, and where the sun
 * is follows from three things: the place, the day of the year and the time.
 * The time-of-day presets fix the last two — they put the clock at a solar
 * hour on today's date and leave it there — which is exactly what "fly it at
 * dusk" wants and no use at all for flying a real December afternoon at 47
 * north, where the sun is already on the horizon at three.
 *
 * So a mission may carry a clock instead: a calendar date and a time of day,
 * read either as the local time at the launch site or as UTC. That instant is
 * what the scene clock is set to, and the sun is then wherever it really was
 * over that place at that moment.
 *
 * **Local** here is standard time for the site's longitude — one hour per
 * fifteen degrees, rounded to the nearest hour. That is the zone a clock on
 * the ground keeps across most of the world, but it is a geometric answer to
 * a political question: no daylight saving, and no allowance for the countries
 * that draw the boundary somewhere else or sit on a half-hour offset. The
 * worst case is half an hour of sun, and UTC is always there for anyone who
 * wants the instant stated exactly.
 */

import { clamp } from "../math/scalar";

/** Whether a clock setting is read as local time at the site, or as UTC. */
export const TIME_ZONE = {
  Local: "LOCAL",
  Utc: "UTC",
} as const;

export type TimeZone = (typeof TIME_ZONE)[keyof typeof TIME_ZONE];

export interface MissionClock {
  /** The calendar date in the chosen zone, as `YYYY-MM-DD`. */
  readonly date: string;
  /** The time of day in the chosen zone, in minutes past midnight. */
  readonly minutes: number;
  /** How `date` and `minutes` are to be read. */
  readonly zone: TimeZone;
}

export const MINUTES_PER_DAY = 1440;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * The whole-hour zone the given longitude sits in.
 *
 * The date line is the reason for the clamp: a longitude that has wandered
 * past +/-180 still has to come back with an offset a clock could show.
 */
export function zoneOffsetHours(longitude: number): number {
  let lon = longitude % 360;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return clamp(Math.round(lon / 15), -12, 14);
}

/** Hours to add to UTC to get the clock the pilot is setting. */
export function offsetHoursFor(zone: TimeZone, longitude: number): number {
  return zone === TIME_ZONE.Utc ? 0 : zoneOffsetHours(longitude);
}

export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  return clamp(Math.round(minutes), 0, MINUTES_PER_DAY - 1);
}

/** `YYYY-MM-DD`, or null when the text is not a date that exists. */
export function parseDate(text: string): CalendarDay | null {
  const match = DATE_PATTERN.exec(text.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // The 31st of February parses and is still not a day: rebuilding it and
  // reading it back is what catches the ones the ranges let through.
  const built = new Date(Date.UTC(year, month - 1, day));
  if (
    built.getUTCFullYear() !== year ||
    built.getUTCMonth() !== month - 1 ||
    built.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function formatDate(day: CalendarDay): string {
  return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

/** `HH:MM`, the way a time field wants it. */
export function formatClockTime(minutes: number): string {
  const total = clampMinutes(minutes);
  const hours = Math.floor(total / 60);
  return `${String(hours).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Minutes past midnight from `HH:MM`, or null when it is not a time. */
export function parseClockTime(text: string): number | null {
  const match = TIME_PATTERN.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** `+02:00`, the way an offset is written down. */
export function formatOffset(hours: number): string {
  const sign = hours < 0 ? "-" : "+";
  const whole = Math.floor(Math.abs(hours));
  const minutes = Math.round((Math.abs(hours) - whole) * 60);
  return `${sign}${String(whole).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** What the chosen zone works out to here: `UTC+02:00`. */
export function describeZone(zone: TimeZone, longitude: number): string {
  return `UTC${formatOffset(offsetHoursFor(zone, longitude))}`;
}

/**
 * The UTC instant a clock setting names.
 *
 * A date that is not a date falls back to the reference day rather than to
 * an invalid instant: a half-typed field in the setup screen should leave the
 * sun where it was, not send the flight to 1970.
 */
export function missionInstant(
  clock: MissionClock,
  longitude: number,
  reference: Date = new Date(),
): Date {
  const offset = offsetHoursFor(clock.zone, longitude);
  const day = parseDate(clock.date) ?? dayAt(reference, offset);
  const minutes = clampMinutes(clock.minutes);
  return new Date(
    Date.UTC(day.year, day.month - 1, day.day) + (minutes - offset * 60) * 60000,
  );
}

/** The same instant, written as the clock a pilot in that zone would read. */
export function clockFromInstant(
  instant: Date,
  zone: TimeZone,
  longitude: number,
): MissionClock {
  const offset = offsetHoursFor(zone, longitude);
  const shifted = new Date(instant.getTime() + offset * 3600000);
  return {
    date: formatDate(dayOf(shifted)),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    zone,
  };
}

/**
 * What the clock starts at when the pilot first asks for one: now, at the
 * launch site. Whatever else a date field defaults to, today is never wrong.
 */
export function defaultMissionClock(
  longitude: number,
  now: Date = new Date(),
): MissionClock {
  return clockFromInstant(now, TIME_ZONE.Local, longitude);
}

/** `2026-09-01 14:30 UTC+02:00` — an instant written out in a zone. */
export function formatInstant(
  instant: Date,
  zone: TimeZone,
  longitude: number,
): string {
  const clock = clockFromInstant(instant, zone, longitude);
  return `${clock.date} ${formatClockTime(clock.minutes)} ${describeZone(zone, longitude)}`;
}

/** `2026-09-01 14:30 UTC+02:00`, for a setting rather than an instant. */
export function describeClock(clock: MissionClock, longitude: number): string {
  return `${clock.date} ${formatClockTime(clock.minutes)} ${describeZone(clock.zone, longitude)}`;
}

function dayOf(instant: Date): CalendarDay {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

function dayAt(instant: Date, offsetHours: number): CalendarDay {
  return dayOf(new Date(instant.getTime() + offsetHours * 3600000));
}
