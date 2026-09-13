"use client";

/**
 * Raw keyboard state.
 *
 * Deliberately dumb: it tracks which physical keys are down and which were
 * pressed since the last poll. Nothing here knows what a key *means* — the
 * mapping to flight controls lives in `keyboardFlightSource.ts`, and the
 * mapping to UI actions lives in the React layer.
 */

export type KeyCode = string;

/**
 * Keys whose browser default (scrolling, quick-find, reload) would fight the
 * sim, whether or not anything is bound to them.
 */
const ALWAYS_SWALLOWED: readonly KeyCode[] = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "Slash",
];

export class Keyboard {
  private readonly down = new Set<KeyCode>();
  private readonly pressed = new Set<KeyCode>();
  /** Grows with whatever the pilot has bound; see `setSwallowed`. */
  private swallowed = new Set<KeyCode>(ALWAYS_SWALLOWED);
  private attached = false;

  /**
   * True for a key whose default the sim should suppress.
   *
   * Never with a modifier held: a pilot who has bound R to something still
   * expects Ctrl+R to reload the page.
   */
  private shouldSwallow(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    return this.swallowed.has(event.code);
  }

  /**
   * Adds the currently bound keys to the ones whose default is suppressed.
   *
   * Bindings are editable, so which keys need swallowing is not known when
   * this class is written: a pilot who moves pitch onto Page Up would
   * otherwise scroll the page every time they pulled back.
   */
  setSwallowed(codes: Iterable<KeyCode>): void {
    const next = new Set<KeyCode>(ALWAYS_SWALLOWED);
    for (const code of codes) {
      if (code) next.add(code);
    }
    this.swallowed = next;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      if (this.shouldSwallow(event)) event.preventDefault();
      return;
    }
    // Never steal keys from a text field.
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (this.shouldSwallow(event)) event.preventDefault();
    this.down.add(event.code);
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.shouldSwallow(event)) event.preventDefault();
    this.down.delete(event.code);
  };

  /** Releases every key when focus leaves, so nothing sticks down. */
  private readonly onBlur = (): void => {
    this.down.clear();
  };

  attach(target: Window = window): void {
    if (this.attached) return;
    this.attached = true;
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
  }

  detach(target: Window = window): void {
    if (!this.attached) return;
    this.attached = false;
    target.removeEventListener("keydown", this.onKeyDown);
    target.removeEventListener("keyup", this.onKeyUp);
    target.removeEventListener("blur", this.onBlur);
    this.down.clear();
    this.pressed.clear();
  }

  /** An empty code is an unbound action, which is never down. */
  isDown(code: KeyCode): boolean {
    return code !== "" && this.down.has(code);
  }

  /** True once per physical press; clears the edge. */
  consumePress(code: KeyCode): boolean {
    if (code === "" || !this.pressed.has(code)) return false;
    this.pressed.delete(code);
    return true;
  }

  /** Drops any press edges that nothing consumed this frame. */
  endFrame(): void {
    this.pressed.clear();
  }

  releaseAll(): void {
    this.down.clear();
    this.pressed.clear();
  }
}
