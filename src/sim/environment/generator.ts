/**
 * Weather the simulator makes up for itself.
 *
 * Random weather that is genuinely random is not weather — it is a scattered
 * cirrus deck under a nimbostratus in fog, which happens on no planet. Real
 * skies come from a small number of situations, so this picks one of those
 * first and then fills in the detail inside it: a ridge of high pressure, a
 * warm sector, a front going through, an unstable afternoon, a cold snap, a
 * radiation-fog morning.
 *
 * Everything is drawn from the mission seed, so "random weather" is still the
 * same weather every time that mission is flown — which is what makes it worth
 * putting in a logbook.
 */

import { clamp } from "../math/scalar";
import type { Rng } from "../math/rng";
import { createRng } from "../math/rng";
import type { CloudLayer } from "./sky";
import {
  CLOUD_AMOUNT,
  CLOUD_TYPE,
  CLOUD_TYPE_INFO,
  normalizeLayers,
} from "./sky";
import type { CloudAmount } from "./sky";
import type { WeatherState, WindLayer } from "./weather";
import {
  NO_PRECIPITATION,
  PRECIPITATION,
  UNLIMITED_VISIBILITY,
  WEATHER_SOURCE,
  WIND_REFERENCE_HEIGHT,
  nearestPreset,
  normalizeWindLayers,
} from "./weather";

/** The situations a generated day can be in, and how often each comes up. */
const SITUATIONS = [
  "ridge",
  "warmSector",
  "frontal",
  "unstable",
  "storms",
  "cold",
  "fog",
] as const;

type Situation = (typeof SITUATIONS)[number];

/** Relative likelihood of each situation. Fine weather is the common case. */
const WEIGHTS: Readonly<Record<Situation, number>> = {
  ridge: 5,
  warmSector: 3,
  frontal: 3,
  unstable: 3,
  storms: 2,
  cold: 1.5,
  fog: 1,
};

function pickSituation(rng: Rng): Situation {
  let total = 0;
  for (const situation of SITUATIONS) total += WEIGHTS[situation];
  let roll = rng.next() * total;
  for (const situation of SITUATIONS) {
    roll -= WEIGHTS[situation];
    if (roll <= 0) return situation;
  }
  return "ridge";
}

export interface GenerateWeatherOptions {
  /**
   * Roughly how far from the equator the mission is, degrees. Only used to
   * bias the temperature, so a generated day in Iceland is not a generated day
   * in Andalusia.
   */
  readonly latitude?: number;
  /** Forced situation, for tests and for a "give me a storm" button. */
  readonly situation?: Situation;
}

/**
 * A plausible day, drawn from a seed.
 *
 * The result is a normal `WeatherState` in every respect: it can be edited,
 * written out as a METAR, and flown exactly like a preset or a real report.
 */
export function generateWeather(
  seed: string,
  options: GenerateWeatherOptions = {},
): WeatherState {
  const rng = createRng(`${seed}:weather`);
  const situation = options.situation ?? pickSituation(rng);
  const latitude = Math.abs(options.latitude ?? 47);

  // Warmer near the equator, colder near the poles, with a few degrees of
  // day-to-day scatter on top.
  const seasonal = 27 - latitude * 0.42 + rng.range(-6, 6);

  const built = buildSituation(situation, rng, seasonal);
  const layers = normalizeLayers(built.layers);
  const state = {
    layers,
    visibilityM: built.visibilityM,
    precipitation: built.precipitation,
    thunderstorm: built.thunderstorm,
  };

  return {
    source: WEATHER_SOURCE.Random,
    preset: nearestPreset(state),
    label: built.label,
    description: built.description,
    layers,
    visibilityM: built.visibilityM,
    precipitation: built.precipitation,
    thunderstorm: built.thunderstorm,
    wind: built.wind,
    temperatureC: built.temperatureC,
    dewPointC: built.dewPointC,
    pressureHpa: built.pressureHpa,
    station: null,
    metar: null,
  };
}

interface BuiltWeather {
  label: string;
  description: string;
  layers: CloudLayer[];
  visibilityM: number;
  precipitation: WeatherState["precipitation"];
  thunderstorm: boolean;
  wind: WeatherState["wind"];
  temperatureC: number;
  dewPointC: number;
  pressureHpa: number;
}

function buildSituation(
  situation: Situation,
  rng: Rng,
  seasonal: number,
): BuiltWeather {
  switch (situation) {
    case "ridge":
      return ridge(rng, seasonal);
    case "warmSector":
      return warmSector(rng, seasonal);
    case "frontal":
      return frontal(rng, seasonal);
    case "unstable":
      return unstable(rng, seasonal);
    case "storms":
      return storms(rng, seasonal);
    case "cold":
      return cold(rng, seasonal);
    case "fog":
      return fog(rng, seasonal);
  }
}

