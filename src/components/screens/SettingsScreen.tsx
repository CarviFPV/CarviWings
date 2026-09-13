"use client";

/**
 * Settings, in rooms rather than one long corridor.
 *
 * Everything here had grown into a single scrolling wall in which the fog, the
 * bank limit and the minimap range were all the same kind of thing, and the
 * aircraft was in there too. The aircraft has moved out to its own workbench,
 * and what is left is sorted by what a pilot is actually trying to change:
 * how it looks, how it flies, what is on the goggles, what it sounds like, and
 * — the one room that belongs to the browser rather than to the pilot — the
 * Cesium ion token the world itself arrives on.
 *
 * The categories are a pane rather than a screen each: the settings are
 * reached both from the main menu and from the pause menu, and a flight cannot
 * be navigated away from to arrange the display it is being flown on.
 */

import { useEffect, useState } from "react";

import { SCREEN, useGameStore } from "@/state/gameStore";
import { useSettingsStore } from "@/state/settingsStore";
import {
  GRAPHICS_PRESETS,
  GRAPHICS_QUALITY_AUTO,
  type GraphicsQuality,
  type GraphicsQualityChoice,
} from "@/lib/cesium/quality";
import { detectGpu } from "@/lib/gpuProbe";
import type { GpuProfile } from "@/sim/render/gpuProfile";
import {
  WORLD_DETAIL,
  WORLD_DETAIL_LABELS,
  type WorldDetail,
} from "@/lib/cesium/scenery";
import { hasGoogleMapsKey } from "@/lib/cesium/googleKey";
import { MUSIC_AUTO, MUSIC_STATIONS } from "@/sim/audio/musicDirector";
import { MINIMAP_ORIENTATION } from "@/sim/hud/minimapProjection";
import {
  FLIGHT_MODE,
  FLIGHT_MODE_LIMITS,
  RTH_ALTITUDE_MODE,
  RTH_ARRIVAL,
} from "@/sim/flight/flightModes";
import {
  MenuColumns,
  OptionGroup,
  PrimaryButton,
  SectionLabel,
  Slider,
  Toggle,
} from "@/components/ui/Primitives";
import { OSD_ELEMENTS, osdPlacement } from "@/sim/hud/osdLayout";
import { OsdLayoutEditor } from "./OsdLayoutEditor";
import { IonTokenHelp, IonTokenPanel } from "./IonTokenScreen";

const QUALITY_HINTS: Record<GraphicsQualityChoice, string> = {
  [GRAPHICS_QUALITY_AUTO]: "From the GPU installed",
  low: "Coarse terrain, no lighting",
  medium: "Balanced",
  high: "Sharp terrain",
  ultra: "Maximum detail",
};

const QUALITY_CHOICES: readonly GraphicsQualityChoice[] = [
  GRAPHICS_QUALITY_AUTO,
  ...(Object.keys(GRAPHICS_PRESETS) as GraphicsQuality[]),
];

const WORLD_DETAIL_HINTS: Record<WorldDetail, string> = {
  flat: "Terrain and imagery",
  buildings: "OSM buildings, extruded",
  photorealistic: "Buildings and trees",
};

/** The rooms the settings are sorted into. */
const CATEGORY = {
  Graphics: "graphics",
  FlightModes: "flightModes",
  Osd: "osd",
  Audio: "audio",
  // Last, and unlike the other four not a preference at all: the token is the
  // installation's, shared by every pilot in this browser. It is in here
  // because this is where somebody goes looking for it, and because a pilot
  // who has just been told the world will not load needs one screen to fix it
  // on rather than a text file and a rebuild.
  Ion: "ion",
} as const;

type Category = (typeof CATEGORY)[keyof typeof CATEGORY];

const CATEGORY_INFO: Record<Category, { label: string; hint: string }> = {
  [CATEGORY.Graphics]: {
    label: "Graphics",
    hint: "Detail, the world, the view and the weather",
  },
  [CATEGORY.FlightModes]: {
    label: "Flight modes",
    hint: "How the sticks reach the wing, and the way home",
  },
  [CATEGORY.Osd]: { label: "OSD", hint: "What is on the goggles, and where" },
  [CATEGORY.Audio]: { label: "Audio", hint: "Sound, music and volume" },
  [CATEGORY.Ion]: {
    label: "Cesium ion",
    hint: "The access token the world is streamed on",
  },
};

