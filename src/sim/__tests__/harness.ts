/** Tiny assertion harness — no test framework dependency required. */

let failures = 0;
let checks = 0;
let currentSuite = "";

export function suite(name: string, body: () => void): void;
export function suite(name: string, body: () => Promise<void>): Promise<void>;
export function suite(
  name: string,
  body: () => void | Promise<void>,
): void | Promise<void> {
  currentSuite = name;
  console.log(`\n${name}`);
  return body();
}

function record(ok: boolean, message: string, detail?: string): void {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${message}${detail ? `\n        ${detail}` : ""}`);
  }
}

export function assert(condition: boolean, message: string): void {
  record(condition, message);
}

export function assertClose(
  actual: number,
  expected: number,
  tolerance: number,
  message: string,
): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  record(
    ok,
    message,
    ok
      ? undefined
      : `expected ${expected} +/- ${tolerance}, got ${actual}`,
  );
}

export function assertBetween(
  actual: number,
  min: number,
  max: number,
  message: string,
): void {
  const ok = Number.isFinite(actual) && actual >= min && actual <= max;
  record(ok, message, ok ? undefined : `expected ${min}..${max}, got ${actual}`);
}

export function report(): void {
  console.log(
    `\n${checks - failures}/${checks} checks passed${
      failures > 0 ? ` — ${failures} FAILED` : ""
    }`,
  );
  void currentSuite;
  if (failures > 0) process.exit(1);
}

/**
 * A stand-in for `window` that delivers key events.
 *
 * `Keyboard` attaches to whatever window it is handed, so the input layer can
 * be driven from Node without a DOM. Suppressed defaults are recorded, which
 * is the only way to see from a test whether a key was swallowed.
 */
export interface FakeWindow {
  readonly target: Window;
  keyDown(code: string, options?: KeyEventOptions): void;
  keyUp(code: string, options?: KeyEventOptions): void;
  /** Codes whose browser default was suppressed, in order. */
  readonly prevented: string[];
}

export interface KeyEventOptions {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export function fakeWindow(): FakeWindow {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const prevented: string[] = [];
  const target = {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(): void {},
  } as unknown as Window;

  const fire = (type: string, code: string, options: KeyEventOptions): void => {
    for (const handler of listeners.get(type) ?? []) {
      handler({
        code,
        repeat: options.repeat ?? false,
        ctrlKey: options.ctrlKey ?? false,
        metaKey: options.metaKey ?? false,
        altKey: options.altKey ?? false,
        target: null,
        preventDefault() {
          prevented.push(code);
        },
      });
    }
  };

  return {
    target,
    keyDown: (code, options = {}) => fire("keydown", code, options),
    keyUp: (code, options = {}) => fire("keyup", code, options),
    prevented,
  };
}
