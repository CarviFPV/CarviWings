"use client";

/**
 * A picture of the aircraft, in the colours it is painted in.
 *
 * The projection and the shading are `sim/render/aircraftPreview`, which knows
 * nothing about React or a canvas; this is the fifty lines that put the
 * triangles it returns onto one, follow the element's size, and let the wing be
 * turned round with the pointer.
 *
 * Redrawn only when something about the picture changes — the paint, the
 * angle, the size of the box. There is no animation loop: a menu that ran one
 * would spin a wing at sixty frames a second behind every screen it appears
 * on, and the flight is what the frames are for.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { Livery } from "@/sim/flight/livery";
import type { MeshKind } from "@/sim/render/aircraftMesh";
import { MESH_KIND } from "@/sim/render/aircraftMesh";
import {
  DEFAULT_PREVIEW_AZIMUTH,
  DEFAULT_PREVIEW_ELEVATION,
  previewImage,
} from "@/sim/render/aircraftPreview";

/** How far the wing turns per pixel dragged, degrees. */
const DRAG_DEGREES = 0.45;
/** Kept off the poles, where the picture would flip over. */
const MAX_ELEVATION = 82;

export function AircraftPreview({
  livery,
  kind = MESH_KIND.Wing,
  height = 200,
  interactive = true,
  className = "",
}: {
  livery: Livery;
  /** Which airframe to draw. The wing, unless it says otherwise. */
  kind?: MeshKind;
  /** Height of the picture in pixels; the width is whatever it is given. */
  height?: number;
  /** Lets the aircraft be turned round with the pointer. */
  interactive?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height });
  const [azimuth, setAzimuth] = useState(DEFAULT_PREVIEW_AZIMUTH);
  const [elevation, setElevation] = useState(DEFAULT_PREVIEW_ELEVATION);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // The width comes from the layout rather than from a prop: these sit in
  // columns that decide their own width, and a picture that had to be told how
  // wide it is would be wrong on every screen but the one it was sized for.
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return;
    const measure = (): void =>
      setSize({ width: parent.clientWidth, height });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    // Always at least twice the size it is shown at, whatever the panel is:
    // the rasteriser writes whole pixels, and the browser scaling the picture
    // back down is what smooths the long thin edges an airframe is made of.
    const ratio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const width = Math.round(size.width * ratio);
    const height = Math.round(size.height * ratio);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const picture = previewImage({
      azimuthDeg: azimuth,
      elevationDeg: elevation,
      width,
      height,
      padding: 0.06,
      livery,
      kind,
    });
    const image = context.createImageData(picture.width, picture.height);
    image.data.set(picture.pixels);
    context.putImageData(image, 0, 0);
  }, [azimuth, elevation, kind, livery, size.width, size.height]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      drag.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [interactive],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const from = drag.current;
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      drag.current = { x: event.clientX, y: event.clientY };
      // Negated so the wing follows the pointer rather than running away from
      // it: the camera goes the other way round the aircraft from the drag.
      setAzimuth((value) => value - dx * DRAG_DEGREES);
      setElevation((value) =>
        Math.max(
          -MAX_ELEVATION,
          Math.min(MAX_ELEVATION, value + dy * DRAG_DEGREES),
        ),
      );
    },
    [],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!drag.current) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  return (
    <div className={`relative w-full ${className}`} style={{ height }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          setAzimuth(DEFAULT_PREVIEW_AZIMUTH);
          setElevation(DEFAULT_PREVIEW_ELEVATION);
        }}
        className={`block h-full w-full ${
          interactive ? "cursor-grab touch-none active:cursor-grabbing" : ""
        }`}
      />
    </div>
  );
}
