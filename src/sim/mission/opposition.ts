/**
 * What everybody else in the sky is flying.
 *
 * Every other aircraft in this simulator used to be the same one the pilot was
 * flying, because there was only one aircraft. There are four now, and a
 * mission that puts a 2.1 m survey wing, a 480 mm glider and a 160 mm
 * quadcopter in the same piece of sky is a different mission from one that
 * puts four more interceptors in it — they climb differently, turn
 * differently, and they are not all runnable-down from the same aspect.
 *
 * So the field is chosen the way everything else about a mission is: pick the
 * airframes, or ask for the whole hangar. It is the same choice whatever is
 * being flown — the contacts hunting you on an interception, the transit and
 * its escort on a strike, the rest of your flight on a formation display, the
 * grid on a race, the club on a festival field — because "what is up there
 * with me" is one question, and the answer to it is not the mission's to make.
 * Nothing here decides how anybody flies — that is the AI's business — only
 * which aeroplane each of them is sitting in, and the speed the pilot flying
 * it is held to.
 *
 * Which one gets which airframe comes from the mission seed, like the spawn
 * points and the routes: the same mission always puts the same aircraft in the
 * same places.
 */

import type { AircraftConfig } from "../flight/config";
import { maxLevelSpeed } from "../flight/physics";
import type { Uav } from "../flight/uav";
import { DEFAULT_UAV_ID, UAVS, findUav, uavOrDefault } from "../flight/uav";
import { createRng } from "../math/rng";

export const OPPOSITION_MODE = {
  /**
   * The airframes the pilot picked, and nothing else.
   *
   * One of them is a mission flown against a single type; several is a mixed
   * field, dealt so that all of them actually turn up.
   */
  Chosen: "CHOSEN",
  /** Drawn from the whole hangar, aircraft by aircraft. Anything can appear. */
  Random: "RANDOM",
  /** The whole hangar, dealt so that every type in it is represented. */
  All: "ALL",
} as const;

export type OppositionMode =
  (typeof OPPOSITION_MODE)[keyof typeof OPPOSITION_MODE];

export const OPPOSITION_MODES = [
  OPPOSITION_MODE.Chosen,
  OPPOSITION_MODE.Random,
  OPPOSITION_MODE.All,
] as const;

/** What each way of choosing a field is called, and what it does. */
export interface OppositionModeInfo {
  readonly id: OppositionMode;
  readonly label: string;
  /** One line, for the option button. */
  readonly hint: string;
}

export const OPPOSITION_MODE_INFO: Readonly<
  Record<OppositionMode, OppositionModeInfo>
> = {
  [OPPOSITION_MODE.Chosen]: {
    id: OPPOSITION_MODE.Chosen,
    label: "Selected",
    hint: "the airframes you pick",
  },
  [OPPOSITION_MODE.Random]: {
    id: OPPOSITION_MODE.Random,
    label: "Random",
    hint: "anything, drawn per aircraft",
  },
  [OPPOSITION_MODE.All]: {
    id: OPPOSITION_MODE.All,
    label: "All types",
    hint: "the whole hangar, mixed",
  },
} as const;

export interface OppositionSettings {
  readonly mode: OppositionMode;
  /**
   * The airframes everybody else may fly, by hangar id.
   *
   * Only read in `Chosen`; kept when the pilot switches away from it so that
   * switching back finds the selection where they left it.
   */
  readonly aircraft: readonly string[];
}

/**
 * What a mission is flown with when nobody has said otherwise: more of the
 * aircraft the simulator has always put up, which is what every mission flown
 * before this was choosable was flown against — and, on a race, a display or a
 * festival, alongside.
 */
export const DEFAULT_OPPOSITION: OppositionSettings = {
  mode: OPPOSITION_MODE.Chosen,
  aircraft: [DEFAULT_UAV_ID],
};

/**
 * Repairs an opposition setting from storage, a saved mission, or a screen.
 *
 * Airframes that are no longer in the hangar are dropped, duplicates are
 * dropped, the rest are put back into hangar order, and a selection that has
 * nothing left in it becomes the delivered one rather than an opposition of
 * no aircraft at all.
 */
