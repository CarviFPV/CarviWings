import { assert, assertBetween, assertClose, fakeWindow, suite } from "./harness";
import type {
  ControllerProfile,
  ControllerSnapshot,
} from "../input/controllerProfile";
import {
  CONTROLLER_LAYOUT,
  UNBOUND,
  applyExpo,
  applyProfile,
  channelLabel,
  channelValue,
  controlBinding,
  defaultProfile,
  mapBipolar,
  mapUnipolar,
  reconcileProfile,
  throttleBinding,
  withAxisChange,
} from "../input/controllerProfile";
import {
  CALIBRATION_STEP,
  CENTRE_SECONDS,
  HOLD_SECONDS,
  ControllerCalibration,
  TRAVEL_SECONDS,
  detectPressedChannel,
} from "../input/controllerCalibration";
import type { ControllerReader } from "../input/flightControls";
import { KEY_ACTION } from "../input/keyBindings";
import { FlightControls, INPUT_DEVICE } from "../input/flightControls";
import { createFlightInput } from "../input/types";
import type { GamepadDevice } from "../input/gamepad";
import { deviceDisplayName } from "../input/gamepad";

function pad(axes: number[], buttons: number[] = []): ControllerSnapshot {
  return { axes, buttons };
}

/** A reader that hands out whatever axis positions a test writes into it. */
class ScriptedReader implements ControllerReader {
  connected = true;
  values: ControllerSnapshot = { axes: [0, 0, 0, 0], buttons: [0, 0, 0, 0] };
  deviceInfo: GamepadDevice | null = {
    index: 0,
    id: "Scripted Pad",
    mapping: "standard",
    axisCount: 4,
    buttonCount: 4,
  };
  attach(): void {}
  detach(): void {}
  poll(): void {}
  set(axes: number[], buttons: number[] = [0, 0, 0, 0]): void {
    this.values = { axes, buttons };
  }
}

/**
 * Runs a pilot through the calibration wizard.
 *
 * `positions` gives the raw channel readings held during each binding step, in
 * the order the wizard asks for them.
 */
function calibrateWith(
  calibration: ControllerCalibration,
  rest: number[],
  extremes: number[][],
  positions: number[][],
): void {
  const step = 1 / 60;
  const feed = (axes: number[], seconds: number): void => {
    for (let t = 0; t < seconds; t += step) {
      calibration.update(pad(axes), step);
    }
  };
  feed(rest, CENTRE_SECONDS + 0.1);
  for (const extreme of extremes) feed(extreme, 0.4);
  feed(rest, TRAVEL_SECONDS);
  for (const position of positions) {
    feed(rest, 0.2);
    feed(position, HOLD_SECONDS + 0.3);
  }
}

