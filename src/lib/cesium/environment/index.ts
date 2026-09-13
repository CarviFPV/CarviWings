"use client";

/**
 * The environment.
 *
 * Owns everything about the world that is not terrain: where the sun is, how
 * bright it is, what the sky looks like, where the clouds are, whether anything
 * is falling out of them and whether it is thundering. It reads the weather and
 * time-of-day profiles the mission was set up with and applies them to the
 * Cesium scene, and either of them can be replaced while the flight is running.
 *
 * Cloud comes in two forms and this class picks between them: a raymarched
 * volume that can be flown into (`volumetricClouds.ts`), and the older
 * billboard field (`clouds.ts`) kept as the fallback for machines — or shader
 * compilers — that cannot afford the march. Both draw the same decks, so the
 * gameplay side never has to know which one is on screen.
 *
 * A sky is up to three decks rather than one, and each of them has a base, a
 * depth, an amount and a genus. Two things follow from that and are decided
 * here rather than anywhere else:
 *
 *   - **precipitation has a lid.** Rain and snow fall out of cloud, so above
 *     the highest cloud top there is nothing to fall: climb through the deck
 *     and the weather stops, which is exactly what happens in an aircraft.
 *   - **lightning belongs to the cell.** When the weather has a cumulonimbus
 *     in it, strikes are scheduled inside that deck, the scene is lit by the
 *     flash, and the thunder is handed to the caller with the delay the
 *     distance implies.
 *
 * The simulation's own view of the environment — how far you can see, how hard
 * the wind is blowing — lives in `sim/environment`. This class feeds it the two
 * things it cannot work out alone: how much daylight there is right now, and
 * where the decks actually ended up.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "../loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { GraphicsQuality } from "../quality";
import { clamp, DEG_TO_RAD, lerp } from "@/sim/math/scalar";
import type { Vec3 } from "@/sim/math/vec3";
import { vec3 } from "@/sim/math/vec3";
import type {
  MissionClock,
  TimeOfDayProfile,
  WeatherProfile,
} from "@/sim/environment/types";
import { PRECIPITATION } from "@/sim/environment/types";
import type { VisibilityLayer } from "@/sim/environment/visibility";
import type { Strike } from "@/sim/environment/lightning";
import { LightningField, stormActivity } from "@/sim/environment/lightning";
import { daylightFactor, solarPosition } from "@/sim/environment/solar";
import { applyFog, applyLighting, applyTimeOfDay, clockDate } from "./lighting";
import { CloudField } from "./clouds";
import type { CloudDeck } from "./volumetricClouds";
import { VolumetricClouds } from "./volumetricClouds";
import { RainEffect } from "./rain";

export interface EnvironmentOptions {
  readonly weather: WeatherProfile;
  readonly time: TimeOfDayProfile;
  /** The date and time to fly at, when the mission names one. */
  readonly clock?: MissionClock;
  readonly latitude: number;
  readonly longitude: number;
  readonly seed: string;
  readonly viewDistanceKm: number;
  /** Drives how hard the cloud volume is allowed to be marched. */
  readonly quality: GraphicsQuality;
  /** Graphics settings; each may be switched off independently. */
  readonly clouds: boolean;
  /** Raymarched cloud rather than billboards, when the hardware allows it. */
  readonly volumetricClouds: boolean;
  readonly rain: boolean;
  readonly effects: boolean;
  /** How far strikes are scattered around the mission area, metres. */
  readonly stormRadius?: number;
}

export interface EnvironmentToggles {
  clouds?: boolean;
  volumetricClouds?: boolean;
  rain?: boolean;
  effects?: boolean;
  viewDistanceKm?: number;
}

/** Which cloud renderer is actually on screen. */
export type CloudMode = "volumetric" | "billboards" | "off";