export function SettingsScreen({ embedded = false }: { embedded?: boolean }) {
  const goto = useGameStore((state) => state.goto);
  // Null is the list of categories itself, which is where the screen opens: a
  // handful of short lists are only easier than one long one if you are shown
  // the handful first.
  const [category, setCategory] = useState<Category | null>(null);
  const [editingOsd, setEditingOsd] = useState(false);

  const leave = (): void => {
    if (editingOsd) setEditingOsd(false);
    else if (category !== null) setCategory(null);
    else goto(SCREEN.Menu);
  };

  const heading = editingOsd
    ? "OSD layout"
    : category === null
      ? "Settings"
      : CATEGORY_INFO[category].label;
  const back = editingOsd
    ? "OSD"
    : category === null
      ? "Main menu"
      : "Settings";

  const body = editingOsd ? (
    <OsdLayoutEditor onBack={() => setEditingOsd(false)} />
  ) : category === null ? (
    <CategoryList onOpen={setCategory} />
  ) : category === CATEGORY.Graphics ? (
    <GraphicsPane />
  ) : category === CATEGORY.FlightModes ? (
    <FlightModePane />
  ) : category === CATEGORY.Osd ? (
    <OsdPane onEditLayout={() => setEditingOsd(true)} />
  ) : category === CATEGORY.Audio ? (
    <AudioPane />
  ) : (
    <IonPane />
  );

  if (embedded) {
    return (
      <div>
        {/* The pause menu draws its own way out, back to the pause menu. This
            is the one back into the category list, which only exists once a
            category is open. */}
        {category !== null && !editingOsd ? (
          <div className="mb-6 flex items-end justify-between gap-4 border-b border-hairline pb-3">
            <p className="text-xs uppercase tracking-[0.18em] text-osd">
              {heading}
            </p>
            <button
              type="button"
              onClick={leave}
              className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
            >
              &larr; Settings
            </button>
          </div>
        ) : null}
        {body}
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      {/* Wide enough for the sections to reach three columns and land inside
          a 1080p window without a scrollbar. */}
      <div className="mx-auto w-full max-w-[92rem] px-8 py-12">
        <header className="mb-10 flex items-end justify-between border-b border-hairline pb-5">
          <div>
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Configuration
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">
              {heading.toUpperCase()}
            </h1>
          </div>
          <button
            type="button"
            onClick={leave}
            className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
          >
            &larr; {back}
          </button>
        </header>
        {body}
        <p className="mt-8 text-2xs text-osd-faint">
          Settings are stored in this browser only.
        </p>
      </div>
    </div>
  );
}

/** The way in: the categories, and the one button that outranks them. */
function CategoryList({ onOpen }: { onOpen: (category: Category) => void }) {
  const reset = useSettingsStore((state) => state.reset);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <nav className="grid gap-2 sm:grid-cols-2">
        {(Object.values(CATEGORY) as Category[]).map((id) => (
          <PrimaryButton key={id} onClick={() => onOpen(id)}>
            <span className="block">{CATEGORY_INFO[id].label}</span>
            <span className="mt-0.5 block text-2xs normal-case tracking-[0.06em] text-osd-faint">
              {CATEGORY_INFO[id].hint}
            </span>
          </PrimaryButton>
        ))}
      </nav>

      <p className="mt-6 text-2xs leading-relaxed text-osd-faint">
        The aircraft is not in here. Which airframe, the motor and the pack in
        it, the rates it is flown on and the colours it is painted are all the
        same thing — an aircraft — and they are set up together on the{" "}
        <span className="text-osd-dim">aircraft builder</span> on the main menu.
        Key bindings and the controller are under{" "}
        <span className="text-osd-dim">Controls</span>.
      </p>

      <section className="mt-8">
        <SectionLabel>Defaults</SectionLabel>
        <PrimaryButton onClick={() => reset()}>Restore defaults</PrimaryButton>
        <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
          Puts every setting the pilot owns back where it started, the flight
          controller and every aircraft&rsquo;s rates and paint included. Key
          bindings, the controller, the pilot roster, the saved aircraft and the
          Cesium ion token are not touched &mdash; a named aircraft is deleted
          from its own row in the builder, one at a time, or not at all, and the
          token is the browser&rsquo;s rather than any pilot&rsquo;s.
        </p>
      </section>
    </div>
  );
}

