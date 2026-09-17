"use client";

/**
 * The world's detail budget, held steady while the view zooms.
 *
 * The quality preset is where a flight starts and where it stays — see
 * `quality.ts`, which says so — and nothing here argues with it. What it does
 * is stop a narrowing field of view from quietly asking for several times more
 * of the world than the preset ever chose.
 *
 * Cesium picks a tile level by projecting the tile's error onto the screen and
 * refining until what is left is under `maximumScreenSpaceError` pixels. The
 * projection divides by `2 tan(fovy/2)`, so halving the field of view doubles
 * the error every tile in the scene reports and the whole view refines a level
 * deeper — at the tail end of the ground view's zoom, roughly five times the
 * tiles, wanted all at once, out of the same request budget and the same cache
 * as the sky the model is actually in. It is asked for again every time the
 * model goes out and given back every time it comes home, which is a load storm
 * on the rhythm of a circuit.
 *
 * So the threshold moves with the zoom and the tiles stay where they were: the
 * same world, magnified. It reads softer the further the eye is closed down,
 * which is the trade — and it is the honest one for this view, because nobody
 * standing on a field resolves more of the next valley by squinting at their
 * wing.
 *
 * Only the ground view ever asks for this. Every other camera has a fixed field
 * of view for the whole flight — the pilot's own FPV setting included — so
 * there is no zoom to compensate for and nothing changes for them: the
 * magnification is 1 and the baseline is what is applied.
 */

import type * as Cesium from "cesium";

/**
 * How far the magnification has to move, as a fraction of what is applied,
 * before it is worth stating again.
 *
 * Relative rather than absolute, and not only to spare a couple of property
 * writes. Cesium keeps a memory backoff of its own on a tileset — when the
 * tiles needed would not fit the cache it creeps the error it actually refines
 * to upwards a couple of percent a frame, and creeps it back down when they
 * would — and writing `maximumScreenSpaceError` resets that backoff to whatever
 * was written. Restating the same number every frame would hold it at zero and
 * take that mechanism away. A twentieth of a tile's threshold is far inside one
 * level of detail, so nothing on screen can tell the difference, and it leaves
 * the magnification still for as long as the model's range is: which is most of
 * a flight, and all of every camera that does not zoom.
 */
const RESTATE_FRACTION = 0.05;

export class ViewDetail {
  private readonly globe: Cesium.Globe | undefined;
  private readonly tilesets: readonly Cesium.Cesium3DTileset[];
  /**
   * What the preset asked for, read back off the scene rather than passed in.
   *
   * `viewer.ts` and `scenery.ts` are the two places that apply a preset, and
   * they have both already run by the time this exists. Reading what they
   * actually applied is one fewer copy of the same numbers to keep in step.
   */
  private readonly baselineGlobe: number;
  private readonly baselineTilesets: readonly number[];
  private applied = 1;

  constructor(scene: Cesium.Scene, tilesets: readonly Cesium.Cesium3DTileset[]) {
    this.globe = scene.globe ?? undefined;
    this.tilesets = tilesets;
    this.baselineGlobe = this.globe?.maximumScreenSpaceError ?? 0;
    this.baselineTilesets = tilesets.map(
      (tileset) => tileset.maximumScreenSpaceError,
    );
  }

  /**
   * Says how many times the view is magnified against a plain one, and relaxes
   * the detail threshold by the same factor.
   *
   * 1 puts everything back where the preset left it, which is what every camera
   * but the ground view asks for, every frame, for nothing.
   */
  setMagnification(magnification: number): void {
    const wanted =
      Number.isFinite(magnification) && magnification >= 1 ? magnification : 1;
    // Exactly 1 is stated rather than approached: it is the preset's own
    // number, and a camera that has stopped zooming should be holding it and
    // not a twentieth either side of it.
    const moved = Math.abs(wanted - this.applied);
    if (moved < this.applied * RESTATE_FRACTION && !(wanted === 1 && moved > 0)) {
      return;
    }
    this.applied = wanted;

    if (this.globe && this.baselineGlobe > 0) {
      this.globe.maximumScreenSpaceError = this.baselineGlobe * wanted;
    }
    for (let i = 0; i < this.tilesets.length; i += 1) {
      const tileset = this.tilesets[i];
      const baseline = this.baselineTilesets[i];
      if (!tileset || baseline === undefined || baseline <= 0) continue;
      if (tileset.isDestroyed()) continue;
      tileset.maximumScreenSpaceError = baseline * wanted;
    }
  }

  /** The magnification the scene is currently being drawn under. */
  get magnification(): number {
    return this.applied;
  }
}