/** How often the sun position and scene grading are recomputed. */
const LIGHTING_INTERVAL = 0.25;
/** Side length of the billboard cloud field that follows the aircraft, metres. */
const CLOUD_FIELD_EXTENT = 11000;
/**
 * Cover below which a deck is simply not there.
 *
 * Both cloud renderers have a floor under them — the billboard field lays out
 * a minimum number of puffs whatever it is asked for, and the march is a
 * full-screen pass whether or not it finds anything to draw — so "almost no
 * cloud" is very nearly as expensive as an overcast and looks like neither.
 * Under this a deck is not built at all, which is what makes a cover of zero
 * cost nothing and show nothing.
 */
const EMPTY_SKY = 0.001;
/** How far above the highest cloud top the precipitation has faded out, metres. */
const PRECIPITATION_FADE = 200;
/** Strikes are scattered this far around the aircraft when nothing says else. */
const DEFAULT_STORM_RADIUS = 9000;
/** Still air, for placing a freshly built cloud field without drifting it. */
const NO_WIND = vec3();

const _sunDirection = vec3();
const _sunColour = vec3();
const _skyColour = vec3();
const _windSample = vec3();

export class EnvironmentController {
  private readonly cesium: CesiumModule;
  private readonly viewer: Cesium.Viewer;
  private readonly frame: EnuFrame;
  private readonly baseLayer: Cesium.ImageryLayer | undefined;
  private cloudField: CloudField | null = null;
  private readonly cloudVolume: VolumetricClouds | null;
  private readonly rainEffect: RainEffect;
  private readonly lightning: LightningField;

  private decks: readonly CloudDeck[] = [];
  private weather: WeatherProfile;
  private options: EnvironmentOptions;
  private lightingTimer = LIGHTING_INTERVAL;
  private currentDaylight = 1;
  private currentSunElevation = 45;
  private currentFlash = 0;
  private insideCloud = false;
  private destroyed = false;
  /**
   * Where the wind is read from, when the flight has a wind field yet.
   *
   * Each deck drifts at the wind of its own altitude rather than the wind at
   * the aircraft, so a sheared airmass moves the low deck one way and the high
   * one another. Until the flight hands one over, everything drifts with the
   * single vector `update` was given.
   */
  private windField: { sample(altitudeAgl: number, out: Vec3): Vec3 } | null = null;
  private fallbackWind = vec3();
  /**
   * Where the aircraft was on the last frame that ran.
   *
   * The cloud field is laid out around the player, and the weather can be
   * changed from the pause menu — where no frame is being stepped at all. A
   * rebuilt field would otherwise stay at the frame origin until the pilot
   * resumed, so the last known position is kept to place it straight away.
   */
  private readonly lastPlayerPosition = vec3();

  constructor(
    cesium: CesiumModule,
    viewer: Cesium.Viewer,
    frame: EnuFrame,
    options: EnvironmentOptions,
  ) {
    this.cesium = cesium;
    this.viewer = viewer;
    this.frame = frame;
    this.options = options;
    this.weather = options.weather;
    this.decks = decksFor(options.weather);

    this.baseLayer =
      viewer.imageryLayers.length > 0 ? viewer.imageryLayers.get(0) : undefined;

    applyTimeOfDay(
      cesium,
      viewer,
      options.time,
      options.longitude,
      options.clock,
    );

    // Post-process stages composite in the order they are added, so the cloud
    // volume goes in before the rain: rain falls in front of the weather, not
    // behind it. Both are built once, up front, and then only ever re-aimed —
    // the volume even when the setting is off, because a disabled stage
    // releases its resources and costs nothing, and building it later would
    // put it behind the rain.
    const volume = new VolumetricClouds(cesium, viewer.scene, frame, {
      quality: options.quality,
      decks: this.decks,
    });
    // A volume that would not compile is worse than no volume: fall back to
    // billboards rather than flying under an empty sky.
    if (!volume.available) volume.destroy();
    this.cloudVolume = volume.available ? volume : null;

    this.rainEffect = new RainEffect(cesium, viewer.scene, frame);

    this.lightning = new LightningField({
      seed: options.seed,
      activity: this.stormActivity,
      baseZ: this.stormBase,
      topZ: this.stormTop,
      radius: options.stormRadius ?? DEFAULT_STORM_RADIUS,
    });

    this.applyCloudLayer();
    this.refreshLighting();
    this.refreshPrecipitation();
  }

