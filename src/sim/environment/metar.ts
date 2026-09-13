/**
 * METAR.
 *
 * The aerodrome report is the format every pilot already reads and every
 * weather service already publishes, so it is the one this simulator takes
 * weather in and gives weather out in. Three things go through here:
 *
 *   - the report the pilot types into the setup screen by hand,
 *   - the report fetched from the nearest real aerodrome,
 *   - and the report written *back* out of whatever sky is being flown, so a
 *     hand-built or generated day can be read, copied and shared like any
 *     other.
 *
 * The parser is deliberately forgiving. A real report carries runway state,
 * trend groups, recent weather and free-text remarks that mean nothing to a
 * flight simulator, and an unrecognised group is skipped rather than treated as
 * an error: what matters is that the wind, the visibility, the cloud, the
 * weather and the temperature come out right.
 *
 * Heights are reported above the *aerodrome*, and the aerodrome is almost
 * never where the flight starts. The simulation's local frame measures from
 * the ground under the mission origin, so converting a cloud base is feet to
 * metres and then the step between the two grounds — `stationElevationOffset`.
 * A report from a field in the valley, flown from the ridge above it, puts its
 * deck *below* the launch point, and that is allowed: bases are signed.
 */

import { clamp } from "../math/scalar";
import type { CloudLayer, CloudType } from "./sky";
import {
  CLOUD_AMOUNT,
  CLOUD_TYPE,
  CLOUD_TYPE_INFO,
  MAX_CLOUD_BASE,
  MAX_CLOUD_LAYERS,
  MIN_CLOUD_BASE,
  formatLayer,
  normalizeLayers,
} from "./sky";
import type { CloudAmount } from "./sky";
import type { PrecipitationState, WeatherState, WindLayer } from "./weather";
import {
  NO_PRECIPITATION,
  PRECIPITATION,
  UNLIMITED_VISIBILITY,
  WEATHER_SOURCE,
  WIND_REFERENCE_HEIGHT,
  nearestPreset,
  normalizeWindLayers,
  surfaceWind,
} from "./weather";

const FEET_TO_METRES = 0.3048;
const KNOTS_TO_MS = 0.514444;

export interface MetarWind {
  /** Direction it blows from, compass degrees; null when reported variable. */
  readonly directionDeg: number | null;
  /** Mean speed, m/s. */
  readonly speed: number;
  /** Gust speed, m/s; null when none was reported. */
  readonly gust: number | null;
  /** The reported variation range, when one was given. */
  readonly variableFromDeg: number | null;
  readonly variableToDeg: number | null;
}

export interface MetarCloud {
  readonly amount: CloudAmount;
  /** Base above the aerodrome, feet. */
  readonly heightFt: number;
  /** `CB` or `TCU` when the report named one. */
  readonly type: CloudType | null;
}

export interface MetarPhenomenon {
  /** -1 light, 0 moderate, 1 heavy. */
  readonly intensity: number;
  /** `SH`, `TS`, `FZ`, `MI`… when one was given. */
  readonly descriptor: string | null;
  /** `RA`, `SN`, `FG`… one or more, in the order reported. */
  readonly kinds: readonly string[];
  /** True when the group was prefixed `VC` — in the vicinity, not here. */
  readonly vicinity: boolean;
}

export interface MetarReport {
  readonly raw: string;
  readonly station: string | null;
  /** Day of the month the observation was taken. */
  readonly dayOfMonth: number | null;
  readonly hourUtc: number | null;
  readonly minuteUtc: number | null;
  readonly automatic: boolean;
  readonly cavok: boolean;
  readonly wind: MetarWind | null;
  /** Horizontal visibility, metres; null when the report did not give one. */
  readonly visibilityM: number | null;
  readonly phenomena: readonly MetarPhenomenon[];
  readonly clouds: readonly MetarCloud[];
  /** Vertical visibility in feet, for a sky obscured rather than clouded. */
  readonly verticalVisibilityFt: number | null;
  /** True when the sky was reported clear (`SKC`, `CLR`, `NSC`, `NCD`). */
  readonly skyClear: boolean;
  readonly temperatureC: number | null;
  readonly dewPointC: number | null;
  readonly pressureHpa: number | null;
}

const AMOUNTS: Readonly<Record<string, CloudAmount>> = {
  FEW: CLOUD_AMOUNT.Few,
  SCT: CLOUD_AMOUNT.Scattered,
  BKN: CLOUD_AMOUNT.Broken,
  OVC: CLOUD_AMOUNT.Overcast,
};

