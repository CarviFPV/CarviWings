"use client";

/**
 * The radio: one `<audio>` element, pointed at a stream.
 *
 * There is no Web Audio graph here on purpose. The soundscape next door is
 * synthesised and needs one; this is a continuous MP3 stream off the network,
 * and a media element already knows how to buffer one, recover a stutter and
 * keep playing when the tab is in the background. Routing it through a context
 * would buy a gain node and cost the streaming.
 *
 * What the element does not do is decide anything, so this adds the three
 * things a station has to survive: a fade, so a change of mood takes the old
 * station down and brings the new one up rather than cutting mid-bar; a walk
 * down the mirror list when a server will not talk to us; and the autoplay
 * dance, because a browser will not start audio until somebody has clicked
 * something.
 *
 * Which station to play is decided in `sim/audio/musicDirector.ts`.
 */

import type { MusicStation } from "@/sim/audio/musicDirector";
import {
  MUSIC_FADE_SECONDS,
  fadeStep,
  musicProxyUrl,
  musicSources,
  needsMusicProxy,
  parsePlaylist,
  playlistUrl,
} from "@/sim/audio/musicDirector";
import { clamp } from "@/sim/math/scalar";

/** How often the fade advances, milliseconds. Slow: it is a volume ramp. */
const FADE_TICK_MS = 60;

/**
 * How long a stream gets to produce sound before it is written off, ms.
 *
 * Generous, because this is a connection to a shared radio server rather than
 * a file: it can take a couple of seconds to be handed a slot, and giving up
 * early would walk the whole mirror list while every one of them was working.
 */
const START_TIMEOUT_MS = 12000;

/** Wait before an established stream that dropped is picked back up, ms. */
const RECOVER_DELAY_MS = 1500;

export interface MusicPlayerEvents {
  /** The station now actually making sound, or null while there is none. */
  onStation?(station: MusicStation | null): void;
  /**
   * True when the browser refused to start audio without a gesture.
   *
   * The fix is a click anywhere, which the layer above arms a listener for.
   */
  onBlocked?(blocked: boolean): void;
}

export class MusicPlayer {
  private readonly audio: HTMLAudioElement;
  private readonly events: MusicPlayerEvents;

  /** The stations to try for the current mood, best first. */
  private candidates: readonly MusicStation[] = [];
  private candidateIndex = 0;
  /** Every mirror of the station being tried, best first. */
  private sources: readonly string[] = [];
  private sourceIndex = 0;

  private station: MusicStation | null = null;
  private volume: number;
  /** Where the fade is going: the volume, or zero while changing station. */
  private target = 0;
  private level = 0;
  private fadeTimer: number | null = null;
  private startTimer: number | null = null;
  private recoverTimer: number | null = null;
  /** Bumped on every tune, so a slow playlist fetch cannot land on top of a
   *  station chosen after it was asked for. */
  private generation = 0;
  /** Bumped on every mirror tried, so one refusal costs exactly one mirror.
   *  A server that will not have us says so twice — the element fires `error`
   *  and the `play()` it was handed rejects — and both arrive here as news
   *  that the mirror failed. Without this the second one walks past whichever
   *  mirror the first had already moved on to, and half the list is spent
   *  without ever being tried. */
  private attempt = 0;
  private blocked = false;
  private playing = false;
  private destroyed = false;

  private constructor(
    audio: HTMLAudioElement,
    volume: number,
    events: MusicPlayerEvents,
  ) {
    this.audio = audio;
    this.volume = clamp(volume, 0, 1);
    this.events = events;

    audio.preload = "none";
    audio.loop = false;
    audio.volume = 0;

    audio.addEventListener("playing", this.handlePlaying);
    audio.addEventListener("error", this.handleFailure);
    // A live stream has no end: reaching one means the connection dropped.
    audio.addEventListener("ended", this.handleFailure);
  }

  /** Builds a player, or returns null where there is no media element. */
  static create(volume: number, events: MusicPlayerEvents = {}): MusicPlayer | null {
    if (typeof window === "undefined" || typeof Audio === "undefined") {
      return null;
    }
    try {
      return new MusicPlayer(new Audio(), volume, events);
    } catch {
      // No media element, no music. Not worth failing a flight over.
      return null;
    }
  }

  get currentStation(): MusicStation | null {
    return this.station;
  }

  /** True while the browser is waiting for a gesture before it will play. */
  get needsGesture(): boolean {
    return this.blocked;
  }

