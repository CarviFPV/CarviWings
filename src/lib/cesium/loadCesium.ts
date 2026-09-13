"use client";

/**
 * CesiumJS entry point.
 *
 * Cesium is loaded from its own prebuilt browser bundle at `/cesium/Cesium.js`
 * rather than being imported through the application bundler. Two reasons:
 *
 *  1. Correctness. Cesium embeds several megabytes of binary payloads (Draco,
 *     Basis, meshopt) as escaped string literals. Re-minifying them corrupts
 *     the escapes — Turbopack writes a raw NUL as `\0` followed by a literal
 *     `0`, which re-parses as an illegal octal escape and kills the chunk.
 *     Cesium's own bundle is already minified and known-good.
 *  2. Isolation. Nothing about Cesium can end up in a server render, because
 *     the library only exists once a `<script>` has run in a browser.
 *
 * Types still come from the `cesium` package: the `import type` below is erased
 * at compile time, so the whole application stays fully typed against the exact
 * installed version without shipping it through the bundler.
 */

import type * as CesiumNamespace from "cesium";

export type CesiumModule = typeof CesiumNamespace;

/** Where `scripts/copy-cesium.mjs` stages Cesium's runtime assets. */
export const CESIUM_BASE_URL = "/cesium";

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
    Cesium?: CesiumModule;
  }
}

let pending: Promise<CesiumModule> | null = null;

function loadStylesheet(): Promise<void> {
  return new Promise((resolve) => {
    const href = `${CESIUM_BASE_URL}/Widgets/widgets.css`;
    if (document.querySelector(`link[href="${href}"]`)) {
      resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    // Cesium's widget CSS is not load-bearing for the simulator's own chrome,
    // so a failure here must not block the flight.
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = `${CESIUM_BASE_URL}/Cesium.js`;
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      if (window.Cesium) resolve();
      else {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () =>
          reject(new Error("CesiumJS failed to load")),
        );
      }
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          `CesiumJS could not be loaded from ${src}. Run \`npm run build\` or \`npm run dev\` so scripts/copy-cesium.mjs stages it into public/cesium.`,
        ),
      );
    document.head.appendChild(script);
  });
}

export function loadCesium(): Promise<CesiumModule> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("CesiumJS is browser-only and cannot be loaded during SSR."),
    );
  }
  if (!pending) {
    // Must be set before the bundle evaluates: Cesium reads it to locate its
    // Workers, Assets and Widgets.
    window.CESIUM_BASE_URL = CESIUM_BASE_URL;
    pending = Promise.all([loadStylesheet(), loadScript()])
      .then(() => {
        const cesium = window.Cesium;
        if (!cesium) {
          throw new Error(
            "CesiumJS loaded but did not register itself on window.Cesium.",
          );
        }
        return cesium;
      })
      .catch((error: unknown) => {
        // Allow a later attempt to retry rather than caching the failure.
        pending = null;
        throw error;
      });
  }
  return pending;
}