const DESCRIPTORS = ["MI", "PR", "BC", "DR", "BL", "SH", "TS", "FZ"];
const PHENOMENA = [
  "DZ", "RA", "SN", "SG", "IC", "PL", "GR", "GS", "UP",
  "BR", "FG", "FU", "VA", "DU", "SA", "HZ",
  "PO", "SQ", "FC", "SS", "DS", "PY",
];

const STATION = /^[A-Z][A-Z0-9]{3}$/;
const OBSERVED_AT = /^(\d{2})(\d{2})(\d{2})Z$/;
const WIND = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/;
const WIND_VARIATION = /^(\d{3})V(\d{3})$/;
const VISIBILITY_METRES = /^(\d{4})(?:NDV|[NSEW]{1,2})?$/;
const VISIBILITY_MILES = /^(M)?(\d{1,2})(?:\/(\d{1,2}))?SM$/;
const CLOUD = /^(FEW|SCT|BKN|OVC)(\d{3}|\/{3})(CB|TCU)?$/;
const VERTICAL_VISIBILITY = /^VV(\d{3}|\/{3})$/;
const TEMPERATURE = /^(M?\d{1,2})\/(M?\d{1,2})$/;
const PRESSURE_HPA = /^Q(\d{4})$/;
const PRESSURE_INHG = /^A(\d{4})$/;

function signedTemperature(token: string): number {
  return token.startsWith("M") ? -Number(token.slice(1)) : Number(token);
}

function weatherGroup(token: string): MetarPhenomenon | null {
  let rest = token;
  let intensity = 0;
  let vicinity = false;

  if (rest.startsWith("-")) {
    intensity = -1;
    rest = rest.slice(1);
  } else if (rest.startsWith("+")) {
    intensity = 1;
    rest = rest.slice(1);
  }
  if (rest.startsWith("VC")) {
    vicinity = true;
    rest = rest.slice(2);
  }

  let descriptor: string | null = null;
  if (rest.length >= 2 && DESCRIPTORS.includes(rest.slice(0, 2))) {
    descriptor = rest.slice(0, 2);
    rest = rest.slice(2);
  }

  const kinds: string[] = [];
  while (rest.length >= 2 && PHENOMENA.includes(rest.slice(0, 2))) {
    kinds.push(rest.slice(0, 2));
    rest = rest.slice(2);
  }

  // Anything left over means this was never a weather group — a runway state
  // or a trend code that happens to start with the same two letters.
  if (rest.length > 0) return null;
  if (!descriptor && kinds.length === 0) return null;
  return { intensity, descriptor, kinds, vicinity };
}

/**
 * Decodes a report.
 *
 * Returns null only for input that is not a report at all; anything with a
 * usable group in it comes back, with the parts that were missing left null.
 */
