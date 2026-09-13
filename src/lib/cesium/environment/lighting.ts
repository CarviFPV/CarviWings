"use client";

/**
 * Sky, sun and exposure.
 *
 * Time of day is set by putting Cesium's clock at the right instant — a solar
 * hour for a preset, a real date and time for a mission that sets one — and
 * letting it compute the sun; the simulation works out how much daylight that
 * means for itself (see `sim/environment/solar.ts`) so gameplay never has to
 * ask the renderer what time it is.
 *
 * Exposure is then applied on top. Cesium's day/night terminator alone would
 * leave the night side of the globe pure black — accurate, and unflyable — so
 * the terrain shading keeps an ambient floor and the imagery is graded down to
 * a dim, desaturated, cool cast instead. Night is unmistakably night, and you
 * can still see the ridge you are about to hit.
 *
 * The fog is here too, and it is the other half of the same job: how far the
 * world reaches. It is graded once per frame rather than with the light,
 * because it has to undo a term Cesium works out from where the camera is
 * pointing — see `applyFog`.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "../loadCesium";
import { clamp, lerp } from "@/sim/math/scalar";
import type {
  MissionClock,
  TimeOfDayProfile,
  WeatherProfile,
} from "@/sim/environment/types";
import {
  fogExtinctionFor,
  fogginess,
  missionStartTime,
  visibilityForExtinction,
} from "@/sim/environment/types";

/**
 * Places the clock so the sun sits where the chosen time of day implies.
 *
 * A mission carrying a date and time is placed at that instant instead, which
 * is the whole of what "the real sun" costs here: the scene clock is the only
 * thing that decides where Cesium puts the sun, and the simulation derives its
 * own daylight from the same clock.
 */
export function applyTimeOfDay(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
  time: TimeOfDayProfile,
  longitude: number,
  clock?: MissionClock,
): void {
  const start = missionStartTime(time, longitude, clock);
  viewer.clock.currentTime = cesium.JulianDate.fromDate(start);
  viewer.clock.multiplier = time.clockMultiplier;
  viewer.clock.clockRange = cesium.ClockRange.UNBOUNDED;
  viewer.clock.shouldAnimate = true;
}

/** The UTC instant Cesium's clock is currently showing. */
export function clockDate(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
): Date {
  return cesium.JulianDate.toDate(viewer.clock.currentTime);
}

export interface LightingInputs {
  readonly weather: WeatherProfile;
  /** 0 = full night, 1 = full daylight. */
  readonly daylight: number;
  /**
   * How bright the sky is from a lightning discharge right now, 0..1.
   *
   * A flash lights the whole scene from above, so it lifts the terrain
   * exposure and the sky together rather than being drawn as an object. At
   * night that is the difference between a storm you can see and a black
   * screen with rain on it.
   */
  readonly flash?: number;
}

