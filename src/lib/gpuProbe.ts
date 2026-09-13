"use client";

/**
 * Asking the browser what GPU is in the machine.
 *
 * One throwaway 1×1 WebGL context, read once and dropped. That is the whole
 * probe: `UNMASKED_RENDERER_WEBGL` for the part, a couple of context limits for
 * what it can be asked to do, and `navigator` for the box around it. Everything
 * that *decides* anything from that is `sim/render/gpuProfile.ts`, which has no
 * WebGL in it and is checked in Node against a list of real renderer strings.
 *
 * The context is deliberately minimal — no depth, no stencil, no alpha, no
 * multisampling — and is handed straight back through `WEBGL_lose_context`. A
 * browser will only keep a handful of live WebGL contexts, and the one that
 * matters is the viewer's; a probe that held one could cost the simulator the
 * globe on a machine already near the limit.
 *
 * Everything is cached for the life of the page. The answer cannot change:
 * nobody swaps a graphics card between two flights.
 *
 * Nothing here throws. A browser with WebGL disabled, a server render, a
 * hardened privacy mode that masks the renderer string — each of them lands on
 * `UNKNOWN_GPU`, and `classifyGpu` has a conservative answer for that.
 */

import {
  UNKNOWN_GPU,
  classifyGpu,
  type GpuCapabilities,
  type GpuProfile,
} from "@/sim/render/gpuProfile";
import {
  GRAPHICS_QUALITY_AUTO,
  type GraphicsQuality,
  type GraphicsQualityChoice,
} from "./cesium/quality";

let cached: GpuProfile | null = null;

/** Context attributes for a probe: as little of a context as WebGL allows. */
const PROBE_CONTEXT: WebGLContextAttributes = {
  alpha: false,
  depth: false,
  stencil: false,
  antialias: false,
  // The discrete card is the one worth asking about on a laptop with both.
  powerPreference: "high-performance",
  // The software fallback is a real answer here — it is the one machine that
  // most needs the lowest preset — so it must not be refused a context.
  failIfMajorPerformanceCaveat: false,
};

/**
 * The GPU as the browser will describe it, or `UNKNOWN_GPU`.
 *
 * Exported for the settings screen and for tests; everything else wants
 * `detectGpu`.
 */
export function probeGpu(): GpuCapabilities {
  if (typeof document === "undefined") return UNKNOWN_GPU;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;

    const gl2 = canvas.getContext("webgl2", PROBE_CONTEXT);
    const gl: WebGLRenderingContext | WebGL2RenderingContext | null =
      gl2 ?? canvas.getContext("webgl", PROBE_CONTEXT);
    if (!gl) return UNKNOWN_GPU;

    // Deprecated, and gone or masked in several browsers. Where it is missing,
    // `RENDERER` answers something generic like "WebKit WebGL", which
    // `classifyGpu` reads as an unnamed GPU rather than as a wrong one.
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = readString(
      gl,
      debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
    );
    const vendor = readString(
      gl,
      debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR,
    );

    const capabilities: GpuCapabilities = {
      renderer,
      vendor,
      webgl2: gl2 !== null,
      maxSamples: gl2 ? readNumber(gl2, gl2.MAX_SAMPLES) : 0,
      maxTextureSize: readNumber(gl, gl.MAX_TEXTURE_SIZE),
      deviceMemoryGb: readDeviceMemory(),
      hardwareConcurrency: readHardwareConcurrency(),
      mobile: readMobile(),
    };

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return capabilities;
  } catch {
    return UNKNOWN_GPU;
  }
}

/** The GPU, classified. Probed on the first call and cached after that. */
export function detectGpu(): GpuProfile {
  cached ??= classifyGpu(probeGpu());
  return cached;
}

/**
 * The preset a flight is actually flown at.
 *
 * `auto` is the one choice that is not a preset: it is the pilot saying the
 * machine should decide, and this is where that is decided — once, before the
 * flight, from hardware that will not change during it.
 */
export function resolveGraphicsQuality(
  choice: GraphicsQualityChoice,
): GraphicsQuality {
  return choice === GRAPHICS_QUALITY_AUTO ? detectGpu().quality : choice;
}

function readString(gl: WebGLRenderingContext, parameter: number): string {
  const value: unknown = gl.getParameter(parameter);
  return typeof value === "string" ? value : "";
}

function readNumber(gl: WebGLRenderingContext, parameter: number): number {
  const value: unknown = gl.getParameter(parameter);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Chromium only, rounded down to a power of two and capped at 8. */
function readDeviceMemory(): number | null {
  if (typeof navigator === "undefined") return null;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readHardwareConcurrency(): number | null {
  if (typeof navigator === "undefined") return null;
  const value = navigator.hardwareConcurrency;
  return typeof value === "number" && value > 0 ? value : null;
}

function readMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const hints = (
    navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  ).userAgentData;
  if (typeof hints?.mobile === "boolean") return hints.mobile;
  // iPadOS reports itself as a Mac, which is exactly the machine this is meant
  // to catch — but it is also the string a real Mac sends, so the touch count
  // is what separates them.
  const agent = navigator.userAgent ?? "";
  if (/android|iphone|ipod|iemobile|opera mini/i.test(agent)) return true;
  return /ipad/i.test(agent) || (/macintosh/i.test(agent) && navigator.maxTouchPoints > 1);
}
