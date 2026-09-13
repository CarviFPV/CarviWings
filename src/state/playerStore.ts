"use client";

/**
 * Pilots, and the storage every other store hangs off.
 *
 * The roster and the logbooks live here. The settings, the key layout and the
 * controller calibrations do not: they stay in the stores that already own
 * them, and this store moves those stores onto a different storage key when a
 * different pilot takes over. Nothing else in the application has to know that
 * more than one pilot exists — a screen reads `useSettingsStore` exactly as it
 * did before, and what it gets back is whatever the pilot currently flying
 * saved.
 *
 * There is no server and no database behind any of this, deliberately. The
 * only data a pilot generates is their own settings and their own flights,
 * nobody else ever needs to read it, and a database would mean an account, a
 * password and something to host — none of which makes the simulator fly
 * better. What a server would buy is a pilot surviving the browser they fly
 * in, and that is bought here instead by `backupPilot` and `restorePilot`: a
 * pilot is one serialisable document, so they can be written to a file the
 * pilot keeps and read back into any browser, on any machine, after any
 * clear-out.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { FlightStatistics } from "@/sim/flight/telemetry";
import type { MissionSettings, MissionStatus } from "@/sim/mission";
import type {
  FlightRecord,
  PilotBackup,
  PlayerProfile,
  Roster,
} from "@/sim/player";
import {
  EMPTY_ROSTER,
  MAX_PLAYERS,
  activePlayer,
  addPlayer,
  addRecord,
  callsignRejection,
  createPlayerId,
  createProfile,
  findPlayer,
  flightRecord,
  normaliseLog,
  normaliseRoster,
  pilotBackup,
  readPilotBackup,
  removePlayer,
  renamePlayer,
  rosterFull,
  selectPlayer,
  touchPlayer,
  uniqueCallsign,
} from "@/sim/player";

import { useSettingsStore } from "./settingsStore";
import { useKeyBindingStore } from "./keyBindingStore";
import { useControllerStore } from "./controllerStore";

/**
 * A store whose persisted state belongs to one pilot.
 *
 * Only the three methods used to move a store between pilots are named here,
 * so the list below can hold stores with entirely different state shapes.
 */
interface PilotScopedStore {
  /** The storage key used before pilots existed, and the prefix used since. */
  readonly base: string;
  readonly persist: {
    setOptions(options: { name: string }): void;
    rehydrate(): Promise<void> | void;
  };
  /** Puts the store back to what a pilot who has changed nothing has. */
  toDefaults(): void;
}

const PILOT_SCOPED: readonly PilotScopedStore[] = [
  {
    base: "fpv-wing-settings",
    persist: useSettingsStore.persist,
    toDefaults: () => useSettingsStore.getState().reset(),
  },
  {
    base: "fpv-wing-keybindings",
    persist: useKeyBindingStore.persist,
    toDefaults: () => useKeyBindingStore.getState().reset(),
  },
  {
    // A calibration is a preference as much as a measurement — the expo and
    // the dead zone on a stick are the pilot's, not the machine's — so a
    // controller is calibrated per pilot rather than once per device.
    base: "fpv-wing-controllers",
    persist: useControllerStore.persist,
    toDefaults: () => useControllerStore.getState().forgetAll(),
  },
];

function storageKey(base: string, playerId: string): string {
  return `${base}:${playerId}`;
}

/**
 * Whether a pilot has anything saved under a key yet.
 *
 * Storage can refuse to answer at all — a browser with site data blocked
 * throws on the first read — and a pilot with nothing saved is the same
 * situation as one who cannot be read: they start from the defaults.
 */
function hasStored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function forgetStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // A browser that will not let go of the key is not worth failing a delete
    // over: the pilot is gone from the roster either way, and nothing reads a
    // key no roster entry names.
  }
}

/**
 * Puts the pilot-scoped stores on one pilot's storage and loads it.
 *
 * The order matters: the key is changed first, so nothing is written back to
 * the pilot being left, and the defaults are only applied when there is
 * genuinely nothing stored — resetting first would write those defaults over
 * the settings this pilot is about to load.
 */
async function adoptPlayer(playerId: string): Promise<void> {
  for (const store of PILOT_SCOPED) {
    const key = storageKey(store.base, playerId);
    store.persist.setOptions({ name: key });
    if (hasStored(key)) {
      await store.persist.rehydrate();
    } else {
      store.toDefaults();
    }
  }
}

/**
 * Leaves the stores on the unnamespaced keys they used before pilots existed.
 *
 * Reached only by deleting the last pilot, which puts the installation back to
 * a first run — and a first run is exactly what those keys describe.
 */
