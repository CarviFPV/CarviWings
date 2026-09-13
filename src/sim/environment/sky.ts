/**
 * Cloud layers, in the vocabulary a pilot already has.
 *
 * A sky is not one number. Real weather comes in decks — a scattered cumulus
 * base with a broken sheet above it, a towering cell sitting in an otherwise
 * quiet afternoon — and the terminology for describing that is already
 * standardised in the aerodrome report: an *amount* in oktas (`FEW`, `SCT`,
 * `BKN`, `OVC`), a *base* in hundreds of feet, and, where it matters to an
 * aircraft, a *genus* (`CB`, `TCU`).
 *
 * That is what this module models. Everything downstream — the raymarched
 * volume, the billboard field, the visibility model, the precipitation and the
 * lightning — reads layers from here rather than a single cloud base, so all of
 * them agree about where the cloud actually is.
 *
 * Heights are metres above the mission origin's ground, because that is the
 * frame the simulation and both cloud renderers work in. METAR quotes feet
 * above aerodrome level; the conversion lives in `metar.ts` and nowhere else.
 *
 * A base is allowed to be *negative*. The launch point is not the bottom of
 * the world: fly from a ridge and the deck reported by the aerodrome down in
 * the valley is genuinely below you, and a sea of cloud seen from above is one
 * of the things a mountain launch is for. Everything downstream — the march,
 * the billboard field, the visibility model, the precipitation lid — is
 * written in signed local metres and needs nothing else to draw it there.
 */

import { clamp } from "../math/scalar";

/** How much of the sky a layer covers, in the reported oktas bands. */
export const CLOUD_AMOUNT = {
  Few: "FEW",
  Scattered: "SCT",
  Broken: "BKN",
  Overcast: "OVC",
} as const;

export type CloudAmount = (typeof CLOUD_AMOUNT)[keyof typeof CLOUD_AMOUNT];

/** Every amount, driest first — the order the editor lists them in. */
export const CLOUD_AMOUNTS: readonly CloudAmount[] = [
  CLOUD_AMOUNT.Few,
  CLOUD_AMOUNT.Scattered,
  CLOUD_AMOUNT.Broken,
  CLOUD_AMOUNT.Overcast,
];

export interface CloudAmountInfo {
  readonly id: CloudAmount;
  readonly label: string;
  /** Oktas the band spans, as reported. */
  readonly oktas: readonly [number, number];
  /** Fraction of the sky the layer fills, taken at the middle of the band. */
  readonly coverage: number;
}

export const CLOUD_AMOUNT_INFO: Readonly<Record<CloudAmount, CloudAmountInfo>> = {
  [CLOUD_AMOUNT.Few]: {
    id: CLOUD_AMOUNT.Few,
    label: "Few",
    oktas: [1, 2],
    coverage: 0.19,
  },
  [CLOUD_AMOUNT.Scattered]: {
    id: CLOUD_AMOUNT.Scattered,
    label: "Scattered",
    oktas: [3, 4],
    coverage: 0.44,
  },
  [CLOUD_AMOUNT.Broken]: {
    id: CLOUD_AMOUNT.Broken,
    label: "Broken",
    oktas: [5, 7],
    coverage: 0.75,
  },
  [CLOUD_AMOUNT.Overcast]: {
    id: CLOUD_AMOUNT.Overcast,
    label: "Overcast",
    oktas: [8, 8],
    coverage: 1,
  },
} as const;

/** The genus of a layer. `CB` and `TCU` are the two a report actually names. */
export const CLOUD_TYPE = {
  Cumulus: "CU",
  Stratocumulus: "SC",
  Stratus: "ST",
  Towering: "TCU",
  Cumulonimbus: "CB",
  Nimbostratus: "NS",
  Altostratus: "AS",
  Cirrus: "CI",
} as const;

export type CloudType = (typeof CLOUD_TYPE)[keyof typeof CLOUD_TYPE];