function ridge(rng: Rng, seasonal: number): BuiltWeather {
  const temperature = seasonal + rng.range(1, 5);
  const layers: CloudLayer[] = [];
  if (rng.next() < 0.7) {
    layers.push(layer(rng, CLOUD_TYPE.Cumulus, CLOUD_AMOUNT.Few, rng.range(1100, 2000)));
  }
  if (rng.next() < 0.35) {
    layers.push(layer(rng, CLOUD_TYPE.Cirrus, CLOUD_AMOUNT.Few, rng.range(7500, 10500)));
  }
  return {
    label: "High pressure",
    description: "A ridge sitting over the area. Light winds and a long view.",
    layers,
    visibilityM: rng.next() < 0.7 ? UNLIMITED_VISIBILITY : rng.range(8000, 13000),
    precipitation: NO_PRECIPITATION,
    thunderstorm: false,
    wind: wind(rng, rng.range(1, 4), 0.2, 0.25, 1.5),
    temperatureC: temperature,
    dewPointC: temperature - rng.range(8, 16),
    pressureHpa: rng.range(1020, 1033),
  };
}

function warmSector(rng: Rng, seasonal: number): BuiltWeather {
  const temperature = seasonal + rng.range(-1, 3);
  return {
    label: "Warm sector",
    description: "A low deck of stratocumulus filling in, and a damp, hazy view.",
    layers: [
      layer(rng, CLOUD_TYPE.Stratocumulus, rng.next() < 0.6 ? CLOUD_AMOUNT.Broken : CLOUD_AMOUNT.Overcast, rng.range(500, 1100)),
      ...(rng.next() < 0.5
        ? [layer(rng, CLOUD_TYPE.Altostratus, CLOUD_AMOUNT.Broken, rng.range(3000, 4500))]
        : []),
    ],
    visibilityM: rng.range(5000, 11000),
    precipitation:
      rng.next() < 0.4
        ? { kind: PRECIPITATION.Rain, intensity: rng.range(0.2, 0.4), showers: false }
        : NO_PRECIPITATION,
    thunderstorm: false,
    wind: wind(rng, rng.range(4, 9), 0.35, 0.35, 1.8),
    temperatureC: temperature,
    dewPointC: temperature - rng.range(1, 3),
    pressureHpa: rng.range(1005, 1015),
  };
}

function frontal(rng: Rng, seasonal: number): BuiltWeather {
  const temperature = seasonal - rng.range(1, 5);
  const heavy = rng.next() < 0.45;
  return {
    label: "Front going through",
    description: "An overcast rain deck with the wind up and the visibility down.",
    layers: [
      layer(rng, CLOUD_TYPE.Nimbostratus, CLOUD_AMOUNT.Overcast, rng.range(300, 700), rng.range(1800, 3200)),
      ...(rng.next() < 0.4
        ? [layer(rng, CLOUD_TYPE.Cirrus, CLOUD_AMOUNT.Broken, rng.range(7000, 9500))]
        : []),
    ],
    visibilityM: rng.range(1800, 5000),
    precipitation: {
      kind: temperature <= 1 ? PRECIPITATION.Snow : PRECIPITATION.Rain,
      intensity: heavy ? rng.range(0.7, 0.95) : rng.range(0.4, 0.7),
      showers: false,
    },
    thunderstorm: false,
    wind: wind(rng, rng.range(8, 14), 0.65, 0.5, 2),
    temperatureC: temperature,
    dewPointC: temperature - rng.range(0, 2),
    pressureHpa: rng.range(985, 1002),
  };
}

function unstable(rng: Rng, seasonal: number): BuiltWeather {
  const temperature = seasonal + rng.range(-1, 3);
  const towering = rng.next() < 0.5;
  return {
    label: "Unstable airmass",
    description: "Cumulus going up all afternoon, showers under the bigger ones.",
    layers: [
      layer(
        rng,
        towering ? CLOUD_TYPE.Towering : CLOUD_TYPE.Cumulus,
        rng.next() < 0.5 ? CLOUD_AMOUNT.Scattered : CLOUD_AMOUNT.Broken,
        rng.range(900, 1700),
      ),
      ...(rng.next() < 0.4
        ? [layer(rng, CLOUD_TYPE.Cirrus, CLOUD_AMOUNT.Few, rng.range(7000, 10000))]
        : []),
    ],
    visibilityM: rng.range(9000, UNLIMITED_VISIBILITY),
    precipitation: towering
      ? { kind: PRECIPITATION.Rain, intensity: rng.range(0.3, 0.6), showers: true }
      : NO_PRECIPITATION,
    thunderstorm: false,
    wind: wind(rng, rng.range(3, 8), 0.6, 0.55, 1.9),
    temperatureC: temperature,
    dewPointC: temperature - rng.range(4, 9),
    pressureHpa: rng.range(1008, 1018),
  };
}

