import { assert, assertClose, suite } from "./harness";
import {
  MOOD_STATIONS,
  MUSIC_AUTO,
  MUSIC_FADE_SECONDS,
  MUSIC_MIRRORS,
  MUSIC_MOOD,
  MUSIC_STATIONS,
  fadeStep,
  isMusicStationChoice,
  isMusicStreamUrl,
  mirrorUrls,
  musicProxyUrl,
  needsMusicProxy,
  moodFor,
  musicGain,
  musicSources,
  musicStation,
  parsePlaylist,
  playlistUrl,
  stationsFor,
} from "../audio/musicDirector";
import type { MusicMood } from "../audio/musicDirector";
import { MISSION_MODE } from "../mission/types";

export function runMusicTests(): void {
  suite("the mission decides the music", () => {
    assert(
      moodFor({ flying: false, mode: null }) === MUSIC_MOOD.Menu,
      "the menus get the menu mood",
    );
    assert(
      moodFor({ flying: false, mode: MISSION_MODE.Race }) === MUSIC_MOOD.Menu,
      "and so does a race that has been set up but not launched",
    );
    assert(
      moodFor({ flying: true, mode: MISSION_MODE.FreeFlight }) ===
        MUSIC_MOOD.Cruise,
      "a free flight cruises",
    );
    assert(
      moodFor({ flying: true, mode: MISSION_MODE.Intercept }) ===
        MUSIC_MOOD.Combat &&
        moodFor({ flying: true, mode: MISSION_MODE.Strike }) ===
          MUSIC_MOOD.Combat,
      "the two missions with a charge on the wing get the dramatic one",
    );
    assert(
      moodFor({ flying: true, mode: MISSION_MODE.Race }) === MUSIC_MOOD.Race,
      "a gate course gets its own",
    );
    assert(
      moodFor({ flying: true, mode: MISSION_MODE.Formation }) ===
        MUSIC_MOOD.Freestyle &&
        moodFor({ flying: true, mode: MISSION_MODE.Festival }) ===
          MUSIC_MOOD.Freestyle,
      "a display and a fly-in are both flown to the freestyle mood",
    );

    let everyModeMapped = true;
    for (const mode of Object.values(MISSION_MODE)) {
      const mood = moodFor({ flying: true, mode });
      if (!(mood in MOOD_STATIONS)) everyModeMapped = false;
    }
    assert(everyModeMapped, "and every mission mode lands on a mood that plays");
  });

  suite("every mood has somewhere to play from", () => {
    let complete = true;
    let hasFallback = true;
    for (const mood of Object.values(MUSIC_MOOD) as MusicMood[]) {
      const ids = MOOD_STATIONS[mood];
      if (ids.length < 2) hasFallback = false;
      for (const id of ids) {
        if (musicStation(id) === null) complete = false;
      }
    }
    assert(complete, "every station a mood names is in the catalogue");
    assert(hasFallback, "and every mood has a second choice when one is down");

    const ids = new Set(MUSIC_STATIONS.map((station) => station.id));
    assert(
      ids.size === MUSIC_STATIONS.length,
      "the catalogue has no duplicate channels",
    );
  });

  suite("a pinned station wins, and still falls back", () => {
    const auto = stationsFor(MUSIC_MOOD.Race);
    assert(
      auto[0]?.id === MOOD_STATIONS[MUSIC_MOOD.Race][0],
      "auto plays the mood's own first choice",
    );

    const pinned = stationsFor(MUSIC_MOOD.Race, "dronezone");
    assert(pinned[0]?.id === "dronezone", "a pinned station is tried first");
    assert(
      pinned.length === auto.length + 1,
      "and the mood's channels stay behind it as fallbacks",
    );

    const pinnedToMoodChannel = stationsFor(MUSIC_MOOD.Race, "defcon");
    assert(
      pinnedToMoodChannel.filter((station) => station.id === "defcon")
        .length === 1,
      "pinning a station the mood already plays does not list it twice",
    );

    assert(
      stationsFor(MUSIC_MOOD.Menu, "not-a-channel")[0]?.id ===
        MOOD_STATIONS[MUSIC_MOOD.Menu][0],
      "a pin naming a channel that no longer exists is ignored",
    );

    assert(
      isMusicStationChoice(MUSIC_AUTO) &&
        isMusicStationChoice("groovesalad") &&
        !isMusicStationChoice("scanner") &&
        !isMusicStationChoice(7),
      "only auto and a catalogue channel are storable choices",
    );
  });

  suite("stream addresses are absolute and plural", () => {
    const station = MUSIC_STATIONS[0];
    if (!station) throw new Error("the catalogue is empty");

    const mirrors = mirrorUrls(station);
    assert(
      mirrors.length === MUSIC_MIRRORS.length,
      "there is one built-in address per mirror",
    );
    assert(
      mirrors.every((url) => url.startsWith("https://")),
      "every one of them is https",
    );
    assert(
      mirrors.every((url) => url.includes(station.id)),
      "and every one of them names the channel",
    );
    assert(
      new Set(mirrors).size === mirrors.length,
      "with no address listed twice",
    );
    assert(
      playlistUrl(station) === `https://api.somafm.com/${station.id}.pls`,
      "the playlist is one unauthenticated GET",
    );
  });

  suite("a playlist is read, and not trusted", () => {
    const pls = [
      "[playlist]",
      "numberofentries=2",
      "File1=https://ice6.somafm.com/defcon-128-mp3",
      "Title1=SomaFM: DEF CON Radio",
      "Length1=-1",
      "File2=https://ice2.somafm.com/defcon-128-mp3",
      "Version=2",
    ].join("\r\n");
    const parsed = parsePlaylist(pls);
    assert(
      parsed.length === 2 &&
        parsed[0] === "https://ice6.somafm.com/defcon-128-mp3" &&
        parsed[1] === "https://ice2.somafm.com/defcon-128-mp3",
      "a .pls yields its streams in the order it lists them",
    );

    const m3u = [
      "#EXTM3U",
      "# a comment",
      "http://ice4.somafm.com/groovesalad-128-mp3",
      "",
      "http://ice4.somafm.com/groovesalad-128-mp3",
    ].join("\n");
    const fromM3u = parsePlaylist(m3u);
    assert(
      fromM3u.length === 1 &&
        fromM3u[0] === "http://ice4.somafm.com/groovesalad-128-mp3",
      "an .m3u is read too, and a repeated line is listed once",
    );

    const hostile = [
      "File1=javascript:alert(1)",
      "File2=file:///etc/passwd",
      "File3=/relative/stream",
      "Title1=https://example.com/not-a-file-key",
      "File4=https://ice1.somafm.com/lush-128-mp3",
    ].join("\n");
    const safe = parsePlaylist(hostile);
    assert(
      safe.length === 1 && safe[0] === "https://ice1.somafm.com/lush-128-mp3",
      "and nothing that is not an absolute http address survives",
    );

    assert(parsePlaylist("").length === 0, "an empty playlist yields nothing");
  });

  suite("the live list is tried before the written-down one", () => {
    const station = musicStation("defcon");
    if (!station) throw new Error("defcon is missing from the catalogue");

    const live = ["https://ice6.somafm.com/defcon-256-mp3"];
    const sources = musicSources(station, live);
    assert(sources[0] === live[0], "what the station said comes first");
    assert(
      sources.length === live.length + MUSIC_MIRRORS.length,
      "with every built-in mirror behind it",
    );
    assert(
      new Set(sources).size === sources.length,
      "and an address named by both is only tried once",
    );
    assert(
      musicSources(station).length === MUSIC_MIRRORS.length,
      "a playlist that could not be fetched leaves the mirrors to play",
    );
  });

  suite("a fade lands exactly, and never overshoots", () => {
    const dt = 0.06;
    let level = 0;
    let steps = 0;
    let overshot = false;
    let regressed = false;
    while (level < 1 && steps < 1000) {
      const next = fadeStep(level, 1, dt);
      if (next > 1) overshot = true;
      if (next < level) regressed = true;
      level = next;
      steps += 1;
    }
    assert(level === 1, "a fade up arrives on the target exactly");
    assert(!overshot && !regressed, "climbing the whole way and no further");
    assertClose(
      steps * dt,
      MUSIC_FADE_SECONDS,
      dt * 2,
      "and it takes the fade time to get there",
    );

    let down = 1;
    for (let i = 0; i < 1000 && down > 0; i += 1) {
      down = fadeStep(down, 0, dt);
    }
    assert(down === 0, "a fade out reaches silence, not almost-silence");
    assert(
      fadeStep(0.4, 1, 0) === 1 && fadeStep(0.4, 1, dt, 0) === 1,
      "and a fade with no time in it is a cut",
    );
    assert(
      fadeStep(2, 5, dt) === 1 && fadeStep(-1, -1, dt) === 0,
      "levels outside the range are clamped rather than played",
    );
  });

  suite("a localhost page has to ask through the proxy", () => {
    assert(
      needsMusicProxy("localhost") && needsMusicProxy("LocalHost"),
      "the servers refuse a localhost referer whatever its case",
    );
    assert(
      !needsMusicProxy("127.0.0.1") &&
        !needsMusicProxy("192.168.1.20") &&
        !needsMusicProxy("carviwings.example"),
      "and nothing else is refused, so nothing else is proxied",
    );
    assert(
      needsMusicProxy("mylocalhost.com"),
      "the match is the servers' own: a substring, not a hostname",
    );

    const mirror = "https://ice2.somafm.com/groovesalad-128-mp3";
    assert(
      musicProxyUrl(mirror) === `/api/radio?src=${encodeURIComponent(mirror)}`,
      "a proxied mirror is the same mirror, asked for from our own origin",
    );
    assert(
      musicProxyUrl(mirror).startsWith("/"),
      "and it is same-origin, so it carries no cross-site referer either",
    );
  });

  suite("the proxy only fetches the stations we play", () => {
    for (const station of MUSIC_STATIONS) {
      for (const url of mirrorUrls(station)) {
        assert(
          isMusicStreamUrl(url),
          `every written-down mirror of ${station.id} is allowed through`,
        );
      }
    }
    assert(
      isMusicStreamUrl("https://ice5.somafm.com/groovesalad-128-mp3"),
      "and so is a server only the live playlist knows about",
    );

    const refused: readonly string[] = [
      "http://ice2.somafm.com/groovesalad-128-mp3",
      "https://ice2.somafm.com.evil.test/groovesalad-128-mp3",
      "https://evil.test/groovesalad-128-mp3",
      "https://ice2.somafm.com/../secret",
      "https://ice2.somafm.com/groovesalad-128-mp3?redirect=evil.test",
      "https://ice2.somafm.com/notachannel-128-mp3",
      "https://user:pass@ice2.somafm.com/groovesalad-128-mp3",
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data/",
      "not a url at all",
      "",
    ];
    let allRefused = true;
    for (const url of refused) {
      if (isMusicStreamUrl(url)) allRefused = false;
    }
    assert(
      allRefused,
      "and anything that is not one of them is not fetched on request",
    );
  });

  suite("music sits under the aircraft", () => {
    assert(musicGain(1) < 1, "full on the slider is not full scale");
    assert(
      musicGain(0.5) < musicGain(1) && musicGain(0) === 0,
      "and the slider still moves the level, all the way to silence",
    );
    assert(musicGain(1, false) === 0, "switched off is silent whatever the slider says");
    assert(
      musicGain(4) === musicGain(1) && musicGain(-2) === 0,
      "a level out of range is clamped",
    );
  });
}
