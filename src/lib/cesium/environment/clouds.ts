"use client";

/**
 * The billboard cloud layer.
 *
 * The fallback renderer: `volumetricClouds.ts` is what normally draws the sky,
 * and this is what draws it when the pilot has turned the march off or the
 * hardware would not take it. It is cheap and holds up at a distance, but a
 * billboard has no inside — fly into one and it turns edge-on and vanishes at
 * the moment you are closest to it.
 *
 * Built on Cesium's `CloudCollection`, which renders procedural cumulus as GPU
 * billboards — a few hundred draw-instanced quads rather than geometry, and
 * nothing per-cloud on the CPU beyond a position. There are no entities and no
 * React components involved, and the aircraft flies straight through them
 * because they have no collision at all.
 *
 * The field is finite but appears endless: it is centred on the player, and any
 * cloud that falls off one edge is wrapped round to the opposite one. That
 * keeps the cloud count fixed no matter how far the mission ranges.
 *
 * A cloud is a small cluster of billboards rather than one, because a single
 * quad reads as a decal from anywhere near it and cumulus is lumpy. The
 * billboard budget is fixed either way: clustering spends it on fewer, better
 * clouds instead of more, flatter ones.
 *
 * The field draws every deck the weather describes rather than one, splitting
 * the same billboard budget between them in proportion to how much of the sky
 * each fills. What a deck looks like comes from its genus: a convective one is
 * tall, lumpy and bright, a sheet is wide, flat and grey. Every deck drifts at
 * the wind of its own altitude, so a sheared sky reads as sheared here too.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "../loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { CloudDeck } from "./volumetricClouds";
import { createRng } from "@/sim/math/rng";
import { clamp, lerp } from "@/sim/math/scalar";
import type { Vec3 } from "@/sim/math/vec3";
import { vec3 } from "@/sim/math/vec3";

export interface CloudFieldOptions {
  readonly seed: string;
  /** The decks to lay out, lowest first. */
  readonly decks: readonly CloudDeck[];
  /** Side length of the field that follows the player, metres. */
  readonly extent: number;
}

/** One billboard, offset from the mass it belongs to. */
interface Puff {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly cloud: Cesium.CumulusCloud;
}

/** A cluster of billboards that moves as one cloud. */
interface CloudMass {
  /** Offset from the field centre, in local ENU metres. */
  readonly offset: Vec3;
  /** Which deck it belongs to, so it drifts at that deck's wind. */
  readonly deck: number;
  readonly puffs: readonly Puff[];
}

/** Fewest and most billboards drawn, at zero and full coverage. */
const MIN_BILLBOARDS = 24;
const MAX_BILLBOARDS = 220;
/** Billboards per cloud. More at the top end makes each cloud read as a mass. */
const MIN_PUFFS = 2;
const MAX_PUFFS = 5;
/** The field is re-centred and drifted at this rate, not every frame. */
const UPDATE_INTERVAL = 0.2;

const _local = vec3();
const _ecef = vec3();

export class CloudField {
  private readonly cesium: CesiumModule;
  private readonly scene: Cesium.Scene;
  private readonly frame: EnuFrame;
  private readonly collection: Cesium.CloudCollection;
  private readonly masses: CloudMass[] = [];
  private decks: readonly CloudDeck[] = [];
  private billboards = 0;
  private readonly centre = vec3();
  /**
   * A Cartesian the collection does not own.
   *
   * `CumulusCloud.position`'s getter hands back its *internal* vector, and its
   * setter skips the update when the value it is given already equals that
   * vector. Mutating what the getter returned and assigning it back therefore
   * moves nothing — the cloud is never marked dirty and stays wherever it was
   * first placed. Writing through a separate object is what makes the setter
   * see a change.
   */
  private readonly scratchPosition: Cesium.Cartesian3;
  private readonly extent: number;
  private readonly halfExtent: number;
  private timer = UPDATE_INTERVAL;
  /** How far each deck has moved since the last reposition, metres. */
  private readonly deckDrift: { x: number; y: number }[] = [];
  private destroyed = false;

  constructor(
    cesium: CesiumModule,
    scene: Cesium.Scene,
    frame: EnuFrame,
    options: CloudFieldOptions,
  ) {
    this.cesium = cesium;
    this.scene = scene;
    this.frame = frame;
    this.extent = options.extent;
    this.halfExtent = options.extent / 2;
    this.scratchPosition = new cesium.Cartesian3();

    this.collection = new cesium.CloudCollection({
      // Enough noise octaves to read as cumulus without hurting fill rate.
      noiseDetail: 16,
    });
    scene.primitives.add(this.collection);

    this.decks = options.decks.filter(
      (deck) => deck.coverage > 0.001 && deck.topZ > deck.baseZ,
    );
    const rng = createRng(`${options.seed}:clouds`);

    // The budget is shared out by how much of the sky each deck fills, so an
    // overcast base under a few wisps of cirrus gets almost all the quads.
    const weights = this.decks.map((deck) => deck.coverage);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const thickest = this.decks.reduce(
      (most, deck) => Math.max(most, deck.coverage),
      0,
    );
    const budget = Math.round(lerp(MIN_BILLBOARDS, MAX_BILLBOARDS, thickest));

    for (let index = 0; index < this.decks.length; index += 1) {
      const deck = this.decks[index] as CloudDeck;
      const share =
        totalWeight > 0 ? (weights[index] as number) / totalWeight : 0;
      this.layOutDeck(cesium, rng, deck, index, Math.round(budget * share));
    }
  }

