"use client";

/**
 * Volumetric clouds.
 *
 * Billboarded cumulus (see `clouds.ts`) is cheap and holds up at a distance,
 * but it never survives being flown into: a quad has no inside, so the cloud
 * turns edge-on and vanishes at the moment the pilot is closest to it. This
 * layer is the other approach — the cloud deck is a *volume*, and every pixel
 * of the frame is a short ray march through it.
 *
 * ## How it is drawn
 *
 * Two post-process stages, run as one composite:
 *
 * 1. `fpv_cloud_march` marches the deck and writes cloud colour and coverage
 *    into an offscreen texture. It runs at a fraction of the framebuffer size,
 *    because clouds carry no sharp edges and a half-resolution march is four
 *    times cheaper than a full one.
 * 2. `fpv_cloud_blend` composites that texture over the scene at full
 *    resolution, so the terrain, the aircraft and the HUD stay crisp.
 *
 * The march is clipped against the depth buffer, which is what puts a ridge in
 * front of the cloud behind it, and against a maximum distance, beyond which
 * the deck dissolves into the fog rather than ending at a visible edge.
 *
 * ## Why it stays affordable
 *
 * Nothing here is a texture lookup: the cloud shape is hashed value noise
 * evaluated in the shader, which modern GPUs do far faster than they sample
 * memory. The march skips ahead in empty air, stops as soon as the ray is
 * opaque, gives up entirely on rays that never cross the deck at all, and
 * takes progressively longer steps with distance. Step counts come from the
 * graphics preset, so a low preset is a coarser march rather than no clouds.
 *
 * Everything is computed in the mission's local ENU frame: a deck is a flat
 * slab between two altitudes, which over a mission-sized area is what a cloud
 * base actually is, and it keeps the shader free of planetary-scale numbers.
 *
 * ## Several decks
 *
 * A sky is up to three of those slabs, because that is what a routine aerodrome
 * report describes and what a real sky usually is: a low deck to fly under, a
 * mid-level sheet, and ice above both. The march covers the union of them in
 * one pass and evaluates each deck at every step, so the extra cost is the
 * density function rather than another full-screen march. Each deck carries its
 * own coverage, its own opacity and its own shape — a cumulonimbus towers where
 * a stratus sheet lies flat — and drifts at the wind of its own altitude, which
 * is what makes a sheared sky read as sheared.
 */

import type * as Cesium from "cesium";
import type { CesiumModule } from "../loadCesium";
import type { EnuFrame } from "@/sim/geo/enuFrame";
import type { GraphicsQuality } from "../quality";
import { detectGpu } from "@/lib/gpuProbe";
import { gpuCloudMarchScale } from "@/sim/render/gpuProfile";
import { clamp } from "@/sim/math/scalar";
import type { Vec3 } from "@/sim/math/vec3";
import { vec3 } from "@/sim/math/vec3";