export interface CloudTypeInfo {
  readonly id: CloudType;
  readonly label: string;
  readonly description: string;
  /** Vertical extent a layer of this genus is given when nothing says otherwise. */
  readonly defaultDepth: number;
  /** Typical base above ground, metres; used when a layer is added blind. */
  readonly typicalBase: number;
  /**
   * How solid the cloud is, 0..1.
   *
   * Drives the march's extinction and how much of a sight line the layer eats.
   * Cirrus is ice and you can see the sun through it; nimbostratus is not.
   */
  readonly density: number;
  /** How much the layer piles upward rather than spreading flat, 0..1. */
  readonly convection: number;
  /** True for the one genus that makes lightning. */
  readonly thunder: boolean;
  /**
   * How hard it rains out of a layer of this genus at full coverage, 0..1.
   * Zero means this cloud does not precipitate at all.
   */
  readonly precipitation: number;
  /** True when what falls out of it comes in showers rather than steadily. */
  readonly showery: boolean;
}

export const CLOUD_TYPE_INFO: Readonly<Record<CloudType, CloudTypeInfo>> = {
  [CLOUD_TYPE.Cumulus]: {
    id: CLOUD_TYPE.Cumulus,
    label: "Cumulus",
    description: "Fair-weather lumps with flat bases and blue sky between them.",
    defaultDepth: 700,
    typicalBase: 1200,
    density: 0.82,
    convection: 0.75,
    thunder: false,
    precipitation: 0,
    showery: true,
  },
  [CLOUD_TYPE.Stratocumulus]: {
    id: CLOUD_TYPE.Stratocumulus,
    label: "Stratocumulus",
    description: "A lumpy sheet. The usual low deck over a cool, damp airmass.",
    defaultDepth: 600,
    typicalBase: 900,
    density: 0.88,
    convection: 0.3,
    thunder: false,
    precipitation: 0.15,
    showery: false,
  },
  [CLOUD_TYPE.Stratus]: {
    id: CLOUD_TYPE.Stratus,
    label: "Stratus",
    description: "Featureless grey, low enough to sit on the hills.",
    defaultDepth: 300,
    typicalBase: 250,
    density: 0.9,
    convection: 0.05,
    thunder: false,
    precipitation: 0.2,
    showery: false,
  },
  [CLOUD_TYPE.Towering]: {
    id: CLOUD_TYPE.Towering,
    label: "Towering cumulus",
    description: "Cumulus growing hard. Showers under it and a rough ride in it.",
    defaultDepth: 3000,
    typicalBase: 1100,
    density: 0.95,
    convection: 1,
    thunder: false,
    precipitation: 0.55,
    showery: true,
  },
  [CLOUD_TYPE.Cumulonimbus]: {
    id: CLOUD_TYPE.Cumulonimbus,
    label: "Cumulonimbus",
    description: "A thunderstorm cell: heavy showers, violent air, lightning.",
    defaultDepth: 8000,
    typicalBase: 1000,
    density: 1,
    convection: 1,
    thunder: true,
    precipitation: 0.95,
    showery: true,
  },
  [CLOUD_TYPE.Nimbostratus]: {
    id: CLOUD_TYPE.Nimbostratus,
    label: "Nimbostratus",
    description: "The rain deck. Thick, dark and steady, with no gaps in it.",
    defaultDepth: 3500,
    typicalBase: 600,
    density: 1,
    convection: 0.1,
    thunder: false,
    precipitation: 0.8,
    showery: false,
  },
  [CLOUD_TYPE.Altostratus]: {
    id: CLOUD_TYPE.Altostratus,
    label: "Altostratus",
    description: "A mid-level sheet the sun shows through as a bright patch.",
    defaultDepth: 1500,
    typicalBase: 3500,
    density: 0.62,
    convection: 0.1,
    thunder: false,
    precipitation: 0.1,
    showery: false,
  },
  [CLOUD_TYPE.Cirrus]: {
    id: CLOUD_TYPE.Cirrus,
    label: "Cirrus",
    description: "Ice, far above everything. You fly through it and barely notice.",
    defaultDepth: 900,
    typicalBase: 8000,
    density: 0.28,
    convection: 0,
    thunder: false,
    precipitation: 0,
    showery: false,
  },
} as const;

