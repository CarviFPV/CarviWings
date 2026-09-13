"use client";

/**
 * The controls screen: a reference that is also the editor.
 *
 * Every row is the binding itself rather than a picture of one, so a pilot who
 * came here to look up a key can change it on the spot. Capture listens for a
 * physical key — `KeyboardEvent.code` — which is what keeps a layout bound on
 * one keyboard sitting under the same fingers on another.
 */

import { useCallback, useEffect, useState } from "react";

import { SCREEN, useGameStore } from "@/state/gameStore";
import { useKeyBindingStore } from "@/state/keyBindingStore";
import { KeyCap, MenuColumns, SectionLabel } from "@/components/ui/Primitives";
import type {
  KeyAction,
  KeyActionGroup,
  KeyActionInfo,
  KeyBindings,
} from "@/sim/input/keyBindings";
import {
  DEFAULT_KEY_BINDINGS,
  KEY_ACTION_GROUP,
  actionHoldingKey,
  actionInfo,
  actionsInGroup,
  isEssentialAction,
  isReservedKey,
  keyLabel,
} from "@/sim/input/keyBindings";

/** Keys the capture prompt uses for itself rather than binding. */
const CANCEL_KEY = "Escape";
const CLEAR_KEYS: readonly string[] = ["Backspace", "Delete"];
/** A modifier pressed on its own is on its way to a combination, not a binding. */
const MODIFIER_KEYS: readonly string[] = [
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
];