  /**
   * Plays the first of these stations that will have us.
   *
   * Called with the same list on every render, so the common case — the mood
   * has not changed — has to be free, and is: the list is compared against
   * what is already playing and nothing happens.
   */
  tune(candidates: readonly MusicStation[]): void {
    if (this.destroyed) return;
    if (candidates.length === 0) {
      this.stop();
      return;
    }
    if (this.station && candidates[0]?.id === this.station.id) {
      // Already on the station this mood wants. Keep the rest of the list
      // fresh so a drop falls back through the new mood's channels.
      this.candidates = candidates;
      this.candidateIndex = 0;
      this.fadeTo(this.volume);
      return;
    }
    this.candidates = candidates;
    this.candidateIndex = 0;
    this.generation += 1;
    const generation = this.generation;
    // Whatever the station being left was still waiting for, it is not wanted.
    this.clearStartTimer();
    this.clearRecoverTimer();
    // The station being left goes down before the next one comes up, so a
    // change of mood is a transition rather than a cut mid-bar. Nothing is
    // playing on a first tune, so that one starts straight away.
    this.fadeTo(0, () => {
      if (this.destroyed || generation !== this.generation) return;
      this.release();
      void this.open(candidates[0] as MusicStation, generation);
    });
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (this.destroyed) return;
    if (this.station) this.fadeTo(this.volume);
  }

  /** Fades the music out and lets go of the stream. */
  stop(): void {
    if (this.destroyed) return;
    this.generation += 1;
    this.clearTimers();
    this.candidates = [];
    this.setStation(null);
    this.fadeTo(0, () => this.release());
  }

  /**
   * Tries again after a gesture.
   *
   * Autoplay is refused before the pilot has touched anything, which is most
   * of the time on a first load: the page opens, the music is asked for, and
   * the browser says no. One click later this succeeds.
   */
  async resume(): Promise<void> {
    if (this.destroyed) return;
    if (!this.station) {
      // Nothing is tuned: every mirror was walked and given up on while the
      // browser was refusing to play anyway. A gesture is the best moment
      // there is to start the whole list again.
      if (this.candidates.length > 0) this.tune(this.candidates);
      return;
    }
    await this.start(this.generation);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    this.audio.removeEventListener("playing", this.handlePlaying);
    this.audio.removeEventListener("error", this.handleFailure);
    this.audio.removeEventListener("ended", this.handleFailure);
    this.release();
  }

  // --- Tuning --------------------------------------------------------------

  /**
   * Connects to one station.
   *
   * The mirror list is asked for first, so a server taken out of service stops
   * being connected to as soon as the station says so. The written-down
   * mirrors are appended to whatever comes back, and are the whole list when
   * the fetch fails — which it will, offline or behind a filter, and that is
   * not a reason to be silent.
   */
  private async open(station: MusicStation, generation: number): Promise<void> {
    const playlist = await this.fetchPlaylist(station);
    if (this.destroyed || generation !== this.generation) return;

    this.sources = musicSources(station, playlist);
    this.sourceIndex = 0;
    this.setStation(station);
    await this.start(generation);
  }

  private async fetchPlaylist(
    station: MusicStation,
  ): Promise<readonly string[]> {
    if (typeof fetch !== "function") return [];
    try {
      const response = await fetch(playlistUrl(station), {
        // The list changes when a server is added or drained, not per listener.
        cache: "no-cache",
        redirect: "follow",
      });
      if (!response.ok) return [];
      return parsePlaylist(await response.text());
    } catch {
      return [];
    }
  }

  /**
   * Points the element at the current mirror and asks it to play.
   *
   * Everything from here on is stamped with the tune it belongs to. A station
   * takes seconds to be given up on and the pilot can start a mission in the
   * middle of that, so a timeout armed for the old one must not be allowed to
   * walk the new one's mirror list, or to put the old station back on the air
   * after it has been left.
   *
   * It is stamped with the mirror as well, for the same reason one step down:
   * a mirror is reported failed by two routes at once, and only the first of
   * them should count.
   */
  private async start(generation: number): Promise<void> {
    if (this.destroyed || generation !== this.generation) return;
    const source = this.sources[this.sourceIndex];
    if (!source) return;

    this.clearStartTimer();
    this.playing = false;
    const attempt = (this.attempt += 1);
    this.audio.src = playable(source);
    this.audio.volume = this.level;
    this.audio.load();

    // Sound is only proven by the `playing` event: a server that accepts the
    // connection and then never sends a byte looks exactly like one that is
    // working until this runs out.
    //
    // Armed before the play is asked for rather than after it is granted,
    // because `playing` arrives while that promise is still pending. Armed
    // afterwards, the watchdog is installed behind the event that disarms it
    // and so is never disarmed at all: it fires on a stream that is playing
    // perfectly well and moves the pilot to the next mirror, twelve seconds
    // in, and twelve seconds after that, for as long as the music lasts.
    this.startTimer = window.setTimeout(
      () => this.advance(generation, attempt),
      START_TIMEOUT_MS,
    );

    try {
      await this.audio.play();
      this.setBlocked(false);
    } catch (error) {
      if (isAutoplayRefusal(error)) {
        // Not the stream's fault, so the mirror list is left where it is: the
        // same URL will play the moment a gesture arrives, and the watchdog
        // has nothing to watch until it does.
        if (attempt === this.attempt) this.clearStartTimer();
        this.setBlocked(true);
        return;
      }
      // A play interrupted by the next load is this player changing station,
      // which is not a mirror refusing us either. The timer now standing is
      // the replacement's, so it is left alone.
      if (isInterrupted(error)) return;
      this.advance(generation, attempt);
    }
  }

