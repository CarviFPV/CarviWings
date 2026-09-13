import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  daylightFactor,
  solarPosition,
  utcForLocalSolarHour,
} from "../environment/solar";
import { WindField, createMissionWind, formatWind } from "../environment/wind";
import { VisibilitySystem } from "../environment/visibility";
import {
  TIME_OF_DAY,
  TIME_PROFILES,
  TIME_ZONE,
  WEATHER,
  WEATHER_PROFILES,
  clockFromInstant,
  defaultMissionClock,
  describeClock,
  describeZone,
  formatClockTime,
  missionInstant,
  missionStartTime,
  parseClockTime,
  parseDate,
  withCloudCover,
  zoneOffsetHours,
} from "../environment/types";
import type { WindSpec } from "../environment/types";
import { layersFromProfile } from "../environment/visibility";
import { rainStreakField } from "../environment/precipitation";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import * as V from "../math/vec3";

const EQUINOX_NOON = new Date("2025-03-20T12:00:00Z");
const JUNE_SOLSTICE = new Date("2025-06-21T12:00:00Z");
const DECEMBER_SOLSTICE = new Date("2025-12-21T12:00:00Z");

export async function runEnvironmentTests(): Promise<void> {
  suite("solar position", () => {
    // On the equinox the sun stands almost overhead at the equator at noon.
    const overhead = solarPosition(0, 0, EQUINOX_NOON);
    assert(
      overhead.elevation > 85,
      `equinox noon at the equator is near vertical (${overhead.elevation.toFixed(1)} deg)`,
    );
    assertClose(overhead.declination, 0, 1, "equinox declination is near zero");

    const midnight = solarPosition(0, 0, new Date("2025-03-20T00:00:00Z"));
    assert(
      midnight.elevation < -85,
      `equinox midnight is the far side of the Earth (${midnight.elevation.toFixed(1)} deg)`,
    );

    // Solstice declinations bracket the tropics.
    assertClose(
      solarPosition(0, 0, JUNE_SOLSTICE).declination,
      23.4,
      0.4,
      "June solstice declination",
    );
    assertClose(
      solarPosition(0, 0, DECEMBER_SOLSTICE).declination,
      -23.4,
      0.4,
      "December solstice declination",
    );

    // Midnight sun and polar night, which only come out right if the hour
    // angle and declination are both correct.
    const svalbard = solarPosition(78, 15, new Date("2025-06-21T23:00:00Z"));
    assert(svalbard.elevation > 0, "the sun is up at midnight over Svalbard in June");
    const antarctic = solarPosition(-78, 15, new Date("2025-06-21T12:00:00Z"));
    assert(antarctic.elevation < 0, "and down at noon in the Antarctic in June");

    // Moving 15 degrees east is worth exactly one hour.
    const atGreenwich = solarPosition(45, 0, EQUINOX_NOON);
    const eastAnHourEarlier = solarPosition(
      45,
      15,
      new Date(EQUINOX_NOON.getTime() - 3600000),
    );
    assertClose(
      eastAnHourEarlier.elevation,
      atGreenwich.elevation,
      0.2,
      "15 degrees of longitude equals one hour of rotation",
    );

    // Local solar noon really is the peak of the day.
    const noon = utcForLocalSolarHour(7.9625, 12, EQUINOX_NOON);
    const peak = solarPosition(46.5375, 7.9625, noon).elevation;
    for (const offsetHours of [-3, -1, 1, 3]) {
      const other = solarPosition(
        46.5375,
        7.9625,
        new Date(noon.getTime() + offsetHours * 3600000),
      ).elevation;
      assert(
        other < peak,
        `the sun is lower ${offsetHours}h from local solar noon`,
      );
    }

    assertClose(
      utcForLocalSolarHour(0, 12, EQUINOX_NOON).getUTCHours(),
      12,
      0.01,
      "local solar noon at Greenwich is 12:00 UTC",
    );
    assertClose(
      utcForLocalSolarHour(15, 12, EQUINOX_NOON).getUTCHours(),
      11,
      0.01,
      "local solar noon 15 degrees east is 11:00 UTC",
    );
  });

  suite("mission clock", () => {
    // The zone a longitude falls in, one hour every fifteen degrees.
    assert(zoneOffsetHours(0) === 0, "Greenwich is UTC+00:00");
    assert(zoneOffsetHours(7.96) === 1, "the Bernese Oberland is UTC+01:00");
    assert(zoneOffsetHours(-74) === -5, "New York is UTC-05:00");
    assert(zoneOffsetHours(139.7) === 9, "Tokyo is UTC+09:00");
    assert(zoneOffsetHours(190) === -11, "past the date line comes back west");

    // A local time is the UTC instant minus the site's offset.
    const local = missionInstant(
      { date: "2025-06-21", minutes: 14 * 60 + 30, zone: TIME_ZONE.Local },
      7.96,
    );
    assert(
      local.toISOString() === "2025-06-21T13:30:00.000Z",
      `14:30 local at 8 east is 13:30 UTC (${local.toISOString()})`,
    );

    // The same digits read as UTC are a different moment.
    const utc = missionInstant(
      { date: "2025-06-21", minutes: 14 * 60 + 30, zone: TIME_ZONE.Utc },
      7.96,
    );
    assert(
      utc.toISOString() === "2025-06-21T14:30:00.000Z",
      `14:30 UTC is 14:30 UTC (${utc.toISOString()})`,
    );

    // An offset that crosses midnight has to take the date with it.
    const nextDay = missionInstant(
      { date: "2025-06-21", minutes: 23 * 60, zone: TIME_ZONE.Local },
      139.7,
    );
    assert(
      nextDay.toISOString() === "2025-06-21T14:00:00.000Z",
      `23:00 in Tokyo is 14:00 UTC the same day (${nextDay.toISOString()})`,
    );
    const previousDay = missionInstant(
      { date: "2025-06-21", minutes: 60, zone: TIME_ZONE.Local },
      -74,
    );
    assert(
      previousDay.toISOString() === "2025-06-21T06:00:00.000Z",
      `01:00 in New York is 06:00 UTC (${previousDay.toISOString()})`,
    );

    // Reading an instant back in a zone is the inverse of setting it there.
    const roundTrip = clockFromInstant(local, TIME_ZONE.Local, 7.96);
    assert(
      roundTrip.date === "2025-06-21" && roundTrip.minutes === 14 * 60 + 30,
      `a clock survives a trip through an instant (${describeClock(roundTrip, 7.96)})`,
    );
    const asUtc = clockFromInstant(local, TIME_ZONE.Utc, 7.96);
    assert(
      asUtc.date === "2025-06-21" && asUtc.minutes === 13 * 60 + 30,
      "and the same instant reads an hour earlier in UTC",
    );

    // Fields, parsed and printed.
    assert(parseDate("2025-02-30") === null, "the 30th of February is not a day");
    assert(parseDate("2024-02-29") !== null, "the 29th in a leap year is");
    assert(parseDate("not a date") === null, "and nor is a sentence");
    assert(parseClockTime("07:05") === 425, "07:05 is 425 minutes past midnight");
    assert(parseClockTime("24:00") === null, "there is no 24:00");
    assert(formatClockTime(425) === "07:05", "and it prints back the same way");
    assert(
      describeZone(TIME_ZONE.Local, 7.96) === "UTC+01:00",
      "a zone is written the way a clock setting is",
    );
    assert(
      describeZone(TIME_ZONE.Utc, 7.96) === "UTC+00:00",
      "and UTC is UTC wherever the flight is",
    );

    // A date that is not a date leaves the flight on the reference day rather
    // than in 1970: a half-typed field must not move the sun to the epoch.
    const fallback = missionInstant(
      { date: "", minutes: 12 * 60, zone: TIME_ZONE.Utc },
      0,
      EQUINOX_NOON,
    );
    assert(
      fallback.toISOString() === "2025-03-20T12:00:00.000Z",
      `an unparseable date falls back to the reference day (${fallback.toISOString()})`,
    );

    const now = defaultMissionClock(7.96, EQUINOX_NOON);
    assert(
      now.zone === TIME_ZONE.Local && now.minutes === 13 * 60,
      `a fresh clock is now, at the site (${describeClock(now, 7.96)})`,
    );
  });

  suite("mission start time", () => {
    // A preset is a look rather than a moment: it is placed by solar hour on
    // the day the flight is flown, and the calendar never comes into it.
    const preset = missionStartTime(
      TIME_PROFILES[TIME_OF_DAY.Day],
      15,
      undefined,
      EQUINOX_NOON,
    );
    assertClose(
      preset.getTime(),
      utcForLocalSolarHour(15, 13, EQUINOX_NOON).getTime(),
      1,
      "a preset starts at its own local solar hour",
    );

    // A clock is the other question, and is flown at the instant it names.
    const clock = {
      date: "2025-12-21",
      minutes: 16 * 60,
      zone: TIME_ZONE.Local,
    };
    const custom = missionStartTime(
      TIME_PROFILES[TIME_OF_DAY.Custom],
      7.96,
      clock,
      EQUINOX_NOON,
    );
    assert(
      custom.toISOString() === "2025-12-21T15:00:00.000Z",
      `a set date and time is flown at that instant (${custom.toISOString()})`,
    );

    // Which is the whole point: the same clock time is a different sun in
    // December than in June, and that only comes out right if the date is
    // carried through to the solar position.
    const winter = solarPosition(46.5, 7.96, custom).elevation;
    const summer = solarPosition(
      46.5,
      7.96,
      missionStartTime(
        TIME_PROFILES[TIME_OF_DAY.Custom],
        7.96,
        { ...clock, date: "2025-06-21" },
        EQUINOX_NOON,
      ),
    ).elevation;
    assert(
      winter < 10 && summer > 35,
      `four in the afternoon is a sun on the horizon in December and a high one in June (${winter.toFixed(1)} vs ${summer.toFixed(1)} deg)`,
    );

    // A mission set to a real date but carrying no clock still has to start
    // somewhere sensible rather than at an unset field.
    const noClock = missionStartTime(
      TIME_PROFILES[TIME_OF_DAY.Custom],
      7.96,
      undefined,
      EQUINOX_NOON,
    );
    assert(
      solarPosition(46.5, 7.96, noClock).elevation > 30,
      "a date-and-time mission with no clock falls back to midday",
    );
  });

  suite("daylight factor", () => {
    assertClose(daylightFactor(20), 1, 1e-9, "high sun is full daylight");
    assertClose(daylightFactor(-20), 0, 1e-9, "well below the horizon is night");
    assertClose(daylightFactor(0), 0.5, 1e-9, "the horizon is halfway");
    assert(
      daylightFactor(-3) > 0 && daylightFactor(-3) < 0.5,
      "civil twilight is partial light",
    );
  });

  suite("wind", () => {
    const options = {
      seed: "MISSION-1",
      layers: [{ altitudeAgl: 10, directionDeg: 270, speed: 8 }],
      gustiness: 0,
      variation: 0,
    };
    const a = new WindField(options);
    const b = new WindField(options);
    for (let i = 0; i < 200; i += 1) {
      a.update(1 / 60);
      b.update(1 / 60);
    }
    assertClose(a.speed, b.speed, 1e-12, "the same seed gives the same wind");
    assertClose(a.speed, 8, 1e-9, "no gustiness means a steady wind");
    assertClose(a.directionDeg, 270, 1e-9, "and a steady direction");

    // Meteorological convention: from 270 means blowing toward the east.
    const velocity = a.sample(10, V.vec3());
    assert(velocity.x > 0, "a westerly blows toward the east");
    assertClose(velocity.y, 0, 1e-6, "and has no northward component");
    assertClose(V.length(velocity), 8, 1e-6, "reference height gives the quoted speed");

    // The boundary layer: faster higher up, but bounded.
    const low = a.speedAt(10);
    const mid = a.speedAt(300);
    const high = a.speedAt(3000);
    assert(mid > low * 1.4, `wind shear strengthens with height (${mid.toFixed(1)} vs ${low.toFixed(1)} m/s)`);
    assert(high > mid, "and keeps strengthening");
    assert(high < low * 2.3, "but is capped rather than growing without limit");
    assert(a.speedAt(0) >= 0, "ground level is finite");

    // Gusts move, and stay bounded. Speed and direction move independently:
    // gustiness is the first and variation is the second.
    const gusty = new WindField({ ...options, gustiness: 1, variation: 1 });
    let min = Infinity;
    let max = -Infinity;
    let directionSwing = 0;
    for (let i = 0; i < 60 * 600; i += 1) {
      gusty.update(1 / 60);
      min = Math.min(min, gusty.speed);
      max = Math.max(max, gusty.speed);
      const delta = Math.abs(((gusty.directionDeg - 270 + 540) % 360) - 180);
      directionSwing = Math.max(directionSwing, delta);
    }
    assert(max > min + 1, `gusts vary the speed (${min.toFixed(1)}-${max.toFixed(1)} m/s)`);
    assertBetween(max, 8, 20, "gusts stay within a believable band");
    assert(min >= 0, "wind never blows backwards through the gust model");
    assertBetween(directionSwing, 3, 45, `the wind shifts by up to ${directionSwing.toFixed(0)} deg`);

    // A mission wind is reproducible from its seed.
    const spec: WindSpec = {
      layers: [{ altitudeAgl: 10, directionDeg: 270, speed: 6 }],
      gustiness: 0.4,
      variation: 0.3,
    };
    const veer = { veerBySeed: true };
    const first = createMissionWind("ALPHA", spec, veer);
    const second = createMissionWind("ALPHA", spec, veer);
    const third = createMissionWind("BRAVO", spec, veer);
    assertClose(
      first.baseDirectionDeg,
      second.baseDirectionDeg,
      1e-12,
      "the same mission seed picks the same wind direction",
    );
    assert(
      Math.abs(first.baseDirectionDeg - third.baseDirectionDeg) > 1e-6,
      "a different seed picks a different one",
    );
    assertClose(
      createMissionWind("ALPHA", spec).baseDirectionDeg,
      270,
      1e-9,
      "an observed wind is left exactly where it was observed",
    );

    // Several levels: the wind between two of them is interpolated, and the
    // direction is walked the short way round rather than past north.
    const sheared = new WindField({
      seed: "SHEAR",
      layers: [
        { altitudeAgl: 10, directionDeg: 350, speed: 4 },
        { altitudeAgl: 1010, directionDeg: 30, speed: 16 },
      ],
      gustiness: 0,
      variation: 0,
    });
    sheared.update(1 / 60);
    assertClose(sheared.speedAt(1010), 16, 1e-6, "a quoted level blows what it says");
    assertClose(sheared.speedAt(510), 10, 1e-6, "and halfway up is halfway between");
    assertClose(
      sheared.directionAt(510),
      10,
      1e-6,
      "the direction takes the short way round north",
    );
    assertClose(
      sheared.directionAt(4000),
      30,
      1e-6,
      "above the top level the direction the top level had simply continues",
    );
    assert(
      sheared.speedAt(4000) > sheared.speedAt(1010),
      "while the speed keeps shearing the way the boundary layer does",
    );
    assert(
      sheared.speedAt(1) < sheared.speedAt(10),
      "and below the lowest level the boundary layer takes over",
    );

    assert(formatWind(7, 5) === "007/18", `wind formats as bearing/speed (${formatWind(7, 5)})`);

    // The weather can be changed mid-flight, and the wind goes with it. What
    // comes out has to be the wind that weather would have had all along, so
    // the pilot cannot tell a swapped airmass from a freshly launched one.
    const light: WindSpec = {
      layers: [{ altitudeAgl: 10, directionDeg: 270, speed: 3 }],
      gustiness: 0.25,
      variation: 0.2,
    };
    const strong: WindSpec = {
      layers: [{ altitudeAgl: 10, directionDeg: 270, speed: 9 }],
      gustiness: 0.7,
      variation: 0.2,
    };
    const swapped = new WindField({ seed: options.seed, ...light });
    const always = new WindField({ seed: options.seed, ...strong });
    for (let i = 0; i < 1200; i += 1) {
      if (i === 600) swapped.setProfile(strong);
      swapped.update(1 / 60);
      always.update(1 / 60);
    }
    assertClose(swapped.baseSpeed, 9, 1e-12, "new weather re-quotes the mean wind");
    assertClose(swapped.gustiness, 0.7, 1e-12, "and its gustiness");
    assertClose(
      swapped.speed,
      always.speed,
      1e-12,
      "a swapped airmass gusts identically to one launched in it",
    );
    assertClose(
      swapped.directionDeg,
      always.directionDeg,
      1e-12,
      "and the direction stays where the seed put it",
    );

    swapped.setProfile({
      layers: [{ altitudeAgl: 10, directionDeg: 270, speed: -5 }],
      gustiness: 4,
      variation: -2,
    });
    assertClose(swapped.baseSpeed, 0, 1e-12, "a negative wind speed is clamped away");
    assertClose(swapped.gustiness, 1, 1e-12, "and gustiness stays inside 0..1");
    assertClose(swapped.variation, 0, 1e-12, "as does the variation");
  });

  await suite("visibility", async () => {
    // A ridge running east-west at y = 500, everything else at sea level.
    const terrain = new TerrainField(
      async (points: readonly TerrainQuery[]) =>
        points.map((p) => (Math.abs(p.y - 500) < 150 ? 900 : 0)),
      { cellSize: 50 },
    );
    await terrain.prefill(V.vec3(0, 500, 0), 1500);

    const clear = new VisibilitySystem(terrain, {
      weather: WEATHER_PROFILES[WEATHER.Clear],
      daylight: 1,
      layers: layersFromProfile(WEATHER_PROFILES[WEATHER.Clear]),
    });

    assertClose(
      clear.sightRange,
      WEATHER_PROFILES[WEATHER.Clear].sightRange,
      1e-9,
      "full daylight gives the weather's full sight range",
    );

    const near = clear.visibility(V.vec3(0, 0, 1000), V.vec3(200, 0, 1000));
    assertClose(near, 1, 1e-6, "a contact alongside is fully visible");

    const beyond = clear.visibility(
      V.vec3(0, 0, 1000),
      V.vec3(30000, 0, 1000),
    );
    assertClose(beyond, 0, 1e-9, "beyond the sight range nothing is visible");

    const halfway = clear.visibility(V.vec3(0, 0, 1000), V.vec3(16000, 0, 1000));
    assertBetween(halfway, 0.01, 0.99, `range fades rather than switching off (${halfway.toFixed(2)})`);

    // Night shrinks the range without changing the weather.
    clear.setDaylight(0);
    assert(
      clear.sightRange < WEATHER_PROFILES[WEATHER.Clear].sightRange * 0.5,
      "night cuts the sight range",
    );
    clear.setDaylight(1);

    // Fog cuts it much further.
    const foggy = new VisibilitySystem(terrain, {
      weather: WEATHER_PROFILES[WEATHER.Fog],
      daylight: 1,
      layers: layersFromProfile(WEATHER_PROFILES[WEATHER.Fog]),
    });
    assert(
      foggy.sightRange < clear.sightRange / 10,
      `fog is an order of magnitude worse (${foggy.sightRange} m vs ${clear.sightRange} m)`,
    );
    assertClose(
      foggy.visibility(V.vec3(0, 0, 1000), V.vec3(3000, 0, 1000)),
      0,
      1e-9,
      "3 km is already invisible in fog",
    );

    // Terrain blocks the line of sight outright.
    const throughRidge = clear.visibility(
      V.vec3(0, 0, 300),
      V.vec3(0, 1000, 300),
    );
    assertClose(throughRidge, 0, 1e-9, "a ridge in the way blocks the contact");
    const overRidge = clear.visibility(
      V.vec3(0, 0, 1400),
      V.vec3(0, 1000, 1400),
    );
    assert(overRidge > 0.5, "flying over the ridge restores the sight line");
    assert(
      clear.hasLineOfSight(V.vec3(0, 0, 1400), V.vec3(0, 1000, 1400)),
      "line of sight agrees",
    );

    // Unsampled terrain must not invent a mountain.
    const empty = new TerrainField(
      async (points: readonly TerrainQuery[]) => points.map(() => null),
      { cellSize: 50 },
    );
    const blind = new VisibilitySystem(empty, {
      weather: WEATHER_PROFILES[WEATHER.Clear],
      daylight: 1,
      layers: layersFromProfile(WEATHER_PROFILES[WEATHER.Clear]),
    });
    assert(
      blind.hasLineOfSight(V.vec3(0, 0, 100), V.vec3(0, 2000, 100)),
      "missing terrain data never blocks a sight line",
    );

    // Cloud: inside the layer you can barely see out.
    const cloudy = new VisibilitySystem(terrain, {
      weather: WEATHER_PROFILES[WEATHER.Cloudy],
      daylight: 1,
      layers: layersFromProfile(WEATHER_PROFILES[WEATHER.Cloudy]),
    });
    const inCloud = cloudy.visibility(V.vec3(0, 0, 1000), V.vec3(600, 0, 1000));
    const belowCloud = cloudy.visibility(V.vec3(0, 0, 400), V.vec3(600, 0, 400));
    assert(
      inCloud < belowCloud * 0.5,
      `sitting in cloud hides contacts (${inCloud.toFixed(2)} vs ${belowCloud.toFixed(2)})`,
    );
    assert(cloudy.isInCloud(V.vec3(0, 0, 1000)), "the layer bounds are respected");
    assert(!cloudy.isInCloud(V.vec3(0, 0, 400)), "below the base is clear");

    // Changing the weather mid-flight moves both the sight range and the cloud
    // layer, on the system that is already running.
    const switched = new VisibilitySystem(terrain, {
      weather: WEATHER_PROFILES[WEATHER.Clear],
      daylight: 1,
      layers: layersFromProfile(WEATHER_PROFILES[WEATHER.Clear]),
    });
    // Setting the weather brings its decks with it: nothing has to remember
    // to move the cloud separately.
    switched.setWeather(WEATHER_PROFILES[WEATHER.Fog]);
    assertClose(
      switched.sightRange,
      foggy.sightRange,
      1e-9,
      "flying into fog shortens the sight range without a restart",
    );
    assert(
      switched.isInCloud(V.vec3(0, 0, 300)),
      "and brings the cloud layer down with it",
    );
    assert(
      !switched.isInCloud(V.vec3(0, 0, 1500)),
      "leaving nothing behind where the old layer was",
    );

    // Looking down at a contact against terrain is harder than looking up.
    const lookingUp = clear.visibility(V.vec3(0, 0, 1000), V.vec3(4000, 0, 1600));
    const lookingDown = clear.visibility(V.vec3(0, 0, 1600), V.vec3(4000, 0, 1000));
    assert(
      lookingDown < lookingUp,
      `ground clutter costs visibility (${lookingDown.toFixed(2)} down vs ${lookingUp.toFixed(2)} up)`,
    );

    // An empty sky hides nothing: the cover the pilot set is the cover the
    // visibility model works from, not the preset it was taken from.
    const thinned = withCloudCover(WEATHER_PROFILES[WEATHER.Cloudy], 0);
    const emptySky = new VisibilitySystem(terrain, {
      weather: thinned,
      daylight: 1,
      layers: layersFromProfile(thinned),
    });
    const overcast = new VisibilitySystem(terrain, {
      weather: WEATHER_PROFILES[WEATHER.Cloudy],
      daylight: 1,
      layers: layersFromProfile(WEATHER_PROFILES[WEATHER.Cloudy]),
    });
    const inLayer = V.vec3(0, 0, 1000);
    const alongLayer = V.vec3(3000, 0, 1000);
    assert(
      overcast.visibility(inLayer, alongLayer) <
        emptySky.visibility(inLayer, alongLayer),
      "cloud in the way costs a contact",
    );
    assertClose(
      emptySky.visibility(inLayer, alongLayer),
      1,
      1e-6,
      "and with the cover slid to nothing there is no cloud in the way",
    );
  });

  suite("cloud cover is the pilot's to set", () => {
    const cloudy = WEATHER_PROFILES[WEATHER.Cloudy];

    assert(
      withCloudCover(cloudy, cloudy.cloudCoverage) === cloudy,
      "asking for the cover it already has changes nothing at all",
    );

    const empty = withCloudCover(cloudy, 0);
    assert(empty.cloudCoverage === 0, "an empty sky is an empty sky");
    assert(
      empty.id === cloudy.id &&
        empty.windSpeed === cloudy.windSpeed &&
        empty.fogExtinction === cloudy.fogExtinction &&
        empty.cloudBaseAgl === cloudy.cloudBaseAgl,
      "and the rest of the weather is untouched",
    );

    assert(
      withCloudCover(cloudy, -1).cloudCoverage === 0 &&
        withCloudCover(cloudy, 4).cloudCoverage === 1,
      "nothing outside a covered sky is reachable",
    );
  });

  suite("rain streaks", () => {
    // Camera on the nose, looking north, in the local ENU frame.
    const north = {
      right: V.vec3(1, 0, 0),
      up: V.vec3(0, 0, 1),
      forward: V.vec3(0, 1, 0),
      down: V.vec3(0, 0, -1),
      fallSpeed: 7,
      tanHalfFovY: 0.6,
    };

    // Parked in still air, rain falls straight down the frame and there is no
    // vanishing point to fan it out of.
    const still = rainStreakField({
      ...north,
      cameraVelocity: V.vec3(),
      wind: V.vec3(),
    });
    assertClose(still.axisX, 0, 1e-9, "still air puts the streaks vertical");
    assertClose(still.axisY, -1, 1e-9, "and pointing down the frame");
    assertClose(still.radial, 0, 1e-9, "with no vanishing point to fan out of");
    assertClose(still.speed, 7, 1e-9, "at the drop's own fall speed");

    // Flying north at 30 m/s: the drops stream backwards past the camera, so
    // they radiate out of a point just above the middle of the frame.
    const flying = rainStreakField({
      ...north,
      cameraVelocity: V.vec3(0, 30, 0),
      wind: V.vec3(),
    });
    assert(
      flying.radial > 0.9,
      `flying fast makes the field radial (${flying.radial.toFixed(2)})`,
    );
    assertClose(flying.focusX, 0, 1e-9, "straight ahead, the focus stays centred");
    assert(
      flying.focusY > 0,
      `and sits above the centre because the drops also fall (${flying.focusY.toFixed(3)})`,
    );
    assert(
      flying.speed > still.speed,
      "and the drops go past faster than they fall",
    );

    // A crosswind with no forward motion leans the streaks without giving them
    // a vanishing point: nothing is receding down the view axis.
    const crosswind = rainStreakField({
      ...north,
      cameraVelocity: V.vec3(),
      wind: V.vec3(9, 0, 0),
    });
    assert(crosswind.axisX > 0, "a crosswind leans the streaks across the frame");
    assert(crosswind.axisY < 0, "while they are still falling");
    assertClose(
      Math.hypot(crosswind.axisX, crosswind.axisY),
      1,
      1e-9,
      "and the streak axis stays a unit vector",
    );
    assertClose(crosswind.radial, 0, 1e-9, "with no vanishing point on screen");

    // Flying backwards, the drops close on the vanishing point rather than
    // stream out of it, which the sign of `radial` is what carries.
    const reversed = rainStreakField({
      ...north,
      cameraVelocity: V.vec3(0, -30, 0),
      wind: V.vec3(),
    });
    assert(
      reversed.radial < -0.9,
      `drops closing on the camera reverse the flow (${reversed.radial.toFixed(2)})`,
    );

    // Wind blowing exactly as fast as the aircraft flies is dead air on the
    // canopy: nothing but the fall is left.
    const matched = rainStreakField({
      ...north,
      cameraVelocity: V.vec3(0, 12, 0),
      wind: V.vec3(0, 12, 0),
    });
    assertClose(
      matched.speed,
      7,
      1e-9,
      "flying with the wind leaves only the drop's own fall",
    );
    assertClose(matched.radial, 0, 1e-9, "and no fan to it");
  });
}
