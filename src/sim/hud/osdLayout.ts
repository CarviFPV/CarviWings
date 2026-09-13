/**
 * Where every piece of the on-screen display sits, and whether it is drawn.
 *
 * An FPV OSD is a character grid: the flight controller lays glyphs onto fixed
 * cells and the pilot moves them around in a configurator until the picture
 * reads the way they want it to. That is the model here — a placement is a
 * grid cell plus the side the element grows from — and it is deliberately
 * coarse. Storing pixels would mean a layout tuned on one window looked wrong
 * in every other; storing cells means a layout is a proportion of the picture
 * and survives the goggles being a different shape.
 *
 * The grid is finer than a flight controller's because this OSD is set in a
 * real typeface rather than a 12x18 font. A row is a little over half the
 * height of a readout — a readout is a glyph and a number, not a line of small
 * caps — so readouts that stack stand two rows apart. That holds at every
 * window size and not just at 1080p, because the display is sized off the
 * height of the picture as well: see `osd-scale` in `globals.css`.
 *
 * Framework-agnostic on purpose. Nothing here knows about React, the DOM or a
 * canvas; the layer that draws asks for an anchor and gets two numbers.
 */

export const OSD_GRID_COLUMNS = 60;
export const OSD_GRID_ROWS = 48;

export const OSD_ALIGN = {
  /** The element grows right from its anchor. */
  Left: "left",
  /** The element is centred on its anchor. */
  Centre: "centre",
  /** The element grows left from its anchor. */
  Right: "right",
} as const;

export type OsdAlign = (typeof OSD_ALIGN)[keyof typeof OSD_ALIGN];

export const OSD_ELEMENT = {
  // Contacts and the mission the flight is being flown as.
  MissionPanel: "missionPanel",
  Contacts: "contacts",
  Interceptors: "interceptors",
  Tracking: "tracking",

  // The power system.
  Battery: "battery",
  BatteryVoltage: "batteryVoltage",
  BatteryCurrent: "batteryCurrent",
  BatteryMah: "batteryMah",
  Endurance: "endurance",

  // The link the picture comes down.
  LinkQuality: "linkQuality",

  // Energy state.
  Airspeed: "airspeed",
  GroundSpeed: "groundSpeed",
  Wind: "wind",
  Throttle: "throttle",
  LoadFactor: "loadFactor",
  Pitch: "pitch",
  Roll: "roll",

  // Height.
  Altitude: "altitude",
  AltitudeAgl: "altitudeAgl",
  VerticalSpeed: "verticalSpeed",

  // Where the aircraft is pointed and what is being chased.
  Heading: "heading",
  HeadingTape: "headingTape",
  TargetRange: "targetRange",
  TargetBearing: "targetBearing",
  HomeArrow: "homeArrow",

  // What the flight controller is doing.
  FlightMode: "flightMode",
  Holds: "holds",
  Warnings: "warnings",

  // Instruments drawn as line art rather than set as text.
  Horizon: "horizon",
  Crosshair: "crosshair",
  TargetIndicator: "targetIndicator",
  Minimap: "minimap",

  // The session itself.
  CraftName: "craftName",
  FlightTimer: "flightTimer",
  CameraMode: "cameraMode",
  Fps: "fps",
  Coordinates: "coordinates",
  TerrainHeight: "terrainHeight",
} as const;

export type OsdElementId = (typeof OSD_ELEMENT)[keyof typeof OSD_ELEMENT];

export const OSD_GROUP = {
  Instruments: "instruments",
  Energy: "energy",
  Height: "height",
  Navigation: "navigation",
  Power: "power",
  Mission: "mission",
  System: "system",
} as const;

export type OsdGroup = (typeof OSD_GROUP)[keyof typeof OSD_GROUP];

export const OSD_GROUP_LABEL: Record<OsdGroup, string> = {
  instruments: "Instruments",
  energy: "Energy",
  height: "Height",
  navigation: "Navigation",
  power: "Power",
  mission: "Mission",
  system: "Session",
};