export function parseMetar(raw: string): MetarReport | null {
  const text = raw.trim().toUpperCase().replace(/=+$/, "");
  if (text.length === 0) return null;

  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;

  let station: string | null = null;
  let dayOfMonth: number | null = null;
  let hourUtc: number | null = null;
  let minuteUtc: number | null = null;
  let automatic = false;
  let cavok = false;
  let wind: MetarWind | null = null;
  let visibilityM: number | null = null;
  let verticalVisibilityFt: number | null = null;
  let skyClear = false;
  let temperatureC: number | null = null;
  let dewPointC: number | null = null;
  let pressureHpa: number | null = null;
  const phenomena: MetarPhenomenon[] = [];
  const clouds: MetarCloud[] = [];

  let recognised = 0;
  // Everything after RMK is free text, and free text is full of groups that
  // look like data.
  const body = tokens.slice(0, tokens.indexOf("RMK") === -1 ? undefined : tokens.indexOf("RMK"));

  for (let i = 0; i < body.length; i += 1) {
    const token = body[i] as string;

    if (token === "METAR" || token === "SPECI" || token === "COR") continue;
    if (token === "AUTO") {
      automatic = true;
      recognised += 1;
      continue;
    }
    if (token === "NOSIG" || token === "NSW") continue;
    if (token === "CAVOK") {
      cavok = true;
      skyClear = true;
      visibilityM = visibilityM ?? UNLIMITED_VISIBILITY;
      recognised += 1;
      continue;
    }
    if (token === "SKC" || token === "CLR" || token === "NSC" || token === "NCD") {
      skyClear = true;
      recognised += 1;
      continue;
    }

    if (station === null && STATION.test(token) && !AMOUNTS[token]) {
      station = token;
      recognised += 1;
      continue;
    }

    const observed = OBSERVED_AT.exec(token);
    if (observed) {
      dayOfMonth = Number(observed[1]);
      hourUtc = Number(observed[2]);
      minuteUtc = Number(observed[3]);
      recognised += 1;
      continue;
    }

    const windGroup = WIND.exec(token);
    if (windGroup && wind === null) {
      const unit = windGroup[4] as string;
      const factor = unit === "KT" ? KNOTS_TO_MS : unit === "KMH" ? 1 / 3.6 : 1;
      wind = {
        directionDeg: windGroup[1] === "VRB" ? null : Number(windGroup[1]),
        speed: Number(windGroup[2]) * factor,
        gust: windGroup[3] ? Number(windGroup[3]) * factor : null,
        variableFromDeg: null,
        variableToDeg: null,
      };
      recognised += 1;
      continue;
    }

    const variation = WIND_VARIATION.exec(token);
    if (variation && wind !== null) {
      const observed: MetarWind = wind;
      wind = {
        directionDeg: observed.directionDeg,
        speed: observed.speed,
        gust: observed.gust,
        variableFromDeg: Number(variation[1]),
        variableToDeg: Number(variation[2]),
      };
      recognised += 1;
      continue;
    }

    const cloud = CLOUD.exec(token);
    if (cloud) {
      const height = cloud[2] as string;
      clouds.push({
        amount: AMOUNTS[cloud[1] as string] as CloudAmount,
        // A report that cannot measure the base still knows there is one.
        heightFt: height.includes("/") ? 2500 : Number(height) * 100,
        type:
          cloud[3] === "CB"
            ? CLOUD_TYPE.Cumulonimbus
            : cloud[3] === "TCU"
              ? CLOUD_TYPE.Towering
              : null,
      });
      recognised += 1;
      continue;
    }

    const vertical = VERTICAL_VISIBILITY.exec(token);
    if (vertical) {
      const height = vertical[1] as string;
      verticalVisibilityFt = height.includes("/") ? 100 : Number(height) * 100;
      recognised += 1;
      continue;
    }

    const temperature = TEMPERATURE.exec(token);
    if (temperature) {
      temperatureC = signedTemperature(temperature[1] as string);
      dewPointC = signedTemperature(temperature[2] as string);
      recognised += 1;
      continue;
    }

    const hpa = PRESSURE_HPA.exec(token);
    if (hpa) {
      pressureHpa = Number(hpa[1]);
      recognised += 1;
      continue;
    }

    const inHg = PRESSURE_INHG.exec(token);
    if (inHg) {
      pressureHpa = (Number(inHg[1]) / 100) * 33.8639;
      recognised += 1;
      continue;
    }

    const miles = VISIBILITY_MILES.exec(token);
    if (miles) {
      const whole = Number(miles[2]);
      const fraction = miles[3] ? whole / Number(miles[3]) : whole;
      // `1 1/2SM` arrives as two tokens: a bare integer and then the fraction.
      const previous = i > 0 ? (body[i - 1] as string) : "";
      const leading = miles[3] && /^\d{1,2}$/.test(previous) ? Number(previous) : 0;
      const value = (leading + fraction) * 1609.344;
      // `M1/4SM` means less than a quarter mile.
      visibilityM = miles[1] ? value * 0.75 : value;
      recognised += 1;
      continue;
    }

    if (visibilityM === null && !cavok) {
      const metres = VISIBILITY_METRES.exec(token);
      if (metres) {
        const value = Number(metres[1]);
        visibilityM = value >= 9999 ? UNLIMITED_VISIBILITY : value;
        recognised += 1;
        continue;
      }
    }

    const phenomenon = weatherGroup(token);
    if (phenomenon) {
      phenomena.push(phenomenon);
      recognised += 1;
      continue;
    }
  }

  if (recognised === 0) return null;
  return {
    raw: text,
    station,
    dayOfMonth,
    hourUtc,
    minuteUtc,
    automatic,
    cavok,
    wind,
    visibilityM,
    phenomena,
    clouds,
    verticalVisibilityFt,
    skyClear,
    temperatureC,
    dewPointC,
    pressureHpa,
  };
}

