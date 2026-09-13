/**
 * What the moment should sound like, and where that music comes from.
 *
 * The same split as the rest of the audio: this is plain arithmetic and a
 * catalogue that runs in Node, and `lib/audio/musicPlayer.ts` is the part that
 * touches a browser API and has no judgement of its own.
 *
 * The music itself is not ours and is not shipped. It is streamed from
 * SomaFM, which is listener-supported internet radio with no account, no key
 * and no SDK behind it: a channel is a plain MP3 stream an `<audio>` element
 * can be pointed straight at, and the playlist that lists the mirrors is one
 * unauthenticated GET. That matters for a project that has to stay open
 * source — there is no proprietary client to embed and no credential to hide,
 * only a URL — and it is why the catalogue below is a handful of channel
 * identifiers rather than a licensed soundtrack.
 *
 * A mood is chosen from what the pilot is doing rather than from the screen
 * they are on: menus and the globe are one thing, a gate course is another,
 * and an interception is the dramatic one.
 */

import type { MissionMode } from "../mission/types";
import { MISSION_MODE } from "../mission/types";
import { clamp } from "../math/scalar";

export const MUSIC_MOOD = {
  /** Menus, the globe, the workbench, the debrief: nothing is being flown. */
  Menu: "MENU",
  /** Free flight — somewhere to be and nothing to do when you get there. */
  Cruise: "CRUISE",
  /** A display or a fly-in: the music a freestyle line gets cut to. */
  Freestyle: "FREESTYLE",
  /** A gate course against the clock. */
  Race: "RACE",
  /** Interception and strike, which are the ones with a charge on the wing. */
  Combat: "COMBAT",
} as const;

export type MusicMood = (typeof MUSIC_MOOD)[keyof typeof MUSIC_MOOD];

export interface MusicStation {
  /**
   * The SomaFM channel identifier.
   *
   * Also what a pinned station is stored as, so it has to stay stable: a
   * channel renamed in the catalogue keeps the pilot's pin, and a channel
   * removed from it falls back to the mood's own choice on the way in.
   */
  readonly id: string;
  readonly name: string;
  /** One line, for the option button in the settings. */
  readonly description: string;
}

/**
 * The channels the simulator offers, and nothing else.
 *
 * SomaFM carries forty-odd; these are the ones that sound like flying
 * something. Adding one is a row here plus a place for it in `MOOD_STATIONS`.
 */
export const MUSIC_STATIONS: readonly MusicStation[] = [
  {
    id: "groovesalad",
    name: "Groove Salad",
    description: "Chilled ambient and downtempo",
  },
  {
    id: "beatblender",
    name: "Beat Blender",
    description: "Deep house and downtempo chill",
  },
  {
    id: "poptron",
    name: "PopTron",
    description: "Electropop and indie dance rock",
  },
  {
    id: "thetrip",
    name: "The Trip",
    description: "Progressive house and trance",
  },
  {
    id: "defcon",
    name: "DEF CON Radio",
    description: "Driving electronic, for going fast",
  },
  {
    id: "secretagent",
    name: "Secret Agent",
    description: "Stylish, mysterious, dangerous",
  },
  {
    id: "missioncontrol",
    name: "Mission Control",
    description: "Ambient electronica for space explorers",
  },
  {
    id: "dronezone",
    name: "Drone Zone",
    description: "Atmospheric textures, minimal beats",
  },
] as const;

/**
 * What each mood plays, best first.
 *
 * More than one because a stream can be down, a mirror can refuse a listener,
 * and a browser can decide it does not like the codec today. The second entry
 * is what the mood sounds like when the first one cannot be reached, not a
 * different mood.
 */
