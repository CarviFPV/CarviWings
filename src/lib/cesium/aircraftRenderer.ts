"use client";

/**
 * Draws aircraft into the Cesium scene.
 *
 * Strictly a view: it is handed a position, an orientation and a scale, and it
 * has no opinion about how any of them came to be. The simulation owns the
 * aircraft state; this only visualises it.
 *
 * An aircraft is a handful of Cesium primitives whose `modelMatrix` is
 * rewritten each frame. Nothing is rebuilt, no entities are created or
 * destroyed while flying, and the per-frame cost is a few matrix compositions.
 * The moving parts are separate primitives rather than reshaped geometry
 * precisely so that no vertex is ever touched once the aircraft exists.
 *
 * Only the player's aircraft is built with working elevons. A contact is seen
 * from far enough away that a control surface is a pixel or two, and a flight
 * of twenty of them is the difference between eighty draw calls and forty —
 * which is worth far more than a detail nobody can resolve. The propeller is
 * the same trade made per frame rather than per airframe: it has to be its own
 * primitive to turn, so beyond the range at which the disc is sub-pixel it is
 * simply not drawn.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { AircraftState } from "@/sim/flight/state";
import { forwardAxis, leftAxis, upAxis } from "@/sim/math/quat";
import { vec3 } from "@/sim/math/vec3";
import type { Livery } from "@/sim/flight/livery";
import { DEFAULT_LIVERY } from "@/sim/flight/livery";
import type { AircraftMesh, MeshKind, MeshPart } from "@/sim/render/aircraftMesh";
import {
  MESH_KIND,
  meshOfKind,
  partColor,
} from "@/sim/render/aircraftMesh";

/** One propeller of one aircraft, with the matrices it is placed by. */
interface PropellerVisual {
  readonly primitive: Cesium.Primitive;
  readonly translation: Cesium.Cartesian3;
  /** True for a rotor turning about the body up axis rather than the nose. */
  readonly aboutUp: boolean;
  readonly direction: number;
  readonly matrix: Cesium.Matrix4;
}

interface AircraftVisual {
  readonly body: Cesium.Primitive;
  readonly propellers: readonly PropellerVisual[];
  readonly elevonLeft: Cesium.Primitive | null;
  readonly elevonRight: Cesium.Primitive | null;
  readonly bodyMatrix: Cesium.Matrix4;
  readonly leftMatrix: Cesium.Matrix4;
  readonly rightMatrix: Cesium.Matrix4;
  /** Hinge offset of this airframe's elevons, if it has any. */
  readonly hinge: Cesium.Cartesian3;
  /** Span of this airframe as a multiple of the mesh's own. */
  readonly scale: number;
  /** What the caller last asked for, which the propeller LOD must not undo. */
  visible: boolean;
  /** Whether the propellers are currently close enough to be drawn. */
  propellerDrawn: boolean;
}

/**
 * Range beyond which the propeller is not drawn, metres.
 *
 * The disc is a hundred millimetres across. At this range that is half a pixel
 * on a 1080p frame through a 100-degree lens, and it is spinning: there is
 * nothing there to resolve. It has to be its own primitive in order to turn,
 * which also makes it its own draw call — and in a race or a crowded intercept
 * the traffic on screen is what there is a lot of, so dropping the half of
 * each distant contact nobody can see costs nothing and halves what the scene
 * has to issue for it.
 */
const PROPELLER_RANGE = 240;
const PROPELLER_RANGE_SQUARED = PROPELLER_RANGE * PROPELLER_RANGE;

/**
 * Bounding spheres by mesh part, shared by every aircraft ever drawn.
 *
 * The geometry is a module singleton — every wing at a fly-in is drawn from
 * one set of `MeshPart` objects — so the sphere around each part is the same
 * sphere every time. Working it out per airframe means scanning six thousand
 * coordinates and copying the vertex array into a plain one, twenty times over,
 * in the frame a wave relaunches; working it out once means neither.
 */
const boundingSpheres = new WeakMap<MeshPart, Cesium.BoundingSphere>();

const _fwd = vec3();
const _left = vec3();
const _up = vec3();
const _fwdEcef = vec3();
const _leftEcef = vec3();
const _upEcef = vec3();
const _originEcef = vec3();

export class AircraftRenderer {
  private readonly cesium: CesiumModule;
  private readonly scene: Cesium.Scene;
  private readonly frame: EnuFrame;
  private readonly visuals = new Map<string, AircraftVisual>();
  private readonly matrixValues = new Float64Array(16);
  private readonly propLocal: Cesium.Matrix4;
  private readonly propRotation: Cesium.Matrix3;
  private readonly hingeLocal: Cesium.Matrix4;
  private readonly hingeRotation: Cesium.Matrix3;