  /** Bottom of the deck a pilot would call the cloud base, in local metres. */
  get cloudBase(): number {
    return this.weather.cloudBaseAgl;
  }

  /** Top of that same deck, in local metres. */
  get cloudTop(): number {
    return this.weather.cloudBaseAgl + this.weather.cloudDepth;
  }

  /** Every deck actually being drawn, for the visibility model. */
  get cloudLayers(): readonly VisibilityLayer[] {
    if (!this.cloudsWanted) return [];
    return this.decks.map((deck) => ({
      baseZ: deck.baseZ,
      topZ: deck.topZ,
      opacity: clamp(deck.coverage * deck.density, 0, 1),
    }));
  }

  /** 0 = full night, 1 = full daylight. */
  get daylight(): number {
    return this.currentDaylight;
  }

  get sunElevationDegrees(): number {
    return this.currentSunElevation;
  }

  /**
   * The instant the scene clock is showing.
   *
   * Read rather than remembered, because a dynamic day runs the clock: the
   * time being flown at is not the time the flight started at.
   */
  get time(): Date {
    return clockDate(this.cesium, this.viewer);
  }

  get inCloud(): boolean {
    return this.insideCloud;
  }

  /** How bright the sky is from lightning right now, 0..1. */
  get lightningFlash(): number {
    return this.currentFlash;
  }

  /** True when the weather has a cell in it that is actually discharging. */
  get stormy(): boolean {
    return this.lightning.active;
  }

  /** The decks in flight, for the debug panel: `750-1450 m 75%`. */
  get deckSummary(): string {
    if (!this.cloudsWanted || this.decks.length === 0) return "clear";
    return this.decks
      .map(
        (deck) =>
          `${Math.round(deck.baseZ)}-${Math.round(deck.topZ)} m ${Math.round(
            deck.coverage * 100,
          )}%`,
      )
      .join(" · ");
  }

  /** Billboards in flight; zero while the volume is drawing the sky. */
  get cloudCount(): number {
    return this.cloudField?.cloudCount ?? 0;
  }

  get cloudMode(): CloudMode {
    if (!this.cloudsWanted) return "off";
    return this.volumeWanted ? "volumetric" : "billboards";
  }

  get rainAvailable(): boolean {
    return this.rainEffect.available;
  }

  /**
   * Hands over the airmass, so each deck can drift at its own altitude's wind.
   *
   * The flight builds its wind after the environment, so this arrives a moment
   * later rather than in the constructor.
   */
  setWindField(field: { sample(altitudeAgl: number, out: Vec3): Vec3 }): void {
    this.windField = field;
  }

  setToggles(toggles: EnvironmentToggles): void {
    const clouds = this.cloudsWanted;
    const volume = this.volumeWanted;
    this.options = { ...this.options, ...toggles };
    if (this.cloudsWanted !== clouds || this.volumeWanted !== volume) {
      this.applyCloudLayer();
    }
    this.refreshPrecipitation();
    this.refreshLighting();
  }

  /**
   * Changes the weather on a flight that is already airborne.
   *
   * The volume only needs to be told where the new decks are. The billboard
   * field is a layout rather than a shader, so it is thrown away and laid out
   * again from the same seed: the same weather always gives the same sky,
   * whether it was chosen before the flight or during it. Everything else —
   * light, fog, precipitation, the storm — is a fresh grade of the scene and
   * needs nothing rebuilt.
   *
   * The decks are compared rather than the profile's identity, because a sky
   * assembled by hand has no identity to compare: two different weathers can
   * both be `CUSTOM`, and sliding the cover on the one already flying has to
   * reach the cloud layer like any other change.
   */
  setWeather(weather: WeatherProfile): void {
    if (this.destroyed) return;
    const decks = decksFor(weather);
    const unchanged =
      sameDecks(decks, this.decks) &&
      weather.rain === this.weather.rain &&
      weather.snow === this.weather.snow &&
      weather.visibilityM === this.weather.visibilityM &&
      weather.thunderstorm === this.weather.thunderstorm;
    if (unchanged) return;

    this.weather = weather;
    this.decks = decks;
    this.options = { ...this.options, weather };
    this.lightning.setStorm({
      activity: this.stormActivity,
      baseZ: this.stormBase,
      topZ: this.stormTop,
    });
    this.applyCloudLayer();
    this.refreshPrecipitation();
    this.refreshLighting();
  }

