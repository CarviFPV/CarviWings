"use client";

/**
 * Cesium viewer construction for flight.
 *
 * The world is the real Earth: Cesium ion supplies the global terrain and the
 * satellite imagery, and nothing here generates or approximates either. If ion
 * cannot be reached the failure is reported to the caller so the UI can explain
 * it — the globe is never quietly replaced with a stand-in.
 *
 * Terrain and imagery give the world its shape and its colour, but nothing that
 * stands on it: buildings and woodland are painted into the satellite image and
 * have no volume at all. That geometry comes from the 3D tilesets attached in
 * `scenery.ts`, which this module brings up once the viewer exists.
 */

import type * as Cesium from "cesium";
import { loadCesium, type CesiumModule } from "./loadCesium";
import { readIonToken } from "./ionToken";
import { GRAPHICS_PRESETS, type GraphicsQuality } from "./quality";
import { detectGpu } from "@/lib/gpuProbe";
import { gpuAntiAliasing } from "@/sim/render/gpuProfile";
import { loadScenery, WORLD_DETAIL, type Scenery, type WorldDetail } from "./scenery";

export { GRAPHICS_PRESETS };
export type { GraphicsQuality };

export interface ViewerOptions {
  readonly quality: GraphicsQuality;
  /** Which 3D scenery is laid over the terrain; defaults to buildings. */
  readonly worldDetail?: WorldDetail;
}

export interface FlightViewer {
  readonly cesium: CesiumModule;
  readonly viewer: Cesium.Viewer;
  /** What ended up on top of the terrain, and why, if it was downgraded. */
  readonly scenery: Scenery;
  destroy(): void;
}

export class CesiumConfigurationError extends Error {
  readonly kind: "missing-token" | "ion-unreachable" | "webgl-unavailable";

  constructor(
    kind: "missing-token" | "ion-unreachable" | "webgl-unavailable",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CesiumConfigurationError";
    this.kind = kind;
  }
}

export type LoadStage =
  | "cesium"
  | "imagery"
  | "terrain"
  | "viewer"
  | "scenery"
  | "tiles";

export interface CreateViewerCallbacks {
  /**
   * `detail` carries a line about what a slow stage is doing — the
   * photogrammetry session being opened, or retried — for the loading screen
   * to show under the stage name.
   */
  onStage?: (stage: LoadStage, detail?: string) => void;
}

