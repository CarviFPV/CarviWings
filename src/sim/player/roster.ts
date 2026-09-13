/**
 * Pilots, and the roster they are kept in.
 *
 * A pilot is a name and nothing else: their settings, their controller
 * calibration and their logbook are all stored against the identifier here
 * rather than inside it. Nothing in this file knows where any of that is kept,
 * which is what lets the same roster describe a browser holding two pilots and
 * a machine that one day holds them somewhere else.
 *
 * Everything that comes back out of storage goes through `normaliseRoster`
 * before it is used. A roster outlives the code that wrote it, may have been
 * hand-edited, and is the one thing the rest of the application is keyed on: a
 * missing callsign, or an active identifier naming a pilot who has been
 * deleted, has to become a repaired roster here rather than an undefined pilot
 * everywhere else.
 */

/** A pilot. Everything else about them is stored against `id`. */
export interface PlayerProfile {
  /** Stable for the life of the pilot; a rename does not change it. */
  readonly id: string;
  readonly callsign: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds of the last flight logged; null before the first. */
  readonly lastFlownAt: number | null;
}

export interface Roster {
  readonly players: readonly PlayerProfile[];
  /** Whose settings and logbook are live. Null only before the first pilot. */
  readonly activeId: string | null;
}

export const EMPTY_ROSTER: Roster = { players: [], activeId: null };

export const MIN_CALLSIGN_LENGTH = 2;
export const MAX_CALLSIGN_LENGTH = 16;

/**
 * How many pilots one installation holds.
 *
 * The limit is not a storage one — it is that a roster is chosen from a list,
 * and a list long enough to scroll is a worse way to start flying than typing
 * the name again.
 */
export const MAX_PLAYERS = 8;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 10;

/** Control characters, which arrive pasted in and are not part of a name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * A callsign as it will actually be stored.
 *
 * Typed input arrives with the spacing people type: a leading space, a double
 * one in the middle, a newline pasted in with the name. None of that is part of
 * what the pilot means to be called, and leaving it in means two callsigns that
 * read identically are held as two different pilots.
 */
export function normaliseCallsign(raw: string): string {
  return raw
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CALLSIGN_LENGTH);
}

/** True when two callsigns name the same pilot as far as a person is concerned. */
export function sameCallsign(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * Why a callsign cannot be used, as a sentence, or null when it can.
 *
 * `exceptId` is the pilot being renamed, who is allowed to keep their own name.
 */
export function callsignRejection(
  raw: string,
  roster: Roster,
  exceptId?: string,
): string | null {
  const callsign = normaliseCallsign(raw);
  if (callsign.length < MIN_CALLSIGN_LENGTH) {
    return `A callsign needs at least ${MIN_CALLSIGN_LENGTH} characters.`;
  }
  const taken = roster.players.some(
    (player) => player.id !== exceptId && sameCallsign(player.callsign, callsign),
  );
  return taken ? "That callsign is already flying here." : null;
}

/**
 * A callsign nobody in the roster is already using.
 *
 * Restoring a backup into a browser that still has that pilot in it is a real
 * thing to do — a second machine, a file kept from before a clear-out — and
 * neither answer of "refuse it" or "write over them" is what was meant. A
 * numeral makes the restored pilot their own pilot, visibly the same person,
 * and leaves the one already flying here untouched.
 */
export function uniqueCallsign(roster: Roster, wanted: string): string {
  const callsign = normaliseCallsign(wanted);
  const taken = (name: string): boolean =>
    roster.players.some((player) => sameCallsign(player.callsign, name));
  if (!taken(callsign)) return callsign;

  for (let suffix = 2; suffix <= MAX_PLAYERS + 1; suffix += 1) {
    const tail = ` ${suffix}`;
    const stem = callsign.slice(0, MAX_CALLSIGN_LENGTH - tail.length).trim();
    const candidate = `${stem}${tail}`;
    if (!taken(candidate)) return candidate;
  }
  return callsign;
}

/** True once the roster is full and the create form should say so. */
export function rosterFull(roster: Roster): boolean {
  return roster.players.length >= MAX_PLAYERS;
}

/**
 * An identifier no pilot in the roster is using.
 *
 * The random source is injectable so the collision path can be tested; nothing
 * about a pilot identifier has to be unguessable, only unique.
 */
export function createPlayerId(
  taken: readonly string[],
  random: () => number = Math.random,
): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let id = "";
    for (let i = 0; i < ID_LENGTH; i += 1) {
      const index = Math.floor(random() * ID_ALPHABET.length);
      id += ID_ALPHABET.charAt(
        Math.min(ID_ALPHABET.length - 1, Math.max(0, index)),
      );
    }
    if (!taken.includes(id)) return id;
  }
  // Sixty-four identical draws from a space this size means the random source
  // is not one; a counter still produces an identifier nobody else holds.
  let fallback = taken.length;
  while (taken.includes(`pilot-${fallback}`)) fallback += 1;
  return `pilot-${fallback}`;
}

