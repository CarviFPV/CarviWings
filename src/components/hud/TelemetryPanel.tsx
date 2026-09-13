"use client";

/**
 * Numeric OSD.
 *
 * Plain DOM rather than canvas: these are slow-moving numbers that want real
 * text rendering and Tailwind styling, and a ten-times-a-second React update on
 * a handful of spans costs nothing. The instruments that must move at display
 * rate — horizon, target indicator, minimap — live on the canvas layer instead.
 *
 * Nothing here decides where anything goes. Every readout is wrapped in a slot
 * that reads its cell out of the pilot's OSD layout, which is what makes the
 * same component serve both the flight and the editor: the editor renders it
 * over sample telemetry and hands the slots a drag handler.
 *
 * Nothing here is set in screen pixels either. The root carries `osd-scale`,
 * which sizes the type off the height of the picture, and every measurement
 * below is in `em` against it — so a readout is always the same fraction of a
 * grid cell whatever window the flight is being flown in, and an arrangement
 * that stands clear of itself in the editor stands clear of itself in the air.
 */

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { FlightTelemetry } from "@/sim/flight/telemetry";
import { MS_TO_KMH, formatDuration } from "@/sim/flight/telemetry";
import type {
  FestivalProgress,
  FormationProgress,
  RaceProgress,
} from "@/sim/mission";
import {
  PASS_FRACTION,
  STREAMER_STUB,
  formatRaceTime,
  formatStreamerLength,
  racePlacing,
} from "@/sim/mission";
import { formatWind } from "@/sim/environment/wind";
import {
  FLIGHT_MODE,
  FLIGHT_MODE_LABEL,
  RTH_STAGE_LABEL,
} from "@/sim/flight/flightModes";
import type {
  OsdElementId,
  OsdLayout,
  OsdPlacement,
  OsdView,
} from "@/sim/hud/osdLayout";
import {
  OSD_ALIGN,
  OSD_ELEMENT,
  OSD_VIEW,
  compassTape,
  osdAnchorFraction,
  osdPlacement,
} from "@/sim/hud/osdLayout";
import {
  AglGlyph,
  AirframeGlyph,
  AltitudeGlyph,
  BatteryGlyph,
  CurrentGlyph,
  HomeGlyph,
  LinkGlyph,
  LoadGlyph,
  SpeedGlyph,
  TargetGlyph,
  ThrottleGlyph,
  TimerGlyph,
  VerticalSpeedGlyph,
  WindGlyph,
} from "./OsdIcons";
import { formatRange } from "./draw/targetIndicator";

/** Picture quality below which the link is worth telling the pilot about. */
const VIDEO_CAUTION = 0.75;
/**
 * Charge below which the pack is a note, and below which it is a warning.
 *
 * The first is where a pilot who is a long way out turns for home; the second
 * is where there is no longer a decision to make. Both are read off the charge
 * rather than off the voltage, because a voltage under load is a number that
 * means something different in every turn.
 */
const BATTERY_CAUTION = 0.3;
const BATTERY_WARN = 0.12;
/** Integrity below which the airframe is a warning rather than a note. */
const AIRFRAME_WARN = 0.6;

/**
 * What a readout says when the quantity is not being simulated at all.
 *
 * A flight controller with nothing wired to a rail does not blank the cell, it
 * prints dashes: the pilot can see the readout is there and that it has no
 * number, which is a different thing from the readout being gone. Endurance
 * and charge get the infinity instead, because on an unlimited flight they
 * have an answer and it is "as long as you like".
 */
const UNMEASURED = "--";
const UNLIMITED = "\u221e";

type Tone = "normal" | "warn" | "caution" | "good";

const TONE_CLASS: Record<Tone, string> = {
  normal: "text-osd-bright",
  warn: "text-danger",
  caution: "text-amber",
  good: "text-osd-green",
};

/**
 * Cells in the pack, which is how an OSD says how big a battery is.
 *
 * Derived rather than carried: the simulation already publishes the pack and
 * the per-cell voltage, and their ratio is the count. Zero while the numbers
 * are not meaningful yet, which the caller draws as nothing at all.
 */
function packCells(voltage: number, cellVoltage: number): number {
  if (!(cellVoltage > 0.5)) return 0;
  return Math.max(1, Math.round(voltage / cellVoltage));
}

/**
 * What the editor needs from the display it is editing.
 *
 * Absent in flight, which is what keeps the OSD inert under the pointer: the
 * whole layer is `pointer-events-none` and nothing in it can be clicked.
 */
export interface OsdEditing {
  readonly selected: OsdElementId | null;
  readonly onSelect: (id: OsdElementId) => void;
  /** Pointer went down on an element; the editor takes it from there. */
  readonly onGrab: (id: OsdElementId, event: ReactPointerEvent<HTMLElement>) => void;
}

// --- Slots -----------------------------------------------------------------

function alignClass(align: OsdPlacement["align"]): string {
  if (align === OSD_ALIGN.Right) return "text-right";
  if (align === OSD_ALIGN.Centre) return "text-center";
  return "text-left";
}

function anchorStyle(placement: OsdPlacement): CSSProperties {
  const { x, y } = osdAnchorFraction(placement);
  const top = `${y * 100}%`;

  // A right-aligned element is pinned by its right edge rather than shifted
  // back from its left one. Both put it in the same place, but an element
  // offset from the left has only the width between its anchor and the edge of
  // the picture to lay itself out in — which, an inch from the right-hand
  // edge, is a column two characters wide and every readout wrapping in it.
  if (placement.align === OSD_ALIGN.Right) {
    return { position: "absolute", right: `${(1 - x) * 100}%`, top };
  }
  if (placement.align === OSD_ALIGN.Centre) {
    return {
      position: "absolute",
      left: `${x * 100}%`,
      top,
      transform: "translateX(-50%)",
    };
  }
  return { position: "absolute", left: `${x * 100}%`, top };
}

