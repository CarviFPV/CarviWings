/**
 * The weather, as a single piece of data.
 *
 * A `WeatherState` is everything an observer would write down: the cloud decks
 * and what genus they are, how far you can see, what is falling out of the sky,
 * whether it is thundering, and what the wind is doing at each height. It is
 * the one thing the pilot edits, whether they picked a preset, typed a METAR,
 * pulled the real weather off the nearest aerodrome, or asked for a random day.
 *
 * `WeatherProfile` is the other half: the same weather already worked out into
 * the numbers the scene and the simulation want — a fog density, an exposure,
 * a sight range, a set of decks in metres. Nothing downstream reads a state
 * directly; everything reads a resolved profile, so there is exactly one place
 * where "9 km visibility in light rain" turns into a fog density.
 *
 * The four historic presets are now written in the same vocabulary as
 * everything else and resolved through the same function, so a preset is not a
 * special case — it is a `WeatherState` someone already filled in.
 */

import { clamp, lerp } from "../math/scalar";
import type { CloudAmount, CloudLayer, CloudType } from "./sky";
import {
  CLOUD_AMOUNT,
  CLOUD_TYPE,
  CLOUD_TYPE_INFO,
  ceilingAgl,
  hasThunderCloud,
  highestCloudTop,
  precipitationIntensity,
  layerCoverage,
  layerTop,
  normalizeLayers,
  primaryLayer,
  skyCoverage,
} from "./sky";

export const WEATHER = {
  Clear: "CLEAR",
  Cloudy: "CLOUDY",
  Rain: "RAIN",
  Storm: "STORM",
  Snow: "SNOW",
  Fog: "FOG",
} as const;

export type Weather = (typeof WEATHER)[keyof typeof WEATHER];

/** Where the weather being flown in came from. */
export const WEATHER_SOURCE = {
  /** One of the built-in presets, optionally with the cover slider moved. */
  Preset: "PRESET",
  /** Layers, visibility and wind the pilot built by hand. */
  Custom: "CUSTOM",
  /** Decoded from a report the pilot typed in. */
  Metar: "METAR",
  /** Decoded from the nearest real aerodrome report. */
  Live: "LIVE",
  /** Generated from the mission seed. */
  Random: "RANDOM",
} as const;

export type WeatherSource = (typeof WEATHER_SOURCE)[keyof typeof WEATHER_SOURCE];

/**
 * The ways the pilot can say what the weather is, in the order they are offered.
 *
 * `Preset` is deliberately not one of them. The presets are still the
 * vocabulary the whole model is written in, and every sky is still filed under
 * the one it most resembles — but a day is described by building it, reading a
 * report or drawing one, not by picking a word out of a list of six.
 */
export const WEATHER_SOURCE_CHOICES = [
  WEATHER_SOURCE.Live,
  WEATHER_SOURCE.Metar,
  WEATHER_SOURCE.Custom,
  WEATHER_SOURCE.Random,
] as const;

export type WeatherSourceChoice = (typeof WEATHER_SOURCE_CHOICES)[number];

/** Whether a source is one the pilot can pick, rather than only end up with. */
export function isWeatherSourceChoice(
  value: unknown,
): value is WeatherSourceChoice {
  return (WEATHER_SOURCE_CHOICES as readonly string[]).includes(value as string);
}

export const PRECIPITATION = {
  None: "NONE",
  Rain: "RAIN",
  Snow: "SNOW",
} as const;

export type PrecipitationKind =
  (typeof PRECIPITATION)[keyof typeof PRECIPITATION];

export interface PrecipitationState {
  readonly kind: PrecipitationKind;
  /** 0..1. Zero with a kind set means it has stopped. */
  readonly intensity: number;
  /** True for showers — heavier, briefer, and out of convective cloud. */
  readonly showers: boolean;
}

export const NO_PRECIPITATION: PrecipitationState = {
  kind: PRECIPITATION.None,
  intensity: 0,
  showers: false,
};