  /** Moves to the next mirror, then to the next station, then gives up. */
  private advance(generation: number, attempt: number): void {
    if (this.destroyed || generation !== this.generation) return;
    // A mirror that has already been moved on from. This is the second of the
    // two ways the same refusal is reported, and the first one has been acted
    // on: moving on again would skip the mirror now being tried.
    if (attempt !== this.attempt) return;
    // Spend the attempt here rather than leaving it to the next `start`, so
    // that the second report is stale even when there is no next mirror to
    // start — otherwise the end of the list is announced once per route.
    this.attempt += 1;
    this.clearStartTimer();

    if (this.sourceIndex + 1 < this.sources.length) {
      this.sourceIndex += 1;
      void this.start(generation);
      return;
    }

    const next = this.candidates[this.candidateIndex + 1];
    if (next) {
      this.candidateIndex += 1;
      this.generation += 1;
      void this.open(next, this.generation);
      return;
    }

    // Every mirror of every station for this mood refused. Silence is the
    // honest outcome; the flight is not waiting on it.
    console.warn("[fpv] no music stream could be reached");
    this.setStation(null);
    this.release();
  }

  private handlePlaying = (): void => {
    this.clearStartTimer();
    this.playing = true;
    this.setBlocked(false);
    this.fadeTo(this.volume);
  };

  /**
   * A stream that was working stopped.
   *
   * Reconnecting to the same mirror is worth one try — a dropped connection is
   * usually just a dropped connection — before the list is walked. A stream
   * that never started is a mirror that will not have us, and goes straight on.
   */
  private handleFailure = (): void => {
    if (this.destroyed || !this.station) return;
    // A browser that has refused to play also stops loading, which arrives
    // here as the stream having failed. It has not: walking the mirror list
    // over it would spend the pilot's first choice of station on a policy,
    // and the gesture that is coming will play whatever is tuned now.
    if (this.blocked) return;
    const generation = this.generation;
    const attempt = this.attempt;
    if (!this.playing) {
      this.advance(generation, attempt);
      return;
    }
    this.playing = false;
    this.clearRecoverTimer();
    this.recoverTimer = window.setTimeout(() => {
      this.recoverTimer = null;
      void this.start(generation);
    }, RECOVER_DELAY_MS);
  };

  // --- Level ---------------------------------------------------------------

  private fadeTo(target: number, onArrival?: () => void): void {
    this.target = clamp(target, 0, 1);
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
    const dt = FADE_TICK_MS / 1000;
    this.fadeTimer = window.setInterval(() => {
      this.level = fadeStep(this.level, this.target, dt, MUSIC_FADE_SECONDS);
      try {
        this.audio.volume = this.level;
      } catch {
        // A element torn down under us. The interval below stops it.
      }
      if (this.level === this.target) {
        this.clearFadeTimer();
        onArrival?.();
      }
    }, FADE_TICK_MS);
  }

  private setStation(station: MusicStation | null): void {
    if (this.station?.id === station?.id) return;
    this.station = station;
    this.events.onStation?.(station);
  }

  private setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.events.onBlocked?.(blocked);
  }

  /** Lets go of the connection without tearing the element down. */
  private release(): void {
    this.playing = false;
    this.level = 0;
    try {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    } catch {
      // Nothing to let go of.
    }
  }

  private clearTimers(): void {
    this.clearFadeTimer();
    this.clearStartTimer();
    this.clearRecoverTimer();
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer === null) return;
    window.clearInterval(this.fadeTimer);
    this.fadeTimer = null;
  }

  private clearStartTimer(): void {
    if (this.startTimer === null) return;
    window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private clearRecoverTimer(): void {
    if (this.recoverTimer === null) return;
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
  }
}

/**
 * Whether a rejected `play()` was the autoplay policy rather than the stream.
 *
 * Matched by name rather than by class: this rejects with a `DOMException` in
 * every browser that matters, but the name is the part that is specified.
 */
/**
 * The URL to actually point the element at.
 *
 * Normally the mirror itself. A development page served from localhost is
 * refused by every one of them over its `Referer`, though, and cannot stop
 * sending it, so there the request goes through `/api/radio` and is made from
 * the server, which sends no `Referer` at all. That route does not exist in a
 * production build, and no deployed origin has ever needed it.
 */
function playable(source: string): string {
  if (process.env.NODE_ENV === "production") return source;
  if (typeof location === "undefined") return source;
  return needsMusicProxy(location.hostname) ? musicProxyUrl(source) : source;
}

function isAutoplayRefusal(error: unknown): boolean {
  return errorName(error) === "NotAllowedError";
}

/** Whether the play was cut short by the next load rather than by a mirror. */
function isInterrupted(error: unknown): boolean {
  return errorName(error) === "AbortError";
}

function errorName(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}
