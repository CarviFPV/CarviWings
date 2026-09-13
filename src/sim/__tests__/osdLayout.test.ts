import { assert, assertClose, suite } from "./harness";
import {
  DEFAULT_OSD_LAYOUT,
  FIELD_OSD_LAYOUT,
  OSD_ALIGN,
  OSD_ELEMENT,
  OSD_ELEMENTS,
  OSD_ELEMENT_INFO,
  OSD_GRID_COLUMNS,
  OSD_GRID_ROWS,
  OSD_GROUPS,
  OSD_VIEW,
  compassTape,
  normaliseOsdLayout,
  osdAnchorFraction,
  osdLayoutFor,
  osdAnchorPixels,
  osdCellAt,
  osdElementInfo,
  osdElementsInGroup,
  osdPlacement,
  resetOsdElement,
  withOsdEnabled,
  withOsdPlacement,
} from "../hud/osdLayout";
import type { CompassMark, OsdElementId } from "../hud/osdLayout";

export function runOsdLayoutTests(): void {
  suite("osd element catalogue", () => {
    const ids = new Set<string>(OSD_ELEMENTS);
    assert(ids.size === OSD_ELEMENT_INFO.length, "every element id is unique");
    assert(
      OSD_ELEMENT_INFO.every((info) => OSD_GROUPS.includes(info.group)),
      "every element is in a group the editor lists",
    );
    assert(
      OSD_GROUPS.every((group) => osdElementsInGroup(group).length > 0),
      "no group is listed with nothing in it",
    );
    assert(
      OSD_ELEMENT_INFO.every(
        (info) =>
          info.defaults.column >= 0 &&
          info.defaults.column < OSD_GRID_COLUMNS &&
          info.defaults.row >= 0 &&
          info.defaults.row < OSD_GRID_ROWS,
      ),
      "every default placement is inside the grid",
    );
    assert(
      OSD_ELEMENT_INFO.every((info) => info.defaults.enabled),
      "everything the simulator draws is on by default",
    );
    assert(
      osdElementInfo(OSD_ELEMENT.Minimap).label === "Minimap",
      "an element can be looked up by id",
    );

    // A readout is a glyph and a number, which is taller than one cell of the
    // grid, so two of them delivered a row apart in the same column are drawn
    // over each other and the pilot loses whichever is underneath. The three
    // pinned instruments all sit on the middle of the picture by definition
    // and are drawn as line art, so they are not in this.
    const stacked = OSD_ELEMENT_INFO.filter((info) => info.movable);
    const collisions = stacked.flatMap((info) =>
      stacked
        .filter(
          (other) =>
            other.id !== info.id &&
            other.defaults.column === info.defaults.column &&
            other.defaults.align === info.defaults.align &&
            Math.abs(other.defaults.row - info.defaults.row) < 2,
        )
        .map((other) => `${info.id}/${other.id}`),
    );
    assert(
      collisions.length === 0,
      `stacked defaults stand clear of each other, got ${collisions.join(", ")}`,
    );
  });

  suite("osd placement editing", () => {
    const moved = withOsdPlacement(DEFAULT_OSD_LAYOUT, OSD_ELEMENT.Altitude, {
      column: 10,
      row: 4,
      align: OSD_ALIGN.Left,
    });
    assert(moved[OSD_ELEMENT.Altitude].column === 10, "an element moves");
    assert(moved[OSD_ELEMENT.Altitude].row === 4, "on both axes");
    assert(
      moved[OSD_ELEMENT.Altitude].align === OSD_ALIGN.Left,
      "and takes the alignment it was given",
    );
    assert(
      moved[OSD_ELEMENT.Airspeed].column ===
        DEFAULT_OSD_LAYOUT[OSD_ELEMENT.Airspeed].column,
      "moving one element leaves the others where they were",
    );

    const outside = withOsdPlacement(DEFAULT_OSD_LAYOUT, OSD_ELEMENT.Altitude, {
      column: 500,
      row: -20,
    });
    assert(
      outside[OSD_ELEMENT.Altitude].column === OSD_GRID_COLUMNS - 1,
      "a column past the right edge is pulled back onto the picture",
    );
    assert(
      outside[OSD_ELEMENT.Altitude].row === 0,
      "and a negative row back onto the top of it",
    );

    const pinned = withOsdPlacement(DEFAULT_OSD_LAYOUT, OSD_ELEMENT.Horizon, {
      column: 0,
      row: 0,
    });
    assert(
      pinned[OSD_ELEMENT.Horizon].column ===
        osdElementInfo(OSD_ELEMENT.Horizon).defaults.column,
      "an instrument that only reads centred cannot be moved off centre",
    );

    const off = withOsdEnabled(DEFAULT_OSD_LAYOUT, OSD_ELEMENT.Horizon, false);
    assert(!off[OSD_ELEMENT.Horizon].enabled, "but it can still be switched off");

    const back = resetOsdElement(moved, OSD_ELEMENT.Altitude);
    assert(
      back[OSD_ELEMENT.Altitude].column ===
        DEFAULT_OSD_LAYOUT[OSD_ELEMENT.Altitude].column,
      "one element goes back to its delivered place on its own",
    );
  });

  suite("osd placement reading", () => {
    assert(
      osdPlacement(DEFAULT_OSD_LAYOUT, OSD_ELEMENT.Throttle) ===
        DEFAULT_OSD_LAYOUT[OSD_ELEMENT.Throttle],
      "an element that is in the layout is read straight out of it",
    );

    // A layout stored by a build that predates an element reaches the display
    // without it. Falling over there would take the whole OSD down, not the
    // one readout, so the element is drawn where it is delivered instead.
    const behind = { ...DEFAULT_OSD_LAYOUT } as Record<string, unknown>;
    delete behind[OSD_ELEMENT.Throttle];
    const placement = osdPlacement(
      behind as unknown as typeof DEFAULT_OSD_LAYOUT,
      OSD_ELEMENT.Throttle,
    );
    assert(
      placement.enabled &&
        placement.column ===
          osdElementInfo(OSD_ELEMENT.Throttle).defaults.column &&
        placement.row === osdElementInfo(OSD_ELEMENT.Throttle).defaults.row,
      "an element the layout has never heard of is still placed and drawn",
    );
    assert(
      OSD_ELEMENTS.every((id) => osdPlacement({} as never, id).enabled),
      "and an empty layout draws the whole display rather than none of it",
    );
  });

  suite("osd layout repair", () => {
    const fresh = normaliseOsdLayout(undefined);
    assert(
      OSD_ELEMENTS.every((id) => fresh[id] !== undefined),
      "nothing stored yields the delivered layout",
    );

    const partial = normaliseOsdLayout({
      [OSD_ELEMENT.Altitude]: { enabled: false, column: 3, row: 7, align: "right" },
    });
    assert(
      !partial[OSD_ELEMENT.Altitude].enabled &&
        partial[OSD_ELEMENT.Altitude].column === 3,
      "a stored placement is kept",
    );
    assert(
      partial[OSD_ELEMENT.Airspeed].column ===
        DEFAULT_OSD_LAYOUT[OSD_ELEMENT.Airspeed].column,
      "an element the stored layout predates gets its default",
    );

    const junk = normaliseOsdLayout({
      [OSD_ELEMENT.Altitude]: { enabled: "yes", column: "left", row: 900, align: "up" },
      somethingRemovedSince: { enabled: true, column: 1, row: 1, align: "left" },
    });
    assert(
      junk[OSD_ELEMENT.Altitude].enabled,
      "a non-boolean enabled falls back to the default",
    );
    assert(
      junk[OSD_ELEMENT.Altitude].column ===
        DEFAULT_OSD_LAYOUT[OSD_ELEMENT.Altitude].column,
      "a column that is not a number falls back to the default",
    );
    assert(
      junk[OSD_ELEMENT.Altitude].row === OSD_GRID_ROWS - 1,
      "a row off the bottom is pulled back onto the picture",
    );
    assert(
      junk[OSD_ELEMENT.Altitude].align ===
        DEFAULT_OSD_LAYOUT[OSD_ELEMENT.Altitude].align,
      "an alignment the display does not have falls back to the default",
    );
    assert(
      !("somethingRemovedSince" in junk),
      "an element the simulator no longer draws is dropped",
    );

    const smuggled = normaliseOsdLayout({
      [OSD_ELEMENT.Horizon]: { enabled: true, column: 0, row: 0, align: "left" },
    });
    assert(
      smuggled[OSD_ELEMENT.Horizon].column ===
        osdElementInfo(OSD_ELEMENT.Horizon).defaults.column,
      "a stored layout cannot move a pinned instrument either",
    );
  });

  suite("osd projection", () => {
    const anchor = osdAnchorFraction({
      enabled: true,
      column: 30,
      row: 24,
      align: OSD_ALIGN.Centre,
    });
    assertClose(anchor.x, 0.5, 1e-9, "the middle column is half way across");
    assertClose(anchor.y, 0.5, 1e-9, "the middle row is half way down");

    const pixels = osdAnchorPixels(
      { enabled: true, column: 30, row: 24, align: OSD_ALIGN.Centre },
      1920,
      1080,
    );
    assertClose(pixels.x, 960, 1e-6, "and lands in the middle of a 1080p frame");
    assertClose(pixels.y, 540, 1e-6, "on both axes");

    const cell = osdCellAt(0.5, 0.5);
    assert(
      cell.column === 30 && cell.row === 24,
      "a point half way across the picture snaps to the middle cell",
    );
    const corner = osdCellAt(2, -1);
    assert(
      corner.column === OSD_GRID_COLUMNS - 1 && corner.row === 0,
      "a point dragged off the picture snaps to its edge",
    );
  });

  suite("compass ribbon", () => {
    const labels = (marks: readonly CompassMark[]): string =>
      marks.map((mark) => mark.label ?? ".").join(" ");
    const centreOf = (marks: readonly CompassMark[]): CompassMark | undefined =>
      marks.find((mark) => mark.centre);

    const north = compassTape(0);
    assert(north.length === 9, "the ribbon is as wide as it was asked for");
    assert(
      north.filter((mark) => mark.centre).length === 1,
      "exactly one mark sits under the nose",
    );
    assert(centreOf(north)?.label === "N", "flying north puts N under the nose");
    assert(
      labels(north) === ". NW . . N . . NE .",
      `north reads as a ribbon around N, got "${labels(north)}"`,
    );

    assert(
      centreOf(compassTape(90))?.label === "E",
      "flying east puts E under the nose",
    );
    assert(
      centreOf(compassTape(-10))?.bearing === 345,
      "a negative heading is still a compass bearing",
    );
    assert(
      compassTape(-10).every((mark) => mark.bearing >= 0 && mark.bearing < 360),
      "and every mark on it lies on the compass",
    );

    const wide = compassTape(180, 5, 45);
    assert(wide.length === 5, "the window can be narrowed");
    assert(
      labels(wide) === "E SE S SW W",
      `a wider step covers more of the compass, got "${labels(wide)}"`,
    );

    assert(
      centreOf(compassTape(22))?.label === null,
      "a heading between two points shows a plain tick under the nose",
    );
  });
}