/** Where one element sits, and whether the pilot wants it at all. */
export interface OsdPlacement {
  readonly enabled: boolean;
  /** Grid column of the anchor, 0..`OSD_GRID_COLUMNS` - 1. */
  readonly column: number;
  /** Grid row of the anchor, 0..`OSD_GRID_ROWS` - 1. */
  readonly row: number;
  readonly align: OsdAlign;
}

export type OsdLayout = Readonly<Record<OsdElementId, OsdPlacement>>;

export interface OsdElementInfo {
  readonly id: OsdElementId;
  readonly group: OsdGroup;
  readonly label: string;
  readonly description: string;
  /**
   * False for an element that only means something where it is.
   *
   * The horizon and the crosshair are attitude references read against the
   * middle of the picture, and the target indicator is drawn wherever the
   * target happens to be. Moving any of the three would not make a layout,
   * it would make a bug, so they can only be switched off.
   */
  readonly movable: boolean;
  /**
   * True for an element that is only drawn on some flights.
   *
   * Not a placement: it says the pilot may go a whole flight without seeing
   * it, so the editor can say so rather than looking broken.
   */
  readonly conditional: boolean;
  readonly defaults: OsdPlacement;
}

function place(
  column: number,
  row: number,
  align: OsdAlign = OSD_ALIGN.Left,
  enabled = true,
): OsdPlacement {
  return { enabled, column, row, align };
}

/**
 * Every element, in the order the editor lists them.
 *
 * The defaults are the layout a pilot who has ever worn goggles will recognise
 * without being told: speed on the left of the compass ribbon and height on
 * the right of it, both at eye level rather than in a corner; the middle of
 * the picture left to the horizon and the reticle; the way home under it; the
 * pack along the bottom, drawn out of it on the left and going into the motor
 * on the right; and the mission, the link and the session round the outside
 * where they can be glanced at rather than read.
 *
 * The rows are two apart wherever readouts stack, because a readout is a glyph
 * and a number rather than a line of small caps now and takes up more than one
 * cell of the grid. Everything the simulator draws is on by default — a pilot
 * who never opens the editor sees more than before, not less.
 */
