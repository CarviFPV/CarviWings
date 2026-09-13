/**
 * Artificial horizon, drawn the way a goggle OSD draws one.
 *
 * Not a numbered pitch ladder: a character generator has no room for one and
 * no pilot reads it. What it draws instead is three things — a short row of
 * dots that tilts with the bank and slides with the pitch, and two fixed
 * dotted columns either side of it with an arrowhead each pointing inward at
 * the middle of the picture. The dots are the horizon, the columns are the
 * frame you read them against, and between them they tell you the same two
 * things a ladder would while covering almost none of the camera view.
 *
 * The scale is symbolic rather than conformal — pixels per degree tuned to be
 * readable, not matched to the camera's field of view — which is how on-screen
 * displays actually present attitude.
 */

import { DEG_TO_RAD } from "@/sim/math/scalar";
import { HUD_COLORS, outlinedFill, outlinedStroke } from "./palette";

export interface HorizonOptions {
  /** Vertical pixels per degree of pitch. */
  readonly pixelsPerDegree: number;
  /** Half-width of the row of dots the horizon is drawn as, in pixels. */
  readonly lineHalfWidth: number;
  /** True while the wing is stalled, which recolours the instrument. */
  readonly stalled: boolean;
}

/** Dots the horizon line is built from. Odd, so one sits on the centreline. */
const ATTITUDE_DOTS = 9;
const DOT_RADIUS = 2.6;

/** Marks down each sidebar above the arrowhead, and again below it. */
const SIDEBAR_MARKS = 8;

export function drawHorizon(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pitchDeg: number,
  rollDeg: number,
  options: HorizonOptions,
): void {
  const centreX = width / 2;
  const centreY = height / 2;
  const colour = options.stalled ? HUD_COLORS.danger : HUD_COLORS.primary;

  // How far out the columns stand, and how far up and down they run. Both are
  // a proportion of the picture with a ceiling on them, so the instrument sits
  // in the middle of a goggle-shaped view and does not sprawl across a
  // desktop-shaped one.
  const sidebarX = Math.min(width * 0.145, 220);
  const sidebarHalfHeight = Math.min(height * 0.2, 210);

  drawSidebar(ctx, centreX - sidebarX, centreY, sidebarHalfHeight, 1, colour);
  drawSidebar(ctx, centreX + sidebarX, centreY, sidebarHalfHeight, -1, colour);

  drawAttitudeLine(ctx, centreX, centreY, sidebarX, sidebarHalfHeight, pitchDeg, rollDeg, options, colour);
}

/**
 * The horizon itself: a row of dots, banked and pitched.
 *
 * Clipped to the box the sidebars enclose, so a steep attitude slides the line
 * out of the frame rather than smearing dots across the readouts pinned to the
 * edges of the picture.
 */
function drawAttitudeLine(
  ctx: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  sidebarX: number,
  sidebarHalfHeight: number,
  pitchDeg: number,
  rollDeg: number,
  options: HorizonOptions,
  colour: string,
): void {
  ctx.save();

  const clipHalfWidth = sidebarX - 14;
  const clipHalfHeight = sidebarHalfHeight;
  ctx.beginPath();
  ctx.rect(
    centreX - clipHalfWidth,
    centreY - clipHalfHeight,
    clipHalfWidth * 2,
    clipHalfHeight * 2,
  );
  ctx.clip();

  ctx.translate(centreX, centreY);
  // Banking right rolls the world the other way, so the line counter-rotates.
  ctx.rotate(-rollDeg * DEG_TO_RAD);
  // Nose up puts the horizon below the middle of the picture.
  ctx.translate(0, pitchDeg * options.pixelsPerDegree);

  const half = Math.min(options.lineHalfWidth, clipHalfWidth * 0.82);
  const step = (half * 2) / (ATTITUDE_DOTS - 1);
  for (let i = 0; i < ATTITUDE_DOTS; i += 1) {
    ctx.beginPath();
    ctx.arc(-half + i * step, 0, DOT_RADIUS, 0, Math.PI * 2);
    outlinedFill(ctx, colour);
  }

  ctx.restore();
}

/**
 * One fixed column, with the arrowhead that points back at the centre.
 *
 * `direction` is +1 for the column on the left of the picture, whose arrow
 * points right, and -1 for the one on the right. The marks alternate between a
 * short bar and a dot the whole way down, which is what a character generator
 * gets out of two glyphs repeated and what makes the column read as a scale
 * rather than as a dotted line.
 */
function drawSidebar(
  ctx: CanvasRenderingContext2D,
  x: number,
  centreY: number,
  halfHeight: number,
  direction: 1 | -1,
  colour: string,
): void {
  const spacing = halfHeight / SIDEBAR_MARKS;
  const barHalfWidth = 5;

  for (let i = 1; i <= SIDEBAR_MARKS; i += 1) {
    for (const sign of [-1, 1]) {
      const y = centreY + sign * i * spacing;
      if (i % 2 === 1) {
        ctx.beginPath();
        ctx.moveTo(x - barHalfWidth, y);
        ctx.lineTo(x + barHalfWidth, y);
        outlinedStroke(ctx, colour, 2);
      } else {
        ctx.beginPath();
        ctx.rect(x - 1.6, y - 1.6, 3.2, 3.2);
        outlinedFill(ctx, colour);
      }
    }
  }

  // The arrowhead: an open chevron, the way the glyph is drawn.
  const tip = x + direction * 9;
  const back = x - direction * 5;
  ctx.beginPath();
  ctx.moveTo(back, centreY - 11);
  ctx.lineTo(tip, centreY);
  ctx.lineTo(back, centreY + 11);
  ctx.lineJoin = "miter";
  outlinedStroke(ctx, colour, 3.4);
}