function adoptNobody(): void {
  for (const store of PILOT_SCOPED) {
    store.persist.setOptions({ name: store.base });
    store.toDefaults();
  }
}

/**
 * Hands an installation that flew before pilots existed to its first pilot.
 *
 * The stored values are moved rather than read: each store has its own version
 * number and its own migrations, and copying the raw text under the new key
 * leaves all of that to run exactly as it would have.
 */
function claimUnnamespacedStorage(playerId: string): void {
  for (const store of PILOT_SCOPED) {
    try {
      const stored = localStorage.getItem(store.base);
      if (stored === null) continue;
      const key = storageKey(store.base, playerId);
      if (localStorage.getItem(key) === null) localStorage.setItem(key, stored);
      localStorage.removeItem(store.base);
    } catch {
      // Nothing to carry over that is worth refusing to create a pilot for.
    }
  }
}

function forgetPlayerStorage(playerId: string): void {
  for (const store of PILOT_SCOPED) {
    forgetStored(storageKey(store.base, playerId));
  }
}

/**
 * The stored block of every pilot-scoped store, as storage holds it.
 *
 * Read as text and parsed rather than taken from the live stores: a block
 * carries the version that wrote it alongside the state, and a backup that
 * dropped the version would arrive on a later build claiming to be current and
 * skip the migrations it needs. A pilot who has changed nothing has no block
 * at all, and one that will not parse is one nothing could have loaded either;
 * both are simply left out, and the pilot restores onto the defaults.
 */
function readPlayerStorage(playerId: string): Record<string, unknown> {
  const stores: Record<string, unknown> = {};
  for (const store of PILOT_SCOPED) {
    try {
      const stored = localStorage.getItem(storageKey(store.base, playerId));
      if (stored === null) continue;
      const block = JSON.parse(stored) as unknown;
      if (block && typeof block === "object") stores[store.base] = block;
    } catch {
      // Unreadable or unparsable is the same as never saved.
    }
  }
  return stores;
}

/**
 * Puts a backup's blocks under a new pilot's keys, ready to be loaded.
 *
 * Only the stores this build has are written: a backup from a build with a
 * store since renamed or removed carries a block nothing will ever read, and
 * writing it would leave storage holding a key no pilot can clear.
 */
function writePlayerStorage(
  playerId: string,
  stores: Readonly<Record<string, unknown>>,
): void {
  for (const store of PILOT_SCOPED) {
    const block = stores[store.base];
    if (block === undefined) continue;
    try {
      const key = storageKey(store.base, playerId);
      localStorage.setItem(key, JSON.stringify(block));
    } catch {
      // A browser refusing the write leaves that store on its defaults, which
      // is a worse restore than was asked for but still a pilot who can fly.
    }
  }
}

/** A restore either seats a pilot or says, in a sentence, why it could not. */
export type PilotRestore =
  | { readonly ok: true; readonly profile: PlayerProfile }
  | { readonly ok: false; readonly reason: string };

interface PlayerStore {
  roster: Roster;
  /** One logbook per pilot, newest flight first, keyed by pilot identifier. */
  logs: Record<string, readonly FlightRecord[]>;
  /** False until storage has been read, which is deferred until after mount. */
  hydrated: boolean;

  hydrate(): Promise<void>;
  /** Creates a pilot and puts them in the seat, or returns null with why not. */
  createPilot(callsign: string): PlayerProfile | null;
  selectPilot(id: string): void;
  renamePilot(id: string, callsign: string): void;
  deletePilot(id: string): void;
  /** Everything a pilot owns, as the document a backup file holds. */
  backupPilot(id: string): PilotBackup | null;
  /**
   * Restores a backup as a new pilot and puts them in the seat.
   *
   * Never writes over a pilot already here: a restore that replaced the
   * matching callsign would be the one action in the roster that destroys a
   * logbook without asking.
   */
  restorePilot(raw: unknown): PilotRestore;
  /** Writes a finished flight into the flying pilot's logbook. */
  logFlight(
    settings: MissionSettings,
    statistics: FlightStatistics,
    status: MissionStatus,
  ): void;
}