/** The wind at one height. */
export interface WindLayer {
  /** Height above the mission origin's ground, metres. */
  readonly altitudeAgl: number;
  /** Direction the wind blows *from*, compass degrees. */
  readonly directionDeg: number;
  /** Mean speed, m/s. */
  readonly speed: number;
}

/**
 * The wind through the whole depth of the flight.
 *
 * At least one layer, quoted at the surface reference height; more of them
 * describe shear, which is the thing that makes flying a ridge in a real
 * airmass different from flying it in a uniform one.
 */
export interface WindSpec {
  readonly layers: readonly WindLayer[];
  /** 0..1 how hard it gusts — variation in *speed*. */
  readonly gustiness: number;
  /** 0..1 how much it wanders — variation in *direction*. */
  readonly variation: number;
}

/** The surface reference height a wind is quoted at, metres. */
export const WIND_REFERENCE_HEIGHT = 10;

/** How many wind layers a sky may carry. */
export const MAX_WIND_LAYERS = 4;

/** The wind quoted at the surface, which is the one a report leads with. */
export function surfaceWind(spec: WindSpec): WindLayer {
  return (
    spec.layers[0] ?? {
      altitudeAgl: WIND_REFERENCE_HEIGHT,
      directionDeg: 270,
      speed: 0,
    }
  );
}

/** Wind layers sorted low to high, clamped, and no more than the limit. */
export function normalizeWindLayers(
  layers: readonly WindLayer[],
): readonly WindLayer[] {
  const cleaned = layers
    .map((layer) => ({
      altitudeAgl: clamp(layer.altitudeAgl, 0, 15000),
      directionDeg: ((layer.directionDeg % 360) + 360) % 360,
      speed: clamp(layer.speed, 0, 80),
    }))
    .sort((a, b) => a.altitudeAgl - b.altitudeAgl)
    .slice(0, MAX_WIND_LAYERS);
  return cleaned.length > 0
    ? cleaned
    : [{ altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: 270, speed: 0 }];
}

export interface WeatherState {
  readonly source: WeatherSource;
  /** The preset this is, or the one it most resembles. Drives the logbook. */
  readonly preset: Weather;
  readonly label: string;
  readonly description: string;
  readonly layers: readonly CloudLayer[];
  /** Horizontal visibility at the surface, metres. */
  readonly visibilityM: number;
  readonly precipitation: PrecipitationState;
  /** True when thunder is reported, whether or not a CB was named. */
  readonly thunderstorm: boolean;
  readonly wind: WindSpec;
  readonly temperatureC: number;
  readonly dewPointC: number;
  readonly pressureHpa: number;
  /** The station the report came from, when it came from one. */
  readonly station: string | null;
  /** The raw report, when there was one. */
  readonly metar: string | null;
}

/** A cloud deck worked out into the metres and fractions a renderer wants. */
export interface ResolvedCloudLayer {
  readonly type: CloudType;
  /** Bounds above the mission origin's ground, metres. */
  readonly baseAgl: number;
  readonly topAgl: number;
  /** How much of the sky this deck fills, 0..1. */
  readonly coverage: number;
  /** How solid the cloud is, 0..1. */
  readonly density: number;
  /** How much it towers rather than spreads, 0..1. */
  readonly convection: number;
}

export interface WeatherProfile {
  readonly id: Weather;
  readonly label: string;
  readonly description: string;

  // --- Gameplay -------------------------------------------------------------
  /** Range at which a contact becomes effectively invisible, metres. */
  readonly sightRange: number;
  /** Reported horizontal visibility, metres. */
  readonly visibilityM: number;

  // --- Atmosphere -----------------------------------------------------------
  /** How fast the air takes the contrast out of what is behind it, per metre. */
  readonly fogExtinction: number;
  /** The same inside a deck, where the cloud sets the thickness of the air. */
  readonly inCloudExtinction: number;
  /** Scene exposure multiplier, 1 = full sun. */
  readonly brightness: number;
  /** Colour saturation multiplier. */
  readonly saturation: number;