/** True when the report says thunder, whether or not it named a CB. */
function reportsThunder(report: MetarReport): boolean {
  return (
    report.phenomena.some((group) => group.descriptor === "TS") ||
    report.clouds.some((cloud) => cloud.type === CLOUD_TYPE.Cumulonimbus)
  );
}

/** What is falling, decoded from the weather groups. */
function precipitationFromReport(report: MetarReport): PrecipitationState {
  let best: PrecipitationState = NO_PRECIPITATION;
  let bestIntensity = 0;

  for (const group of report.phenomena) {
    const frozen = group.kinds.some((kind) =>
      ["SN", "SG", "IC", "PL"].includes(kind),
    );
    const liquid = group.kinds.some((kind) =>
      ["RA", "DZ", "GR", "GS", "UP"].includes(kind),
    );
    if (!frozen && !liquid) continue;

    // Drizzle is the lightest thing that falls; hail out of a storm is the
    // heaviest. Everything else sits on the reported intensity.
    let intensity = group.intensity < 0 ? 0.35 : group.intensity > 0 ? 0.95 : 0.65;
    if (group.kinds.includes("DZ")) intensity *= 0.6;
    if (group.kinds.includes("GR") || group.kinds.includes("GS")) intensity = 1;
    if (group.descriptor === "TS") intensity = Math.max(intensity, 0.8);
    // Something happening over the next valley is not happening here.
    if (group.vicinity) intensity *= 0.3;

    if (intensity > bestIntensity) {
      bestIntensity = intensity;
      best = {
        kind: frozen ? PRECIPITATION.Snow : PRECIPITATION.Rain,
        intensity,
        showers: group.descriptor === "SH" || group.descriptor === "TS",
      };
    }
  }
  return best;
}

/**
 * The genus of a reported layer.
 *
 * A report names only `CB` and `TCU`, because those are the two that change
 * how an aircraft is flown. Everything else has to be inferred, and height and
 * amount are enough to do it the way a forecaster would: anything with a base
 * down at a few hundred feet is stratus whatever the amount — cumulus does not
 * form that low — a broken or overcast low deck is stratocumulus, a scattered
 * one is cumulus, mid-level and raining is nimbostratus, and anything above six
 * kilometres is ice.
 */
function inferCloudType(
  cloud: MetarCloud,
  report: MetarReport,
  precipitating: boolean,
): CloudType {
  if (cloud.type) return cloud.type;
  if (reportsThunder(report)) return CLOUD_TYPE.Cumulonimbus;

  const metres = cloud.heightFt * FEET_TO_METRES;
  const solid =
    cloud.amount === CLOUD_AMOUNT.Broken || cloud.amount === CLOUD_AMOUNT.Overcast;

  if (metres >= 6000) return CLOUD_TYPE.Cirrus;
  if (metres >= 2000) {
    return precipitating && solid ? CLOUD_TYPE.Nimbostratus : CLOUD_TYPE.Altostratus;
  }
  if (metres < 300) return CLOUD_TYPE.Stratus;
  if (!solid) return CLOUD_TYPE.Cumulus;
  return precipitating ? CLOUD_TYPE.Nimbostratus : CLOUD_TYPE.Stratocumulus;
}

export interface MetarDecodeOptions {
  /**
   * The height the mission origin sits at relative to the reporting station,
   * metres — the mission's ground elevation minus the station's.
   *
   * Cloud is reported above the aerodrome, and the aerodrome is usually not
   * where the flight starts. Positive means the flight starts above the field,
   * which lowers every base by that much and can push a deck below the launch
   * point entirely; negative means it starts below, which lifts them. Without
   * it a base reported over a sea-level airfield would sit inside an alpine
   * ridge.
   */
  readonly stationElevationOffset?: number;
}

/**
 * The sky a report describes.
 *
 * Everything the simulator needs and nothing it does not: the runway state,
 * the trend group and the remarks are read and discarded.
 */
