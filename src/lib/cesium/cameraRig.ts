"use client";

/**
 * Flight cameras.
 *
 * Cesium's camera is driven directly rather than through an entity tracker, so
 * the view is exactly where the flight model says it is with no interpolation
 * lag between the aircraft and what the pilot sees.
 *
 * Four modes:
 *  - FPV    — bolted to the camera mount on the nose, tilted up the way a pilot
 *             would angle it, with restrained vibration that scales with power
 *             and airspeed.
 *  - CHASE  — a smoothed third-person follow that keeps the horizon stable.
 *  - GROUND — the pilot standing on the field, watching the model. The eyes do
 *             not move; only the head turns.
 *  - FREE   — hands Cesium's own controls back to the mouse, for debugging.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "./loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { AircraftState } from "@/sim/flight/state";
import { forwardAxis, rotateVector, upAxis } from "@/sim/math/quat";
import { clamp, damp, DEG_TO_RAD, RAD_TO_DEG } from "@/sim/math/scalar";
import type { Vec3 } from "@/sim/math/vec3";
import * as V from "@/sim/math/vec3";
import type { MeshKind } from "@/sim/render/aircraftMesh";
import { MESH_KIND, meshOfKind } from "@/sim/render/aircraftMesh";
import { viewMagnification } from "@/sim/render/detailBudget";
import type { ViewDetail } from "./viewDetail";

export const CAMERA_MODE = {
  Fpv: "FPV",
  Chase: "CHASE",
  /** Line of sight from where the pilot is standing. */
  Ground: "GROUND",
  Free: "FREE",
} as const;

export type CameraMode = (typeof CAMERA_MODE)[keyof typeof CAMERA_MODE];

export interface CameraSettings {
  /** Horizontal field of view for the FPV camera, degrees. */
  fpvFieldOfView: number;
  /** 0 disables shake entirely. */
  cameraShake: number;
  /** Chase camera distance behind the aircraft, metres. */
  chaseDistance: number;
  /** Chase camera height above the aircraft, metres. */
  chaseHeight: number;
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  fpvFieldOfView: 100,
  cameraShake: 0.6,
  chaseDistance: 11,
  chaseHeight: 3.2,
};

/**
 * Where a pilot watching a model looks, and how tightly.
 *
 * A head turns fast but not instantly, and the eye does something a fixed
 * field of view cannot: it picks a model out of the sky at half a kilometre
 * that would be two pixels across on a screen at any honest angle. So the view
 * narrows onto the aircraft as it goes out, the way attention does, and opens
 * back up as it comes home — never past what somebody standing there could
 * take in at once.
 */
const GROUND_MAX_FOV = 65;
const GROUND_MIN_FOV = 15;
/** Fraction of the view width the aircraft is held at while it can be. */
const GROUND_APPARENT_SIZE = 0.02;
/** Smoothing on the head turn, and on the eye settling to a new distance. */
const GROUND_TURN_SMOOTHING = 0.002;
const GROUND_ZOOM_SMOOTHING = 0.06;

const _bodyOffset = V.vec3();
const _worldOffset = V.vec3();
const _position = V.vec3();
const _direction = V.vec3();
const _up = V.vec3();
const _right = V.vec3();
const _fwd = V.vec3();
const _bodyUp = V.vec3();
const _desired = V.vec3();
const _lookAt = V.vec3();
const _ecef = V.vec3();

export class CameraRig {
  private readonly cesium: CesiumModule;
  private readonly viewer: Cesium.Viewer;
  private readonly frame: EnuFrame;

  private mode: CameraMode = CAMERA_MODE.Fpv;
  private settings: CameraSettings = { ...DEFAULT_CAMERA_SETTINGS };

  /**
   * Where the FPV camera sits on the aircraft being flown, and how far up it
   * looks. Both belong to the airframe — a quadcopter's camera is at the front
   * of a 160 mm frame looking twenty-five degrees up, a wing's is on the nose
   * of a 1.4 m one looking twelve — so they move when the aircraft does.
   */
  private readonly fpvOffset: Vec3;
  private fpvTilt: number;

