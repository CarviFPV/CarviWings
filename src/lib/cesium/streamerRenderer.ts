"use client";

/**
 * Draws the streamers into the Cesium scene.
 *
 * Strictly a view, like every other renderer here: the streamer field owns
 * where each ribbon is and how much of it is left, and this turns that into
 * polylines and nothing else.
 *
 * One `PolylineCollection` for the whole field and one polyline per ribbon,
 * created the first time a ribbon appears and then only moved, recoloured,
 * shown and hidden. A wave that relaunches fifty aircraft reuses the fifty
 * polylines the last one had.
 *
 * Width is in pixels rather than metres on purpose. A streamer is fifty
 * millimetres of crepe paper: drawn true to size it would be invisible at the
 * range most of the field is flown at, and the whole event is judging where
 * somebody else's paper is from across the strip. So it is drawn as a line
 * that stays readable — the length is real, the thickness is a courtesy.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { Streamer, StreamerField } from "@/sim/mission/streamer";
import { rgbOf } from "@/sim/flight/livery";
import { vec3 } from "@/sim/math/vec3";

/** How thick a ribbon is drawn, pixels. */
const WIDTH = 3;

const _ecef = vec3();

interface Ribbon {
  readonly polyline: Cesium.Polyline;
  /** The Cartesians handed to Cesium, reused between frames. */
  positions: Cesium.Cartesian3[];
  /** What it is currently painted, so a colour is set once and not per frame. */
  color: string;
}

export class StreamerRenderer {
  private readonly cesium: CesiumModule;
  private readonly scene: Cesium.Scene;
  private readonly frame: EnuFrame;
  private readonly collection: Cesium.PolylineCollection;
  private readonly ribbons = new Map<string, Ribbon>();

  constructor(cesium: CesiumModule, scene: Cesium.Scene, frame: EnuFrame) {
    this.cesium = cesium;
    this.scene = scene;
    this.frame = frame;
    this.collection = new cesium.PolylineCollection();
    scene.primitives.add(this.collection);
  }

  /** Puts every ribbon in the field where the field says it is. */
  draw(field: StreamerField): void {
    const seen = new Set<string>();

    for (const streamer of field.streamers) {
      // Two nodes is the least that is a line; a ribbon cut back to the knot
      // is a stub nobody needs to see.
      if (streamer.points.length < 2) continue;
      seen.add(streamer.aircraftId);
      this.drawOne(streamer);
    }

    // Anything that went in, landed, or was cleared away with its wave.
    for (const [id, ribbon] of this.ribbons) {
      if (seen.has(id)) continue;
      if (ribbon.polyline.show) ribbon.polyline.show = false;
    }
  }

  private drawOne(streamer: Streamer): void {
    const ribbon = this.ribbonFor(streamer);
    const points = streamer.points;

    // Grown and shrunk in place: the node count moves by one as the ribbon is
    // walked along and cut, and reallocating the array for that would put a
    // dozen Cartesians a frame per aircraft through the collector.
    const positions = ribbon.positions;
    while (positions.length < points.length) {
      positions.push(new this.cesium.Cartesian3());
    }
    if (positions.length > points.length) positions.length = points.length;

    for (let i = 0; i < points.length; i += 1) {
      this.frame.localToEcef(points[i] as { x: number; y: number; z: number }, _ecef);
      const target = positions[i] as Cesium.Cartesian3;
      target.x = _ecef.x;
      target.y = _ecef.y;
      target.z = _ecef.z;
    }

    ribbon.polyline.positions = positions;
    if (!ribbon.polyline.show) ribbon.polyline.show = true;
  }

  private ribbonFor(streamer: Streamer): Ribbon {
    const existing = this.ribbons.get(streamer.aircraftId);
    if (existing) {
      // A fresh airframe for the same pilot keeps the same colour, but the
      // polyline outlives both, so the paint is checked rather than assumed.
      if (existing.color !== streamer.color) {
        existing.color = streamer.color;
        this.paint(existing.polyline, streamer.color);
      }
      return existing;
    }

    const polyline = this.collection.add({
      positions: [],
      width: WIDTH,
      show: false,
    });
    this.paint(polyline, streamer.color);
    const ribbon: Ribbon = { polyline, positions: [], color: streamer.color };
    this.ribbons.set(streamer.aircraftId, ribbon);
    return ribbon;
  }

  private paint(polyline: Cesium.Polyline, color: string): void {
    const [red, green, blue] = rgbOf(color);
    polyline.material = this.cesium.Material.fromType("Color", {
      color: new this.cesium.Color(red, green, blue, 1),
    });
  }

  destroy(): void {
    this.ribbons.clear();
    this.scene.primitives.remove(this.collection);
  }
}