/**
 * What the machine turned out to have in it.
 *
 * Probed after mount rather than during the render: the answer comes from a
 * WebGL context, which does not exist on the server, and a line that differed
 * between the two renders would be a hydration mismatch. Shown whichever
 * preset is chosen — a pilot overruling the machine is owed the reason it
 * would have given — but only the `auto` line says the choice follows from it.
 */
function DetectedGpu({ auto }: { auto: boolean }) {
  const [profile, setProfile] = useState<GpuProfile | null>(null);
  useEffect(() => setProfile(detectGpu()), []);
  if (!profile) return null;

  return (
    <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
      <span className="text-osd-dim">Detected:</span> {profile.note}
      {auto
        ? " Multisampling and the cloud march are provisioned from it either way."
        : " Auto would follow that; the preset above overrules it."}
    </p>
  );
}

/** How much of the world is drawn, and how far into it you can see. */
function GraphicsPane() {
  const settings = useSettingsStore();
  const googleKeyPresent = hasGoogleMapsKey();

  return (
    <MenuColumns minWidth="21rem">
      <section>
        <SectionLabel>Graphics quality</SectionLabel>
        <OptionGroup
          columns={5}
          value={settings.graphicsQuality}
          onChange={(value) => settings.set("graphicsQuality", value)}
          options={QUALITY_CHOICES.map((key) => ({
            value: key,
            label:
              key === GRAPHICS_QUALITY_AUTO
                ? "Auto"
                : GRAPHICS_PRESETS[key].label,
            hint: QUALITY_HINTS[key],
          }))}
        />
        <DetectedGpu auto={settings.graphicsQuality === GRAPHICS_QUALITY_AUTO} />
        <p className="mt-2 text-2xs text-osd-faint">
          Applied when the next flight starts. Controls terrain detail, tile
          cache size, render scale and anti-aliasing.
        </p>
        <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
          What you pick here is what is drawn, for the whole flight &mdash;
          nothing lowers it behind you. The world is fetched before take-off
          instead: the loading screen streams the field, the whole circle around
          it and the country behind that, which is why a higher preset costs
          loading time rather than frames.
        </p>
      </section>

      <section>
        <SectionLabel>World detail</SectionLabel>
        <OptionGroup
          columns={3}
          value={settings.worldDetail}
          onChange={(value) => settings.set("worldDetail", value)}
          options={(
            Object.values(WORLD_DETAIL) as WorldDetail[]
          ).map((key) => ({
            value: key,
            label: WORLD_DETAIL_LABELS[key],
            hint: WORLD_DETAIL_HINTS[key],
          }))}
        />
        <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
          Terrain gives the ground its shape; everything standing on it is
          painted into the satellite image unless a 3D dataset is laid over the
          top. <span className="text-osd-dim">Buildings</span> extrudes every
          OpenStreetMap footprint on the planet.{" "}
          <span className="text-osd-dim">Photorealistic</span> streams
          Google&rsquo;s photogrammetry mesh worldwide: real buildings, real
          trees, real forests.
        </p>
        {settings.worldDetail === WORLD_DETAIL.Photorealistic && (
          <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
            {googleKeyPresent
              ? "A Google Maps Platform key is configured, so the tiles come straight from Google and ion's allowance is not touched."
              : "Served through Cesium ion, which meters photogrammetry by root tile — roughly one per flight, on an allowance a private project will not notice. A Google Maps Platform key in NEXT_PUBLIC_GOOGLE_MAPS_API_KEY bypasses ion entirely."}
          </p>
        )}
        {settings.worldDetail === WORLD_DETAIL.Photorealistic && (
          <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
            The plain globe is switched off underneath the mesh to stop the two
            ground surfaces fighting, so anywhere Google has no coverage reads as
            empty. Collisions still follow the terrain height field, not the
            mesh: you can fly through a building.
          </p>
        )}
      </section>

      <section className="space-y-4">
        <SectionLabel>View</SectionLabel>
        <Slider
          label="View distance"
          min={10}
          max={150}
          step={5}
          value={settings.viewDistanceKm}
          onChange={(value) => settings.set("viewDistanceKm", value)}
          format={(value) => `${value} km`}
        />
        <p className="-mt-2 text-2xs text-osd-faint">
          A ceiling on how far the world reaches. The air is thickened until the
          horizon sits at this distance, so a clear day ends here and a foggy
          one still ends where the weather says. It does not clip the sky.
        </p>
        <Slider
          label="FPV field of view"
          min={60}
          max={140}
          step={1}
          value={settings.fpvFieldOfView}
          onChange={(value) => settings.set("fpvFieldOfView", value)}
          format={(value) => `${value.toFixed(0)}°`}
        />
        <Slider
          label="Camera shake"
          min={0}
          max={1.5}
          step={0.05}
          value={settings.cameraShake}
          onChange={(value) => settings.set("cameraShake", value)}
          format={(value) => (value === 0 ? "Off" : value.toFixed(2))}
        />
        <Slider
          label="Chase distance"
          min={5}
          max={30}
          step={0.5}
          value={settings.chaseDistance}
          onChange={(value) => settings.set("chaseDistance", value)}
          format={(value) => `${value.toFixed(1)} m`}
        />
        <Slider
          label="Chase height"
          min={0}
          max={12}
          step={0.2}
          value={settings.chaseHeight}
          onChange={(value) => settings.set("chaseHeight", value)}
          format={(value) => `${value.toFixed(1)} m`}
        />
      </section>

      <section className="space-y-3">
        <SectionLabel>Weather effects</SectionLabel>
        <Toggle
          label="Weather effects"
          checked={settings.weatherEffects}
          onChange={(value) => settings.set("weatherEffects", value)}
        />
        <Toggle
          label="Clouds"
          checked={settings.showClouds}
          onChange={(value) => settings.set("showClouds", value)}
        />
        <Toggle
          label="Volumetric clouds"
          checked={settings.volumetricClouds}
          onChange={(value) => settings.set("volumetricClouds", value)}
        />
        <Toggle
          label="Rain"
          checked={settings.showRain}
          onChange={(value) => settings.set("showRain", value)}
        />
        <p className="text-2xs text-osd-faint">
          Turning weather effects off removes fog, cloud and precipitation from
          the render. It does not change how far the aircraft can actually see —
          visibility is part of the mission, not a graphics setting.
        </p>
        <p className="text-2xs text-osd-faint">
          Volumetric cloud is raymarched: it has an inside, so flying into a
          cumulus goes white rather than through a billboard. It is the most
          expensive setting here — turn it off for the cheaper cloud field, and
          the graphics preset decides how finely it is marched.
        </p>
        <p className="text-2xs text-osd-faint">
          How much cloud there is at all is part of the weather rather than a
          graphics setting, so it lives with the mission: set it on the setup
          screen, or under Time &amp; weather in the pause menu. Slide the cover
          to nothing and there is no cloud layer to draw, march or fly into.
        </p>
      </section>
    </MenuColumns>
  );
}

