/**
 * What GPU is in the machine, and how much of the frame it can be handed.
 *
 * Almost everything this simulator draws is already the GPU's work: the clouds
 * are a raymarch in a fragment shader, the rain and the snow are one full-screen
 * pass whatever the weather is doing, the terrain and the tilesets are Cesium's
 * own pipeline. What was missing was the other half of that — asking the machine
 * what it is before deciding how much of it to ask for. Every install got the
 * same fixed settings, so a laptop on Intel graphics was handed the same
 * multisampled, full-detail frame as a desktop with a discrete card, and the
 * card was handed no more than the laptop.
 *
 * So this is the check: a renderer string, a couple of context limits and the
 * browser's own hints about the machine, turned into a class of GPU, the preset
 * that class is good for, and the parts of the frame that are worth giving it.
 * No WebGL and no Cesium — the probe that fills in `GpuCapabilities` lives in
 * `lib/gpuProbe.ts`, and everything that decides anything is here, in Node,
 * where it can be checked against a list of real renderer strings rather than
 * judged by squinting at a frame counter on one developer's machine.
 *
 * Two rules run through all of it.
 *
 * The first is that this is decided **once, before the flight**, and never
 * during one. `render/preloadPlan.ts` has the long version: a governor that
 * gives up detail as the frame rate falls was tried, and it made the picture
 * worse without making the stutters better. Hardware does not change between
 * frames, so nothing here has to be re-asked between them.
 *
 * The second is what this is allowed to decide. The preset names how much
 * *world* is drawn — terrain detail, tile caches, screen-space error — and that
 * is the pilot's choice on the menu, which nothing here overrides. What is not
 * on the menu is how the frame is put together: the multisample count, whether
 * a full-screen anti-aliasing pass is still worth running, what fraction of the
 * framebuffer the cloud march runs at. Those are the GPU's business, and they
 * are provisioned from the GPU that is actually installed.
 */

import { clamp } from "../math/scalar";

/**
 * The graphics presets, by name.
 *
 * The presets themselves are `lib/cesium/quality.ts`, which is where the
 * numbers are and which checks against this list that the two agree. The names
 * are here because this is what recommends one.
 */
export const GRAPHICS_QUALITY_NAMES = ["low", "medium", "high", "ultra"] as const;

export type GraphicsQualityName = (typeof GRAPHICS_QUALITY_NAMES)[number];

/**
 * What kind of thing is drawing.
 *
 * Deliberately coarse. The difference between two cards a generation apart is
 * not worth guessing at from a string; the difference between a software
 * rasteriser, a phone, an integrated chip and a discrete card is the whole
 * decision.
 */
export const GPU_CLASS = {
  /** No GPU at all: SwiftShader, llvmpipe, Microsoft's basic renderer. */
  Software: "software",
  /** A phone or a tablet part: Adreno, Mali, PowerVR, Apple A-series. */
  Mobile: "mobile",
  /** Sharing the memory bus with the CPU: Intel HD/UHD/Iris, an AMD APU. */
  Integrated: "integrated",
  /** A card of its own, with memory of its own. */
  Discrete: "discrete",
  /** A card of its own, and a generous one. */
  Enthusiast: "enthusiast",
  /** The renderer string was masked and the limits said nothing decisive. */
  Unknown: "unknown",
} as const;

export type GpuClass = (typeof GPU_CLASS)[keyof typeof GPU_CLASS];

/** What a probe can find out about the machine. */
export interface GpuCapabilities {
  /**
   * `UNMASKED_RENDERER_WEBGL`, or "" where the browser withholds it.
   *
   * Firefox in resist-fingerprinting mode, Safari, and Chrome behind certain
   * enterprise policies all report nothing useful here, which is why none of
   * the decisions below depend on it alone.
   */
  readonly renderer: string;
  /** `UNMASKED_VENDOR_WEBGL`, or "". */
  readonly vendor: string;
  /** Whether a WebGL 2 context could be created at all. */
  readonly webgl2: boolean;
  /** `gl.MAX_SAMPLES`, or 0 when it could not be read. */
  readonly maxSamples: number;
  /** `gl.MAX_TEXTURE_SIZE`, or 0. */
  readonly maxTextureSize: number;
  /** `navigator.deviceMemory` in GB, or null off Chromium. Caps at 8. */
  readonly deviceMemoryGb: number | null;
  /** `navigator.hardwareConcurrency`, or null. */
  readonly hardwareConcurrency: number | null;
  /** Whether the browser says it is running on a phone or a tablet. */
  readonly mobile: boolean;
}