/**
 * One element, put where the layout says and drawn only if it is wanted.
 *
 * `visible` is the flight condition — a target readout with no target, a pack
 * readout on an unlimited flight. The editor overrides it, because an element
 * a pilot cannot see is an element they cannot place.
 */
function Slot({
  id,
  layout,
  editing,
  visible = true,
  children,
}: {
  id: OsdElementId;
  layout: OsdLayout;
  editing?: OsdEditing;
  visible?: boolean;
  children: ReactNode;
}) {
  const placement = osdPlacement(layout, id);
  if (!placement.enabled) return null;
  if (!visible && !editing) return null;

  const style = anchorStyle(placement);

  if (!editing) {
    return (
      <div style={style} className={alignClass(placement.align)}>
        {children}
      </div>
    );
  }

  const selected = editing.selected === id;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={id}
      aria-pressed={selected}
      onPointerDown={(event) => editing.onGrab(id, event)}
      onFocus={() => editing.onSelect(id)}
      style={style}
      className={`cursor-grab touch-none border border-dashed transition-colors active:cursor-grabbing ${alignClass(
        placement.align,
      )} ${
        selected
          ? "border-cyan bg-cyan/10"
          : "border-transparent hover:border-hairline-bright"
      }`}
    >
      {children}
    </div>
  );
}

// --- Readouts --------------------------------------------------------------

/**
 * A unit, set the way a character generator sets one.
 *
 * Small, and stacked when it is a rate: an OSD has no room for `km/h` on one
 * line, so it puts `km` over `h` in a single cell and every FPV pilot reads it
 * without thinking about it. A unit with no solidus in it is just small.
 */
function Unit({ unit }: { unit: string }) {
  const solidus = unit.indexOf("/");
  if (solidus < 0) {
    return <span className="text-[0.6em] text-osd-bright">{unit}</span>;
  }
  return (
    <span className="inline-flex flex-col items-center text-[0.46em] leading-[1.02] text-osd-bright">
      <span>{unit.slice(0, solidus)}</span>
      <span>{unit.slice(solidus + 1)}</span>
    </span>
  );
}

/**
 * One readout: a glyph, a number, and what the number is in.
 *
 * No three-letter caption — a flight controller does not have the cells for
 * one, and the picture in front of the number is what says which number it is.
 * The glyph always leads, whichever edge the readout is pinned to, because
 * that is the order the eye has learnt on real goggles.
 */
function Readout({
  glyph,
  value,
  unit,
  tone = "normal",
  align = OSD_ALIGN.Left,
}: {
  glyph?: ReactNode;
  value: string;
  unit?: string;
  tone?: Tone;
  align?: OsdPlacement["align"];
}) {
  return (
    <div
      className={`flex items-center gap-[0.25em] leading-none ${
        align === OSD_ALIGN.Right
          ? "justify-end"
          : align === OSD_ALIGN.Centre
            ? "justify-center"
            : ""
      }`}
    >
      {glyph}
      <span className={`text-[1.125em] tabular-nums ${TONE_CLASS[tone]}`}>{value}</span>
      {unit ? <Unit unit={unit} /> : null}
    </div>
  );
}

/** A glyph and whatever it stands in front of: the compact form. */
function Tag({
  glyph,
  label,
  children,
  align = OSD_ALIGN.Left,
}: {
  /** The picture that says what this is; a caption only where there is none. */
  glyph?: ReactNode;
  label?: string;
  children: ReactNode;
  align?: OsdPlacement["align"];
}) {
  return (
    <div
      className={`flex items-center gap-[0.25em] leading-none ${
        align === OSD_ALIGN.Right
          ? "justify-end"
          : align === OSD_ALIGN.Centre
            ? "justify-center"
            : ""
      }`}
    >
      {glyph}
      {label ? (
        <span className="text-[0.6875em] tracking-[0.12em] text-osd-bright">{label}</span>
      ) : null}
      {children}
    </div>
  );
}