/**
 * The flight controller: what the sticks mean, and what happens without them.
 *
 * The rates each airframe is tuned on are not here — they belong to the
 * aircraft and live on the workbench with it. What is here is true of every
 * aircraft in the hangar: the mode it launches in, the attitudes the assisted
 * modes hold to, and the way home.
 */
function FlightModePane() {
  const settings = useSettingsStore();
  const modes = settings.flightModes;
  const rth = modes.rth;
  const limits = FLIGHT_MODE_LIMITS;

  return (
    <MenuColumns minWidth="21rem">
      <section className="space-y-4">
        <SectionLabel>Flight modes</SectionLabel>
        <div>
          <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
            Mode at launch
          </p>
          <OptionGroup
            columns={3}
            value={modes.defaultMode}
            onChange={(value) => settings.setFlightModes({ defaultMode: value })}
            options={[
              {
                value: FLIGHT_MODE.Manual,
                label: "Manual",
                hint: "Sticks are elevons",
              },
              {
                value: FLIGHT_MODE.Acro,
                label: "Acro",
                hint: "Sticks are rates",
              },
              {
                value: FLIGHT_MODE.Angle,
                label: "Angle",
                hint: "Sticks are attitude",
              },
            ]}
          />
        </div>
        <p className="text-2xs leading-relaxed text-osd-faint">
          Manual is the airframe as it is: the sticks are the control surfaces,
          and how fast it rotates is whatever the air makes of that. Acro puts a
          gyro on it and holds the rates the aircraft is tuned on, which are set
          in the aircraft builder. Angle turns the sticks into an attitude: full
          roll is the bank limit below, and letting go levels the wing. Course
          hold and altitude hold sit on top of any of them, and the two together
          are cruise &mdash; a heading and a height, hands off.
        </p>
        <Slider
          label="Bank limit"
          min={limits.maxBankDeg.min}
          max={limits.maxBankDeg.max}
          step={1}
          value={modes.maxBankDeg}
          onChange={(value) => settings.setFlightModes({ maxBankDeg: value })}
          format={(value) => `${value.toFixed(0)}°`}
        />
        <Slider
          label="Pitch limit"
          min={limits.maxPitchDeg.min}
          max={limits.maxPitchDeg.max}
          step={1}
          value={modes.maxPitchDeg}
          onChange={(value) => settings.setFlightModes({ maxPitchDeg: value })}
          format={(value) => `${value.toFixed(0)}°`}
        />
        <Slider
          label="Course trim rate"
          min={limits.courseTrimRate.min}
          max={limits.courseTrimRate.max}
          step={5}
          value={modes.courseTrimRate}
          onChange={(value) => settings.setFlightModes({ courseTrimRate: value })}
          format={(value) => `${value.toFixed(0)}°/s`}
        />
        <Slider
          label="Altitude trim rate"
          min={limits.altitudeTrimRate.min}
          max={limits.altitudeTrimRate.max}
          step={0.5}
          value={modes.altitudeTrimRate}
          onChange={(value) =>
            settings.setFlightModes({ altitudeTrimRate: value })
          }
          format={(value) => `${value.toFixed(1)} m/s`}
        />
        <p className="text-2xs leading-relaxed text-osd-faint">
          While a hold is engaged the stick stops flying the axis and starts
          walking what is being held: roll moves the course, pitch moves the
          height. The trim rates are how fast a full deflection moves each.
        </p>
      </section>

      <section className="space-y-4">
        <SectionLabel>Return home</SectionLabel>
        <div>
          <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
            Return altitude
          </p>
          <OptionGroup
            columns={4}
            value={rth.altitudeMode}
            onChange={(value) => settings.setRth({ altitudeMode: value })}
            options={[
              {
                value: RTH_ALTITUDE_MODE.AtLeast,
                label: "At least",
                hint: "Climb, never descend",
              },
              {
                value: RTH_ALTITUDE_MODE.Fixed,
                label: "Fixed",
                hint: "Always this height",
              },
              {
                value: RTH_ALTITUDE_MODE.Current,
                label: "Current",
                hint: "Keep what it has",
              },
              {
                value: RTH_ALTITUDE_MODE.Extra,
                label: "Extra",
                hint: "Add to what it has",
              },
            ]}
          />
        </div>
        <Slider
          label="Return height"
          min={limits.rthAltitudeMetres.min}
          max={limits.rthAltitudeMetres.max}
          step={10}
          value={rth.altitudeMetres}
          onChange={(value) => settings.setRth({ altitudeMetres: value })}
          format={(value) => `${value.toFixed(0)} m`}
        />
        <p className="-mt-2 text-2xs leading-relaxed text-osd-faint">
          Measured above the ground at the launch point, not above the aircraft.{" "}
          <span className="text-osd-dim">Current</span> ignores it entirely and
          comes home at whatever height the return was started at.
        </p>
        <Toggle
          label="Climb before turning back"
          checked={rth.climbFirst}
          onChange={(value) => settings.setRth({ climbFirst: value })}
        />
        <p className="-mt-2 text-2xs leading-relaxed text-osd-faint">
          On, the wing goes up to the return height first and only then points
          at home &mdash; the only safe answer when what is between the two is a
          ridge. Off, it turns straight away and climbs on the way, which is
          quicker over flat ground.
        </p>
        <div>
          <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
            On arrival
          </p>
          <OptionGroup
            columns={2}
            value={rth.arrival}
            onChange={(value) => settings.setRth({ arrival: value })}
            options={[
              {
                value: RTH_ARRIVAL.Loiter,
                label: "Loiter",
                hint: "Circle and wait",
              },
              {
                value: RTH_ARRIVAL.Land,
                label: "Land",
                hint: "Spiral down onto it",
              },
            ]}
          />
        </div>
        <Slider
          label="Loiter radius"
          min={limits.rthLoiterRadiusMetres.min}
          max={limits.rthLoiterRadiusMetres.max}
          step={10}
          value={rth.loiterRadiusMetres}
          onChange={(value) => settings.setRth({ loiterRadiusMetres: value })}
          format={(value) => `${value.toFixed(0)} m`}
        />
        <Slider
          label="Return speed"
          min={limits.rthCruiseSpeed.min}
          max={limits.rthCruiseSpeed.max}
          step={1}
          value={rth.cruiseSpeed}
          onChange={(value) => settings.setRth({ cruiseSpeed: value })}
          format={(value) => `${Math.round(value * 3.6)} km/h`}
        />
        <Toggle
          label="Sticks take it back"
          checked={rth.allowStickOverride}
          onChange={(value) => settings.setRth({ allowStickOverride: value })}
        />
        <p className="text-2xs leading-relaxed text-osd-faint">
          With this on, moving pitch, roll or yaw cancels the return and hands
          the aircraft straight back. Off, only the return key does &mdash;
          which is what you want if the reason you pressed it was that you can
          no longer see anything.
        </p>
      </section>

      <section className="space-y-4">
        <SectionLabel>Stick sensitivity</SectionLabel>
        <Slider
          label="Flight sensitivity"
          min={0.2}
          max={1}
          step={0.05}
          value={settings.flightSensitivity}
          onChange={(value) => settings.set("flightSensitivity", value)}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <Slider
          label="Controller sensitivity"
          min={0.2}
          max={1.5}
          step={0.05}
          value={settings.controllerSensitivity}
          onChange={(value) => settings.set("controllerSensitivity", value)}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <p className="text-2xs leading-relaxed text-osd-faint">
          Flight sensitivity scales the keyboard; controller sensitivity scales
          every controller axis on top of its own calibration. Axis mapping,
          inversion, dead zones and calibration live on the controller screen.
        </p>
      </section>
    </MenuColumns>
  );
}

