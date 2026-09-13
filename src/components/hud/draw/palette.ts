/**
 * Shared colours for the canvas instruments, matching the CSS OSD theme.
 *
 * A goggle OSD is a character generator over the camera picture, so the glyphs
 * are plain white with a black outline round every one of them, and the only
 * other colours are the green the attitude and heading marks are drawn in and
 * the red reserved for things that have gone wrong.
 */
export const HUD_COLORS = {
  primary: "rgba(255, 255, 255, 0.98)",
  dim: "rgba(255, 255, 255, 0.7)",
  faint: "rgba(255, 255, 255, 0.4)",
  /** The mark colour: compass ticks, the reticle, the attitude line. */
  green: "rgba(60, 229, 60, 0.95)",
  cyan: "rgba(55, 211, 232, 0.95)",
  amber: "rgba(255, 176, 32, 0.95)",
  danger: "rgba(255, 77, 77, 0.95)",
  shadow: "rgba(0, 0, 0, 0.9)",
  panel: "rgba(4, 6, 10, 0.72)",
} as const;

/** Kept in step with `--font-osd`; see `globals.css`. */
const OSD_FACE = 'Consolas, ui-monospace, "SF Mono", Menlo, monospace';

export const HUD_FONT = `bold 13px ${OSD_FACE}`;
export const HUD_FONT_SMALL = `bold 11px ${OSD_FACE}`;

/**
 * Draws a stroked-then-filled glyph so instrument lines stay legible over
 * snow, water or bare rock without a background plate behind them.
 */
export function outlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = HUD_COLORS.shadow;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Strokes the current path twice: a dark halo first, then the line itself. */
export function outlinedStroke(
  ctx: CanvasRenderingContext2D,
  color: string,
  width = 1.4,
): void {
  ctx.lineWidth = width + 2.6;
  ctx.strokeStyle = HUD_COLORS.shadow;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/**
 * Fills the current path over its own dark outline.
 *
 * The same idea as `outlinedStroke` for the solid marks — the dots the
 * attitude line is drawn from, the arrowheads on the sidebars — which are read
 * as shapes rather than as lines and would disappear into bright ground
 * without something dark round the edge of them.
 */
export function outlinedFill(
  ctx: CanvasRenderingContext2D,
  color: string,
  outline = 2.4,
): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = outline;
  ctx.strokeStyle = HUD_COLORS.shadow;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
}