/** What is known when nothing could be probed: a server render, or no WebGL. */
export const UNKNOWN_GPU: GpuCapabilities = {
  renderer: "",
  vendor: "",
  webgl2: false,
  maxSamples: 0,
  maxTextureSize: 0,
  deviceMemoryGb: null,
  hardwareConcurrency: null,
  mobile: false,
};

export interface GpuProfile {
  readonly capabilities: GpuCapabilities;
  readonly class: GpuClass;
  /** The part as it is worth showing a pilot, or "" where it is masked. */
  readonly model: string;
  /** The preset this machine is good for. */
  readonly quality: GraphicsQualityName;
  /** One line for the settings screen on how that was arrived at. */
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* Reading the renderer string                                                 */
/* -------------------------------------------------------------------------- */

/** Software rasterisers. There is no GPU behind any of these. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|basic display|d3d11 software|generic renderer|apple software renderer/;

/** Phone and tablet parts. */
const MOBILE = /adreno|mali[-\s]|powervr|videocore|apple a\d{1,2}\b|xclipse/;

/**
 * Strips the wrapper Chrome puts round a Windows renderer string.
 *
 * `ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)` is the
 * shape: the vendor, then the part, then the shader model it was compiled
 * against. Only the middle of that is a card anybody would recognise.
 */
export function gpuModelName(renderer: string): string {
  const trimmed = renderer.trim();
  if (trimmed === "") return "";

  let name = trimmed;
  const angle = /^angle\s*\((.*)\)$/i.exec(trimmed);
  if (angle?.[1]) {
    const parts = angle[1].split(",").map((part) => part.trim());
    // Vendor, part, driver — but older strings carry only one field, and a
    // part name can itself contain a comma. The longest field is the part.
    name = parts.length > 1 ? (parts[1] ?? parts[0] ?? "") : (parts[0] ?? "");
  }

  return name
    // Shader models, driver versions and PCI ids: true of the driver, not of
    // anything a pilot is trying to recognise.
    .replace(/\bdirect3d\d*\b/gi, "")
    .replace(/\bvs_\d+_\d+\b/gi, "")
    .replace(/\bps_\d+_\d+\b/gi, "")
    .replace(/\(0x[0-9a-f]+\)/gi, "")
    .replace(/\bopengl engine\b/gi, "")
    // Whatever came out took its spacing with it: an emptied bracket, and the
    // gap in front of the one that closed round it.
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,]+$/, "")
    .trim();
}

/** The four-digit model number in a card name, or 0. */
function modelNumber(text: string, prefix: RegExp): number {
  const match = prefix.exec(text);
  const digits = match?.[1];
  return digits ? Number.parseInt(digits, 10) : 0;
}

/**
 * Whether an NVIDIA part number is the upper half of its generation.
 *
 * A 4070 and a 4050 are the same generation and not the same card. NVIDIA puts
 * the generation in front and the tier in the last two digits — 1050, 2060,
 * 4070 — and sixty is where the mid-range starts.
 */
function nvidiaUpperTier(model: number): boolean {
  return model >= 100 && model % 100 >= 60;
}

/**
 * The same question for AMD, which numbers it differently: one generation
 * digit and a three-digit tier, so an RX 7900 and an RX 7600 are a generation
 * of each other and an RX 580 is two generations older than either.
 */
function amdUpperTier(model: number): boolean {
  return model >= 1000 && model % 1000 >= 600;
}