  // --- Clouds ---------------------------------------------------------------
  /** Every deck, lowest first. Empty for a clear sky. */
  readonly layers: readonly ResolvedCloudLayer[];
  /** 0..1 total sky coverage. */
  readonly cloudCoverage: number;
  /** Base of the deck that matters most, above the origin terrain, metres. */
  readonly cloudBaseAgl: number;
  /** Depth of that same deck, metres. */
  readonly cloudDepth: number;
  /** Top of the highest cloud there is; nothing falls from above it. */
  readonly cloudTopAgl: number;
  /** Base of the lowest broken-or-worse deck; infinite when there is none. */
  readonly ceilingAgl: number;

  // --- Precipitation --------------------------------------------------------
  readonly precipitation: PrecipitationState;
  /** 0..1 liquid precipitation; drives the rain post-process. */
  readonly rain: number;
  /** 0..1 frozen precipitation; the same pass, drawn as flakes. */
  readonly snow: number;

  // --- Thunderstorms --------------------------------------------------------
  readonly thunderstorm: boolean;

  // --- Wind -----------------------------------------------------------------
  readonly wind: WindSpec;
  /** Mean wind speed at the reference height, m/s. */
  readonly windSpeed: number;
  /** 0..1 how much the wind gusts. */
  readonly gustiness: number;
  /** 0..1 how much the wind wanders in direction. */
  readonly variation: number;
}

/** Visibility at or above this is "ten kilometres or more" — a CAVOK day. */
export const UNLIMITED_VISIBILITY = 15000;

/**
 * How far a contact can be held, from how far the ground observer can see.
 *
 * Reported visibility is measured against dark objects on the ground in the
 * worst direction; an aircraft against sky, from an aircraft, is picked up
 * appreciably further out than that, which is what the factor is for.
 */
function sightRangeFor(visibilityM: number): number {
  return clamp(visibilityM * 1.35, 250, 26000);
}

/**
 * How much contrast the air has taken by the time it is at the visibility.
 *
 * Meteorological visibility is the distance at which a dark object against the
 * horizon is down to a few per cent of its contrast — Koschmieder's relation,
 * with 3.9 for the 2% a trained observer is asked for. A simulator wants the
 * ridge *gone* at that distance rather than technically still resolvable, so
 * the slightly softer 3 is used: 95% of the contrast, and no ridge.
 */
const CONTRAST_AT_VISIBILITY = 3;

/**
 * How thick the air is, from how far you can see through it.
 *
 * The reciprocal of the visibility, and nothing else: extinction is what a
 * visibility *is*. It used to be a fitted power curve producing a Cesium fog
 * density directly, which meant nobody could say what the number meant and a
 * sky that said one kilometre was flown with the far side of the valley still
 * in view. The renderer now inverts its own fog curve against this, so the
 * distance the weather names is the distance the world ends at.
 */
export function fogExtinctionFor(visibilityM: number): number {
  return CONTRAST_AT_VISIBILITY / Math.max(visibilityM, 1);
}

/** The visibility an extinction implies. The inverse of `fogExtinctionFor`. */
export function visibilityForExtinction(extinction: number): number {
  return CONTRAST_AT_VISIBILITY / Math.max(extinction, 1e-9);
}

/** How far you can see inside the thinnest cloud there is, and the thickest. */
const IN_CLOUD_VISIBILITY = { thin: 140, solid: 25 } as const;

/** How much of the light is a whiteout rather than merely a grey day, 0..1. */
export function fogginess(visibilityM: number): number {
  return clamp(1 - visibilityM / 2000, 0, 1);
}

/**
 * The weather worked out into scene and gameplay numbers.
 *
 * Everything here is derived — there are no per-preset magic values left — so a
 * sky assembled by hand, decoded from a report or generated from a seed is lit,
 * fogged and flown exactly like a preset with the same numbers in it.
 */
