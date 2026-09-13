/**
 * The sky, drawn side-on.
 *
 * A list of decks with bases and depths in it is a perfectly good description
 * of the weather and a terrible picture of it. What a pilot actually wants to
 * know before launching — is the deck above me or below me, will I be in it at
 * two hundred metres, is the wind at ridge height the same wind as at the
 * surface — is a question about a *vertical section*, and the answer is a
 * drawing rather than a number.
 *
 * This module works out that drawing's geometry: where the axis starts and
 * ends, which round numbers get a tick, and where on the page each cloud deck
 * and each wind level lands. It deliberately stops there. Nothing here knows
 * about SVG, colour or React — the component draws what this returns — which
 * is what lets the axis arithmetic be tested with the rest of the simulation
 * rather than in a browser.
 *
 * Positions come back as fractions down the page (`0` at the top of the axis,
 * `1` at the bottom), so the same profile can be drawn at any height without
 * recomputing it.
 */

import { clamp } from "../math/scalar";
import type { CloudLayer } from "./sky";
import { CLOUD_AMOUNT_INFO, layerCoverage, layerTop } from "./sky";
import type { WeatherState, WindLayer } from "./weather";

/** How many ticks the altitude axis aims for. An aim, not a rule. */
const TICK_TARGET = 6;

/** The least depth of air the axis will ever show, metres. */
const MIN_SPAN = 400;

/** Air left above the highest thing drawn and below the lowest, as a fraction. */
const MARGIN = 0.12;

/** One cloud deck, placed on the page. */
export interface SkyProfileBand {
  /** Index into the sky's own layer list, so a selection can be matched up. */
  readonly index: number;
  readonly layer: CloudLayer;
  /** The deck as a report writes its amount and genus: `BKN CU`. */
  readonly label: string;
  /** 0..1 of the sky this deck fills. */
  readonly coverage: number;
  readonly baseAgl: number;
  readonly topAgl: number;
  /** Fractions down the page. `top` is the smaller number. */
  readonly top: number;
  readonly bottom: number;
}

/** One wind level, placed on the page. */
export interface SkyProfileWind {
  readonly index: number;
  readonly layer: WindLayer;
  readonly altitudeAgl: number;
  readonly directionDeg: number;
  readonly speed: number;
  readonly y: number;
  /** Speed against the fastest level drawn, 0..1, for how heavy the arrow is. */
  readonly strength: number;
}

export interface SkyProfileTick {
  readonly altitude: number;
  readonly y: number;
}

export interface SkyProfile {
  /** Bounds of the axis, metres above the mission origin's ground. */
  readonly floor: number;
  readonly ceiling: number;
  /** Round number the ticks step by, metres. */
  readonly step: number;
  readonly ticks: readonly SkyProfileTick[];
  /** Where the ground under the launch point sits on the page. */
  readonly ground: number;
  readonly clouds: readonly SkyProfileBand[];
  readonly winds: readonly SkyProfileWind[];
  /** Fastest wind level drawn, m/s; zero when the air is still. */
  readonly fastestWind: number;
}

export interface SkyProfileOptions {
  /**
   * The least height the axis reaches above the ground, metres. A clear sky
   * with a calm surface wind has nothing in it to set a scale, and an axis
   * that collapses onto the ground reads as broken rather than as empty.
   */
  readonly minCeiling?: number;
}

/**
 * A round step for an axis spanning this much air.
 *
 * 1, 2 or 5 times a power of ten — the only step sizes whose labels a reader
 * does arithmetic with without thinking about it.
 */
export function niceStep(span: number, target = TICK_TARGET): number {
  const raw = Math.max(span, 1) / Math.max(target, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const multiple of [1, 2, 5]) {
    if (magnitude * multiple >= raw) return magnitude * multiple;
  }
  return magnitude * 10;
}

/**
 * The section through a sky.
 *
 * The axis covers everything there is to show — every deck, every wind level,
 * and the ground at zero, which is always on it because the whole point of the
 * picture is whether the weather is above the launch point or below it — with
 * a margin of air at each end and its ends snapped out to the tick step.
 */
export function buildSkyProfile(
  state: WeatherState,
  options: SkyProfileOptions = {},
): SkyProfile {
  const layers = state.layers;
  const winds = state.wind.layers;

  let low = 0;
  let high = Math.max(options.minCeiling ?? 800, MIN_SPAN);
  for (const layer of layers) {
    low = Math.min(low, layer.baseAgl);
    high = Math.max(high, layerTop(layer));
  }
  for (const wind of winds) {
    low = Math.min(low, wind.altitudeAgl);
    high = Math.max(high, wind.altitudeAgl);
  }

  const margin = Math.max(high - low, MIN_SPAN) * MARGIN;
  const step = niceStep(high - low + 2 * margin);
  const floor = Math.floor((low - margin) / step) * step;
  const ceiling = Math.ceil((high + margin) / step) * step;
  const span = Math.max(ceiling - floor, 1);
  const yFor = (altitude: number): number => (ceiling - altitude) / span;

  const ticks: SkyProfileTick[] = [];
  for (let altitude = floor; altitude <= ceiling + step * 0.5; altitude += step) {
    // Floating point walks off a round number over a dozen additions, and the
    // label is what the reader trusts, so it is snapped back each time.
    const rounded = Math.round(altitude / step) * step;
    ticks.push({ altitude: rounded, y: clamp(yFor(rounded), 0, 1) });
  }

  let fastestWind = 0;
  for (const wind of winds) fastestWind = Math.max(fastestWind, wind.speed);

  return {
    floor,
    ceiling,
    step,
    ticks,
    ground: clamp(yFor(0), 0, 1),
    clouds: layers.map((layer, index) => ({
      index,
      layer,
      label: `${layer.amount} ${layer.type}`,
      coverage: layerCoverage(layer),
      baseAgl: layer.baseAgl,
      topAgl: layerTop(layer),
      top: clamp(yFor(layerTop(layer)), 0, 1),
      bottom: clamp(yFor(layer.baseAgl), 0, 1),
    })),
    winds: winds.map((layer, index) => ({
      index,
      layer,
      altitudeAgl: layer.altitudeAgl,
      directionDeg: layer.directionDeg,
      speed: layer.speed,
      y: clamp(yFor(layer.altitudeAgl), 0, 1),
      strength: fastestWind > 0 ? clamp(layer.speed / fastestWind, 0, 1) : 0,
    })),
    fastestWind,
  };
}

/** The oktas band a deck is reported in, as `5-7/8`, for the picture's key. */
export function oktasLabel(layer: CloudLayer): string {
  const [from, to] = CLOUD_AMOUNT_INFO[layer.amount].oktas;
  return from === to ? `${from}/8` : `${from}-${to}/8`;
}
