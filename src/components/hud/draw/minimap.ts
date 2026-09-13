/**
 * Minimap.
 *
 * A plain 2D canvas, not a second Cesium globe: it draws the same local ENU
 * metres the flight model runs in, scaled down and centred on the player. That
 * makes it essentially free to render and keeps it exact — the dots are the
 * simulation's own coordinates, not a re-projection of them.
 */

import type { AircraftState } from "@/sim/flight/state";
import { AIRCRAFT_ROLE, isAirworthy } from "@/sim/flight/state";
import { forwardAxis } from "@/sim/math/quat";
import { vec3 } from "@/sim/math/vec3";
import type { RaceGate } from "@/sim/mission/race";
import type { MinimapOrientation } from "@/sim/hud/minimapProjection";
import {
  MINIMAP_ORIENTATION,
  minimapHeadingRotation,
  minimapRangeRings,
  projectToMinimap,
} from "@/sim/hud/minimapProjection";
import {
  HUD_COLORS,
  HUD_FONT_SMALL,
  outlinedStroke,
  outlinedText,
} from "./palette";

export interface MinimapOptions {
  /** Canvas position of the map's centre. */
  readonly centreX: number;
  readonly centreY: number;
  readonly radius: number;
  /** Ground distance from centre to rim, in metres. */
  readonly rangeMetres: number;
  readonly orientation: MinimapOrientation;
  readonly missionRadius: number;
  readonly targetId: string | null;
  /** The race course, when one is being flown. */
  readonly gates?: readonly RaceGate[];
  /** Which gate is next, so the map says where to go rather than where to be. */
  readonly nextGate?: number;
}

const _forward = vec3();
const _point = { x: 0, y: 0 };
const _centre = { x: 0, y: 0 };

function headingOf(state: AircraftState): number {
  forwardAxis(_forward, state.orientation);
  return (Math.atan2(_forward.x, _forward.y) * 180) / Math.PI;
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  player: AircraftState,
  aircraft: readonly AircraftState[],
  options: MinimapOptions,
): void {
  const { centreX, centreY, radius } = options;
  const projection = {
    playerX: player.position.x,
    playerY: player.position.y,
    headingDeg: headingOf(player),
    metresPerPixel: options.rangeMetres / radius,
    orientation: options.orientation,
  };

  ctx.save();
  ctx.translate(centreX, centreY);

  // Dial face.
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = HUD_COLORS.panel;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.clip();

  drawRangeRings(ctx, radius, options.rangeMetres);
  drawMissionArea(ctx, projection, options);
  drawCourse(ctx, projection, options);
  drawContacts(ctx, projection, aircraft, options, radius);

  ctx.restore();

  drawRim(ctx, radius, projection);
  drawPlayer(ctx, projection);
  drawLabels(ctx, radius, options);

  ctx.restore();
}

