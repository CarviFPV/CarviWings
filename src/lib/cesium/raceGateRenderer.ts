"use client";

/**
 * Draws the race course into the Cesium scene.
 *
 * Strictly a view, like the aircraft renderer: it is handed a course in local
 * ENU metres and puts frames in the sky where the gates are. The simulation
 * decides what a gate is and whether it has been flown, and `raceGateMesh`
 * decides what one looks like; this only puts the shape in the world and
 * colours it by what the race says the gate is doing.
 *
 * Every box of every gate lives in one primitive with a per-instance colour,
 * so a twenty-gate course is a single draw rather than a thousand, and marking
 * a gate as next or as flown is an attribute write rather than a rebuild.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { RaceCourse, RaceGate } from "@/sim/mission/race";
import { GATE_TONE, buildGateFrame } from "@/sim/render/raceGateMesh";
import { vec3 } from "@/sim/math/vec3";

type Rgb = readonly [number, number, number];

/**
 * How a gate is painted in one of its states.
 *
 * Two colours rather than one: the band carries the state and the liner around
 * the opening is a paler version of it, which is what makes the frame read as
 * a hole with an edge rather than as a solid shape at a distance where the
 * whole gate is a few pixels wide.
 */
interface GateSkin {
  readonly band: Rgb;
  readonly liner: Rgb;
}

/** The gate the pilot is flying at now. */
const NEXT_SKIN: GateSkin = {
  band: [0.1, 0.9, 1],
  liner: [0.9, 0.99, 1],
};
/**
 * Gates still to come.
 *
 * A second colour entirely rather than a dimmer white: a course is flown by
 * looking through the gate being flown at to the one behind it, and two
 * frames the same colour a hundred metres apart are one frame until they are
 * too close to do anything about.
 */
const AHEAD_SKIN: GateSkin = {
  band: [1, 0.22, 0.72],
  liner: [1, 0.9, 0.96],
};
/** The finish, until it has been crossed. */
const FINISH_SKIN: GateSkin = {
  band: [1, 0.63, 0.05],
  liner: [1, 0.94, 0.8],
};
/**
 * Gates already flown.
 *
 * Dark, but still there: on a circuit the frames a lap behind are the course
 * ahead seen early, and a gate that vanished once it had been crossed would
 * take the shape of the track with it.
 */
const PASSED_SKIN: GateSkin = {
  band: [0.22, 0.25, 0.3],
  liner: [0.45, 0.49, 0.55],
};
/** The edge round the outside, which is the same on every gate. */
const TRIM_COLOR: Rgb = [0.03, 0.04, 0.06];

const _fwd = vec3();
const _left = vec3();
const _up = vec3();
const _fwdEcef = vec3();
const _leftEcef = vec3();
const _upEcef = vec3();
const _originEcef = vec3();

/** The instances of one gate that change colour, kept by what they are. */
interface GateInstances {
  readonly band: string[];
  readonly liner: string[];
}

export class RaceGateRenderer {
  private readonly cesium: CesiumModule;
  private readonly scene: Cesium.Scene;
  private readonly frame: EnuFrame;
  private readonly course: RaceCourse;

  private primitive: Cesium.Primitive | null = null;
  /** Instance ids per gate, so a gate can be recoloured without a rebuild. */
  private readonly instances: GateInstances[] = [];
  private readonly skins: GateSkin[] = [];
  private nextGate = 0;

  constructor(
    cesium: CesiumModule,
    scene: Cesium.Scene,
    frame: EnuFrame,
    course: RaceCourse,
  ) {
    this.cesium = cesium;
    this.scene = scene;
    this.frame = frame;
    this.course = course;
    this.build();
    this.setNextGate(0);
  }

  private build(): void {
    const cesium = this.cesium;
    const instances: Cesium.GeometryInstance[] = [];

    // One frame per thing in the sky, not one per crossing: a circuit's finish
    // is its start line, and drawing it twice would be two gates fighting over
    // the same cubic metre.
    for (const gate of this.course.frames) {
      const matrix = this.gateMatrix(gate);
      const ids: GateInstances = { band: [], liner: [] };
      const skin = this.skinFor(gate.frame, 0);

      buildGateFrame(gate).forEach((slab, i) => {
        const id = `gate-${gate.frame}-${i}`;
        let color = TRIM_COLOR;
        if (slab.tone === GATE_TONE.Band) {
          ids.band.push(id);
          color = skin.band;
        } else if (slab.tone === GATE_TONE.Liner) {
          ids.liner.push(id);
          color = skin.liner;
        }

        const local = cesium.Matrix4.fromRotationTranslation(
          cesium.Matrix3.fromRotationX(slab.roll),
          new cesium.Cartesian3(
            slab.offset[0],
            slab.offset[1],
            slab.offset[2],
          ),
        );
        const modelMatrix = cesium.Matrix4.multiply(
          matrix,
          local,
          new cesium.Matrix4(),
        );
        instances.push(
          new cesium.GeometryInstance({
            geometry: cesium.BoxGeometry.fromDimensions({
              vertexFormat:
                cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
              dimensions: new cesium.Cartesian3(
                slab.size[0],
                slab.size[1],
                slab.size[2],
              ),
            }),
            modelMatrix,
            id,
            attributes: {
              color: cesium.ColorGeometryInstanceAttribute.fromColor(
                new cesium.Color(color[0], color[1], color[2], 1),
              ),
            },
          }),
        );
      });

      this.instances[gate.frame] = ids;
      this.skins[gate.frame] = skin;
    }

    if (instances.length === 0) return;

    this.primitive = new cesium.Primitive({
      geometryInstances: instances,
      appearance: new cesium.PerInstanceColorAppearance({
        // Unshaded on purpose. These are markers rather than structures, and a
        // gate lit by the scene's sun is a dark grey frame at dusk, in the
        // shadow of the ridge it is sitting under, and on the night half of
        // the world — which is exactly where a pilot most needs to find it.
        flat: true,
        translucent: false,
        closed: true,
      }),
      asynchronous: false,
      allowPicking: false,
      // The colours change as the course is flown, so the instances have to
      // stay around to be written to.
      releaseGeometryInstances: false,
      shadows: cesium.ShadowMode.DISABLED,
    });
    this.scene.primitives.add(this.primitive);
  }