  constructor(cesium: CesiumModule, scene: Cesium.Scene, frame: EnuFrame) {
    this.cesium = cesium;
    this.scene = scene;
    this.frame = frame;
    this.propRotation = new cesium.Matrix3();
    this.propLocal = new cesium.Matrix4();
    this.hingeRotation = new cesium.Matrix3();
    this.hingeLocal = new cesium.Matrix4();
  }

  private buildPrimitive(
    parts: readonly MeshPart[],
    tint: readonly [number, number, number] | null,
    livery: Livery,
  ): Cesium.Primitive | null {
    if (parts.length === 0) return null;
    const cesium = this.cesium;

    const instances = parts.map((part) => {
      const attributes = new cesium.GeometryAttributes();
      attributes.position = new cesium.GeometryAttribute({
        componentDatatype: cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: part.positions,
      });
      attributes.normal = new cesium.GeometryAttribute({
        componentDatatype: cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: part.normals,
      });

      const geometry = new cesium.Geometry({
        attributes,
        indices: part.indices,
        primitiveType: cesium.PrimitiveType.TRIANGLES,
        boundingSphere: this.boundingSphereFor(part),
      });

      // The paint goes on first and the tint over the top of it: a contact is
      // marked apart by the tint whatever it is painted, and the pilot's own
      // aircraft carries no tint at all and is simply the colour they chose.
      const painted = partColor(part, livery);
      const [r, g, b] = tint
        ? ([
            painted[0] * 0.45 + tint[0] * 0.55,
            painted[1] * 0.45 + tint[1] * 0.55,
            painted[2] * 0.45 + tint[2] * 0.55,
          ] as const)
        : painted;

      return new cesium.GeometryInstance({
        geometry,
        attributes: {
          color: cesium.ColorGeometryInstanceAttribute.fromColor(
            new cesium.Color(r, g, b, 1),
          ),
        },
      });
    });

    return new cesium.Primitive({
      geometryInstances: instances,
      appearance: new cesium.PerInstanceColorAppearance({
        flat: false,
        translucent: false,
        closed: false,
      }),
      asynchronous: false,
      // Pickable, so that it can be *un*picked. A height sample reports
      // whatever geometry stands at a column, aircraft included, and the only
      // way to keep an airframe out of one is `objectsToExclude` — which is
      // matched through the pick buffer, so a primitive with picking off cannot
      // be named there at all. Turning picking off therefore does the opposite
      // of what it looks like: it makes the aircraft impossible to leave out.
      // Nothing in the flight scene picks except the surface probes, and both
      // of those exclude everything `pickExclusions` returns.
      allowPicking: true,
      releaseGeometryInstances: true,
      shadows: cesium.ShadowMode.DISABLED,
    });
  }

  /**
   * The sphere around one mesh part, worked out the first time it is asked for.
   *
   * Cesium is handed a clone rather than the cached sphere itself: a primitive
   * transforms the geometry it is given into world coordinates, and it must not
   * be allowed to transform every other aircraft's sphere along with it.
   */
  private boundingSphereFor(part: MeshPart): Cesium.BoundingSphere {
    const cached = boundingSpheres.get(part);
    if (cached) return this.cesium.BoundingSphere.clone(cached);
    const sphere = this.cesium.BoundingSphere.fromVertices(
      Array.from(part.positions),
    );
    boundingSpheres.set(part, sphere);
    return this.cesium.BoundingSphere.clone(sphere);
  }

  /**
   * Creates the primitives for one aircraft.
   *
   * `tint` marks enemies apart. `animated` builds the elevons as separate,
   * hinged primitives; without it they are merged into the airframe at neutral
   * and the aircraft costs half as much to draw. `span` is the airframe's own
   * wing span in metres: an airframe that is only a different size of the mesh
   * `kind` names is that mesh drawn at the size it actually is, and only one
   * that is a different shape carries geometry of its own. `livery` is the
   * paint on it, which is the pilot's
   * on their own aircraft and the delivered colours on everybody else's.
   */
  add(
    id: string,
    tint: readonly [number, number, number] | null = null,
    animated = false,
    span?: number,
    livery: Livery = DEFAULT_LIVERY,
    kind: MeshKind = MESH_KIND.Wing,
  ): void {
    if (this.visuals.has(id)) return;
    const mesh: AircraftMesh = meshOfKind(kind);
    const body = this.buildPrimitive(
      animated ? mesh.parts : mesh.staticParts,
      tint,
      livery,
    );
    if (!body) return;

    const propellers: PropellerVisual[] = [];
    for (const group of mesh.propellers) {
      const primitive = this.buildPrimitive(group.parts, tint, livery);
      if (!primitive) continue;
      propellers.push({
        primitive,
        translation: new this.cesium.Cartesian3(
          group.origin[0],
          group.origin[1],
          group.origin[2],
        ),
        aboutUp: group.axis === "z",
        direction: group.direction,
        matrix: new this.cesium.Matrix4(),
      });
    }

    const elevonLeft = animated
      ? this.buildPrimitive(mesh.elevonParts.left, tint, livery)
      : null;
    const elevonRight = animated
      ? this.buildPrimitive(mesh.elevonParts.right, tint, livery)
      : null;

    this.scene.primitives.add(body);
    for (const propeller of propellers) {
      this.scene.primitives.add(propeller.primitive);
    }
    if (elevonLeft) this.scene.primitives.add(elevonLeft);
    if (elevonRight) this.scene.primitives.add(elevonRight);

    const [hx, , hz] = mesh.elevonOrigin;
    const width = span && span > 0 ? span : mesh.referenceSpan;
    this.visuals.set(id, {
      body,
      propellers,
      elevonLeft,
      elevonRight,
      hinge: new this.cesium.Cartesian3(hx, 0, hz),
      scale: width / mesh.referenceSpan,
      bodyMatrix: new this.cesium.Matrix4(),
      leftMatrix: new this.cesium.Matrix4(),
      rightMatrix: new this.cesium.Matrix4(),
      visible: true,
      propellerDrawn: true,
    });
  }

