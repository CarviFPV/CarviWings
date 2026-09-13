"use client";

/**
 * The browsable world.
 *
 * Before a flight there is a globe: the real Earth, streamed from the same ion
 * terrain and imagery the flight itself uses, that the player spins with the
 * mouse and clicks to choose a start point — the way MSFS's world map or
 * Google Earth works, rather than a list of places somebody else picked.
 *
 * This module owns that viewer and nothing else. It knows how to show the
 * globe, where a click landed, how high the ground is there, how to look a
 * place up by name, and how to draw the marker that says where the aircraft
 * will start. What the place is *called*, and what is done with it, belongs to
 * the caller: the naming rules and the coordinate parsing are plain arithmetic
 * in `sim/geo/placePicker.ts`, and the mission is assembled in React.
 *
 * The flight viewer in `viewer.ts` is deliberately not reused. It exists to be
 * flown — camera inputs off, scenery attached, a frame loop driving it — and
 * the map wants the opposite of all three.
 */

import type * as Cesium from "cesium";
import { loadCesium, type CesiumModule } from "./loadCesium";
import { readIonToken } from "./ionToken";
import { GRAPHICS_PRESETS, type GraphicsQuality } from "./quality";
import { CesiumConfigurationError } from "./viewer";
import { sampleDetailedHeight } from "./terrainProbe";
import {
  formatHeading,
  normaliseHeading,
  normaliseLongitude,
  pointAlongHeading,
  ringAroundDegrees,
  shortPlaceName,
  SPAWN_ALTITUDE_LIMITS,
  type GeoPoint,
} from "@/sim/geo/placePicker";

/** Radius of the ring drawn on the ground under the start marker. */
const MARKER_RING_METRES = 400;

/**
 * How far the heading needle reaches out of the ring, metres.
 *
 * Long enough to read as a direction at the zoom a start point is picked at,
 * short enough that it is still pointing at ground the flight begins over.
 */
const HEADING_NEEDLE_METRES = 1600;

/**
 * The angle each barb of the arrowhead makes with the way the needle points,
 * degrees. Just short of straight back, so the head reads as an arrow rather
 * than as a crossbar.
 */
const HEADING_BARB_DEG = 155;

/** And how long those barbs are, as a fraction of the needle. */
const HEADING_BARB_FRACTION = 0.18;

/** How far back the camera sits when it frames a single point. */
const POINT_VIEW_RANGE_METRES = 14000;

/**
 * Camera pitch when framing a place. The map is a map: straight down, north
 * up, the way it looks the moment the globe opens. Tilting it turns the search
 * for a start point into a flight of its own, so the picker does not offer it
 * and nothing here introduces it.
 */
const VIEW_PITCH_DEGREES = -90;

const EARTH_RADIUS_METRES = 6378137;

export interface WorldMapPick extends GeoPoint {
  /** Ground elevation at the point, in metres above the ellipsoid. */
  readonly terrainHeight: number;
  /**
   * False while the elevation is still the one the rendered globe happened to
   * have loaded, true once the terrain data itself has answered.
   */
  readonly precise: boolean;
}

export interface WorldSearchResult extends GeoPoint {
  /** Short form, for a mission name. */
  readonly name: string;
  /** The geocoder's full display name, for the results list. */
  readonly displayName: string;
  /** How far back to sit when framing it: a country needs more than a street. */
  readonly viewRange: number;
}

export interface WorldMapOptions {
  readonly quality: GraphicsQuality;
  /** Where to open the camera, if a place has already been chosen. */
  readonly initial?: GeoPoint | null;
}

export interface WorldMapCallbacks {
  /**
   * Fired once with the globe's own estimate the moment a point is chosen, and
   * again with `precise` set once the terrain sample lands. Both carry the same
   * coordinates, so the caller can render immediately and refine in place.
   */
  onPick?: (pick: WorldMapPick) => void;
}

interface MarkerState extends GeoPoint {
  readonly terrainHeight: number;
}