export function normaliseOpposition(
  stored: unknown,
): OppositionSettings {
  const raw = (stored ?? {}) as Partial<Record<keyof OppositionSettings, unknown>>;
  const mode = (OPPOSITION_MODES as readonly OppositionMode[]).includes(
    raw.mode as OppositionMode,
  )
    ? (raw.mode as OppositionMode)
    : DEFAULT_OPPOSITION.mode;

  const listed = Array.isArray(raw.aircraft) ? raw.aircraft : [];
  const wanted = new Set(
    listed.filter((id): id is string => typeof id === "string"),
  );
  const aircraft = UAVS.filter((uav) => wanted.has(uav.id)).map((uav) => uav.id);

  return {
    mode,
    aircraft: aircraft.length > 0 ? aircraft : [DEFAULT_UAV_ID],
  };
}

/**
 * The airframes a setting can put in the air, in hangar order.
 *
 * Never empty: a mission with no opposition airframe at all is not a mission,
 * so an unrecognisable setting falls back to the interceptor rather than
 * leaving the session with nothing to spawn.
 */
export function oppositionFleet(
  settings: OppositionSettings | null | undefined,
): readonly Uav[] {
  const normalised = normaliseOpposition(settings);
  if (normalised.mode !== OPPOSITION_MODE.Chosen) return UAVS;
  const chosen = normalised.aircraft
    .map((id) => findUav(id))
    .filter((uav): uav is Uav => uav !== null);
  return chosen.length > 0 ? chosen : [uavOrDefault(DEFAULT_UAV_ID)];
}

/**
 * The fleet in the order it is dealt out, from the mission seed.
 *
 * Dealt rather than drawn, so a field asked to contain every type contains
 * every type: four contacts against the whole hangar are one of each, not
 * three quadcopters and a glider. Shuffled first so that the order is the
 * mission's rather than the hangar's — the same four aircraft, but not always
 * the interceptor in front.
 */
function dealtFleet(fleet: readonly Uav[], seed: string): readonly Uav[] {
  const order = [...fleet];
  const rng = createRng(`${seed}:opposition-order`);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const held = order[i] as Uav;
    order[i] = order[j] as Uav;
    order[j] = held;
  }
  return order;
}

/**
 * Which airframe the `index`th aircraft of a mission's field is flying.
 *
 * A contact, a rival on the grid, somebody's slot in the flight, somebody's
 * model at the fly-in: all the same question, counted from zero in whatever
 * order the mission spawns them. Deterministic in the mission seed and that
 * number, so a mission flown twice puts the same aircraft up twice, and
 * nothing has to be stored between the setup screen and the spawn.
 */
export function oppositionAircraft(
  settings: OppositionSettings | null | undefined,
  seed: string,
  index: number,
): Uav {
  const fleet = oppositionFleet(settings);
  const only = fleet[0] as Uav;
  if (fleet.length === 1) return only;

  const nth = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  if (normaliseOpposition(settings).mode === OPPOSITION_MODE.Random) {
    return createRng(`${seed}:opposition:${nth}`).pick(fleet);
  }
  const dealt = dealtFleet(fleet, seed);
  return dealt[nth % dealt.length] as Uav;
}

/**
 * The speed an AI pilot is held to, metres per second.
 *
 * Two things decide it, and both of them matter. The first is the aeroplane:
 * a survey wing is slower than an interceptor and a racing quadcopter is
 * faster than both, and a mission with all three in it should feel like it.
 * The second is that an aircraft nobody can stay with is nobody's mission —
 * a contact that out-runs the one chasing it ends an interception by flying
 * away from it, a leader that out-runs its own flight is not leading a
 * formation, and a grid that cannot be seen after the first gate is not a
 * race.
 *
 * So it is the slower of the two: the AI's own airframe, until that airframe
 * is faster than the pilot's, at which point it is held to the pilot's. What
 * each kind of pilot then does inside that — a fraction of it on patrol, a
 * profile's pace on a course, a fly-in circuit speed — is its own business.
 */
export function contactSpeedReference(
  contact: AircraftConfig,
  player: AircraftConfig,
): number {
  return Math.min(maxLevelSpeed(contact), maxLevelSpeed(player));
}

/** The field in one line, for a setup screen or a briefing. */
export function describeOpposition(
  settings: OppositionSettings | null | undefined,
): string {
  const fleet = oppositionFleet(settings);
  if (fleet.length === 1) return (fleet[0] as Uav).config.name;
  return fleet.map((uav) => uav.config.name).join(" · ");
}
