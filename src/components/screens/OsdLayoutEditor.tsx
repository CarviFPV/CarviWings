"use client";

/**
 * The OSD layout editor.
 *
 * A configurator, in the sense a flight controller's is: on the left a picture
 * of the display exactly as it will be flown, on the right the list of what can
 * be on it. Elements are dragged around the picture and snap to the same grid
 * the OSD is laid out on, so what is arranged here is what appears over the
 * camera.
 *
 * The preview is the real `TelemetryPanel` over sample telemetry rather than a
 * drawing of one. That is the whole point: an element cannot drift out of the
 * editor's idea of itself, because there is only one idea of it. The panel is
 * laid out at a fixed 1920x1080 and scaled to whatever room the screen has,
 * which keeps the miniature faithful down to the type size — the display sizes
 * its own type off the height of the box it is drawn in, so the shrunk preview
 * and the full-screen flight are the same picture at two magnifications.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useSettingsStore } from "@/state/settingsStore";
import { PrimaryButton, SectionLabel } from "@/components/ui/Primitives";
import { TelemetryPanel } from "@/components/hud/TelemetryPanel";
import type { OsdAlign, OsdElementId, OsdPlacement } from "@/sim/hud/osdLayout";
import {
  OSD_ALIGN,
  OSD_ELEMENT,
  OSD_GRID_COLUMNS,
  OSD_GRID_ROWS,
  OSD_GROUPS,
  OSD_GROUP_LABEL,
  osdElementInfo,
  osdElementsInGroup,
  osdPlacement,
} from "@/sim/hud/osdLayout";
import { SAMPLE_RACE, SAMPLE_TELEMETRY } from "./osdSample";

/** The frame the preview is composed in. Scaled, never re-laid-out. */
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

const ALIGN_LABEL: Record<OsdAlign, string> = {
  left: "Left",
  centre: "Centre",
  right: "Right",
};

interface Drag {
  readonly id: OsdElementId;
  /** Where the pointer went down, in client pixels. */
  readonly fromX: number;
  readonly fromY: number;
  /** Where the element was when it went down, in grid cells. */
  readonly originColumn: number;
  readonly originRow: number;
}