export function resolveWeatherProfile(state: WeatherState): WeatherProfile {
  const layers = normalizeLayers(state.layers);
  const coverage = skyCoverage(layers);
  const primary = primaryLayer(layers);
  const precipitation = resolvePrecipitation(state, layers);
  const wet = precipitation.intensity;
  const visibility = clamp(state.visibilityM, 50, 60000);
  const murk = fogginess(visibility);
  const shapedCover = Math.pow(coverage, 1.2);

  const fogExtinction = fogExtinctionFor(visibility);
  // Inside cloud the air reaches a thickness of its own, set by how solid the
  // cloud is rather than by how clear the day outside it was — which is why
  // this is a visibility in its own right and not a multiple of the other one.
  const densest = layers.reduce(
    (most, layer) =>
      Math.max(most, layerCoverage(layer) * CLOUD_TYPE_INFO[layer.type].density),
    0,
  );
  const inCloudExtinction = Math.max(
    fogExtinction,
    fogExtinctionFor(
      lerp(IN_CLOUD_VISIBILITY.thin, IN_CLOUD_VISIBILITY.solid, densest),
    ),
  );

  const wind = state.wind;
  const surface = surfaceWind(wind);

  return {
    id: state.preset,
    label: state.label,
    description: state.description,

    sightRange: sightRangeFor(visibility),
    visibilityM: visibility,

    fogExtinction,
    inCloudExtinction,
    brightness: clamp(
      1 - 0.28 * shapedCover - 0.16 * wet - 0.45 * murk,
      0.28,
      1,
    ),
    saturation: clamp(1 - 0.2 * shapedCover - 0.25 * wet - murk, 0.22, 1),

    layers: layers.map(resolveLayer),
    cloudCoverage: coverage,
    cloudBaseAgl: primary ? primary.baseAgl : Number.POSITIVE_INFINITY,
    cloudDepth: primary ? primary.depth : 0,
    cloudTopAgl: highestCloudTop(layers),
    ceilingAgl: ceilingAgl(layers),

    precipitation,
    rain: precipitation.kind === PRECIPITATION.Rain ? precipitation.intensity : 0,
    snow: precipitation.kind === PRECIPITATION.Snow ? precipitation.intensity : 0,

    thunderstorm: state.thunderstorm || hasThunderCloud(layers),

    wind,
    windSpeed: surface.speed,
    gustiness: clamp(wind.gustiness, 0, 1),
    variation: clamp(wind.variation, 0, 1),
  };
}

function resolveLayer(layer: CloudLayer): ResolvedCloudLayer {
  const info = CLOUD_TYPE_INFO[layer.type];
  return {
    type: layer.type,
    baseAgl: layer.baseAgl,
    topAgl: layerTop(layer),
    coverage: layerCoverage(layer),
    density: info.density,
    convection: info.convection,
  };
}

/**
 * What is actually falling, and how hard.
 *
 * A report that names the precipitation is believed outright. Otherwise the
 * cloud decides: a deck of nimbostratus rains and a field of fair-weather
 * cumulus does not, and whether it comes down as rain or snow is a question
 * about the temperature rather than about the cloud.
 */
function resolvePrecipitation(
  state: WeatherState,
  layers: readonly CloudLayer[],
): PrecipitationState {
  if (state.precipitation.kind !== PRECIPITATION.None) {
    return {
      ...state.precipitation,
      intensity: clamp(state.precipitation.intensity, 0, 1),
    };
  }
  const intensity = precipitationIntensity(layers);
  if (intensity <= 0.01) return NO_PRECIPITATION;
  return {
    kind: state.temperatureC <= 1 ? PRECIPITATION.Snow : PRECIPITATION.Rain,
    intensity,
    showers: layers.some(
      (layer) =>
        CLOUD_TYPE_INFO[layer.type].showery &&
        CLOUD_TYPE_INFO[layer.type].precipitation > 0,
    ),
  };
}

/**
 * The same weather with a different amount of cloud in it.
 *
 * Cloud cover is the one part of a preset the pilot moves with a single
 * control: the preset decides how high the decks sit and how thick the air is,
 * and this decides how much of the sky they fill. Every deck is scaled by the
 * same ratio, so a two-deck sky thins out as one sky rather than losing its
 * lower layer first. At zero there is no cloud at all and nothing is drawn,
 * marched or seen through.
 */
