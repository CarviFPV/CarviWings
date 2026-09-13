/**
 * Target indicator.
 *
 * Two states, both driven by the same tracking data:
 *
 *  - the target is in view — corner brackets track it in screen space, sized by
 *    range so a distant contact does not look like a near one
 *  - the target is outside the field of view — an arrow pinned to the edge of
 *    the screen points at its true bearing, with range and bearing alongside
 */

import type { HudTargetView } from "@/lib/cesium/flightSession";
import {
  HUD_COLORS,
  HUD_FONT,
  HUD_FONT_SMALL,
  outlinedStroke,
  outlinedText,
} from "./palette";

export function formatRange(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`;
}

/** Below this the contact is lost in the weather and the HUD says so. */
const NO_VISUAL_THRESHOLD = 0.06;

/**
 * "2/5" while there is more than one contact to choose between, and nothing
 * at all while there is only one.
 *
 * Cycling to a contact that is behind the wing, or lost in the weather, moves
 * nothing a pilot can see: without this the cycle key reads as a key that does
 * not work. With it, every press visibly steps the count, so picking which
 * contact to run down is something that can be done while flying rather than
 * only guessed at.
 */
function selectionLabel(view: HudTargetView): string {
  if (view.count < 2 || view.index < 1) return "";
  return `${view.index}/${view.count}`;
}

export function drawTargetIndicator(
  ctx: CanvasRenderingContext2D,
  view: HudTargetView,
): void {
  if (!view.active) return;
  ctx.save();
  // Weather dims the indicator with the contact rather than hiding it: the
  // bearing is still worth something even when you cannot see the aircraft.
  ctx.globalAlpha = 0.3 + 0.7 * view.visibility;
  if (view.onScreen) drawTrackingBox(ctx, view);
  else drawEdgeArrow(ctx, view);
  ctx.restore();
}

function drawTrackingBox(
  ctx: CanvasRenderingContext2D,
  view: HudTargetView,
): void {
  // Shrink the brackets with range, floored so they never vanish.
  const size = Math.max(14, Math.min(52, 5200 / Math.max(view.distance, 60)));
  const arm = size * 0.34;
  const x = view.screenX;
  const y = view.screenY;

  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const cx = x + sx * size;
    const cy = y + sy * size;
    ctx.moveTo(cx, cy - sy * arm);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx - sx * arm, cy);
  }
  outlinedStroke(ctx, HUD_COLORS.amber, 1.6);

  ctx.font = HUD_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  outlinedText(ctx, formatRange(view.distance), x, y + size + 6, HUD_COLORS.amber);

  let below = y + size + 20;
  ctx.font = HUD_FONT_SMALL;
  if (view.visibility < NO_VISUAL_THRESHOLD) {
    outlinedText(ctx, "NO VISUAL", x, below, HUD_COLORS.dim);
    below += 13;
  }
  const selection = selectionLabel(view);
  if (selection) outlinedText(ctx, selection, x, below, HUD_COLORS.dim);
  ctx.restore();
}

function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  view: HudTargetView,
): void {
  const x = view.edgeX;
  const y = view.edgeY;
  const angle = Math.atan2(view.dirY, view.dirX);

  ctx.save();
  ctx.translate(x, y);

  ctx.save();
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-6, -9);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-6, 9);
  ctx.closePath();
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = HUD_COLORS.shadow;
  ctx.stroke();
  ctx.fillStyle = HUD_COLORS.amber;
  ctx.fill();
  ctx.restore();

  // Push the label well inboard of the arrow and give it a plate, so it never
  // lands on top of the airspeed or altitude columns.
  const labelX = -view.dirX * 46;
  const labelY = -view.dirY * 46;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.beginPath();
  ctx.rect(labelX - 34, labelY - 22, 68, 44);
  ctx.fillStyle = HUD_COLORS.panel;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 176, 32, 0.35)";
  ctx.stroke();

  ctx.font = HUD_FONT_SMALL;
  outlinedText(
    ctx,
    view.visibility < NO_VISUAL_THRESHOLD ? "NO VISUAL" : "TARGET",
    labelX,
    labelY - 13,
    view.visibility < NO_VISUAL_THRESHOLD ? HUD_COLORS.dim : HUD_COLORS.amber,
  );
  ctx.font = HUD_FONT;
  outlinedText(ctx, formatRange(view.distance), labelX, labelY, HUD_COLORS.primary);
  ctx.font = HUD_FONT_SMALL;
  // The selection shares the bearing line: it is the only one of the three
  // with room left on the plate, and the two belong together anyway — which
  // contact this is, and which way it lies.
  const bearing = `${Math.round(view.bearingDeg).toString().padStart(3, "0")}°`;
  const selection = selectionLabel(view);
  outlinedText(
    ctx,
    selection ? `${bearing} ${selection}` : bearing,
    labelX,
    labelY + 13,
    HUD_COLORS.dim,
  );

  ctx.restore();
}
