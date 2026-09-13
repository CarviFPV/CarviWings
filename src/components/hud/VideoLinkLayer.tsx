"use client";

/**
 * The goggles.
 *
 * Everything the pilot sees arrives down one analogue video channel, so when
 * that channel breaks up it takes the picture *and* the OSD drawn on top of it
 * with it — which is why this sits above both the Cesium view and the
 * instrument layers rather than beside them. It stays below the pause menu and
 * the airframe-lost card: those are the game talking, not the aircraft.
 *
 * All of which is true only of the picture that actually comes down the link.
 * Watched from the field or from a chase camera the pilot is looking at the
 * aircraft rather than at a screen fed from it, and there is nothing between
 * them and it to break up — so nothing is drawn.
 *
 * Like the rest of the HUD it runs on its own animation frame and never
 * touches React state; the link is read straight off the session at display
 * rate, because a signal that only updated ten times a second would flicker
 * like a strobe rather than like static.
 */

import { useEffect, useRef } from "react";

import type { FlightSession } from "@/lib/cesium/flightSession";
import { CAMERA_MODE } from "@/lib/cesium/cameraRig";
import { videoNoiseFrame } from "@/sim/hud/videoNoise";
import {
  createVideoStaticBuffer,
  drawVideoStatic,
} from "./draw/videoStatic";

export function VideoLinkLayer({ session }: { session: FlightSession }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const buffer = createVideoStaticBuffer();
    if (!buffer) return;

    let frame = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastRatio = 0;

    const draw = (now: number): void => {
      frame = requestAnimationFrame(draw);

      const { width, height } = session.viewportSize;
      if (width === 0 || height === 0) return;

      // Static is speckle, not line art: half resolution is plenty and costs a
      // quarter of the fill on a display that is already drawing the world.
      const ratio = Math.min(window.devicePixelRatio || 1, 1);
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

      // Read at display rate rather than passed in: a camera change has to
      // take the static with it on the frame it happens, not a tenth of a
      // second later when the HUD next polls.
      if (session.cameraMode !== CAMERA_MODE.Fpv) return;

      const link = session.videoLink;
      if (!link) return;

      drawVideoStatic(
        ctx,
        width,
        height,
        videoNoiseFrame(link.quality, now / 1000),
        buffer,
      );
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [session]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[25]"
    />
  );
}