// Shader comments must be `//` lines, or multi-line if blocked out: Cesium
// strips `/** ... */` by counting the newlines in the match, which throws on a
// block comment that fits on one line and kills the whole render loop.
const MARCH_SHADER = `
precision highp float;

uniform sampler2D depthTexture;

uniform vec3 cameraLocal;
uniform vec3 camRight;
uniform vec3 camUp;
uniform vec3 camForward;
// Half-extent of the near plane in view units: (x = aspect * y).
uniform vec2 projection;
// One per deck: (base, top, coverage, extinction per metre at full density).
// Three separate uniforms rather than an array: the decks are named
// individually in the density function anyway, and a plain vec4 needs none of
// the uniform-array machinery that varies between drivers.
uniform vec4 deckA;
uniform vec4 deckB;
uniform vec4 deckC;
// One per deck: (convection, noise offset, drift x, drift y).
uniform vec4 shapeA;
uniform vec4 shapeB;
uniform vec4 shapeC;
// How many of the three decks are real.
uniform float layerCount;
// The union of every deck, in local metres: what the ray is marched through.
uniform vec2 marchBounds;
uniform float maxDistance;
uniform float steps;
uniform float lightSteps;
// 1 adds the third noise octave; 0 leaves the deck smooth.
uniform float detail;
uniform vec3 sunDirection;
uniform vec3 sunColour;
uniform vec3 skyColour;

in vec2 v_textureCoordinates;

const int MAX_STEPS = 96;
const int MAX_LIGHT_STEPS = 6;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

/**
 * Density of one deck at a point, 0..1.
 *
 * Two octaves of noise decide where there is cloud at all and how much of it;
 * coverage moves the threshold they have to clear, so the same field goes from
 * a few fair-weather puffs to a solid overcast without being rebuilt. The mass
 * that survives then decides how far up the deck the cloud towers — but only as
 * far as the genus lets it: a convective deck piles into cauliflower with blue
 * sky between the tops, while a sheet fills its slab evenly however dense it
 * is. A last, finer octave eats into the edges, because a cloud without a
 * cauliflower on it reads as airbrushed.
 *
 * Each deck is offset in the noise field, so two decks never stack into one
 * column of cloud at the same place on the ground.
 */
float layerDensity(vec4 deck, vec4 shape, vec3 p, float useDetail) {
  float span = max(deck.y - deck.x, 1.0);
  float height = (p.z - deck.x) / span;
  if (height < 0.0 || height > 1.0) return 0.0;

  vec2 ground = p.xy - shape.zw + vec2(shape.y, shape.y * 1.7);
  vec3 q = vec3(ground, p.z * 0.35) * 0.0006;
  float noise = valueNoise(q) * 0.62 + valueNoise(q * 2.7) * 0.26;
  noise += useDetail > 0.5 ? valueNoise(q * 6.1) * 0.12 : 0.06;

  // Coverage is shaped before it is used: the noise is bell-shaped, so an even
  // slide of the threshold would spend most of its travel in the middle of the
  // range and never reach a proper overcast or a properly empty sky. The gain
  // sharpens what is left — a few clouds in a clear sky are solid ones, not a
  // haze of half-formed wisps.
  float coverage = deck.z;
  float shaped = pow(coverage, 1.25);
  float threshold = mix(0.685, 0.16, shaped);
  float mass = clamp((noise - threshold) * mix(7.0, 3.2, shaped), 0.0, 1.0);
  if (mass <= 0.0) return 0.0;

  float convection = shape.x;
  // Flat base either way; a convective top rises with the mass under it, a
  // layered one simply reaches the top of its own slab.
  float top = mix(1.0, 0.3 + 0.7 * mass, convection);
  float falloff = mix(0.22, 0.45, convection);
  float density =
    mass * smoothstep(0.0, 0.12, height) * smoothstep(top, top - falloff, height);

  if (useDetail > 0.5) {
    // A solid deck is not eaten into as hard as a fair-weather cumulus; an
    // overcast that breaks up into lumps stops reading as overcast.
    float erosion = valueNoise(vec3(ground, p.z) * 0.0038);
    density -= (1.0 - density) * erosion * 0.35 * (1.0 - coverage * 0.6);
  }
  return clamp(density, 0.0, 1.0);
}

// Folds one deck into the running totals.
void addDeck(vec4 deck, vec4 shape, vec3 p, float useDetail, inout float thickest, inout float sigma) {
  float density = layerDensity(deck, shape, p, useDetail);
  if (density <= 0.0) return;
  thickest = max(thickest, density);
  sigma += density * deck.w;
}

/**
 * Every deck at once.
 *
 * Returns how much cloud is at the point, and writes out the extinction it
 * adds — which is a sum rather than a maximum, because two decks occupying the
 * same air absorb one after the other.
 */
float cloudDensity(vec3 p, float useDetail, out float sigma) {
  sigma = 0.0;
  float thickest = 0.0;
  if (layerCount > 0.5) addDeck(deckA, shapeA, p, useDetail, thickest, sigma);
  if (layerCount > 1.5) addDeck(deckB, shapeB, p, useDetail, thickest, sigma);
  if (layerCount > 2.5) addDeck(deckC, shapeC, p, useDetail, thickest, sigma);
  return thickest;
}

// Beer's law along a short march towards the sun.
float sunlight(vec3 p) {
  float optical = 0.0;
  float stride = 70.0;
  float travelled = 0.0;
  float sigma;
  for (int i = 0; i < MAX_LIGHT_STEPS; i++) {
    if (float(i) >= lightSteps) break;
    travelled += stride;
    cloudDensity(p + sunDirection * travelled, 0.0, sigma);
    optical += sigma * stride;
    stride *= 1.9;
  }
  return exp(-optical * 1.4);
}

// Henyey-Greenstein, the forward-scattering lobe that lights cloud edges.
float phase(float cosAngle, float g) {
  float gg = g * g;
  float denom = 1.0 + gg - 2.0 * g * cosAngle;
  return (1.0 - gg) / (4.0 * 3.14159265 * pow(max(denom, 1e-4), 1.5));
}

void main(void) {
  vec2 uv = v_textureCoordinates;
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 rd = normalize(
    camForward + camRight * (ndc.x * projection.x) + camUp * (ndc.y * projection.y));
  vec3 ro = cameraLocal;

  // Anything already drawn — terrain, an aircraft — ends the march where it
  // stands, so a ridge occludes the cloud behind it.
  float sceneDepth = texture(depthTexture, uv).r;
  float far = maxDistance;
  if (sceneDepth < 1.0) {
    vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, sceneDepth);
    far = min(length(eye.xyz / eye.w), maxDistance);
  }

  // Where the ray is inside the band every deck lives in. Gaps between decks
  // are marched through as empty air, which the step-skipping below crosses
  // cheaply — far cheaper than a separate march per deck.
  float enter = 0.0;
  float leave = far;
  if (abs(rd.z) < 1e-5) {
    if (ro.z < marchBounds.x || ro.z > marchBounds.y) {
      out_FragColor = vec4(0.0);
      return;
    }
  } else {
    float toBase = (marchBounds.x - ro.z) / rd.z;
    float toTop = (marchBounds.y - ro.z) / rd.z;
    enter = max(min(toBase, toTop), 0.0);
    leave = min(max(toBase, toTop), far);
  }

  if (leave <= enter) {
    out_FragColor = vec4(0.0);
    return;
  }

  float span = leave - enter;
  // Steps grow with distance: near cloud gets the detail, far cloud gets the
  // cheap approximation nobody can see the difference in.
  float growth = 1.035;
  float base = span * (growth - 1.0) / (pow(growth, steps) - 1.0);

  // A per-pixel offset breaks the march's banding into dither, which the
  // half-resolution upsample then smooths away.
  float jitter = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);

  float cosAngle = dot(rd, sunDirection);
  float lobe = phase(cosAngle, 0.45) * 2.6 + 0.28;

  float transmittance = 1.0;
  vec3 scattered = vec3(0.0);
  float t = enter + base * jitter;
  float stride = base;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= steps || t >= leave || transmittance < 0.02) break;

    vec3 p = ro + rd * t;
    // Distant cloud thins out instead of ending at a hard edge.
    float reach = 1.0 - smoothstep(maxDistance * 0.6, maxDistance, t);
    float sigma;
    float density = cloudDensity(p, detail, sigma) * reach;
    sigma *= reach;

    if (density > 0.002) {
      float absorbed = 1.0 - exp(-sigma * stride);
      float lit = sunlight(p);
      // Deep cloud is dark at the bottom and bright on top, which is most of
      // what makes a cumulus read as solid.
      float height = clamp(
        (p.z - marchBounds.x) / max(marchBounds.y - marchBounds.x, 1.0), 0.0, 1.0);
      vec3 colour = sunColour * lit * lobe + skyColour * (0.45 + 0.55 * height);
      scattered += transmittance * absorbed * colour;
      transmittance *= 1.0 - absorbed;
      t += stride;
    } else {
      // Empty air is skipped in longer strides.
      t += stride * 1.8;
    }
    stride *= growth;
  }

  out_FragColor = vec4(scattered, clamp(1.0 - transmittance, 0.0, 1.0));
}
`;