export class WorldMap {
  private readonly cesium: CesiumModule;
  private readonly viewer: Cesium.Viewer;
  private readonly terrainProvider: Cesium.TerrainProvider;
  private readonly handler: Cesium.ScreenSpaceEventHandler;
  private readonly callbacks: WorldMapCallbacks;
  private geocoder: Cesium.IonGeocoderService | null = null;

  private marker: MarkerState | null = null;
  private spawnAltitude: number = SPAWN_ALTITUDE_LIMITS.default;
  private startHeading = 0;
  /** Guards against a slow elevation sample overwriting a newer pick. */
  private pickSerial = 0;
  private destroyed = false;

  private constructor(
    cesium: CesiumModule,
    viewer: Cesium.Viewer,
    terrainProvider: Cesium.TerrainProvider,
    callbacks: WorldMapCallbacks,
  ) {
    this.cesium = cesium;
    this.viewer = viewer;
    this.terrainProvider = terrainProvider;
    this.callbacks = callbacks;
    this.handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction(
      (event: Cesium.ScreenSpaceEventHandler.PositionedEvent) =>
        this.handleClick(event.position),
      cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  static async start(
    container: HTMLElement,
    options: WorldMapOptions,
    callbacks: WorldMapCallbacks = {},
  ): Promise<WorldMap> {
    const token = readIonToken();
    if (!token) {
      throw new CesiumConfigurationError(
        "missing-token",
        "No Cesium ion access token is configured.",
      );
    }

    const cesium = await loadCesium();
    cesium.Ion.defaultAccessToken = token;

    const preset = GRAPHICS_PRESETS[options.quality];

    let terrainProvider: Cesium.TerrainProvider;
    let baseLayer: Cesium.ImageryLayer;
    try {
      terrainProvider = await cesium.createWorldTerrainAsync({
        requestVertexNormals: false,
        requestWaterMask: false,
      });
      baseLayer = cesium.ImageryLayer.fromWorldImagery({});
    } catch (error) {
      throw new CesiumConfigurationError(
        "ion-unreachable",
        "Cesium ion rejected the request for global terrain or imagery. The token may be invalid, expired, or missing asset access.",
        { cause: error },
      );
    }

    let viewer: Cesium.Viewer;
    try {
      viewer = new cesium.Viewer(container, {
        terrainProvider,
        baseLayer,
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        // The simulator supplies its own search box: the coordinate parsing,
        // the results list and the marker all belong to the picking flow.
        geocoder: false,
        homeButton: false,
        infoBox: false,
        navigationHelpButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        navigationInstructionsInitiallyVisible: false,
        // A menu screen has no reason to hold a GPU at full rate.
        targetFrameRate: 30,
        contextOptions: {
          webgl: {
            alpha: false,
            antialias: true,
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

    const scene = viewer.scene;
    const globe = scene.globe;
    // The map is browsed, not flown: this is the one Cesium camera in the
    // project the player actually drives.
    const controller = scene.screenSpaceCameraController;
    controller.enableInputs = true;
    controller.enableCollisionDetection = true;
    controller.minimumZoomDistance = 120;
    // Drag the globe and zoom, nothing else. Tilt and free-look are the two
    // inputs that can pitch the camera off top-down, and a picker that has
    // been tilted no longer reads as a map.
    controller.enableTilt = false;
    controller.enableLook = false;

    globe.maximumScreenSpaceError = Math.max(preset.maximumScreenSpaceError, 2);
    globe.tileCacheSize = preset.tileCacheSize;
    globe.depthTestAgainstTerrain = true;
    // Full daylight everywhere: a night side would hide half the places the
    // player might want to start from.
    globe.enableLighting = false;
    globe.showGroundAtmosphere = true;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    scene.fog.enabled = false;
    scene.logarithmicDepthBuffer = true;
    scene.shadowMap.enabled = false;
    viewer.clock.shouldAnimate = false;
    viewer.resolutionScale = preset.resolutionScale;

    // ion's imagery and terrain attribution is required wherever they are
    // drawn, the map included.
    const credits = viewer.cesiumWidget.creditContainer as HTMLElement;
    credits.classList.add("fpv-credits");

    const map = new WorldMap(cesium, viewer, terrainProvider, callbacks);
    if (options.initial) {
      // Opening on the last chosen place saves finding it again; opening on
      // the whole globe, which is Cesium's default view, is the alternative
      // when nothing has been chosen yet.
      map.frame(options.initial, {
        range: POINT_VIEW_RANGE_METRES * 2,
        seconds: 0,
      });
      void map.pick(options.initial, { fly: false });
    }
    return map;
  }

  /** Height above the ground for the marker's altitude stem, in metres. */
  /**
   * How high above the marker the aircraft will appear.
   *
   * Zero is a flight that starts on the ground: the stem collapses, the marker
   * sits on the surface and says so, which is exactly what it is describing.
   */
  setSpawnAltitude(metres: number): void {
    this.spawnAltitude = metres;
    this.drawMarker();
  }

  /**
   * Which way the flight starts off, degrees from north.
   *
   * Drawn as a needle out of the marker ring, because a heading typed into a
   * control is a number and a heading drawn on the map is the valley the
   * aircraft is about to fly down.
   */
  setStartHeading(degrees: number): void {
    this.startHeading = normaliseHeading(degrees);
    this.drawMarker();
  }

  /**
   * Chooses a point, draws the marker and reports the ground height under it.
   *
   * The globe's own idea of the elevation comes back immediately so the marker
   * can be drawn at once, then the terrain data is asked properly — at coarse
   * zoom the rendered mesh is a chord across the curve of the Earth and can be
   * hundreds of metres out.
   */
  async pick(
    point: GeoPoint,
    options: { fly?: boolean; range?: number } = {},
  ): Promise<void> {
    if (this.destroyed) return;
    const latitude = point.latitude;
    const longitude = normaliseLongitude(point.longitude);
    const serial = (this.pickSerial += 1);

    const approximate = this.globeHeightAt(latitude, longitude) ?? 0;
    this.marker = { latitude, longitude, terrainHeight: approximate };
    this.drawMarker();
    this.callbacks.onPick?.({
      latitude,
      longitude,
      terrainHeight: approximate,
      precise: false,
    });

    const shouldFly = options.fly !== false;
    const range = options.range ?? POINT_VIEW_RANGE_METRES;
    if (shouldFly) this.frame({ latitude, longitude }, { range });

    const sampled = await sampleDetailedHeight(
      this.cesium,
      this.terrainProvider,
      latitude,
      longitude,
    );
    // A newer pick, or an unmount, while the sample was in flight.
    if (this.destroyed || serial !== this.pickSerial) return;

    const terrainHeight = sampled ?? approximate;
    this.marker = { latitude, longitude, terrainHeight };
    this.drawMarker();
    this.callbacks.onPick?.({
      latitude,
      longitude,
      terrainHeight,
      precise: sampled !== null,
    });

    // The camera was aimed using the globe's guess. Over a mountain that guess
    // can be a kilometre low, which points the view at the ground under the
    // peak rather than at the peak; a real sample that far off is worth a
    // second, gentler move.
    if (shouldFly && Math.abs(terrainHeight - approximate) > 200) {
      this.frame({ latitude, longitude }, {
        range,
        seconds: 1,
        height: terrainHeight,
      });
    }
  }

  /** Moves the camera to look at a place without choosing it. */
  frame(
    point: GeoPoint,
    options: { range?: number; seconds?: number; height?: number } = {},
  ): void {
    if (this.destroyed) return;
    const { Cartesian3, BoundingSphere, HeadingPitchRange, Math: CesiumMath } =
      this.cesium;
    const height =
      options.height ?? this.globeHeightAt(point.latitude, point.longitude) ?? 0;
    const centre = Cartesian3.fromDegrees(
      normaliseLongitude(point.longitude),
      point.latitude,
      height,
    );
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(centre, 0), {
      offset: new HeadingPitchRange(
        0,
        CesiumMath.toRadians(VIEW_PITCH_DEGREES),
        options.range ?? POINT_VIEW_RANGE_METRES,
      ),
      duration: options.seconds,
    });
  }

  /**
   * Looks a place up by name through Cesium ion's geocoder — the same service
   * behind Cesium's own search box, included with the token the simulator
   * already needs.
   */
  async search(query: string): Promise<WorldSearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || this.destroyed) return [];
    if (!this.geocoder) {
      this.geocoder = new this.cesium.IonGeocoderService({
        scene: this.viewer.scene,
      });
    }
    const results = await this.geocoder.geocode(
      trimmed,
      this.cesium.GeocodeType.SEARCH,
    );
    const mapped: WorldSearchResult[] = [];
    for (const result of results) {
      const place = this.toSearchResult(result);
      if (place) mapped.push(place);
    }
    return mapped;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.handler.destroy();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }

  private handleClick(position: Cesium.Cartesian2): void {
    const scene = this.viewer.scene;
    const ray = this.viewer.camera.getPickRay(position);
    // A click on the sky rather than the planet: nothing to choose.
    const cartesian = ray ? scene.globe.pick(ray, scene) : undefined;
    if (!cartesian) return;
    const carto = this.cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return;
    const { Math: CesiumMath } = this.cesium;
    // A click chooses a point; it does not move the camera, which is already
    // exactly where the player put it.
    void this.pick(
      {
        latitude: CesiumMath.toDegrees(carto.latitude),
        longitude: CesiumMath.toDegrees(carto.longitude),
      },
      { fly: false },
    );
  }

  private toSearchResult(
    result: Cesium.GeocoderService.Result,
  ): WorldSearchResult | null {
    const { Cartographic, Rectangle, Math: CesiumMath } = this.cesium;
    const destination = result.destination;
    let carto: Cesium.Cartographic | undefined;
    let range = POINT_VIEW_RANGE_METRES;

    if (destination instanceof Rectangle) {
      carto = Rectangle.center(destination);
      // A bounding box says how big the thing found is: a city wants a
      // different camera distance from a continent.
      const height = (destination.north - destination.south) * EARTH_RADIUS_METRES;
      const width =
        Rectangle.computeWidth(destination) *
        EARTH_RADIUS_METRES *
        Math.cos(carto.latitude);
      range = Math.min(
        12_000_000,
        Math.max(4000, Math.max(width, Math.abs(height)) * 1.8),
      );
    } else {
      carto = Cartographic.fromCartesian(destination);
    }
    if (!carto) return null;

    const displayName = result.displayName?.trim() ?? "";
    return {
      name: shortPlaceName(displayName.length > 0 ? displayName : "Search result"),
      displayName,
      latitude: CesiumMath.toDegrees(carto.latitude),
      longitude: normaliseLongitude(CesiumMath.toDegrees(carto.longitude)),
      viewRange: range,
    };
  }

  /**
   * Elevation off the rendered globe. Instant and approximate — good enough to
   * put a marker on screen while the real sample is fetched.
   */
  private globeHeightAt(latitude: number, longitude: number): number | null {
    const carto = this.cesium.Cartographic.fromDegrees(
      normaliseLongitude(longitude),
      latitude,
    );
    const height = this.viewer.scene.globe.getHeight(carto);
    return height !== undefined && Number.isFinite(height) ? height : null;
  }

  /**
   * The start marker: a ring on the ground, a stem the height of the chosen
   * AGL, and a point at the top where the aircraft will actually appear.
   */
  private drawMarker(): void {
    if (this.destroyed) return;
    const entities = this.viewer.entities;
    entities.removeAll();
    const marker = this.marker;
    if (!marker) return;

    const { Cartesian2, Cartesian3, Color, LabelStyle, VerticalOrigin } =
      this.cesium;
    const accent = Color.fromCssColorString("#37d3e8");
    const ring = ringAroundDegrees(marker, MARKER_RING_METRES);
    const top = marker.terrainHeight + this.spawnAltitude;

    entities.add({
      polyline: {
        positions: cartesiansForRing(this.cesium, ring),
        width: 2,
        material: accent.withAlpha(0.9),
        clampToGround: true,
      },
    });

    // The needle: out of the ring on the start heading, with an arrowhead at
    // the far end so which end is the nose is never a guess. Clamped to the
    // ground like the ring, so it lies along the terrain it points down.
    const tip = pointAlongHeading(marker, this.startHeading, HEADING_NEEDLE_METRES);
    const barb = HEADING_NEEDLE_METRES * HEADING_BARB_FRACTION;
    entities.add({
      polyline: {
        positions: cartesiansForPath(this.cesium, [
          pointAlongHeading(marker, this.startHeading, MARKER_RING_METRES),
          tip,
        ]),
        width: 2,
        material: accent.withAlpha(0.85),
        clampToGround: true,
      },
    });
    entities.add({
      polyline: {
        positions: cartesiansForPath(this.cesium, [
          pointAlongHeading(tip, this.startHeading - HEADING_BARB_DEG, barb),
          tip,
          pointAlongHeading(tip, this.startHeading + HEADING_BARB_DEG, barb),
        ]),
        width: 2,
        material: accent.withAlpha(0.85),
        clampToGround: true,
      },
    });
    entities.add({
      position: cartesianForPoint(
        this.cesium,
        pointAlongHeading(marker, this.startHeading, HEADING_NEEDLE_METRES * 0.62),
        marker.terrainHeight,
      ),
      label: {
        text: formatHeading(this.startHeading),
        font: "12px ui-monospace, monospace",
        fillColor: accent,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    // No stem on a flight that starts on the ground: there is no height above
    // the marker to draw, and a polyline of zero length is not a drawing of
    // one.
    if (this.spawnAltitude > 0) {
      entities.add({
        polyline: {
          positions: [
            Cartesian3.fromDegrees(
              marker.longitude,
              marker.latitude,
              marker.terrainHeight,
            ),
            Cartesian3.fromDegrees(marker.longitude, marker.latitude, top),
          ],
          width: 2,
          material: accent.withAlpha(0.55),
        },
      });
    }

    entities.add({
      position: Cartesian3.fromDegrees(marker.longitude, marker.latitude, top),
      point: {
        pixelSize: 11,
        color: accent,
        outlineColor: Color.BLACK.withAlpha(0.8),
        outlineWidth: 2,
        // The marker is the whole point of the screen: it stays visible even
        // when the terrain in front of it says otherwise.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text:
          this.spawnAltitude > 0
            ? `${Math.round(this.spawnAltitude)} m AGL`
            : "On the ground",
        font: "12px ui-monospace, monospace",
        fillColor: accent,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -14),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }
}

/** An open run of ground points, for the heading needle and its arrowhead. */
function cartesiansForPath(
  cesium: CesiumModule,
  path: readonly GeoPoint[],
): Cesium.Cartesian3[] {
  const flat: number[] = [];
  for (const point of path) {
    flat.push(point.longitude, point.latitude);
  }
  return cesium.Cartesian3.fromDegreesArray(flat);
}

function cartesianForPoint(
  cesium: CesiumModule,
  point: GeoPoint,
  height: number,
): Cesium.Cartesian3 {
  return cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, height);
}

function cartesiansForRing(
  cesium: CesiumModule,
  ring: readonly GeoPoint[],
): Cesium.Cartesian3[] {
  const flat: number[] = [];
  for (const point of ring) {
    flat.push(point.longitude, point.latitude);
  }
  // Closed: the last segment has to return to the first point.
  const first = ring[0];
  if (first) flat.push(first.longitude, first.latitude);
  return cesium.Cartesian3.fromDegreesArray(flat);
}