export const MOOD_STATIONS: Readonly<Record<MusicMood, readonly string[]>> = {
  [MUSIC_MOOD.Menu]: ["groovesalad", "dronezone"],
  [MUSIC_MOOD.Cruise]: ["beatblender", "groovesalad"],
  [MUSIC_MOOD.Freestyle]: ["poptron", "thetrip"],
  [MUSIC_MOOD.Race]: ["defcon", "thetrip"],
  [MUSIC_MOOD.Combat]: ["secretagent", "missioncontrol"],
};

/** The pilot has not pinned a station: the mood picks one. */
export const MUSIC_AUTO = "auto";

/** Either `MUSIC_AUTO` or the identifier of a station in the catalogue. */
export type MusicStationChoice = string;

export function musicStation(id: string): MusicStation | null {
  return MUSIC_STATIONS.find((station) => station.id === id) ?? null;
}

export function isMusicStationId(value: unknown): value is string {
  return typeof value === "string" && musicStation(value) !== null;
}

export function isMusicStationChoice(
  value: unknown,
): value is MusicStationChoice {
  return value === MUSIC_AUTO || isMusicStationId(value);
}

/** What the pilot is doing, which is all the mood is decided from. */
export interface MusicScene {
  /** True only while a flight is actually running, not while it loads. */
  readonly flying: boolean;
  /** The mission being flown, or null anywhere that is not a flight. */
  readonly mode: MissionMode | null;
}

export function moodFor(scene: MusicScene): MusicMood {
  if (!scene.flying || scene.mode === null) return MUSIC_MOOD.Menu;
  switch (scene.mode) {
    case MISSION_MODE.Intercept:
    case MISSION_MODE.Strike:
      return MUSIC_MOOD.Combat;
    case MISSION_MODE.Race:
      return MUSIC_MOOD.Race;
    case MISSION_MODE.Formation:
    case MISSION_MODE.Festival:
      return MUSIC_MOOD.Freestyle;
    case MISSION_MODE.FreeFlight:
    case MISSION_MODE.GroundView:
      return MUSIC_MOOD.Cruise;
  }
}

/**
 * The stations to try for a mood, best first.
 *
 * A pinned station goes to the front rather than replacing the list: a pin is
 * what the pilot wants to hear, and the mood's own channels are what they get
 * instead of silence when it cannot be reached.
 */
export function stationsFor(
  mood: MusicMood,
  choice: MusicStationChoice = MUSIC_AUTO,
): readonly MusicStation[] {
  const wanted = isMusicStationId(choice) ? [choice] : [];
  const ordered = [...wanted, ...MOOD_STATIONS[mood]];
  const seen = new Set<string>();
  const stations: MusicStation[] = [];
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    const station = musicStation(id);
    if (station) stations.push(station);
  }
  return stations;
}

/** Where the mirror list for a channel is published. No key, no account. */
export const MUSIC_PLAYLIST_BASE = "https://api.somafm.com";

/**
 * The mirrors, as a last resort.
 *
 * Normally the playlist above is fetched and the servers it names are used,
 * which is how a mirror taken out of service stops being asked for. These are
 * the same servers written down, so a browser that cannot fetch the playlist —
 * offline, blocked, or behind something that dislikes cross-origin requests —
 * still has somewhere to connect to.
 */
export const MUSIC_MIRRORS: readonly string[] = [
  "ice1.somafm.com",
  "ice2.somafm.com",
  "ice4.somafm.com",
  "ice6.somafm.com",
];

/** 128 kbit MP3: understood by every browser, and small enough to stream. */
export const MUSIC_STREAM_SUFFIX = "-128-mp3";

export function playlistUrl(station: MusicStation): string {
  return `${MUSIC_PLAYLIST_BASE}/${station.id}.pls`;
}

export function mirrorUrls(station: MusicStation): readonly string[] {
  return MUSIC_MIRRORS.map(
    (host) => `https://${host}/${station.id}${MUSIC_STREAM_SUFFIX}`,
  );
}

