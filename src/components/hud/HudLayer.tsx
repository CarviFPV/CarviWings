"use client";

/**
 * The canvas instrument layer.
 *
 * Artificial horizon, target indicator and minimap all share one full-viewport
 * canvas and one animation frame. They have to move at display rate to read as
 * instruments rather than as a stuttering overlay, which rules out React state
 * — nothing here triggers a render. The numeric OSD is the opposite case and
 * stays in the DOM, where it is easier to style and slow enough not to matter.
 */

import { useEffect, useRef } from "react";

import type { FlightSession } from "@/lib/cesium/flightSession";
import { toHeadingPitchRoll } from "@/sim/math/quat";
import type { MinimapOrientation } from "@/sim/hud/minimapProjection";
import type { OsdLayout } from "@/sim/hud/osdLayout";
import {
  OSD_ELEMENT,
  osdAnchorPixels,
  osdPlacement,
} from "@/sim/hud/osdLayout";
import { drawGateIndicator } from "./draw/gateIndicator";
import { drawHorizon } from "./draw/horizon";
import { drawMinimap } from "./draw/minimap";
import { drawStationIndicator } from "./draw/stationIndicator";
import { drawTargetIndicator } from "./draw/targetIndicator";

export interface HudLayerProps {
  session: FlightSession;
  /** Off takes the whole display down, whatever the layout says. */
  showOsd: boolean;
  /** Which instruments the pilot wants, and where the minimap sits. */
  layout: OsdLayout;
  minimapOrientation: MinimapOrientation;
  minimapRangeMetres: number;
}

const MINIMAP_RADIUS = 88;
/** Closest the minimap rim may come to the edge of the picture, in pixels. */
const MINIMAP_MARGIN = 26;

export function HudLayer(props: HudLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read through a ref so toggling an instrument never restarts the loop.
  const optionsRef = useRef(props);
  optionsRef.current = props;

  const session = props.session;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let frame = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastRatio = 0;

    const draw = (): void => {
      frame = requestAnimationFrame(draw);

      const { width, height } = session.viewportSize;
      if (width === 0 || height === 0) return;

      // Cap the backing store at 2x: beyond that the extra fill costs more
      // than the sharpness is worth for line art.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (width !== lastWidth || height !== lastHeight || ratio !== lastRatio) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        lastWidth = width;
        lastHeight = height;
        lastRatio = ratio;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const player = session.playerState;
      if (!player) return;
      const options = optionsRef.current;
      if (!options.showOsd) return;
      const layout = options.layout;

      if (osdPlacement(layout, OSD_ELEMENT.Horizon).enabled) {
        const angles = toHeadingPitchRoll(player.orientation);
        drawHorizon(ctx, width, height, angles.pitchDeg, angles.rollDeg, {
          pixelsPerDegree: Math.min(height * 0.008, 8),
          lineHalfWidth: Math.min(width * 0.08, 120),
          stalled: player.stalled,
        });
      }

      if (osdPlacement(layout, OSD_ELEMENT.TargetIndicator).enabled) {
        drawTargetIndicator(ctx, session.targetView());
        // Only ever non-empty on a formation flight, where the slot is the
        // thing being flown and the leader is only how you find it.
        drawStationIndicator(ctx, session.stationView());
        // Only ever active on a race, where the gate is the only thing worth
        // looking at and the aircraft around you are scenery.
        drawGateIndicator(ctx, session.gateView());
      }

      const minimap = osdPlacement(layout, OSD_ELEMENT.Minimap);
      if (minimap.enabled) {
        // The layout puts the map's centre anywhere on the grid; a circle
        // whose rim would hang off the picture is nudged back on, because a
        // half-drawn map is worse than one a cell away from where it was put.
        const anchor = osdAnchorPixels(minimap, width, height);
        const inset = MINIMAP_RADIUS + MINIMAP_MARGIN;
        drawMinimap(ctx, player, session.simulation.aircraft, {
          centreX: Math.min(Math.max(anchor.x, inset), Math.max(inset, width - inset)),
          centreY: Math.min(Math.max(anchor.y, inset), Math.max(inset, height - inset)),
          radius: MINIMAP_RADIUS,
          rangeMetres: options.minimapRangeMetres,
          orientation: options.minimapOrientation,
          missionRadius: session.simulation.missionRadius,
          targetId: session.simulation.target?.id ?? null,
          gates: session.course?.gates,
          nextGate: session.mission.race?.playerGate ?? 0,
        });
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [session]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10"
    />
  );
}