export function withCloudCover(
  profile: WeatherProfile,
  coverage: number,
): WeatherProfile {
  const wanted = clamp(coverage, 0, 1);
  if (Math.abs(wanted - profile.cloudCoverage) < 1e-6) return profile;
  if (profile.cloudCoverage <= 1e-6) return profile;

  const ratio = wanted / profile.cloudCoverage;
  const layers =
    wanted <= 1e-6
      ? []
      : profile.layers.map((layer) => ({
          ...layer,
          coverage: clamp(layer.coverage * ratio, 0, 1),
        }));

  return {
    ...profile,
    layers,
    cloudCoverage: wanted,
    // Thinning the sky thins what falls out of it, and empties it entirely at
    // zero: rain from a cloud that is not drawn reads as a bug.
    precipitation: {
      ...profile.precipitation,
      intensity: profile.precipitation.intensity * ratio,
    },
    rain: profile.rain * ratio,
    snow: profile.snow * ratio,
    thunderstorm: profile.thunderstorm && wanted > 0.05,
    cloudTopAgl: wanted <= 1e-6 ? 0 : profile.cloudTopAgl,
  };
}

// --- The presets -----------------------------------------------------------

function preset(
  id: Weather,
  label: string,
  description: string,
  parts: {
    layers: readonly CloudLayer[];
    visibilityM: number;
    precipitation?: PrecipitationState;
    thunderstorm?: boolean;
    wind: WindSpec;
    temperatureC: number;
    dewPointC: number;
    pressureHpa?: number;
  },
): WeatherState {
  return {
    source: WEATHER_SOURCE.Preset,
    preset: id,
    label,
    description,
    layers: normalizeLayers(parts.layers),
    visibilityM: parts.visibilityM,
    precipitation: parts.precipitation ?? NO_PRECIPITATION,
    thunderstorm: parts.thunderstorm ?? false,
    wind: {
      layers: normalizeWindLayers(parts.wind.layers),
      gustiness: parts.wind.gustiness,
      variation: parts.wind.variation,
    },
    temperatureC: parts.temperatureC,
    dewPointC: parts.dewPointC,
    pressureHpa: parts.pressureHpa ?? 1013,
    station: null,
    metar: null,
  };
}

