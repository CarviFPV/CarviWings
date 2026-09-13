import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  CLOUD_AMOUNT,
  CLOUD_TYPE,
  MIN_CLOUD_BASE,
  ceilingAgl,
  clampLayers,
  formatLayer,
  hasThunderCloud,
  highestCloudTop,
  normalizeLayers,
  primaryLayer,
  skyCoverage,
} from "../environment/sky";
import type { CloudLayer } from "../environment/sky";
import type { WeatherState } from "../environment/weather";
import {
  PRECIPITATION,
  PRESET_WEATHER,
  UNLIMITED_VISIBILITY,
  WEATHER,
  WEATHER_PROFILES,
  WEATHER_SOURCE,
  WEATHER_SOURCE_CHOICES,
  describeWeather,
  isWeatherSourceChoice,
  lerpAngleDegrees,
  nearestPreset,
  normalizeWindLayers,
  resolveWeatherProfile,
  surfaceWind,
  visibilityForExtinction,
  withCloudCover,
  withSkyCoverage,
} from "../environment/weather";
import {
  formatMetar,
  parseMetar,
  weatherStateFromMetar,
  weatherStateFromRawMetar,
} from "../environment/metar";
import { buildSkyProfile, niceStep } from "../environment/skyProfile";
import { LightningField, stormActivity } from "../environment/lightning";
import { generateWeather } from "../environment/generator";
import { vec3 } from "../math/vec3";

function layer(
  amount: CloudLayer["amount"],
  type: CloudLayer["type"],
  baseAgl: number,
  depth: number,
): CloudLayer {
  return { amount, type, baseAgl, depth };
}