export const usePlayerStore = create<PlayerStore>()(
  persist(
    (set, get) => ({
      roster: EMPTY_ROSTER,
      logs: {},
      hydrated: false,

      hydrate: async () => {
        await usePlayerStore.persist.rehydrate();
        const active = get().roster.activeId;
        if (active) await adoptPlayer(active);
        set({ hydrated: true });
      },

      createPilot: (callsign) => {
        const roster = get().roster;
        if (rosterFull(roster) || callsignRejection(callsign, roster)) return null;

        const id = createPlayerId(roster.players.map((player) => player.id));
        const profile = createProfile(id, callsign, Date.now());
        // The pilot who ends a first run inherits whatever was set up before
        // there was anybody to own it, so nobody loses a calibration to this.
        if (roster.players.length === 0) claimUnnamespacedStorage(id);

        set({ roster: addPlayer(roster, profile) });
        void adoptPlayer(id);
        return profile;
      },

      selectPilot: (id) => {
        const roster = selectPlayer(get().roster, id);
        if (roster === get().roster) return;
        set({ roster });
        void adoptPlayer(id);
      },

      renamePilot: (id, callsign) =>
        set((state) => ({ roster: renamePlayer(state.roster, id, callsign) })),

      deletePilot: (id) => {
        const roster = removePlayer(get().roster, id);
        if (roster === get().roster) return;

        const logs = { ...get().logs };
        delete logs[id];
        set({ roster, logs });
        forgetPlayerStorage(id);

        if (roster.activeId === null) adoptNobody();
        else if (roster.activeId !== id) void adoptPlayer(roster.activeId);
      },

      backupPilot: (id) => {
        const profile = findPlayer(get().roster, id);
        if (!profile) return null;
        return pilotBackup(
          profile,
          get().logs[id] ?? [],
          readPlayerStorage(id),
          Date.now(),
        );
      },

      restorePilot: (raw) => {
        const read = readPilotBackup(raw);
        if (!read.ok) return read;

        const roster = get().roster;
        if (rosterFull(roster)) {
          return {
            ok: false,
            reason:
              `The roster holds ${MAX_PLAYERS} pilots and is full — ` +
              "delete one to restore another.",
          };
        }

        const backup = read.backup;
        const id = createPlayerId(roster.players.map((player) => player.id));
        const profile: PlayerProfile = {
          id,
          callsign: uniqueCallsign(roster, backup.callsign),
          createdAt: backup.createdAt > 0 ? backup.createdAt : Date.now(),
          lastFlownAt: backup.lastFlownAt,
        };

        // A first-run installation's unnamespaced keys are deliberately left
        // where they are: they are whoever set this browser up before pilots
        // existed, and handing them to a pilot restored from somebody else's
        // file would mix two people's settings together.
        //
        // Written before the pilot is seated: adopting them loads these keys,
        // and a pilot adopted onto keys that are not there yet would take the
        // defaults and then save them over the backup.
        writePlayerStorage(id, backup.stores);

        set({
          roster: addPlayer(roster, profile),
          logs: { ...get().logs, [id]: backup.log },
        });
        void adoptPlayer(id);
        return { ok: true, profile };
      },

      logFlight: (settings, statistics, status) => {
        const id = get().roster.activeId;
        if (!id) return;

        const now = Date.now();
        const record = flightRecord(settings, statistics, status, now);
        set((state) => ({
          roster: touchPlayer(state.roster, id, now),
          logs: { ...state.logs, [id]: addRecord(state.logs[id] ?? [], record) },
        }));
      },
    }),
    {
      name: "fpv-wing-pilots",
      storage: createJSONStorage(() => localStorage),
      // Rehydrated explicitly on mount, like every other persisted store, and
      // before them: which pilot is flying decides what they read.
      skipHydration: true,
      version: 1,
      partialize: (state) => ({ roster: state.roster, logs: state.logs }),
      // Everything here is repaired on the way in. The roster is the one piece
      // of state the whole application is keyed on, and a logbook is the only
      // record of flights that cannot be flown again.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as {
          roster?: unknown;
          logs?: unknown;
        };
        const roster = normaliseRoster(stored.roster);
        const known = new Set(roster.players.map((player) => player.id));

        const logs: Record<string, readonly FlightRecord[]> = {};
        if (stored.logs && typeof stored.logs === "object") {
          for (const [id, log] of Object.entries(stored.logs)) {
            // A logbook whose pilot did not survive normalisation belongs to
            // nobody: keeping it would leave storage growing on every repair.
            if (!known.has(id)) continue;
            logs[id] = normaliseLog(log);
          }
        }

        return { ...current, roster, logs };
      },
    },
  ),
);

/** One shared empty list, so a pilot with no flights is a stable reference. */
const EMPTY_LOG: readonly FlightRecord[] = [];

/** The pilot currently flying, or null during a first run. */
export function useActivePilot(): PlayerProfile | null {
  return usePlayerStore((state) => activePlayer(state.roster));
}

/** The flying pilot's logbook, newest flight first. */
export function useActiveLog(): readonly FlightRecord[] {
  return usePlayerStore((state) => {
    const id = state.roster.activeId;
    return id ? (state.logs[id] ?? EMPTY_LOG) : EMPTY_LOG;
  });
}