/** What is drawn over the picture. */
function OsdPane({ onEditLayout }: { onEditLayout: () => void }) {
  const settings = useSettingsStore();
  const osdSummary = OSD_ELEMENTS.filter(
    (id) => osdPlacement(settings.osdLayout, id).enabled,
  ).length;

  return (
    <MenuColumns minWidth="21rem">
      <section className="space-y-3">
        <SectionLabel>On-screen display</SectionLabel>
        <Toggle
          label="On-screen display"
          checked={settings.showOsd}
          onChange={(value) => settings.set("showOsd", value)}
        />
        <PrimaryButton onClick={onEditLayout}>OSD layout</PrimaryButton>
        <p className="text-2xs leading-relaxed text-osd-faint">
          {osdSummary} shown of {OSD_ELEMENTS.length}. Switch elements on and
          off and drag them where you want them, the way a flight
          controller&rsquo;s OSD is set up. One layout for the pilot, so it is
          the same display on every aircraft in the hangar.
        </p>
      </section>

      <section className="space-y-3">
        <SectionLabel>Minimap</SectionLabel>
        <div>
          <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
            Orientation
          </p>
          <OptionGroup
            columns={2}
            value={settings.minimapOrientation}
            onChange={(value) => settings.set("minimapOrientation", value)}
            options={[
              { value: MINIMAP_ORIENTATION.NorthUp, label: "North up" },
              { value: MINIMAP_ORIENTATION.HeadingUp, label: "Heading up" },
            ]}
          />
        </div>
        <div>
          <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
            Range
          </p>
          <OptionGroup
            columns={5}
            value={settings.minimapRangeMetres}
            onChange={(value) => settings.set("minimapRangeMetres", value)}
            options={[
              { value: 1000, label: "1 km" },
              { value: 2500, label: "2.5 km" },
              { value: 5000, label: "5 km" },
              { value: 10000, label: "10 km" },
              { value: 25000, label: "25 km" },
            ]}
          />
        </div>
        <p className="text-2xs leading-relaxed text-osd-faint">
          How far the rim of the minimap is from the aircraft, and whether the
          map turns under you or you turn on it. Whether it is drawn at all, and
          where it sits, are part of the layout above.
        </p>
      </section>
    </MenuColumns>
  );
}

