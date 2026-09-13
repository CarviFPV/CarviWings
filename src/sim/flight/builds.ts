/**
 * Saved aircraft: an airframe, the hardware in it and the tune, under a name.
 *
 * The hangar in `uav.ts` is a workbench. It holds one setup per airframe — the
 * rates it is tuned on, the combo bolted to it, the pack in the bay — and that
 * is exactly what a transmitter's model memory is: the aircraft as it stands
 * right now. What it cannot do is hold two of them. A pilot who has set an X8
 * up for a long mapping run and again for a sport flight has to rebuild one of
 * the two every time they want it.
 *
 * A build is that setup written down and given a name, so it can be recalled
 * before a flight instead of rebuilt. It is a snapshot rather than a second
 * place the aircraft lives: selecting one lays it back over the workbench, and
 * the flight still reads the workbench, so nothing downstream of here — the
 * session, the flight controller, the OSD — needs to know builds exist at all.
 *
 * Which build is selected is therefore not stored. It is whichever one the
 * workbench currently matches, so setting an aircraft up by hand until it
 * happens to be a saved one selects it, and moving one slider away from a
 * saved one deselects it, without a stored identifier that could disagree with
 * the aircraft actually in front of the pilot.
 *
 * Every airframe in the hangar also has a build nobody saved: itself, as it
 * comes out of the box. A stock build is the airframe's own delivered
 * hardware, tune and paint written in the same shape as a saved one, so a
 * pilot who has never opened the workbench still has an aircraft to pick for
 * every airframe the simulator has, and picking one is picking an aircraft
 * rather than rebuilding one. It is derived rather than stored — there is
 * nothing about it to keep that the airframe does not already say — which is
 * also why it cannot be renamed, written over or deleted: modifying one is
 * what saving a build under a name of your own is for.
 */

import type { Livery } from "./livery";
import { normaliseLivery, sameLivery } from "./livery";
import { cruiseEndurance, maxLevelSpeed } from "./physics";
import {
  BATTERY_UNLIMITED,
  formatBattery,
  formatEndurance,
} from "./powerplant";
import type { ControlRates } from "./rates";
import { normaliseRates } from "./rates";
import { MS_TO_KMH } from "./telemetry";
import type { Uav, UavLoadout, UavSettings } from "./uav";
import {
  UAVS,
  deliveredBattery,
  deliveredMotor,
  findUav,
  liveryFor,
  loadoutFor,
  ratesFor,
  resolveLoadout,
  uavOrDefault,
} from "./uav";

/** One saved aircraft. */
export interface AircraftBuild {
  /** Stable for the life of the build; renaming it does not change it. */
  readonly id: string;
  /** What the pilot calls it. */
  readonly name: string;
  /** The airframe, by hangar id. */
  readonly uav: string;
  /** The motor, ESC and propeller combination fitted. */
  readonly motor: string;
  /** The pack in the bay, or `BATTERY_UNLIMITED` for no range simulation. */
  readonly battery: string;
  /** The tune it is flown on. */
  readonly rates: ControlRates;
  /** The colours it is painted in. */
  readonly livery: Livery;
}

export const MIN_BUILD_NAME_LENGTH = 2;
export const MAX_BUILD_NAME_LENGTH = 24;

/**
 * How many aircraft one pilot can keep.
 *
 * Not a storage limit: the list is read before every flight, and a list long
 * enough to scroll is a worse way to choose an aircraft than setting the one
 * you want up again.
 */
export const MAX_BUILDS = 12;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 10;

/** Control characters, which arrive pasted in and are not part of a name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** A name as it will actually be stored, with the typing tidied out of it. */
export function normaliseBuildName(raw: string): string {
  return raw
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BUILD_NAME_LENGTH);
}

/** True when two names read as the same aircraft to a person. */
export function sameBuildName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * What every stock aircraft's identifier starts with.
 *
 * A saved build's identifier is ten characters from `ID_ALPHABET`, which has
 * no colon in it, so nothing a pilot saves can ever collide with one of these
 * — and the prefix is what tells the two apart everywhere a list holds both.
 */
const STOCK_ID_PREFIX = "stock:";

/** The identifier the stock build of one airframe answers to. */
export function stockBuildId(uavId: string): string {
  return `${STOCK_ID_PREFIX}${uavId}`;
}

/** True when an identifier names an airframe as delivered rather than a save. */
export function isStockBuildId(id: string): boolean {
  return id.startsWith(STOCK_ID_PREFIX);
}

/**
 * One airframe as it comes out of the box, in the shape of a build.
 *
 * Named after the airframe itself, because that is what it is: not a setup
 * somebody arrived at, but the aircraft the manufacturer delivers.
 */
export function stockBuild(uav: Uav): AircraftBuild {
  return {
    id: stockBuildId(uav.id),
    name: normaliseBuildName(uav.config.name),
    uav: uav.id,
    motor: deliveredMotor(uav).id,
    battery: deliveredBattery(uav).id,
    rates: uav.defaultRates,
    livery: uav.defaultLivery,
  };
}