function storms(rng: Rng, seasonal: number): BuiltWeather {
  const temperature = seasonal + rng.range(0, 5);
  return {
    label: "Thunderstorms",
    description: "Cells building over the area. Heavy showers and lightning.",
    layers: [
      layer(rng, CLOUD_TYPE.Stratocumulus, CLOUD_AMOUNT.Broken, rng.range(600, 1000), rng.range(400, 700)),
      layer(
        rng,
        CLOUD_TYPE.Cumulonimbus,
        rng.next() < 0.5 ? CLOUD_AMOUNT.Scattered : CLOUD_AMOUNT.Broken,
        rng.range(800, 1400),
        rng.range(6000, 9500),
      ),
    ],
    visibilityM: rng.range(3000, 7000),
    precipitation: {
      kind: PRECIPITATION.Rain,
      intensity: rng.range(0.65, 1),
      showers: true,
    },
    thunderstorm: true,
    wind: wind(rng, rng.range(5, 12), 0.9, 0.75, 2.4),
    temperatureC: temperature,
    dewPointC: temperature - rng.range(1, 4),
    pressureHpa: rng.range(1000, 1010),
  };
}

function cold(rng: Rng, seasonal: number): BuiltWeather {
  const temperature = Math.min(seasonal - rng.range(10, 20), -0.5);
  const snowing = rng.next() < 0.7;
  return {
    label: "Cold and grey",
    description: snowing
      ? "A cold overcast with snow coming out of it and flat, shadowless light."
      : "A cold, dry overcast with the light gone flat.",
    layers: [
      layer(
        rng,
        snowing ? CLOUD_TYPE.Nimbostratus : CLOUD_TYPE.Stratocumulus,
        CLOUD_AMOUNT.Overcast,
        rng.range(350, 900),
      ),
    ],
    visibilityM: snowing ? rng.range(1200, 3500) : rng.range(6000, 12000),
    precipitation: snowing
      ? { kind: PRECIPITATION.Snow, intensity: rng.range(0.4, 0.85), showers: false }
      : NO_PRECIPITATION,
    thunderstorm: false,
    wind: wind(rng, rng.range(3, 9), 0.4, 0.35, 1.9),
    temperatureC: temperature,
    dewPointC: temperature - rng.range(0.5, 3),
    pressureHpa: rng.range(1002, 1020),
  };
}

function fog(rng: Rng, seasonal: number): BuiltWeather {
  const temperature = seasonal - rng.range(6, 12);
  return {
    label: "Radiation fog",
    description: "Fog in the valley under a clear sky. It will burn off. Later.",
    layers: [
      layer(rng, CLOUD_TYPE.Stratus, CLOUD_AMOUNT.Scattered, rng.range(30, 120), rng.range(250, 600)),
    ],
    visibilityM: rng.range(250, 1400),
    precipitation: NO_PRECIPITATION,
    thunderstorm: false,
    wind: wind(rng, rng.range(0, 2.5), 0.1, 0.1, 2.2),
    temperatureC: temperature,
    dewPointC: temperature,
    pressureHpa: rng.range(1018, 1032),
  };
}

function layer(
  rng: Rng,
  type: CloudLayer["type"],
  amount: CloudAmount,
  baseAgl: number,
  depth?: number,
): CloudLayer {
  const info = CLOUD_TYPE_INFO[type];
  return {
    amount,
    type,
    baseAgl,
    depth: depth ?? info.defaultDepth * rng.range(0.7, 1.3),
  };
}

/**
 * A wind profile with shear in it.
 *
 * The surface wind is what is quoted; above it the air is faster and veered to
 * the right, which is the sense the northern-hemisphere boundary layer actually
 * turns as friction lets go.
 */
function wind(
  rng: Rng,
  surfaceSpeed: number,
  gustiness: number,
  variation: number,
  shear: number,
): WeatherState["wind"] {
  const direction = rng.range(0, 360);
  const layers: WindLayer[] = [
    {
      altitudeAgl: WIND_REFERENCE_HEIGHT,
      directionDeg: direction,
      speed: surfaceSpeed,
    },
    {
      altitudeAgl: rng.range(900, 1500),
      directionDeg: (direction + rng.range(10, 40)) % 360,
      speed: surfaceSpeed * shear + rng.range(0.5, 3),
    },
    {
      altitudeAgl: rng.range(3000, 5000),
      directionDeg: (direction + rng.range(25, 70)) % 360,
      speed: surfaceSpeed * shear * 1.35 + rng.range(3, 9),
    },
  ];
  return {
    layers: normalizeWindLayers(layers),
    gustiness: clamp(gustiness + rng.range(-0.08, 0.08), 0, 1),
    variation: clamp(variation + rng.range(-0.08, 0.08), 0, 1),
  };
}