export function weatherStateFromMetar(
  report: MetarReport,
  options: MetarDecodeOptions = {},
): WeatherState {
  const offset = options.stationElevationOffset ?? 0;
  const precipitation = precipitationFromReport(report);
  const precipitating = precipitation.kind !== PRECIPITATION.None;
  const thunderstorm = reportsThunder(report);

  const reported = report.clouds
    .slice()
    .sort((a, b) => a.heightFt - b.heightFt)
    .slice(0, MAX_CLOUD_LAYERS);

  const layers: CloudLayer[] = reported.map((cloud, index) => {
    const type = inferCloudType(cloud, report, precipitating);
    const info = CLOUD_TYPE_INFO[type];
    const baseAgl = clamp(
      cloud.heightFt * FEET_TO_METRES - offset,
      MIN_CLOUD_BASE,
      MAX_CLOUD_BASE,
    );
    // A flat deck stops under whatever is reported above it; a convective one
    // is allowed to tower straight through, because that is what it does.
    const above = reported[index + 1];
    const room = above
      ? Math.max(above.heightFt * FEET_TO_METRES - offset - baseAgl - 60, 120)
      : Number.POSITIVE_INFINITY;
    const depth =
      info.convection >= 0.9
        ? info.defaultDepth
        : Math.min(info.defaultDepth, room);
    return { amount: cloud.amount, type, baseAgl, depth };
  });

  // A sky reported obscured has no measurable base at all: what is quoted is
  // how far up you can see into it, which is the top of the murk.
  if (layers.length === 0 && report.verticalVisibilityFt !== null) {
    layers.push({
      amount: CLOUD_AMOUNT.Overcast,
      type: CLOUD_TYPE.Stratus,
      // Murk you are standing in starts at the ground you are standing on.
      baseAgl: 0,
      depth: Math.max(
        report.verticalVisibilityFt * FEET_TO_METRES + 200,
        CLOUD_TYPE_INFO[CLOUD_TYPE.Stratus].defaultDepth,
      ),
    });
  }

  const visibilityM = report.visibilityM ?? UNLIMITED_VISIBILITY;
  const wind = windFromReport(report, layers);
  const temperatureC = report.temperatureC ?? 15;

  const state = {
    layers: normalizeLayers(layers),
    visibilityM,
    precipitation:
      precipitation.kind === PRECIPITATION.None && precipitating
        ? NO_PRECIPITATION
        : precipitation,
    thunderstorm,
  };

  return {
    source: WEATHER_SOURCE.Metar,
    preset: nearestPreset(state),
    label: report.station ? `METAR ${report.station}` : "METAR",
    description: report.raw,
    layers: state.layers,
    visibilityM,
    precipitation: state.precipitation,
    thunderstorm,
    wind,
    temperatureC,
    dewPointC: report.dewPointC ?? temperatureC - 5,
    pressureHpa: report.pressureHpa ?? 1013,
    station: report.station,
    metar: report.raw,
  };
}

/**
 * The wind through the depth of the flight, from a report that only measured
 * it at ten metres.
 *
 * A surface wind is not the wind at a thousand metres, and pretending it is
 * costs the one thing that makes flying a real airmass interesting. So the
 * reported wind is kept exactly as observed at the surface and a gradient wind
 * is put above it: stronger, and veered to the right in the northern sense, as
 * friction stops holding it back. That is an approximation of the Ekman spiral
 * rather than a measurement, and it is a far better guess than no shear at all.
 */
function windFromReport(
  report: MetarReport,
  layers: readonly CloudLayer[],
) {
  const observed = report.wind;
  const speed = observed?.speed ?? 0;
  const direction = observed?.directionDeg ?? 250;
  const gust = observed?.gust ?? null;

  // A gust group says outright how hard it is gusting; without one the
  // gustiness follows how convective the sky is.
  const convective = layers.some(
    (layer) => CLOUD_TYPE_INFO[layer.type].convection >= 0.75,
  );
  const gustiness =
    gust !== null && speed > 0.5
      ? clamp((gust / speed - 1) * 1.4, 0.1, 1)
      : convective
        ? 0.55
        : 0.25;

  // `VRB`, or a reported variation range, is the report telling you outright
  // how much the direction moves.
  let variation = gustiness * 0.7;
  if (observed && observed.directionDeg === null) variation = 0.85;
  else if (observed && observed.variableFromDeg !== null && observed.variableToDeg !== null) {
    const from = observed.variableFromDeg;
    const to = observed.variableToDeg;
    const span = ((to - from) % 360 + 360) % 360;
    variation = clamp(span / 120, 0.15, 1);
  }

  const gradient: WindLayer = {
    altitudeAgl: 1200,
    directionDeg: (direction + 25) % 360,
    speed: speed * 1.75 + 1.5,
  };

  return {
    layers: normalizeWindLayers([
      { altitudeAgl: WIND_REFERENCE_HEIGHT, directionDeg: direction, speed },
      gradient,
      {
        altitudeAgl: 4000,
        directionDeg: (direction + 40) % 360,
        speed: speed * 2.4 + 4,
      },
    ]),
    gustiness,
    variation,
  };
}

