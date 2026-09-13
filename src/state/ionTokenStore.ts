"use client";

/**
 * The Cesium ion access token, as this installation holds it.
 *
 * Deliberately not a pilot setting. A token is an account with an allowance on
 * it, not a preference: everybody flying this browser streams the world on the
 * same one, and a second pilot should not have to go and find a token of their
 * own before they can take off. So this store is left out of the pilot-scoped
 * list in `playerStore` — it keeps one unnamespaced key, it survives a pilot
 * being deleted, and it is not carried in a pilot backup, which would otherwise
 * hand somebody else's token to whoever the file was sent to.
 *
 * Like the other persisted stores it is hydrated after mount rather than during
 * render, so the server-rendered markup and the first client render agree.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  ION_TOKEN_SOURCE,
  normaliseIonToken,
  readEnvIonToken,
  setEnteredIonToken,
  type IonTokenSource,
} from "@/lib/cesium/ionToken";
import { resolveIonToken } from "@/sim/config/ionToken";

interface IonTokenStore {
  /** The token typed into the application; empty when none has been. */
  token: string;
  /** False until storage has been read, which is deferred until after mount. */
  hydrated: boolean;
  /**
   * Whether this installation has been asked for a token yet.
   *
   * The prompt is a first run, not a nag: once it has been answered — with a
   * token, or with "look around first" — the application is never taken over
   * by it again. Somebody who then clears the token from the settings screen
   * knows exactly what they have done and does not need throwing back to a
   * welcome screen for it; the warning on the main menu and the field on the
   * failure screen are what carry it from there.
   */
  prompted: boolean;

  hydrate(): Promise<void>;
  /** Stores a pasted token. False when there was nothing usable in it. */
  save(raw: string): boolean;
  /** Forgets the stored token, falling back to whatever the build carries. */
  clear(): void;
  /** Answers the first-run prompt without a token. */
  dismissPrompt(): void;
}

export const useIonTokenStore = create<IonTokenStore>()(
  persist(
    (set) => ({
      token: "",
      hydrated: false,
      prompted: false,

      hydrate: async () => {
        await useIonTokenStore.persist.rehydrate();
        set({ hydrated: true });
      },

      save: (raw) => {
        const token = normaliseIonToken(raw);
        if (token.length === 0) return false;
        set({ token, prompted: true });
        return true;
      },

      clear: () => set({ token: "" }),

      dismissPrompt: () => set({ prompted: true }),
    }),
    {
      name: "fpv-wing-ion",
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      version: 1,
      partialize: (state) => ({ token: state.token, prompted: state.prompted }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as {
          token?: unknown;
          prompted?: unknown;
        };
        // Repaired on the way in like every other stored block: a token edited
        // by hand or truncated by a browser out of quota is still only text,
        // and a blank one simply means nothing was ever entered.
        const token = normaliseIonToken(stored.token);
        return {
          ...current,
          token,
          // A block written before the prompt existed belongs to somebody
          // already flying, who does not need welcoming to their own
          // installation. So does one carrying a token by any route.
          prompted: stored.prompted === true || token.length > 0,
        };
      },
    },
  ),
);

// Everything that streams the world reads the token through `lib/cesium`, which
// has no way of its own to reach storage. Pushing it across here — once for the
// value the store starts on, then on every change, hydration included — is what
// makes a token typed into the settings screen take effect on the next flight
// without a reload.
setEnteredIonToken(useIonTokenStore.getState().token);
useIonTokenStore.subscribe((state) => setEnteredIonToken(state.token));

/** Which way in the token in force arrived by, as a subscription. */
export function useIonTokenSource(): IonTokenSource {
  const entered = useIonTokenStore((state) => state.token);
  return resolveIonToken(entered.length > 0 ? entered : null, readEnvIonToken())
    .source;
}

/**
 * Whether the world can be streamed at all.
 *
 * False while storage is still being read: a stored token is the usual case, so
 * assuming there is none until proven otherwise would flash "no token" at
 * everybody who has one.
 */
export function useIonTokenConfigured(): boolean {
  const source = useIonTokenSource();
  const hydrated = useIonTokenStore((state) => state.hydrated);
  return source !== ION_TOKEN_SOURCE.None || !hydrated;
}