export function applyLighting(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
  baseLayer: Cesium.ImageryLayer | undefined,
  inputs: LightingInputs,
): void {
  const scene = viewer.scene;
  const globe = scene.globe;
  const { weather, daylight } = inputs;
  const flash = clamp(inputs.flash ?? 0, 0, 1);

  // --- Terrain exposure ----------------------------------------------------
  const light = lerp(0.34, 1, daylight);
  // A discharge is worth far more in the dark than at noon: at night it is the
  // only light there is, in daylight it is a flicker on an already-lit world.
  const strike = flash * lerp(1.6, 0.35, daylight);
  const exposure = weather.brightness * light * (1 + strike);

  if (baseLayer) {
    baseLayer.brightness = exposure;
    baseLayer.saturation = weather.saturation * lerp(0.45, 1, daylight);
    // A cool cast after dark, and lifted gamma so shadows stay readable.
    baseLayer.hue = -0.07 * (1 - daylight);
    baseLayer.gamma = lerp(1.3, 1, daylight);
    baseLayer.contrast = lerp(1.12, 1, daylight);
  }

  // Keeps sun-direction hillshading during the day while giving the night side
  // an ambient floor instead of collapsing to black.
  globe.enableLighting = true;
  globe.dynamicAtmosphereLighting = true;
  globe.dynamicAtmosphereLightingFromSun = true;
  globe.vertexShadowDarkness = lerp(0.55, 0.22, daylight) * (1 - 0.6 * flash);
  globe.lambertDiffuseMultiplier = lerp(0.6, 1, daylight);

  // --- Sky -----------------------------------------------------------------
  //
  // Both of these are read off the weather rather than off which preset it is,
  // because a sky can now be assembled by hand or decoded from a report and
  // have no preset behind it at all. A whiteout is a visibility, not a name.
  // It is also a matter of degree: `murk` grades the whole way in rather than
  // switching on under some threshold, so three kilometres is already part of
  // the way towards the flat white of five hundred metres.
  const murk = fogginess(weather.visibilityM);
  const foggy = murk > 0.25;
  const overcast = weather.cloudCoverage > 0.6;

  // The ground atmosphere is what tints Cesium's fog. Switching it off in fog
  // leaves the fog colour unlit and the terrain reads as black rather than as
  // a whiteout, so it stays on and is graded instead.
  globe.showGroundAtmosphere = true;
  globe.atmosphereBrightnessShift =
    lerp(overcast ? -0.2 : 0, 0.15, murk) + strike * 0.6;
  globe.atmosphereSaturationShift = -(1 - weather.saturation) * 0.6;

  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = !foggy;
    scene.skyAtmosphere.brightnessShift =
      (weather.brightness - 1) * 0.7 + strike * 0.8;
    scene.skyAtmosphere.saturationShift = -(1 - weather.saturation) * 0.5;
  }
  if (scene.skyBox) {
    // Stars are visible once the sun is well down, but not through fog or a
    // solid overcast.
    scene.skyBox.show = !foggy && weather.cloudCoverage < 0.9;
  }
  if (scene.sun) scene.sun.show = weather.cloudCoverage < 0.6 && !foggy;
  if (scene.moon) scene.moon.show = !foggy;
  scene.sunBloom =
    weather.cloudCoverage < 0.35 && !foggy && daylight > 0.2;

  // Beyond the far plane the background shows through, so it has to match the
  // weather or fog reads as a hard edge instead of a whiteout.
  const ground = lerp(0.05, 0.62, daylight) * weather.brightness * (1 + strike * 2);
  scene.backgroundColor = new cesium.Color(
    ground * 0.92,
    ground * 0.95,
    ground,
    1,
  );
}

export interface FogInputs {
  readonly weather: WeatherProfile;
  /** 0 = full night, 1 = full daylight. */
  readonly daylight: number;
  /** True while the camera is inside the cloud layer. */
  readonly inCloud: boolean;
  /** False disables fog entirely. */
  readonly effectsEnabled: boolean;
  /** Visible distance in kilometres, from the graphics settings. */
  readonly viewDistanceKm: number;
}

/**
 * The blend the fog has to have reached at the visibility distance.
 *
 * The air is given the extinction that takes 95% of a ridge's contrast by that
 * distance, so the fog has to have taken 95% of the ridge with it. Otherwise
 * the two disagree about what the number in the weather panel meant.
 */
const FOG_AT_VISIBILITY = 0.95;
/** Cesium's fog is `1 - exp(-E)`; this is the `E` that blend asks for. */
const FOG_EXPONENT = -Math.log(1 - FOG_AT_VISIBILITY);
/** The visual scalar the density is sized around — Cesium's own default. */
const NOMINAL_VISUAL_DENSITY = 0.15;
/** The horizon fade a level aircraft with a tilted lens flies most of. */
const NOMINAL_HORIZON_FADE = 0.85;
/** How near the inside of a cloud is allowed to pull the terrain culling. */
const IN_CLOUD_CULL_FLOOR = 3000;
/** What `distance × density` comes to at the visibility, at that scalar. */
const NOMINAL_SCALED_VISIBILITY = solveProduct(
  FOG_EXPONENT / (NOMINAL_VISUAL_DENSITY * (1 + NOMINAL_VISUAL_DENSITY)),
);

/**
 * Fog, aimed at a distance rather than at a look.
 *
 * Fog is the only thing that limits how far the world is visible. Clipping the
 * frustum would be cheaper, but it also cuts away the atmosphere shell and
 * turns the daytime sky black, so distance is bought with density instead.
 *
 * Cesium's fog is a curve in distance whose density it then scales by the
 * camera's height above the *ellipsoid* and fades out as the camera turns away
 * from the horizon. Left to itself that is why a sky that said five hundred
 * metres still showed the far side of the valley: fly a ridge two thousand
 * metres above the sea and the air is thinned several-fold for a reason no
 * pilot would recognise, and tilt the lens up the way an FPV camera is tilted
 * and a good part of what is left goes with it. What was left of the fog then
 * read as the terrain quietly going darker rather than as air.
 *
 * So none of it is left to Cesium:
 *
 *   - **the height falloff is switched off.** In this simulator visibility is
 *     a property of the airmass — the same one the AI and the video link are
 *     flown against — and it does not improve because the mountain is tall.
 *   - **the density is solved backwards out of Cesium's own curve**, so the
 *     fog is all but closed at exactly the visibility the weather reports.
 *   - **the horizon fade is cancelled every frame** through
 *     `visualDensityScalar`, which the fog shader reads and the tile culling
 *     does not. The density the terrain LOD sees therefore only moves when the
 *     weather does: a pitching aircraft never re-decides how detailed the
 *     valley is, which is the one way this could have cost frames. The inside
 *     of a cloud is carried the same way, for the same reason.
 *
 * Thicker air is *cheaper*, not dearer — Cesium culls terrain it would draw in
 * full fog and coarsens what is left — so low visibility buys frames back.
 */