function classifyRenderer(renderer: string, mobile: boolean): GpuClass | null {
  const text = renderer.toLowerCase();
  if (text === "") return null;

  if (SOFTWARE.test(text)) return GPU_CLASS.Software;
  if (MOBILE.test(text)) return GPU_CLASS.Mobile;

  // Apple silicon. Every Mac that reports an Apple GPU is an M-series machine,
  // and the Pro, Max and Ultra parts are desktop-class by any measure.
  if (/apple m\d/.test(text)) {
    return /\b(pro|max|ultra)\b/.test(text)
      ? GPU_CLASS.Enthusiast
      : GPU_CLASS.Discrete;
  }
  // Safari masks the part but still names the vendor: "Apple GPU".
  if (/\bapple\b/.test(text)) {
    return mobile ? GPU_CLASS.Mobile : GPU_CLASS.Discrete;
  }

  if (/nvidia|geforce|quadro|tesla|titan|\brtx\b|\bgtx\b/.test(text)) {
    if (/titan|quadro|tesla|\brtx a\d/.test(text)) return GPU_CLASS.Enthusiast;
    const model =
      modelNumber(text, /\brtx\s*(\d{3,4})/) ||
      modelNumber(text, /\bgtx\s*(\d{3,4})/) ||
      modelNumber(text, /\bgeforce\s+(?:rtx\s+|gtx\s+)?(\d{3,4})/);
    return nvidiaUpperTier(model) ? GPU_CLASS.Enthusiast : GPU_CLASS.Discrete;
  }

  // Intel's discrete line is named before its integrated one is looked for:
  // "Intel(R) Arc(TM) A770" matches both.
  if (/\barc\b/.test(text) && /intel/.test(text)) return GPU_CLASS.Discrete;

  if (/radeon|firepro|\bamd\b/.test(text)) {
    // An APU: the Ryzen integrated part reports itself as plain "Radeon
    // Graphics", or as a small Vega with a single-digit compute unit count.
    if (/\bvega\s*\d{1,2}\b/.test(text) && !/vega\s*(56|64)/.test(text)) {
      return GPU_CLASS.Integrated;
    }
    if (/radeon\s*(\(tm\)\s*)?graphics\s*$/.test(text.trim())) {
      return GPU_CLASS.Integrated;
    }
    if (/\b(r[3457])\s*graphics\b/.test(text)) return GPU_CLASS.Integrated;
    const model = modelNumber(text, /\brx\s*(\d{3,4})/);
    if (amdUpperTier(model)) return GPU_CLASS.Enthusiast;
    if (/radeon pro|firepro|radeon vii|vega\s*(56|64)/.test(text)) {
      return GPU_CLASS.Enthusiast;
    }
    return GPU_CLASS.Discrete;
  }

  if (/intel|\buhd\b|\bhd graphics\b|\biris\b/.test(text)) {
    return GPU_CLASS.Integrated;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* The profile                                                                 */
/* -------------------------------------------------------------------------- */

/** What each class is good for before the machine around it is considered. */
const QUALITY_FOR_CLASS: Readonly<Record<GpuClass, GraphicsQualityName>> = {
  [GPU_CLASS.Software]: "low",
  [GPU_CLASS.Mobile]: "low",
  [GPU_CLASS.Integrated]: "medium",
  [GPU_CLASS.Discrete]: "high",
  [GPU_CLASS.Enthusiast]: "ultra",
  [GPU_CLASS.Unknown]: "medium",
};

const QUALITY_ORDER: Readonly<Record<GraphicsQualityName, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  ultra: 3,
};

function lowerOf(
  a: GraphicsQualityName,
  b: GraphicsQualityName,
): GraphicsQualityName {
  return QUALITY_ORDER[a] <= QUALITY_ORDER[b] ? a : b;
}

/**
 * How much system memory the top preset wants to see, in GB.
 *
 * Ultra sizes its tileset cache at a gigabyte and a half and its terrain cache
 * at sixteen hundred tiles, all of it held for the whole flight on purpose. A
 * machine with eight gigabytes in it can be *drawing* that comfortably and
 * still be swapping to hold it, which is a stutter the GPU had no part in.
 */
const ULTRA_MEMORY_GB = 8;

/** Below this a preset above Medium is asking for trouble. */
const HIGH_MEMORY_GB = 4;

/**
 * Whether a machine whose renderer is masked still looks like a strong one.
 *
 * Nothing here identifies a GPU — these are the limits and the browser's hints
 * about the box it is in. A 16k texture limit, a WebGL 2 context, eight cores
 * and eight gigabytes is not proof of a discrete card, but it is a machine that
 * is not going to be embarrassed by the middle preset either.
 */
function looksCapable(caps: GpuCapabilities): boolean {
  return (
    caps.webgl2 &&
    caps.maxTextureSize >= 16384 &&
    (caps.hardwareConcurrency ?? 0) >= 8 &&
    // Only Chromium reports memory at all, and Safari — the browser most
    // likely to have masked the renderer in the first place — never does.
    // Silence is not evidence of a small machine.
    (caps.deviceMemoryGb ?? ULTRA_MEMORY_GB) >= ULTRA_MEMORY_GB
  );
}

export function classifyGpu(capabilities: GpuCapabilities): GpuProfile {
  const model = gpuModelName(capabilities.renderer);
  const named = classifyRenderer(model || capabilities.renderer, capabilities.mobile);
  const gpuClass =
    named ?? (capabilities.mobile ? GPU_CLASS.Mobile : GPU_CLASS.Unknown);

  let quality = QUALITY_FOR_CLASS[gpuClass];
  const reasons: string[] = [];

  if (gpuClass === GPU_CLASS.Unknown && looksCapable(capabilities)) {
    // Masked renderer, but a machine that reads as a desktop.
    quality = "high";
  }

  // A context that cannot do WebGL 2 is either very old hardware or a driver
  // the browser has blacklisted; either way it is not the machine any of the
  // upper presets were measured on.
  if (!capabilities.webgl2 && capabilities.maxTextureSize > 0) {
    if (quality !== "low") reasons.push("no WebGL 2 context");
    quality = "low";
  }

  const memory = capabilities.deviceMemoryGb;
  if (memory !== null && memory < ULTRA_MEMORY_GB) {
    const capped = lowerOf(quality, memory < HIGH_MEMORY_GB ? "medium" : "high");
    if (capped !== quality) {
      quality = capped;
      reasons.push(`${memory} GB of system memory to hold the world in`);
    }
  }

  return {
    capabilities,
    class: gpuClass,
    model,
    quality,
    note: describe(gpuClass, model, quality, reasons),
  };
}

const CLASS_PROSE: Readonly<Record<GpuClass, string>> = {
  [GPU_CLASS.Software]: "no GPU at all: the frame is being drawn on the CPU",
  [GPU_CLASS.Mobile]: "a mobile GPU",
  [GPU_CLASS.Integrated]: "integrated graphics",
  [GPU_CLASS.Discrete]: "a discrete GPU",
  [GPU_CLASS.Enthusiast]: "a discrete GPU with room to spare",
  [GPU_CLASS.Unknown]: "a GPU the browser will not name",
};

/** The presets as the settings screen writes them. */
const QUALITY_LABEL: Readonly<Record<GraphicsQualityName, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

function describe(
  gpuClass: GpuClass,
  model: string,
  quality: GraphicsQualityName,
  reasons: readonly string[],
): string {
  const prose = CLASS_PROSE[gpuClass];
  // An unidentified GPU has a renderer string all the same — "WebKit WebGL",
  // or whatever the privacy mode substitutes — and printing it as though it
  // were the part would be worse than saying nothing.
  const named = model !== "" && gpuClass !== GPU_CLASS.Unknown;
  const what = named
    ? `${model} — ${prose}`
    : `${prose.charAt(0).toUpperCase()}${prose.slice(1)}`;
  const because =
    reasons.length > 0 ? `, held back by ${reasons.join(" and ")}` : "";
  return `${what}. The world is drawn at ${QUALITY_LABEL[quality]}${because}.`;
}

/* -------------------------------------------------------------------------- */
/* What the GPU is handed                                                      */
/* -------------------------------------------------------------------------- */

export interface AntiAliasing {
  /** Multisample count for the scene's framebuffer; one sample is none. */
  readonly msaaSamples: number;
  /** Whether the full-screen FXAA pass is run on top. */
  readonly fxaa: boolean;
}

/** Sample counts a GPU may actually be asked for. */
const SAMPLE_STEPS = [1, 2, 4, 8] as const;

/**
 * How many samples each class is worth asking for, where the preset wanted
 * anti-aliasing at all. Zero means "whatever the preset asked for".
 */
const SAMPLE_TARGET: Readonly<Record<GpuClass, number>> = {
  [GPU_CLASS.Software]: 1,
  [GPU_CLASS.Mobile]: 1,
  [GPU_CLASS.Integrated]: 2,
  [GPU_CLASS.Discrete]: 4,
  [GPU_CLASS.Enthusiast]: 4,
  // Unmeasured hardware is given what the preset asked for and nothing extra.
  [GPU_CLASS.Unknown]: 0,
};

/** Rounds down to a sample count worth asking a driver for. */
function snapSamples(samples: number): number {
  let snapped = 1;
  for (const step of SAMPLE_STEPS) if (step <= samples) snapped = step;
  return snapped;
}

/**
 * How the frame is anti-aliased, given what the preset asked for.
 *
 * The interesting half is the FXAA pass. Cesium's FXAA is a full-screen
 * post-process — its own render target, its own pass over every pixel — and it
 * is there because two samples of hardware multisampling leave stair-steps on a
 * wing against the sky. Four samples do not, so on a card that can afford four
 * the pass is dropped rather than run on top: that is a whole screen of
 * fragment work handed back, and a sharper picture for it. This is the one
 * place where asking the GPU for *more* makes the frame cheaper.
 *
 * Downwards it is simpler. A software rasteriser gets neither — multisampling
 * on llvmpipe is the frame rate divided by the sample count — and nothing is
 * ever asked for more samples than the context says it has.
 *
 * A preset that asked for no anti-aliasing at all is left alone in both
 * directions. Low is picked by somebody who wants the frame cheap, and a card
 * that could afford four samples is not a reason to overrule them.
 */
export function gpuAntiAliasing(
  asked: AntiAliasing,
  profile: GpuProfile,
): AntiAliasing {
  if (asked.msaaSamples <= 1 && !asked.fxaa) return { msaaSamples: 1, fxaa: false };
  if (profile.class === GPU_CLASS.Software) return { msaaSamples: 1, fxaa: false };

  const target = SAMPLE_TARGET[profile.class] || asked.msaaSamples;
  const supported =
    profile.capabilities.maxSamples > 0 ? profile.capabilities.maxSamples : target;
  const msaaSamples = snapSamples(clamp(target, 1, supported));

  return { msaaSamples, fxaa: msaaSamples >= 4 ? false : asked.fxaa };
}

/** Below this the preset is economising on purpose; see below. */
const RAISE_FLOOR = 0.5;

/**
 * What fraction of the framebuffer the volumetric cloud march runs at.
 *
 * The march is the most expensive thing on the screen and the one thing here
 * that is purely the GPU's: forty steps through the deck and four more towards
 * the sun, per pixel, every frame. Every preset runs it at half resolution or
 * less and upscales, which is why cloud edges are soft in a way weather is not.
 *
 * A card with headroom is given the resolution instead. This is work moved onto
 * the GPU rather than off it, and it is the right trade in exactly one
 * direction: a machine that was going to be waiting on the main thread anyway
 * spends the wait drawing better clouds.
 *
 * Below `RAISE_FLOOR` the preset has already given up half the framebuffer,
 * which is a preset asking for cheap clouds rather than one that could not have
 * them. Those are only ever lowered further, never raised.
 */
export function gpuCloudMarchScale(asked: number, profile: GpuProfile): number {
  const scale = (() => {
    switch (profile.class) {
      case GPU_CLASS.Software:
      case GPU_CLASS.Mobile:
        return Math.min(asked, 0.35);
      case GPU_CLASS.Discrete:
        return asked >= RAISE_FLOOR ? Math.min(1, asked * 1.4) : asked;
      case GPU_CLASS.Enthusiast:
        return asked >= RAISE_FLOOR ? 1 : asked;
      default:
        return asked;
    }
  })();
  return Math.round(clamp(scale, 0.2, 1) * 100) / 100;
}