export const PRESET_WEATHER: Readonly<Record<Weather, WeatherState>> = {
  [WEATHER.Clear]: preset(
    WEATHER.Clear,
    "Clear",
    "Open sky, long sight lines, light breeze.",
    {
      layers: [
        {
          amount: CLOUD_AMOUNT.Few,
          type: CLOUD_TYPE.Cumulus,
          baseAgl: 1400,
          depth: 500,
        },
      ],
      visibilityM: UNLIMITED_VISIBILITY,
      wind: {
        layers: [
          { altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: 270, speed: 3 },
          { altitudeAgl: 1500, directionDeg: 285, speed: 6 },
        ],
        gustiness: 0.25,
        variation: 0.25,
      },
      temperatureC: 22,
      dewPointC: 8,
      pressureHpa: 1021,
    },
  ),
  [WEATHER.Cloudy]: preset(
    WEATHER.Cloudy,
    "Cloudy",
    "Broken cumulus to hide in. Still good visibility below.",
    {
      layers: [
        {
          amount: CLOUD_AMOUNT.Broken,
          type: CLOUD_TYPE.Stratocumulus,
          baseAgl: 750,
          depth: 700,
        },
        {
          amount: CLOUD_AMOUNT.Few,
          type: CLOUD_TYPE.Cirrus,
          baseAgl: 8500,
          depth: 900,
        },
      ],
      visibilityM: 11000,
      wind: {
        layers: [
          { altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: 240, speed: 6 },
          { altitudeAgl: 1200, directionDeg: 260, speed: 12 },
        ],
        gustiness: 0.45,
        variation: 0.4,
      },
      temperatureC: 14,
      dewPointC: 9,
      pressureHpa: 1014,
    },
  ),
  [WEATHER.Rain]: preset(
    WEATHER.Rain,
    "Rain",
    "Heavy overcast, wet air, gusts. Contacts are hard to hold.",
    {
      layers: [
        {
          amount: CLOUD_AMOUNT.Overcast,
          type: CLOUD_TYPE.Nimbostratus,
          baseAgl: 420,
          depth: 2400,
        },
      ],
      visibilityM: 3300,
      precipitation: {
        kind: PRECIPITATION.Rain,
        intensity: 0.85,
        showers: false,
      },
      wind: {
        layers: [
          { altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: 200, speed: 9 },
          { altitudeAgl: 1000, directionDeg: 215, speed: 16 },
        ],
        gustiness: 0.7,
        variation: 0.5,
      },
      temperatureC: 9,
      dewPointC: 8,
      pressureHpa: 1002,
    },
  ),
  [WEATHER.Storm]: preset(
    WEATHER.Storm,
    "Thunderstorm",
    "A cell overhead: violent air, heavy showers and lightning in the cloud.",
    {
      layers: [
        {
          amount: CLOUD_AMOUNT.Scattered,
          type: CLOUD_TYPE.Cumulonimbus,
          baseAgl: 900,
          depth: 8000,
        },
        {
          amount: CLOUD_AMOUNT.Broken,
          type: CLOUD_TYPE.Stratocumulus,
          baseAgl: 700,
          depth: 500,
        },
      ],
      visibilityM: 4500,
      precipitation: {
        kind: PRECIPITATION.Rain,
        intensity: 0.8,
        showers: true,
      },
      thunderstorm: true,
      wind: {
        layers: [
          { altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: 190, speed: 8 },
          { altitudeAgl: 900, directionDeg: 220, speed: 18 },
          { altitudeAgl: 3000, directionDeg: 250, speed: 26 },
        ],
        gustiness: 0.9,
        variation: 0.75,
      },
      temperatureC: 19,
      dewPointC: 17,
      pressureHpa: 1005,
    },
  ),
  [WEATHER.Snow]: preset(
    WEATHER.Snow,
    "Snow",
    "A cold overcast filling in. Flat light and no horizon to speak of.",
    {
      layers: [
        {
          amount: CLOUD_AMOUNT.Overcast,
          type: CLOUD_TYPE.Nimbostratus,
          baseAgl: 500,
          depth: 1800,
        },
      ],
      visibilityM: 2200,
      precipitation: {
        kind: PRECIPITATION.Snow,
        intensity: 0.7,
        showers: false,
      },
      wind: {
        layers: [
          { altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: 20, speed: 5 },
          { altitudeAgl: 1200, directionDeg: 30, speed: 11 },
        ],
        gustiness: 0.4,
        variation: 0.35,
      },
      temperatureC: -3,
      dewPointC: -4,
      pressureHpa: 1008,
    },
  ),
  [WEATHER.Fog]: preset(
    WEATHER.Fog,
    "Fog",
    "You will not see the ridge until you are in it.",
    {
      layers: [
        {
          amount: CLOUD_AMOUNT.Scattered,
          type: CLOUD_TYPE.Stratus,
          baseAgl: 60,
          depth: 440,
        },
      ],
      visibilityM: 960,
      wind: {
        layers: [
          { altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: 320, speed: 2 },
          { altitudeAgl: 800, directionDeg: 320, speed: 5 },
        ],
        gustiness: 0.15,
        variation: 0.12,
      },
      temperatureC: 6,
      dewPointC: 6,
      pressureHpa: 1024,
    },
  ),
} as const;

export const WEATHER_PROFILES: Readonly<Record<Weather, WeatherProfile>> = {
  [WEATHER.Clear]: resolveWeatherProfile(PRESET_WEATHER[WEATHER.Clear]),
  [WEATHER.Cloudy]: resolveWeatherProfile(PRESET_WEATHER[WEATHER.Cloudy]),
  [WEATHER.Rain]: resolveWeatherProfile(PRESET_WEATHER[WEATHER.Rain]),
  [WEATHER.Storm]: resolveWeatherProfile(PRESET_WEATHER[WEATHER.Storm]),
  [WEATHER.Snow]: resolveWeatherProfile(PRESET_WEATHER[WEATHER.Snow]),
  [WEATHER.Fog]: resolveWeatherProfile(PRESET_WEATHER[WEATHER.Fog]),
} as const;