export const OSD_ELEMENT_INFO: readonly OsdElementInfo[] = [
  // --- Instruments ---------------------------------------------------------
  {
    id: OSD_ELEMENT.Horizon,
    group: OSD_GROUP.Instruments,
    label: "Artificial horizon",
    description: "Attitude line and the sidebars it is read against",
    movable: false,
    conditional: false,
    defaults: place(30, 24, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.Crosshair,
    group: OSD_GROUP.Instruments,
    label: "Crosshair",
    description: "The reticle the nose is read against",
    movable: false,
    conditional: false,
    defaults: place(30, 24, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.TargetIndicator,
    group: OSD_GROUP.Instruments,
    label: "Target indicator",
    description: "Box and off-screen arrow on the contact",
    movable: false,
    conditional: true,
    defaults: place(30, 24, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.Minimap,
    group: OSD_GROUP.Instruments,
    label: "Minimap",
    description: "Tactical display, drawn round its anchor",
    movable: true,
    conditional: false,
    defaults: place(5, 42, OSD_ALIGN.Centre),
  },

  // --- Energy --------------------------------------------------------------
  {
    id: OSD_ELEMENT.Airspeed,
    group: OSD_GROUP.Energy,
    label: "Airspeed",
    description: "True airspeed through the air",
    movable: true,
    conditional: false,
    defaults: place(14, 12),
  },
  {
    id: OSD_ELEMENT.GroundSpeed,
    group: OSD_GROUP.Energy,
    label: "Ground speed",
    description: "Speed over the ground",
    movable: true,
    conditional: false,
    defaults: place(14, 14),
  },
  {
    id: OSD_ELEMENT.Wind,
    group: OSD_GROUP.Energy,
    label: "Wind",
    description: "Where it blows from, and how hard",
    movable: true,
    conditional: false,
    defaults: place(14, 16),
  },
  {
    id: OSD_ELEMENT.Throttle,
    group: OSD_GROUP.Energy,
    label: "Throttle",
    description: "Stick position, per cent",
    movable: true,
    conditional: false,
    defaults: place(58, 32, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.LoadFactor,
    group: OSD_GROUP.Energy,
    label: "G",
    description: "Load factor on the airframe",
    movable: true,
    conditional: false,
    defaults: place(14, 18),
  },
  {
    id: OSD_ELEMENT.Pitch,
    group: OSD_GROUP.Energy,
    label: "Pitch angle",
    description: "Nose up or down, degrees",
    movable: true,
    conditional: false,
    defaults: place(14, 20),
  },
  {
    id: OSD_ELEMENT.Roll,
    group: OSD_GROUP.Energy,
    label: "Roll angle",
    description: "Bank, degrees",
    movable: true,
    conditional: false,
    defaults: place(14, 22),
  },

  // --- Height --------------------------------------------------------------
  {
    id: OSD_ELEMENT.Altitude,
    group: OSD_GROUP.Height,
    label: "Altitude",
    description: "Height above the ellipsoid",
    movable: true,
    conditional: false,
    defaults: place(46, 14, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.AltitudeAgl,
    group: OSD_GROUP.Height,
    label: "Height above ground",
    description: "Clearance over the terrain below",
    movable: true,
    conditional: false,
    defaults: place(46, 12, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.VerticalSpeed,
    group: OSD_GROUP.Height,
    label: "Vertical speed",
    description: "Climb or sink rate",
    movable: true,
    conditional: false,
    defaults: place(46, 16, OSD_ALIGN.Right),
  },

  // --- Navigation ----------------------------------------------------------
  {
    id: OSD_ELEMENT.Heading,
    group: OSD_GROUP.Navigation,
    label: "Heading",
    description: "Compass degrees, over the nose",
    movable: true,
    conditional: false,
    defaults: place(30, 9, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.HeadingTape,
    group: OSD_GROUP.Navigation,
    label: "Compass ribbon",
    description: "Cardinal points sliding under the nose",
    movable: true,
    conditional: false,
    defaults: place(30, 12, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.HomeArrow,
    group: OSD_GROUP.Navigation,
    label: "Home",
    description: "Distance and bearing back to the launch point",
    movable: true,
    conditional: false,
    defaults: place(30, 36, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.TargetRange,
    group: OSD_GROUP.Navigation,
    label: "Target range",
    description: "Distance to the selected contact",
    movable: true,
    conditional: true,
    defaults: place(46, 20, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.TargetBearing,
    group: OSD_GROUP.Navigation,
    label: "Target bearing",
    description: "Which way it lies, and whether it can be seen",
    movable: true,
    conditional: true,
    defaults: place(46, 22, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.FlightMode,
    group: OSD_GROUP.Navigation,
    label: "Flight mode",
    description: "Acro, angle, or a return in progress",
    movable: true,
    conditional: true,
    defaults: place(30, 44, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.Holds,
    group: OSD_GROUP.Navigation,
    label: "Course and altitude hold",
    description: "What the flight controller is holding",
    movable: true,
    conditional: true,
    defaults: place(58, 3, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.Warnings,
    group: OSD_GROUP.Navigation,
    label: "Warnings",
    description: "Stall, terrain, damage, flat pack, lost picture",
    movable: true,
    conditional: true,
    defaults: place(30, 4, OSD_ALIGN.Centre),
  },

  // --- Power ---------------------------------------------------------------
  {
    id: OSD_ELEMENT.Battery,
    group: OSD_GROUP.Power,
    label: "Battery charge",
    description: "What is left in the pack, per cent",
    movable: true,
    conditional: false,
    defaults: place(2, 30),
  },
  {
    id: OSD_ELEMENT.BatteryVoltage,
    group: OSD_GROUP.Power,
    label: "Battery voltage",
    description: "Pack volts, and volts per cell",
    movable: true,
    conditional: false,
    defaults: place(2, 34),
  },
  {
    id: OSD_ELEMENT.BatteryCurrent,
    group: OSD_GROUP.Power,
    label: "Current draw",
    description: "What the motor is pulling, amps",
    movable: true,
    conditional: false,
    defaults: place(58, 30, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.BatteryMah,
    group: OSD_GROUP.Power,
    label: "Capacity drawn",
    description: "mAh out of the pack, against what it holds",
    movable: true,
    conditional: false,
    defaults: place(2, 32),
  },
  {
    id: OSD_ELEMENT.Endurance,
    group: OSD_GROUP.Power,
    label: "Endurance",
    description: "Flight left at the present draw",
    movable: true,
    conditional: false,
    defaults: place(58, 34, OSD_ALIGN.Right),
  },

  // --- Mission -------------------------------------------------------------
  {
    id: OSD_ELEMENT.MissionPanel,
    group: OSD_GROUP.Mission,
    label: "Mission panel",
    description: "The race, formation or festival block",
    movable: true,
    conditional: true,
    // Six lines deep, so it is delivered below the stack it stands in for
    // rather than on top of the two readouts that outlive it.
    defaults: place(2, 9),
  },
  {
    id: OSD_ELEMENT.Contacts,
    group: OSD_GROUP.Mission,
    label: "Contacts",
    description: "Aircraft in the air against you",
    movable: true,
    conditional: true,
    defaults: place(2, 1),
  },
  {
    id: OSD_ELEMENT.Interceptors,
    group: OSD_GROUP.Mission,
    label: "Airframes left",
    description: "How many more times you can bin it",
    movable: true,
    conditional: true,
    defaults: place(2, 3),
  },
  {
    id: OSD_ELEMENT.LinkQuality,
    group: OSD_GROUP.Mission,
    label: "Video link",
    description: "Picture quality on the goggles",
    movable: true,
    conditional: true,
    defaults: place(2, 5),
  },
  {
    id: OSD_ELEMENT.Tracking,
    group: OSD_GROUP.Mission,
    label: "Tracking flag",
    description: "Says a contact is locked",
    movable: true,
    conditional: true,
    // Under the contacts it belongs with. It is never drawn on a flight that
    // has a mission panel, so the two never meet.
    defaults: place(2, 7),
  },

  // --- Session -------------------------------------------------------------
  {
    id: OSD_ELEMENT.CraftName,
    group: OSD_GROUP.System,
    label: "Craft name",
    description: "The airframe being flown",
    movable: true,
    conditional: false,
    defaults: place(30, 46, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.FlightTimer,
    group: OSD_GROUP.System,
    label: "Flight timer",
    description: "Time since the launch",
    movable: true,
    conditional: false,
    defaults: place(20, 44, OSD_ALIGN.Centre),
  },
  {
    id: OSD_ELEMENT.CameraMode,
    group: OSD_GROUP.System,
    label: "Camera",
    description: "Which view the picture comes from",
    movable: true,
    conditional: false,
    defaults: place(58, 5, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.Fps,
    group: OSD_GROUP.System,
    label: "Frame rate",
    description: "Frames a second the world is drawn at",
    movable: true,
    conditional: false,
    defaults: place(58, 7, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.Coordinates,
    group: OSD_GROUP.System,
    label: "Coordinates",
    description: "Latitude and longitude",
    movable: true,
    conditional: false,
    defaults: place(58, 46, OSD_ALIGN.Right),
  },
  {
    id: OSD_ELEMENT.TerrainHeight,
    group: OSD_GROUP.System,
    label: "Terrain height",
    description: "Elevation of the ground below",
    movable: true,
    conditional: false,
    defaults: place(58, 44, OSD_ALIGN.Right),
  },
];

export const OSD_ELEMENTS: readonly OsdElementId[] = OSD_ELEMENT_INFO.map(
  (info) => info.id,
);

export const OSD_GROUPS: readonly OsdGroup[] = [
  OSD_GROUP.Instruments,
  OSD_GROUP.Energy,
  OSD_GROUP.Height,
  OSD_GROUP.Navigation,
  OSD_GROUP.Power,
  OSD_GROUP.Mission,
  OSD_GROUP.System,
];

const INFO_BY_ID = new Map<OsdElementId, OsdElementInfo>(
  OSD_ELEMENT_INFO.map((info) => [info.id, info]),
);

export function osdElementInfo(id: OsdElementId): OsdElementInfo {
  const info = INFO_BY_ID.get(id);
  // Every id in the union is in the table; the fallback only exists so no
  // caller has to deal with `undefined`.
  return (
    info ?? {
      id,
      group: OSD_GROUP.System,
      label: id,
      description: "",
      movable: true,
      conditional: false,
      defaults: place(0, 0),
    }
  );
}

export function osdElementsInGroup(group: OsdGroup): readonly OsdElementInfo[] {
  return OSD_ELEMENT_INFO.filter((info) => info.group === group);
}

/**
 * Where one element sits, whatever the layout is missing.
 *
 * A layout outlives the build that wrote it, so a stored one can be a
 * catalogue behind: an element added since is simply not in it. Reading it
 * straight would hand the display an `undefined` and take the whole OSD down
 * with it — not the readout that is missing, the lot. Every reader goes
 * through here instead and gets the element's delivered placement, which is
 * the same repair `normaliseOsdLayout` makes on the way in and costs nothing
 * to make twice.
 */
export function osdPlacement(
  layout: OsdLayout,
  id: OsdElementId,
): OsdPlacement {
  return layout[id] ?? osdElementInfo(id).defaults;
}

export const DEFAULT_OSD_LAYOUT: OsdLayout = Object.freeze(
  Object.fromEntries(
    OSD_ELEMENT_INFO.map((info) => [info.id, info.defaults]),
  ) as Record<OsdElementId, OsdPlacement>,
);

// --- Where the flight is being watched from --------------------------------

/**
 * The two pictures a flight can be watched on, which want different displays.
 *
 * An OSD is not a game overlay. It is characters a flight controller lays over
 * the composite video before it leaves the aircraft, so it belongs to the
 * picture the camera on the nose is sending down and to nothing else: an
 * artificial horizon read against the middle of *that* picture is the pilot's
 * attitude reference, and the same horizon drawn over a view of the aircraft
 * from a hundred metres away is a line across a photograph.
 *
 * So the RC ground view — where the pilot is standing on the field looking at
 * the model with their own eyes — and the chase camera get the other display:
 * the numbers, gathered down the two edges of the monitor where they can be
 * read without covering the aircraft, and none of the instruments that only
 * mean anything from the cockpit.
 */
export const OSD_VIEW = {
  /** What the goggles are showing: the aircraft's own camera, and its OSD. */
  Goggles: "GOGGLES",
  /** The aircraft seen from outside: from the field, or from a chase camera. */
  Field: "FIELD",
} as const;

export type OsdView = (typeof OSD_VIEW)[keyof typeof OSD_VIEW];

function edge(
  column: number,
  row: number,
  align: OsdAlign = OSD_ALIGN.Left,
): OsdPlacement {
  return { enabled: true, column, row, align };
}

/** Never drawn off the aircraft's own camera, whatever the pilot has turned on. */
function off(): OsdPlacement {
  return { enabled: false, column: 30, row: 24, align: OSD_ALIGN.Centre };
}

/**
 * The display for a flight being watched from outside the aircraft.
 *
 * Two columns hard against the edges of the monitor and nothing anywhere else:
 * what is being looked at is the aircraft, and on a line-of-sight launch it is
 * a model against a sky and it is small. So the middle of the picture is left
 * completely alone — no horizon, no reticle — and everything that was arranged
 * around a nose that is no longer in front of the pilot is arranged around the
 * screen instead. What the aircraft is doing goes down the left, because that
 * is the column the eye comes back to; what the *flight* is doing — the clock,
 * the pack, the mission, the contacts — goes down the right.
 *
 * The pilot's own layout still decides what is on: an element switched off in
 * the editor stays off here. Where it sits is not theirs to set, because this
 * is the simulator's own screen furniture rather than the aircraft's OSD.
 */
const FIELD_PLACEMENTS: Readonly<Record<OsdElementId, OsdPlacement>> = {
  // The instruments of a cockpit nobody is sitting in.
  [OSD_ELEMENT.Horizon]: off(),
  [OSD_ELEMENT.Crosshair]: off(),
  [OSD_ELEMENT.HeadingTape]: off(),
  // There are no goggles, so there is no picture to lose.
  [OSD_ELEMENT.LinkQuality]: off(),
  // Both are drawn where the thing they point at is rather than on the grid,
  // and finding a model in a big sky is exactly what they are for.
  [OSD_ELEMENT.TargetIndicator]: edge(30, 24, OSD_ALIGN.Centre),
  [OSD_ELEMENT.Minimap]: edge(7, 41, OSD_ALIGN.Centre),

  // Down the left: the aircraft.
  [OSD_ELEMENT.CraftName]: edge(2, 2),
  [OSD_ELEMENT.Airspeed]: edge(2, 5),
  [OSD_ELEMENT.GroundSpeed]: edge(2, 7),
  [OSD_ELEMENT.AltitudeAgl]: edge(2, 9),
  [OSD_ELEMENT.Altitude]: edge(2, 11),
  [OSD_ELEMENT.VerticalSpeed]: edge(2, 13),
  [OSD_ELEMENT.Heading]: edge(2, 15),
  [OSD_ELEMENT.Wind]: edge(2, 17),
  [OSD_ELEMENT.Throttle]: edge(2, 19),
  [OSD_ELEMENT.LoadFactor]: edge(2, 21),
  [OSD_ELEMENT.Pitch]: edge(2, 23),
  [OSD_ELEMENT.Roll]: edge(2, 25),
  [OSD_ELEMENT.HomeArrow]: edge(2, 28),
  [OSD_ELEMENT.TerrainHeight]: edge(2, 30),
  [OSD_ELEMENT.Coordinates]: edge(2, 32),

  // Down the right: the flight.
  [OSD_ELEMENT.FlightTimer]: edge(58, 2, OSD_ALIGN.Right),
  [OSD_ELEMENT.CameraMode]: edge(58, 4, OSD_ALIGN.Right),
  [OSD_ELEMENT.Fps]: edge(58, 6, OSD_ALIGN.Right),
  [OSD_ELEMENT.FlightMode]: edge(58, 9, OSD_ALIGN.Right),
  [OSD_ELEMENT.Holds]: edge(58, 11, OSD_ALIGN.Right),
  [OSD_ELEMENT.Contacts]: edge(58, 14, OSD_ALIGN.Right),
  [OSD_ELEMENT.Interceptors]: edge(58, 16, OSD_ALIGN.Right),
  [OSD_ELEMENT.Tracking]: edge(58, 18, OSD_ALIGN.Right),
  // Six lines deep, so it is given the gap the battery block starts after.
  [OSD_ELEMENT.MissionPanel]: edge(58, 21, OSD_ALIGN.Right),
  [OSD_ELEMENT.Battery]: edge(58, 30, OSD_ALIGN.Right),
  [OSD_ELEMENT.BatteryVoltage]: edge(58, 32, OSD_ALIGN.Right),
  [OSD_ELEMENT.BatteryMah]: edge(58, 34, OSD_ALIGN.Right),
  [OSD_ELEMENT.BatteryCurrent]: edge(58, 36, OSD_ALIGN.Right),
  [OSD_ELEMENT.Endurance]: edge(58, 38, OSD_ALIGN.Right),
  [OSD_ELEMENT.TargetRange]: edge(58, 41, OSD_ALIGN.Right),
  [OSD_ELEMENT.TargetBearing]: edge(58, 43, OSD_ALIGN.Right),

  // Across the top, where a warning is a warning whatever is being looked at.
  [OSD_ELEMENT.Warnings]: edge(30, 3, OSD_ALIGN.Centre),
};

export const FIELD_OSD_LAYOUT: OsdLayout = Object.freeze({
  ...FIELD_PLACEMENTS,
});

// One layout in, one layout out, and the same one back for as long as the
// pilot does not change theirs: this is read on every frame the HUD draws.
let lastGoggles: OsdLayout | null = null;
let lastField: OsdLayout | null = null;

/**
 * The display to draw, for the picture the flight is being watched on.
 *
 * The goggles get the pilot's own OSD, exactly as they laid it out. Everything
 * else gets the field display, carrying over which elements the pilot wanted —
 * an element they switched off is off wherever they are looking from.
 */
export function osdLayoutFor(layout: OsdLayout, view: OsdView): OsdLayout {
  if (view === OSD_VIEW.Goggles) return layout;
  if (lastGoggles === layout && lastField) return lastField;

  const next = {} as Record<OsdElementId, OsdPlacement>;
  for (const info of OSD_ELEMENT_INFO) {
    const placement = FIELD_PLACEMENTS[info.id];
    const wanted = (layout[info.id] ?? info.defaults).enabled;
    next[info.id] = placement.enabled === wanted
      ? placement
      : { ...placement, enabled: placement.enabled && wanted };
  }

  lastGoggles = layout;
  lastField = next;
  return next;
}

// --- Editing ---------------------------------------------------------------

export function clampColumn(column: number): number {
  if (!Number.isFinite(column)) return 0;
  return Math.min(OSD_GRID_COLUMNS - 1, Math.max(0, Math.round(column)));
}

export function clampRow(row: number): number {
  if (!Number.isFinite(row)) return 0;
  return Math.min(OSD_GRID_ROWS - 1, Math.max(0, Math.round(row)));
}

function isAlign(value: unknown): value is OsdAlign {
  return (
    value === OSD_ALIGN.Left ||
    value === OSD_ALIGN.Centre ||
    value === OSD_ALIGN.Right
  );
}

/**
 * Moves or restyles one element, leaving every other one alone.
 *
 * An element that is pinned by what it is keeps its own anchor whatever the
 * caller asks for: the editor does not offer to move it, and a layout loaded
 * from storage cannot smuggle a move past this either.
 */
export function withOsdPlacement(
  layout: OsdLayout,
  id: OsdElementId,
  change: Partial<OsdPlacement>,
): OsdLayout {
  const info = osdElementInfo(id);
  const current = layout[id] ?? info.defaults;
  const next: OsdPlacement = info.movable
    ? {
        enabled: change.enabled ?? current.enabled,
        column: clampColumn(change.column ?? current.column),
        row: clampRow(change.row ?? current.row),
        align: isAlign(change.align) ? change.align : current.align,
      }
    : {
        ...info.defaults,
        enabled: change.enabled ?? current.enabled,
      };
  return { ...layout, [id]: next };
}

export function withOsdEnabled(
  layout: OsdLayout,
  id: OsdElementId,
  enabled: boolean,
): OsdLayout {
  return withOsdPlacement(layout, id, { enabled });
}

/** Puts one element back where it is delivered, without touching the rest. */
export function resetOsdElement(
  layout: OsdLayout,
  id: OsdElementId,
): OsdLayout {
  return { ...layout, [id]: osdElementInfo(id).defaults };
}

/**
 * Repairs a layout loaded from storage.
 *
 * A layout outlives the version of the simulator that wrote it: an element
 * added since gets its default placement, one that has been removed is
 * dropped, and anything out of the grid — or not a number at all — is pulled
 * back inside it rather than being drawn off the edge of the picture where
 * nobody could find it again.
 */
export function normaliseOsdLayout(stored: unknown): OsdLayout {
  const raw = (stored ?? {}) as Partial<Record<OsdElementId, unknown>>;
  const next = {} as Record<OsdElementId, OsdPlacement>;

  for (const info of OSD_ELEMENT_INFO) {
    const entry = raw[info.id] as Partial<OsdPlacement> | undefined;
    if (!entry || typeof entry !== "object") {
      next[info.id] = info.defaults;
      continue;
    }
    const enabled =
      typeof entry.enabled === "boolean" ? entry.enabled : info.defaults.enabled;
    if (!info.movable) {
      next[info.id] = { ...info.defaults, enabled };
      continue;
    }
    next[info.id] = {
      enabled,
      column:
        typeof entry.column === "number"
          ? clampColumn(entry.column)
          : info.defaults.column,
      row:
        typeof entry.row === "number" ? clampRow(entry.row) : info.defaults.row,
      align: isAlign(entry.align) ? entry.align : info.defaults.align,
    };
  }

  return next;
}

// --- Projection ------------------------------------------------------------

/** Where an anchor sits as a fraction of the picture, 0..1 on both axes. */
export function osdAnchorFraction(placement: OsdPlacement): {
  x: number;
  y: number;
} {
  return {
    x: placement.column / OSD_GRID_COLUMNS,
    y: placement.row / OSD_GRID_ROWS,
  };
}

/** The same anchor in pixels, for the layer that draws on a canvas. */
export function osdAnchorPixels(
  placement: OsdPlacement,
  width: number,
  height: number,
): { x: number; y: number } {
  const fraction = osdAnchorFraction(placement);
  return { x: fraction.x * width, y: fraction.y * height };
}

/** The grid cell a point in the picture falls in, as a fraction of it. */
export function osdCellAt(
  xFraction: number,
  yFraction: number,
): { column: number; row: number } {
  return {
    column: clampColumn(xFraction * OSD_GRID_COLUMNS),
    row: clampRow(yFraction * OSD_GRID_ROWS),
  };
}

// --- Compass ribbon --------------------------------------------------------

/** Degrees between two marks on the ribbon. */
export const COMPASS_TAPE_STEP = 15;

const CARDINALS: readonly { at: number; label: string }[] = [
  { at: 0, label: "N" },
  { at: 45, label: "NE" },
  { at: 90, label: "E" },
  { at: 135, label: "SE" },
  { at: 180, label: "S" },
  { at: 225, label: "SW" },
  { at: 270, label: "W" },
  { at: 315, label: "NW" },
];

export interface CompassMark {
  /** Bearing this mark stands for, 0..360. */
  readonly bearing: number;
  /** The cardinal or ordinal point, or `null` for a plain tick. */
  readonly label: string | null;
  /** True for the mark under the nose. */
  readonly centre: boolean;
}

/**
 * The compass ribbon under the nose.
 *
 * A window of marks either side of the heading, rounded to the nearest step so
 * the ribbon slides in whole cells instead of shimmering — which is what a
 * flight controller's own heading graph does, and what makes it readable at
 * all when the aircraft is rolling.
 */
export function compassTape(
  headingDeg: number,
  marks = 9,
  step = COMPASS_TAPE_STEP,
): CompassMark[] {
  const half = Math.floor(marks / 2);
  const centre = Math.round(normaliseBearing(headingDeg) / step) * step;
  const out: CompassMark[] = [];

  for (let i = -half; i <= half; i += 1) {
    const bearing = normaliseBearing(centre + i * step);
    const cardinal = CARDINALS.find(
      (point) => Math.abs(bearingDelta(bearing, point.at)) < step / 2,
    );
    out.push({
      bearing,
      label: cardinal ? cardinal.label : null,
      centre: i === 0,
    });
  }

  return out;
}

function normaliseBearing(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Signed difference between two bearings, -180..180. */
function bearingDelta(from: number, to: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return delta;
}