/** Every genus, lowest-flying first — the order the editor lists them in. */
export const CLOUD_TYPES: readonly CloudType[] = [
  CLOUD_TYPE.Stratus,
  CLOUD_TYPE.Stratocumulus,
  CLOUD_TYPE.Cumulus,
  CLOUD_TYPE.Towering,
  CLOUD_TYPE.Cumulonimbus,
  CLOUD_TYPE.Nimbostratus,
  CLOUD_TYPE.Altostratus,
  CLOUD_TYPE.Cirrus,
];

export interface CloudLayer {
  readonly amount: CloudAmount;
  readonly type: CloudType;
  /** Base above the mission origin's ground, metres. */
  readonly baseAgl: number;
  /** Vertical extent, metres. */
  readonly depth: number;
}

/**
 * How many decks a sky may have.
 *
 * Three is the number a routine METAR carries, and it is also what the cloud
 * march can afford: every extra deck is another density evaluation at every
 * step of every ray.
 */
export const MAX_CLOUD_LAYERS = 3;

/**
 * Bounds a layer's base and depth are held to, metres.
 *
 * The floor is below the launch point, not at it. Clamping every base to just
 * above the pilot is what made a report from a valley aerodrome put its cloud
 * on top of a mountain start — the deck the pilot was supposed to be looking
 * down on ended up as fog around the wing.
 */
export const MIN_CLOUD_BASE = -4000;
export const MAX_CLOUD_BASE = 12000;
export const MIN_CLOUD_DEPTH = 60;
export const MAX_CLOUD_DEPTH = 10000;

/** A layer of this genus, at a sensible base, ready to be edited. */
export function defaultLayer(type: CloudType): CloudLayer {
  const info = CLOUD_TYPE_INFO[type];
  return {
    amount: CLOUD_AMOUNT.Scattered,
    type,
    baseAgl: info.typicalBase,
    depth: info.defaultDepth,
  };
}

/** One layer, with its numbers held to what the renderers can draw. */
export function clampLayer(layer: CloudLayer): CloudLayer {
  const baseAgl = clamp(layer.baseAgl, MIN_CLOUD_BASE, MAX_CLOUD_BASE);
  const depth = clamp(layer.depth, MIN_CLOUD_DEPTH, MAX_CLOUD_DEPTH);
  if (baseAgl === layer.baseAgl && depth === layer.depth) return layer;
  return { ...layer, baseAgl, depth };
}

/**
 * The layers a sky is actually flown with: clamped, lowest first, and no more
 * of them than the renderers will draw.
 *
 * Layers past the limit are dropped from the top down, which is the same
 * choice an observer makes — the deck you are about to fly into matters more
 * than the cirrus above it.
 */
export function normalizeLayers(
  layers: readonly CloudLayer[],
): readonly CloudLayer[] {
  return layers
    .map(clampLayer)
    .sort((a, b) => a.baseAgl - b.baseAgl)
    .slice(0, MAX_CLOUD_LAYERS);
}

/**
 * The same layers, clamped and capped, but left in the order they were given
 * in.
 *
 * This is what an *editor* wants. Sorting a sky while one of its bases is
 * being dragged swaps that deck with its neighbour under the pointer, so the
 * slider the pilot is holding suddenly belongs to a different layer — which is
 * why a deck could never be moved past another one by hand. Sorting is a
 * property of the sky being *resolved*, and happens exactly once, in
 * `normalizeLayers`.
 */
export function clampLayers(
  layers: readonly CloudLayer[],
): readonly CloudLayer[] {
  return layers.map(clampLayer).slice(0, MAX_CLOUD_LAYERS);
}

/** Fraction of the sky this layer alone fills, 0..1. */
export function layerCoverage(layer: CloudLayer): number {
  return CLOUD_AMOUNT_INFO[layer.amount].coverage;
}

/** Top of a layer, metres above the mission origin's ground. */
export function layerTop(layer: CloudLayer): number {
  return layer.baseAgl + layer.depth;
}

/**
 * How much of the sky is covered by cloud in total, 0..1.
 *
 * Reported amounts are cumulative — an observer counts every layer at or below
 * the one being reported — so the total is the largest amount present rather
 * than a sum, and a valid report always names it last. A sky assembled by hand
 * need not obey that, so the maximum is taken rather than the top layer's.
 */
