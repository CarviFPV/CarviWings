/**
 * A pilot as a file: what a backup holds, and how one is read back.
 *
 * Everything a pilot owns lives in the browser it was flown in, which is the
 * right place for it — there is no account and no server to lose — but a
 * browser is also a thing people clear, replace, and do not carry to the
 * machine they fly on next. A backup is the answer to all three: one file
 * holding the callsign, the logbook and the raw stored blocks of every
 * pilot-scoped store, written out on demand and read back anywhere.
 *
 * The store blocks are carried as they were stored — `{ state, version }` as
 * the persistence layer wrote them — rather than as parsed settings. A backup
 * outlives the build that wrote it, so a restored block has to arrive at the
 * store's own migrations and repair pass exactly as a block sitting in storage
 * would; anything unpacked here would be a second copy of those rules, drifting
 * from the ones that matter.
 *
 * Nothing in this file knows which stores exist or what they are called: the
 * caller names them on the way out, and reads back the ones it recognises. That
 * keeps the document shape stable across a build that adds a store, and keeps
 * this module free of anything that only exists in a browser.
 */

import type { FlightRecord } from "./flightLog";
import { normaliseLog } from "./flightLog";
import type { PlayerProfile } from "./roster";
import { MIN_CALLSIGN_LENGTH, normaliseCallsign } from "./roster";

/** Names the file as ours, so a file picked by mistake is refused by name. */
export const PILOT_BACKUP_FORMAT = "carviwings-pilot";

/**
 * The document version, which is not any store's version.
 *
 * It describes the envelope — the fields below — and nothing inside `stores`,
 * each of which carries the version its own store wrote.
 */
export const PILOT_BACKUP_VERSION = 1;

/** One pilot, in the shape that is written to a file. */
export interface PilotBackup {
  readonly format: typeof PILOT_BACKUP_FORMAT;
  readonly version: number;
  /** Epoch milliseconds the backup was taken, shown when restoring it. */
  readonly exportedAt: number;
  readonly callsign: string;
  /** Epoch milliseconds; carried so a restored pilot keeps their history. */
  readonly createdAt: number;
  readonly lastFlownAt: number | null;
  readonly log: readonly FlightRecord[];
  /**
   * The persisted block of each pilot-scoped store, keyed by its storage name
   * and held exactly as storage held it.
   */
  readonly stores: Readonly<Record<string, unknown>>;
}

/** Why a file could not be restored, or the pilot inside it. */
export type PilotBackupRead =
  | { readonly ok: true; readonly backup: PilotBackup }
  | { readonly ok: false; readonly reason: string };

/** The backup document for a pilot, ready to be written out as JSON. */
export function pilotBackup(
  profile: PlayerProfile,
  log: readonly FlightRecord[],
  stores: Readonly<Record<string, unknown>>,
  now: number,
): PilotBackup {
  return {
    format: PILOT_BACKUP_FORMAT,
    version: PILOT_BACKUP_VERSION,
    exportedAt: now,
    callsign: profile.callsign,
    createdAt: profile.createdAt,
    lastFlownAt: profile.lastFlownAt,
    log,
    stores,
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A backup that can be trusted, from whatever a file picker handed back.
 *
 * A backup is the one document here that arrives from outside the browser that
 * wrote it — hand-edited, truncated by a copy that failed, or simply the wrong
 * file — so it is checked before any of it reaches storage. The parts that can
 * be repaired are repaired, on the same rules storage is repaired on; the parts
 * that identify the file cannot be, and a file failing those is refused with
 * the reason, because "nothing happened" is the worst answer a restore can give.
 */
export function readPilotBackup(raw: unknown): PilotBackupRead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "That file is not a pilot backup." };
  }

  const value = raw as Partial<Record<keyof PilotBackup, unknown>>;
  if (value.format !== PILOT_BACKUP_FORMAT) {
    return { ok: false, reason: "That file is not a CarviWings pilot backup." };
  }

  const version = finiteOr(value.version, 0);
  if (version > PILOT_BACKUP_VERSION) {
    return {
      ok: false,
      reason: "That backup was written by a newer version of the simulator.",
    };
  }

  const callsign =
    typeof value.callsign === "string" ? normaliseCallsign(value.callsign) : "";
  if (callsign.length < MIN_CALLSIGN_LENGTH) {
    return { ok: false, reason: "That backup has no callsign in it." };
  }

  // Only plain objects survive: a store block is handed straight back to a
  // persistence layer that will read `state` and `version` off it, and an
  // array or a string reaching that is a crash rather than a stale setting.
  const stores: Record<string, unknown> = {};
  if (value.stores && typeof value.stores === "object") {
    for (const [name, block] of Object.entries(value.stores)) {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        stores[name] = block;
      }
    }
  }

  return {
    ok: true,
    backup: {
      format: PILOT_BACKUP_FORMAT,
      version,
      exportedAt: finiteOr(value.exportedAt, 0),
      callsign,
      createdAt: finiteOr(value.createdAt, 0),
      lastFlownAt:
        typeof value.lastFlownAt === "number" && Number.isFinite(value.lastFlownAt)
          ? value.lastFlownAt
          : null,
      log: normaliseLog(value.log),
      stores,
    },
  };
}

/** Characters a file name keeps; everything else in a callsign becomes a dash. */
const UNSAFE_FILE_CHARACTERS = /[^a-z0-9]+/g;

/**
 * What the saved file is called.
 *
 * The callsign and the date are both in it because a pilot who backs up twice
 * wants the newer file to sit beside the older one rather than replace it, and
 * because a download folder is not somewhere anybody reads JSON to find out.
 */
export function backupFileName(callsign: string, exportedAt: number): string {
  const name =
    callsign
      .toLowerCase()
      .replace(UNSAFE_FILE_CHARACTERS, "-")
      .replace(/^-|-$/g, "") || "pilot";
  const date = new Date(exportedAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = Number.isFinite(exportedAt)
    ? `-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : "";
  return `carviwings-${name}${stamp}.json`;
}
