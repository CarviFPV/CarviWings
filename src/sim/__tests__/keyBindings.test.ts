import { assert, assertClose, fakeWindow, suite } from "./harness";
import type { KeyBindings } from "../input/keyBindings";
import {
  DEFAULT_KEY_BINDINGS,
  KEY_ACTION,
  KEY_ACTIONS,
  UNBOUND_KEY,
  actionHoldingKey,
  boundKeys,
  flightBindings,
  keyLabel,
  normaliseBindings,
  withBinding,
  withoutBinding,
} from "../input/keyBindings";
import { FlightControls } from "../input/flightControls";

export function runKeyBindingTests(): void {
  suite("the default layout is a valid one", () => {
    const codes = KEY_ACTIONS.map((action) => DEFAULT_KEY_BINDINGS[action]);
    assert(
      codes.every((code) => code !== UNBOUND_KEY),
      "every action ships with a key on it",
    );
    assert(
      new Set(codes).size === codes.length,
      "and no two actions want the same one",
    );
    assert(
      normaliseBindings(DEFAULT_KEY_BINDINGS).pitchUp ===
        DEFAULT_KEY_BINDINGS.pitchUp,
      "repairing a sound layout leaves it alone",
    );
  });

  suite("rebinding a key takes it from whoever had it", () => {
    const bindings = withBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.PitchUp, "KeyI");
    assert(bindings.pitchUp === "KeyI", "the action gets the key it was given");
    assert(
      bindings.pitchDown === DEFAULT_KEY_BINDINGS.pitchDown,
      "and its neighbours are untouched",
    );

    const stolen = withBinding(bindings, KEY_ACTION.Camera, "KeyI");
    assert(stolen.camera === "KeyI", "a second action can claim the same key");
    assert(
      stolen.pitchUp === UNBOUND_KEY,
      "which leaves the first one unbound rather than both firing",
    );
    assert(
      actionHoldingKey(DEFAULT_KEY_BINDINGS, "KeyV") === KEY_ACTION.Camera,
      "the interface can say which action a key already belongs to",
    );
    assert(
      actionHoldingKey(DEFAULT_KEY_BINDINGS, "KeyV", KEY_ACTION.Camera) === null,
      "and an action does not report a conflict with itself",
    );

    const cleared = withoutBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.SpawnEnemy);
    assert(cleared.spawnEnemy === UNBOUND_KEY, "a binding can be removed");
    assert(
      !boundKeys(cleared).includes(DEFAULT_KEY_BINDINGS.spawnEnemy),
      "and the key is no longer one the sim listens for",
    );

    assert(
      withBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.PitchUp, "Tab").pitchUp ===
        DEFAULT_KEY_BINDINGS.pitchUp,
      "a key the browser needs is refused rather than taken",
    );
  });

  suite("pause always keeps a key", () => {
    // Unbinding the way out of a flight would leave a pilot with no menu.
    assert(
      withoutBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.Pause).pause ===
        DEFAULT_KEY_BINDINGS.pause,
      "it cannot be cleared",
    );
    assert(
      withBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.Camera, "Escape").camera ===
        DEFAULT_KEY_BINDINGS.camera,
      "and another action cannot take its key out from under it",
    );

    const moved = withBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.Pause, "KeyP");
    assert(moved.pause === "KeyP", "moving it somewhere else is allowed");
    assert(
      withBinding(moved, KEY_ACTION.Camera, "Escape").camera === "Escape",
      "which frees the key it used to hold",
    );

    assert(
      normaliseBindings({ pause: UNBOUND_KEY }).pause ===
        DEFAULT_KEY_BINDINGS.pause,
      "a stored layout without it gets it back",
    );
    const rescued = normaliseBindings({ camera: "Escape", pause: UNBOUND_KEY });
    assert(
      rescued.pause === DEFAULT_KEY_BINDINGS.pause &&
        rescued.camera === UNBOUND_KEY,
      "even when something else had claimed the key",
    );
  });

  suite("a stored layout is repaired before it is used", () => {
    const stored = normaliseBindings({
      pitchUp: "KeyI",
      pitchDown: 7,
      rollLeft: "KeyJ",
      // A hand-edited file can name one key twice; the later action loses it.
      rollRight: "KeyJ",
      camera: UNBOUND_KEY,
      nonsense: "KeyZ",
    });
    assert(stored.pitchUp === "KeyI", "a valid binding survives");
    assert(
      stored.pitchDown === DEFAULT_KEY_BINDINGS.pitchDown,
      "junk falls back to the default",
    );
    assert(stored.rollLeft === "KeyJ", "the first claim on a key keeps it");
    assert(
      stored.rollRight === DEFAULT_KEY_BINDINGS.rollRight,
      "and the second falls back to its own default, which is still free",
    );
    assert(
      stored.camera === UNBOUND_KEY,
      "a deliberately unbound action stays unbound",
    );
    assert(
      stored.throttleUp === DEFAULT_KEY_BINDINGS.throttleUp,
      "an action the stored layout predates gets its default",
    );
    assert(
      KEY_ACTIONS.every((action) => typeof stored[action] === "string"),
      "and every action ends up with an answer",
    );

    const collided = normaliseBindings({
      pitchUp: "KeyW",
      pitchDown: "ArrowDown",
      throttleUp: "KeyW",
    });
    assert(
      collided.throttleUp === UNBOUND_KEY,
      "a loser whose own default was taken is left unbound rather than doubled up",
    );
  });

  suite("the aircraft flies on the pilot's own keys", () => {
    const bindings: KeyBindings = withBinding(
      withBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.PitchUp, "KeyI"),
      KEY_ACTION.ThrottleUp,
      "PageUp",
    );
    assert(
      flightBindings(bindings).pitchUp === "KeyI",
      "the flight source is handed the pilot's layout",
    );

    const controls = new FlightControls({ bindings });
    const keys = fakeWindow();
    controls.keyboard.attach(keys.target);
    controls.reset(0);

    keys.keyDown("ArrowUp");
    let input = controls.sample(1 / 60);
    assertClose(input.pitch, 0, 1e-9, "the key that used to pitch up does nothing");
    keys.keyUp("ArrowUp");

    keys.keyDown("KeyI");
    for (let i = 0; i < 20; i += 1) input = controls.sample(1 / 60);
    assert(input.pitch > 0.5, "and the key the pilot chose raises the nose");
    keys.keyUp("KeyI");

    keys.keyDown("PageUp");
    for (let i = 0; i < 60; i += 1) input = controls.sample(1 / 60);
    assert(input.throttle > 0.5, "a rebound throttle key still adds power");
    assert(
      keys.prevented.includes("PageUp"),
      "and its browser default — scrolling the page — is suppressed",
    );
    keys.keyUp("PageUp");

    assert(
      !keys.prevented.includes("KeyR"),
      "a key nothing is bound to keeps its default",
    );
  });

  suite("rebinding an action while flying", () => {
    const controls = new FlightControls();
    const keys = fakeWindow();
    controls.keyboard.attach(keys.target);

    keys.keyDown("KeyV");
    assert(
      controls.consumeAction(KEY_ACTION.Camera),
      "the default key toggles the camera",
    );
    keys.keyUp("KeyV");
    controls.endFrame();

    controls.setBindings(
      withBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.Camera, "KeyC"),
    );
    keys.keyDown("KeyV");
    assert(
      !controls.consumeAction(KEY_ACTION.Camera),
      "after the change the old key no longer does",
    );
    keys.keyUp("KeyV");
    controls.endFrame();

    keys.keyDown("KeyC");
    assert(
      controls.consumeAction(KEY_ACTION.Camera),
      "and the new one does, without restarting the flight",
    );
    keys.keyUp("KeyC");
    controls.endFrame();

    controls.setBindings(
      withoutBinding(DEFAULT_KEY_BINDINGS, KEY_ACTION.SpawnEnemy),
    );
    keys.keyDown(DEFAULT_KEY_BINDINGS.spawnEnemy);
    assert(
      !controls.consumeAction(KEY_ACTION.SpawnEnemy),
      "an unbound action never fires",
    );
  });

  suite("keys are named the way a pilot would write them", () => {
    assert(keyLabel("KeyW") === "W", "a letter key is its letter");
    assert(keyLabel("Digit4") === "4", "a number key is its number");
    assert(keyLabel("ArrowLeft") === "←", "an arrow is drawn as one");
    assert(keyLabel("Escape") === "Esc", "Escape is abbreviated");
    assert(keyLabel("Numpad7") === "Num 7", "the numeric pad is distinguished");
    assert(keyLabel("F3") === "F3", "a function key needs no translation");
    assert(keyLabel(UNBOUND_KEY) === "—", "and nothing at all reads as a dash");
  });
}