/**
 * The stream URLs out of a playlist.
 *
 * Handles both of the two formats a radio station publishes: the `.pls` INI
 * with numbered `File` keys, and plain `.m3u`, which is one URL per line with
 * `#` comments. Anything that is not an absolute HTTP URL is dropped rather
 * than trusted — this is a document fetched off the network, and a `file:` or
 * `javascript:` entry in it has no business reaching an element.
 */
export function parsePlaylist(text: string): readonly string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const entry = /^file\d*\s*=\s*(.+)$/i.exec(line);
    const candidate = (entry?.[1] ?? line).trim();
    if (!/^https?:\/\/\S+$/i.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    urls.push(candidate);
  }
  return urls;
}

/**
 * Everywhere a station can be listened to, in the order to try them.
 *
 * What the playlist says first, because that is the live list, then the
 * written-down mirrors for anything it did not mention.
 */
export function musicSources(
  station: MusicStation,
  playlist: readonly string[] = [],
): readonly string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const url of [...playlist, ...mirrorUrls(station)]) {
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push(url);
  }
  return sources;
}

/**
 * Whether a page served from this hostname will be refused by the stream
 * servers.
 *
 * SomaFM answers 403 to any request whose `Referer` names localhost, and a
 * media element sends the page's origin as its `Referer` and cannot be told
 * not to. So a development page on `localhost` is turned away by every mirror
 * of every station, while the same page on `127.0.0.1`, on a LAN address or
 * on a deployed origin is served normally. The match is the servers' own: a
 * plain substring, which is why `mylocalhost.com` is refused too.
 */
export function needsMusicProxy(hostname: string): boolean {
  return hostname.toLowerCase().includes("localhost");
}

/** Where the development-only proxy route lives. */
export const MUSIC_PROXY_PATH = "/api/radio";

/** One mirror, asked for through the proxy instead of directly. */
export function musicProxyUrl(source: string): string {
  return `${MUSIC_PROXY_PATH}?src=${encodeURIComponent(source)}`;
}

/**
 * Whether a URL is one of the mirrors this project streams from.
 *
 * The proxy hands what it is given straight to the network, so this is the
 * gate that stops it being a way to fetch anything at all: the host has to be
 * one of the station's own servers and the path has to name a channel in the
 * catalogue, at the bitrate we ask for and with nothing else attached.
 */
export function isMusicStreamUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (url.search.length > 0 || url.hash.length > 0) return false;
  if (!/^ice\d+\.somafm\.com$/.test(url.hostname)) return false;
  return MUSIC_STATIONS.some(
    (station) => url.pathname === `/${station.id}${MUSIC_STREAM_SUFFIX}`,
  );
}

/** How long a change of station takes to fade, seconds. */
export const MUSIC_FADE_SECONDS = 1.6;

/**
 * One step of a fade.
 *
 * Linear rather than exponential: a fade this long is a cut being covered up,
 * not a level being matched, and the arithmetic has to land exactly on the
 * target so a fade-out can be told it has finished.
 */
export function fadeStep(
  current: number,
  target: number,
  dt: number,
  seconds: number = MUSIC_FADE_SECONDS,
): number {
  const clamped = clamp(current, 0, 1);
  const wanted = clamp(target, 0, 1);
  if (seconds <= 0 || dt <= 0) return wanted;
  const step = dt / seconds;
  const delta = wanted - clamped;
  if (Math.abs(delta) <= step) return wanted;
  return clamp(clamped + Math.sign(delta) * step, 0, 1);
}

/**
 * The level the music actually plays at.
 *
 * Music sits under the aircraft: it is a soundtrack, and a soundtrack that
 * covers the motor has taken away the one instrument a wing has. Full on the
 * slider is two thirds of the way up, which is loud enough to be the thing you
 * are listening to and quiet enough that a stall still announces itself.
 */
export const MUSIC_HEADROOM = 0.66;

export function musicGain(volume: number, enabled = true): number {
  if (!enabled) return 0;
  return clamp(volume, 0, 1) * MUSIC_HEADROOM;
}