export function createProfile(
  id: string,
  callsign: string,
  now: number,
): PlayerProfile {
  return {
    id,
    callsign: normaliseCallsign(callsign),
    createdAt: now,
    lastFlownAt: null,
  };
}

export function findPlayer(roster: Roster, id: string): PlayerProfile | null {
  return roster.players.find((player) => player.id === id) ?? null;
}

export function activePlayer(roster: Roster): PlayerProfile | null {
  return roster.activeId ? findPlayer(roster, roster.activeId) : null;
}

/** Adds a pilot and makes them the one flying, which is why they were added. */
export function addPlayer(roster: Roster, profile: PlayerProfile): Roster {
  if (findPlayer(roster, profile.id)) return roster;
  return { players: [...roster.players, profile], activeId: profile.id };
}

export function selectPlayer(roster: Roster, id: string): Roster {
  if (!findPlayer(roster, id) || roster.activeId === id) return roster;
  return { ...roster, activeId: id };
}

export function renamePlayer(
  roster: Roster,
  id: string,
  callsign: string,
): Roster {
  const wanted = normaliseCallsign(callsign);
  if (wanted.length < MIN_CALLSIGN_LENGTH) return roster;
  return {
    ...roster,
    players: roster.players.map((player) =>
      player.id === id ? { ...player, callsign: wanted } : player,
    ),
  };
}

/** Marks a pilot as having just flown, which is what the roster shows. */
export function touchPlayer(roster: Roster, id: string, now: number): Roster {
  return {
    ...roster,
    players: roster.players.map((player) =>
      player.id === id ? { ...player, lastFlownAt: now } : player,
    ),
  };
}

/**
 * Removes a pilot, and hands the active slot to whoever is left.
 *
 * Deleting the pilot who is flying has to leave somebody flying: their
 * neighbour in the list, so the roster keeps a selection under the cursor
 * rather than dropping the application back to the first-run form with pilots
 * still in it.
 */
export function removePlayer(roster: Roster, id: string): Roster {
  const index = roster.players.findIndex((player) => player.id === id);
  if (index < 0) return roster;

  const players = roster.players.filter((player) => player.id !== id);
  if (roster.activeId !== id) return { ...roster, players };

  const neighbour = players[Math.min(index, players.length - 1)];
  return { players, activeId: neighbour ? neighbour.id : null };
}

function normaliseProfile(
  raw: unknown,
  taken: readonly string[],
): PlayerProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof PlayerProfile, unknown>>;

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id || taken.includes(id)) return null;

  const callsign =
    typeof value.callsign === "string" ? normaliseCallsign(value.callsign) : "";
  if (callsign.length < MIN_CALLSIGN_LENGTH) return null;

  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  const lastFlownAt =
    typeof value.lastFlownAt === "number" && Number.isFinite(value.lastFlownAt)
      ? value.lastFlownAt
      : null;

  return { id, callsign, createdAt, lastFlownAt };
}

/**
 * A roster that can be trusted, from whatever storage handed back.
 *
 * Anything that cannot be read as a pilot is dropped rather than repaired into
 * one: a nameless row is one nobody can select, and a duplicate identifier
 * would give two pilots the same logbook.
 */
export function normaliseRoster(raw: unknown): Roster {
  if (!raw || typeof raw !== "object") return EMPTY_ROSTER;
  const value = raw as { players?: unknown; activeId?: unknown };

  const players: PlayerProfile[] = [];
  if (Array.isArray(value.players)) {
    for (const entry of value.players) {
      if (players.length >= MAX_PLAYERS) break;
      const profile = normaliseProfile(
        entry,
        players.map((player) => player.id),
      );
      if (profile) players.push(profile);
    }
  }

  if (players.length === 0) return EMPTY_ROSTER;

  const wanted = typeof value.activeId === "string" ? value.activeId : null;
  const active = players.some((player) => player.id === wanted)
    ? wanted
    : (players[0] as PlayerProfile).id;

  return { players, activeId: active };
}