  /** Places a gate in ECEF: x through the frame, y across it, z up. */
  private gateMatrix(gate: RaceGate): Cesium.Matrix4 {
    _fwd.x = gate.forward.x;
    _fwd.y = gate.forward.y;
    _fwd.z = 0;
    // Left, so that the frame is right-handed with up.
    _left.x = -gate.right.x;
    _left.y = -gate.right.y;
    _left.z = 0;
    _up.x = 0;
    _up.y = 0;
    _up.z = 1;

    this.frame.enuVectorToEcef(_fwd, _fwdEcef);
    this.frame.enuVectorToEcef(_left, _leftEcef);
    this.frame.enuVectorToEcef(_up, _upEcef);
    this.frame.localToEcef(gate.position, _originEcef);

    return this.cesium.Matrix4.fromColumnMajorArray([
      _fwdEcef.x, _fwdEcef.y, _fwdEcef.z, 0,
      _leftEcef.x, _leftEcef.y, _leftEcef.z, 0,
      _upEcef.x, _upEcef.y, _upEcef.z, 0,
      _originEcef.x, _originEcef.y, _originEcef.z, 1,
    ]);
  }

  /**
   * How one frame should be painted with the course at `nextGate`.
   *
   * Asked about a frame rather than about a crossing, because a circuit's
   * start line is both its first gate and its last: it is lit as the gate
   * being flown at on the way out, goes dark once it has been crossed, and
   * comes back as the finish on the last leg. Every one of those is just
   * "what does the order say about this frame right now".
   */
  private skinFor(frame: number, nextGate: number): GateSkin {
    const next = this.course.gate(nextGate);
    if (next && next.frame === frame) {
      return this.course.isFinish(nextGate) ? FINISH_SKIN : NEXT_SKIN;
    }
    // Still owed later in the order? Then it is a gate ahead, whatever has
    // already been done with it.
    const owed = this.course.gates.some(
      (gate) => gate.frame === frame && gate.index > nextGate,
    );
    if (!owed) return PASSED_SKIN;
    return this.course.isFinish(this.lastCrossingOf(frame))
      ? FINISH_SKIN
      : AHEAD_SKIN;
  }

  /** The last place in the order this frame is crossed. */
  private lastCrossingOf(frame: number): number {
    let last = -1;
    for (const gate of this.course.gates) {
      if (gate.frame === frame) last = gate.index;
    }
    return last;
  }

  /**
   * Tells the course which gate is being flown at.
   *
   * Called every frame and cheap when nothing has moved on: only the gates
   * whose colour actually changed are written.
   */
  setNextGate(nextGate: number): void {
    const primitive = this.primitive;
    if (!primitive || !primitive.ready) {
      this.nextGate = nextGate;
      return;
    }

    for (const gate of this.course.frames) {
      const index = gate.frame;
      const wanted = this.skinFor(index, nextGate);
      if (this.skins[index] === wanted) continue;
      this.skins[index] = wanted;
      const ids = this.instances[index];
      if (!ids) continue;
      this.paint(ids.band, wanted.band);
      this.paint(ids.liner, wanted.liner);
    }
    this.nextGate = nextGate;
  }

  /** Writes one colour onto a set of instances already in the primitive. */
  private paint(ids: readonly string[], color: Rgb): void {
    const primitive = this.primitive;
    if (!primitive) return;
    const value = this.cesium.ColorGeometryInstanceAttribute.toValue(
      new this.cesium.Color(color[0], color[1], color[2], 1),
    );
    for (const id of ids) {
      const attributes = primitive.getGeometryInstanceAttributes(id) as
        | { color?: Uint8Array }
        | undefined;
      if (attributes?.color) attributes.color = value;
    }
  }

  get currentGate(): number {
    return this.nextGate;
  }

  destroy(): void {
    if (this.primitive && !this.scene.isDestroyed()) {
      this.scene.primitives.remove(this.primitive);
    }
    this.primitive = null;
  }
}