const BLEND_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D fpv_cloud_march;
in vec2 v_textureCoordinates;

void main(void) {
  vec4 scene = texture(colorTexture, v_textureCoordinates);
  vec4 clouds = texture(fpv_cloud_march, v_textureCoordinates);
  // The march writes premultiplied colour, so this is a plain over-blend.
  out_FragColor = vec4(scene.rgb * (1.0 - clouds.a) + clouds.rgb, scene.a);
}
`;

interface MarchPreset {
  /** Ray steps through the deck. */
  readonly steps: number;
  /** Steps of the shadow march towards the sun. */
  readonly lightSteps: number;
  /** Whether the third noise octave is sampled. */
  readonly detail: number;
  /** Fraction of the framebuffer the march runs at. */
  readonly textureScale: number;
  /** How far the deck is marched, metres. */
  readonly maxDistance: number;
}

const PRESETS: Readonly<Record<GraphicsQuality, MarchPreset>> = {
  low: { steps: 20, lightSteps: 2, detail: 0, textureScale: 0.4, maxDistance: 9000 },
  medium: { steps: 28, lightSteps: 3, detail: 0, textureScale: 0.5, maxDistance: 12000 },
  high: { steps: 40, lightSteps: 4, detail: 1, textureScale: 0.5, maxDistance: 16000 },
  ultra: { steps: 56, lightSteps: 5, detail: 1, textureScale: 0.7, maxDistance: 20000 },
};

/** A deck as the march needs it: bounds in local metres, and how it behaves. */
export interface CloudDeck {
  /** Bounds in local ENU metres. */
  readonly baseZ: number;
  readonly topZ: number;
  /** 0..1 how much of the sky this deck fills. */
  readonly coverage: number;
  /** 0..1 how solid the cloud is. */
  readonly density: number;
  /** 0..1 how much it towers rather than lies flat. */
  readonly convection: number;
}

export interface VolumetricCloudOptions {
  readonly quality: GraphicsQuality;
  /** The decks to march, lowest first. Empty draws nothing. */
  readonly decks: readonly CloudDeck[];
}

/** How many decks the shader carries uniforms for. */
const MAX_LAYERS = 3;

/** Under this coverage a deck is not worth an extinction sample. */
const EMPTY_DECK = 0.001;

const _local = vec3();

export class VolumetricClouds {
  private readonly scene: Cesium.Scene;
  private readonly frame: EnuFrame;
  private readonly preset: MarchPreset;
  private composite: Cesium.PostProcessStageComposite | null = null;

  private readonly cameraLocal: Cesium.Cartesian3;
  private readonly camRight: Cesium.Cartesian3;
  private readonly camUp: Cesium.Cartesian3;
  private readonly camForward: Cesium.Cartesian3;
  private readonly projection: Cesium.Cartesian2;
  /** Per deck: (base, top, coverage, extinction). */
  private readonly layerDeck: Cesium.Cartesian4[];
  /** Per deck: (convection, noise offset, drift x, drift y). */
  private readonly layerShape: Cesium.Cartesian4[];
  private readonly marchBounds: Cesium.Cartesian2;
  private readonly sunDirection: Cesium.Cartesian3;
  private readonly sunColour: Cesium.Cartesian3;
  private readonly skyColour: Cesium.Cartesian3;
  private decks: readonly CloudDeck[] = [];
  private layerCount = 0;
  private wanted = true;
  private visibility = Number.POSITIVE_INFINITY;
  private destroyed = false;

  constructor(
    cesium: CesiumModule,
    scene: Cesium.Scene,
    frame: EnuFrame,
    options: VolumetricCloudOptions,
  ) {
    this.scene = scene;
    this.frame = frame;
    this.preset = PRESETS[options.quality];

    this.cameraLocal = new cesium.Cartesian3();
    this.camRight = new cesium.Cartesian3(1, 0, 0);
    this.camUp = new cesium.Cartesian3(0, 0, 1);
    this.camForward = new cesium.Cartesian3(0, 1, 0);
    this.projection = new cesium.Cartesian2(1, 0.577);
    this.layerDeck = [];
    this.layerShape = [];
    for (let i = 0; i < MAX_LAYERS; i += 1) {
      this.layerDeck.push(new cesium.Cartesian4(0, 1, 0, 0.006));
      // Each deck is offset in the noise field by a fixed, generous amount, so
      // decks never line up into one column of cloud on the ground.
      this.layerShape.push(new cesium.Cartesian4(0.5, i * 37000, 0, 0));
    }
    this.marchBounds = new cesium.Cartesian2(0, 1);
    this.sunDirection = new cesium.Cartesian3(0, 0, 1);
    this.sunColour = new cesium.Cartesian3(1, 0.98, 0.94);
    this.skyColour = new cesium.Cartesian3(0.45, 0.52, 0.62);

    this.setDecks(options.decks);

    try {
      const march = new cesium.PostProcessStage({
        name: "fpv_cloud_march",
        fragmentShader: MARCH_SHADER,
        // The one thing on the screen that is purely the GPU's, so what
        // fraction of the framebuffer it runs at is asked of the GPU that is
        // installed rather than fixed at the preset's half. A card with
        // headroom marches at full resolution and stops upscaling soft edges
        // onto a sky; a phone or a software rasteriser marches at a third.
        textureScale: gpuCloudMarchScale(this.preset.textureScale, detectGpu()),
        uniforms: {
          cameraLocal: () => this.cameraLocal,
          camRight: () => this.camRight,
          camUp: () => this.camUp,
          camForward: () => this.camForward,
          projection: () => this.projection,
          deckA: () => this.layerDeck[0] as Cesium.Cartesian4,
          deckB: () => this.layerDeck[1] as Cesium.Cartesian4,
          deckC: () => this.layerDeck[2] as Cesium.Cartesian4,
          shapeA: () => this.layerShape[0] as Cesium.Cartesian4,
          shapeB: () => this.layerShape[1] as Cesium.Cartesian4,
          shapeC: () => this.layerShape[2] as Cesium.Cartesian4,
          layerCount: () => this.layerCount,
          marchBounds: () => this.marchBounds,
          maxDistance: () => Math.min(this.preset.maxDistance, this.visibility),
          steps: () => this.preset.steps,
          lightSteps: () => this.preset.lightSteps,
          detail: () => this.preset.detail,
          sunDirection: () => this.sunDirection,
          sunColour: () => this.sunColour,
          skyColour: () => this.skyColour,
        },
      });
      const blend = new cesium.PostProcessStage({
        name: "fpv_cloud_blend",
        fragmentShader: BLEND_SHADER,
        uniforms: {
          // Resolved by Cesium to the march stage's output texture.
          fpv_cloud_march: march.name,
        },
      });
      this.composite = scene.postProcessStages.add(
        new cesium.PostProcessStageComposite({
          name: "fpv_clouds",
          stages: [march, blend],
          // Both stages read the scene, and the blend reads the march's
          // output by name; running them in series would feed the blend a
          // half-resolution copy of the whole frame instead.
          inputPreviousStageTexture: false,
        }),
      ) as Cesium.PostProcessStageComposite;
      this.composite.enabled = false;
    } catch (error) {
      // Losing the cloud layer costs the flight nothing else; the caller falls
      // back to billboards.
      console.error("[fpv] volumetric clouds unavailable", error);
      this.composite = null;
    }
  }

  get available(): boolean {
    return this.composite !== null;
  }

  set show(value: boolean) {
    this.wanted = value;
    this.applyEnabled();
  }

  /**
   * How far the air is clear, in metres.
   *
   * The march has a reach of its own, set by the graphics preset, and cloud
   * fades out over the last part of it. In thick weather the air runs out
   * first, and cloud drawn crisply at five kilometres through a sky that says
   * five hundred metres is exactly the thing that made low visibility look
   * like a colour grade rather than like fog. The shorter of the two wins.
   */
  setVisibility(metres: number): void {
    this.visibility = Math.max(metres, 1);
  }

  /**
   * The decks the weather asks for, in local metres.
   *
   * Anything past the third is dropped — the shader carries three — and a deck
   * with no cloud in it is dropped whatever position it is in, so a sky that
   * thins to nothing costs nothing rather than marching three empty slabs.
   */
  setDecks(decks: readonly CloudDeck[]): void {
    const real = decks
      .filter((deck) => deck.coverage > EMPTY_DECK && deck.topZ > deck.baseZ)
      .slice(0, MAX_LAYERS);
    this.decks = real;
    this.layerCount = real.length;

    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < real.length; i += 1) {
      const deck = real[i] as CloudDeck;
      const target = this.layerDeck[i] as Cesium.Cartesian4;
      const shape = this.layerShape[i] as Cesium.Cartesian4;
      const top = Math.max(deck.topZ, deck.baseZ + 50);
      target.x = deck.baseZ;
      target.y = top;
      target.z = clamp(deck.coverage, 0, 1);
      // Thin fair-weather cloud is wispy; an overcast deck is close to opaque,
      // and a cirrus sheet is neither however much of the sky it covers.
      target.w = (0.004 + 0.009 * target.z) * clamp(deck.density, 0.05, 1.2);
      shape.x = clamp(deck.convection, 0, 1);
      lowest = Math.min(lowest, deck.baseZ);
      highest = Math.max(highest, top);
    }

    if (real.length === 0) {
      this.marchBounds.x = 0;
      this.marchBounds.y = 1;
    } else {
      this.marchBounds.x = lowest;
      this.marchBounds.y = highest;
    }
    this.applyEnabled();
  }

  private applyEnabled(): void {
    if (this.composite) {
      this.composite.enabled = this.wanted && this.layerCount > 0;
    }
  }

  /**
   * Where the light comes from and what colour it is.
   *
   * @param sunDirection Unit vector towards the sun, in local ENU.
   */
  setLight(sunDirection: Vec3, sun: Vec3, sky: Vec3): void {
    this.sunDirection.x = sunDirection.x;
    this.sunDirection.y = sunDirection.y;
    this.sunDirection.z = sunDirection.z;
    this.sunColour.x = sun.x;
    this.sunColour.y = sun.y;
    this.sunColour.z = sun.z;
    this.skyColour.x = sky.x;
    this.skyColour.y = sky.y;
    this.skyColour.z = sky.z;
  }

  /**
   * Drifts each deck downwind and re-reads the camera.
   *
   * `windAt` is asked for the wind in the middle of each deck rather than at
   * the aircraft, so a sheared airmass moves its low deck one way and its high
   * one another — which is most of what makes a real sky look layered.
   */
  update(windAt: (altitudeAgl: number) => Vec3, dt: number): void {
    if (this.destroyed || !this.composite || !this.composite.enabled) return;

    for (let i = 0; i < this.layerCount; i += 1) {
      const deck = this.decks[i] as CloudDeck;
      const shape = this.layerShape[i] as Cesium.Cartesian4;
      const wind = windAt((deck.baseZ + Math.max(deck.topZ, deck.baseZ)) / 2);
      shape.z += wind.x * dt;
      shape.w += wind.y * dt;
    }

    const camera = this.scene.camera;
    this.frame.ecefToLocal(camera.positionWC, _local);
    this.cameraLocal.x = _local.x;
    this.cameraLocal.y = _local.y;
    this.cameraLocal.z = _local.z;

    this.frame.ecefVectorToEnu(camera.rightWC, _local);
    this.camRight.x = _local.x;
    this.camRight.y = _local.y;
    this.camRight.z = _local.z;

    this.frame.ecefVectorToEnu(camera.upWC, _local);
    this.camUp.x = _local.x;
    this.camUp.y = _local.y;
    this.camUp.z = _local.z;

    this.frame.ecefVectorToEnu(camera.directionWC, _local);
    this.camForward.x = _local.x;
    this.camForward.y = _local.y;
    this.camForward.z = _local.z;

    const frustum = camera.frustum as { fovy?: number; aspectRatio?: number };
    const fovy = typeof frustum.fovy === "number" && frustum.fovy > 0
      ? frustum.fovy
      : Math.PI / 3;
    const aspect =
      typeof frustum.aspectRatio === "number" && frustum.aspectRatio > 0
        ? frustum.aspectRatio
        : 16 / 9;
    this.projection.y = Math.tan(fovy / 2);
    this.projection.x = this.projection.y * aspect;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.composite && !this.scene.isDestroyed()) {
      this.scene.postProcessStages.remove(this.composite);
    }
    this.composite = null;
  }
}