/**
 * The preset a hand-built or decoded sky most resembles.
 *
 * Nothing in the flight reads this — it exists so the logbook, the debrief and
 * the mission summary can still say what kind of day it was in one word.
 */
export function nearestPreset(state: {
  readonly layers: readonly CloudLayer[];
  readonly visibilityM: number;
  readonly precipitation: PrecipitationState;
  readonly thunderstorm: boolean;
}): Weather {
  if (state.thunderstorm || hasThunderCloud(state.layers)) return WEATHER.Storm;
  if (state.visibilityM < 1500) return WEATHER.Fog;
  if (state.precipitation.kind === PRECIPITATION.Snow) return WEATHER.Snow;
  if (state.precipitation.kind === PRECIPITATION.Rain) return WEATHER.Rain;
  return skyCoverage(state.layers) > 0.5 ? WEATHER.Cloudy : WEATHER.Clear;
}

/** A state built from a preset, ready to be edited into something else. */
export function weatherStateFromPreset(weather: Weather): WeatherState {
  return PRESET_WEATHER[weather];
}

/**
 * A preset with the cover slider moved, as a state rather than a profile.
 *
 * The slider is a single number over a sky that may have several decks, so it
 * moves every deck's *amount* to the nearest band that adds up to what was
 * asked for, and empties the sky entirely at zero.
 */
export function withSkyCoverage(
  state: WeatherState,
  coverage: number,
): WeatherState {
  const wanted = clamp(coverage, 0, 1);
  const current = skyCoverage(state.layers);
  if (Math.abs(wanted - current) < 1e-6) return state;
  if (wanted <= 1e-6) return { ...state, layers: [] };
  if (current <= 1e-6) return state;

  const ratio = wanted / current;
  return {
    ...state,
    layers: state.layers.map((layer) => ({
      ...layer,
      amount: amountForCoverage(layerCoverage(layer) * ratio),
    })),
  };
}

/** The reported band a continuous coverage falls in. */
export function amountForCoverage(coverage: number): CloudAmount {
  if (coverage >= 0.88) return CLOUD_AMOUNT.Overcast;
  if (coverage >= 0.56) return CLOUD_AMOUNT.Broken;
  if (coverage >= 0.3) return CLOUD_AMOUNT.Scattered;
  return CLOUD_AMOUNT.Few;
}

/** A one-line summary of a sky, for the setup screen and the OSD. */
export function describeWeather(state: WeatherState): string {
  const parts: string[] = [];
  const coverage = skyCoverage(state.layers);
  if (state.layers.length === 0) parts.push("Sky clear");
  else parts.push(`${Math.round(coverage * 100)}% cloud`);

  parts.push(
    state.visibilityM >= UNLIMITED_VISIBILITY
      ? "10 km+ visibility"
      : `${(state.visibilityM / 1000).toFixed(1)} km visibility`,
  );

  if (state.thunderstorm) parts.push("thunderstorms");
  else if (state.precipitation.kind === PRECIPITATION.Rain) parts.push("rain");
  else if (state.precipitation.kind === PRECIPITATION.Snow) parts.push("snow");

  const surface = surfaceWind(state.wind);
  parts.push(
    surface.speed < 0.5
      ? "calm"
      : `wind ${String(Math.round(surface.directionDeg)).padStart(3, "0")}° at ${Math.round(
          surface.speed * 3.6,
        )} km/h`,
  );
  return `${parts.join(", ")}.`;
}

/**
 * Interpolates a compass bearing the short way round.
 *
 * Shared by the layered wind field and the editor, both of which have to walk
 * between two directions without going the long way past north.
 */
export function lerpAngleDegrees(a: number, b: number, t: number): number {
  const delta = (((b - a) % 360) + 540) % 360 - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}