/** What the aircraft sounds like, and what it is flown to. */
function AudioPane() {
  const settings = useSettingsStore();

  return (
    <MenuColumns minWidth="21rem">
      <section className="space-y-4">
        <SectionLabel>Aircraft</SectionLabel>
        <Toggle
          label="Sound"
          checked={settings.audioEnabled}
          onChange={() => settings.toggle("audioEnabled")}
        />
        <Slider
          label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={settings.audioVolume}
          onChange={(value) => settings.set("audioVolume", value)}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <p className="text-2xs leading-relaxed text-osd-faint">
          Every sound the aircraft makes is generated as the flight runs — the
          motor is an oscillator at the propeller&rsquo;s blade-passing
          frequency and the airframe rush is filtered noise. No audio files are
          downloaded. Sound is the master switch: with it off, the music below
          is off too.
        </p>
      </section>

      <section className="space-y-4">
        <SectionLabel>Music</SectionLabel>
        <Toggle
          label="Music"
          checked={settings.musicEnabled}
          onChange={() => settings.toggle("musicEnabled")}
        />
        <Slider
          label="Music volume"
          min={0}
          max={1}
          step={0.05}
          value={settings.musicVolume}
          onChange={(value) => settings.set("musicVolume", value)}
          format={(value) => `${Math.round(value * 100)}%`}
        />
        <div>
          <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
            Station
          </p>
          <OptionGroup
            columns={3}
            value={settings.musicStation}
            onChange={(value) => settings.set("musicStation", value)}
            options={[
              {
                value: MUSIC_AUTO,
                label: "Auto",
                hint: "The mission picks",
              },
              ...MUSIC_STATIONS.map((station) => ({
                value: station.id,
                label: station.name,
                hint: station.description,
              })),
            ]}
          />
        </div>
        <p className="text-2xs leading-relaxed text-osd-faint">
          On <span className="text-osd-dim">Auto</span> the mission chooses:
          downtempo in the menus, deep house on a free flight, electropop at a
          display or a fly-in, something with a pulse on a gate course, and the
          dangerous one for an interception or a strike. Pin a station and it
          plays throughout instead.
        </p>
        <p className="text-2xs leading-relaxed text-osd-faint">
          The music is streamed live from{" "}
          <span className="text-osd-dim">SomaFM</span>, listener-supported
          commercial-free internet radio — no account, no key and nothing
          stored. It needs a connection: offline, the stations are simply
          silent, and the aircraft is unaffected. Browsers will not start audio
          until the page has been clicked once, so the first flight of a
          session may be what starts it.
        </p>
      </section>
    </MenuColumns>
  );
}

/**
 * The token the Earth arrives on.
 *
 * The one thing in the settings that is not the pilot's: it belongs to this
 * browser, every pilot in it flies on the same one, and it is deliberately not
 * carried in a pilot backup.
 */
function IonPane() {
  return (
    <MenuColumns minWidth="24rem">
      <section>
        <SectionLabel>Access token</SectionLabel>
        <IonTokenPanel />
        <p className="mt-4 text-2xs leading-relaxed text-osd-faint">
          Terrain, satellite imagery, the world buildings and the place search
          all come from Cesium ion, and ion wants to know whose account is
          asking. The free Community plan covers personal, non-commercial
          flying. A token entered here is used by every pilot on this browser
          and takes effect on the next flight; it is not part of a pilot backup,
          so a backup file can be sent to somebody else without sending them
          your account.
        </p>
      </section>

      <section>
        <SectionLabel>Getting one</SectionLabel>
        <IonTokenHelp />
      </section>
    </MenuColumns>
  );
}
