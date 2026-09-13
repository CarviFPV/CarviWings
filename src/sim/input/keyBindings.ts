/**
 * Keyboard bindings: which physical key stands for which action.
 *
 * One table for the whole simulator. The flight axes, the view keys and the
 * development keys all live here so that a pilot rebinding "pitch up" and a
 * pilot rebinding "toggle camera" go through the same code, and so that no
 * two actions can quietly end up on the same key.
 *
 * Nothing here touches the DOM. A binding is a `KeyboardEvent.code` — the
 * physical key, not the character it produces — which is what makes a layout
 * bound on AZERTY still sit under the same fingers on QWERTY.
 */

export type KeyCode = string;

/** An action with no key on it. Reads as "—" and never matches an event. */
export const UNBOUND_KEY: KeyCode = "";

export const KEY_ACTION = {
  PitchUp: "pitchUp",
  PitchDown: "pitchDown",
  RollLeft: "rollLeft",
  RollRight: "rollRight",
  YawLeft: "yawLeft",
  YawRight: "yawRight",
  ThrottleUp: "throttleUp",
  ThrottleDown: "throttleDown",
  FlightMode: "flightMode",
  CourseHold: "courseHold",
  AltitudeHold: "altitudeHold",
  ReturnHome: "returnHome",
  Camera: "camera",
  Minimap: "minimap",
  CycleTarget: "cycleTarget",
  Pause: "pause",
  Debug: "debug",
  ResetAircraft: "resetAircraft",
  SpawnEnemy: "spawnEnemy",
  FreeCamera: "freeCamera",
} as const;

export type KeyAction = (typeof KEY_ACTION)[keyof typeof KEY_ACTION];

export const KEY_ACTION_GROUP = {
  Flight: "flight",
  /** The stabilisation and navigation switches an FPV wing carries. */
  Modes: "modes",
  View: "view",
  Development: "development",
} as const;

export type KeyActionGroup =
  (typeof KEY_ACTION_GROUP)[keyof typeof KEY_ACTION_GROUP];

export interface KeyActionInfo {
  readonly action: KeyAction;
  readonly group: KeyActionGroup;
  readonly label: string;
  readonly description: string;
}

/**
 * Every bindable action, in the order the controls screen lists them.
 *
 * This is also the canonical order conflicts are resolved in, so the flight
 * controls keep their keys when a stored layout has to be repaired.
 */
export const KEY_ACTION_INFO: readonly KeyActionInfo[] = [
  {
    action: KEY_ACTION.PitchUp,
    group: KEY_ACTION_GROUP.Flight,
    label: "Pitch up",
    description: "Raises the nose",
  },
  {
    action: KEY_ACTION.PitchDown,
    group: KEY_ACTION_GROUP.Flight,
    label: "Pitch down",
    description: "Lowers the nose",
  },
  {
    action: KEY_ACTION.RollLeft,
    group: KEY_ACTION_GROUP.Flight,
    label: "Roll left",
    description: "Banks left to turn",
  },
  {
    action: KEY_ACTION.RollRight,
    group: KEY_ACTION_GROUP.Flight,
    label: "Roll right",
    description: "Banks right to turn",
  },
  {
    action: KEY_ACTION.ThrottleUp,
    group: KEY_ACTION_GROUP.Flight,
    label: "Throttle up",
    description: "Ramps up while held",
  },
  {
    action: KEY_ACTION.ThrottleDown,
    group: KEY_ACTION_GROUP.Flight,
    label: "Throttle down",
    description: "Ramps down while held",
  },
  {
    action: KEY_ACTION.YawLeft,
    group: KEY_ACTION_GROUP.Flight,
    label: "Yaw left",
    description: "Differential drag",
  },
  {
    action: KEY_ACTION.YawRight,
    group: KEY_ACTION_GROUP.Flight,
    label: "Yaw right",
    description: "Differential drag",
  },
  {
    action: KEY_ACTION.FlightMode,
    group: KEY_ACTION_GROUP.Modes,
    label: "Flight mode",
    description: "Acro \u2194 angle",
  },
  {
    action: KEY_ACTION.CourseHold,
    group: KEY_ACTION_GROUP.Modes,
    label: "Course hold",
    description: "Holds the heading it is on",
  },
  {
    action: KEY_ACTION.AltitudeHold,
    group: KEY_ACTION_GROUP.Modes,
    label: "Altitude hold",
    description: "Holds the height it is at",
  },
  {
    action: KEY_ACTION.ReturnHome,
    group: KEY_ACTION_GROUP.Modes,
    label: "Return home",
    description: "Flies itself back to the launch point",
  },
  {
    action: KEY_ACTION.Camera,
    group: KEY_ACTION_GROUP.View,
    label: "Toggle camera",
    description: "FPV, chase, and the field on a ground-view flight",
  },
  {
    action: KEY_ACTION.Minimap,
    group: KEY_ACTION_GROUP.View,
    label: "Toggle minimap",
    description: "Bottom-left tactical display",
  },
  {
    action: KEY_ACTION.CycleTarget,
    group: KEY_ACTION_GROUP.View,
    label: "Cycle target",
    description: "Steps through contacts by range",
  },
  {
    action: KEY_ACTION.Pause,
    group: KEY_ACTION_GROUP.View,
    label: "Pause",
    description: "Opens the pause menu",
  },
  {
    action: KEY_ACTION.Debug,
    group: KEY_ACTION_GROUP.View,
    label: "Debug overlay",
    description: "Simulation internals",
  },
  {
    action: KEY_ACTION.ResetAircraft,
    group: KEY_ACTION_GROUP.Development,
    label: "Reset aircraft",
    description: "Respawn at the mission origin",
  },
  {
    action: KEY_ACTION.SpawnEnemy,
    group: KEY_ACTION_GROUP.Development,
    label: "Spawn enemy",
    description: "An AI interceptor on the shared flight model",
  },
  {
    action: KEY_ACTION.FreeCamera,
    group: KEY_ACTION_GROUP.Development,
    label: "Free camera",
    description: "Hands the view to the mouse",
  },
];