export function runControllerTests(): void {
  suite("axis mapping", () => {
    const binding = controlBinding(0, false);
    assertClose(mapBipolar(0, binding), 0, 1e-9, "a centred stick commands nothing");
    assertClose(mapBipolar(1, binding), 1, 1e-9, "full travel commands full deflection");
    assertClose(mapBipolar(-1, binding), -1, 1e-9, "and the same the other way");

    const linear = { ...binding, expo: 0, deadzone: 0 };
    assertClose(mapBipolar(0.5, linear), 0.5, 1e-9, "and half travel, half deflection");

    const inverted = { ...linear, inverted: true };
    assertClose(mapBipolar(0.5, inverted), -0.5, 1e-9, "inversion flips the sign");
    assertClose(mapBipolar(0, inverted), 0, 1e-9, "and leaves centre alone");

    const half = { ...linear, sensitivity: 0.5 };
    assertClose(mapBipolar(1, half), 0.5, 1e-9, "sensitivity scales the command");

    const unbound = { ...linear, channel: UNBOUND };
    assertClose(mapBipolar(1, unbound), 0, 1e-9, "an unbound axis commands nothing");
  });

  suite("deadzone", () => {
    const binding = { ...controlBinding(0, false), expo: 0, deadzone: 0.1 };
    assertClose(mapBipolar(0.05, binding), 0, 1e-9, "noise inside the dead band is ignored");
    assertClose(mapBipolar(-0.1, binding), 0, 1e-9, "right up to its edge");
    assert(mapBipolar(0.2, binding) > 0, "and movement past it commands something");
    assertClose(
      mapBipolar(1, binding),
      1,
      1e-9,
      "full travel still reaches full deflection",
    );
    assertClose(
      mapBipolar(0.55, binding),
      0.5,
      1e-9,
      "with what remains rescaled across the whole range",
    );

    const wide = { ...binding, deadzone: 5 };
    assert(
      Math.abs(mapBipolar(1, wide)) <= 1 && Number.isFinite(mapBipolar(1, wide)),
      "an absurd dead band is clamped rather than dividing by nothing",
    );
  });

  suite("expo", () => {
    assertClose(applyExpo(1, 0.6), 1, 1e-9, "expo leaves full deflection alone");
    assertClose(applyExpo(-1, 0.6), -1, 1e-9, "at both ends");
    assertClose(applyExpo(0, 0.6), 0, 1e-9, "and centre");
    assert(
      applyExpo(0.4, 0.6) < applyExpo(0.4, 0),
      "and softens the middle of the travel",
    );
    let monotonic = true;
    let previous = -1.0001;
    for (let x = -1; x <= 1.0001; x += 0.01) {
      const value = applyExpo(x, 0.9);
      if (value <= previous) monotonic = false;
      previous = value;
    }
    assert(monotonic, "a bigger stick movement is always a bigger command");
  });

  suite("asymmetric and reversed calibrations", () => {
    // A gimbal that rests off centre and travels further one way than the
    // other: exactly what a cheap joystick or a trimmed radio produces.
    const skewed = {
      ...controlBinding(0, false),
      expo: 0,
      deadzone: 0,
      low: -0.6,
      centre: 0.15,
      high: 1,
    };
    assertClose(mapBipolar(0.15, skewed), 0, 1e-9, "rest reads as centred");
    assertClose(mapBipolar(1, skewed), 1, 1e-9, "the long side reaches full");
    assertClose(mapBipolar(-0.6, skewed), -1, 1e-9, "and so does the short one");

    const flat = { ...skewed, low: 0.2, centre: 0.2, high: 0.2 };
    assert(
      Number.isFinite(mapBipolar(0.9, flat)),
      "a channel that never moved during calibration cannot divide by zero",
    );
  });

  suite("throttle mapping", () => {
    const binding = { ...throttleBinding(2, false), deadzone: 0 };
    assertClose(mapUnipolar(-1, binding), 0, 1e-9, "the bottom of the travel is idle");
    assertClose(mapUnipolar(1, binding), 1, 1e-9, "and the top is full power");
    assertClose(mapUnipolar(0, binding), 0.5, 1e-9, "with the middle halfway");

    const inverted = { ...binding, inverted: true };
    assertClose(mapUnipolar(-1, inverted), 1, 1e-9, "inversion swaps the ends");
    assertClose(mapUnipolar(1, inverted), 0, 1e-9, "both of them");

    const banded = { ...binding, deadzone: 0.05 };
    assertClose(
      mapUnipolar(-0.95, banded),
      0,
      1e-9,
      "a stick stopping short of its stop still commands idle",
    );
    assertClose(
      mapUnipolar(0.95, banded),
      1,
      1e-9,
      "and still commands full power",
    );

    const trigger = { ...throttleBinding(6, false), low: 0, high: 1, deadzone: 0 };
    assertClose(
      mapUnipolar(0.4, trigger),
      0.4,
      1e-9,
      "an analogue trigger works as a throttle without special handling",
    );
  });

  suite("channels", () => {
    const snapshot = pad([0.1, 0.2], [0, 1]);
    assertClose(channelValue(snapshot, 1), 0.2, 1e-9, "axes come first");
    assertClose(channelValue(snapshot, 3), 1, 1e-9, "and buttons follow them");
    assertClose(channelValue(snapshot, 99), 0, 1e-9, "a channel off the end reads zero");
    assert(channelLabel(1, 2) === "AXIS 1", "axes are labelled by index");
    assert(channelLabel(3, 2) === "BTN 1", "and buttons by their own");
  });

  suite("default layouts", () => {
    const standard = defaultProfile("Pad (STANDARD GAMEPAD)", "standard", 4, 16);
    assert(
      standard.layout === CONTROLLER_LAYOUT.Standard,
      "a browser-vouched pad uses the standard layout",
    );
    const input = createFlightInput();

    // Right stick forward is -1 on the Y axis, and forward is nose down.
    applyProfile(input, pad([0, 0, 0, -1], []), standard);
    assert(input.pitch < -0.5, "pushing the right stick forward commands nose down");
    applyProfile(input, pad([0, 0, 0, 1], []), standard);
    assert(input.pitch > 0.5, "and pulling it back commands nose up");
    applyProfile(input, pad([0, 0, 1, 0], []), standard);
    assert(input.roll > 0.5, "right on the right stick rolls right");
    applyProfile(input, pad([1, 0, 0, 0], []), standard);
    assert(input.yaw > 0.5, "right on the left stick yaws right");
    applyProfile(input, pad([0, -1, 0, 0], []), standard);
    assertClose(input.throttle, 1, 1e-6, "left stick forward is full power");
    applyProfile(input, pad([0, 1, 0, 0], []), standard);
    assertClose(input.throttle, 0, 1e-6, "and back is idle");

    const radio = defaultProfile("RadioMaster TX16S Joystick", "", 8, 0);
    assert(
      radio.layout === CONTROLLER_LAYOUT.Aetr,
      "an unrecognised device falls back to the usual radio channel order",
    );
    assert(
      radio.axes.roll.channel === 0 &&
        radio.axes.pitch.channel === 1 &&
        radio.axes.throttle.channel === 2 &&
        radio.axes.yaw.channel === 3,
      "which is aileron, elevator, throttle, rudder",
    );
    assert(
      radio.actions.camera === UNBOUND,
      "with nothing bound to buttons it has not been told it has",
    );

    const tiny = defaultProfile("One Axis", "", 1, 0);
    assert(
      tiny.axes.yaw.channel === UNBOUND,
      "a device without enough axes leaves the rest unbound",
    );
  });

  suite("profiles survive their hardware", () => {
    const original = defaultProfile("Pad", "standard", 4, 16);
    const same = reconcileProfile(original, 4, 16);
    assert(
      same.axes.pitch.channel === original.axes.pitch.channel &&
        same.actions.camera === original.actions.camera,
      "a profile that still fits its device is untouched",
    );

    const shrunk = reconcileProfile(original, 2, 0);
    assert(
      shrunk.axes.pitch.channel === UNBOUND,
      "a channel the device no longer has is unbound rather than left dangling",
    );
    assert(
      shrunk.actions.camera === UNBOUND,
      "and so is a button that has gone",
    );

    const corrupt = {
      ...original,
      axes: {
        ...original.axes,
        roll: {
          ...original.axes.roll,
          deadzone: Number.NaN,
          sensitivity: 99,
          low: Number.NaN,
        },
      },
    } as ControllerProfile;
    const repaired = reconcileProfile(corrupt, 4, 16);
    assert(
      Number.isFinite(repaired.axes.roll.deadzone) &&
        Number.isFinite(repaired.axes.roll.low),
      "unreadable stored numbers fall back to defaults",
    );
    assertBetween(
      repaired.axes.roll.sensitivity,
      0.2,
      1.5,
      "and out-of-range ones are clamped",
    );

    const edited = withAxisChange(original, "yaw", { inverted: true });
    assert(
      edited.axes.yaw.inverted && !original.axes.yaw.inverted,
      "editing an axis returns a new profile and leaves the old one alone",
    );
    assert(
      edited.layout === CONTROLLER_LAYOUT.Custom,
      "and the layout is no longer the browser's claim",
    );
  });

  suite("calibration learns a layout", () => {
    // A radio nothing could have guessed: pitch on channel 5 and reversed,
    // roll on 2, yaw on 0, throttle on 7 resting at its bottom stop.
    const rest = [0, 0, 0, 0, 0, 0, 0, -1];
    const calibration = new ControllerCalibration("Odd Radio", 8, 0);
    calibrateWith(
      calibration,
      rest,
      [
        [1, 0, 1, 0, 0, 1, 0, 1],
        [-1, 0, -1, 0, 0, -1, 0, -1],
      ],
      [
        // Pitch back: channel 5 goes negative, and channel 2 twitches with it.
        [0, 0, 0.12, 0, 0, -1, 0, -1],
        // Roll right: channel 2.
        [0, 0, 1, 0, 0, 0, 0, -1],
        // Yaw right: channel 0.
        [1, 0, 0, 0, 0, 0, 0, -1],
        // Throttle open: channel 7 to its top stop.
        [0, 0, 0, 0, 0, 0, 0, 1],
      ],
    );

    assert(calibration.complete, "the wizard reaches the end");
    const profile = calibration.profile();
    assert(
      profile.layout === CONTROLLER_LAYOUT.Calibrated,
      "and reports the layout as measured rather than guessed",
    );
    assert(profile.axes.pitch.channel === 5, "pitch was found on channel 5");
    assert(profile.axes.pitch.inverted, "and recognised as reversed");
    assert(
      profile.axes.roll.channel === 2,
      "crosstalk from the same stick did not steal roll's channel",
    );
    assert(profile.axes.yaw.channel === 0, "yaw was found on channel 0");
    assert(profile.axes.throttle.channel === 7, "and the throttle on channel 7");

    // The real test of a calibration is whether the aircraft then flies.
    const input = createFlightInput();
    applyProfile(input, pad([0, 0, 0, 0, 0, -1, 0, -1]), profile);
    assert(input.pitch > 0.9, "pulling back now commands nose up");
    applyProfile(input, pad([0, 0, 1, 0, 0, 0, 0, -1]), profile);
    assert(input.roll > 0.9, "right stick commands roll right");
    applyProfile(input, pad([1, 0, 0, 0, 0, 0, 0, -1]), profile);
    assert(input.yaw > 0.9, "and right rudder commands yaw right");
    applyProfile(input, pad([0, 0, 0, 0, 0, 0, 0, -1]), profile);
    assertClose(input.throttle, 0, 1e-6, "the throttle at its bottom stop is idle");
    applyProfile(input, pad([0, 0, 0, 0, 0, 0, 0, 1]), profile);
    assertClose(input.throttle, 1, 1e-6, "and at its top stop is full power");
    applyProfile(input, pad(rest), profile);
    assert(
      Math.abs(input.pitch) < 1e-6 &&
        Math.abs(input.roll) < 1e-6 &&
        Math.abs(input.yaw) < 1e-6,
      "hands off, nothing is commanded",
    );
  });

  suite("calibration refuses to guess", () => {
    const calibration = new ControllerCalibration("Still Pad", 4, 0);
    const step = 1 / 60;
    for (let t = 0; t < CENTRE_SECONDS + TRAVEL_SECONDS + 4; t += step) {
      calibration.update(pad([0, 0, 0, 0]), step);
    }
    assert(
      calibration.step === CALIBRATION_STEP.Pitch,
      "a pilot who moves nothing is left waiting rather than bound at random",
    );

    const ambiguous = new ControllerCalibration("Ambiguous", 4, 0);
    calibrateWith(
      ambiguous,
      [0, 0, 0, 0],
      [
        [1, 1, 1, 1],
        [-1, -1, -1, -1],
      ],
      [[0.8, 0.8, 0, 0]],
    );
    assert(
      ambiguous.step === CALIBRATION_STEP.Pitch,
      "and two channels moving together bind neither",
    );
  });

  suite("calibration keeps what it was not asked about", () => {
    const previous = withAxisChange(
      defaultProfile("Pad", "standard", 4, 16),
      "yaw",
      { sensitivity: 0.4 },
    );
    const calibration = new ControllerCalibration("Pad", 4, 16);
    const step = 1 / 60;
    for (let t = 0; t < CENTRE_SECONDS + 0.1; t += step) {
      calibration.update(pad([0, 0, 0, 0]), step);
    }
    calibration.skip();
    calibration.skip();
    calibration.skip();
    calibration.skip();
    calibration.skip();
    const merged = calibration.profile(previous);
    assertClose(
      merged.axes.yaw.sensitivity,
      0.4,
      1e-9,
      "skipping a control leaves its existing binding alone",
    );
    assert(
      merged.actions.camera === previous.actions.camera,
      "and button bindings are carried across",
    );
  });

  suite("binding a button", () => {
    const rest = [0, 0, 0, 0, 0, 0];
    assert(
      detectPressedChannel(pad([0, 0, 0, 0], [0, 0]), rest) === UNBOUND,
      "an untouched controller binds nothing",
    );
    assert(
      detectPressedChannel(pad([0, 0, 0, 0], [0, 1]), rest) === 5,
      "and a pressed button is found by its flat channel index",
    );
    assert(
      detectPressedChannel(pad([0, 0, 0, 0], [0, 0.2]), rest) === UNBOUND,
      "a trigger brushed lightly is not a press",
    );
  });

  suite("keyboard and controller share the aircraft", () => {
    const reader = new ScriptedReader();
    const controls = new FlightControls({ reader });
    const keys = fakeWindow();
    controls.keyboard.attach(keys.target);
    controls.setProfile(defaultProfile("Scripted Pad", "standard", 4, 4));
    controls.reset(0.4);

    let input = controls.sample(1 / 60);
    assert(
      controls.activeDevice === INPUT_DEVICE.Keyboard,
      "an untouched controller does not take the aircraft",
    );

    reader.set([0, -1, 0.9, 0]);
    input = controls.sample(1 / 60);
    assert(
      controls.activeDevice === INPUT_DEVICE.Controller,
      "moving a stick hands the aircraft to the controller",
    );
    assert(input.roll > 0.5, "which then flies it");
    assertClose(input.throttle, 1, 1e-6, "including the throttle, absolutely");

    // Held steady off centre: the controller must not be dropped.
    for (let i = 0; i < 30; i += 1) input = controls.sample(1 / 60);
    assert(
      controls.activeDevice === INPUT_DEVICE.Controller,
      "and holding a steady turn does not hand it back",
    );

    keys.keyDown("ArrowLeft");
    input = controls.sample(1 / 60);
    assert(
      controls.activeDevice === INPUT_DEVICE.Keyboard,
      "touching a key takes the aircraft back",
    );
    assertClose(
      input.throttle,
      1,
      1e-6,
      "and the power setting carries across rather than dropping to idle",
    );
    keys.keyUp("ArrowLeft");

    reader.connected = false;
    controls.sample(1 / 60);
    assert(
      controls.activeDevice === INPUT_DEVICE.Keyboard,
      "unplugging the controller leaves the keyboard flying",
    );
  });

  suite("controller buttons reach the session", () => {
    const reader = new ScriptedReader();
    const controls = new FlightControls({ reader });
    controls.setProfile(defaultProfile("Scripted Pad", "standard", 4, 4));

    controls.sample(1 / 60);
    assert(
      !controls.consumeAction(KEY_ACTION.Camera),
      "nothing is pressed to begin with",
    );

    reader.set([0, 0, 0, 0], [0, 0, 0, 1]);
    controls.sample(1 / 60);
    assert(
      controls.consumeAction(KEY_ACTION.Camera),
      "a bound button arrives as the action it stands for",
    );
    assert(!controls.consumeAction(KEY_ACTION.Camera), "and only once");

    controls.endFrame();
    controls.sample(1 / 60);
    assert(
      !controls.consumeAction(KEY_ACTION.Camera),
      "holding it down does not repeat",
    );

    reader.set([0, 0, 0, 0], [0, 0, 0, 0]);
    controls.sample(1 / 60);
    controls.endFrame();
    reader.set([0, 0, 0, 0], [0, 0, 0, 1]);
    controls.sample(1 / 60);
    assert(
      controls.consumeAction(KEY_ACTION.Camera),
      "releasing and pressing again does",
    );
  });

  suite("button edges outlive the frame that produced them", () => {
    // A button edge appears while the physics step is running, which is after
    // the session has already polled its hotkeys. Discarding unconsumed edges
    // at the end of the frame threw every one of them away.
    const reader = new ScriptedReader();
    const controls = new FlightControls({ reader });
    controls.setProfile(defaultProfile("Scripted Pad", "standard", 4, 4));

    reader.set([0, 0, 0, 0], [0, 0, 1, 0]);
    controls.sample(1 / 60);
    controls.endFrame();
    assert(
      controls.consumeAction(KEY_ACTION.CycleTarget),
      "an edge nothing has polled yet is still there next frame",
    );

    // Pausing releases the keys, and the button that caused it is still down.
    reader.set([0, 0, 0, 0], [0, 0, 0, 1]);
    controls.poll();
    assert(
      controls.consumeAction(KEY_ACTION.Camera),
      "a fresh press is delivered once",
    );
    controls.releaseAll();
    controls.poll();
    assert(
      !controls.consumeAction(KEY_ACTION.Camera),
      "and letting go of the keys does not make a held button look new",
    );
  });

  suite("buttons work while the simulation is stopped", () => {
    // Flight input is only produced while the aircraft is being flown, so a
    // paused game never samples. Polling has to keep working or a pilot on a
    // controller could pause and never resume.
    const reader = new ScriptedReader();
    const controls = new FlightControls({ reader });
    controls.setProfile(defaultProfile("Scripted Pad", "standard", 4, 4));

    reader.set([0, 0, 0, 0], [0, 0, 0, 0]);
    controls.poll();
    reader.set([0, 0, 0, 0], [1, 0, 0, 0]);
    controls.poll();
    assert(
      controls.consumeAction(KEY_ACTION.Minimap),
      "a button pressed with nothing being sampled still arrives",
    );
  });

  suite("controller sensitivity", () => {
    const reader = new ScriptedReader();
    const controls = new FlightControls({ reader, controllerSensitivity: 0.5 });
    controls.setProfile(defaultProfile("Scripted Pad", "standard", 4, 4));
    reader.set([0, 0, 0.6, 0]);
    const input = controls.sample(1 / 60);
    const full = createFlightInput();
    applyProfile(
      full,
      pad([0, 0, 0.6, 0], [0, 0, 0, 0]),
      defaultProfile("Scripted Pad", "standard", 4, 4),
    );
    assertClose(
      input.roll,
      full.roll * 0.5,
      1e-6,
      "the global slider scales the whole device without touching a calibration",
    );
  });

  suite("device names", () => {
    assert(
      deviceDisplayName("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)") ===
        "Xbox Wireless Controller",
      "vendor and product codes are trimmed for display",
    );
    assert(
      deviceDisplayName("RadioMaster TX16S Joystick (Vendor: 1209 Product: 4f54)") ===
        "RadioMaster TX16S Joystick",
      "leaving the part a pilot recognises",
    );
    assert(deviceDisplayName("Plain Pad") === "Plain Pad", "and a plain name is left alone");
  });
}
