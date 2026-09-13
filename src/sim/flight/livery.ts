/**
 * How an aircraft is painted.
 *
 * There are a handful of meshes and a growing hangar of airframes flown on
 * them, so the colour cannot live in the geometry: two pilots with the same
 * wing should be able to tell theirs apart in a festival slot, and a pilot who
 * has built two of them should be able to tell those apart too. A livery is
 * therefore part of how an aircraft is set up — stored beside the rates and the
 * hardware, saved into a build, and laid back over the workbench with it.
 *
 * Two colours rather than a paint scheme: the shell, which is most of what is
 * seen, and the accent the marker tape and the winglets carry. That is what the
 * airframe this mesh was drawn from actually has, and it is the pair a pilot
 * covering a wing in tape is really choosing between.
 *
 * Colours are stored as `#rrggbb` because that is what a browser colour picker
 * hands back and what a person reads a colour as. The renderer wants them in
 * 0..1, which is what `rgbOf` is for.
 */

/** The two colours an airframe is painted in. */
export interface Livery {
  /** The shell: the wing above and below, and the pod under it. */
  readonly shell: string;
  /** The marker tape across the wing roots, and the winglets. */
  readonly accent: string;
}

/**
 * The colours the mesh is modelled in.
 *
 * These are the airframe as photographed — dark grey shell, orange tape — and
 * `partColor` reproduces the delivered part colours from them, which
 * `render.test.ts` holds it to.
 */
export const DEFAULT_LIVERY: Livery = { shell: "#303338", accent: "#ff6b0d" };

/** A named scheme, offered so a livery is one click rather than two pickers. */
export interface LiveryPreset {
  readonly id: string;
  readonly label: string;
  readonly livery: Livery;
}

/**
 * The schemes on offer.
 *
 * Chosen to be told apart from each other at a kilometre and from the
 * interceptor red and transit olive the AI is drawn in — the point of painting
 * an aircraft is knowing which one is yours.
 */
export const LIVERY_PRESETS: readonly LiveryPreset[] = [
  { id: "factory", label: "Factory", livery: DEFAULT_LIVERY },
  { id: "survey", label: "Survey", livery: { shell: "#e6e6e1", accent: "#ff6b0d" } },
  { id: "night", label: "Night", livery: { shell: "#14161a", accent: "#37d3e8" } },
  { id: "racer", label: "Racer", livery: { shell: "#1b4f9c", accent: "#f2d024" } },
  { id: "desert", label: "Desert", livery: { shell: "#b79a63", accent: "#3f4a2e" } },
  { id: "hi-vis", label: "Hi-vis", livery: { shell: "#f25c05", accent: "#f2f2f2" } },
  { id: "forest", label: "Forest", livery: { shell: "#2d4432", accent: "#9fd14f" } },
  { id: "carbon", label: "Carbon", livery: { shell: "#242629", accent: "#8f9399" } },
];

const HEX_COLOUR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A colour as it will actually be stored, or null when it is not one.
 *
 * Three-digit hex is accepted because a person typing one means it; anything
 * else — a colour name, an `rgb()`, a truncated paste — is not a colour this
 * can hand to the renderer and is refused rather than guessed at.
 */
export function normaliseColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = HEX_COLOUR.exec(raw.trim());
  if (!match) return null;
  const digits = (match[1] ?? "").toLowerCase();
  if (digits.length === 3) {
    return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
  }
  return `#${digits}`;
}

/** A stored colour in the 0..1 triple the renderer draws with. */
export function rgbOf(color: string): readonly [number, number, number] {
  const hex = normaliseColor(color) ?? DEFAULT_LIVERY.shell;
  const value = Number.parseInt(hex.slice(1), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}

/** The inverse: a 0..1 triple written the way a colour picker reads it. */
export function hexOf(rgb: readonly [number, number, number]): string {
  const channel = (value: number): string => {
    const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
    return byte.toString(16).padStart(2, "0");
  };
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** True when two liveries would paint the same aircraft. */
export function sameLivery(a: Livery, b: Livery): boolean {
  return a.shell === b.shell && a.accent === b.accent;
}

/**
 * Repairs a livery loaded from storage.
 *
 * A colour that cannot be read falls back to the one the airframe is delivered
 * in rather than to black: a stored value nobody can parse is a setting that
 * was never made, and an aircraft nobody can see is worse than an unpainted
 * one.
 */
export function normaliseLivery(
  raw: unknown,
  fallback: Livery = DEFAULT_LIVERY,
): Livery {
  const value = (raw ?? {}) as Partial<Record<keyof Livery, unknown>>;
  return {
    shell: normaliseColor(value.shell) ?? fallback.shell,
    accent: normaliseColor(value.accent) ?? fallback.accent,
  };
}
