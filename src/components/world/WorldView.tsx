"use client";

/**
 * Choosing where to fly, on the world itself.
 *
 * The whole Earth, spun with the mouse and clicked where the flight should
 * start — no list of places somebody else chose. Search finds anywhere by
 * name, or takes a pasted coordinate pair; the marker shows the spot, the
 * height above the ground the aircraft will appear at and, as a needle out of
 * the ring, which way it will be pointing; and the mode is picked here too,
 * because "where, how high and facing where" and "what am I doing there" are
 * the same decision.
 *
 * Everything downstream of the marker — weather, contacts, seed — is still the
 * mission setup screen's, which this hands over to.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { CesiumConfigurationError } from "@/lib/cesium/viewer";
import type { WorldMap, WorldMapPick, WorldSearchResult } from "@/lib/cesium/worldMap";
import { LOCATION_PRESETS } from "@/sim/geo/locations";
import {
  clampSpawnAltitude,
  clampStartHeading,
  compassPoint,
  DEFAULT_START_HEADING_DEG,
  formatCoordinates,
  formatHeading,
  parseCoordinateQuery,
  placeNameForPick,
  SPAWN_ALTITUDE_LIMITS,
  SPAWN_ALTITUDE_PRESETS,
  START_HEADING_PRESETS,
  type NamedPlace,
} from "@/sim/geo/placePicker";
import { SCREEN, useGameStore, type MissionMode } from "@/state/gameStore";
import {
  MISSION_MODES,
  MISSION_MODE_INFO,
  OPEN_MODES,
  startsOnTheGround,
} from "@/sim/mission";
import { useSettingsStore } from "@/state/settingsStore";
import { useIonTokenConfigured } from "@/state/ionTokenStore";
import { ConfigurationError } from "@/components/screens/ConfigurationError";
import { OptionGroup, PrimaryButton, SectionLabel, Slider } from "@/components/ui/Primitives";

// Cesium is browser-only: this is the SSR isolation boundary.
const WorldStage = dynamic(() => import("./WorldStage"), { ssr: false });

/** Said both before the globe is opened and when opening it fails. */
const NO_TOKEN_DETAIL =
  "The world map streams the real Earth from Cesium ion, and this installation has no access token. Without one there is nothing to choose a start point on. Enter one below — it takes a free one-minute sign-up.";

/** How far back the camera sits when jumping to one of the bookmarks. */
const BOOKMARK_VIEW_RANGE = 20000;

interface ChosenPlace {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly terrainHeight: number;
  /** False while the elevation is still the globe's estimate. */
  readonly precise: boolean;
}