  /** Span of the airframe being flown, which is how big it looks from here. */
  private airframeSpan: number;

  /**
   * Where the pilot is standing, in local ENU metres, or null when nobody is:
   * every flight but the RC ground view begins with the aircraft already up
   * and the pilot wherever they like.
   */
  private station: Vec3 | null = null;
  /** The line of sight actually being looked along, smoothed. */
  private readonly groundDirection = V.vec3(0, 1, 0);
  private groundFieldOfView = GROUND_MAX_FOV;
  private groundInitialised = false;

  /**
   * The world's detail budget, where there is one to hold.
   *
   * The ground view is the only camera that zooms, so it is the only one whose
   * zoom the world behind it has to be protected from: see `viewDetail.ts`.
   */
  private detail: ViewDetail | null = null;

  /** Smoothed chase camera position in local ENU metres. */
  private readonly chasePosition = V.vec3();
  private chaseInitialised = false;
  private shakeTime = 0;

  private readonly destination: Cesium.Cartesian3;
  private readonly directionEcef: Cesium.Cartesian3;
  private readonly upEcef: Cesium.Cartesian3;

  /**
   * The pose actually applied to the camera this frame, in local ENU. The HUD
   * needs it to work out where a target sits relative to the view.
   */
  readonly pose = {
    position: V.vec3(),
    direction: V.vec3(),
    up: V.vec3(),
    right: V.vec3(),
  };

  constructor(cesium: CesiumModule, viewer: Cesium.Viewer, frame: EnuFrame) {
    this.cesium = cesium;
    this.viewer = viewer;
    this.frame = frame;

    this.fpvOffset = V.vec3();
    this.fpvTilt = 0;
    this.airframeSpan = 1;
    this.setAirframe(MESH_KIND.Wing);

    this.destination = new cesium.Cartesian3();
    this.directionEcef = new cesium.Cartesian3();
    this.upEcef = new cesium.Cartesian3();
  }

  /**
   * Puts the camera where it sits on this kind of aircraft, and tells it how
   * big the aircraft is — which is the only thing the ground view can judge
   * distance by.
   */
  setAirframe(kind: MeshKind, span?: number): void {
    const mesh = meshOfKind(kind);
    this.airframeSpan = span && span > 0 ? span : mesh.referenceSpan;
    // Scaled with the airframe, the same way the renderer scales the geometry
    // it came from. One set of geometry can serve several sizes of the same
    // aeroplane — the Skyeye series is one mesh between 2.6 and 6 metres — and
    // the camera has to move to the nose of the one actually being flown
    // rather than sitting where the nose of the drawn one was.
    const scale = this.airframeSpan / mesh.referenceSpan;
    V.set(
      this.fpvOffset,
      mesh.fpvCamera.offset[0] * scale,
      mesh.fpvCamera.offset[1] * scale,
      mesh.fpvCamera.offset[2] * scale,
    );
    this.fpvTilt = mesh.fpvCamera.tiltDegrees * DEG_TO_RAD;
  }

  /**
   * Hands the rig the detail budget its zoom is spent against.
   *
   * Optional: a rig without one still zooms, it simply lets the renderer answer
   * the zoom with tiles, which is what every camera did before the ground view
   * had an eye that narrowed.
   */
  setDetail(detail: ViewDetail | null): void {
    this.detail = detail;
    this.holdDetail();
  }

  /**
   * Puts the pilot on the ground at a point in the local frame, or takes them
   * off it again with null. Only a flight that has one offers the ground view.
   */
  setStation(position: Vec3 | null): void {
    if (position === null) {
      this.station = null;
      if (this.mode === CAMERA_MODE.Ground) this.setMode(CAMERA_MODE.Fpv);
      return;
    }
    if (this.station === null) this.station = V.vec3();
    V.copy(this.station, position);
  }

