"use client";

/**
 * Rain.
 *
 * A single full-screen post-process pass. Rain is drawn in the fragment shader
 * from hashed noise rather than as particles, so heavy rain costs one extra
 * pass over the framebuffer regardless of how hard it is coming down — no
 * particle systems, no DOM elements, nothing per-drop on the CPU.
 *
 * What separates rain from snow on screen is not the colour of the drops, it is
 * their geometry: rain is a long, thin, fast streak leaning into the direction
 * of flight, and the whole field fans out of the point the aircraft is heading
 * for. That geometry is computed from the camera's own motion — differenced
 * frame to frame, so it works in every camera mode — by
 * `sim/environment/precipitation.ts`, and arrives here as uniforms. Slow down
 * and the same shader draws near-vertical streaks; dive and they lengthen and
 * turn to follow the flight path.
 *
 * The pass also darkens and desaturates the scene, because rain that only adds
 * bright streaks looks like scratches on the lens rather than weather.
 *
 * Snow is the same pass with the physics changed rather than a second one. A
 * flake falls at a metre or so a second instead of seven, which the same
 * relative-motion maths turns into a field that hangs almost still when the
 * aircraft is slow and streaks horizontally when it is fast — exactly what snow
 * does through a canopy. The shader is told which it is drawing so a flake can
 * be a short round dab rather than a hairline, and so the scene is not darkened
 * the way rain darkens it: snow is the brightest weather there is.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "../loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import { clamp } from "@/sim/math/scalar";
import type { Vec3 } from "@/sim/math/vec3";
import { vec3 } from "@/sim/math/vec3";
import { rainStreakField } from "@/sim/environment/precipitation";

const RAIN_SHADER = `
uniform sampler2D colorTexture;
uniform float intensity;
uniform float phase;
uniform vec2 focus;
uniform vec2 axis;
uniform float radial;
uniform float stretch;
// 0 draws rain, 1 draws snow.
uniform float flake;
in vec2 v_textureCoordinates;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/**
 * One depth layer of drops.
 *
 * The frame is cut into tall, narrow cells laid along the streak direction;
 * each cell either carries one drop or is empty, which is what keeps the
 * spacing irregular. A drop is a hairline that is brightest at its head and
 * fades down its tail.
 */
float dropLayer(vec2 uv, vec2 dir, float columns, float rows, float streak, float t, float seed) {
  vec2 side = vec2(-dir.y, dir.x);
  vec2 p = vec2(dot(uv, side) * columns, dot(uv, dir) * rows);

  float column = floor(p.x);
  float jitter = hash21(vec2(column, seed));
  // Drops sit anywhere across their column rather than down the middle of it.
  float offset = (hash21(vec2(column, seed + 3.7)) - 0.5) * 0.7;
  float across = abs(fract(p.x) - 0.5 - offset);
  // A raindrop is a hairline; a flake is a soft dab several times as wide.
  float body = smoothstep(mix(0.05, 0.16, flake), 0.0, across);
  if (body <= 0.0) return 0.0;

  // Drops in a column fall together, at a rate of their own.
  float travel = p.y + t * (1.0 + jitter * 0.55) + jitter * 17.0;
  float cell = floor(travel);
  float along = fract(travel);
  // Roughly a third of the cells are empty, so the field never reads as a grid.
  if (hash21(vec2(column * 1.7, cell + seed)) > 0.66) return 0.0;

  float head = smoothstep(streak * 0.3, 0.0, along);
  float tail = smoothstep(streak, 0.0, along);
  return body * (tail * 0.55 + head * 0.45);
}