/** Every airframe as delivered, in hangar order. Always there, never stored. */
export const STOCK_BUILDS: readonly AircraftBuild[] = UAVS.map(stockBuild);

/** The stock build with that identifier, or null when it names no airframe. */
export function findStockBuild(id: string): AircraftBuild | null {
  return STOCK_BUILDS.find((build) => build.id === id) ?? null;
}

/** The stock build of one airframe, by hangar id. */
export function stockBuildFor(uavId: string): AircraftBuild {
  return stockBuild(uavOrDefault(uavId));
}

/**
 * Every aircraft that can be picked without building one first.
 *
 * The airframes as delivered come first and in hangar order, so the list reads
 * the same on a pilot's first flight as on their hundredth, with whatever they
 * have saved underneath rather than instead.
 */
export function hangarAircraft(
  builds: readonly AircraftBuild[],
): readonly AircraftBuild[] {
  return [...STOCK_BUILDS, ...builds];
}

/** True when a name is one an airframe already answers to as delivered. */
export function isStockBuildName(raw: string): boolean {
  const name = normaliseBuildName(raw);
  return STOCK_BUILDS.some((stock) => sameBuildName(stock.name, name));
}

/**
 * Why a name cannot be used, as a sentence, or null when it can.
 *
 * `exceptId` is the build being renamed or written over, which is allowed to
 * keep the name it already has.
 */
export function buildNameRejection(
  raw: string,
  builds: readonly AircraftBuild[],
  exceptId?: string,
): string | null {
  const name = normaliseBuildName(raw);
  if (name.length < MIN_BUILD_NAME_LENGTH) {
    return `A name needs at least ${MIN_BUILD_NAME_LENGTH} characters.`;
  }
  // The airframes as delivered are in the same list under their own names, so
  // one of those is not a name a saved aircraft can take: two rows reading
  // "Skywalker X8" would be two different aircraft the pilot cannot tell apart.
  if (isStockBuildName(name)) {
    return "That is an airframe's own name, and it is already in the hangar.";
  }
  const taken = builds.some(
    (build) => build.id !== exceptId && sameBuildName(build.name, name),
  );
  return taken ? "There is already an aircraft saved under that name." : null;
}

/** True once the hangar is full and the save form should say so. */
export function buildsFull(builds: readonly AircraftBuild[]): boolean {
  return builds.length >= MAX_BUILDS;
}

/** The build with that id, or null when nothing saved answers to it. */
export function findBuild(
  builds: readonly AircraftBuild[],
  id: string,
): AircraftBuild | null {
  return builds.find((build) => build.id === id) ?? null;
}

/**
 * An identifier no saved aircraft is using.
 *
 * The random source is injectable so the collision path can be tested; nothing
 * about a build identifier has to be unguessable, only unique.
 */
export function createBuildId(
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
  while (taken.includes(`build-${fallback}`)) fallback += 1;
  return `build-${fallback}`;
}

/** The aircraft on the workbench right now, saved under a name. */
export function buildFromSettings(
  settings: UavSettings,
  id: string,
  name: string,
): AircraftBuild {
  const uav = uavOrDefault(settings.active);
  const power = loadoutFor(settings, uav.id);
  return {
    id,
    name: normaliseBuildName(name),
    uav: uav.id,
    motor: power.motor,
    battery: power.battery,
    rates: ratesFor(settings, uav.id),
    livery: liveryFor(settings, uav.id),
  };
}

/**
 * The same settings with a saved aircraft laid back over the workbench.
 *
 * Only the airframe the build names is touched: every other airframe keeps the
 * tune and the hardware it was left with, the way selecting one model memory
 * on a transmitter does not disturb the rest of them.
 */
export function applyBuild(
  settings: UavSettings,
  build: AircraftBuild,
): UavSettings {
  return {
    ...settings,
    active: build.uav,
    rates: { ...settings.rates, [build.uav]: build.rates },
    power: {
      ...settings.power,
      [build.uav]: { motor: build.motor, battery: build.battery },
    },
    livery: { ...settings.livery, [build.uav]: build.livery },
  };
}

function sameRates(a: ControlRates, b: ControlRates): boolean {
  return (
    a.rollRate === b.rollRate &&
    a.pitchRate === b.pitchRate &&
    a.rollExpo === b.rollExpo &&
    a.pitchExpo === b.pitchExpo
  );
}

/** True when the workbench is holding exactly the aircraft that was saved. */
export function buildMatchesSettings(
  settings: UavSettings,
  build: AircraftBuild,
): boolean {
  if (settings.active !== build.uav) return false;
  const power = loadoutFor(settings, build.uav);
  if (power.motor !== build.motor || power.battery !== build.battery) {
    return false;
  }
  if (!sameLivery(liveryFor(settings, build.uav), build.livery)) return false;
  return sameRates(ratesFor(settings, build.uav), build.rates);
}