  /** Moves the clock, and the sun with it, on a flight already airborne. */
  setTimeOfDay(time: TimeOfDayProfile, clock?: MissionClock): void {
    if (this.destroyed || this.viewer.isDestroyed()) return;
    this.options = { ...this.options, time, clock };
    applyTimeOfDay(
      this.cesium,
      this.viewer,
      time,
      this.options.longitude,
      clock,
    );
    this.refreshLighting();
  }

  private get cloudsWanted(): boolean {
    return (
      this.options.clouds &&
      this.options.effects &&
      this.decks.length > 0 &&
      this.weather.cloudCoverage > EMPTY_SKY
    );
  }

  /** Whether the march is the renderer in use, rather than the billboards. */
  private get volumeWanted(): boolean {
    return (
      this.cloudsWanted && this.options.volumetricClouds && this.cloudVolume !== null
    );
  }

  /** How busy the cell is, from the weather it is part of. */
  private get stormActivity(): number {
    if (!this.options.effects || !this.weather.thunderstorm) return 0;
    return stormActivity({
      thunderstorm: true,
      coverage: this.weather.cloudCoverage,
      cloudDepth: this.stormTop - this.stormBase,
    });
  }

  /** The deck the discharges happen in; the deepest one there is. */
  private get stormBase(): number {
    const cell = this.deepestDeck();
    return cell ? cell.baseZ : this.weather.cloudBaseAgl;
  }

  private get stormTop(): number {
    const cell = this.deepestDeck();
    return cell ? cell.topZ : this.weather.cloudBaseAgl + this.weather.cloudDepth;
  }

  private deepestDeck(): CloudDeck | null {
    let deepest: CloudDeck | null = null;
    for (const deck of this.decks) {
      if (!deepest || deck.topZ - deck.baseZ > deepest.topZ - deepest.baseZ) {
        deepest = deck;
      }
    }
    return deepest;
  }

  /**
   * How far the air outside a cloud is clear, in metres.
   *
   * The weather's own visibility, held down to the view-distance setting: the
   * two are one number as far as anything drawn is concerned, and the fog and
   * the cloud march have to agree on it or one of them shows what the other
   * has hidden.
   */
  private get clearAir(): number {
    return Math.min(
      this.weather.visibilityM,
      Math.max(this.options.viewDistanceKm, 1) * 1000,
    );
  }

  /** Points whichever cloud renderer is in use at the current decks. */
  private applyCloudLayer(): void {
    const volumetric = this.volumeWanted;
    const decks = this.cloudsWanted ? this.decks : [];

    if (this.cloudVolume) {
      this.cloudVolume.setDecks(decks);
      // Billboards and the volume must never both be up: the same cloud drawn
      // twice reads as haze.
      this.cloudVolume.show = volumetric;
      // The weather can be changed from the pause menu, where no frame is
      // being stepped: without this the first frame after resuming would be
      // marched from wherever the camera was when the volume was built.
      this.cloudVolume.update(stillAir, 0);
    }

    const billboards = this.cloudsWanted && !volumetric;
    this.cloudField?.destroy();
    this.cloudField = billboards
      ? new CloudField(this.cesium, this.viewer.scene, this.frame, {
          seed: this.options.seed,
          decks,
          extent: CLOUD_FIELD_EXTENT,
        })
      : null;
    this.cloudField?.update(this.lastPlayerPosition, stillAir, 0);
  }