export async function createFlightViewer(
  container: HTMLElement,
  options: ViewerOptions,
  callbacks: CreateViewerCallbacks = {},
): Promise<FlightViewer> {
  const token = readIonToken();
  if (!token) {
    throw new CesiumConfigurationError(
      "missing-token",
      "No Cesium ion access token is configured.",
    );
  }

  callbacks.onStage?.("cesium");
  const cesium = await loadCesium();
  cesium.Ion.defaultAccessToken = token;

  const preset = GRAPHICS_PRESETS[options.quality];

  callbacks.onStage?.("terrain");
  let terrainProvider: Cesium.TerrainProvider;
  let baseLayer: Cesium.ImageryLayer;
  try {
    terrainProvider = await cesium.createWorldTerrainAsync({
      requestVertexNormals: preset.terrainNormals,
      requestWaterMask: false,
    });
    callbacks.onStage?.("imagery");
    baseLayer = cesium.ImageryLayer.fromWorldImagery({});
  } catch (error) {
    throw new CesiumConfigurationError(
      "ion-unreachable",
      "Cesium ion rejected the request for global terrain or imagery. The token may be invalid, expired, or missing asset access.",
      { cause: error },
    );
  }

  callbacks.onStage?.("viewer");
  let viewer: Cesium.Viewer;
  try {
    viewer = new cesium.Viewer(container, {
      terrainProvider,
      baseLayer,
      // Everything below is chrome the simulator supplies itself.
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      navigationInstructionsInitiallyVisible: false,
      requestRenderMode: false,
      contextOptions: {
        webgl: {
          alpha: false,
          antialias: preset.fxaa,
          powerPreference: "high-performance",
        },
      },
    });
  } catch (error) {
    throw new CesiumConfigurationError(
      "webgl-unavailable",
      "A WebGL context could not be created. The browser or GPU may not support it.",
      { cause: error },
    );
  }

  configureScene(cesium, viewer, options);

  // Buildings are streamed geometry, not part of the world's existence: a
  // failure there downgrades the view and is reported through `scenery.note`.
  // Photogrammetry is the world the pilot chose, so `loadScenery` raises a
  // `PhotorealisticUnavailableError` rather than swapping it for something
  // else, and the flight is not started over the wrong scenery.
  callbacks.onStage?.("scenery");
  let scenery: Scenery;
  try {
    scenery = await loadScenery(cesium, viewer, {
      detail: options.worldDetail ?? WORLD_DETAIL.Buildings,
      quality: options.quality,
      onProgress: (detail) => callbacks.onStage?.("scenery", detail),
    });
  } catch (error) {
    if (!viewer.isDestroyed()) viewer.destroy();
    throw error;
  }

  return {
    cesium,
    viewer,
    scenery,
    destroy: () => {
      scenery.destroy();
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}

function configureScene(
  cesium: CesiumModule,
  viewer: Cesium.Viewer,
  options: ViewerOptions,
): void {
  const preset = GRAPHICS_PRESETS[options.quality];
  const scene = viewer.scene;
  const globe = scene.globe;

  viewer.resolutionScale = preset.resolutionScale;
  globe.maximumScreenSpaceError = preset.maximumScreenSpaceError;
  globe.tileCacheSize = preset.tileCacheSize;

  // Terrain that is culled this frame is loaded anyway, because a wing turns
  // constantly and what is off the edge of the screen now is in the middle of
  // it a second later. Cesium leaves this off by default — it costs tiles — but
  // tiles fetched now are tiles not fetched in a frame somebody is flying, and
  // the loading sweep in `flightSession` fills this cache right round the
  // compass before take-off precisely so the first turn finds it already there.
  globe.preloadSiblings = true;

  // Terrain must occlude aircraft and geometry drawn behind it.
  globe.depthTestAgainstTerrain = true;
  // Lit terrain reads as actual mountains rather than a flat texture.
  globe.enableLighting = preset.terrainNormals;
  globe.showGroundAtmosphere = true;

  // The camera is driven entirely by the flight model.
  scene.screenSpaceCameraController.enableInputs = false;
  scene.screenSpaceCameraController.enableCollisionDetection = false;

  scene.fog.enabled = true;
  scene.fog.density = 0.00015;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;

  // How much world is drawn is the preset's business — the pilot's choice. How
  // the frame is anti-aliased is the GPU's, and is asked of the GPU that is
  // actually installed: a card that can afford four hardware samples does not
  // also need the full-screen FXAA pass on top of them, and dropping it hands
  // back a whole screen of fragment work. See `sim/render/gpuProfile.ts`.
  const antiAliasing = gpuAntiAliasing(
    { msaaSamples: preset.msaaSamples, fxaa: preset.fxaa },
    detectGpu(),
  );
  scene.postProcessStages.fxaa.enabled = antiAliasing.fxaa;
  scene.msaaSamples = antiAliasing.msaaSamples;
  scene.shadowMap.enabled = false;
  scene.debugShowFramesPerSecond = false;

  // Metre-scale aircraft against a planet-scale world: a logarithmic depth
  // buffer is what keeps the near geometry from z-fighting.
  scene.logarithmicDepthBuffer = true;
  viewer.camera.frustum.near = 0.5;
  // The far plane is deliberately left at Cesium's default. Shortening it to
  // limit view distance also clips the sky atmosphere shell, which sits about a
  // hundred kilometres up — the sky turns black and the stars come out at
  // midday. View distance is a fog setting, not a frustum one; see
  // environment/lighting.ts.

  viewer.clock.shouldAnimate = true;

  // Keep Cesium's required attribution visible but out of the flight display.
  const credits = viewer.cesiumWidget.creditContainer as HTMLElement;
  credits.classList.add("fpv-credits");
}