/** The saved aircraft the workbench is currently holding, if it is one. */
export function selectedBuild(
  builds: readonly AircraftBuild[],
  settings: UavSettings,
): AircraftBuild | null {
  return builds.find((build) => buildMatchesSettings(settings, build)) ?? null;
}

/**
 * The aircraft the workbench is holding, saved or stock.
 *
 * A saved one answers first: a pilot who has saved the delivered setup under a
 * name of their own has said what they call that aircraft, and the list should
 * agree with them. Only when nothing saved matches does the airframe's own
 * stock build answer, which is what an untouched hangar is holding.
 */
export function fittedAircraft(
  builds: readonly AircraftBuild[],
  settings: UavSettings,
): AircraftBuild | null {
  const saved = selectedBuild(builds, settings);
  if (saved) return saved;
  const stock = stockBuildFor(settings.active);
  return buildMatchesSettings(settings, stock) ? stock : null;
}

/** A saved aircraft as it flies: the airframe worked out from the hardware. */
export function resolveBuild(build: AircraftBuild): UavLoadout {
  return resolveLoadout(uavOrDefault(build.uav), {
    motor: build.motor,
    battery: build.battery,
  });
}

/** What is in an aircraft and how fast it goes, without naming the airframe. */
export function describeHardware(loadout: UavLoadout): string {
  const speed = Math.round(maxLevelSpeed(loadout.config) * MS_TO_KMH);
  const pack = loadout.battery
    ? formatBattery(loadout.battery)
    : loadout.motor.combustion
      ? "no tank simulated"
      : "no pack simulated";
  return `${pack} · ${speed} km/h`;
}

/** One line about an aircraft: what it is, what is in it, how fast it goes. */
export function describeLoadout(loadout: UavLoadout): string {
  return `${loadout.uav.config.name} · ${describeHardware(loadout)}`;
}

/**
 * The same line for an aircraft in a list, without it having to be fitted.
 *
 * A stock aircraft is named after its airframe already, so its line says what
 * is in it and how fast it goes rather than saying the airframe again.
 */
export function describeBuild(build: AircraftBuild): string {
  const loadout = resolveBuild(build);
  return isStockBuildId(build.id)
    ? describeHardware(loadout)
    : describeLoadout(loadout);
}

/** How long an aircraft cruises for, in the words a flight is planned in. */
export function formatLoadoutEndurance(loadout: UavLoadout): string {
  return formatEndurance(
    loadout.battery
      ? cruiseEndurance(loadout.config, loadout.motor, loadout.battery)
      : Number.POSITIVE_INFINITY,
  );
}

/**
 * Repairs one saved aircraft loaded from storage.
 *
 * Anything that cannot be read as an aircraft is dropped rather than repaired
 * into one: a build with no name is one nobody can pick out of the list, a
 * build naming an airframe this version of the simulator no longer has is not
 * an aircraft at all, and a build wearing a stock identifier would hide the
 * airframe it names rather than adding an aircraft. What *can* be repaired is repaired — hardware nobody
 * sells any more falls back to what the airframe is delivered with, and every
 * rate is clamped on the way through rather than reaching the flight
 * controller.
 */
export function normaliseBuild(
  raw: unknown,
  taken: readonly string[],
): AircraftBuild | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof AircraftBuild, unknown>>;

  const id = typeof value.id === "string" ? value.id.trim() : "";
  // A stored aircraft claiming a stock identifier would shadow an airframe as
  // delivered, and there would then be no way back to it: the stock builds are
  // derived, so nothing can be saved over one.
  if (!id || isStockBuildId(id) || taken.includes(id)) return null;

  const name =
    typeof value.name === "string" ? normaliseBuildName(value.name) : "";
  if (name.length < MIN_BUILD_NAME_LENGTH) return null;

  const uav = typeof value.uav === "string" ? findUav(value.uav) : null;
  if (!uav) return null;

  const loadout = resolveLoadout(uav, {
    motor: typeof value.motor === "string" ? value.motor : "",
    battery: typeof value.battery === "string" ? value.battery : "",
  });

  return {
    id,
    name,
    uav: uav.id,
    motor: loadout.motor.id,
    battery: loadout.battery ? loadout.battery.id : BATTERY_UNLIMITED,
    rates: normaliseRates(value.rates, uav.defaultRates),
    livery: normaliseLivery(value.livery, uav.defaultLivery),
  };
}

/** Every saved aircraft that can be trusted, from whatever storage held. */
export function normaliseBuilds(raw: unknown): readonly AircraftBuild[] {
  if (!Array.isArray(raw)) return [];
  const builds: AircraftBuild[] = [];
  for (const entry of raw) {
    if (builds.length >= MAX_BUILDS) break;
    const build = normaliseBuild(
      entry,
      builds.map((saved) => saved.id),
    );
    if (build) builds.push(build);
  }
  return builds;
}