export function applyFog(viewer: Cesium.Viewer, inputs: FogInputs): void {
  const scene = viewer.scene;
  const fog = scene.fog;
  fog.enabled = inputs.effectsEnabled;
  if (!inputs.effectsEnabled) return;

  const { weather, daylight } = inputs;
  // The view-distance setting is a cap on the weather rather than a multiple
  // of it: 10 km means the world ends at ten kilometres, whatever the sky
  // says, and a clear day is left alone at the settings most people fly.
  const clearAir = visibilityForExtinction(
    Math.max(
      weather.fogExtinction,
      fogExtinctionFor(Math.max(inputs.viewDistanceKm, 1) * 1000),
    ),
  );
  const visibility = inputs.inCloud
    ? Math.min(clearAir, visibilityForExtinction(weather.inCloudExtinction))
    : clearAir;
  // A deck is flown through in seconds, and terrain culled for those seconds
  // is terrain fetched again on the way out — the one thing here that could
  // hand back a stutter. So the density the culling reads is held to the air
  // outside the cloud, or to a few kilometres, whichever is nearer, and the
  // thickness of the cloud itself is carried by the visual scalar alone.
  const culled = Math.max(visibility, Math.min(clearAir, IN_CLOUD_CULL_FLOOR));

  fog.heightScalar = 1;
  fog.heightFalloff = 0;
  const density = NOMINAL_SCALED_VISIBILITY / (culled * NOMINAL_HORIZON_FADE);
  fog.density = density;
  fog.visualDensityScalar = visualDensityFor(
    visibility * density * horizonFade(scene.camera),
  );

  // `minimumBrightness` is the floor the fog colour is lit to: Cesium darkens
  // it by how high the sun is, which with a low floor turns haze into
  // blackness on exactly the mornings and evenings it should be brightest.
  const murk = fogginess(weather.visibilityM);
  fog.minimumBrightness = lerp(
    lerp(0.04, 0.42, daylight),
    lerp(0.16, 0.78, daylight),
    murk,
  );
  fog.screenSpaceErrorFactor = lerp(2, 4, murk);
}

/**
 * The positive `x` with `x * (x + 1) = value`.
 *
 * Cesium's fog is `1 - exp(-m(1 + m) · s(s + 1))` for a scaled distance `s`
 * and a visual scalar `m` — the same shape in both unknowns, so this solves it
 * for whichever of the two the other one is already known.
 */
function solveProduct(value: number): number {
  return (Math.sqrt(1 + 4 * Math.max(value, 0)) - 1) / 2;
}

/**
 * The visual scalar that closes the fog at a scaled visibility distance.
 *
 * Cesium ships 0.15 and the range it is bounded to here is far wider, which is
 * deliberate: a large scalar is what carries a thickness the density is not
 * allowed to have, and the curve it draws is the *better* one. The fog is zero
 * at zero distance whatever the scalar is, and the bigger it gets the more the
 * approach to the visibility straightens into the exponential decay real air
 * has, rather than the flat start Cesium's default draws.
 */
function visualDensityFor(scaledVisibility: number): number {
  const product = Math.max(scaledVisibility * (scaledVisibility + 1), 1e-6);
  return clamp(solveProduct(FOG_EXPONENT / product), 0.05, 12);
}

/**
 * How much of the fog Cesium will leave once it has faded it to the horizon.
 *
 * It thins its fog by how far the camera is turned away from level, which is
 * the term this cancels: the same dot product, off the camera as it stands a
 * moment before the frame it will be applied to.
 */
function horizonFade(camera: Cesium.Camera): number {
  const position = camera.positionWC;
  const direction = camera.directionWC;
  const radius = Math.hypot(position.x, position.y, position.z);
  if (radius <= 0) return 1;
  const up = Math.abs(
    (direction.x * position.x +
      direction.y * position.y +
      direction.z * position.z) /
      radius,
  );
  return clamp(1 - up, 1e-3, 1);
}