function drawRangeRings(
  ctx: CanvasRenderingContext2D,
  radius: number,
  rangeMetres: number,
): void {
  ctx.setLineDash([2, 4]);
  for (const ring of minimapRangeRings(rangeMetres)) {
    const pixels = (ring / rangeMetres) * radius;
    ctx.beginPath();
    ctx.arc(0, 0, pixels, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = HUD_COLORS.faint;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** Mission centre and boundary, both drawn in the player's frame. */
function drawMissionArea(
  ctx: CanvasRenderingContext2D,
  projection: Parameters<typeof projectToMinimap>[0],
  options: MinimapOptions,
): void {
  projectToMinimap(projection, 0, 0, _centre);

  const boundaryPixels = options.missionRadius / projection.metresPerPixel;
  ctx.beginPath();
  ctx.arc(_centre.x, _centre.y, boundaryPixels, 0, Math.PI * 2);
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = HUD_COLORS.cyan;
  ctx.globalAlpha = 0.55;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // Mission origin marker.
  ctx.beginPath();
  ctx.moveTo(_centre.x, _centre.y - 4);
  ctx.lineTo(_centre.x + 4, _centre.y);
  ctx.lineTo(_centre.x, _centre.y + 4);
  ctx.lineTo(_centre.x - 4, _centre.y);
  ctx.closePath();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = HUD_COLORS.cyan;
  ctx.stroke();
}

/**
 * The race course.
 *
 * Drawn as the line between the gates rather than as a scatter of marks: what
 * a pilot needs off a map mid-race is which way the course goes next, and a
 * row of dots does not say that.
 */
function drawCourse(
  ctx: CanvasRenderingContext2D,
  projection: Parameters<typeof projectToMinimap>[0],
  options: MinimapOptions,
): void {
  const gates = options.gates;
  if (!gates || gates.length === 0) return;
  const next = options.nextGate ?? 0;

  ctx.save();
  ctx.beginPath();
  gates.forEach((gate, i) => {
    projectToMinimap(projection, gate.position.x, gate.position.y, _point);
    if (i === 0) ctx.moveTo(_point.x, _point.y);
    else ctx.lineTo(_point.x, _point.y);
  });
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = HUD_COLORS.faint;
  ctx.stroke();
  ctx.setLineDash([]);

  gates.forEach((gate, i) => {
    projectToMinimap(projection, gate.position.x, gate.position.y, _point);
    const upcoming = i === next;
    ctx.beginPath();
    ctx.arc(_point.x, _point.y, upcoming ? 3.4 : 2, 0, Math.PI * 2);
    ctx.fillStyle = upcoming
      ? HUD_COLORS.cyan
      : i < next
        ? HUD_COLORS.faint
        : HUD_COLORS.dim;
    ctx.fill();
    if (upcoming) {
      ctx.beginPath();
      ctx.arc(_point.x, _point.y, 6.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = HUD_COLORS.cyan;
      ctx.stroke();
    }
  });
  ctx.restore();
}

function drawContacts(
  ctx: CanvasRenderingContext2D,
  projection: Parameters<typeof projectToMinimap>[0],
  aircraft: readonly AircraftState[],
  options: MinimapOptions,
  radius: number,
): void {
  for (const state of aircraft) {
    if (state.role === AIRCRAFT_ROLE.Player) continue;
    if (!isAirworthy(state.status)) continue;

    projectToMinimap(projection, state.position.x, state.position.y, _point);
    const isTarget = state.id === options.targetId;
    // The formation is not opposition, and colouring it like opposition would
    // be actively misleading on a flight whose whole point is staying near it.
    const friendly = state.role !== AIRCRAFT_ROLE.Enemy;

    // Contacts beyond the rim are pinned to it so their bearing still reads.
    const distance = Math.hypot(_point.x, _point.y);
    let x = _point.x;
    let y = _point.y;
    let clipped = false;
    if (distance > radius - 6) {
      const scale = (radius - 6) / (distance || 1);
      x *= scale;
      y *= scale;
      clipped = true;
    }

    ctx.save();
    ctx.translate(x, y);
    if (!clipped) {
      ctx.rotate(minimapHeadingRotation(projection, headingOf(state)));
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(3.6, 4);
      ctx.lineTo(0, 2);
      ctx.lineTo(-3.6, 4);
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
    }
    ctx.fillStyle = isTarget
      ? HUD_COLORS.amber
      : friendly
        ? HUD_COLORS.cyan
        : HUD_COLORS.danger;
    ctx.fill();
    ctx.restore();

    if (isTarget) {
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = HUD_COLORS.amber;
      ctx.stroke();
    }
  }
}

function drawRim(
  ctx: CanvasRenderingContext2D,
  radius: number,
  projection: Parameters<typeof projectToMinimap>[0],
): void {
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = HUD_COLORS.dim;
  ctx.stroke();

  // North marker: fixed at the top in north-up, orbiting in heading-up.
  const northAngle =
    projection.orientation === MINIMAP_ORIENTATION.NorthUp
      ? 0
      : -projection.headingDeg * (Math.PI / 180);
  const nx = Math.sin(northAngle) * (radius - 9);
  const ny = -Math.cos(northAngle) * (radius - 9);
  ctx.font = HUD_FONT_SMALL;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  outlinedText(ctx, "N", nx, ny, HUD_COLORS.cyan);
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  projection: Parameters<typeof projectToMinimap>[0],
): void {
  ctx.save();
  // The map is centred on the player, so the symbol always sits at the middle.
  ctx.rotate(minimapHeadingRotation(projection, projection.headingDeg));
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(5, 6);
  ctx.lineTo(0, 3.5);
  ctx.lineTo(-5, 6);
  ctx.closePath();
  outlinedStroke(ctx, HUD_COLORS.cyan, 1.2);
  ctx.fillStyle = HUD_COLORS.cyan;
  ctx.fill();
  ctx.restore();
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  radius: number,
  options: MinimapOptions,
): void {
  ctx.font = HUD_FONT_SMALL;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const range =
    options.rangeMetres >= 1000
      ? `${(options.rangeMetres / 1000).toFixed(options.rangeMetres < 10000 ? 1 : 0)} KM`
      : `${Math.round(options.rangeMetres)} M`;
  const mode =
    options.orientation === MINIMAP_ORIENTATION.NorthUp ? "N-UP" : "HDG-UP";
  outlinedText(ctx, `${range} · ${mode}`, 0, radius + 6, HUD_COLORS.dim);
}