/** Convenience: a raw report straight to a sky, or null if it will not parse. */
export function weatherStateFromRawMetar(
  raw: string,
  options: MetarDecodeOptions = {},
): WeatherState | null {
  const report = parseMetar(raw);
  return report ? weatherStateFromMetar(report, options) : null;
}

export interface MetarFormatOptions {
  /** Station identifier to write into the report. */
  readonly station?: string;
  /** Observation time; the current time when not given. */
  readonly observedAt?: Date;
}

/**
 * Writes a sky back out as a report.
 *
 * The round trip is not lossless — a report has no vocabulary for "the cloud
 * is 900 metres deep" — but it is faithful in everything a report *can* say,
 * which is what makes a generated or hand-built day something the pilot can
 * copy out, read, and paste back in.
 */
export function formatMetar(
  state: WeatherState,
  options: MetarFormatOptions = {},
): string {
  const parts: string[] = ["METAR"];
  parts.push(options.station ?? state.station ?? "ZZZZ");

  const at = options.observedAt ?? new Date();
  parts.push(
    `${pad2(at.getUTCDate())}${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}Z`,
  );

  const surface = surfaceWind(state.wind);
  const knots = Math.round(surface.speed / KNOTS_TO_MS);
  if (knots === 0) {
    parts.push("00000KT");
  } else {
    const gust = Math.round(knots * (1 + state.wind.gustiness * 0.75));
    const direction = state.wind.variation >= 0.8
      ? "VRB"
      : pad3(Math.round(surface.directionDeg / 10) * 10 % 360);
    parts.push(
      `${direction}${pad2(knots)}${gust > knots + 4 ? `G${pad2(gust)}` : ""}KT`,
    );
  }

  const clear = state.layers.length === 0;
  const cavok =
    clear &&
    state.visibilityM >= UNLIMITED_VISIBILITY &&
    state.precipitation.kind === PRECIPITATION.None &&
    !state.thunderstorm;

  if (cavok) {
    parts.push("CAVOK");
  } else {
    parts.push(
      state.visibilityM >= UNLIMITED_VISIBILITY
        ? "9999"
        : pad4(Math.min(Math.round(state.visibilityM / 50) * 50, 9998)),
    );

    const weather = formatPresentWeather(state);
    if (weather) parts.push(weather);

    if (clear) parts.push("NSC");
    else for (const layer of state.layers) parts.push(formatLayer(layer));
  }

  parts.push(
    `${formatTemperature(state.temperatureC)}/${formatTemperature(state.dewPointC)}`,
  );
  parts.push(`Q${pad4(Math.round(state.pressureHpa))}`);
  return parts.join(" ");
}

function formatPresentWeather(state: WeatherState): string | null {
  const { kind, intensity, showers } = state.precipitation;
  if (kind === PRECIPITATION.None) {
    if (state.thunderstorm) return "TS";
    // Poor visibility with nothing falling is mist below a kilometre and haze
    // above it — which is exactly how an observer would report it.
    if (state.visibilityM < 1000) return "FG";
    if (state.visibilityM < 5000) return "BR";
    return null;
  }
  const prefix = intensity >= 0.85 ? "+" : intensity <= 0.45 ? "-" : "";
  const descriptor = state.thunderstorm ? "TS" : showers ? "SH" : "";
  const body = kind === PRECIPITATION.Snow ? "SN" : "RA";
  return `${prefix}${descriptor}${body}`;
}

function formatTemperature(celsius: number): string {
  const rounded = Math.round(celsius);
  return rounded < 0 ? `M${pad2(Math.abs(rounded))}` : pad2(rounded);
}

function pad2(value: number): string {
  return String(Math.max(0, Math.round(value))).padStart(2, "0");
}

function pad3(value: number): string {
  return String(Math.max(0, Math.round(value))).padStart(3, "0");
}

function pad4(value: number): string {
  return String(Math.max(0, Math.round(value))).padStart(4, "0");
}

/** The cloud groups of a sky, for a compact summary line. */
export function formatCloudGroups(state: WeatherState): string {
  if (state.layers.length === 0) return "NSC";
  return state.layers.map(formatLayer).join(" ");
}
