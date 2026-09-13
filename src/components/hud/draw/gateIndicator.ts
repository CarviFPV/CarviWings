/**
 * Next-gate indicator.
 *
 * A race is flown by looking at one gate at a time, and the gate itself is a
 * thin frame that disappears against a mountainside from half a kilometre out.
 * So the HUD draws a square around where it is, sized by range the way the
 * target box is: it reads as "the gate is over there and it is this far" at a
 * glance, without anything to interpret.
 *
 * Behind you it becomes an arrow on the rim — the same language the target and
 * the formation slot use, because it is the same question.
 */

import type { HudGateView } from "@/lib/cesium/flightSession";
import {
  HUD_COLORS,
  HUD_FONT,
  HUD_FONT_SMALL,
  outlinedStroke,
  outlinedText,
} from "./palette";
import { formatRange } from "./targetIndicator";

/** Range at which the marker is drawn at its largest, metres. */
const NEAR_RANGE = 120;

export function drawGateIndicator(
  ctx: CanvasRenderingContext2D,
  view: HudGateView,
): void {
  if (!view.active) return;
  ctx.save();
  if (view.onScreen) drawFrame(ctx, view);
  else drawEdgeArrow(ctx, view);
  ctx.restore();
}

function colourFor(view: HudGateView): string {
  return view.isFinish ? HUD_COLORS.amber : HUD_COLORS.cyan;
}

function drawFrame(ctx: CanvasRenderingContext2D, view: HudGateView): void {
  // Grows as the gate is approached, floored so a distant one is still a mark
  // rather than a pixel, capped so the last hundred metres do not fill the
  // screen with a box the pilot is trying to see through.
  const size = Math.max(16, Math.min(96, (NEAR_RANGE * 34) / Math.max(view.distance, 40)));
  const colour = colourFor(view);
  const x = view.screenX;
  const y = view.screenY;

  ctx.save();
  ctx.setLineDash([]);

  // Corner brackets rather than a closed square: the middle of a gate is
  // exactly where the pilot needs to be looking.
  const arm = size * 0.36;
  ctx.beginPath();
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const cx = x + sx * size;
    const cy = y + sy * size;
    ctx.moveTo(cx - sx * arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy - sy * arm);
  }
  outlinedStroke(ctx, colour, view.isFinish ? 2 : 1.5);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = HUD_FONT_SMALL;
  outlinedText(
    ctx,
    view.isFinish ? "FINISH" : `GATE ${view.number}/${view.count}`,
    x,
    y + size + 7,
    colour,
  );
  ctx.font = HUD_FONT;
  outlinedText(
    ctx,
    formatRange(view.distance),
    x,
    y + size + 19,
    HUD_COLORS.primary,
  );
  ctx.restore();
}

function drawEdgeArrow(ctx: CanvasRenderingContext2D, view: HudGateView): void {
  const colour = colourFor(view);
  ctx.save();
  ctx.translate(view.edgeX, view.edgeY);

  ctx.save();
  ctx.rotate(Math.atan2(view.dirY, view.dirX));
  ctx.beginPath();
  ctx.moveTo(15, 0);
  ctx.lineTo(-6, -9);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-6, 9);
  ctx.closePath();
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = HUD_COLORS.shadow;
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.restore();

  const labelX = -view.dirX * 42;
  const labelY = -view.dirY * 42;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = HUD_FONT_SMALL;
  outlinedText(
    ctx,
    view.isFinish ? "FINISH" : `GATE ${view.number}`,
    labelX,
    labelY - 7,
    colour,
  );
  ctx.font = HUD_FONT;
  outlinedText(
    ctx,
    formatRange(view.distance),
    labelX,
    labelY + 7,
    HUD_COLORS.primary,
  );
  ctx.restore();
}
