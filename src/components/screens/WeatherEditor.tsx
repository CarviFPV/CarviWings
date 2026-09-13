"use client";

/**
 * The weather panel.
 *
 * One editor, used twice: on the setup screen before the flight and in the
 * pause menu during it. Both hand it the sky and take back a new one, so the
 * weather is described in exactly the same way whichever side of take-off the
 * pilot is on.
 *
 * There are four ways to say what the weather is, and the pilot picks between
 * them at the top:
 *
 *   - **Live** — the current report from the nearest real aerodrome, fetched
 *     as soon as the panel opens on it.
 *   - **METAR** — a report typed in, decoded and flown.
 *   - **Custom** — decks, visibility, precipitation and layered wind, built by
 *     hand the way a flight simulator's weather page works.
 *   - **Random** — a plausible day drawn from the mission seed.
 *
 * All four produce the same thing, a `WeatherState`, and any of them can be
 * switched to *Custom* and edited afterwards — which is the point of fetching
 * a real report and then deciding it needs a thunderstorm in it.
 *
 * Live is where a pilot who has never touched the panel starts, and after that
 * it opens on whichever of the four they last chose. There is no preset list:
 * the presets are still the vocabulary all of this is written in, and every
 * sky is still filed under the one it most resembles for the logbook, but they
 * are no longer a way of picking a day.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MenuColumns,
  NumberField,
  OptionGroup,
  PrimaryButton,
  SectionLabel,
  Slider,
  TextField,
  Toggle,
} from "@/components/ui/Primitives";
import type {
  CloudLayer,
  CloudType,
  WeatherSourceChoice,
  WeatherState,
  WindLayer,
} from "@/sim/environment/types";
import {
  CLOUD_AMOUNTS,
  CLOUD_AMOUNT_INFO,
  CLOUD_TYPE,
  CLOUD_TYPES,
  CLOUD_TYPE_INFO,
  MAX_CLOUD_BASE,
  MAX_CLOUD_LAYERS,
  MAX_WIND_LAYERS,
  MIN_CLOUD_BASE,
  PRECIPITATION,
  UNLIMITED_VISIBILITY,
  WEATHER,
  WEATHER_SOURCE,
  WEATHER_SOURCE_CHOICES,
  WIND_REFERENCE_HEIGHT,
  clampLayers,
  defaultLayer,
  describeWeather,
  isWeatherSourceChoice,
  layerTop,
  nearestPreset,
  normalizeWindLayers,
  weatherStateFromPreset,
} from "@/sim/environment/types";
import { SkyProfileView } from "./SkyProfile";
import { formatMetar, weatherStateFromRawMetar } from "@/sim/environment/metar";
import { generateWeather } from "@/sim/environment/generator";
import { fetchLiveWeather } from "@/lib/weather/nearestMetar";
import { useSettingsStore } from "@/state/settingsStore";

/** How the pilot is describing the weather right now. */
type Mode = WeatherSourceChoice;

const MODE = WEATHER_SOURCE;

const MODE_LABELS: Readonly<Record<Mode, { label: string; hint: string }>> = {
  [MODE.Live]: { label: "Live", hint: "Nearest field" },
  [MODE.Metar]: { label: "METAR", hint: "Type a report" },
  [MODE.Custom]: { label: "Custom", hint: "Build it" },
  [MODE.Random]: { label: "Random", hint: "From the seed" },
};

/**
 * The sky a panel opens on, for a pilot who has not built one yet.
 *
 * Every source but *Random* starts from the same clear day and is then said
 * again in its own terms: *Live* and *METAR* replace it wholesale the moment a
 * report is read, and *Custom* is somewhere to start editing from. A day is
 * never left undescribed, because the layer viewer draws whatever is being
 * flown and there is always something being flown.
 */
export function initialSky(
  source: Mode,
  args: { readonly seed: string; readonly latitude: number },
): WeatherState {
  return source === MODE.Random
    ? generateWeather(args.seed, { latitude: args.latitude })
    : describedAs(weatherStateFromPreset(WEATHER.Clear), source);
}