export function runFieldOsdTests(): void {
  suite("the display for a flight watched from outside the aircraft", () => {
    assert(
      OSD_ELEMENTS.every((id) => FIELD_OSD_LAYOUT[id] !== undefined),
      "every element the simulator draws has somewhere to be on the field",
    );
    assert(
      OSD_ELEMENTS.every((id) => {
        const placement = FIELD_OSD_LAYOUT[id];
        return (
          placement.column >= 0 &&
          placement.column < OSD_GRID_COLUMNS &&
          placement.row >= 0 &&
          placement.row < OSD_GRID_ROWS
        );
      }),
      "and every one of them is inside the picture",
    );

    // The pilot is looking at a model in the sky. Nothing an FPV camera would
    // have put over the middle of the picture belongs across the top of it.
    const cockpit = [
      OSD_ELEMENT.Horizon,
      OSD_ELEMENT.Crosshair,
      OSD_ELEMENT.HeadingTape,
      OSD_ELEMENT.LinkQuality,
    ];
    assert(
      cockpit.every((id) => !FIELD_OSD_LAYOUT[id].enabled),
      "no horizon, no reticle, no compass ribbon and no link on a flight nobody is watching through goggles",
    );
    assert(
      cockpit.every((id) => DEFAULT_OSD_LAYOUT[id].enabled),
      "all of which are on in the goggles, which is what makes it a different display",
    );

    // Everything else is out of the way of the aircraft: hard left or hard
    // right, with the middle of the monitor left alone.
    const readouts = OSD_ELEMENT_INFO.filter(
      (info) => info.movable && FIELD_OSD_LAYOUT[info.id].enabled,
    );
    const centred = readouts.filter((info) => {
      const { column } = FIELD_OSD_LAYOUT[info.id];
      return column > 12 && column < OSD_GRID_COLUMNS - 12;
    });
    assert(
      centred.every(
        (info) =>
          info.id === OSD_ELEMENT.Warnings || info.id === OSD_ELEMENT.Minimap,
      ),
      `the readouts are down the edges, got ${centred.map((info) => info.id).join(", ")} in the middle`,
    );

    const collisions = readouts.flatMap((info) =>
      readouts
        .filter((other) => {
          const a = FIELD_OSD_LAYOUT[info.id];
          const b = FIELD_OSD_LAYOUT[other.id];
          return (
            other.id !== info.id &&
            a.column === b.column &&
            a.align === b.align &&
            Math.abs(a.row - b.row) < 2
          );
        })
        .map((other) => `${info.id}/${other.id}`),
    );
    assert(
      collisions.length === 0,
      `nothing is stacked on top of anything else, got ${collisions.join(", ")}`,
    );
  });

  suite("choosing the display for the picture", () => {
    assert(
      osdLayoutFor(DEFAULT_OSD_LAYOUT, OSD_VIEW.Goggles) === DEFAULT_OSD_LAYOUT,
      "the goggles get the pilot's own OSD, untouched",
    );

    const field = osdLayoutFor(DEFAULT_OSD_LAYOUT, OSD_VIEW.Field);
    assert(
      !field[OSD_ELEMENT.Horizon].enabled,
      "and the field display is the other one",
    );
    assert(
      field[OSD_ELEMENT.Airspeed].column ===
        FIELD_OSD_LAYOUT[OSD_ELEMENT.Airspeed].column,
      "with everything where the field display puts it",
    );
    assert(
      osdLayoutFor(DEFAULT_OSD_LAYOUT, OSD_VIEW.Field) === field,
      "the same layout back for the same input, because this is read every frame",
    );

    // What the pilot switched off stays off wherever they are watching from.
    const withoutWind = withOsdEnabled(DEFAULT_OSD_LAYOUT, OSD_ELEMENT.Wind, false);
    const trimmed = osdLayoutFor(withoutWind, OSD_VIEW.Field);
    assert(
      !trimmed[OSD_ELEMENT.Wind].enabled,
      "an element the pilot turned off is off on the field too",
    );
    assert(
      trimmed[OSD_ELEMENT.Airspeed].enabled,
      "and the rest of the display is untouched by that",
    );

    // The other way round is not on offer: the pilot cannot switch the horizon
    // back on over a view it cannot be read against.
    const withHorizon = withOsdEnabled(
      DEFAULT_OSD_LAYOUT,
      OSD_ELEMENT.Horizon,
      true,
    );
    assert(
      !osdLayoutFor(withHorizon, OSD_VIEW.Field)[OSD_ELEMENT.Horizon].enabled,
      "the instruments that only read from the cockpit stay off it",
    );
  });
}

/** Keeps the id type referenced, so a renamed element breaks this file too. */
export type OsdLayoutTestElement = OsdElementId;
