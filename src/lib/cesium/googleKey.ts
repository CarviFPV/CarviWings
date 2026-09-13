/**
 * Google Maps Platform key handling.
 *
 * Entirely optional. Google's Photorealistic 3D Tiles are served through Cesium
 * ion on the ion token by default, metered there by root tile; a Maps Platform
 * key routes around ion and bills Google directly instead, which is what a
 * project past ion's free allowance wants. Like the ion token this is public
 * client configuration — it is inlined into the browser bundle — but it must not
 * end up in error text, logs or telemetry, which is what `redactGoogleKey`
 * below is for: Cesium reports failures with the full request URL, and the key
 * is a query parameter on it.
 */

export const GOOGLE_MAPS_KEY_ENV_VAR = "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY";

/** Returns the configured key, or `null` when it is absent or blank. */
export function readGoogleMapsKey(): string | null {
  // Must be a full static member expression so Next can inline it.
  const raw = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function hasGoogleMapsKey(): boolean {
  return readGoogleMapsKey() !== null;
}

/** A non-identifying fingerprint for the debug overlay. */
export function describeGoogleMapsKey(): string {
  const key = readGoogleMapsKey();
  if (!key) return "not configured";
  return `configured (${key.length} chars)`;
}

/**
 * Strips the key out of a string that may have been built from a request URL.
 *
 * Both the literal value and any `key=` query parameter are removed, so a
 * message stays safe to show even if Cesium's wording changes.
 */
export function redactGoogleKey(text: string): string {
  const key = readGoogleMapsKey();
  let safe = key ? text.split(key).join("<redacted>") : text;
  safe = safe.replace(/([?&]key=)[^&\s"']+/gi, "$1<redacted>");
  return safe;
}
