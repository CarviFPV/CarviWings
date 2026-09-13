/**
 * Real-world flight locations. Every coordinate below is an actual place on
 * Earth — Cesium streams the imagery and terrain, nothing here is generated.
 */

export interface LocationPreset {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly latitude: number;
  readonly longitude: number;
  /**
   * Rough terrain elevation at the origin, used only to size the loading-time
   * altitude guess before the real terrain sample comes back from Cesium.
   */
  readonly approximateTerrainHeight: number;
  readonly description: string;
}

export const LOCATION_PRESETS: readonly LocationPreset[] = [
  {
    id: "swiss-alps",
    name: "Swiss Alps",
    region: "Switzerland",
    // Jungfrau / Lauterbrunnen valley.
    latitude: 46.5375,
    longitude: 7.9625,
    approximateTerrainHeight: 2400,
    description: "High alpine ridges, deep valleys and glacier walls.",
  },
  {
    id: "zurich",
    name: "Zurich",
    region: "Switzerland",
    latitude: 47.3769,
    longitude: 8.5417,
    approximateTerrainHeight: 410,
    description: "Dense city core along the lake, rolling hills beyond.",
  },
  {
    id: "bern",
    name: "Bern",
    region: "Switzerland",
    latitude: 46.948,
    longitude: 7.4474,
    approximateTerrainHeight: 540,
    description: "The Aare loop, old town rooftops and open farmland.",
  },
  {
    id: "porto",
    name: "Porto",
    region: "Portugal",
    latitude: 41.1496,
    longitude: -8.6109,
    approximateTerrainHeight: 90,
    description: "Douro river mouth, bridges and Atlantic coastline.",
  },
  {
    id: "norway-fjords",
    name: "Norway",
    region: "Geiranger",
    latitude: 62.1,
    longitude: 7.2058,
    approximateTerrainHeight: 900,
    description: "Fjord walls dropping straight into black water.",
  },
  {
    id: "rocky-mountains",
    name: "Rocky Mountains",
    region: "Colorado, USA",
    latitude: 39.1178,
    longitude: -106.4453,
    approximateTerrainHeight: 3200,
    description: "Wide alpine basins above the tree line.",
  },
  {
    id: "new-york",
    name: "New York",
    region: "USA",
    latitude: 40.7128,
    longitude: -74.006,
    approximateTerrainHeight: 10,
    description: "Manhattan skyline, rivers and harbour approaches.",
  },
];

/**
 * How far the flight area reaches from the mission origin, metres.
 *
 * A range rather than a handful of presets: the area is one number the pilot
 * turns up or down, and half a kilometre either way is a real difference to a
 * course laid out inside it. The floor is a field rather than a region — a
 * model flown line of sight never leaves a 500 m bubble — and the default is
 * the couple of kilometres a normal flight actually covers, so the boundary
 * warning on the OSD means something instead of never arriving.
 */
export const MIN_MISSION_RADIUS = 500;
export const MAX_MISSION_RADIUS = 50000;
export const MISSION_RADIUS_STEP = 500;
export const DEFAULT_MISSION_RADIUS = 2000;

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