export function TelemetryPanel({
  telemetry,
  layout,
  flightTime,
  fps,
  cameraMode,
  craftName,
  enemyCount,
  hasTarget,
  interceptors,
  formation,
  race,
  festival,
  formationSlot,
  flightSize,
  manoeuvre,
  view = OSD_VIEW.Goggles,
  editing,
}: {
  telemetry: FlightTelemetry;
  /** Where every element sits, and whether the pilot wants it. */
  layout: OsdLayout;
  /**
   * Which picture this is being drawn over.
   *
   * The layout has already been chosen for it; what is left is the handful of
   * notes that only mean something on one of them — a link that can break up
   * is a link the pilot is watching through.
   */
  view?: OsdView;
  flightTime: number;
  fps: number;
  cameraMode: string;
  /** The airframe being flown, the way a flight controller carries a name. */
  craftName: string;
  enemyCount: number;
  hasTarget: boolean;
  /** Airframes left including this one; omitted in free flight. */
  interceptors?: number;
  /** How the slot is being held; only on a formation flight. */
  formation?: FormationProgress;
  /** How the race is going; only on a race. */
  race?: RaceProgress;
  /** What is left of the field; only at a festival. */
  festival?: FestivalProgress;
  formationSlot?: string;
  /** Aircraft still flying in the formation, the leader included. */
  flightSize?: number;
  manoeuvre?: string;
  /** Set only by the layout editor; absent in flight. */
  editing?: OsdEditing;
}) {
  const { verticalSpeed, altitudeAgl: agl, grounded } = telemetry;
  const cells = packCells(
    telemetry.batteryVoltage,
    telemetry.batteryCellVoltage,
  );
  const missionPanel = formation ?? race ?? festival;
  const alignOf = (id: OsdElementId): OsdPlacement["align"] =>
    osdPlacement(layout, id).align;

  const slot = (
    id: OsdElementId,
    visible: boolean,
    children: ReactNode,
  ): ReactNode => (
    <Slot id={id} layout={layout} editing={editing} visible={visible}>
      {children}
    </Slot>
  );

  const assisted =
    telemetry.flightMode !== FLIGHT_MODE.Acro ||
    telemetry.courseHold ||
    telemetry.altitudeHold ||
    telemetry.returnHome;

  return (
    <div
      className={`osd-glow osd-typeface osd-scale absolute inset-0 z-20 select-none ${
        editing ? "" : "pointer-events-none"
      }`}
    >
      {/* --- Mission ------------------------------------------------------ */}
      {slot(
        OSD_ELEMENT.MissionPanel,
        missionPanel !== undefined,
        formation ? (
          <FormationReadout
            formation={formation}
            slot={formationSlot}
            flightSize={flightSize}
            manoeuvre={manoeuvre}
          />
        ) : race ? (
          <RaceReadout race={race} />
        ) : festival ? (
          <FestivalReadout festival={festival} />
        ) : null,
      )}
      {slot(
        OSD_ELEMENT.Contacts,
        missionPanel === undefined,
        <Tag glyph={<TargetGlyph />} align={alignOf(OSD_ELEMENT.Contacts)}>
          <span
            className={`tabular-nums text-[1.125em] ${
              enemyCount > 0 ? "text-danger" : "text-osd-bright/80"
            }`}
          >
            {enemyCount}
          </span>
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.Interceptors,
        interceptors !== undefined && Number.isFinite(interceptors),
        <Tag
          glyph={<AirframeGlyph />}
          align={alignOf(OSD_ELEMENT.Interceptors)}
        >
          <span
            className={`tabular-nums text-[1.125em] ${
              (interceptors ?? 0) <= 1 ? "text-danger" : "text-osd-bright"
            }`}
          >
            {interceptors ?? 0}
          </span>
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.LinkQuality,
        telemetry.videoLinkEnabled,
        <Tag glyph={<LinkGlyph />} align={alignOf(OSD_ELEMENT.LinkQuality)}>
          <span
            className={`tabular-nums text-[1.125em] ${
              telemetry.videoQuality <= 0
                ? "text-danger"
                : telemetry.videoQuality < VIDEO_CAUTION
                  ? "text-amber"
                  : "text-osd-bright"
            }`}
          >
            {Math.round(telemetry.videoQuality * 100)}
            <span className="text-osd-bright/80">%</span>
          </span>
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.Tracking,
        hasTarget && missionPanel === undefined,
        <div className="text-[0.6875em] tracking-[0.2em] text-amber">TRACKING</div>,
      )}

      {/* --- Power -------------------------------------------------------- */}
      {/* Drawn whether or not a pack is being simulated. An unlimited flight
          is a state of the aircraft, not an absence of one: quietly dropping
          five readouts the pilot placed themselves leaves them staring at a
          display with holes in it and no way to tell a setting from a fault.
          So the cells stay filled, and the numbers that are not being measured
          read the way a flight controller with no sensor on that rail reads —
          `--`, with the endurance and the charge going to infinity. */}
      {slot(
        OSD_ELEMENT.Battery,
        true,
        <Tag
          glyph={<BatteryGlyph charge={telemetry.batteryEnabled ? telemetry.batteryCharge : 1} />}
          align={alignOf(OSD_ELEMENT.Battery)}
        >
          <span
            className={`tabular-nums text-[1.125em] ${
              !telemetry.batteryEnabled
                ? "text-osd-bright/80"
                : telemetry.batteryCut || telemetry.batteryCharge < BATTERY_WARN
                  ? "text-danger"
                  : telemetry.batteryCharge < BATTERY_CAUTION
                    ? "text-amber"
                    : "text-osd-bright"
            }`}
          >
            {telemetry.batteryEnabled ? (
              <>
                {Math.round(telemetry.batteryCharge * 100)}
                <span className="text-osd-bright/80">%</span>
              </>
            ) : (
              UNLIMITED
            )}
          </span>
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.BatteryVoltage,
        true,
        <Tag align={alignOf(OSD_ELEMENT.BatteryVoltage)}>
          {/* The pack the way a goggle calls it out: how many cells it is,
              what the whole of it reads, and then the per-cell number that is
              the one a pilot actually flies to. */}
          <span
            className={`tabular-nums text-[1.125em] ${
              !telemetry.batteryEnabled
                ? "text-osd-bright/80"
                : telemetry.batteryCut
                  ? "text-danger"
                  : "text-osd-bright"
            }`}
          >
            {!telemetry.batteryEnabled
              ? `${UNMEASURED}${telemetry.fuelled ? "L" : "V"}`
              : telemetry.fuelled
                ? `${telemetry.fuelLitres.toFixed(1)}L`
                : `${cells > 0 ? `${cells}S ` : ""}${telemetry.batteryVoltage.toFixed(1)}V`}
          </span>
          <span className="tabular-nums text-[0.875em] text-osd-bright">
            {!telemetry.batteryEnabled
              ? UNMEASURED
              : telemetry.fuelled
                ? `/${telemetry.fuelCapacityLitres.toFixed(1)}`
                : telemetry.batteryCellVoltage.toFixed(2)}
          </span>
          <span className="text-[0.6em] tracking-widest text-osd-bright">
            {telemetry.fuelled ? "FUEL" : "VOLT"}
          </span>
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.BatteryCurrent,
        true,
        <Tag
          glyph={<CurrentGlyph />}
          align={alignOf(OSD_ELEMENT.BatteryCurrent)}
        >
          <span
            className={`tabular-nums text-[1.125em] ${
              telemetry.batteryEnabled ? "text-osd-bright" : "text-osd-bright/80"
            }`}
          >
            {!telemetry.batteryEnabled
              ? UNMEASURED
              : telemetry.fuelled
                ? telemetry.fuelBurnLitresPerHour.toFixed(2)
                : telemetry.batteryCurrent.toFixed(2)}
          </span>
          <span className="text-[0.6em] tracking-widest text-osd-bright">
            {telemetry.fuelled ? "L/H" : "AMP"}
          </span>
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.BatteryMah,
        true,
        <Readout
          align={alignOf(OSD_ELEMENT.BatteryMah)}
          value={
            !telemetry.batteryEnabled
              ? UNMEASURED
              : telemetry.fuelled
                ? (
                    telemetry.fuelCapacityLitres - telemetry.fuelLitres
                  ).toFixed(1)
                : `${Math.round(telemetry.batteryConsumedMah)}`
          }
          unit={telemetry.fuelled ? "litres" : "mA/h"}
        />,
      )}
      {slot(
        OSD_ELEMENT.Endurance,
        true,
        <Readout
          glyph={<TimerGlyph />}
          align={alignOf(OSD_ELEMENT.Endurance)}
          value={
            !telemetry.batteryEnabled
              ? UNLIMITED
              : telemetry.batteryCut
                ? "--:--"
                : telemetry.batteryEnduranceSeconds >= 3600
                  ? // Past an hour a mm:ss readout stops telling a pilot
                    // anything, and an aeroplane carrying eleven litres of
                    // petrol is going to spend most of a flight up there.
                    // Hours and minutes, the way an aeroplane reads its own
                    // endurance, and "60+" for the electric aircraft that only
                    // ever reach this on a bench.
                    `${Math.floor(telemetry.batteryEnduranceSeconds / 3600)}h${Math.floor(
                      (telemetry.batteryEnduranceSeconds % 3600) / 60,
                    )
                      .toString()
                      .padStart(2, "0")}`
                  : formatDuration(telemetry.batteryEnduranceSeconds)
          }
          tone={
            !telemetry.batteryEnabled
              ? "normal"
              : telemetry.batteryCut || telemetry.batteryEnduranceSeconds < 120
                ? "warn"
                : telemetry.batteryEnduranceSeconds < 300
                  ? "caution"
                  : "normal"
          }
        />,
      )}

      {/* --- Energy ------------------------------------------------------- */}
      {slot(
        OSD_ELEMENT.Airspeed,
        true,
        <Readout
          glyph={<SpeedGlyph />}
          align={alignOf(OSD_ELEMENT.Airspeed)}
          value={(telemetry.airspeed * MS_TO_KMH).toFixed(0)}
          unit="km/h"
          tone={telemetry.stalled ? "warn" : "normal"}
        />,
      )}
      {slot(
        OSD_ELEMENT.GroundSpeed,
        true,
        <Tag label="GND" align={alignOf(OSD_ELEMENT.GroundSpeed)}>
          <Readout
            align={alignOf(OSD_ELEMENT.GroundSpeed)}
            value={(telemetry.groundSpeed * MS_TO_KMH).toFixed(0)}
            unit="km/h"
          />
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.Wind,
        true,
        <Readout
          glyph={<WindGlyph />}
          align={alignOf(OSD_ELEMENT.Wind)}
          value={formatWind(telemetry.windDirection, telemetry.windSpeed)}
          unit="km/h"
          tone={telemetry.windSpeed > 11 ? "caution" : "normal"}
        />,
      )}
      {slot(
        OSD_ELEMENT.Throttle,
        true,
        <Readout
          glyph={<ThrottleGlyph />}
          align={alignOf(OSD_ELEMENT.Throttle)}
          value={`${Math.round(telemetry.throttle * 100)}`}
          // Said out loud, because a bare number beside a bar chart could be
          // anything: the charge and the link either side of it are both per
          // cent, and this is the third.
          unit="%"
        />,
      )}
      {slot(
        OSD_ELEMENT.LoadFactor,
        true,
        <Readout
          glyph={<LoadGlyph />}
          align={alignOf(OSD_ELEMENT.LoadFactor)}
          value={telemetry.loadFactor.toFixed(1)}
          unit="G"
          tone={Math.abs(telemetry.loadFactor) > 6 ? "warn" : "normal"}
        />,
      )}
      {slot(
        OSD_ELEMENT.Pitch,
        true,
        <Tag label="PIT" align={alignOf(OSD_ELEMENT.Pitch)}>
          <Readout
            align={alignOf(OSD_ELEMENT.Pitch)}
            value={`${telemetry.pitch.toFixed(0)}°`}
          />
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.Roll,
        true,
        <Tag label="ROL" align={alignOf(OSD_ELEMENT.Roll)}>
          <Readout
            align={alignOf(OSD_ELEMENT.Roll)}
            value={`${telemetry.roll.toFixed(0)}°`}
          />
        </Tag>,
      )}

      {/* --- Height ------------------------------------------------------- */}
      {slot(
        OSD_ELEMENT.Altitude,
        true,
        <Readout
          glyph={<AltitudeGlyph />}
          align={alignOf(OSD_ELEMENT.Altitude)}
          value={telemetry.altitude.toFixed(0)}
          unit="m"
        />,
      )}
      {slot(
        OSD_ELEMENT.AltitudeAgl,
        true,
        <Readout
          glyph={<AglGlyph />}
          align={alignOf(OSD_ELEMENT.AltitudeAgl)}
          value={agl.toFixed(0)}
          unit="m"
          tone={
            grounded ? "good" : agl < 60 ? "warn" : agl < 150 ? "caution" : "normal"
          }
        />,
      )}
      {slot(
        OSD_ELEMENT.VerticalSpeed,
        true,
        <Readout
          glyph={<VerticalSpeedGlyph climbing={verticalSpeed >= 0} />}
          align={alignOf(OSD_ELEMENT.VerticalSpeed)}
          value={`${verticalSpeed >= 0 ? "+" : ""}${verticalSpeed.toFixed(1)}`}
          unit="m/s"
          tone={
            verticalSpeed > 0.5 ? "good" : verticalSpeed < -4 ? "caution" : "normal"
          }
        />,
      )}

      {/* --- Navigation --------------------------------------------------- */}
      {slot(
        OSD_ELEMENT.Heading,
        true,
        <div className="text-[1.25em] tabular-nums leading-none text-osd-bright">
          {telemetry.heading.toFixed(0).padStart(3, "0")}
          <span className="text-[0.6em]">°</span>
        </div>,
      )}
      {slot(
        OSD_ELEMENT.HeadingTape,
        true,
        <CompassRibbon heading={telemetry.heading} />,
      )}
      {slot(
        OSD_ELEMENT.HomeArrow,
        true,
        <Tag glyph={<HomeGlyph />} align={alignOf(OSD_ELEMENT.HomeArrow)}>
          <span
            aria-hidden
            className="text-[0.875em] text-osd-green"
            style={{
              display: "inline-block",
              // The arrow is read against the nose, not against north: it
              // points where the pilot has to turn, which is the only reason
              // a home arrow is on an OSD at all.
              transform: `rotate(${telemetry.homeBearing - telemetry.heading}deg)`,
            }}
          >
            ↑
          </span>
          <span className="tabular-nums text-[0.875em] text-osd-bright">
            {formatRange(telemetry.homeDistance)}
          </span>
        </Tag>,
      )}
      {slot(
        OSD_ELEMENT.TargetRange,
        telemetry.targetDistance !== undefined,
        <Readout
          glyph={<TargetGlyph />}
          align={alignOf(OSD_ELEMENT.TargetRange)}
          value={formatRange(telemetry.targetDistance ?? 0)}
          tone="caution"
        />,
      )}
      {slot(
        OSD_ELEMENT.TargetBearing,
        telemetry.targetDistance !== undefined,
        <div>
          <Readout
            glyph={<TargetGlyph />}
            align={alignOf(OSD_ELEMENT.TargetBearing)}
            value={`${Math.round(telemetry.targetBearing ?? 0)
              .toString()
              .padStart(3, "0")}°`}
            tone="caution"
          />
          {(telemetry.targetVisibility ?? 1) < 0.25 ? (
            <div className="text-[0.6875em] tracking-[0.18em] text-osd-bright/80">
              NO VISUAL
            </div>
          ) : null}
        </div>,
      )}

      {/* --- Flight controller -------------------------------------------- */}
      {/* Deliberately quiet in acro with nothing engaged — that is the mode a
          flight starts in, and an OSD that shouts "ACRO" at a pilot who never
          turned anything on is noise. A return home is the opposite end of it:
          the one state where the aircraft is flying itself. */}
      {slot(
        OSD_ELEMENT.FlightMode,
        assisted && !telemetry.disabled,
        telemetry.returnHome ? (
          <div className="animate-warn inline-block border border-amber/70 bg-amber/10 px-[0.5em] py-[0.125em] text-[0.6875em] tracking-[0.2em] text-amber">
            RTH · {(RTH_STAGE_LABEL[telemetry.rthStage ?? "CRUISE"] ?? "").toUpperCase()}
          </div>
        ) : (
          <div className="inline-block border border-hairline-bright/50 px-[0.5em] py-[0.125em] text-[0.6875em] tracking-[0.2em] text-osd-bright">
            {FLIGHT_MODE_LABEL[telemetry.flightMode].toUpperCase()}
          </div>
        ),
      )}
      {slot(
        OSD_ELEMENT.Holds,
        (telemetry.courseHold || telemetry.altitudeHold) && !telemetry.disabled,
        <div className="flex items-baseline gap-[0.75em] text-[0.6875em] tabular-nums tracking-[0.14em]">
          {telemetry.courseHold ? (
            <span className="text-osd-green">
              CRS {Math.round(telemetry.heldCourse).toString().padStart(3, "0")}°
            </span>
          ) : null}
          {telemetry.altitudeHold ? (
            <span className="text-osd-green">
              HLD {telemetry.heldAltitude.toFixed(0)} m
            </span>
          ) : null}
        </div>,
      )}

      {/* --- Session ------------------------------------------------------ */}
      {slot(
        OSD_ELEMENT.CraftName,
        true,
        <div className="text-[0.6875em] tracking-[0.2em] text-osd-bright uppercase">
          {craftName}
        </div>,
      )}
      {slot(
        OSD_ELEMENT.FlightTimer,
        true,
        <div className="flex items-center gap-[0.25em] text-[1em] tabular-nums leading-none text-osd-bright">
          <TimerGlyph />
          {formatDuration(flightTime)}
        </div>,
      )}
      {slot(
        OSD_ELEMENT.CameraMode,
        true,
        <div className="text-[0.6875em] tracking-[0.14em] text-osd-bright/80">{cameraMode}</div>,
      )}
      {slot(
        OSD_ELEMENT.Fps,
        true,
        <div
          className={`text-[0.6875em] tabular-nums tracking-[0.14em] ${
            fps < 30 ? "text-amber" : "text-osd-bright/80"
          }`}
        >
          {fps.toFixed(0)} FPS
        </div>,
      )}
      {slot(
        OSD_ELEMENT.Coordinates,
        true,
        <div className="text-[0.6875em] tabular-nums text-osd-bright/80">
          {telemetry.latitude >= 0 ? "N" : "S"}
          {Math.abs(telemetry.latitude).toFixed(5)}{" "}
          {telemetry.longitude >= 0 ? "E" : "W"}
          {Math.abs(telemetry.longitude).toFixed(5)}
        </div>,
      )}
      {slot(
        OSD_ELEMENT.TerrainHeight,
        true,
        <div className="text-[0.6875em] tabular-nums text-osd-bright/80">
          TERRAIN {telemetry.terrainHeight.toFixed(0)} m
        </div>,
      )}

      {/* --- Crosshair ---------------------------------------------------- */}
      {/* Not in a slot with the rest: it is pinned to the middle of the
          picture, so its anchor is its own and only the switch is the
          pilot's. */}
      {osdPlacement(layout, OSD_ELEMENT.Crosshair).enabled ? <Crosshair /> : null}

      {/* --- Warnings ----------------------------------------------------- */}
      {slot(
        OSD_ELEMENT.Warnings,
        true,
        <Warnings telemetry={telemetry} view={view} />,
      )}
    </div>
  );
}

