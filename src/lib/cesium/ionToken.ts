/**
 * Cesium ion access token handling.
 *
 * Two ways in. `NEXT_PUBLIC_CESIUM_ION_TOKEN` is inlined into the client bundle
 * at build time, which is what a developer running the simulator from a
 * checkout uses; a token typed into the application is kept in this browser and
 * takes effect immediately, which is what everybody who did not build it uses.
 * `resolveIonToken` decides between them and the typed one wins.
 *
 * The typed token is pushed in here by the store that owns it rather than read
 * out of storage from here, so that everything under `lib/cesium` — which is
 * loaded inside the Cesium boundary, and by the world map before any screen has
 * mounted — stays free of React and of the store graph.
 *
 * An ion token *is* public client configuration, but it still must not leak
 * into error text or telemetry: nothing here formats the value itself, and the
 * only thing said about it out loud is `describeIonToken`'s length and origin.
 */

import {
  describeIonToken as describeChoice,
  ION_TOKEN_SOURCE,
  normaliseIonToken,
  resolveIonToken,
  type IonTokenSource,
} from "@/sim/config/ionToken";

export { ION_TOKEN_SOURCE, normaliseIonToken };
export type { IonTokenSource };

export const ION_TOKEN_ENV_VAR = "NEXT_PUBLIC_CESIUM_ION_TOKEN";

/** The token this build was compiled with, or `null` when it carries none. */
export function readEnvIonToken(): string | null {
  // Must be a full static member expression so Next can inline it.
  const raw = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The token typed into the application, as the store last had it. */
let entered: string | null = null;

/**
 * Hands the typed token to everything that streams the world.
 *
 * Called by `ionTokenStore` on load and on every change, which is the only
 * place that knows what a pilot has typed or cleared.
 */
export function setEnteredIonToken(raw: string | null): void {
  const clean = normaliseIonToken(raw ?? "");
  entered = clean.length > 0 ? clean : null;
}

/** Returns the token to stream on, or `null` when there is none to use. */
export function readIonToken(): string | null {
  return resolveIonToken(entered, readEnvIonToken()).token;
}

/**
 * A non-identifying fingerprint for the debug overlay, so a developer can tell
 * *which* token is loaded without the value ever being displayed.
 */
export function describeIonToken(): string {
  return describeChoice(resolveIonToken(entered, readEnvIonToken()));
}