  /** True when there is somebody on the ground to watch the flight from. */
  get hasStation(): boolean {
    return this.station !== null;
  }

  getMode(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (mode === CAMERA_MODE.Ground && this.station === null) return;
    if (this.mode === mode) return;
    this.mode = mode;
    this.chaseInitialised = false;
    this.groundInitialised = false;
    // The free camera is the only mode where the mouse may move the view.
    this.viewer.scene.screenSpaceCameraController.enableInputs =
      mode === CAMERA_MODE.Free;
  }

  /**
   * The next view round.
   *
   * Two views on a flight the pilot is not standing at, three on one they
   * are: from inside the aircraft, from behind it, and from the field.
   */
  toggle(): CameraMode {
    if (this.mode === CAMERA_MODE.Fpv) this.setMode(CAMERA_MODE.Chase);
    else if (this.mode === CAMERA_MODE.Chase && this.station !== null)
      this.setMode(CAMERA_MODE.Ground);
    else this.setMode(CAMERA_MODE.Fpv);
    return this.mode;
  }

  setSettings(settings: Partial<CameraSettings>): void {
    Object.assign(this.settings, settings);
  }

  /** True when the aircraft model should be hidden — you cannot see your own airframe from inside it. */
  get hidesOwnAircraft(): boolean {
    return this.mode === CAMERA_MODE.Fpv;
  }

  /**
   * Smooth, deterministic vibration. A sum of incommensurate sines reads as
   * engine buzz without the twitchiness of per-frame randomness.
   */
  private shakeAmount(state: AircraftState, axis: number): number {
    const t = this.shakeTime;
    const a = Math.sin(t * (31.7 + axis * 4.1));
    const b = Math.sin(t * (17.3 + axis * 2.7) + 1.7);
    const c = Math.sin(t * (7.1 + axis) + 3.4);
    return (a * 0.5 + b * 0.33 + c * 0.17);
  }

  update(state: AircraftState, dt: number): void {
    if (this.mode === CAMERA_MODE.Free) {
      // The mouse owns the camera here, so read the pose back out of Cesium
      // instead of writing it, and keep the HUD working either way.
      this.readPoseFromCamera();
      this.holdDetail();
      return;
    }
    this.shakeTime += dt;
    if (this.mode === CAMERA_MODE.Fpv) this.updateFpv(state, dt);
    else if (this.mode === CAMERA_MODE.Ground) this.updateGround(state, dt);
    else this.updateChase(state, dt);
    this.holdDetail();
  }

  /**
   * Tells the world how much it is being magnified onto the screen.
   *
   * Only the eye on the field narrows; every other camera holds one angle for
   * the whole flight, so every other camera magnifies nothing and the world is
   * drawn at exactly the detail the quality preset asked for. Measured against
   * the widest the eye ever opens, so the flight the pilot is used to — a model
   * close in, the view wide — is the one that is unchanged.
   */
  private holdDetail(): void {
    if (!this.detail) return;
    this.detail.setMagnification(
      this.mode === CAMERA_MODE.Ground
        ? viewMagnification(this.groundFieldOfView, GROUND_MAX_FOV)
        : 1,
    );
  }