export function runWeatherTests(): void {
  suite("cloud layers", () => {
    const layers = normalizeLayers([
      layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Cirrus, 8000, 900),
      layer(CLOUD_AMOUNT.Broken, CLOUD_TYPE.Stratocumulus, 700, 600),
      layer(CLOUD_AMOUNT.Scattered, CLOUD_TYPE.Altostratus, 3500, 1200),
    ]);
    assert(layers.length === 3, "three decks survive");
    assert(
      (layers[0] as CloudLayer).baseAgl === 700 &&
        (layers[2] as CloudLayer).baseAgl === 8000,
      "and come back lowest first",
    );

    assert(
      normalizeLayers([
        layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Cumulus, 500, 400),
        layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Cumulus, 900, 400),
        layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Cumulus, 1300, 400),
        layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Cumulus, 1700, 400),
      ]).length === 3,
      "a fourth deck is dropped from the top down",
    );

    // A base below the launch point is not a mistake to be corrected: it is a
    // deck in the valley, seen from the ridge the flight starts on.
    const below = normalizeLayers([
      layer(CLOUD_AMOUNT.Overcast, CLOUD_TYPE.Stratus, -900, 3),
    ])[0] as CloudLayer;
    assertClose(below.baseAgl, -900, 1e-9, "a deck below the launch point stays there");
    assert(below.depth >= 60, "and a deck with no depth is given some");
    assertClose(
      (normalizeLayers([
        layer(CLOUD_AMOUNT.Overcast, CLOUD_TYPE.Stratus, -99000, 400),
      ])[0] as CloudLayer).baseAgl,
      MIN_CLOUD_BASE,
      1e-9,
      "but the floor still holds",
    );

    // The editor's version keeps the pilot's order, so a base slider being
    // dragged past its neighbour does not swap the deck under the pointer.
    const unsorted = clampLayers([
      layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Cirrus, 8000, 900),
      layer(CLOUD_AMOUNT.Broken, CLOUD_TYPE.Stratocumulus, 700, 600),
    ]);
    assert(
      (unsorted[0] as CloudLayer).baseAgl === 8000,
      "clampLayers leaves the decks in the order they were given in",
    );

    assert(
      highestCloudTop([
        layer(CLOUD_AMOUNT.Overcast, CLOUD_TYPE.Stratus, -900, 300),
      ]) === -600,
      "and the lid on a sky entirely below the launch point is below it too",
    );
    assert(
      formatLayer(layer(CLOUD_AMOUNT.Broken, CLOUD_TYPE.Stratus, -900, 300)) ===
        "BKN000",
      "a report has no way to write a base below the field, so it writes zero",
    );

    // Reported amounts are cumulative, so the total is the largest of them
    // rather than a sum: SCT under BKN is a broken sky, not an overcast one.
    assertClose(skyCoverage(layers), 0.75, 1e-9, "the sky is as covered as its most covered deck");
    assertClose(skyCoverage([]), 0, 1e-9, "and an empty sky is empty");

    assertClose(highestCloudTop(layers), 8900, 1e-9, "the lid is the highest top");
    assertClose(ceilingAgl(layers), 700, 1e-9, "the ceiling is the lowest broken deck");
    assert(
      !Number.isFinite(
        ceilingAgl([layer(CLOUD_AMOUNT.Scattered, CLOUD_TYPE.Cumulus, 900, 500)]),
      ),
      "a sky with nothing broken in it has no ceiling at all",
    );

    assert(
      (primaryLayer(layers) as CloudLayer).baseAgl === 700,
      "the deck that matters is the one filling most of the sky",
    );
    assert(primaryLayer([]) === null, "and an empty sky has none");

    assert(
      !hasThunderCloud(layers) &&
        hasThunderCloud([
          layer(CLOUD_AMOUNT.Scattered, CLOUD_TYPE.Cumulonimbus, 900, 8000),
        ]),
      "only a cumulonimbus makes lightning",
    );

    assert(
      formatLayer(layer(CLOUD_AMOUNT.Broken, CLOUD_TYPE.Cumulonimbus, 762, 8000)) ===
        "BKN025CB",
      `a deck writes itself the way a report does (${formatLayer(
        layer(CLOUD_AMOUNT.Broken, CLOUD_TYPE.Cumulonimbus, 762, 8000),
      )})`,
    );
  });

  suite("weather resolves into a profile", () => {
    // The presets are now written in the same vocabulary as everything else and
    // resolved through the same function, so what is checked is that the
    // derivation orders them the way a pilot would.
    const clear = WEATHER_PROFILES[WEATHER.Clear];
    const cloudy = WEATHER_PROFILES[WEATHER.Cloudy];
    const rain = WEATHER_PROFILES[WEATHER.Rain];
    const fog = WEATHER_PROFILES[WEATHER.Fog];
    const storm = WEATHER_PROFILES[WEATHER.Storm];
    const snow = WEATHER_PROFILES[WEATHER.Snow];

    assert(
      clear.sightRange > cloudy.sightRange &&
        cloudy.sightRange > rain.sightRange &&
        rain.sightRange > fog.sightRange,
      "you can see furthest on the clearest day and least in fog",
    );
    assert(
      clear.fogExtinction < cloudy.fogExtinction &&
        cloudy.fogExtinction < rain.fogExtinction &&
        rain.fogExtinction < fog.fogExtinction,
      "and the air thickens the other way round",
    );
    assert(
      clear.brightness > cloudy.brightness && cloudy.brightness > rain.brightness,
      "cloud and rain take the light out of the day",
    );
    assert(
      clear.saturation > rain.saturation && rain.saturation > fog.saturation,
      "and the colour with it",
    );

    // The four historic presets were hand-tuned for a year; the derivation has
    // to land near them or every flight looks different for no reason.
    const historic: Array<[string, number, number]> = [
      ["clear sight range", clear.sightRange, 20000],
      ["cloudy sight range", cloudy.sightRange, 15000],
      ["rain sight range", rain.sightRange, 4500],
      ["fog sight range", fog.sightRange, 1300],
      ["clear brightness", clear.brightness, 1],
      ["cloudy brightness", cloudy.brightness, 0.82],
      ["rain brightness", rain.brightness, 0.58],
      ["fog brightness", fog.brightness, 0.68],
    ];
    for (const [name, actual, expected] of historic) {
      assertBetween(actual / expected, 0.8, 1.25, `${name} is close to what it was`);
    }
    // The fog is no longer a number tuned by eye: it is the extinction the
    // reported visibility implies, so the air has taken all but a few per cent
    // of a ridge's contrast by the time the ridge is at that distance. This is
    // what the renderer solves its fog curve against, and the whole of why
    // asking for five hundred metres now gets five hundred metres.
    for (const profile of Object.values(WEATHER_PROFILES)) {
      assertClose(
        Math.exp(-profile.fogExtinction * profile.visibilityM),
        Math.exp(-3),
        1e-9,
        `${profile.label}: the air closes at the visibility it reports`,
      );
      assertBetween(
        visibilityForExtinction(profile.inCloudExtinction),
        20,
        200,
        `${profile.label}: cloud is thicker inside than out, but not opaque`,
      );
      assert(
        profile.inCloudExtinction >= profile.fogExtinction,
        `${profile.label}: and never clearer inside a deck than outside it`,
      );
      assert(
        profile.layers.every((deck) => deck.topAgl > deck.baseAgl),
        `${profile.label}: every deck has a top above its base`,
      );
    }

    assert(rain.rain > 0 && rain.snow === 0, "rain falls as rain");
    assert(snow.snow > 0 && snow.rain === 0, "and snow as snow");
    assert(storm.thunderstorm, "the storm preset thunders");
    assert(
      !clear.thunderstorm && !rain.thunderstorm,
      "and nothing else does",
    );
    assertClose(
      storm.cloudTopAgl,
      8900,
      1e-6,
      "a cell tops out where its cumulonimbus does",
    );

    // Cloud that does not exist cannot be a base.
    const empty = resolveWeatherProfile({
      ...PRESET_WEATHER[WEATHER.Clear],
      layers: [],
    });
    assert(!Number.isFinite(empty.cloudBaseAgl), "an empty sky has no base");
    assertClose(empty.cloudTopAgl, 0, 1e-9, "and no lid on the weather either");
    assertClose(empty.cloudCoverage, 0, 1e-9, "and no cover");
  });

  suite("precipitation follows the cloud it falls out of", () => {
    const nimbostratus = resolveWeatherProfile({
      ...PRESET_WEATHER[WEATHER.Clear],
      temperatureC: 8,
      layers: [layer(CLOUD_AMOUNT.Overcast, CLOUD_TYPE.Nimbostratus, 500, 3000)],
    });
    assert(
      nimbostratus.precipitation.kind === PRECIPITATION.Rain,
      "a deck of nimbostratus rains without being told to",
    );

    const cold = resolveWeatherProfile({
      ...PRESET_WEATHER[WEATHER.Clear],
      temperatureC: -4,
      layers: [layer(CLOUD_AMOUNT.Overcast, CLOUD_TYPE.Nimbostratus, 500, 3000)],
    });
    assert(
      cold.precipitation.kind === PRECIPITATION.Snow,
      "and the same deck below freezing snows instead",
    );

    const fairWeather = resolveWeatherProfile({
      ...PRESET_WEATHER[WEATHER.Clear],
      layers: [layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Cumulus, 1200, 700)],
    });
    assert(
      fairWeather.precipitation.kind === PRECIPITATION.None,
      "fair-weather cumulus does not rain",
    );
  });

  suite("cloud cover is the pilot's to set", () => {
    const cloudy = WEATHER_PROFILES[WEATHER.Cloudy];
    assert(
      withCloudCover(cloudy, cloudy.cloudCoverage) === cloudy,
      "asking for the cover it already has changes nothing at all",
    );

    const half = withCloudCover(cloudy, cloudy.cloudCoverage / 2);
    assert(
      half.layers.length === cloudy.layers.length,
      "thinning the sky keeps every deck",
    );
    assert(
      half.layers.every(
        (deck, i) =>
          Math.abs(
            deck.coverage - (cloudy.layers[i] as { coverage: number }).coverage / 2,
          ) < 1e-9,
      ),
      "and thins all of them by the same ratio, so a two-deck sky stays one sky",
    );

    const empty = withCloudCover(WEATHER_PROFILES[WEATHER.Rain], 0);
    assert(empty.cloudCoverage === 0, "an empty sky is an empty sky");
    assert(empty.layers.length === 0, "with nothing left to draw");
    assertClose(empty.rain, 0, 1e-9, "and nothing left to rain out of");
    assertClose(empty.cloudTopAgl, 0, 1e-9, "and no lid over an empty sky");

    const stormless = withCloudCover(WEATHER_PROFILES[WEATHER.Storm], 0);
    assert(!stormless.thunderstorm, "a storm with no cloud in it is not a storm");

    assert(
      withCloudCover(cloudy, -1).cloudCoverage === 0 &&
        withCloudCover(cloudy, 4).cloudCoverage === 1,
      "nothing outside a covered sky is reachable",
    );

    const thinned = withSkyCoverage(PRESET_WEATHER[WEATHER.Cloudy], 0.2);
    assert(
      skyCoverage(thinned.layers) < skyCoverage(PRESET_WEATHER[WEATHER.Cloudy].layers),
      "the same slider works on a state as well as a profile",
    );
    assert(
      withSkyCoverage(PRESET_WEATHER[WEATHER.Cloudy], 0).layers.length === 0,
      "and empties it entirely at nothing",
    );
  });

  suite("METAR decodes", () => {
    const raw =
      "METAR LSZH 121620Z 25012G24KT 220V280 9999 -SHRA FEW018 SCT030CB BKN070 17/13 Q1009 NOSIG";
    const report = parseMetar(raw);
    assert(report !== null, "a routine report parses");
    if (!report) return;

    assert(report.station === "LSZH", "the station comes out");
    assert(report.dayOfMonth === 12 && report.hourUtc === 16, "and the time");
    assertClose(report.wind?.directionDeg ?? -1, 250, 1e-9, "wind direction");
    assertClose(report.wind?.speed ?? 0, 12 * 0.514444, 1e-6, "wind speed in m/s");
    assertClose(report.wind?.gust ?? 0, 24 * 0.514444, 1e-6, "and the gust");
    assertClose(report.wind?.variableFromDeg ?? -1, 220, 1e-9, "the variation range");
    assertClose(
      report.visibilityM ?? 0,
      UNLIMITED_VISIBILITY,
      1e-9,
      "9999 means ten kilometres or more",
    );
    assert(report.clouds.length === 3, "three cloud groups");
    assert(
      report.clouds[1]?.type === CLOUD_TYPE.Cumulonimbus,
      "and the CB is named as one",
    );
    assert(
      report.phenomena.length === 1 &&
        report.phenomena[0]?.descriptor === "SH" &&
        report.phenomena[0]?.intensity === -1,
      "light showers of rain",
    );
    assert(report.temperatureC === 17 && report.dewPointC === 13, "temperature and dew point");
    assert(report.pressureHpa === 1009, "and the QNH");

    const state = weatherStateFromMetar(report);
    assert(state.source === WEATHER_SOURCE.Metar, "it becomes a decoded sky");
    assert(state.layers.length === 3, "with all three decks");
    assertClose(
      (state.layers[0] as CloudLayer).baseAgl,
      1800 * 0.3048,
      1,
      "bases convert from hundreds of feet",
    );
    assert(state.thunderstorm, "a CB in the report means thunder");
    assert(
      state.precipitation.kind === PRECIPITATION.Rain &&
        state.precipitation.showers,
      "and showers of rain are showers of rain",
    );
    assert(
      state.wind.layers.length > 1,
      "a surface wind is given a gradient wind above it",
    );
    assert(
      (state.wind.layers[1] as { speed: number }).speed >
        (state.wind.layers[0] as { speed: number }).speed,
      "which blows harder than the surface does",
    );
    assertBetween(state.wind.gustiness, 0.1, 1, "the gust group sets the gustiness");
    assert(state.preset === WEATHER.Storm, "and the day is filed as a storm");

    // Cloud reported over a sea-level field, flown from a ridge two kilometres
    // up, has to end up above the ridge rather than inside it.
    const shifted = weatherStateFromMetar(report, {
      stationElevationOffset: -1500,
    });
    assertClose(
      (shifted.layers[0] as CloudLayer).baseAgl,
      1800 * 0.3048 + 1500,
      1,
      "a station below the mission lifts the bases with it",
    );

    // And the other way round, which is the case that used to be wrong: a
    // report from an aerodrome down in the valley, flown from the ridge above
    // it, describes cloud the pilot is looking *down* on. Clamping that to
    // just above the launch point is what put the start point inside the deck.
    const fromBelow = weatherStateFromMetar(report, {
      stationElevationOffset: 2000,
    });
    assertClose(
      (fromBelow.layers[0] as CloudLayer).baseAgl,
      1800 * 0.3048 - 2000,
      1,
      "a station above the mission drops the bases below the launch point",
    );
    assert(
      (fromBelow.layers[0] as CloudLayer).baseAgl < 0,
      "which is where a deck in the valley actually is",
    );
  });

  suite("METAR handles the awkward reports", () => {
    const cavok = parseMetar("EGLL 021150Z 27008KT CAVOK 21/09 Q1024");
    assert(cavok?.cavok === true, "CAVOK is recognised");
    assertClose(
      cavok?.visibilityM ?? 0,
      UNLIMITED_VISIBILITY,
      1e-9,
      "and means you can see as far as it goes",
    );
    const cavokSky = cavok ? weatherStateFromMetar(cavok) : null;
    assert(cavokSky?.layers.length === 0, "with nothing in the sky at all");

    const snowy = weatherStateFromRawMetar(
      "METAR ENGM 151220Z 03015G28KT 1200 +SN VV004 M03/M05 Q0998",
    );
    assert(snowy !== null, "a snowy obscured sky parses");
    assert(
      snowy?.precipitation.kind === PRECIPITATION.Snow &&
        (snowy?.precipitation.intensity ?? 0) > 0.8,
      "heavy snow is heavy snow",
    );
    assert(
      (snowy?.layers.length ?? 0) > 0,
      "a vertical visibility still gives something to fly into",
    );
    assert(snowy?.preset === WEATHER.Fog, "1200 m of visibility is a fog day");

    const american = parseMetar("KJFK 201551Z 30015KT 10SM FEW045 BKN250 M02/M11 A3005");
    assertClose(
      american?.visibilityM ?? 0,
      10 * 1609.344,
      1,
      "statute miles convert to metres",
    );
    assertClose(american?.pressureHpa ?? 0, 1017.6, 1, "and inches of mercury to hPa");
    assert(american?.temperatureC === -2, "a minus temperature is a minus temperature");

    const variable = parseMetar("LOWI 010650Z VRB03KT 4000 BR SCT004 BKN012 02/02 Q1021");
    const variableSky = variable ? weatherStateFromMetar(variable) : null;
    assert(
      (variableSky?.wind.variation ?? 0) > 0.6,
      "a variable wind wanders a great deal",
    );
    assert(
      (variableSky?.layers[0] as CloudLayer | undefined)?.type === CLOUD_TYPE.Stratus,
      "low, solid cloud with no genus reported is inferred as stratus",
    );

    assert(parseMetar("") === null, "nothing is not a report");
    assert(parseMetar("hello there") === null, "and neither is prose");
    assert(
      parseMetar("metar lszh 121620z 25012kt 9999 few018 17/13 q1009") !== null,
      "but a report in lower case is still a report",
    );
  });

  suite("a sky writes itself back out as a report", () => {
    const written = formatMetar(PRESET_WEATHER[WEATHER.Storm], {
      station: "LSZH",
      observedAt: new Date("2026-03-12T16:20:00Z"),
    });
    assert(written.startsWith("METAR LSZH 121620Z"), `the header is right (${written})`);
    assert(written.includes("TS"), "a storm says so");
    assert(/Q\d{4}$/.test(written), "and it ends with the QNH");

    // The round trip is not lossless — a report cannot say how deep a deck is —
    // but everything a report *can* say has to survive it.
    const back = weatherStateFromRawMetar(written);
    assert(back !== null, "what was written can be read again");
    if (!back) return;
    assert(back.thunderstorm, "the thunder survives");
    assert(
      back.layers.length === PRESET_WEATHER[WEATHER.Storm].layers.length,
      "and so does every deck",
    );
    assertClose(
      back.temperatureC,
      PRESET_WEATHER[WEATHER.Storm].temperatureC,
      1,
      "and the temperature",
    );
    assertClose(
      surfaceWind(back.wind).speed,
      surfaceWind(PRESET_WEATHER[WEATHER.Storm].wind).speed,
      0.6,
      "and the surface wind, to the knot it was rounded to",
    );

    const clear = formatMetar(
      { ...PRESET_WEATHER[WEATHER.Clear], layers: [] },
      { station: "LSGG" },
    );
    assert(clear.includes("CAVOK"), `an empty, unlimited sky is CAVOK (${clear})`);
  });

  suite("lightning", () => {
    const storm = new LightningField({
      seed: "STORM",
      activity: 1,
      baseZ: 900,
      topZ: 8900,
      radius: 9000,
    });
    const observer = vec3(0, 0, 400);

    let strikes = 0;
    let brightest = 0;
    let deepest = 0;
    for (let i = 0; i < 60 * 300; i += 1) {
      storm.update(1 / 60, observer);
      brightest = Math.max(brightest, storm.flash);
      for (const strike of storm.consumeStrikes()) {
        strikes += 1;
        deepest = Math.max(deepest, strike.thunderDelay);
        assert(
          strike.position.z >= 900 && strike.position.z <= 8900,
          "a discharge happens inside the cell",
        );
        assert(
          Math.hypot(strike.position.x, strike.position.y) <= 9000 + 1e-6,
          "and within the area the cell covers",
        );
      }
    }
    assertBetween(strikes, 20, 900, `an active cell flashes repeatedly (${strikes} in five minutes)`);
    assertBetween(brightest, 0.2, 1, "and lights the sky when it does");
    assert(deepest > 1, `thunder arrives late (${deepest.toFixed(1)} s at the furthest)`);

    // Determinism: the same storm flashes at the same instants every time.
    const build = () =>
      new LightningField({
        seed: "STORM",
        activity: 0.6,
        baseZ: 900,
        topZ: 8900,
        radius: 6000,
      });
    const a = build();
    const b = build();
    let same = true;
    for (let i = 0; i < 60 * 120; i += 1) {
      a.update(1 / 60, observer);
      b.update(1 / 60, observer);
      if (Math.abs(a.flash - b.flash) > 1e-12) same = false;
    }
    assert(same, "the same seed gives the same storm");

    const quiet = new LightningField({
      seed: "QUIET",
      activity: 0,
      baseZ: 900,
      topZ: 2000,
      radius: 6000,
    });
    for (let i = 0; i < 60 * 300; i += 1) quiet.update(1 / 60, observer);
    assert(!quiet.active, "a sky with no cell in it is not active");
    assert(quiet.consumeStrikes().length === 0, "and never fires");
    assertClose(quiet.flash, 0, 1e-12, "and the sky stays dark");

    // A cell can grow or die mid-flight without restarting the schedule.
    quiet.setStorm({ activity: 0.8, baseZ: 900, topZ: 8000 });
    assert(quiet.active, "switching a storm on mid-flight makes it active");
    let fired = false;
    for (let i = 0; i < 60 * 300; i += 1) {
      quiet.update(1 / 60, observer);
      if (quiet.consumeStrikes().length > 0) fired = true;
    }
    assert(fired, "and it starts flashing");
    quiet.setStorm({ activity: 0, baseZ: 900, topZ: 8000 });
    quiet.update(1 / 60, observer);
    assertClose(quiet.flash, 0, 1e-12, "switching it off leaves the sky unlit");

    assertClose(
      stormActivity({ thunderstorm: false, coverage: 1, cloudDepth: 9000 }),
      0,
      1e-12,
      "no thunderstorm means no activity at all",
    );
    assert(
      stormActivity({ thunderstorm: true, coverage: 0.9, cloudDepth: 9000 }) >
        stormActivity({ thunderstorm: true, coverage: 0.2, cloudDepth: 3000 }),
      "a deep, well-covered cell is busier than a lone one",
    );
  });

  suite("generated weather", () => {
    const first = generateWeather("ALPHA", { latitude: 47 });
    const again = generateWeather("ALPHA", { latitude: 47 });
    assert(
      JSON.stringify(first) === JSON.stringify(again),
      "the same seed gives the same day",
    );
    assert(
      JSON.stringify(generateWeather("BRAVO", { latitude: 47 })) !==
        JSON.stringify(first),
      "and a different seed does not",
    );

    // Every situation has to produce a sky that makes sense as weather.
    const situations = [
      "ridge",
      "warmSector",
      "frontal",
      "unstable",
      "storms",
      "cold",
      "fog",
    ] as const;
    for (const situation of situations) {
      const state = generateWeather(`SEED-${situation}`, { situation });
      const profile = resolveWeatherProfile(state);
      assertBetween(
        state.visibilityM,
        100,
        UNLIMITED_VISIBILITY,
        `${situation}: visibility is a real visibility`,
      );
      assert(
        state.layers.length <= 3,
        `${situation}: never more decks than can be drawn`,
      );
      assert(
        state.dewPointC <= state.temperatureC + 1e-6,
        `${situation}: the dew point is never above the temperature`,
      );
      assert(
        surfaceWind(state.wind).speed <= 80,
        `${situation}: the wind is flyable`,
      );
      assert(
        profile.layers.every((deck) => deck.topAgl > deck.baseAgl),
        `${situation}: every deck has depth`,
      );
      assert(
        state.source === WEATHER_SOURCE.Random,
        `${situation}: it is filed as generated`,
      );
    }

    const storms = generateWeather("SEED-storms", { situation: "storms" });
    assert(storms.thunderstorm, "the storm situation thunders");
    assert(
      resolveWeatherProfile(storms).cloudTopAgl > 5000,
      "and puts a cell up where a cell goes",
    );

    const fog = generateWeather("SEED-fog", { situation: "fog" });
    assert(fog.visibilityM < 1500, "a fog morning is a fog morning");
    assert(nearestPreset(fog) === WEATHER.Fog, "and is filed as one");

    // A colder place gets colder weather.
    let arctic = 0;
    let tropics = 0;
    for (let i = 0; i < 40; i += 1) {
      arctic += generateWeather(`DAY-${i}`, { latitude: 78 }).temperatureC;
      tropics += generateWeather(`DAY-${i}`, { latitude: 5 }).temperatureC;
    }
    assert(arctic < tropics, "a generated day near the pole is colder than one at the equator");
  });

  suite("the ways a pilot can say what the weather is", () => {
    assert(
      WEATHER_SOURCE_CHOICES.length === 4,
      "there are four of them to pick between",
    );
    assert(
      WEATHER_SOURCE_CHOICES[0] === WEATHER_SOURCE.Live,
      "the real weather over the start point is the first, and the default",
    );
    assert(
      new Set(WEATHER_SOURCE_CHOICES).size === WEATHER_SOURCE_CHOICES.length,
      "and none of them is offered twice",
    );
    assert(
      WEATHER_SOURCE_CHOICES.every((source) =>
        (Object.values(WEATHER_SOURCE) as string[]).includes(source),
      ),
      "every one of them is a source a sky can actually carry",
    );

    assert(
      !isWeatherSourceChoice(WEATHER_SOURCE.Preset),
      "a preset is not one of them: it is what a sky is filed under, not a way of picking one",
    );
    assert(
      isWeatherSourceChoice(PRESET_WEATHER[WEATHER.Clear].source) === false,
      "which is what a preset state still says it is",
    );
    assert(
      !isWeatherSourceChoice("SUNSHINE") && !isWeatherSourceChoice(undefined),
      "and neither is anything else that turns up in storage",
    );
  });

  suite("weather reads back in words", () => {
    const summary = describeWeather(PRESET_WEATHER[WEATHER.Storm]);
    assert(summary.includes("thunderstorms"), `a storm says so (${summary})`);
    assert(summary.includes("wind"), "and the wind is quoted");
    assert(
      describeWeather({ ...PRESET_WEATHER[WEATHER.Clear], layers: [] }).startsWith(
        "Sky clear",
      ),
      "an empty sky is described as clear",
    );

    assertClose(lerpAngleDegrees(350, 30, 0.5), 10, 1e-9, "bearings take the short way round");
    assertClose(lerpAngleDegrees(10, 350, 0.5), 0, 1e-9, "in both directions");

    const sorted = normalizeWindLayers([
      { altitudeAgl: 2000, directionDeg: 400, speed: 200 },
      { altitudeAgl: 10, directionDeg: -40, speed: -3 },
    ]);
    assert(
      (sorted[0] as { altitudeAgl: number }).altitudeAgl === 10,
      "wind levels come back lowest first",
    );
    assertClose(
      (sorted[0] as { directionDeg: number }).directionDeg,
      320,
      1e-9,
      "with the bearings wrapped into a compass",
    );
    assertClose(
      (sorted[0] as { speed: number }).speed,
      0,
      1e-9,
      "and nothing blowing backwards",
    );
    assert(normalizeWindLayers([]).length === 1, "an empty wind is still calm air");
  });

  suite("the layer viewer draws what the sky says", () => {
    const state: WeatherState = {
      ...PRESET_WEATHER[WEATHER.Cloudy],
      layers: [
        layer(CLOUD_AMOUNT.Broken, CLOUD_TYPE.Stratocumulus, -600, 400),
        layer(CLOUD_AMOUNT.Few, CLOUD_TYPE.Altostratus, 3200, 800),
      ],
      wind: {
        layers: normalizeWindLayers([
          { altitudeAgl: 10, directionDeg: 270, speed: 4 },
          { altitudeAgl: 2000, directionDeg: 300, speed: 12 },
        ]),
        gustiness: 0.2,
        variation: 0.1,
      },
    };

    const profile = buildSkyProfile(state);
    assert(profile.floor <= -600, "the axis reaches the deck below the launch point");
    assert(profile.ceiling >= 4000, "and the top of the highest one above it");
    assert(
      profile.floor < 0 && profile.ceiling > 0,
      "so the ground is somewhere on it",
    );
    assertBetween(profile.ground, 0, 1, "and lands on the page");

    const low = profile.clouds[0] as { top: number; bottom: number };
    const high = profile.clouds[1] as { top: number; bottom: number };
    assert(low.top < low.bottom, "a band's top is above its base on the page");
    assert(
      high.bottom < low.top,
      "and the higher deck is drawn above the lower one",
    );

    assert(profile.ticks.length >= 3, "the axis is labelled");
    assert(
      profile.ticks.every(
        (tick) =>
          Math.abs(tick.altitude % profile.step) < 1e-6 &&
          tick.altitude >= profile.floor - 1e-6 &&
          tick.altitude <= profile.ceiling + 1e-6,
      ),
      "with round numbers, all of them on the axis",
    );
    assert(
      profile.ticks.some((tick) => tick.altitude === 0),
      "and one of them is the ground, because the ends are snapped to the step",
    );

    assert(profile.winds.length === 2, "both wind levels are placed");
    assert(
      (profile.winds[0] as { y: number }).y >
        (profile.winds[1] as { y: number }).y,
      "the surface wind below the one aloft",
    );
    assertClose(
      (profile.winds[1] as { strength: number }).strength,
      1,
      1e-9,
      "and the fastest level sets the scale the arrows are weighted against",
    );

    // A clear, calm sky has nothing in it to set a scale, and an axis that
    // collapses onto the ground reads as broken rather than as empty.
    const empty = buildSkyProfile({
      ...state,
      layers: [],
      wind: {
        layers: normalizeWindLayers([
          { altitudeAgl: 10, directionDeg: 0, speed: 0 },
        ]),
        gustiness: 0,
        variation: 0,
      },
    });
    assert(empty.clouds.length === 0, "an empty sky has no bands");
    assert(empty.ceiling >= 400, "but the axis still has air in it");
    assertClose(
      (empty.winds[0] as { strength: number }).strength,
      0,
      1e-9,
      "and a calm level is drawn as calm rather than as the fastest there is",
    );

    assert(niceStep(1000) === 200, "a kilometre is stepped in two hundreds");
    assert(niceStep(30000) === 5000, "and thirty of them in five thousands");
  });
}