  /**
   * True once every aircraft in the scene is resident on the GPU.
   *
   * A Cesium primitive does the whole of its real work — combining the
   * geometry, uploading it, and compiling and linking the shader it is drawn
   * with — in the first frame it is updated in. Left alone that frame is the
   * first frame of the flight, which is also the frame the tile queue and the
   * scene are busiest in; with twenty contacts in the sky it is a visible
   * hitch in the opening seconds. So the loading screen waits on this instead.
   */
  get ready(): boolean {
    for (const visual of this.visuals.values()) {
      if (!visual.body.ready) return false;
      for (const propeller of visual.propellers) {
        if (!propeller.primitive.ready) return false;
      }
      if (visual.elevonLeft && !visual.elevonLeft.ready) return false;
      if (visual.elevonRight && !visual.elevonRight.ready) return false;
    }
    return true;
  }

  /**
   * Shows every part of every aircraft, for a warm-up pass.
   *
   * Cesium does not update a primitive it is not drawing, and a primitive that
   * is not updated is not built — so under the ordinary rules a warm-up would
   * skip exactly the parts that cost something later: the propeller of every
   * contact further off than the LOD range, and the pilot's own airframe,
   * which the FPV camera hides. Each of those would then be built the first
   * time it came into view, in flight, which is the hitch the warm-up exists
   * to remove.
   *
   * Nothing here is a decision about what the flight draws. The range LOD is
   * marked as though everything were in close, so the first frame of the
   * flight sees a change and puts every one of them back where the camera and
   * the range say it belongs.
   */
  showEverything(): void {
    for (const visual of this.visuals.values()) {
      visual.visible = true;
      visual.propellerDrawn = true;
      visual.body.show = true;
      for (const propeller of visual.propellers) propeller.primitive.show = true;
      if (visual.elevonLeft) visual.elevonLeft.show = true;
      if (visual.elevonRight) visual.elevonRight.show = true;
    }
  }

  /**
   * Every primitive this renderer has in the scene.
   *
   * Handed to `Scene.sampleHeightMostDetailed` as its exclusion list. A height
   * sample reports whatever geometry stands at a column, and `allowPicking:
   * false` does not cover it — that flag governs `Scene.pick`, which is a
   * different question asked of a different buffer. Without this, measuring the
   * ground under a launch measures the aircraft sitting on it, and because the
   * measurement is what decides where the aircraft sits, the two lift each
   * other: a wing held two metres over the ground climbs two metres a second
   * for as long as anybody watches.
   */
  pickExclusions(): Cesium.Primitive[] {
    const primitives: Cesium.Primitive[] = [];
    for (const visual of this.visuals.values()) {
      primitives.push(visual.body);
      for (const propeller of visual.propellers) {
        primitives.push(propeller.primitive);
      }
      if (visual.elevonLeft) primitives.push(visual.elevonLeft);
      if (visual.elevonRight) primitives.push(visual.elevonRight);
    }
    return primitives;
  }

  remove(id: string): void {
    const visual = this.visuals.get(id);
    if (!visual) return;
    this.scene.primitives.remove(visual.body);
    for (const propeller of visual.propellers) {
      this.scene.primitives.remove(propeller.primitive);
    }
    if (visual.elevonLeft) this.scene.primitives.remove(visual.elevonLeft);
    if (visual.elevonRight) this.scene.primitives.remove(visual.elevonRight);
    this.visuals.delete(id);
  }

  setVisible(id: string, visible: boolean): void {
    const visual = this.visuals.get(id);
    if (!visual) return;
    visual.visible = visible;
    visual.body.show = visible;
    for (const propeller of visual.propellers) {
      propeller.primitive.show = visible && visual.propellerDrawn;
    }
    if (visual.elevonLeft) visual.elevonLeft.show = visible;
    if (visual.elevonRight) visual.elevonRight.show = visible;
  }

