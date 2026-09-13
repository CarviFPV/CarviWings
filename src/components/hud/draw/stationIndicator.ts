/**
 * Formation slot indicator.
 *
 * Draws the piece of sky the aircraft is supposed to be in. Unlike the target
 * box, which follows something you can see, this marks an empty point — so it
 * is drawn as a ring that closes as the slot is taken and opens as it is lost,
 * which reads at a glance while the leader is manoeuvring and there is no time
 * to look at a number.
 *
 * Off screen it becomes an arrow on the rim: the slot is behind you, and the
 * fastest way back into it is knowing which way to look.
 */

import type { HudStationView } from "@/lib/cesium/flightSession";
import {
  HUD_COLORS,
  HUD_FONT,
  HUD_FONT_SMALL,
  outlinedStroke,
  outlinedText,
} from "./palette";
import { formatRange } from "./targetIndicator";

/** Radius of the ring when the slot is dead ahead, pixels. */
const BASE_RADIUS = 26;
/** Error at which the ring is drawn at its widest, metres. */
const WIDE_ERROR = 140;

export function drawStationIndicator(
  ctx: CanvasRenderingContext2D,
  view: HudStationView,
): void {
  if (!view.active) return;
  ctx.save();
  if (view.onScreen) drawRing(ctx, view);
  else drawEdgeArrow(ctx, view);
  ctx.restore();
}

function drawRing(ctx: CanvasRenderingContext2D, view: HudStationView): void {
  const openness = Math.min(view.error / WIDE_ERROR, 1);
  const radius = BASE_RADIUS * (0.55 + openness);
  const colour = view.inStation ? HUD_COLORS.cyan : HUD_COLORS.primary;
  const x = view.screenX;
  const y = view.screenY;

  ctx.save();
  // Four arcs with gaps rather than a closed circle: the gaps close as the
  // slot is taken, so the marker reads as "nearly there" without a readout.
  const gap = 0.16 + 0.32 * openness;
  ctx.beginPath();
  for (let i = 0; i < 4; i += 1) {
    const start = (i * Math.PI) / 2 + gap;
    ctx.arc(x, y, radius, start, start + Math.PI / 2 - gap * 2);
    ctx.moveTo(x + radius, y);
  }
  outlinedStroke(ctx, colour, view.inStation ? 2 : 1.4);

  // A pip in the middle so the exact point is unambiguous when it is close.
  ctx.beginPath();
  ctx.moveTo(x - 4, y);
  ctx.lineTo(x + 4, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  outlinedStroke(ctx, colour, 1.2);

  ctx.font = view.inStation ? HUD_FONT_SMALL : HUD_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  outlinedText(
    ctx,
    view.inStation ? "IN STATION" : formatRange(view.error),
    x,
    y + radius + 7,
    colour,
  );
  ctx.restore();
}

function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  view: HudStationView,
): void {
  ctx.save();
  ctx.translate(view.edgeX, view.edgeY);

  ctx.save();
  ctx.rotate(Math.atan2(view.dirY, view.dirX));
  ctx.beginPath();
  ctx.moveTo(13, 0);
  ctx.lineTo(-5, -8);
  ctx.lineTo(-5, 8);
  ctx.closePath();
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = HUD_COLORS.shadow;
  ctx.stroke();
  ctx.fillStyle = HUD_COLORS.cyan;
  ctx.fill();
  ctx.restore();

  const labelX = -view.dirX * 40;
  const labelY = -view.dirY * 40;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = HUD_FONT_SMALL;
  outlinedText(ctx, "SLOT", labelX, labelY - 7, HUD_COLORS.cyan);
  ctx.font = HUD_FONT;
  outlinedText(ctx, formatRange(view.error), labelX, labelY + 7, HUD_COLORS.primary);

  ctx.restore();
}