export function skyCoverage(layers: readonly CloudLayer[]): number {
  let most = 0;
  for (const layer of layers) most = Math.max(most, layerCoverage(layer));
  return most;
}

/** The layer a pilot means by "the cloud base"; null when the sky is empty. */
export function primaryLayer(
  layers: readonly CloudLayer[],
): CloudLayer | null {
  let best: CloudLayer | null = null;
  for (const layer of layers) {
    if (!best) {
      best = layer;
      continue;
    }
    // The deck that matters is the one that fills most of the sky, and the
    // lowest of those when two fill the same amount.
    if (layerCoverage(layer) > layerCoverage(best)) best = layer;
  }
  return best;
}

/**
 * The ceiling, in the aviation sense: the base of the lowest layer that is
 * broken or worse. Infinite when nothing up there qualifies.
 */
export function ceilingAgl(layers: readonly CloudLayer[]): number {
  for (const layer of layers) {
    if (
      layer.amount === CLOUD_AMOUNT.Broken ||
      layer.amount === CLOUD_AMOUNT.Overcast
    ) {
      return layer.baseAgl;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The top of the highest cloud there is, metres AGL; zero for an empty sky.
 *
 * This is the lid on the weather: nothing falls out of air that has no cloud
 * above it, so precipitation stops here and the pilot who climbs above the
 * deck flies out of the rain.
 */
export function highestCloudTop(layers: readonly CloudLayer[]): number {
  if (layers.length === 0) return 0;
  let top = Number.NEGATIVE_INFINITY;
  for (const layer of layers) top = Math.max(top, layerTop(layer));
  return top;
}

/** True when any layer is one that makes lightning. */
export function hasThunderCloud(layers: readonly CloudLayer[]): boolean {
  return layers.some((layer) => CLOUD_TYPE_INFO[layer.type].thunder);
}

/**
 * How hard it is precipitating out of these layers, 0..1.
 *
 * Each layer contributes what its genus produces, scaled by how much of the
 * sky it fills and by how deep it is — a 300 m stratus deck drizzles, the same
 * genus 3 km thick does not exist, and a cumulonimbus is mostly depth.
 */
export function precipitationIntensity(layers: readonly CloudLayer[]): number {
  let hardest = 0;
  for (const layer of layers) {
    const info = CLOUD_TYPE_INFO[layer.type];
    if (info.precipitation <= 0) continue;
    const depthFactor = clamp(layer.depth / Math.max(info.defaultDepth, 1), 0.35, 1);
    hardest = Math.max(
      hardest,
      info.precipitation * layerCoverage(layer) * depthFactor,
    );
  }
  return clamp(hardest, 0, 1);
}

/** True when a point at this height AGL is inside any of the layers. */
export function insideAnyLayer(
  layers: readonly CloudLayer[],
  heightAgl: number,
): boolean {
  return layers.some(
    (layer) => heightAgl >= layer.baseAgl && heightAgl <= layerTop(layer),
  );
}

/** A layer written the way a report writes it, e.g. `BKN025CB`. */
export function formatLayer(layer: CloudLayer): string {
  // A deck below the launch point has no height a report could carry — the
  // format has three digits and no sign — so it is written as being on the
  // deck, which is what an observer standing under it would report.
  const hundredsOfFeet = Math.round((layer.baseAgl / 0.3048) / 100);
  const height = String(clamp(hundredsOfFeet, 0, 999)).padStart(3, "0");
  const suffix =
    layer.type === CLOUD_TYPE.Cumulonimbus
      ? "CB"
      : layer.type === CLOUD_TYPE.Towering
        ? "TCU"
        : "";
  return `${layer.amount}${height}${suffix}`;
}

/** A layer written for a human: `Broken cumulus, base 1200 m`. */
export function describeLayer(layer: CloudLayer): string {
  const base = Math.round(layer.baseAgl);
  const where =
    base < 0 ? `base ${-base} m below launch` : `base ${base} m`;
  return `${CLOUD_AMOUNT_INFO[layer.amount].label} ${CLOUD_TYPE_INFO[
    layer.type
  ].label.toLowerCase()}, ${where}`;
}
