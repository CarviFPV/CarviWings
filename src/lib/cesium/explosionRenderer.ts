"use client";

/**
 * Draws an `ExplosionField` into the Cesium scene.
 *
 * Strictly a view, like the aircraft renderer. The field owns where every
 * particle is, how big it has grown and what colour it is now; this turns that
 * into billboards and nothing else.
 *
 * One `BillboardCollection` for the whole field, one billboard per pool slot,
 * created once and then only shown, hidden, moved, resized and tinted. Nothing
 * is added to or removed from the scene while flying, so a mission that ends
 * with twenty aircraft going up costs the same draw call as one that ends
 * quietly.
 *
 * The texture is a soft round puff drawn on a canvas at construction, and
 * every particle uses it: a flame is that puff tinted white-hot, smoke is it
 * tinted grey, and a fragment is it tinted dark and drawn small. One texture
 * means one atlas entry and one batch.
 *
 * Sized in metres rather than pixels, so an explosion two kilometres away is
 * small because it is far away, which is the only way it reads as being out
 * there in the world rather than stuck to the goggles.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { ExplosionField, Particle } from "@/sim/render/explosionField";
import { colorOf, particleColor } from "@/sim/render/explosionField";
import { vec3 } from "@/sim/math/vec3";

/** Side of the puff texture, pixels. Small on purpose: it is a blurred blob. */
const TEXTURE_SIZE = 64;
/**
 * Atlas key for the puff.
 *
 * Every billboard is given the texture through `setImage` under this one id,
 * which is what makes them share a single atlas entry. Assigning the canvas to
 * `billboard.image` instead would look identical and cost six hundred copies
 * of the same 64-pixel square, because Cesium keys an image with no `src` by a
 * fresh GUID each time.
 */
const PUFF_ID = "carviwings-explosion-puff";
/** Below this a particle is not worth a draw. */
const MIN_ALPHA = 0.004;
/** Nothing is drawn smaller than this across, metres. */
const MIN_DIAMETER = 0.15;

const _ecef = vec3();

export class ExplosionRenderer {
  private readonly scene: Cesium.Scene;
  private readonly frame: EnuFrame;
  private readonly collection: Cesium.BillboardCollection;
  private readonly billboards: Cesium.Billboard[] = [];
  private readonly color = particleColor();
  private readonly scratchColor: Cesium.Color;
  private readonly scratchPosition: Cesium.Cartesian3;

  constructor(
    cesium: CesiumModule,
    scene: Cesium.Scene,
    frame: EnuFrame,
    capacity: number,
  ) {
    this.scene = scene;
    this.frame = frame;
    this.scratchColor = new cesium.Color(1, 1, 1, 1);
    this.scratchPosition = new cesium.Cartesian3();

    this.collection = new cesium.BillboardCollection({ scene });
    // Every particle is translucent, and saying so up front saves Cesium
    // splitting the collection into two passes it will never need.
    this.collection.blendOption = cesium.BlendOption.TRANSLUCENT;
    scene.primitives.add(this.collection);

    for (let i = 0; i < capacity; i += 1) {
      const billboard: Cesium.Billboard = this.collection.add({
        // Metres, so the burst lives in the world rather than on the screen.
        sizeInMeters: true,
        width: 1,
        height: 1,
        show: false,
        position: cesium.Cartesian3.ZERO,
      });
      billboard.setImage(PUFF_ID, puffTexture);
      this.billboards.push(billboard);
    }
  }

  /**
   * Pushes the field's current state onto the billboards.
   *
   * Allocation-free: Cesium's `position` and `color` setters copy what they
   * are given, so one scratch of each is reused for the whole pool.
   */
  draw(field: ExplosionField): void {
    const particles = field.particles;
    const billboards = this.billboards;
    const count = Math.min(particles.length, billboards.length);

    for (let i = 0; i < count; i += 1) {
      const particle = particles[i] as Particle;
      const billboard = billboards[i] as Cesium.Billboard;

      if (particle.life <= 0) {
        if (billboard.show) billboard.show = false;
        continue;
      }

      colorOf(this.color, particle);
      if (this.color.a <= MIN_ALPHA) {
        if (billboard.show) billboard.show = false;
        continue;
      }

      this.frame.localToEcef(particle.position, _ecef);
      this.scratchPosition.x = _ecef.x;
      this.scratchPosition.y = _ecef.y;
      this.scratchPosition.z = _ecef.z;
      billboard.position = this.scratchPosition;

      const diameter = Math.max(field.radius(particle) * 2, MIN_DIAMETER);
      billboard.width = diameter;
      billboard.height = diameter;

      this.scratchColor.red = this.color.r;
      this.scratchColor.green = this.color.g;
      this.scratchColor.blue = this.color.b;
      this.scratchColor.alpha = this.color.a;
      billboard.color = this.scratchColor;

      if (!billboard.show) billboard.show = true;
    }

    // A pool larger than the collection would leave stale billboards up.
    for (let i = count; i < billboards.length; i += 1) {
      const billboard = billboards[i] as Cesium.Billboard;
      if (billboard.show) billboard.show = false;
    }
  }

  destroy(): void {
    this.billboards.length = 0;
    this.scene.primitives.remove(this.collection);
  }
}

/**
 * A round puff, opaque in the middle and gone at the rim.
 *
 * The falloff is deliberately not linear: a linear gradient reads as a hard
 * disc with a halo, while squaring it puts most of the opacity in the middle
 * third and lets the edge disappear into whatever is behind it. Cached, so
 * every renderer and every particle shares one texture.
 */
let puff: HTMLCanvasElement | null = null;

function puffTexture(): HTMLCanvasElement {
  if (puff) return puff;

  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return canvas;

  const half = TEXTURE_SIZE / 2;
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const data = image.data;
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const falloff = Math.max(1 - distance, 0);
      const index = (y * TEXTURE_SIZE + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = Math.round(255 * falloff * falloff);
    }
  }
  context.putImageData(image, 0, 0);

  puff = canvas;
  return canvas;
}