export function WorldView() {
  const goto = useGameStore((state) => state.goto);
  const choosePlace = useGameStore((state) => state.choosePlace);
  const pendingPlace = useGameStore((state) => state.pendingPlace);
  const pendingMode = useGameStore((state) => state.pendingMode);
  const graphicsQuality = useSettingsStore((state) => state.graphicsQuality);

  // True until storage has been read, so a pilot who has a token saved is not
  // shown the setup screen for the instant before it loads.
  const tokenConfigured = useIonTokenConfigured();

  // Captured once: the globe is built at mount and must not be rebuilt when
  // the choice on it changes.
  const [initial] = useState(() =>
    pendingPlace
      ? { latitude: pendingPlace.latitude, longitude: pendingPlace.longitude }
      : null,
  );
  const [initialAltitude] = useState(() =>
    clampSpawnAltitude(pendingPlace?.spawnAltitudeAgl ?? SPAWN_ALTITUDE_LIMITS.default),
  );
  const [initialHeading] = useState(() =>
    clampStartHeading(pendingPlace?.startHeadingDeg ?? DEFAULT_START_HEADING_DEG),
  );

  const mapRef = useRef<WorldMap | null>(null);
  // The last place chosen *by name*, so a click near it keeps that name.
  const referenceRef = useRef<NamedPlace | null>(
    pendingPlace
      ? {
          name: pendingPlace.name,
          latitude: pendingPlace.latitude,
          longitude: pendingPlace.longitude,
        }
      : null,
  );

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<{
    title: string;
    detail: string;
    /** Whether entering a token is a plausible fix for this one. */
    tokenSetup: boolean;
  } | null>(null);
  const [stageKey, setStageKey] = useState(0);
  const [place, setPlace] = useState<ChosenPlace | null>(null);
  const [spawnAltitude, setSpawnAltitude] = useState(initialAltitude);
  const [startHeading, setStartHeading] = useState(initialHeading);
  const [mode, setMode] = useState<MissionMode>(pendingMode);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly WorldSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);

  const handleMap = useCallback((map: WorldMap) => {
    mapRef.current = map;
    setReady(true);
  }, []);

  const handlePick = useCallback((pick: WorldMapPick) => {
    setPlace({
      name: placeNameForPick(pick, referenceRef.current),
      latitude: pick.latitude,
      longitude: pick.longitude,
      terrainHeight: pick.terrainHeight,
      precise: pick.precise,
    });
  }, []);

  const handleError = useCallback((raised: unknown) => {
    if (raised instanceof CesiumConfigurationError) {
      setError({
        title:
          raised.kind === "missing-token"
            ? "Cesium ion access token is not configured"
            : raised.kind === "webgl-unavailable"
              ? "WebGL is unavailable"
              : "Cesium ion could not be reached",
        detail:
          raised.kind === "missing-token" ? NO_TOKEN_DETAIL : raised.message,
        tokenSetup: raised.kind !== "webgl-unavailable",
      });
      return;
    }
    setError({
      title: "The world map could not be opened",
      detail: raised instanceof Error ? raised.message : String(raised),
      tokenSetup: false,
    });
    console.error("[fpv] world map failed", raised);
  }, []);

  // The marker's altitude stem follows the control — and collapses onto the
  // ground for a flight that starts there, where there is no height to pick.
  useEffect(() => {
    mapRef.current?.setSpawnAltitude(startsOnTheGround(mode) ? 0 : spawnAltitude);
  }, [spawnAltitude, mode]);

  // And the needle follows the heading control, so the direction is read off
  // the ground the flight starts over rather than off a number.
  useEffect(() => {
    mapRef.current?.setStartHeading(startHeading);
  }, [startHeading]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Escape") goto(SCREEN.Menu);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goto]);

  const jumpTo = useCallback(
    (target: NamedPlace, range?: number) => {
      referenceRef.current = target;
      setResults([]);
      void mapRef.current?.pick(target, { fly: true, range });
    },
    [],
  );

  const runSearch = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    // A pasted coordinate pair is not a question for a geocoder.
    const coordinates = parseCoordinateQuery(trimmed);
    if (coordinates) {
      referenceRef.current = null;
      setResults([]);
      setSearchNote(
        `Coordinates ${formatCoordinates(coordinates.latitude, coordinates.longitude)}`,
      );
      void map.pick(coordinates, { fly: true });
      return;
    }

    setSearching(true);
    setSearchNote(null);
    try {
      const found = await map.search(trimmed);
      setResults(found);
      setSearchNote(found.length === 0 ? `Nothing found for “${trimmed}”` : null);
    } catch (raised: unknown) {
      setResults([]);
      setSearchNote("The ion geocoder could not be reached.");
      console.error("[fpv] geocoder failed", raised);
    } finally {
      setSearching(false);
    }
  }, [query]);

  if (!tokenConfigured || error) {
    return (
      <ConfigurationError
        title={error?.title ?? "Cesium ion access token is not configured"}
        detail={error?.detail ?? NO_TOKEN_DETAIL}
        tokenSetup={error?.tokenSetup ?? true}
        onRetry={() => {
          setError(null);
          setReady(false);
          setStageKey((key) => key + 1);
        }}
      />
    );
  }

  const startAltitudeAmsl = place
    ? Math.round(place.terrainHeight + spawnAltitude)
    : null;
  // A flight flown from the field starts on the field: there is no height to
  // pick, so the controls for one are not shown rather than shown and ignored.
  const fromTheGround = startsOnTheGround(mode);

  return (
    <div className="relative h-full w-full overflow-hidden bg-void">
      <WorldStage
        key={stageKey}
        quality={graphicsQuality}
        initial={initial}
        spawnAltitudeAgl={initialAltitude}
        startHeadingDeg={initialHeading}
        onMap={handleMap}
        onPick={handlePick}
        onError={handleError}
      />

      {!ready ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-void">
          <div className="w-full max-w-md px-8">
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Loading world
            </p>
            <h2 className="mt-2 mb-6 text-2xl font-light tracking-[0.06em]">
              The Earth
            </h2>
            <div className="relative h-px w-full overflow-hidden bg-hairline">
              <div className="absolute inset-y-0 w-1/3 bg-cyan animate-sweep" />
            </div>
          </div>
        </div>
      ) : null}

      {/* Chrome floats over the globe; only the controls take the mouse, so a
          drag anywhere else still spins the world. */}
      <div className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-between p-5">
        <div className="flex items-start justify-between gap-6">
          <div className="pointer-events-auto w-full max-w-sm">
            <div className="flex items-baseline justify-between">
              <p className="text-2xs uppercase tracking-[0.4em] text-accent">
                Choose your start
              </p>
              <button
                type="button"
                onClick={() => goto(SCREEN.Menu)}
                className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
              >
                &larr; Main menu
              </button>
            </div>

            <div className="mt-3 border border-hairline bg-panel/92 backdrop-blur-sm">
              <div className="flex">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runSearch();
                  }}
                  spellCheck={false}
                  placeholder="Search anywhere, or paste coordinates"
                  className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-osd outline-none placeholder:text-osd-faint"
                />
                <button
                  type="button"
                  onClick={() => void runSearch()}
                  disabled={searching || query.trim().length === 0}
                  className="shrink-0 border-l border-hairline px-4 text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:text-cyan disabled:text-osd-faint"
                >
                  {searching ? "…" : "Find"}
                </button>
              </div>

              {results.length > 0 ? (
                <ul className="max-h-64 overflow-y-auto border-t border-hairline">
                  {results.map((result, index) => (
                    <li key={`${result.displayName}-${index}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setQuery(result.name);
                          jumpTo(result, result.viewRange);
                        }}
                        className="block w-full border-b border-hairline/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-cyan/10"
                      >
                        <span className="block text-xs text-osd">
                          {result.displayName || result.name}
                        </span>
                        <span className="mt-0.5 block text-2xs tabular-nums text-osd-faint">
                          {formatCoordinates(result.latitude, result.longitude, 3)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {searchNote ? (
                <p className="border-t border-hairline px-3 py-2 text-2xs text-osd-dim">
                  {searchNote}
                </p>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {LOCATION_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() =>
                    jumpTo(
                      {
                        name: preset.name,
                        latitude: preset.latitude,
                        longitude: preset.longitude,
                      },
                      BOOKMARK_VIEW_RANGE,
                    )
                  }
                  title={preset.description}
                  className="border border-hairline bg-panel/80 px-2.5 py-1 text-2xs uppercase tracking-[0.12em] text-osd-dim backdrop-blur-sm transition-colors hover:border-cyan hover:text-cyan"
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>

          <div className="pointer-events-auto max-h-[88vh] w-full max-w-xs shrink-0 overflow-y-auto border border-hairline bg-panel/92 backdrop-blur-sm">
            <div className="border-b border-hairline px-4 py-3">
              {place ? (
                <>
                  <p className="text-2xs uppercase tracking-[0.18em] text-osd-dim">
                    Start point
                  </p>
                  <h2 className="mt-1 truncate text-lg font-light tracking-[0.04em] text-osd">
                    {place.name}
                  </h2>
                  <p className="mt-1 text-2xs tabular-nums text-osd-faint">
                    {formatCoordinates(place.latitude, place.longitude)}
                  </p>
                  <p className="mt-2 text-2xs tabular-nums text-osd-dim">
                    Ground {Math.round(place.terrainHeight)} m
                    {place.precise ? "" : " (estimated)"} ·{" "}
                    {fromTheGround ? (
                      <>
                        starting <span className="text-cyan">on the ground</span>
                      </>
                    ) : (
                      <>
                        airborne at{" "}
                        <span className="text-cyan">{startAltitudeAmsl} m</span>{" "}
                        AMSL
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-2xs tabular-nums text-osd-dim">
                    Heading{" "}
                    <span className="text-cyan">{formatHeading(startHeading)}</span>
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xs uppercase tracking-[0.18em] text-osd-dim">
                    No start point
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-osd-dim">
                    Drag to spin the world, scroll to zoom, then click the ground
                    anywhere on Earth to put the aircraft there.
                  </p>
                </>
              )}
            </div>

            <div className="px-4 py-4">
              {fromTheGround ? (
                <>
                  <SectionLabel>Start height</SectionLabel>
                  <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
                    None to pick: you are standing at the marker with the
                    aircraft, and nothing goes anywhere until you open the
                    throttle. A wing is held at head height, nose up, and is
                    thrown the moment the motor is running; a quadcopter is put
                    down on the grass and lifts off its own rotors.
                  </p>
                </>
              ) : (
                <>
                  <SectionLabel>Start height · metres AGL</SectionLabel>
                  <OptionGroup
                    columns={5}
                    value={spawnAltitude}
                    onChange={(value) => setSpawnAltitude(clampSpawnAltitude(value))}
                    options={SPAWN_ALTITUDE_PRESETS.map((metres) => ({
                      value: metres as number,
                      label: `${metres}`,
                    }))}
                  />
                  <div className="mt-3">
                    <Slider
                      label="Fine"
                      value={spawnAltitude}
                      min={SPAWN_ALTITUDE_LIMITS.minimum}
                      max={SPAWN_ALTITUDE_LIMITS.maximum}
                      step={10}
                      onChange={(value) =>
                        setSpawnAltitude(clampSpawnAltitude(value))
                      }
                      format={(value) => `${Math.round(value)} m`}
                    />
                  </div>
                  <p className="mt-2 text-2xs text-osd-faint">
                    Height above the real ground at the marker. The aircraft
                    always starts airborne.
                  </p>
                </>
              )}

              <div className="mt-5">
                <SectionLabel>Start heading · degrees</SectionLabel>
                <OptionGroup
                  columns={4}
                  value={startHeading}
                  onChange={(value) => setStartHeading(clampStartHeading(value))}
                  options={START_HEADING_PRESETS.map((degrees) => ({
                    value: degrees as number,
                    label: compassPoint(degrees),
                    hint: `${degrees}°`,
                  }))}
                />
                <div className="mt-3">
                  <Slider
                    label="Fine"
                    value={startHeading}
                    min={0}
                    max={359}
                    step={1}
                    onChange={(value) => setStartHeading(clampStartHeading(value))}
                    format={(value) => formatHeading(value)}
                  />
                </div>
                <p className="mt-2 text-2xs text-osd-faint">
                  {fromTheGround
                    ? "Which way you are facing on the field: the wing is launched out along this heading, away from you."
                    : "Which way the nose is pointing when the flight begins. The needle on the marker shows it."}
                </p>
              </div>

              <div className="mt-5">
                <SectionLabel>Flight type</SectionLabel>
                <OptionGroup
                  columns={2}
                  value={mode}
                  onChange={(value) => setMode(value as MissionMode)}
                  options={[...OPEN_MODES, ...MISSION_MODES].map(
                    (id) => ({
                      value: id as string,
                      label: MISSION_MODE_INFO[id].label,
                      hint: MISSION_MODE_INFO[id].tagline,
                    }),
                  )}
                />
              </div>
            </div>

            <div className="border-t border-hairline p-3">
              <PrimaryButton
                tone="accent"
                disabled={!place}
                onClick={() => {
                  if (!place) return;
                  choosePlace(
                    {
                      name: place.name,
                      latitude: place.latitude,
                      longitude: place.longitude,
                      terrainHeight: place.terrainHeight,
                      spawnAltitudeAgl: spawnAltitude,
                      startHeadingDeg: startHeading,
                    },
                    mode,
                  );
                }}
              >
                <span className="flex items-baseline justify-between">
                  <span>Continue</span>
                  <span className="text-2xs tracking-[0.12em] text-osd-faint">
                    {place
                      ? `${
                          fromTheGround ? "On the ground" : `${spawnAltitude} m AGL`
                        } · ${formatHeading(startHeading)}`
                      : "Pick a spot"}
                  </span>
                </span>
              </PrimaryButton>
            </div>
          </div>
        </div>

        <p className="pointer-events-none text-2xs uppercase tracking-[0.18em] text-osd-faint">
          Drag to rotate · Scroll to zoom · Click to set the start point
        </p>
      </div>
    </div>
  );
}