  update(playerPosition: Vec3, wind: Vec3, dt: number): void {
    if (this.destroyed) return;

    this.lastPlayerPosition.x = playerPosition.x;
    this.lastPlayerPosition.y = playerPosition.y;
    this.lastPlayerPosition.z = playerPosition.z;
    this.fallbackWind.x = wind.x;
    this.fallbackWind.y = wind.y;
    this.fallbackWind.z = wind.z;

    const wasInCloud = this.insideCloud;
    this.insideCloud = this.options.effects && this.isInsideDeck(playerPosition.z);

    const wasFlashing = this.currentFlash > 0.01;
    this.lightning.update(dt, playerPosition);
    this.currentFlash = this.lightning.flash;

    this.lightingTimer += dt;
    if (
      this.lightingTimer >= LIGHTING_INTERVAL ||
      wasInCloud !== this.insideCloud ||
      wasFlashing !== this.currentFlash > 0.01
    ) {
      this.lightingTimer = 0;
      this.refreshLighting();
    } else {
      this.refreshFog();
    }

    // Nothing falls out of air with no cloud above it, so climbing through the
    // top of the weather flies out of the rain.
    this.refreshPrecipitation(playerPosition.z);

    const sampler = this.windAt;
    this.cloudField?.update(playerPosition, sampler, dt);
    this.cloudVolume?.update(sampler, dt);
    this.rainEffect.update(wind, dt);
  }

  /**
   * The strikes that have fired since this was last asked.
   *
   * Handed straight to the soundscape, which delays each crack by the strike's
   * own `thunderDelay`: the flash arrives instantly and the sound does not,
   * which is the only part of a thunderstorm anyone actually counts.
   */
  consumeStrikes(): readonly Strike[] {
    return this.lightning.consumeStrikes();
  }

  /** The wind at a height, or the aircraft's own wind before one is known. */
  private readonly windAt = (altitudeAgl: number): Vec3 => {
    if (!this.windField) return this.fallbackWind;
    return this.windField.sample(altitudeAgl, _windSample);
  };

  private isInsideDeck(z: number): boolean {
    for (const deck of this.decks) {
      if (deck.coverage > 0.25 && z >= deck.baseZ && z <= deck.topZ) return true;
    }
    return false;
  }

  private refreshLighting(): void {
    if (this.destroyed || this.viewer.isDestroyed()) return;

    // The clock may be running fast, so the sun has to be re-derived rather
    // than assumed fixed for the mission.
    const now = clockDate(this.cesium, this.viewer);
    const sun = solarPosition(this.options.latitude, this.options.longitude, now);
    this.currentSunElevation = sun.elevation;
    this.currentDaylight = daylightFactor(sun.elevation);

    applyLighting(this.cesium, this.viewer, this.baseLayer, {
      weather: this.weather,
      daylight: this.currentDaylight,
      flash: this.currentFlash,
    });
    this.refreshFog();

    if (this.cloudVolume) {
      sunDirectionEnu(sun.elevation, sun.azimuth, _sunDirection);
      cloudLight(
        this.currentDaylight,
        sun.elevation,
        this.weather.brightness,
        this.currentFlash,
        _sunColour,
        _skyColour,
      );
      this.cloudVolume.setLight(_sunDirection, _sunColour, _skyColour);
    }
  }

  /**
   * How far the world reaches, this frame.
   *
   * Every frame rather than with the rest of the grading: the fog has to undo
   * a fade Cesium works out from where the camera is pointing, and a quarter
   * of a second of that is a quarter of a second of the horizon opening up in
   * a turn. It is a handful of arithmetic and four property writes.
   */
  private refreshFog(): void {
    if (this.destroyed || this.viewer.isDestroyed()) return;
    applyFog(this.viewer, {
      weather: this.weather,
      daylight: this.currentDaylight,
      inCloud: this.insideCloud,
      effectsEnabled: this.options.effects,
      viewDistanceKm: this.options.viewDistanceKm,
    });
    // The cloud march stops where the air does, for the same reason.
    this.cloudVolume?.setVisibility(this.clearAir);
  }