export const KEY_ACTIONS: readonly KeyAction[] = KEY_ACTION_INFO.map(
  (info) => info.action,
);

/** The axes the flight model is flown on, as opposed to the view actions. */
export const FLIGHT_ACTIONS = [
  KEY_ACTION.PitchUp,
  KEY_ACTION.PitchDown,
  KEY_ACTION.RollLeft,
  KEY_ACTION.RollRight,
  KEY_ACTION.YawLeft,
  KEY_ACTION.YawRight,
  KEY_ACTION.ThrottleUp,
  KEY_ACTION.ThrottleDown,
] as const;

export type FlightAction = (typeof FLIGHT_ACTIONS)[number];

export type KeyBindings = Readonly<Record<KeyAction, KeyCode>>;

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  pitchUp: "ArrowUp",
  pitchDown: "ArrowDown",
  rollLeft: "ArrowLeft",
  rollRight: "ArrowRight",
  yawLeft: "KeyA",
  yawRight: "KeyD",
  throttleUp: "KeyW",
  throttleDown: "KeyS",
  flightMode: "KeyF",
  courseHold: "KeyC",
  altitudeHold: "KeyH",
  returnHome: "KeyR",
  camera: "KeyV",
  minimap: "KeyM",
  cycleTarget: "KeyT",
  pause: "Escape",
  debug: "F3",
  resetAircraft: "F1",
  spawnEnemy: "F2",
  freeCamera: "F4",
};

/**
 * Keys the simulator will not take.
 *
 * Tab is how a keyboard user reaches the rest of the interface, and taking it
 * would leave a mis-bound control with no way to undo itself.
 */
export const RESERVED_KEYS: readonly KeyCode[] = ["Tab"];

export function isReservedKey(code: KeyCode): boolean {
  return RESERVED_KEYS.includes(code);
}

/**
 * Actions that must always have a key on them.
 *
 * Pause is the way back out of a flight. A pilot who unbound it — or who took
 * its key for something else — would be left flying with no menu, so it is the
 * one binding that can be moved but not removed.
 */
export const ESSENTIAL_ACTIONS: readonly KeyAction[] = [KEY_ACTION.Pause];

export function isEssentialAction(action: KeyAction): boolean {
  return ESSENTIAL_ACTIONS.includes(action);
}

export function actionInfo(action: KeyAction): KeyActionInfo {
  const info = KEY_ACTION_INFO.find((entry) => entry.action === action);
  // Every action in the union is in the table; the fallback exists so a
  // caller never has to deal with `undefined`.
  return (
    info ?? {
      action,
      group: KEY_ACTION_GROUP.View,
      label: action,
      description: "",
    }
  );
}

export function actionsInGroup(group: KeyActionGroup): readonly KeyActionInfo[] {
  return KEY_ACTION_INFO.filter((info) => info.group === group);
}

// --- Editing ---------------------------------------------------------------

/** The action already holding `code`, if any, ignoring `except`. */
export function actionHoldingKey(
  bindings: KeyBindings,
  code: KeyCode,
  except?: KeyAction,
): KeyAction | null {
  if (code === UNBOUND_KEY) return null;
  for (const action of KEY_ACTIONS) {
    if (action === except) continue;
    if (bindings[action] === code) return action;
  }
  return null;
}