/** The same sky, said in the terms of another source. */
function describedAs(sky: WeatherState, source: Mode): WeatherState {
  switch (source) {
    case MODE.Custom:
      // Whatever is on screen becomes the starting point, so switching to
      // Custom never throws away the report just fetched — it opens it up for
      // editing.
      return {
        ...sky,
        source: MODE.Custom,
        label: "Custom",
        description: "Built by hand.",
        metar: null,
      };
    case MODE.Metar:
      // The report comes across: a day fetched from a real field and then
      // switched to METAR is one the pilot wants to read and edit, and the
      // pane opens with it already in the box.
      return {
        ...sky,
        source: MODE.Metar,
        label: "METAR",
        description: "Decoded from a typed report.",
      };
    case MODE.Live:
      return {
        ...sky,
        source: MODE.Live,
        label: "Live weather",
        description: "Not fetched yet.",
        // Dropped rather than carried: a report from somewhere else is not
        // this field's, and its presence is what says one has been fetched.
        metar: null,
      };
    case MODE.Random:
      return sky;
  }
}

/**
 * Which of the four the panel is showing for a given sky.
 *
 * A sky filed under a source the panel no longer offers — a preset, from a
 * mission configured before this panel did — is opened as *Custom*, which is
 * what building on it amounts to.
 */
function modeOf(sky: WeatherState): Mode {
  return isWeatherSourceChoice(sky.source) ? sky.source : MODE.Custom;
}

export interface WeatherEditorProps {
  /** The sky being flown, whichever of the four described it. */
  readonly sky: WeatherState;
  /** Where the flight starts, for fetching the real weather. */
  readonly latitude: number;
  readonly longitude: number;
  readonly terrainHeight: number | null;
  /** Seeds the random weather, so the same mission gets the same day. */
  readonly seed: string;
  readonly onSky: (sky: WeatherState) => void;
  /**
   * How many across the option groups aim for — four on the pause panel, six
   * on the setup screen. It is an aim rather than a rule: a group narrows to
   * fewer columns by itself before a label would have to break.
   */
  readonly columns?: number;
}