  private updateFpv(state: AircraftState, dt: number): void {
    const settings = this.settings;

    rotateVector(_worldOffset, state.orientation, this.fpvOffset);
    V.add(_position, state.position, _worldOffset);

    // Look along the nose, tilted up the way an FPV camera is mounted.
    V.set(_bodyOffset, Math.cos(this.fpvTilt), 0, Math.sin(this.fpvTilt));
    rotateVector(_direction, state.orientation, _bodyOffset);
    V.set(_bodyOffset, -Math.sin(this.fpvTilt), 0, Math.cos(this.fpvTilt));
    rotateVector(_up, state.orientation, _bodyOffset);

    // Vibration: scales with power and airspeed, hard-capped so it never fights
    // the pilot for control of the horizon.
    const intensity =
      settings.cameraShake *
      clamp(state.throttle * 0.6 + state.airspeed / 90, 0, 1.2) *
      (state.stalled ? 1.8 : 1);
    if (intensity > 0.001) {
      const angular = 0.0035 * intensity;
      V.addScaled(_direction, _direction, _up, this.shakeAmount(state, 0) * angular);
      upAxis(_bodyUp, state.orientation);
      V.cross(_right, _direction, _up);
      V.normalize(_right, _right);
      V.addScaled(_direction, _direction, _right, this.shakeAmount(state, 1) * angular);
      V.addScaled(_position, _position, _up, this.shakeAmount(state, 2) * 0.008 * intensity);
    }

    this.applyView(_position, _direction, _up);

    this.setFieldOfView(clamp(settings.fpvFieldOfView, 50, 140));
    void dt;
  }

  private updateChase(state: AircraftState, dt: number): void {
    const settings = this.settings;
    forwardAxis(_fwd, state.orientation);

    // Sit behind and above the aircraft, using world up rather than body up so
    // the horizon does not roll with the aircraft.
    V.copy(_desired, state.position);
    V.addScaled(_desired, _desired, _fwd, -settings.chaseDistance);
    _desired.z += settings.chaseHeight;

    if (!this.chaseInitialised) {
      V.copy(this.chasePosition, _desired);
      this.chaseInitialised = true;
    } else {
      // Critically-damped-feeling follow: fast enough to keep up in a hard
      // turn, slow enough to read as a chase plane.
      this.chasePosition.x = damp(this.chasePosition.x, _desired.x, 0.0008, dt);
      this.chasePosition.y = damp(this.chasePosition.y, _desired.y, 0.0008, dt);
      this.chasePosition.z = damp(this.chasePosition.z, _desired.z, 0.0015, dt);
    }

    // Aim slightly ahead of the aircraft so it sits below centre in the frame.
    V.copy(_lookAt, state.position);
    V.addScaled(_lookAt, _lookAt, _fwd, 4);
    V.subtract(_direction, _lookAt, this.chasePosition);
    V.normalize(_direction, _direction);

    // Blend a little body roll into the camera so hard banks still read.
    upAxis(_bodyUp, state.orientation);
    V.set(_up, 0, 0, 1);
    V.lerpVec3(_up, _up, _bodyUp, 0.25);
    V.cross(_right, _direction, _up);
    if (V.lengthSquared(_right) < 1e-8) V.set(_up, 0, 0, 1);

    this.applyView(this.chasePosition, _direction, _up);

    this.setFieldOfView(70);
  }

  /**
   * The pilot on the field.
   *
   * The camera does not move at all: it sits at head height over the spot the
   * aircraft was launched from, and the only thing that changes is where it is
   * looking. That is the whole point of the view — everything a line-of-sight
   * pilot finds hard comes from the model being far away, small, and pointing
   * at them half the time, and none of it survives a camera that follows the
   * aircraft around.
   */
  private updateGround(state: AircraftState, dt: number): void {
    const station = this.station;
    if (!station) return;

    V.subtract(_desired, state.position, station);
    const range = V.length(_desired);
    if (range > 1e-3) {
      V.scale(_desired, _desired, 1 / range);
      if (!this.groundInitialised) {
        V.copy(this.groundDirection, _desired);
        this.groundInitialised = true;
      } else {
        // The head turns quickly, but it does turn rather than snap: a model
        // crossing at fifty metres pulls the view round, it does not teleport
        // it.
        this.groundDirection.x = damp(
          this.groundDirection.x,
          _desired.x,
          GROUND_TURN_SMOOTHING,
          dt,
        );
        this.groundDirection.y = damp(
          this.groundDirection.y,
          _desired.y,
          GROUND_TURN_SMOOTHING,
          dt,
        );
        this.groundDirection.z = damp(
          this.groundDirection.z,
          _desired.z,
          GROUND_TURN_SMOOTHING,
          dt,
        );
      }
    }
    V.normalize(_direction, this.groundDirection);

    // The horizon never rolls: the pilot is standing on it.
    V.set(_up, 0, 0, 1);
    if (Math.abs(_direction.z) > 0.999) V.set(_up, 0, 1, 0);

    this.applyView(station, _direction, _up);

    // How much of the view the aircraft fills at this range decides how wide
    // the view is, so a model on the far side of the field stays something the
    // pilot can actually see.
    const apparent =
      2 * Math.atan(this.airframeSpan / (2 * Math.max(range, 1))) * RAD_TO_DEG;
    const wanted = clamp(
      apparent / GROUND_APPARENT_SIZE,
      GROUND_MIN_FOV,
      GROUND_MAX_FOV,
    );
    this.groundFieldOfView = this.groundInitialised
      ? damp(this.groundFieldOfView, wanted, GROUND_ZOOM_SMOOTHING, dt)
      : wanted;
    this.setFieldOfView(this.groundFieldOfView);
  }