function BindingRow({
  info,
  code,
  capturing,
  onCapture,
  onClear,
  onReset,
}: {
  info: KeyActionInfo;
  code: string;
  capturing: boolean;
  onCapture: () => void;
  onClear: () => void;
  onReset: () => void;
}) {
  const isDefault = code === DEFAULT_KEY_BINDINGS[info.action];
  // Pause is the way out of a flight, so it can be moved but not removed.
  const removable = !isEssentialAction(info.action);
  return (
    <div className="flex items-center gap-4 px-4 py-2.5">
      <div className="w-24 shrink-0">
        <button
          type="button"
          onClick={onCapture}
          aria-label={`Change the key for ${info.label}`}
          className={`text-left transition-opacity ${
            capturing ? "animate-pulse" : "hover:opacity-80"
          }`}
        >
          {capturing ? (
            <KeyCap>
              <span className="text-cyan">Press…</span>
            </KeyCap>
          ) : (
            <KeyCap>
              <span className={code ? "" : "text-osd-faint"}>
                {keyLabel(code)}
              </span>
            </KeyCap>
          )}
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-[0.1em] text-osd">
          {info.label}
        </p>
        <p className="text-2xs text-osd-faint">{info.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {!isDefault ? (
          <button
            type="button"
            onClick={onReset}
            className="text-2xs uppercase tracking-[0.14em] text-osd-dim transition-colors hover:text-osd"
          >
            Default
          </button>
        ) : null}
        {code && removable ? (
          <button
            type="button"
            onClick={onClear}
            className="text-2xs uppercase tracking-[0.14em] text-osd-dim transition-colors hover:text-danger"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BindingGroup({
  group,
  bindings,
  capturing,
  onCapture,
  onClear,
  onReset,
}: {
  group: KeyActionGroup;
  bindings: KeyBindings;
  capturing: KeyAction | null;
  onCapture: (action: KeyAction) => void;
  onClear: (action: KeyAction) => void;
  onReset: (action: KeyAction) => void;
}) {
  return (
    <div className="divide-y divide-hairline border border-hairline">
      {actionsInGroup(group).map((info) => (
        <BindingRow
          key={info.action}
          info={info}
          code={bindings[info.action]}
          capturing={capturing === info.action}
          onCapture={() => onCapture(info.action)}
          onClear={() => onClear(info.action)}
          onReset={() => onReset(info.action)}
        />
      ))}
    </div>
  );
}

export function ControlsScreen() {
  const goto = useGameStore((state) => state.goto);
  const bindings = useKeyBindingStore((state) => state.bindings);
  const bind = useKeyBindingStore((state) => state.bind);
  const clear = useKeyBindingStore((state) => state.clear);
  const resetAction = useKeyBindingStore((state) => state.resetAction);
  const resetAll = useKeyBindingStore((state) => state.reset);

  const [capturing, setCapturing] = useState<KeyAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const beginCapture = useCallback((action: KeyAction) => {
    setCapturing(action);
    setNotice(null);
  }, []);

  /**
   * Captures the next physical key for the action being edited.
   *
   * Held in a capture phase listener so nothing else on the page — a focused
   * button answering to Space or Enter, say — acts on the key first.
   */
  useEffect(() => {
    if (!capturing) return;
    const action = capturing;

    const onKeyDown = (event: KeyboardEvent): void => {
      const code = event.code;
      if (MODIFIER_KEYS.includes(code)) return;
      event.preventDefault();
      event.stopPropagation();

      if (code === CANCEL_KEY) {
        setCapturing(null);
        setNotice(null);
        return;
      }
      if (CLEAR_KEYS.includes(code)) {
        if (isEssentialAction(action)) {
          setNotice(`${actionInfo(action).label} always needs a key.`);
          return;
        }
        clear(action);
        setCapturing(null);
        setNotice(`${actionInfo(action).label} is now unbound.`);
        return;
      }
      if (isReservedKey(code)) {
        setNotice(`${keyLabel(code)} is reserved by the browser.`);
        return;
      }

      const previous = actionHoldingKey(bindings, code, action);
      if (previous && isEssentialAction(previous)) {
        setNotice(
          `${keyLabel(code)} belongs to ${actionInfo(previous).label}, which always needs a key. Move that one first.`,
        );
        return;
      }
      bind(action, code);
      setCapturing(null);
      setNotice(
        previous
          ? `${keyLabel(code)} moved to ${actionInfo(action).label}; ${
              actionInfo(previous).label
            } is now unbound.`
          : `${actionInfo(action).label} is now ${keyLabel(code)}.`,
      );
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, bindings, bind, clear]);

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      <div className="mx-auto w-full max-w-[88rem] px-8 py-12">
        <header className="mb-10 flex items-end justify-between border-b border-hairline pb-5">
          <div>
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Reference
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">
              CONTROLS
            </h1>
          </div>
          <button
            type="button"
            onClick={() => goto(SCREEN.Menu)}
            className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
          >
            &larr; Main menu
          </button>
        </header>

        <div className="mb-8 flex items-center justify-between gap-4 border border-hairline bg-panel px-4 py-3">
          <p className="text-2xs leading-relaxed text-osd-dim">
            {capturing
              ? (notice ??
                "Press the key to assign. Esc cancels, Backspace unbinds.")
              : (notice ??
                "Click a key to reassign it. A key only ever means one thing, so taking it from another control unbinds that one.")}
          </p>
          <button
            type="button"
            onClick={() => {
              resetAll();
              setCapturing(null);
              setNotice("Every key is back to its default.");
            }}
            className="shrink-0 border border-hairline-bright px-3 py-1.5 text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:text-osd"
          >
            Reset all
          </button>
        </div>

        <MenuColumns minWidth="25rem">
          <section>
            <SectionLabel>Flight</SectionLabel>
            <BindingGroup
              group={KEY_ACTION_GROUP.Flight}
              bindings={bindings}
              capturing={capturing}
              onCapture={beginCapture}
              onClear={clear}
              onReset={resetAction}
            />
          </section>

          <section>
            <SectionLabel>Modes</SectionLabel>
            <BindingGroup
              group={KEY_ACTION_GROUP.Modes}
              bindings={bindings}
              capturing={capturing}
              onCapture={beginCapture}
              onClear={clear}
              onReset={resetAction}
            />
            <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
              The switches a wing carries. Course hold and altitude hold layer
              onto whichever mode is selected and can be flown together, which
              is cruise. How far each mode is allowed to go, and everything a
              return home is flown by, is set under Settings.
            </p>
          </section>

          <section>
            <SectionLabel>View</SectionLabel>
            <BindingGroup
              group={KEY_ACTION_GROUP.View}
              bindings={bindings}
              capturing={capturing}
              onCapture={beginCapture}
              onClear={clear}
              onReset={resetAction}
            />
          </section>

          <section>
            <SectionLabel>Development</SectionLabel>
            <BindingGroup
              group={KEY_ACTION_GROUP.Development}
              bindings={bindings}
              capturing={capturing}
              onCapture={beginCapture}
              onClear={clear}
              onReset={resetAction}
            />
          </section>

          <section>
            <SectionLabel>Controller</SectionLabel>
            <div className="border border-hairline bg-panel px-4 py-3">
              <p className="text-xs leading-relaxed text-osd-dim">
                A game pad, USB joystick or RC transmitter in game-pad mode can
                fly the aircraft instead. There is no mode to switch: whichever
                you touched last has control, so you can pick the sticks up
                mid-flight and put them down again.
              </p>
              <button
                type="button"
                onClick={() => goto(SCREEN.Controller)}
                className="mt-3 border border-cyan/60 px-4 py-1.5 text-2xs uppercase tracking-[0.16em] text-cyan transition-colors hover:bg-cyan/10"
              >
                Configure and calibrate
              </button>
            </div>
          </section>

          <div className="border border-hairline bg-panel px-4 py-3">
            <p className="text-2xs uppercase tracking-[0.16em] text-osd-dim">
              Flying the wing
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-osd-dim">
              It is an aircraft, not a spaceship. Bank with the roll keys and
              pull to turn; the wing needs airspeed to hold altitude, and
              pulling too hard at low speed will stall it. Hands off, the pitch
              trim settles the aircraft near 90 km/h.
            </p>
          </div>
        </MenuColumns>
      </div>
    </div>
  );
}