/**
 * The compass ribbon under the nose.
 *
 * A row of cells the way a character generator lays one out: every position is
 * a bar unless a cardinal point falls in it, in which case the letter replaces
 * the bar, and a green tick under each cell is what the eye actually tracks as
 * the aircraft turns. The one under the nose is drawn longer, which is the
 * only thing marking the centre — there is no pointer, because the ribbon is
 * always read against the middle of the picture.
 *
 * Marks slide in whole cells rather than continuously, which is what a flight
 * controller's heading graph does and what keeps it readable while the
 * aircraft is rolling.
 */
function CompassRibbon({ heading }: { heading: number }) {
  const marks = compassTape(heading);
  return (
    <div className="flex items-end gap-[0.375em]">
      {marks.map((mark) => (
        <span key={mark.bearing} className="flex w-[1em] flex-col items-center">
          <span className="text-[1em] leading-none text-osd-bright">
            {mark.label ?? "|"}
          </span>
          <span
            className={`mt-[0.125em] w-px bg-osd-green ${
              mark.centre ? "h-[0.625em]" : "h-[0.375em]"
            }`}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * The reticle the nose is read against.
 *
 * Four short green strokes leaning away from a hollow middle — the shape a
 * character generator makes out of two glyphs either side of the centre cell.
 * The hole in the middle is the point of it: the one part of the picture a
 * pilot is always looking at is the one part nothing is drawn over.
 */
function Crosshair() {
  const arm = "absolute h-[0.125em] w-[0.875em] bg-osd-green";
  return (
    <div
      aria-hidden
      className="absolute left-1/2 top-1/2 h-[1.5em] w-[2.5em] -translate-x-1/2 -translate-y-1/2"
      style={{
        filter:
          "drop-shadow(1px 0 0 rgba(0,0,0,.9)) drop-shadow(-1px 0 0 rgba(0,0,0,.9)) drop-shadow(0 1px 0 rgba(0,0,0,.9)) drop-shadow(0 -1px 0 rgba(0,0,0,.9))",
      }}
    >
      {/* Each arm leans toward the middle, so the four together read as an X
          with its centre cut out. */}
      <span className={arm} style={{ left: 0, top: "0.25em", transform: "rotate(32deg)" }} />
      <span className={arm} style={{ right: 0, top: "0.25em", transform: "rotate(-32deg)" }} />
      <span className={arm} style={{ left: 0, bottom: "0.25em", transform: "rotate(-32deg)" }} />
      <span className={arm} style={{ right: 0, bottom: "0.25em", transform: "rotate(32deg)" }} />
    </div>
  );
}

/** Everything the pilot has to be told about, whether they asked or not. */
function Warnings({
  telemetry,
  view,
}: {
  telemetry: FlightTelemetry;
  view: OsdView;
}) {
  const { altitudeAgl: agl, grounded } = telemetry;
  // Nothing between the pilot and the aircraft to break up: they are looking
  // at it rather than at a picture of it.
  const onTheLink = view === OSD_VIEW.Goggles && telemetry.videoLinkEnabled;

  return (
    <div className="space-y-[0.375em] text-center">
      {telemetry.disabled ? (
        <div className="animate-warn border border-danger bg-danger/20 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-danger">
          AIRFRAME DESTROYED · GOING DOWN
        </div>
      ) : telemetry.damaged ? (
        <div
          className={
            telemetry.integrity < AIRFRAME_WARN
              ? "animate-warn border border-danger/60 bg-danger/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.2em] text-danger"
              : "border border-amber/60 bg-amber/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.2em] text-amber"
          }
        >
          AIRFRAME {Math.round(telemetry.integrity * 100)}%
          {telemetry.controlAuthority < 0.99
            ? ` · CONTROL ${Math.round(telemetry.controlAuthority * 100)}%`
            : null}
        </div>
      ) : null}
      {telemetry.stalled ? (
        <div className="animate-warn border border-danger/60 bg-danger/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-danger">
          STALL
        </div>
      ) : null}
      {telemetry.held ? (
        <div className="border border-cyan/60 bg-cyan/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-cyan">
          IN THE HAND · OPEN THROTTLE TO LAUNCH
        </div>
      ) : telemetry.landed ? (
        <div className="border border-osd-green/60 bg-osd-green/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-osd-green">
          LANDED
        </div>
      ) : grounded ? (
        <div className="border border-osd-green/50 bg-osd-green/5 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-osd-green">
          ON THE GROUND
        </div>
      ) : null}
      {!grounded && agl < 60 && agl > 0 ? (
        <div className="animate-warn border border-amber/60 bg-amber/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-amber">
          TERRAIN
        </div>
      ) : null}
      {telemetry.batteryCut ? (
        <div className="animate-warn border border-danger/60 bg-danger/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-danger">
          {telemetry.fuelled
            ? "TANK DRY · ENGINE OUT · GLIDE IT DOWN"
            : "BATTERY FLAT · NO MOTOR · GLIDE IT DOWN"}
        </div>
      ) : telemetry.batteryEnabled &&
        telemetry.batteryCharge < BATTERY_CAUTION ? (
        <div
          className={
            telemetry.batteryCharge < BATTERY_WARN
              ? "animate-warn border border-danger/60 bg-danger/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.2em] text-danger"
              : "border border-amber/60 bg-amber/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.2em] text-amber"
          }
        >
          {telemetry.fuelled ? "FUEL" : "BATTERY"}{" "}
          {Math.round(telemetry.batteryCharge * 100)}% ·{" "}
          {telemetry.fuelled
            ? `${telemetry.fuelLitres.toFixed(1)} L`
            : `${telemetry.batteryCellVoltage.toFixed(2)} V/CELL`}{" "}
          ·{" "}
          {formatDuration(
            Math.min(telemetry.batteryEnduranceSeconds, 59 * 60 + 59),
          )}{" "}
          LEFT
        </div>
      ) : null}
      {onTheLink && telemetry.videoQuality <= 0 ? (
        <div className="animate-warn border border-danger/60 bg-danger/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.24em] text-danger">
          VIDEO LINK LOST ·{" "}
          {Math.max(
            0,
            Math.ceil(telemetry.videoLossTimeout - telemetry.videoLostSeconds),
          )}
          s
        </div>
      ) : onTheLink && telemetry.videoQuality < VIDEO_CAUTION ? (
        <div className="border border-amber/60 bg-amber/10 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.2em] text-amber">
          VIDEO LINK {Math.round(telemetry.videoQuality * 100)}% ·{" "}
          {(telemetry.videoDistance / 1000).toFixed(1)} of{" "}
          {(telemetry.videoRange / 1000).toFixed(1)} km
        </div>
      ) : null}
      {telemetry.outsideMissionArea ? (
        <div className="border border-amber/50 bg-amber/5 px-[0.75em] py-[0.25em] text-[0.6875em] tracking-[0.2em] text-amber">
          OUTSIDE MISSION AREA ·{" "}
          {(telemetry.distanceFromOrigin / 1000).toFixed(1)} km
        </div>
      ) : null}
    </div>
  );
}

/**
 * What is left of the festival field.
 *
 * Three things, because at a fly-in there are only three questions: how many
 * are still up, how long the slot has left, and — when the wing is in the
 * grass — whether there is anything left of your day. At a streamer event there
 * are two more: how much paper you have taken off the field, and how much of
 * your own is still on the tail.
 */
function FestivalReadout({ festival }: { festival: FestivalProgress }) {
  const down = !festival.playerFlying;
  const board = festival.streamer;
  const you = board?.player ?? null;

  return (
    <div className="space-y-[0.25em]">
      {you ? (
        <>
          <div className="flex items-baseline gap-[0.5em]">
            <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">
              CUT
            </span>
            <span className="tabular-nums text-[0.875em] text-osd-green">
              {formatStreamerLength(you.cut)}
            </span>
          </div>
          <div className="flex items-baseline gap-[0.5em]">
            <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">
              TAIL
            </span>
            <span
              className={`tabular-nums text-[0.875em] ${
                you.remaining <= STREAMER_STUB ? "text-amber" : "text-osd-bright"
              }`}
            >
              {formatStreamerLength(you.remaining)}
            </span>
          </div>
          <div className="flex items-baseline gap-[0.5em]">
            <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">
              POS
            </span>
            <span
              className={`tabular-nums text-[0.875em] ${
                you.position === 1 ? "text-osd-green" : "text-amber"
              }`}
            >
              {you.position}
              <span className="text-osd-bright/80">
                /{board?.standings.length ?? 1}
              </span>
            </span>
          </div>
        </>
      ) : null}
      <div className="flex items-baseline gap-[0.5em]">
        <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">AIR</span>
        <span
          className={`tabular-nums text-[0.875em] ${
            festival.flying > 1 ? "text-osd-bright" : "text-amber"
          }`}
        >
          {festival.flying}
          <span className="text-osd-bright/80">/{festival.total}</span>
        </span>
      </div>
      <div className="flex items-baseline gap-[0.5em]">
        <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">WAV</span>
        <span className="tabular-nums text-[0.875em] text-osd-bright">{festival.wave}</span>
      </div>
      {!festival.unlimited ? (
        <div className="flex items-baseline gap-[0.5em]">
          <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">SLT</span>
          <span
            className={`tabular-nums text-[0.875em] ${
              festival.remaining < 60 ? "text-amber" : "text-osd-bright"
            }`}
          >
            {formatDuration(festival.remaining)}
          </span>
        </div>
      ) : null}
      {festival.midairs > 0 ? (
        <div className="flex items-baseline gap-[0.5em]">
          <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">MID</span>
          <span className="tabular-nums text-[0.875em] text-osd-bright">
            {festival.midairs}
          </span>
        </div>
      ) : null}
      {down ? (
        // Nothing left to fly and nothing to wait for: the field flies on, and
        // the pilot's own afternoon ends with the wing that went in.
        <div className="text-[0.6875em] tracking-[0.2em] text-amber">
          WING IN THE FIELD · DAY OVER
        </div>
      ) : festival.recalled ? (
        <div className="text-[0.6875em] tracking-[0.2em] text-amber">
          LINE CALLED DOWN
        </div>
      ) : null}
    </div>
  );
}

/**
 * How the race is going.
 *
 * Four things, because in a race there are only four questions: which gate is
 * next, what is on the clock, where am I in the field, and how far away is the
 * aircraft in front. Everything else can wait for the debrief.
 */
function RaceReadout({ race }: { race: RaceProgress }) {
  const leader = race.standings[0];
  const chasing =
    race.position > 1 ? leader : (race.standings[1] ?? null);

  return (
    <div className="w-[11em] space-y-[0.25em]">
      <div className="flex items-baseline justify-between gap-[0.5em]">
        <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">GATE</span>
        <span className="tabular-nums text-[0.875em] text-osd-green">
          {Math.min(race.nextGate + 1, race.gateCount)}
          <span className="text-osd-bright/80">/{race.gateCount}</span>
        </span>
      </div>

      {/* How much of the course is behind you. */}
      <div className="h-[0.25em] w-full bg-osd-bright/15">
        <div
          className="h-full bg-osd-green"
          style={{
            width: `${Math.round(
              (race.gatesPassed / Math.max(race.gateCount, 1)) * 100,
            )}%`,
          }}
        />
      </div>

      <div className="flex items-baseline justify-between gap-[0.5em]">
        <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">TIME</span>
        <span
          className={`tabular-nums text-[0.875em] ${
            race.started ? "text-osd-bright" : "text-osd-bright/70"
          }`}
        >
          {race.started ? formatRaceTime(race.elapsed) : "--:--.-"}
        </span>
      </div>

      {race.racerCount > 1 ? (
        <div className="flex items-baseline justify-between gap-[0.5em]">
          <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">POS</span>
          <span
            className={`tabular-nums text-[0.875em] ${
              race.position === 1 ? "text-osd-green" : "text-amber"
            }`}
          >
            {racePlacing(race.position)}
            <span className="text-osd-bright/80"> of {race.racerCount}</span>
          </span>
        </div>
      ) : null}

      {race.racerCount > 1 && chasing && !race.finished ? (
        <div className="flex items-baseline justify-between gap-[0.5em]">
          <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">
            {race.position === 1 ? "LEAD" : "GAP"}
          </span>
          <span className="tabular-nums text-[0.6875em] text-osd-bright/80">
            {formatGap(
              race.position === 1
                ? Math.max(
                    0,
                    (race.standings[0]?.courseProgress ?? 0) -
                      (chasing.courseProgress ?? 0),
                  )
                : race.gapToLeader,
            )}
          </span>
        </div>
      ) : null}

      {!race.started ? (
        <div className="text-[0.6875em] tracking-[0.14em] text-osd-green">
          RUN IN TO THE START
        </div>
      ) : null}
      {race.finished ? (
        <div className="border border-osd-green/60 bg-osd-green/10 px-[0.5em] py-[0.125em] text-[0.6875em] tracking-[0.18em] text-osd-green">
          FINISHED
        </div>
      ) : null}
    </div>
  );
}

/** A gap on the course, in the units a pilot can actually use. */
function formatGap(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * How the slot is being held.
 *
 * Three numbers and a bar, because in formation there are only three questions:
 * how far out am I, how much of the routine have I actually flown in station,
 * and what is the leader about to do to me.
 */
function FormationReadout({
  formation,
  slot,
  flightSize,
  manoeuvre,
}: {
  formation: FormationProgress;
  slot?: string;
  flightSize?: number;
  manoeuvre?: string;
}) {
  const percent = Math.round(formation.score * 100);
  const passing = formation.score >= PASS_FRACTION;
  const remaining = Math.max(0, formation.total - formation.elapsed);

  return (
    <div className="w-[11em] space-y-[0.25em]">
      <div className="flex items-baseline justify-between gap-[0.5em]">
        <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">SLOT</span>
        <span
          className={`tabular-nums text-[0.875em] ${
            formation.inStation ? "text-osd-green" : "text-osd-bright"
          }`}
        >
          {Number.isFinite(formation.stationError)
            ? `${Math.round(formation.stationError)} m`
            : "--"}
        </span>
      </div>

      {/* How well the slot is being held right now. */}
      <div className="h-[0.25em] w-full bg-osd-bright/15">
        <div
          className={formation.inStation ? "h-full bg-osd-green" : "h-full bg-amber"}
          style={{ width: `${Math.round(formation.quality * 100)}%` }}
        />
      </div>

      <div className="flex items-baseline justify-between gap-[0.5em]">
        <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">HELD</span>
        <span
          className={`tabular-nums text-[0.875em] ${
            passing ? "text-osd-green" : "text-amber"
          }`}
        >
          {percent}%
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-[0.5em]">
        <span className="text-[0.6875em] tracking-[0.16em] text-osd-bright/85">LEFT</span>
        <span className="tabular-nums text-[0.6875em] text-osd-bright/80">
          {formatDuration(remaining)}
        </span>
      </div>

      {slot ? (
        <div className="text-[0.6875em] tracking-[0.14em] text-osd-bright/70">
          {slot.toUpperCase()}
          {flightSize !== undefined ? ` · FLIGHT OF ${flightSize + 1}` : ""}
        </div>
      ) : null}
      {manoeuvre ? (
        <div className="text-[0.6875em] tracking-[0.14em] text-osd-green">
          {manoeuvre.toUpperCase()}
        </div>
      ) : null}
      {formation.timeSeparated > 5 ? (
        <div className="animate-warn border border-amber/60 bg-amber/10 px-[0.5em] py-[0.125em] text-[0.6875em] tracking-[0.18em] text-amber">
          REJOIN
        </div>
      ) : null}
    </div>
  );
}
