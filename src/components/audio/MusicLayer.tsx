"use client";

/**
 * The music, wired to what the pilot is doing.
 *
 * Mounted above the screen router rather than inside a screen, because that is
 * the point of it: the menu, the globe, the setup screen and the flight are one
 * continuous piece of music, and a station is only changed when the mood is.
 * Nothing here renders — it exists to own the player and to tell it which mood
 * the application is in.
 *
 * It draws one thing, and only when it has to: a prompt when the browser has
 * refused to start audio until somebody clicks. That is the normal state of a
 * page that has just loaded, so the music can be on from the first frame
 * without the pilot having to go and find a play button.
 */

import { useEffect, useRef, useState } from "react";

import { MusicPlayer } from "@/lib/audio/musicPlayer";
import {
  moodFor,
  musicGain,
  musicStation,
  stationsFor,
} from "@/sim/audio/musicDirector";
import { SCREEN, useGameStore } from "@/state/gameStore";
import { usePlayerStore } from "@/state/playerStore";
import { useSettingsStore } from "@/state/settingsStore";

export function MusicLayer() {
  // Settings belong to a pilot and are read from storage after mount. Starting
  // before that would play a station to a pilot who has the music switched off.
  const hydrated = usePlayerStore((state) => state.hydrated);
  const screen = useGameStore((state) => state.screen);
  const ready = useGameStore((state) => state.ready);
  const mode = useGameStore((state) => state.mission?.mode ?? null);

  const audioEnabled = useSettingsStore((state) => state.audioEnabled);
  const musicEnabled = useSettingsStore((state) => state.musicEnabled);
  const musicVolume = useSettingsStore((state) => state.musicVolume);
  const musicStationChoice = useSettingsStore((state) => state.musicStation);

  const playerRef = useRef<MusicPlayer | null>(null);
  const [blocked, setBlocked] = useState(false);

  // The master sound switch outranks the music switch: a pilot who turned the
  // sound off meant all of it.
  const on = hydrated && audioEnabled && musicEnabled;
  const flying = screen === SCREEN.Flying && ready;
  const mood = moodFor({ flying, mode });
  const gain = musicGain(musicVolume);

  useEffect(() => {
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!on) {
      playerRef.current?.stop();
      setBlocked(false);
      return;
    }
    if (!playerRef.current) {
      playerRef.current = MusicPlayer.create(gain, { onBlocked: setBlocked });
    }
    const player = playerRef.current;
    if (!player) return;
    player.setVolume(gain);
    player.tune(stationsFor(mood, musicStationChoice));
  }, [on, mood, musicStationChoice, gain]);

  // The gesture the autoplay policy is waiting for. Any click or key anywhere
  // will do, so the prompt below is a courtesy rather than the only way in.
  useEffect(() => {
    if (!blocked || !on) return;
    const start = (): void => {
      void playerRef.current?.resume();
    };
    window.addEventListener("pointerdown", start);
    window.addEventListener("keydown", start);
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, [blocked, on]);

  if (!blocked || !on) return null;

  const pinned = musicStation(musicStationChoice);

  return (
    <button
      type="button"
      onClick={() => void playerRef.current?.resume()}
      className="absolute bottom-4 right-4 z-50 border border-hairline bg-panel/85 px-3 py-2 text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
    >
      ♪ Start the music
      <span className="ml-2 normal-case tracking-[0.06em] text-osd-faint">
        {pinned ? pinned.name : "browsers wait for a click"}
      </span>
    </button>
  );
}