/**
 * Puts `code` on `action`.
 *
 * A key can only mean one thing, so whichever action held it is left unbound
 * rather than both firing at once. The interface says which one lost its key,
 * which is far easier to act on than a control that silently stopped working.
 */
export function withBinding(
  bindings: KeyBindings,
  action: KeyAction,
  code: KeyCode,
): KeyBindings {
  if (isReservedKey(code)) return bindings;
  const holder = actionHoldingKey(bindings, code, action);
  // Taking pause's key would leave it unbound, which is the one thing the
  // layout does not allow; move pause first and its old key comes free.
  if (holder && isEssentialAction(holder)) return bindings;
  const next: Record<KeyAction, KeyCode> = { ...bindings };
  if (code !== UNBOUND_KEY) {
    for (const other of KEY_ACTIONS) {
      if (other !== action && next[other] === code) next[other] = UNBOUND_KEY;
    }
  }
  next[action] = code;
  return next;
}

export function withoutBinding(
  bindings: KeyBindings,
  action: KeyAction,
): KeyBindings {
  if (isEssentialAction(action)) return bindings;
  return { ...bindings, [action]: UNBOUND_KEY };
}

/**
 * Repairs a layout loaded from storage.
 *
 * Settings outlive the version of the game that wrote them: an action added
 * since gets its default, junk gets thrown away, and a key claimed twice is
 * given to whichever action comes first in `KEY_ACTIONS` — the loser falls
 * back to its own default if that is still free and is otherwise unbound,
 * which is visible on the controls screen rather than silently wrong.
 */
export function normaliseBindings(stored: unknown): KeyBindings {
  const raw = (stored ?? {}) as Partial<Record<KeyAction, unknown>>;
  const next = {} as Record<KeyAction, KeyCode>;
  const used = new Set<KeyCode>();

  for (const action of KEY_ACTIONS) {
    const value = raw[action];
    let code: KeyCode;
    if (value === UNBOUND_KEY) {
      code = UNBOUND_KEY;
    } else if (typeof value === "string" && !isReservedKey(value)) {
      code = value;
    } else {
      code = DEFAULT_KEY_BINDINGS[action];
    }

    if (code !== UNBOUND_KEY && used.has(code)) {
      const fallback = DEFAULT_KEY_BINDINGS[action];
      code = used.has(fallback) ? UNBOUND_KEY : fallback;
    }
    if (code !== UNBOUND_KEY) used.add(code);
    next[action] = code;
  }

  // An action that cannot be left unbound takes its default back, whoever a
  // hand-edited file had given it to.
  for (const action of ESSENTIAL_ACTIONS) {
    if (next[action] !== UNBOUND_KEY) continue;
    const fallback = DEFAULT_KEY_BINDINGS[action];
    for (const other of KEY_ACTIONS) {
      if (other !== action && next[other] === fallback) next[other] = UNBOUND_KEY;
    }
    next[action] = fallback;
  }

  return next;
}

/** The subset the keyboard flight source is driven by. */
export function flightBindings(
  bindings: KeyBindings,
): Readonly<Record<FlightAction, KeyCode>> {
  const next = {} as Record<FlightAction, KeyCode>;
  for (const action of FLIGHT_ACTIONS) next[action] = bindings[action];
  return next;
}

/** Every key the simulator is listening for, unbound actions aside. */
export function boundKeys(bindings: KeyBindings): KeyCode[] {
  const codes: KeyCode[] = [];
  for (const action of KEY_ACTIONS) {
    const code = bindings[action];
    if (code !== UNBOUND_KEY && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

// --- Presentation ----------------------------------------------------------

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Num ⏎",
  Backspace: "Bksp",
  CapsLock: "Caps",
  ShiftLeft: "L Shift",
  ShiftRight: "R Shift",
  ControlLeft: "L Ctrl",
  ControlRight: "R Ctrl",
  AltLeft: "L Alt",
  AltRight: "R Alt",
  MetaLeft: "L Meta",
  MetaRight: "R Meta",
  ContextMenu: "Menu",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Insert: "Ins",
  Delete: "Del",
  Home: "Home",
  End: "End",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  IntlBackslash: "\\",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadDecimal: "Num .",
};

/** A short, human-readable name for a `KeyboardEvent.code`. */
export function keyLabel(code: KeyCode): string {
  if (!code) return "—";
  const named = NAMED_KEYS[code];
  if (named) return named;
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}