export function OsdLayoutEditor({ onBack }: { onBack: () => void }) {
  const layout = useSettingsStore((state) => state.osdLayout);
  const setPlacement = useSettingsStore((state) => state.setOsdPlacement);
  const toggleElement = useSettingsStore((state) => state.toggleOsdElement);
  const resetElement = useSettingsStore((state) => state.resetOsdElement);
  const resetLayout = useSettingsStore((state) => state.resetOsdLayout);

  const [selected, setSelected] = useState<OsdElementId | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const scale = useFrameScale(frameRef);

  /**
   * How far the pointer has travelled since the grab, in grid cells.
   *
   * A difference rather than a position: the frame's own corner drops out of
   * the arithmetic, so a page that scrolls under the pointer part way through
   * a drag — which is exactly what happens when the grab focuses an element
   * near the bottom of a long settings page — cannot throw the element across
   * the picture.
   */
  const cellsMoved = useCallback(
    (fromX: number, fromY: number, toX: number, toY: number) => {
      const box = frameRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) {
        return { columns: 0, rows: 0 };
      }
      return {
        columns: ((toX - fromX) / box.width) * OSD_GRID_COLUMNS,
        rows: ((toY - fromY) / box.height) * OSD_GRID_ROWS,
      };
    },
    [],
  );

  const handleGrab = useCallback(
    (id: OsdElementId, event: ReactPointerEvent<HTMLElement>) => {
      setSelected(id);
      if (!osdElementInfo(id).movable) return;
      event.preventDefault();
      // Focused by hand rather than by the browser, which would scroll the
      // whole page to bring the element into view the instant it is grabbed.
      event.currentTarget.focus({ preventScroll: true });
      const placement = osdPlacement(layout, id);
      dragRef.current = {
        id,
        fromX: event.clientX,
        fromY: event.clientY,
        originColumn: placement.column,
        originRow: placement.row,
      };
      // Deliberately no pointer capture: the drag is tracked on the window,
      // because a snapped element lags the pointer on every drag and an
      // element that only moved while the pointer was over it could never be
      // placed at all.
    },
    [layout],
  );

  // The move and release listeners live for as long as the editor does. A drag
  // is a ref rather than state so dragging never re-subscribes them, and only
  // an actual change of cell reaches the store.
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      const moved = cellsMoved(
        drag.fromX,
        drag.fromY,
        event.clientX,
        event.clientY,
      );
      setPlacement(drag.id, {
        column: Math.round(drag.originColumn + moved.columns),
        row: Math.round(drag.originRow + moved.rows),
      });
    };
    const onUp = (): void => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [cellsMoved, setPlacement]);

  // Arrow keys nudge the selection a cell at a time. Dragging is how a layout
  // is roughed out; this is how it is finished, and it is also the only way to
  // place an element without a pointer.
  useEffect(() => {
    if (!selected) return;
    const info = osdElementInfo(selected);
    if (!info.movable) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const step = event.shiftKey ? 5 : 1;
      const placement = osdPlacement(
        useSettingsStore.getState().osdLayout,
        selected,
      );
      if (event.key === "ArrowLeft") {
        setPlacement(selected, { column: placement.column - step });
      } else if (event.key === "ArrowRight") {
        setPlacement(selected, { column: placement.column + step });
      } else if (event.key === "ArrowUp") {
        setPlacement(selected, { row: placement.row - step });
      } else if (event.key === "ArrowDown") {
        setPlacement(selected, { row: placement.row + step });
      } else {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, setPlacement]);

  const selectedInfo = selected ? osdElementInfo(selected) : null;
  const selectedPlacement = selected ? osdPlacement(layout, selected) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <p className="text-2xs uppercase tracking-[0.4em] text-accent">
            On-screen display
          </p>
          <h2 className="mt-1 text-2xl font-light tracking-[0.06em]">
            OSD LAYOUT
          </h2>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
        >
          &larr; Settings
        </button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
        {/* --- The picture --------------------------------------------- */}
        <div>
          <div
            ref={frameRef}
            className="relative w-full overflow-hidden border border-hairline bg-void"
            style={{ aspectRatio: `${FRAME_WIDTH} / ${FRAME_HEIGHT}` }}
          >
            <GridOverlay />
            <div
              style={{
                position: "relative",
                width: FRAME_WIDTH,
                height: FRAME_HEIGHT,
                // The scale is also what makes this the containing block every
                // absolutely-placed element inside resolves against, so a
                // layout cell means the same thing here as it does in flight.
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            >
              <TelemetryPanel
                telemetry={SAMPLE_TELEMETRY}
                layout={layout}
                flightTime={252}
                fps={60}
                cameraMode="FPV"
                craftName="Carvi Wing"
                enemyCount={2}
                hasTarget
                interceptors={3}
                race={SAMPLE_RACE}
                editing={{
                  selected,
                  onSelect: setSelected,
                  onGrab: handleGrab,
                }}
              />
              <PinnedStandIn
                label="HORIZON"
                shown={osdPlacement(layout, OSD_ELEMENT.Horizon).enabled}
                width={640}
                height={420}
              />
              <MinimapStandIn
                placement={osdPlacement(layout, OSD_ELEMENT.Minimap)}
                selected={selected === OSD_ELEMENT.Minimap}
                onGrab={handleGrab}
              />
            </div>
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
            Drag anything on the picture to move it; the arrow keys nudge the
            selected element a cell at a time, and hold shift for five. The
            display is drawn over sample telemetry, so every element is shown
            here even though a target readout or a race panel only appears on
            the flights that have one.
          </p>
          <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
            This is the display that comes down the video link, so it is what
            you see through the goggles. Watching the aircraft from outside it
            &mdash; the RC ground view, or the chase camera &mdash; puts the
            same readouts down the edges of the screen instead, without the
            horizon and the reticle, which read against a nose that is not in
            front of you. Anything switched off here is off there too.
          </p>
        </div>

        {/* --- What can be on it ---------------------------------------- */}
        <div className="space-y-5">
          {selectedInfo && selectedPlacement ? (
            <section className="border border-cyan/40 bg-cyan/5 p-4">
              <SectionLabel>{selectedInfo.label}</SectionLabel>
              <p className="mb-3 text-2xs text-osd-faint">
                {selectedInfo.description}
              </p>
              {selectedInfo.movable ? (
                <>
                  <p className="mb-2 text-2xs tabular-nums text-osd-dim">
                    Column {selectedPlacement.column} · row{" "}
                    {selectedPlacement.row}
                  </p>
                  <div className="mb-3 flex gap-1.5">
                    {(
                      [OSD_ALIGN.Left, OSD_ALIGN.Centre, OSD_ALIGN.Right] as const
                    ).map((align) => (
                      <button
                        key={align}
                        type="button"
                        onClick={() =>
                          setPlacement(selectedInfo.id, { align })
                        }
                        className={`flex-1 border px-2 py-1.5 text-2xs uppercase tracking-[0.14em] transition-colors ${
                          selectedPlacement.align === align
                            ? "border-cyan/70 bg-cyan/10 text-cyan"
                            : "border-hairline text-osd-dim hover:border-hairline-bright hover:text-osd"
                        }`}
                      >
                        {ALIGN_LABEL[align]}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="mb-3 text-2xs text-osd-faint">
                  Read against the middle of the picture, so it can be switched
                  off but not moved.
                </p>
              )}
              <button
                type="button"
                onClick={() => resetElement(selectedInfo.id)}
                className="text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:text-osd"
              >
                Put this one back
              </button>
            </section>
          ) : (
            <section className="border border-hairline p-4">
              <p className="text-2xs leading-relaxed text-osd-faint">
                Pick an element — on the picture or in the list — to move it,
                change which side it grows from, or put it back where it
                started.
              </p>
            </section>
          )}

          <div className="max-h-[46vh] space-y-5 overflow-y-auto pr-1">
            {OSD_GROUPS.map((group) => (
              <section key={group}>
                <SectionLabel>{OSD_GROUP_LABEL[group]}</SectionLabel>
                <div className="space-y-1">
                  {osdElementsInGroup(group).map((info) => {
                    const placement = osdPlacement(layout, info.id);
                    const isSelected = selected === info.id;
                    return (
                      <div
                        key={info.id}
                        className={`flex items-center gap-3 border px-3 py-2 transition-colors ${
                          isSelected
                            ? "border-cyan/60 bg-cyan/5"
                            : "border-hairline hover:border-hairline-bright"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelected(info.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-2xs uppercase tracking-[0.14em] text-osd-dim">
                            {info.label}
                          </span>
                          <span className="block truncate text-2xs text-osd-faint normal-case">
                            {info.description}
                            {info.conditional ? " · not on every flight" : ""}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleElement(info.id)}
                          aria-pressed={placement.enabled}
                          aria-label={`${info.label} ${
                            placement.enabled ? "on" : "off"
                          }`}
                          className={`shrink-0 text-xs uppercase tracking-[0.14em] transition-colors ${
                            placement.enabled
                              ? "text-lime hover:text-lime/80"
                              : "text-osd-faint hover:text-osd-dim"
                          }`}
                        >
                          {placement.enabled ? "On" : "Off"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <section>
            <PrimaryButton
              onClick={() => {
                resetLayout();
                setSelected(null);
              }}
            >
              Restore the default layout
            </PrimaryButton>
            <p className="mt-2 text-2xs text-osd-faint">
              Puts every element back where it is delivered and switches them
              all back on. The layout is the pilot&rsquo;s rather than the
              aircraft&rsquo;s, so it is the same display on every UAV in the
              hangar.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * How much the 1920x1080 frame has to shrink to fit the room on screen.
 *
 * Measured rather than assumed: the editor is opened both on its own screen
 * and inside the pause menu, which are nowhere near the same width.
 */
function useFrameScale(ref: React.RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => setScale(node.clientWidth / FRAME_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return scale;
}

/** The cell grid an element snaps to, drawn faintly behind the display. */
function GridOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-40"
      style={{
        backgroundImage:
          "linear-gradient(to right, var(--color-hairline) 1px, transparent 1px)," +
          "linear-gradient(to bottom, var(--color-hairline) 1px, transparent 1px)",
        backgroundSize: `${100 / OSD_GRID_COLUMNS}% ${100 / OSD_GRID_ROWS}%`,
      }}
    />
  );
}

/**
 * Where a canvas instrument sits, in a preview that has no canvas.
 *
 * The horizon is drawn by the instrument layer over the live attitude, which
 * there is none of on a settings screen. An outline in its place is enough to
 * say what the middle of the picture is spoken for by.
 */
function PinnedStandIn({
  label,
  shown,
  width,
  height,
}: {
  label: string;
  shown: boolean;
  width: number;
  height: number;
}) {
  if (!shown) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 flex items-center justify-center border border-dashed border-osd-faint/50 text-osd-faint"
      style={{
        width,
        height,
        transform: "translate(-50%, -50%)",
      }}
    >
      <span className="text-2xl tracking-[0.4em]">{label}</span>
    </div>
  );
}

/** The minimap's own footprint, which is a circle and can be dragged. */
function MinimapStandIn({
  placement,
  selected,
  onGrab,
}: {
  placement: OsdPlacement;
  selected: boolean;
  onGrab: (id: OsdElementId, event: ReactPointerEvent<HTMLElement>) => void;
}) {
  if (!placement.enabled) return null;

  // The instrument layer draws the map round its anchor at a fixed radius in
  // real pixels, so the stand-in is the same circle in frame pixels.
  const radius = 88;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="minimap"
      aria-pressed={selected}
      onPointerDown={(event) => onGrab(OSD_ELEMENT.Minimap, event)}
      className={`absolute flex cursor-grab touch-none items-center justify-center rounded-full border border-dashed active:cursor-grabbing ${
        selected ? "border-cyan bg-cyan/10" : "border-osd-faint/60"
      }`}
      style={{
        left: `${(placement.column / OSD_GRID_COLUMNS) * 100}%`,
        top: `${(placement.row / OSD_GRID_ROWS) * 100}%`,
        width: radius * 2,
        height: radius * 2,
        transform: "translate(-50%, -50%)",
      }}
    >
      <span className="text-xs tracking-[0.24em] text-osd-faint">MAP</span>
    </div>
  );
}
