"use client";

/**
 * The pilot's key layout, persisted to localStorage.
 *
 * Kept apart from the rest of the settings for the same reason controller
 * profiles are: a layout is edited as a whole, has its own repair rules, and
 * has to survive the game gaining actions that did not exist when it was
 * written. Anything loaded from storage goes through `normaliseBindings`
 * before it is used.
 *
 * The layout belongs to a pilot: the player store points this store at that
 * pilot's storage key and loads it when they take over.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { KeyAction, KeyBindings, KeyCode } from "@/sim/input/keyBindings";
import {
  DEFAULT_KEY_BINDINGS,
  normaliseBindings,
  withBinding,
  withoutBinding,
} from "@/sim/input/keyBindings";

interface KeyBindingStore {
  bindings: KeyBindings;
  /** Puts a key on an action, taking it from whatever else held it. */
  bind(action: KeyAction, code: KeyCode): void;
  clear(action: KeyAction): void;
  resetAction(action: KeyAction): void;
  reset(): void;
}

export const useKeyBindingStore = create<KeyBindingStore>()(
  persist(
    (set) => ({
      bindings: DEFAULT_KEY_BINDINGS,
      bind: (action, code) =>
        set((state) => ({ bindings: withBinding(state.bindings, action, code) })),
      clear: (action) =>
        set((state) => ({ bindings: withoutBinding(state.bindings, action) })),
      resetAction: (action) =>
        set((state) => ({
          bindings: withBinding(
            state.bindings,
            action,
            DEFAULT_KEY_BINDINGS[action],
          ),
        })),
      reset: () => set({ bindings: DEFAULT_KEY_BINDINGS }),
    }),
    {
      name: "fpv-wing-keybindings",
      storage: createJSONStorage(() => localStorage),
      // Loaded by the player store, once it knows whose layout this is.
      skipHydration: true,
      version: 1,
      partialize: (state) => ({ bindings: state.bindings }),
      // A stored layout predates every action added since, and may name keys
      // twice if it was hand-edited; repairing it here means nothing
      // downstream has to consider a half-valid table.
      merge: (persisted, current) => ({
        ...current,
        bindings: normaliseBindings(
          (persisted as { bindings?: unknown } | undefined)?.bindings,
        ),
      }),
    },
  ),
);

export function readKeyBindings(): KeyBindings {
  return useKeyBindingStore.getState().bindings;
}