  /**
   * Fills one deck with clusters.
   *
   * How a cloud is shaped is entirely the deck's genus: convective cloud is
   * tall, deep and bunched, a sheet is wide and flat, and a thin deck is
   * brighter than a solid one because less of it is in its own shadow.
   */
  private layOutDeck(
    cesium: CesiumModule,
    rng: ReturnType<typeof createRng>,
    deck: CloudDeck,
    index: number,
    budget: number,
  ): void {
    const coverage = clamp(deck.coverage, 0, 1);
    const convection = clamp(deck.convection, 0, 1);
    const depth = Math.max(deck.topZ - deck.baseZ, 50);
    let placed = 0;

    while (placed < budget) {
      const remaining = budget - placed;
      const puffCount = Math.min(
        remaining,
        Math.round(rng.range(MIN_PUFFS, MAX_PUFFS)),
      );

      // Convective cloud hangs from a flat base and piles upward; a sheet is
      // spread through the shallow slab it occupies.
      const offset = vec3(
        rng.range(-this.halfExtent, this.halfExtent),
        rng.range(-this.halfExtent, this.halfExtent),
        convection > 0.5
          ? deck.baseZ + depth * rng.range(0, 0.25)
          : rng.range(deck.baseZ, deck.topZ),
      );

      // Bigger, flatter clouds when the sky is covered; scattered puffs when
      // it is not. Kept well under the cloud spacing: a billboard wide enough
      // to fill the canopy reads as a grey wall rather than as weather.
      const massWidth = rng.range(220, 470) * lerp(0.85, 1.2, coverage);
      // A sheet is flattened; a convective mass is nearly as tall as it is wide.
      const flatten = lerp(0.4, 1.1, convection);
      const spread = massWidth * 0.55;

      const puffs: Puff[] = [];
      for (let i = 0; i < puffCount; i += 1) {
        // The first billboard is the core; the rest bulge out around it and
        // are progressively smaller, which is what gives a cloud its shape.
        const core = i === 0;
        const scale = core ? 1 : rng.range(0.45, 0.85);
        const width = massWidth * scale;
        const height = width * rng.range(0.34, 0.55) * flatten;
        const cloud = this.collection.add({
          position: cesium.Cartesian3.ZERO,
          scale: new cesium.Cartesian2(width, height),
          maximumSize: new cesium.Cartesian3(
            width * 0.5,
            width * 0.4,
            height * 0.75,
          ),
          slice: rng.range(0.3, 0.55),
          // Overcast is grey. Broken cloud in sunshine is not, and ice is
          // brighter than either.
          brightness:
            rng.range(0.82, 1) *
            lerp(1, 0.82, coverage) *
            lerp(1.15, 0.95, clamp(deck.density, 0, 1)),
        }) as Cesium.CumulusCloud;
        puffs.push({
          dx: core ? 0 : rng.range(-spread, spread),
          dy: core ? 0 : rng.range(-spread, spread),
          // Puffs pile upward more than they hang below, as cumulus does.
          dz: core ? 0 : rng.range(-height * 0.3, height * 0.75),
          cloud,
        });
        this.billboards += 1;
        placed += 1;
      }
      this.masses.push({ offset, deck: index, puffs });
    }
  }

  /** Billboards in flight, which is what the frame actually costs. */
  get cloudCount(): number {
    return this.billboards;
  }

  set show(value: boolean) {
    this.collection.show = value;
  }

  /**
   * Re-centres the field on the player and drifts it downwind.
   *
   * Runs on a timer rather than every frame: at flight speeds a fifth of a
   * second of drift is invisible, and a few hundred matrix writes per second is
   * not worth spending.
   */
  update(
    playerPosition: Vec3,
    windAt: (altitudeAgl: number) => Vec3,
    dt: number,
  ): void {
    if (this.destroyed) return;
    this.timer += dt;
    if (this.timer < UPDATE_INTERVAL) return;
    const elapsed = this.timer;
    this.timer = 0;

    // Each deck moves with the air at its own height, and the field follows
    // the aircraft.
    for (let i = 0; i < this.decks.length; i += 1) {
      const deck = this.decks[i] as CloudDeck;
      const wind = windAt((deck.baseZ + deck.topZ) / 2);
      const drift = this.deckDrift[i] ?? { x: 0, y: 0 };
      drift.x = wind.x * elapsed;
      drift.y = wind.y * elapsed;
      this.deckDrift[i] = drift;
    }

    this.centre.x = playerPosition.x;
    this.centre.y = playerPosition.y;

    for (const mass of this.masses) {
      const drift = this.deckDrift[mass.deck] ?? { x: 0, y: 0 };
      mass.offset.x += drift.x;
      mass.offset.y += drift.y;

      // Wrap anything that has fallen off an edge round to the other side.
      // The whole cluster wraps together, so a cloud never tears in half.
      if (mass.offset.x > this.halfExtent) mass.offset.x -= this.extent;
      else if (mass.offset.x < -this.halfExtent) mass.offset.x += this.extent;
      if (mass.offset.y > this.halfExtent) mass.offset.y -= this.extent;
      else if (mass.offset.y < -this.halfExtent) mass.offset.y += this.extent;

      for (const puff of mass.puffs) {
        _local.x = this.centre.x + mass.offset.x + puff.dx;
        _local.y = this.centre.y + mass.offset.y + puff.dy;
        _local.z = mass.offset.z + puff.dz;
        this.frame.localToEcef(_local, _ecef);

        this.scratchPosition.x = _ecef.x;
        this.scratchPosition.y = _ecef.y;
        this.scratchPosition.z = _ecef.z;
        puff.cloud.position = this.scratchPosition;
      }
    }
  }

  /** Forces a reposition on the next update, e.g. after a respawn. */
  invalidate(): void {
    this.timer = UPDATE_INTERVAL;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.masses.length = 0;
    this.billboards = 0;
    if (!this.scene.isDestroyed()) {
      this.scene.primitives.remove(this.collection);
    }
    void this.cesium;
  }
}