  private setFieldOfView(degrees: number): void {
    const frustum = this.viewer.camera.frustum;
    if (!(frustum instanceof this.cesium.PerspectiveFrustum)) return;
    const radians = degrees * DEG_TO_RAD;
    if (frustum.fov === undefined || Math.abs(frustum.fov - radians) > 1e-4) {
      frustum.fov = radians;
    }
  }

  /** Converts a local ENU pose into ECEF and hands it to Cesium. */
  private applyView(position: Vec3, direction: Vec3, up: Vec3): void {
    // Re-orthogonalise: shake and smoothing can nudge the basis out of square.
    V.normalize(_direction, direction);
    V.cross(_right, _direction, up);
    if (V.lengthSquared(_right) < 1e-9) {
      V.set(_right, 1, 0, 0);
      V.cross(_right, _direction, _right);
    }
    V.normalize(_right, _right);
    V.cross(_up, _right, _direction);
    V.normalize(_up, _up);

    this.frame.localToEcef(position, _ecef);
    this.destination.x = _ecef.x;
    this.destination.y = _ecef.y;
    this.destination.z = _ecef.z;

    this.frame.enuVectorToEcef(_direction, _ecef);
    this.directionEcef.x = _ecef.x;
    this.directionEcef.y = _ecef.y;
    this.directionEcef.z = _ecef.z;

    this.frame.enuVectorToEcef(_up, _ecef);
    this.upEcef.x = _ecef.x;
    this.upEcef.y = _ecef.y;
    this.upEcef.z = _ecef.z;

    this.viewer.camera.setView({
      destination: this.destination,
      orientation: {
        direction: this.directionEcef,
        up: this.upEcef,
      },
    });

    V.copy(this.pose.position, position);
    V.copy(this.pose.direction, _direction);
    V.copy(this.pose.up, _up);
    V.copy(this.pose.right, _right);
  }

  /** Converts Cesium's own camera back into the local ENU frame. */
  private readPoseFromCamera(): void {
    const camera = this.viewer.camera;
    _ecef.x = camera.positionWC.x;
    _ecef.y = camera.positionWC.y;
    _ecef.z = camera.positionWC.z;
    this.frame.ecefToLocal(_ecef, this.pose.position);

    _ecef.x = camera.directionWC.x;
    _ecef.y = camera.directionWC.y;
    _ecef.z = camera.directionWC.z;
    this.frame.ecefVectorToEnu(_ecef, this.pose.direction);

    _ecef.x = camera.upWC.x;
    _ecef.y = camera.upWC.y;
    _ecef.z = camera.upWC.z;
    this.frame.ecefVectorToEnu(_ecef, this.pose.up);

    V.cross(this.pose.right, this.pose.direction, this.pose.up);
    V.normalize(this.pose.right, this.pose.right);
  }
}
