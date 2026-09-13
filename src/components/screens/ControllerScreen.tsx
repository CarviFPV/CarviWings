"use client";

/**
 * Controller configuration and calibration.
 *
 * The live readouts run from a single animation frame that writes straight
 * into the DOM. A game pad reports sixty times a second and React must not be
 * asked to render at that rate; state here changes only when something
 * structural does — a device arriving, a calibration step advancing, a binding
 * being edited.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SCREEN, useGameStore } from "@/state/gameStore";
import { useSettingsStore } from "@/state/settingsStore";
import { profileForDevice, useControllerStore } from "@/state/controllerStore";
import { SectionLabel, Slider } from "@/components/ui/Primitives";
import type { GamepadDevice } from "@/sim/input/gamepad";
import { GamepadReader, deviceDisplayName } from "@/sim/input/gamepad";
import type {
  ControlAxis,
  ControllerAction,
  ControllerProfile,
} from "@/sim/input/controllerProfile";
import {
  CONTROLLER_ACTIONS,
  CONTROL_AXES,
  UNBOUND,
  applyProfile,
  channelLabel,
  channelValue,
  defaultProfile,
  isBipolar,
  withActionChange,
  withAxisChange,
} from "@/sim/input/controllerProfile";
import type { CalibrationView } from "@/sim/input/controllerCalibration";
import {
  ControllerCalibration,
  detectPressedChannel,
  flattenChannels,
} from "@/sim/input/controllerCalibration";
import { createFlightInput } from "@/sim/input/types";

const AXIS_LABEL: Record<ControlAxis, string> = {
  pitch: "Pitch",
  roll: "Roll",
  yaw: "Yaw",
  throttle: "Throttle",
};

const ACTION_LABEL: Record<ControllerAction, string> = {
  camera: "Toggle camera",
  cycleTarget: "Cycle target",
  minimap: "Toggle minimap",
  pause: "Pause",
  flightMode: "Flight mode",
  courseHold: "Course hold",
  altitudeHold: "Altitude hold",
  returnHome: "Return home",
};

const LAYOUT_NOTE: Record<string, string> = {
  STANDARD:
    "The browser reports the standard game pad layout, so the sticks are where this expects them.",
  AETR:
    "No layout was reported, so the usual radio channel order is assumed. Calibrate to be certain.",
  CALIBRATED: "Measured from this controller.",
  CUSTOM: "Edited by hand.",
};

function signed(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

export function ControllerScreen() {
  const goto = useGameStore((state) => state.goto);
  const profiles = useControllerStore((state) => state.profiles);
  const saveProfile = useControllerStore((state) => state.saveProfile);
  const forgetProfile = useControllerStore((state) => state.forgetProfile);
  const controllerSensitivity = useSettingsStore(
    (state) => state.controllerSensitivity,
  );
  const setSetting = useSettingsStore((state) => state.set);

  const [device, setDevice] = useState<GamepadDevice | null>(null);
  const [profile, setProfile] = useState<ControllerProfile | null>(null);
  const [calibrationView, setCalibrationView] = useState<CalibrationView | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<ControllerAction | null>(
    null,
  );

  const readerRef = useRef<GamepadReader | null>(null);
  const calibrationRef = useRef<ControllerCalibration | null>(null);
  const profileRef = useRef<ControllerProfile | null>(null);
  const pendingRef = useRef<ControllerAction | null>(null);
  const sensitivityRef = useRef(controllerSensitivity);
  const restRef = useRef<number[]>([]);
  const liveRef = useRef<Record<string, HTMLElement | null>>({});

  profileRef.current = profile;
  pendingRef.current = pendingAction;
  sensitivityRef.current = controllerSensitivity;

  const setLive = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      liveRef.current[key] = element;
    },
    [],
  );

  // --- Live loop -----------------------------------------------------------

  useEffect(() => {
    const reader = new GamepadReader();
    reader.attach();
    readerRef.current = reader;

    let frame = 0;
    let last = performance.now();
    let seenGeneration = -1;
    const input = createFlightInput();

    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      reader.poll();

      if (reader.generation !== seenGeneration) {
        seenGeneration = reader.generation;
        const info = reader.deviceInfo;
        setDevice(info);
        if (info) {
          const next = profileForDevice(
            info,
            useControllerStore.getState().profiles,
          );
          profileRef.current = next;
          setProfile(next);
          restRef.current = flattenChannels(reader.values);
        } else {
          profileRef.current = null;
          setProfile(null);
          calibrationRef.current = null;
          setCalibrationView(null);
        }
      }

      const snapshot = reader.values;

      // Binding a button: the first channel that moves clearly wins.
      const waiting = pendingRef.current;
      if (waiting && reader.connected) {
        const channel = detectPressedChannel(snapshot, restRef.current);
        if (channel !== UNBOUND) {
          const current = profileRef.current;
          if (current) {
            const next = withActionChange(current, waiting, channel);
            profileRef.current = next;
            setProfile(next);
            saveProfile(next);
          }
          pendingRef.current = null;
          setPendingAction(null);
        }
      }

      const calibration = calibrationRef.current;
      if (calibration && reader.connected) {
        calibration.update(snapshot, dt);
        const view = calibration.view;
        setCalibrationView((previous) =>
          previous &&
          previous.step === view.step &&
          previous.hint === view.hint &&
          previous.candidate === view.candidate
            ? previous
            : view,
        );
        const bar = liveRef.current["calibration.bar"];
        if (bar) bar.style.width = `${(view.progress * 100).toFixed(1)}%`;
        if (view.complete) {
          const learnt = calibration.profile(profileRef.current ?? undefined);
          profileRef.current = learnt;
          setProfile(learnt);
          saveProfile(learnt);
          calibrationRef.current = null;
        }
      }

      // Live values, written straight to the DOM.
      const current = profileRef.current;
      if (current) {
        applyProfile(input, snapshot, current, sensitivityRef.current);
      } else {
        input.pitch = 0;
        input.roll = 0;
        input.yaw = 0;
        input.throttle = 0;
      }
      for (const axis of CONTROL_AXES) {
        const value = input[axis];
        const readout = liveRef.current[`${axis}.value`];
        if (readout) {
          readout.textContent = isBipolar(axis)
            ? signed(value)
            : value.toFixed(2);
        }
        const bar = liveRef.current[`${axis}.bar`];
        if (bar) {
          if (isBipolar(axis)) {
            const half = (Math.abs(value) / 2) * 100;
            bar.style.left = value >= 0 ? "50%" : `${50 - half}%`;
            bar.style.width = `${half}%`;
          } else {
            bar.style.left = "0%";
            bar.style.width = `${value * 100}%`;
          }
        }
        const raw = liveRef.current[`${axis}.raw`];
        if (raw && current) {
          const channel = current.axes[axis].channel;
          raw.textContent =
            channel === UNBOUND
              ? "—"
              : channelValue(snapshot, channel).toFixed(2);
        }
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      reader.detach();
      readerRef.current = null;
    };
  }, [saveProfile]);

  // --- Editing -------------------------------------------------------------

  const update = useCallback(
    (next: ControllerProfile) => {
      profileRef.current = next;
      setProfile(next);
      saveProfile(next);
    },
    [saveProfile],
  );

  const startCalibration = useCallback(() => {
    if (!device) return;
    const calibration = new ControllerCalibration(
      device.id,
      device.axisCount,
      device.buttonCount,
    );
    calibrationRef.current = calibration;
    setCalibrationView(calibration.view);
  }, [device]);

  const cancelCalibration = useCallback(() => {
    calibrationRef.current = null;
    setCalibrationView(null);
  }, []);

  const skipStep = useCallback(() => {
    const calibration = calibrationRef.current;
    if (!calibration) return;
    calibration.skip();
    if (calibration.complete) {
      const learnt = calibration.profile(profileRef.current ?? undefined);
      update(learnt);
      calibrationRef.current = null;
      setCalibrationView(null);
      return;
    }
    setCalibrationView(calibration.view);
  }, [update]);

  const resetProfile = useCallback(() => {
    if (!device) return;
    forgetProfile(device.id);
    const fresh = defaultProfile(
      device.id,
      device.mapping,
      device.axisCount,
      device.buttonCount,
    );
    profileRef.current = fresh;
    setProfile(fresh);
  }, [device, forgetProfile]);

  const channelOptions =
    device === null
      ? []
      : Array.from({ length: device.axisCount + device.buttonCount }, (_, i) => ({
          value: i,
          label: channelLabel(i, device.axisCount),
        }));

  const calibrating = calibrationView !== null;

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      {/* Half the screen is the per-axis and per-button editing, which only
          exists once a device is bound: without one there is no second column
          to make room for. */}
      <div
        className={`mx-auto w-full px-8 py-12 ${
          profile && device ? "max-w-[80rem]" : "max-w-3xl"
        }`}
      >
        <header className="mb-8 flex items-end justify-between border-b border-hairline pb-5">
          <div>
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Input
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">
              CONTROLLER
            </h1>
          </div>
          <button
            type="button"
            onClick={() => goto(SCREEN.Controls)}
            className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
          >
            &larr; Controls
          </button>
        </header>

        {/* Two columns wherever the window has the width for them: the
            device, what it is sending and the calibration on one side, the
            per-axis and per-button editing on the other. Neither half is
            long enough on its own to be scrolled through. */}
        <div
          className={`mb-8 grid gap-x-10 ${
            profile && device ? "xl:grid-cols-2 xl:items-start" : ""
          }`}
        >
          <div className="space-y-8">
            {/* --- Device --------------------------------------------- */}
            <section>
              <SectionLabel>Device</SectionLabel>
              {device ? (
                <div className="border border-hairline bg-panel px-4 py-3">
                  <p className="text-sm tracking-[0.06em] text-osd">
                    {deviceDisplayName(device.id)}
                  </p>
                  <p className="mt-1 text-2xs text-osd-faint">
                    {device.axisCount} axes · {device.buttonCount} buttons ·{" "}
                    {profile ? profile.layout.toLowerCase() : "unmapped"} layout
                  </p>
                  {profile ? (
                    <p className="mt-2 text-2xs leading-relaxed text-osd-dim">
                      {LAYOUT_NOTE[profile.layout] ?? ""}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="border border-hairline bg-panel px-4 py-3">
                  <p className="text-sm tracking-[0.06em] text-osd-dim">
                    No controller detected
                  </p>
                  <p className="mt-1.5 text-2xs leading-relaxed text-osd-faint">
                    Browsers keep a controller hidden until the page has seen it
                    used. Plug it in and press a button or move a stick — it will
                    appear here. USB joysticks and RC transmitters in game-pad mode
                    both work; nothing needs to be installed.
                  </p>
                </div>
              )}
            </section>

            {/* --- Live values ---------------------------------------- */}
            <section>
              <SectionLabel>Live input</SectionLabel>
              <div className="divide-y divide-hairline border border-hairline">
                {CONTROL_AXES.map((axis) => (
                  <div key={axis} className="flex items-center gap-4 px-4 py-2.5">
                    <span className="w-20 shrink-0 text-2xs uppercase tracking-[0.14em] text-osd-dim">
                      {AXIS_LABEL[axis]}
                    </span>
                    <span
                      ref={setLive(`${axis}.value`)}
                      className="w-16 shrink-0 text-sm tabular-nums text-osd"
                    >
                      {isBipolar(axis) ? "+0.00" : "0.00"}
                    </span>
                    <span className="relative h-1.5 min-w-0 flex-1 bg-hairline">
                      {isBipolar(axis) ? (
                        <span className="absolute left-1/2 top-[-3px] h-3 w-px bg-hairline-bright" />
                      ) : null}
                      <span
                        ref={setLive(`${axis}.bar`)}
                        className="absolute top-0 h-full bg-cyan"
                        style={{ left: "50%", width: "0%" }}
                      />
                    </span>
                    <span
                      ref={setLive(`${axis}.raw`)}
                      className="w-12 shrink-0 text-right text-2xs tabular-nums text-osd-faint"
                    >
                      —
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-2xs text-osd-faint">
                The left column is what the aircraft receives. The right is the raw
                reading from the bound channel.
              </p>
            </section>

            {/* --- Calibration ---------------------------------------- */}
            <section>
              <SectionLabel>Calibration</SectionLabel>
              {calibrating && calibrationView ? (
                <div className="border border-cyan/50 bg-cyan/5 px-4 py-4">
                  <p className="text-sm tracking-[0.04em] text-cyan">
                    {calibrationView.prompt}
                  </p>
                  <p className="mt-1.5 text-2xs leading-relaxed text-osd-dim">
                    {calibrationView.hint}
                  </p>
                  <span className="mt-3 block h-1 w-full bg-hairline">
                    <span
                      ref={setLive("calibration.bar")}
                      className="block h-full bg-cyan"
                      style={{ width: "0%" }}
                    />
                  </span>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={skipStep}
                      className="border border-hairline px-3 py-1.5 text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:border-hairline-bright hover:text-osd"
                    >
                      Skip this step
                    </button>
                    <button
                      type="button"
                      onClick={cancelCalibration}
                      className="border border-hairline px-3 py-1.5 text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:border-danger hover:text-danger"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="border border-hairline bg-panel px-4 py-3">
                  <p className="text-2xs leading-relaxed text-osd-dim">
                    Calibration asks for one control at a time and watches which
                    channel moves, so no particular stick order is assumed. It also
                    records how far each control actually travels, which is what
                    lets a transmitter with off-centre trims read as centred.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={startCalibration}
                      disabled={!device}
                      className="border border-cyan/60 px-4 py-1.5 text-2xs uppercase tracking-[0.16em] text-cyan transition-colors hover:bg-cyan/10 disabled:border-hairline disabled:text-osd-faint disabled:hover:bg-transparent"
                    >
                      Start calibration
                    </button>
                    <button
                      type="button"
                      onClick={resetProfile}
                      disabled={!device}
                      className="border border-hairline px-4 py-1.5 text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:border-hairline-bright hover:text-osd disabled:text-osd-faint"
                    >
                      Reset mapping
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* --- Sensitivity ---------------------------------------- */}
            <section>
              <SectionLabel>Controller sensitivity</SectionLabel>
              <div className="border border-hairline bg-panel px-4 py-3">
                <Slider
                  label="All axes"
                  value={controllerSensitivity}
                  min={0.2}
                  max={1.5}
                  step={0.05}
                  onChange={(value) => setSetting("controllerSensitivity", value)}
                  format={(value) => `${Math.round(value * 100)}%`}
                />
                <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
                  Scales every axis on top of its own setting, so the whole device
                  can be calmed down without disturbing a calibration.
                </p>
              </div>
            </section>
          </div>

          <div className="space-y-8">
            {/* --- Axes ----------------------------------------------- */}
            {profile && device ? (
              <section>
                <SectionLabel>Axes</SectionLabel>
                <div className="space-y-3">
                  {CONTROL_AXES.map((axis) => {
                    const binding = profile.axes[axis];
                    const bipolar = isBipolar(axis);
                    return (
                      <div
                        key={axis}
                        className="border border-hairline bg-panel px-4 py-3"
                      >
                        <div className="mb-2.5 flex items-center justify-between gap-3">
                          <span className="text-xs uppercase tracking-[0.14em] text-osd">
                            {AXIS_LABEL[axis]}
                          </span>
                          <div className="flex items-center gap-2">
                            <select
                              value={binding.channel}
                              onChange={(event) =>
                                update(
                                  withAxisChange(profile, axis, {
                                    channel: Number(event.target.value),
                                  }),
                                )
                              }
                              className="border border-hairline bg-void px-2 py-1 text-2xs uppercase tracking-[0.1em] text-osd outline-none focus:border-cyan"
                            >
                              <option value={UNBOUND}>Unbound</option>
                              {channelOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() =>
                                update(
                                  withAxisChange(profile, axis, {
                                    inverted: !binding.inverted,
                                  }),
                                )
                              }
                              className={`border px-2.5 py-1 text-2xs uppercase tracking-[0.12em] transition-colors ${
                                binding.inverted
                                  ? "border-amber/60 bg-amber/10 text-amber"
                                  : "border-hairline text-osd-dim hover:border-hairline-bright hover:text-osd"
                              }`}
                            >
                              Invert
                            </button>
                          </div>
                        </div>
                        <div
                          className={`grid gap-3 ${bipolar ? "sm:grid-cols-3" : ""}`}
                        >
                          <Slider
                            label="Deadzone"
                            value={binding.deadzone}
                            min={0}
                            max={bipolar ? 0.4 : 0.25}
                            step={0.01}
                            onChange={(value) =>
                              update(withAxisChange(profile, axis, { deadzone: value }))
                            }
                            format={(value) => `${Math.round(value * 100)}%`}
                          />
                          {bipolar ? (
                            <>
                              <Slider
                                label="Sensitivity"
                                value={binding.sensitivity}
                                min={0.2}
                                max={1.5}
                                step={0.05}
                                onChange={(value) =>
                                  update(
                                    withAxisChange(profile, axis, {
                                      sensitivity: value,
                                    }),
                                  )
                                }
                                format={(value) => `${Math.round(value * 100)}%`}
                              />
                              <Slider
                                label="Expo"
                                value={binding.expo}
                                min={0}
                                max={0.9}
                                step={0.05}
                                onChange={(value) =>
                                  update(withAxisChange(profile, axis, { expo: value }))
                                }
                                format={(value) => `${Math.round(value * 100)}%`}
                              />
                            </>
                          ) : null}
                        </div>
                        {!bipolar ? (
                          <p className="mt-2 text-2xs text-osd-faint">
                            The throttle has no sensitivity or expo: a throttle at
                            half sensitivity is not a gentler aircraft, only one
                            that cannot reach full power. Its dead band sits at both
                            ends instead, so a stick that stops short of its
                            mechanical stop still commands idle and full power.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* --- Buttons -------------------------------------------- */}
            {profile && device ? (
              <section>
                <SectionLabel>Buttons</SectionLabel>
                <div className="divide-y divide-hairline border border-hairline">
                  {CONTROLLER_ACTIONS.map((action) => {
                    const channel = profile.actions[action];
                    const waiting = pendingAction === action;
                    return (
                      <div
                        key={action}
                        className="flex items-center gap-4 px-4 py-2.5"
                      >
                        <span className="min-w-0 flex-1 text-2xs uppercase tracking-[0.12em] text-osd-dim">
                          {ACTION_LABEL[action]}
                        </span>
                        <span className="w-20 shrink-0 text-right text-2xs tabular-nums text-osd">
                          {channelLabel(channel, device.axisCount)}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const reader = readerRef.current;
                            if (reader) restRef.current = flattenChannels(reader.values);
                            setPendingAction(waiting ? null : action);
                          }}
                          className={`w-24 shrink-0 border px-2 py-1 text-2xs uppercase tracking-[0.12em] transition-colors ${
                            waiting
                              ? "border-cyan/70 bg-cyan/10 text-cyan"
                              : "border-hairline text-osd-dim hover:border-hairline-bright hover:text-osd"
                          }`}
                        >
                          {waiting ? "Press…" : "Bind"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            update(withActionChange(profile, action, UNBOUND))
                          }
                          className="shrink-0 text-2xs uppercase tracking-[0.12em] text-osd-faint transition-colors hover:text-danger"
                        >
                          Clear
                        </button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-2xs text-osd-faint">
                  A bound button does exactly what its key does — the aircraft never
                  learns which one it came from.
                </p>
              </section>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => goto(SCREEN.Controls)}
            className="border border-hairline-bright px-8 py-2.5 text-xs uppercase tracking-[0.18em] text-osd transition-colors hover:border-cyan hover:text-cyan"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
