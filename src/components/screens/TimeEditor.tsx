"use client";

/**
 * The time panel.
 *
 * One editor, used twice — on the setup screen before the flight and in the
 * pause menu during it — for the same reason the weather has one: the light is
 * described in exactly the same way whichever side of take-off the pilot is
 * on.
 *
 * Five of the six choices are looks rather than moments: *Morning* is a low
 * sun, *Night* is stars, and the calendar never comes into it. *Date & time*
 * is the sixth, and is the other question entirely — a real day and a real
 * clock, with the sun where it actually was over this place at that instant.
 * That time is read either as the local time at the launch site or as UTC, and
 * the panel shows what the choice works out to so neither has to be converted
 * in anyone's head.
 */

import { useState } from "react";
import {
  DateTimeField,
  OptionGroup,
  PrimaryButton,
  SectionLabel,
} from "@/components/ui/Primitives";
import type { MissionClock, TimeOfDay, TimeZone } from "@/sim/environment/types";
import {
  TIME_OF_DAY,
  TIME_PROFILES,
  TIME_ZONE,
  clockFromInstant,
  defaultMissionClock,
  describeZone,
  formatClockTime,
  missionInstant,
  parseClockTime,
  parseDate,
} from "@/sim/environment/types";
import { solarPosition } from "@/sim/environment/solar";

export interface TimeEditorProps {
  readonly timeOfDay: TimeOfDay;
  /** The date and time set, when the pilot has set one. */
  readonly clock: MissionClock | undefined;
  /** Where the flight starts: the sun is only meaningful over a place. */
  readonly latitude: number;
  readonly longitude: number;
  /**
   * The time of day and the clock move together, because they are one setting:
   * choosing *Date & time* without the date it is to be flown at would put the
   * flight through an instant nobody asked for on the way.
   */
  readonly onTime: (timeOfDay: TimeOfDay, clock?: MissionClock) => void;
  /** How many across the preset group aims for. */
  readonly columns?: number;
}

export function TimeEditor({
  timeOfDay,
  clock,
  latitude,
  longitude,
  onTime,
  columns = 3,
}: TimeEditorProps) {
  // Only what has been typed but is not yet a date or a time. The fields are
  // otherwise driven by the mission, so a clock changed from anywhere else
  // shows up here without anything having to be kept in step.
  const [draftDate, setDraftDate] = useState<string | null>(null);
  const [draftTime, setDraftTime] = useState<string | null>(null);

  const chooseTimeOfDay = (next: TimeOfDay): void => {
    setDraftDate(null);
    setDraftTime(null);
    // Switching to a real date needs one to start from, and now is the one
    // answer that is never wrong.
    onTime(
      next,
      next === TIME_OF_DAY.Custom
        ? (clock ?? defaultMissionClock(longitude))
        : clock,
    );
  };

  const change = (next: MissionClock): void => onTime(TIME_OF_DAY.Custom, next);

  const changeDate = (text: string): void => {
    if (!clock) return;
    if (!parseDate(text)) {
      setDraftDate(text);
      return;
    }
    setDraftDate(null);
    change({ ...clock, date: text });
  };

  const changeTime = (text: string): void => {
    if (!clock) return;
    const minutes = parseClockTime(text);
    if (minutes === null) {
      setDraftTime(text);
      return;
    }
    setDraftTime(null);
    change({ ...clock, minutes });
  };

  // Changing the zone keeps the instant rather than the digits: a time typed
  // as local and then read as UTC is a different moment, and the pilot picking
  // "UTC" is saying how they want to state the time, not that the flight
  // should jump an hour or two.
  const changeZone = (zone: TimeZone): void => {
    if (!clock || zone === clock.zone) return;
    setDraftDate(null);
    setDraftTime(null);
    change(clockFromInstant(missionInstant(clock, longitude), zone, longitude));
  };

  const setToNow = (): void => {
    setDraftDate(null);
    setDraftTime(null);
    change(clockFromInstant(new Date(), clock?.zone ?? TIME_ZONE.Local, longitude));
  };

  return (
    <section>
      <SectionLabel>Time</SectionLabel>
      <OptionGroup
        columns={columns}
        value={timeOfDay}
        onChange={chooseTimeOfDay}
        options={Object.values(TIME_PROFILES).map((profile) => ({
          value: profile.id,
          label: profile.label,
        }))}
      />
      <p className="mt-2 text-2xs text-osd-faint">
        {TIME_PROFILES[timeOfDay].description}
      </p>

      {timeOfDay === TIME_OF_DAY.Custom && clock ? (
        <div className="mt-4 space-y-3 border border-hairline p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <DateTimeField
              label="Date"
              kind="date"
              value={draftDate ?? clock.date}
              onChange={changeDate}
              invalid={draftDate !== null}
            />
            <DateTimeField
              label="Time"
              kind="time"
              value={draftTime ?? formatClockTime(clock.minutes)}
              onChange={changeTime}
              invalid={draftTime !== null}
            />
          </div>

          <OptionGroup
            columns={2}
            value={clock.zone}
            onChange={changeZone}
            options={[
              {
                value: TIME_ZONE.Local,
                label: "Local",
                hint: describeZone(TIME_ZONE.Local, longitude),
              },
              { value: TIME_ZONE.Utc, label: "UTC", hint: "UTC+00:00" },
            ]}
          />

          <p className="text-2xs text-osd-faint">
            {describeClockLine(clock, latitude, longitude)}
          </p>
          <p className="text-2xs text-osd-faint">
            Local time is the zone the launch site&apos;s longitude falls in, an
            hour every fifteen degrees. There is no daylight saving in it, so a
            summer afternoon may read an hour off the clock on the ground.
          </p>
          <PrimaryButton onClick={setToNow}>Now</PrimaryButton>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Where that setting actually puts the sun, and what it is in the other zone.
 *
 * The elevation is the whole point of the panel — it is the one number that
 * says whether the flight will be in daylight — and the conversion is there so
 * a time typed in one zone never has to be worked out in the other.
 */
function describeClockLine(
  clock: MissionClock,
  latitude: number,
  longitude: number,
): string {
  const instant = missionInstant(clock, longitude);
  const elevation = solarPosition(latitude, longitude, instant).elevation;
  const other = clock.zone === TIME_ZONE.Local ? TIME_ZONE.Utc : TIME_ZONE.Local;
  const there = clockFromInstant(instant, other, longitude);
  const sun =
    elevation > 0
      ? `Sun ${elevation.toFixed(0)}° above the horizon`
      : elevation > -6
        ? `Twilight, sun ${Math.abs(elevation).toFixed(0)}° below the horizon`
        : `Night, sun ${Math.abs(elevation).toFixed(0)}° below the horizon`;
  return `${sun} · ${there.date} ${formatClockTime(there.minutes)} ${describeZone(other, longitude)}`;
}