export function WeatherEditor({
  sky,
  latitude,
  longitude,
  terrainHeight,
  seed,
  onSky,
  columns = 3,
}: WeatherEditorProps) {
  // The choice outlives the mission: a pilot who flies the real weather gets
  // the real weather on the next setup screen without asking for it again.
  const rememberSource = useSettingsStore((state) => state.set);
  const mode = modeOf(sky);

  const chooseMode = (next: Mode): void => {
    rememberSource("weatherSource", next);
    if (next === mode) return;
    onSky(
      next === MODE.Random
        ? generateWeather(seed, { latitude })
        : describedAs(sky, next),
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <SectionLabel>Weather source</SectionLabel>
        <OptionGroup
          columns={Math.min(columns + 1, 4)}
          value={mode}
          onChange={chooseMode}
          options={WEATHER_SOURCE_CHOICES.map((id) => ({
            value: id,
            label: MODE_LABELS[id].label,
            hint: MODE_LABELS[id].hint,
          }))}
        />
      </div>

      {/* Controls on the left, the sky they describe on the right. The viewer
          sticks to the top of its column, because the layer being edited is
          usually below the fold on the setup screen and a picture you have to
          scroll away from the slider to see is a picture nobody looks at. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-5">
          {mode === MODE.Live ? (
            <LivePane
              sky={sky}
              latitude={latitude}
              longitude={longitude}
              terrainHeight={terrainHeight}
              onSky={onSky}
            />
          ) : null}

          {mode === MODE.Metar ? (
            <MetarPane sky={sky} terrainHeight={terrainHeight} onSky={onSky} />
          ) : null}

          {mode === MODE.Custom ? (
            <CustomPane
              sky={sky}
              columns={columns}
              terrainHeight={terrainHeight}
              onSky={onSky}
            />
          ) : null}

          {mode === MODE.Random ? (
            <RandomPane sky={sky} latitude={latitude} seed={seed} onSky={onSky} />
          ) : null}

          <SkySummary sky={sky} />
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <SkyProfileView sky={sky} terrainHeight={terrainHeight} />
        </div>
      </div>
    </div>
  );
}

// --- METAR ------------------------------------------------------------------

const EXAMPLE_METAR = "METAR LSZH 121620Z 25012G24KT 9999 -SHRA FEW018 SCT030CB BKN070 17/13 Q1009";

function MetarPane({
  sky,
  terrainHeight,
  onSky,
}: {
  sky: WeatherState;
  terrainHeight: number | null;
  onSky: (sky: WeatherState) => void;
}) {
  const [text, setText] = useState<string>(sky.metar ?? "");
  const [error, setError] = useState<string | null>(null);
  // Cloud in a report is quoted above the *aerodrome that reported it*, and a
  // typed report carries a four-letter code rather than an elevation. So the
  // elevation is asked for. Null means it has not been touched, in which case
  // it follows the ground under the mission — the report is read as being for
  // this field, which is the assumption that used to be silent and
  // unchangeable. The ground can arrive after the panel is on screen, which is
  // why this is untouched-or-a-number rather than a number seeded once.
  const [typedElevation, setTypedElevation] = useState<string | null>(null);

  const ground = terrainHeight;
  const typed = typedElevation === null ? null : Number(typedElevation);
  // Positive when the flight starts above the reporting field, which is what
  // pushes the reported bases down — possibly below the launch point.
  const offset =
    ground !== null && typed !== null && Number.isFinite(typed)
      ? ground - typed
      : 0;

  const decode = (raw: string, shift = offset): void => {
    const decoded = weatherStateFromRawMetar(raw, {
      stationElevationOffset: shift,
    });
    if (!decoded) {
      setError("Nothing in that could be read as a report.");
      return;
    }
    setError(null);
    onSky(decoded);
  };

  return (
    <section className="space-y-3">
      <SectionLabel>Report</SectionLabel>
      <TextField
        label="METAR"
        value={text}
        rows={3}
        mono
        invalid={error !== null}
        placeholder={EXAMPLE_METAR}
        onChange={(value) => {
          setText(value);
          setError(null);
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <PrimaryButton tone="accent" onClick={() => decode(text)}>
          Decode
        </PrimaryButton>
        <PrimaryButton
          onClick={() => {
            setText(EXAMPLE_METAR);
            decode(EXAMPLE_METAR);
          }}
        >
          Example
        </PrimaryButton>
      </div>
      {error ? <p className="text-2xs text-danger">{error}</p> : null}

      {ground === null ? null : (
        <NumberField
          label="Reporting field elevation"
          value={typedElevation ?? String(Math.round(ground))}
          step={10}
          suffix="m AMSL"
          onChange={(value) => {
            setTypedElevation(value);
            const parsed = Number(value);
            if (text.trim() !== "" && Number.isFinite(parsed)) {
              decode(text, ground - parsed);
            }
          }}
        />
      )}
      <p className="text-2xs leading-relaxed text-osd-faint">
        Wind, visibility, weather groups, cloud layers, temperature and QNH are
        all read. Runway state, trends and remarks are ignored.{" "}
        {ground === null ? (
          <>
            Cloud bases are quoted above the aerodrome that reported them.
            There is no ground elevation to compare that against from here, so
            they are flown exactly as the report reads them.
          </>
        ) : offset === 0 ? (
          <>
            Cloud bases are quoted above that field. Set it to the aerodrome
            the report actually came from and the decks move with it — a field
            below this one puts its cloud under the launch point, which is
            where you would be looking down on it from.
          </>
        ) : (
          <>
            Bases are quoted above that field, and this flight starts at{" "}
            {Math.round(ground)} m, so every deck is drawn{" "}
            {Math.abs(Math.round(offset))} m{" "}
            {offset > 0 ? "lower" : "higher"} than the report reads it.
            {offset > 0
              ? " Anything reported below that difference sits under the launch point."
              : ""}
          </>
        )}
      </p>
    </section>
  );
}

// --- Live -------------------------------------------------------------------

function LivePane({
  sky,
  latitude,
  longitude,
  terrainHeight,
  onSky,
}: {
  sky: WeatherState;
  latitude: number;
  longitude: number;
  terrainHeight: number | null;
  onSky: (sky: WeatherState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const fetchNow = async (): Promise<void> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const live = await fetchLiveWeather(
        latitude,
        longitude,
        terrainHeight,
        controller.signal,
      );
      onSky(live.state);
      setFetchedAt(live.report.observedAt);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "The weather could not be fetched.",
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  // Live is where the panel opens unless the pilot has said otherwise, so the
  // nearest report is fetched without being asked for. Once, when the pane
  // appears with nothing in it: a station that could not be reached will not be
  // reached by re-rendering, and a report already fetched — or edited, or
  // typed — is never overwritten from under the pilot. Empty deps for that
  // reason: this is the opening fetch, not a subscription to the start point.
  useEffect(() => {
    if (sky.metar === null) void fetchNow();
  }, []);

  return (
    <section className="space-y-3">
      <SectionLabel>Live weather</SectionLabel>
      <PrimaryButton tone="accent" disabled={busy} onClick={() => void fetchNow()}>
        {busy
          ? "Fetching..."
          : sky.metar
            ? "Fetch again"
            : "Fetch nearest report"}
      </PrimaryButton>
      {error ? <p className="text-2xs text-danger">{error}</p> : null}
      {sky.metar ? (
        <p className="border border-hairline bg-void px-3 py-2 font-mono text-2xs leading-relaxed text-osd-dim">
          {sky.metar}
        </p>
      ) : null}
      <p className="text-2xs leading-relaxed text-osd-faint">
        {sky.metar
          ? `${sky.label}${fetchedAt ? ` · observed ${fetchedAt.replace("T", " ").slice(0, 16)}Z` : ""}. Bases are reported above the station and shifted onto the ground under the mission — a field lower than the launch point puts its deck below you, and that is where it is drawn.`
          : "Pulls the current aerodrome report nearest the start point from NOAA's Aviation Weather Center and flies exactly what it says."}
      </p>
    </section>
  );
}

// --- Random -----------------------------------------------------------------

function RandomPane({
  sky,
  latitude,
  seed,
  onSky,
}: {
  sky: WeatherState;
  latitude: number;
  seed: string;
  onSky: (sky: WeatherState) => void;
}) {
  const [roll, setRoll] = useState(0);

  return (
    <section className="space-y-3">
      <SectionLabel>Generated</SectionLabel>
      <p className="text-sm text-osd">{sky.label}</p>
      <p className="text-2xs leading-relaxed text-osd-faint">
        {sky.description}
      </p>
      <PrimaryButton
        onClick={() => {
          const next = roll + 1;
          setRoll(next);
          onSky(generateWeather(`${seed}:${next}`, { latitude }));
        }}
      >
        Roll another day
      </PrimaryButton>
      <p className="text-2xs leading-relaxed text-osd-faint">
        Drawn from the mission seed, so the same mission gets the same day every
        time it is flown — and a situation rather than noise, so the sky always
        makes sense as weather.
      </p>
    </section>
  );
}

// --- Custom -----------------------------------------------------------------

function CustomPane({
  sky,
  columns,
  terrainHeight,
  onSky,
}: {
  sky: WeatherState;
  columns: number;
  terrainHeight: number | null;
  onSky: (sky: WeatherState) => void;
}) {
  const patch = (parts: Partial<WeatherState>): void => {
    const next = { ...sky, ...parts };
    onSky({ ...next, preset: nearestPreset(next) });
  };

  // Clamped but *not* sorted. Sorting here is what made a base slider swap the
  // deck under the pointer the moment it crossed its neighbour, so a low deck
  // could never be dragged above a high one and every added deck felt like it
  // had been forced into a tier. The sky is sorted exactly once, where it is
  // resolved for the renderers.
  const setLayers = (layers: readonly CloudLayer[]): void =>
    patch({ layers: clampLayers(layers) });

  const replaceLayer = (index: number, layer: CloudLayer): void =>
    setLayers(sky.layers.map((existing, i) => (i === index ? layer : existing)));

  const addLayer = (): void => {
    // A deck is a deck, not a tier. Whatever genus comes next is placed where
    // that genus normally sits and can be moved anywhere from there — a sky of
    // nothing but altostratus, or nothing but one FEW cumulus, is a sky. The
    // only thing avoided is a base that lands exactly inside a deck already
    // there, because a deck inside another one cannot be seen or picked out.
    const used = new Set(sky.layers.map((layer) => layer.type));
    const type =
      sky.layers.length === 0
        ? CLOUD_TYPE.Cumulus
        : (CLOUD_TYPES.find((candidate) => !used.has(candidate)) ??
          CLOUD_TYPE.Cumulus);
    const fresh = defaultLayer(type);
    const buried = sky.layers.find(
      (layer) =>
        fresh.baseAgl >= layer.baseAgl - 30 && fresh.baseAgl < layerTop(layer),
    );
    const baseAgl = buried
      ? Math.min(layerTop(buried) + 200, MAX_CLOUD_BASE)
      : fresh.baseAgl;
    setLayers([...sky.layers, { ...fresh, baseAgl }]);
  };

  return (
    // The five parts of a hand-built sky are independent of one another and
    // together they are the tallest thing on either screen that shows them, so
    // they are laid out across the width rather than down it.
    <MenuColumns minWidth="22rem">
      <section>
        <SectionLabel>Visibility</SectionLabel>
        <Slider
          label="Horizontal visibility"
          min={100}
          max={UNLIMITED_VISIBILITY}
          step={100}
          value={Math.round(sky.visibilityM)}
          onChange={(value) => patch({ visibilityM: value })}
          format={formatVisibility}
        />
        <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
          What an observer on the ground can see, and the distance the terrain
          is actually gone at — whatever the altitude. It sets the fog, the
          exposure and how far out a contact can be held.
        </p>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <SectionLabel>Cloud layers</SectionLabel>
          <span className="text-2xs text-cyan/70">☁ cloud</span>
        </div>
        <div className="space-y-4">
          {sky.layers.map((layer, index) => (
            <LayerEditor
              key={index}
              index={index}
              layer={layer}
              columns={columns}
              terrainHeight={terrainHeight}
              onChange={(next) => replaceLayer(index, next)}
              onRemove={() =>
                setLayers(sky.layers.filter((_, i) => i !== index))
              }
            />
          ))}
          {sky.layers.length === 0 ? (
            <p className="text-2xs text-osd-faint">
              Sky clear. Nothing is drawn, marched, or available to hide in.
            </p>
          ) : null}
          {sky.layers.length < MAX_CLOUD_LAYERS ? (
            <PrimaryButton onClick={addLayer}>Add a layer</PrimaryButton>
          ) : (
            <p className="text-2xs text-osd-faint">
              Three decks is what a routine report carries, and what the cloud
              march can afford.
            </p>
          )}
          <p className="text-2xs leading-relaxed text-osd-faint">
            Every deck is independent: one is a sky, and so is one deck of
            altostratus with nothing under it. A base may go below the launch
            point, which is what a deck in the valley looks like from a ridge.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <SectionLabel>Precipitation</SectionLabel>
        <OptionGroup
          columns={3}
          value={sky.precipitation.kind}
          onChange={(kind) =>
            patch({
              precipitation: {
                ...sky.precipitation,
                kind,
                intensity:
                  kind === PRECIPITATION.None
                    ? 0
                    : Math.max(sky.precipitation.intensity, 0.5),
              },
            })
          }
          options={[
            { value: PRECIPITATION.None, label: "None" },
            { value: PRECIPITATION.Rain, label: "Rain" },
            { value: PRECIPITATION.Snow, label: "Snow" },
          ]}
        />
        {sky.precipitation.kind !== PRECIPITATION.None ? (
          <>
            <Slider
              label="Intensity"
              min={0}
              max={100}
              step={1}
              value={Math.round(sky.precipitation.intensity * 100)}
              onChange={(value) =>
                patch({
                  precipitation: {
                    ...sky.precipitation,
                    intensity: value / 100,
                  },
                })
              }
              format={(value) => `${value}%`}
            />
            <Toggle
              label="Showers"
              checked={sky.precipitation.showers}
              onChange={(showers) =>
                patch({ precipitation: { ...sky.precipitation, showers } })
              }
            />
          </>
        ) : null}
        <Toggle
          label="Thunderstorm"
          checked={sky.thunderstorm}
          onChange={(thunderstorm) => patch({ thunderstorm })}
        />
        <p className="text-2xs leading-relaxed text-osd-faint">
          Nothing falls above the highest cloud top
          {sky.layers.length > 0
            ? ` — ${Math.round(
                sky.layers.reduce(
                  (top, layer) => Math.max(top, layer.baseAgl + layer.depth),
                  0,
                ),
              )} m here`
            : ""}
          : climb through the deck and you fly out of the weather. Lightning
          needs a cumulonimbus to come out of, so adding one switches the storm
          on by itself.
        </p>
      </section>

      <WindEditor sky={sky} onChange={patch} />

      <section className="space-y-3">
        <SectionLabel>Air</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Temperature"
            value={String(Math.round(sky.temperatureC))}
            step={1}
            suffix="°C"
            onChange={(value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) patch({ temperatureC: parsed });
            }}
          />
          <NumberField
            label="Dew point"
            value={String(Math.round(sky.dewPointC))}
            step={1}
            suffix="°C"
            onChange={(value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) patch({ dewPointC: parsed });
            }}
          />
        </div>
        <p className="text-2xs leading-relaxed text-osd-faint">
          The temperature decides whether cloud that is raining is raining or
          snowing, when the layers are left to work it out for themselves.
        </p>
      </section>
    </MenuColumns>
  );
}

function LayerEditor({
  index,
  layer,
  columns,
  terrainHeight,
  onChange,
  onRemove,
}: {
  index: number;
  layer: CloudLayer;
  columns: number;
  terrainHeight: number | null;
  onChange: (layer: CloudLayer) => void;
  onRemove: () => void;
}) {
  const info = CLOUD_TYPE_INFO[layer.type];
  const base = Math.round(layer.baseAgl);
  return (
    // Cloud is cyan and wind is amber, everywhere: the two stacks of cards
    // edit completely different things and used to be impossible to tell
    // apart halfway down a scrolled panel.
    <div className="space-y-3 border border-hairline border-l-2 border-l-cyan/60 bg-cyan/[0.03] p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-[0.14em] text-cyan/80">
          ☁ Deck {index + 1}
        </span>
        <span className="text-2xs text-osd-faint">{info.label}</span>
      </div>
      <OptionGroup
        columns={4}
        value={layer.amount}
        onChange={(amount) => onChange({ ...layer, amount })}
        options={CLOUD_AMOUNTS.map((amount) => ({
          value: amount,
          label: amount,
          hint: `${CLOUD_AMOUNT_INFO[amount].oktas[0]}-${CLOUD_AMOUNT_INFO[amount].oktas[1]}/8`,
        }))}
      />
      <OptionGroup
        columns={Math.max(columns, 4)}
        value={layer.type}
        onChange={(type: CloudType) =>
          onChange({
            ...layer,
            type,
            // The depth follows the genus unless it has been moved by hand:
            // a stratus sheet 8 km thick is not a stratus sheet.
            depth:
              layer.depth === info.defaultDepth
                ? CLOUD_TYPE_INFO[type].defaultDepth
                : layer.depth,
          })
        }
        options={CLOUD_TYPES.map((type) => ({
          value: type,
          label: type,
          hint: CLOUD_TYPE_INFO[type].label,
        }))}
      />
      <Slider
        label="Base"
        min={MIN_CLOUD_BASE}
        max={MAX_CLOUD_BASE}
        step={10}
        value={base}
        onChange={(baseAgl) => onChange({ ...layer, baseAgl })}
        format={(value) =>
          `${value} m · ${Math.round(value / 30.48) * 100} ft`
        }
      />
      <p className="text-2xs text-osd-faint">
        {base < 0
          ? `${-base} m below the launch point — you take off above this deck.`
          : base === 0
            ? "Sitting on the ground you launch from."
            : `${base} m above the launch point.`}
        {terrainHeight === null
          ? ""
          : ` ${Math.round(terrainHeight + layer.baseAgl)} m above the sea.`}
      </p>
      <Slider
        label="Depth"
        min={60}
        max={10000}
        step={20}
        value={Math.round(layer.depth)}
        onChange={(depth) => onChange({ ...layer, depth })}
        format={(value) => `${value} m`}
      />
      <p className="text-2xs leading-relaxed text-osd-faint">
        {info.description}
        {info.thunder ? " Lightning comes out of this one." : ""}
      </p>
      <PrimaryButton tone="danger" onClick={onRemove}>
        Remove layer
      </PrimaryButton>
    </div>
  );
}

function WindEditor({
  sky,
  onChange,
}: {
  sky: WeatherState;
  onChange: (parts: Partial<WeatherState>) => void;
}) {
  const layers = sky.wind.layers;

  const setLayers = (next: readonly WindLayer[]): void =>
    onChange({ wind: { ...sky.wind, layers: normalizeWindLayers(next) } });

  const replace = (index: number, layer: WindLayer): void =>
    setLayers(layers.map((existing, i) => (i === index ? layer : existing)));

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <SectionLabel>Wind</SectionLabel>
        <span className="text-2xs text-amber/70">↗ wind</span>
      </div>
      {layers.map((layer, index) => (
        // Amber, and a level rather than a deck: the wind cards sit directly
        // under the cloud cards in the same column and must never be mistaken
        // for one more of them.
        <div
          key={index}
          className="space-y-3 border border-hairline border-l-2 border-l-amber/60 bg-amber/[0.03] p-3"
        >
          <div className="flex items-baseline justify-between">
            <span className="text-2xs uppercase tracking-[0.14em] text-amber/80">
              ↗ Level {index + 1}
            </span>
            <span className="text-2xs text-osd-faint">
              {index === 0 ? "Surface" : "Aloft"}
            </span>
          </div>
          <Slider
            tone="amber"
            label={index === 0 ? "Surface height" : "Height"}
            min={index === 0 ? WIND_REFERENCE_HEIGHT : 100}
            max={12000}
            step={index === 0 ? 5 : 100}
            value={Math.round(layer.altitudeAgl)}
            onChange={(altitudeAgl) => replace(index, { ...layer, altitudeAgl })}
            format={(value) => `${value} m`}
          />
          <Slider
            tone="amber"
            label="Direction"
            min={0}
            max={359}
            step={5}
            value={Math.round(layer.directionDeg)}
            onChange={(directionDeg) => replace(index, { ...layer, directionDeg })}
            format={(value) => `${String(value).padStart(3, "0")}° from`}
          />
          <Slider
            tone="amber"
            label="Speed"
            min={0}
            max={140}
            step={1}
            value={Math.round(layer.speed * 3.6)}
            onChange={(kmh) => replace(index, { ...layer, speed: kmh / 3.6 })}
            format={(value) => `${value} km/h · ${Math.round(value / 1.852)} kt`}
          />
          {index > 0 ? (
            <PrimaryButton
              tone="danger"
              onClick={() => setLayers(layers.filter((_, i) => i !== index))}
            >
              Remove level
            </PrimaryButton>
          ) : null}
        </div>
      ))}

      {layers.length < MAX_WIND_LAYERS ? (
        <PrimaryButton
          onClick={() => {
            const top = layers[layers.length - 1] as WindLayer;
            setLayers([
              ...layers,
              {
                altitudeAgl: Math.min(top.altitudeAgl + 1500, 12000),
                // Veering right and strengthening with height is what the
                // boundary layer actually does as friction lets go.
                directionDeg: (top.directionDeg + 20) % 360,
                speed: top.speed * 1.5 + 2,
              },
            ]);
          }}
        >
          Add a level
        </PrimaryButton>
      ) : null}

      <Slider
        tone="amber"
        label="Gusts"
        min={0}
        max={100}
        step={1}
        value={Math.round(sky.wind.gustiness * 100)}
        onChange={(value) =>
          onChange({ wind: { ...sky.wind, gustiness: value / 100 } })
        }
        format={(value) => (value === 0 ? "Steady" : `${value}%`)}
      />
      <Slider
        tone="amber"
        label="Direction variation"
        min={0}
        max={100}
        step={1}
        value={Math.round(sky.wind.variation * 100)}
        onChange={(value) =>
          onChange({ wind: { ...sky.wind, variation: value / 100 } })
        }
        format={(value) => (value === 0 ? "Steady" : `±${Math.round(value * 0.32)}°`)}
      />
      <p className="text-2xs leading-relaxed text-osd-faint">
        Every level gusts together — one airmass — but each keeps its own mean,
        so the shear between them is what the climb actually flies through.
        Below the lowest level the wind falls away to the ground the way the
        boundary layer does.
      </p>
    </section>
  );
}

// --- Summary ----------------------------------------------------------------

function SkySummary({ sky }: { sky: WeatherState }) {
  const metar = useMemo(
    () => formatMetar(sky, { station: sky.station ?? undefined }),
    [sky],
  );
  return (
    <section className="space-y-2 border-t border-hairline pt-4">
      <p className="text-2xs leading-relaxed text-osd-dim">
        {describeWeather(sky)}
      </p>
      <p className="break-words font-mono text-2xs leading-relaxed text-osd-faint">
        {metar}
      </p>
    </section>
  );
}

function formatVisibility(metres: number): string {
  if (metres >= UNLIMITED_VISIBILITY) return "10 km+";
  if (metres >= 5000) return `${(metres / 1000).toFixed(0)} km`;
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres)} m`;
}