  /**
   * How hard it is precipitating where the aircraft is.
   *
   * Full strength under the cloud, fading out over the couple of hundred
   * metres above the highest top and gone above that: the deck is the lid on
   * the weather, and there is nothing over it to fall.
   */
  private refreshPrecipitation(altitude = this.lastPlayerPosition.z): void {
    const enabled = this.options.effects && this.options.rain;
    const precipitation = this.weather.precipitation;
    if (!enabled || precipitation.kind === PRECIPITATION.None) {
      this.rainEffect.setPrecipitation(0);
      return;
    }

    // An empty sky is the one case with no lid at all. A lid *below* the
    // launch point is not that: the deck is down in the valley, and dropping
    // into it should still be wet, so the test is whether there is cloud, not
    // whether it is above the origin.
    if (this.weather.layers.length === 0) {
      this.rainEffect.setPrecipitation(0);
      return;
    }

    const lid = this.weather.cloudTopAgl;
    const above = altitude - lid;
    const under = above <= 0 ? 1 : clamp(1 - above / PRECIPITATION_FADE, 0, 1);

    this.rainEffect.setPrecipitation(
      precipitation.intensity * under,
      precipitation.kind === PRECIPITATION.Snow,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cloudField?.destroy();
    this.cloudVolume?.destroy();
    this.rainEffect.destroy();
  }
}

/** Still air, for placing a freshly built field without drifting it. */
function stillAir(): Vec3 {
  return NO_WIND;
}

/** The decks a weather describes, as the renderers want them. */
function decksFor(weather: WeatherProfile): readonly CloudDeck[] {
  return weather.layers
    .filter((layer) => layer.coverage > EMPTY_SKY)
    .map((layer) => ({
      baseZ: layer.baseAgl,
      topZ: layer.topAgl,
      coverage: layer.coverage,
      density: layer.density,
      convection: layer.convection,
    }));
}

function sameDecks(
  a: readonly CloudDeck[],
  b: readonly CloudDeck[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] as CloudDeck;
    const right = b[i] as CloudDeck;
    if (
      left.baseZ !== right.baseZ ||
      left.topZ !== right.topZ ||
      Math.abs(left.coverage - right.coverage) > 1e-6 ||
      left.density !== right.density ||
      left.convection !== right.convection
    ) {
      return false;
    }
  }
  return true;
}

/** Unit vector towards the sun in local East-North-Up. */
function sunDirectionEnu(
  elevationDegrees: number,
  azimuthDegrees: number,
  out: Vec3,
): Vec3 {
  const elevation = elevationDegrees * DEG_TO_RAD;
  const azimuth = azimuthDegrees * DEG_TO_RAD;
  const horizontal = Math.cos(elevation);
  out.x = horizontal * Math.sin(azimuth);
  out.y = horizontal * Math.cos(azimuth);
  out.z = Math.sin(elevation);
  return out;
}

/**
 * What a cloud is lit by.
 *
 * Direct sunlight reddens and fades as the sun goes down and is gone by the
 * time it is properly dark; the sky light it is replaced by is dimmer, bluer
 * and never quite reaches zero, so a night deck is a silhouette rather than a
 * hole in the world. Overcast weather grades both down together, which is what
 * makes a rain deck read as heavy rather than merely dark.
 *
 * A lightning flash is added to the sky term rather than the sun term, because
 * a discharge lights the cloud from inside and in every direction at once —
 * which is why a storm at night goes from a silhouette to a lantern and back
 * inside a fifth of a second.
 */
function cloudLight(
  daylight: number,
  sunElevationDegrees: number,
  brightness: number,
  flash: number,
  sun: Vec3,
  sky: Vec3,
): void {
  const low = clamp(1 - sunElevationDegrees / 12, 0, 1);
  const strength = (0.08 + 1.05 * daylight) * brightness;
  sun.x = lerp(1, 1, low) * strength;
  sun.y = lerp(0.97, 0.74, low) * strength;
  sun.z = lerp(0.93, 0.52, low) * strength;

  const ambient = (0.12 + 0.62 * daylight) * brightness;
  const lit = flash * (2.4 - 1.4 * daylight);
  sky.x = 0.52 * ambient + lit;
  sky.y = 0.58 * ambient + lit;
  sky.z = 0.68 * ambient + lit * 1.1;
}

export { CloudField } from "./clouds";
export { VolumetricClouds } from "./volumetricClouds";
export { RainEffect } from "./rain";
export type { CloudDeck } from "./volumetricClouds";