  /**
   * Rewrites the model matrix from the aircraft's current position and
   * attitude. The body axes are rotated out of the local ENU frame into ECEF,
   * which is exactly what Cesium wants as the primitive's model matrix.
   */
  update(state: AircraftState): void {
    const visual = this.visuals.get(state.id);
    if (!visual) return;
    const cesium = this.cesium;

    forwardAxis(_fwd, state.orientation);
    leftAxis(_left, state.orientation);
    upAxis(_up, state.orientation);

    this.frame.enuVectorToEcef(_fwd, _fwdEcef);
    this.frame.enuVectorToEcef(_left, _leftEcef);
    this.frame.enuVectorToEcef(_up, _upEcef);
    this.frame.localToEcef(state.position, _originEcef);

    // Column-major: the columns are where the body axes point in ECEF, each as
    // long as the airframe is wide. Scaling the columns scales the geometry
    // hung off this matrix as well — the propeller and both elevons compose
    // their own local matrices against it — so one multiplication sizes the
    // whole aircraft.
    const k = visual.scale;
    const m = this.matrixValues;
    m[0] = _fwdEcef.x * k;  m[1] = _fwdEcef.y * k;  m[2] = _fwdEcef.z * k;  m[3] = 0;
    m[4] = _leftEcef.x * k; m[5] = _leftEcef.y * k; m[6] = _leftEcef.z * k; m[7] = 0;
    m[8] = _upEcef.x * k;   m[9] = _upEcef.y * k;   m[10] = _upEcef.z * k;  m[11] = 0;
    m[12] = _originEcef.x;
    m[13] = _originEcef.y;
    m[14] = _originEcef.z;
    m[15] = 1;

    cesium.Matrix4.fromColumnMajorArray(m as unknown as number[], visual.bodyMatrix);
    visual.body.modelMatrix = visual.bodyMatrix;

    if (visual.propellers.length > 0) {
      // Far enough out that the disc is sub-pixel, the propellers are dropped
      // rather than spun: the aircraft looks identical and the scene issues
      // one draw call for it instead of several.
      const eye = this.scene.camera.positionWC;
      const dx = eye.x - _originEcef.x;
      const dy = eye.y - _originEcef.y;
      const dz = eye.z - _originEcef.z;
      const drawn = dx * dx + dy * dy + dz * dz <= PROPELLER_RANGE_SQUARED;
      if (drawn !== visual.propellerDrawn) {
        visual.propellerDrawn = drawn;
        for (const propeller of visual.propellers) {
          propeller.primitive.show = drawn && visual.visible;
        }
      }

      if (drawn) {
        for (const propeller of visual.propellers) {
          // A wing's pusher turns about the nose; a multirotor's rotors turn
          // about the body up axis, and adjacent ones turn opposite ways.
          const angle = state.propAngle * propeller.direction;
          if (propeller.aboutUp) {
            cesium.Matrix3.fromRotationZ(angle, this.propRotation);
          } else {
            cesium.Matrix3.fromRotationX(angle, this.propRotation);
          }
          cesium.Matrix4.fromRotationTranslation(
            this.propRotation,
            propeller.translation,
            this.propLocal,
          );
          cesium.Matrix4.multiply(
            visual.bodyMatrix,
            this.propLocal,
            propeller.matrix,
          );
          propeller.primitive.modelMatrix = propeller.matrix;
        }
      }
    }

    // Elevons hinge about the spanwise body axis. Positive is trailing edge
    // up, and rotating about +Y (left) carries the aft part of the surface
    // upward, so the state angle is used as it stands.
    if (visual.elevonLeft) {
      this.hingeMatrix(state.elevonLeft, visual.hinge);
      cesium.Matrix4.multiply(
        visual.bodyMatrix,
        this.hingeLocal,
        visual.leftMatrix,
      );
      visual.elevonLeft.modelMatrix = visual.leftMatrix;
    }
    if (visual.elevonRight) {
      this.hingeMatrix(state.elevonRight, visual.hinge);
      cesium.Matrix4.multiply(
        visual.bodyMatrix,
        this.hingeLocal,
        visual.rightMatrix,
      );
      visual.elevonRight.modelMatrix = visual.rightMatrix;
    }
  }

  private hingeMatrix(angle: number, translation: Cesium.Cartesian3): void {
    const cesium = this.cesium;
    cesium.Matrix3.fromRotationY(angle, this.hingeRotation);
    cesium.Matrix4.fromRotationTranslation(
      this.hingeRotation,
      translation,
      this.hingeLocal,
    );
  }

  destroy(): void {
    for (const id of [...this.visuals.keys()]) this.remove(id);
  }
}