void main(void) {
  vec4 scene = texture(colorTexture, v_textureCoordinates);

  if (intensity <= 0.001) {
    out_FragColor = scene;
    return;
  }

  vec2 resolution = czm_viewport.zw;
  vec2 uv = (gl_FragCoord.xy * 2.0 - resolution) / max(resolution.y, 1.0);

  // Streaks run along the line from the vanishing point through this pixel,
  // and fall back to a single leaning direction when there is no useful
  // vanishing point — flying slowly, or straight across the weather.
  vec2 offset = uv - focus;
  float radius = length(offset);
  vec2 outward = radius > 1e-4 ? offset / radius : axis;
  vec2 dir = normalize(mix(axis, outward * sign(radial), abs(radial)));

  // Drops near the point being flown at are coming almost straight at the
  // camera, so they are short and sparse; at the edge of the frame they are
  // long. With no vanishing point this collapses to a uniform field.
  float fan = mix(1.0, smoothstep(0.0, 0.55, radius), abs(radial));
  float wet = 0.35 + 0.65 * intensity;
  float streaks = 0.0;

  // Three depth layers: near drops are fatter, faster and fewer.
  for (int layer = 0; layer < 3; layer++) {
    float depth = 1.0 + float(layer) * 0.9;
    float columns = 16.0 * depth;
    float rows = 2.2 * depth;
    float streak = clamp(0.42 * stretch * fan / depth, 0.02, 0.85) * mix(1.0, 0.4, flake);
    // The fall is integrated on the CPU so that changing speed slides the
    // drops along rather than reshuffling the whole field.
    streaks += dropLayer(uv, dir, columns, rows, streak, phase / depth, float(layer) * 31.0)
      * (1.25 / depth);
  }

  streaks = clamp(streaks, 0.0, 1.0) * wet * clamp(intensity * 1.6, 0.0, 1.0);

  // Wet air: darker, flatter, and cooler than the same scene dry. Snow flattens
  // the scene the same way but barely darkens it — falling snow is lit.
  float grey = dot(scene.rgb, vec3(0.299, 0.587, 0.114));
  vec3 damp = mix(scene.rgb, vec3(grey), 0.18 * intensity)
    * (1.0 - 0.2 * intensity * (1.0 - 0.75 * flake));
  vec3 drop = mix(vec3(0.78, 0.83, 0.9), vec3(0.96, 0.97, 1.0), flake);

  out_FragColor = vec4(mix(damp, drop, streaks * mix(0.55, 0.8, flake)), scene.a);
}
`;

/** Terminal fall speed of a raindrop, m/s. */
const RAIN_FALL_SPEED = 7;
/** And of a snowflake, which is the whole difference between the two. */
const SNOW_FALL_SPEED = 1.1;
/** Camera velocity is smoothed over about this long, seconds. */
const VELOCITY_SMOOTHING = 0.12;

const _cameraLocal = vec3();
const _velocity = vec3();
const _right = vec3();
const _up = vec3();
const _forward = vec3();
const _down = vec3();

export class RainEffect {
  private readonly scene: Cesium.Scene;
  private readonly frame: EnuFrame;
  private stage: Cesium.PostProcessStage | null = null;
  private intensity = 0;
  /** 0 draws rain, 1 draws snow. */
  private flake = 0;
  /** Distance the drops have fallen, in cells; integrated, never reset. */
  private phase = 0;
  private stretch = 1;
  private destroyed = false;

  /** Streak geometry, refreshed from the camera every frame it is drawn. */
  private focus: Cesium.Cartesian2;
  private axis: Cesium.Cartesian2;
  private radial = 0;

  /** Camera position on the previous update, for differencing its velocity. */
  private readonly lastCamera = vec3();
  private readonly smoothedVelocity = vec3();
  private hasLastCamera = false;

  constructor(cesium: CesiumModule, scene: Cesium.Scene, frame: EnuFrame) {
    this.scene = scene;
    this.frame = frame;
    this.focus = new cesium.Cartesian2(0, 0);
    this.axis = new cesium.Cartesian2(0, -1);
    try {
      this.stage = scene.postProcessStages.add(
        new cesium.PostProcessStage({
          name: "fpv_rain",
          fragmentShader: RAIN_SHADER,
          uniforms: {
            intensity: () => this.intensity,
            phase: () => this.phase,
            focus: () => this.focus,
            axis: () => this.axis,
            radial: () => this.radial,
            stretch: () => this.stretch,
            flake: () => this.flake,
          },
        }),
      ) as Cesium.PostProcessStage;
      this.stage.enabled = false;
    } catch (error) {
      // A shader that will not compile must cost the flight nothing beyond the
      // rain itself; the weather still reads through fog and exposure.
      console.error("[fpv] rain post-process unavailable", error);
      this.stage = null;
    }
  }

  get available(): boolean {
    return this.stage !== null;
  }

  /**
   * How hard it is coming down, and whether it is frozen.
   *
   * 0 disables the pass outright rather than running it at zero strength.
   */
  setPrecipitation(intensity: number, snow = false): void {
    if (this.destroyed || !this.stage) return;
    this.intensity = clamp(intensity, 0, 1);
    this.flake = snow ? 1 : 0;
    this.stage.enabled = this.intensity > 0.001;
    if (!this.stage.enabled) this.hasLastCamera = false;
  }

  /**
   * Re-aims the streaks at whatever the camera is doing now.
   *
   * The camera is differenced rather than handed the aircraft's velocity, so
   * an orbit or a chase view gets rain that matches the view actually on
   * screen rather than the one the pilot would have from the nose.
   */
  update(wind: Vec3, dt: number): void {
    if (this.destroyed || !this.stage || !this.stage.enabled || dt <= 0) return;

    const camera = this.scene.camera;
    this.frame.ecefToLocal(camera.positionWC, _cameraLocal);

    if (this.hasLastCamera) {
      _velocity.x = (_cameraLocal.x - this.lastCamera.x) / dt;
      _velocity.y = (_cameraLocal.y - this.lastCamera.y) / dt;
      _velocity.z = (_cameraLocal.z - this.lastCamera.z) / dt;
      // A respawn or a camera cut is a jump, not a velocity.
      if (Math.hypot(_velocity.x, _velocity.y, _velocity.z) > 400) {
        _velocity.x = 0;
        _velocity.y = 0;
        _velocity.z = 0;
      }
      const blend = clamp(dt / VELOCITY_SMOOTHING, 0, 1);
      this.smoothedVelocity.x += (_velocity.x - this.smoothedVelocity.x) * blend;
      this.smoothedVelocity.y += (_velocity.y - this.smoothedVelocity.y) * blend;
      this.smoothedVelocity.z += (_velocity.z - this.smoothedVelocity.z) * blend;
    }
    this.lastCamera.x = _cameraLocal.x;
    this.lastCamera.y = _cameraLocal.y;
    this.lastCamera.z = _cameraLocal.z;
    this.hasLastCamera = true;

    // Camera axes come out of Cesium in ECEF; the wind and the fall direction
    // are local, so the whole calculation is done in the local frame.
    _down.x = 0;
    _down.y = 0;
    _down.z = -1;

    const field = rainStreakField({
      right: this.frame.ecefVectorToEnu(camera.rightWC, _right),
      up: this.frame.ecefVectorToEnu(camera.upWC, _up),
      forward: this.frame.ecefVectorToEnu(camera.directionWC, _forward),
      cameraVelocity: this.smoothedVelocity,
      wind,
      down: _down,
      fallSpeed: this.flake > 0.5 ? SNOW_FALL_SPEED : RAIN_FALL_SPEED,
      tanHalfFovY: tanHalfFovY(this.scene),
    });

    this.focus.x = field.focusX;
    this.focus.y = field.focusY;
    this.axis.x = field.axisX;
    this.axis.y = field.axisY;
    this.radial = field.radial;
    this.stretch = clamp(field.speed / 22, 0.45, 2.2);
    // Cells per second, matching the shader's cell height. Snow drifts down at
    // a fraction of the rate, which is most of what sells it as snow.
    const rate = this.flake > 0.5 ? 3.5 + 2 * this.stretch : 12 + 6 * this.stretch;
    this.phase += rate * dt;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.stage && !this.scene.isDestroyed()) {
      this.scene.postProcessStages.remove(this.stage);
    }
    this.stage = null;
  }
}

/** Half the vertical field of view, as a tangent; 60 degrees if unknowable. */
function tanHalfFovY(scene: Cesium.Scene): number {
  const frustum = scene.camera.frustum as { fovy?: number };
  const fovy = typeof frustum.fovy === "number" && frustum.fovy > 0
    ? frustum.fovy
    : Math.PI / 3;
  return Math.tan(fovy / 2);
}
