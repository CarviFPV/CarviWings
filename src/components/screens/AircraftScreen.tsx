"use client";

/**
 * The aircraft builder: the workbench the wing is actually set up on.
 *
 * Everything about the aircraft itself lives here and nowhere else — which
 * airframe, what is bolted to it, what it is flown on and what it is painted —
 * so that choosing an aircraft before a flight is choosing one rather than
 * building one. The setup screens list what is in the hangar and fit it; the
 * changing is done here, with the wing in front of you.
 */

import { useState } from "react";

import { SCREEN, useGameStore, type Screen } from "@/state/gameStore";
import { useSettingsStore } from "@/state/settingsStore";
import { RATE_LIMITS } from "@/sim/flight/rates";
import { LIVERY_PRESETS, sameLivery } from "@/sim/flight/livery";
import {
  UAVS,
  batteriesFor,
  deliveredBattery,
  liveryFor,
  loadoutFor,
  motorOrDefault,
  ratesFor,
  resolveLoadout,
  uavOrDefault,
} from "@/sim/flight/uav";
import {
  BATTERY_UNLIMITED,
  formatBattery,
  formatEndurance,
  isCombustion,
  loadedMass,
  staticBurn,
  staticCurrent,
} from "@/sim/flight/powerplant";
import type { AircraftBuild } from "@/sim/flight/builds";
import {
  MAX_BUILDS,
  MAX_BUILD_NAME_LENGTH,
  MIN_BUILD_NAME_LENGTH,
  STOCK_BUILDS,
  buildNameRejection,
  buildsFull,
  describeBuild,
  fittedAircraft,
  isStockBuildId,
  normaliseBuildName,
  sameBuildName,
} from "@/sim/flight/builds";
import { MS_TO_KMH } from "@/sim/flight/telemetry";
import { cruiseEndurance, maxLevelSpeed } from "@/sim/flight/physics";
import { hoverThrottle } from "@/sim/flight/multirotor";
import { GRAVITY } from "@/sim/flight/config";
import { meshKindFor } from "@/sim/render/aircraftMesh";
import { AircraftPreview } from "@/components/ui/AircraftPreview";
import {
  ColorField,
  MenuColumns,
  OptionGroup,
  PrimaryButton,
  SectionLabel,
  Slider,
} from "@/components/ui/Primitives";

/** What the way back out of here is called, wherever it was opened from. */
const RETURN_LABELS: Partial<Record<Screen, string>> = {
  [SCREEN.Menu]: "Main menu",
  [SCREEN.Setup]: "Mission setup",
};

export function AircraftScreen() {
  const goto = useGameStore((state) => state.goto);
  const returnScreen = useGameStore((state) => state.aircraftReturn);
  const settings = useSettingsStore();
  // Which saved aircraft has a form open on it, if any. Only one at a time:
  // two open forms on one list is two questions being asked at once.
  const [savingBuild, setSavingBuild] = useState(false);
  const [renamingBuild, setRenamingBuild] = useState<string | null>(null);
  const [deletingBuild, setDeletingBuild] = useState<string | null>(null);
  const closeBuildForms = (): void => {
    setSavingBuild(false);
    setRenamingBuild(null);
    setDeletingBuild(null);
  };

  const uav = uavOrDefault(settings.uav.active);
  const rates = ratesFor(settings.uav, uav.id);
  const power = loadoutFor(settings.uav, uav.id);
  const motor = motorOrDefault(uav, power.motor);
  const loadout = resolveLoadout(uav, power);
  const packs = batteriesFor(uav, motor);
  const livery = liveryFor(settings.uav, uav.id);
  // An unlimited flight still carries the delivered pack's weight, so it is
  // also the pack the quoted figures are worked out against.
  const quotedPack = loadout.battery ?? deliveredBattery(uav);
  // A quadcopter is described in different words to a wing, and quoting one in
  // the other's would be worse than useless: a multirotor has no span to read
  // and a wing has no hover to hold.
  const rotorcraft = loadout.config.rotor !== undefined;
  // And an aeroplane with a petrol engine on it is described in different
  // words again: it has no controller to overrun and no cells to count, and
  // the number a pilot chooses one on is litres an hour rather than amps.
  const fuelled = isCombustion(motor);
  const builds = settings.builds;
  // Not stored: the aircraft the bench is holding right now, saved or stock,
  // if it is holding one at all. Move a slider and the selection goes with it,
  // which is the truth about what is fitted.
  const fitted = fittedAircraft(builds, settings.uav);
  const deliveredFitted = fitted !== null && isStockBuildId(fitted.id);

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      <div className="mx-auto w-full max-w-[92rem] px-8 py-12">
        <header className="mb-10 flex items-end justify-between border-b border-hairline pb-5">
          <div>
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Workbench
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">
              AIRCRAFT BUILDER
            </h1>
          </div>
          <button
            type="button"
            onClick={() => goto(returnScreen)}
            className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
          >
            &larr; {RETURN_LABELS[returnScreen] ?? "Main menu"}
          </button>
        </header>

        {/* The aircraft itself, before any of the controls that change it: it
            is what all of them are about, and a builder that made you imagine
            what you were building would be a form. */}
        <section className="mb-9 grid gap-6 border border-hairline bg-panel p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div>
            <AircraftPreview
              livery={livery}
              kind={meshKindFor(loadout.config)}
              height={280}
            />
            <p className="mt-2 text-center text-2xs text-osd-faint">
              Drag to turn it round; double-click to put it back.
            </p>
          </div>
          <div>
            <p className="text-lg font-light tracking-[0.04em] text-osd">
              {fitted ? fitted.name : uav.config.name}
            </p>
            <p className="mt-1 text-2xs text-osd-faint">
              {!fitted
                ? "Modified, not saved under a name"
                : deliveredFitted
                  ? "As delivered"
                  : uav.config.name}{" "}
              · {uav.summary}
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 border-l border-hairline-bright/40 pl-3 text-2xs tabular-nums text-osd-dim">
              <dt className="text-osd-faint">All-up weight</dt>
              <dd>{loadout.config.mass.toFixed(2)} kg</dd>
              <dt className="text-osd-faint">
                {rotorcraft ? "Tip to tip" : "Wing span"}
              </dt>
              <dd>{loadout.config.wingSpan.toFixed(2)} m</dd>
              <dt className="text-osd-faint">Static thrust</dt>
              <dd>
                {loadout.config.maxThrust.toFixed(0)} N ·{" "}
                {(
                  loadout.config.maxThrust /
                  (loadout.config.mass * GRAVITY)
                ).toFixed(2)}{" "}
                : 1
              </dd>
              <dt className="text-osd-faint">Top level speed</dt>
              <dd>
                {(maxLevelSpeed(loadout.config) * MS_TO_KMH).toFixed(0)} km/h
              </dd>
              <dt className="text-osd-faint">
                {fuelled ? "Full-throttle burn" : "Full-throttle draw"}
              </dt>
              <dd>
                {fuelled ? (
                  <>
                    {staticBurn(motor).toFixed(1)} L/h ·{" "}
                    {motor.combustion?.displacementCc ?? 0} cc
                  </>
                ) : (
                  <>
                    {staticCurrent(motor, quotedPack).toFixed(0)} A of{" "}
                    {motor.escAmps} A
                  </>
                )}
              </dd>
              <dt className="text-osd-faint">Cruise endurance</dt>
              <dd>
                {loadout.battery
                  ? formatEndurance(
                      cruiseEndurance(loadout.config, motor, loadout.battery),
                    )
                  : "unlimited"}
              </dd>
              {rotorcraft ? (
                <>
                  {/* The number a multirotor pilot flies around: where the
                      stick sits when the aircraft is simply staying there. */}
                  <dt className="text-osd-faint">Hover throttle</dt>
                  <dd>{(hoverThrottle(loadout.config) * 100).toFixed(0)} %</dd>
                </>
              ) : null}
            </dl>
            <p className="mt-4 text-2xs leading-relaxed text-osd-faint">
              This is the aircraft the next flight goes up on. Everything below
              changes it in place; saving it under a name keeps this setup so
              the same airframe can be built two ways.
            </p>
          </div>
        </section>

        <MenuColumns minWidth="21rem">
          <section className="space-y-4">
            <SectionLabel>Airframe</SectionLabel>
            <OptionGroup
              columns={2}
              value={uav.id}
              onChange={(value) => settings.selectUav(value)}
              options={UAVS.map((entry) => ({
                value: entry.id,
                label: entry.config.name,
                hint: entry.summary,
              }))}
            />
            <p className="text-2xs leading-relaxed text-osd-faint">
              Three wings, two multirotors and five petrol aeroplanes, and the
              way each one is set up. The hardware, the rates and the paint stay
              with the airframe they were fitted to, the way a transmitter keeps
              a model memory, so a second
              aircraft never inherits the first&rsquo;s tune. Picking a different
              one takes effect on the next flight; the rates below take effect
              immediately, mid-flight included.
            </p>
          </section>

          <section className="space-y-4">
            <SectionLabel>Colours</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <ColorField
                label="Shell"
                value={livery.shell}
                onChange={(value) =>
                  settings.setUavLivery(uav.id, { shell: value })
                }
              />
              <ColorField
                label="Accent"
                value={livery.accent}
                onChange={(value) =>
                  settings.setUavLivery(uav.id, { accent: value })
                }
              />
            </div>
            <div>
              <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
                Schemes
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {LIVERY_PRESETS.map((preset) => {
                  const worn = sameLivery(preset.livery, livery);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        settings.setUavLivery(uav.id, preset.livery)
                      }
                      className={`border px-2 py-2 transition-colors ${
                        worn
                          ? "border-cyan/70 bg-cyan/10"
                          : "border-hairline hover:border-hairline-bright"
                      }`}
                    >
                      <span className="flex h-4 w-full overflow-hidden border border-hairline">
                        <span
                          className="h-full flex-[3]"
                          style={{ backgroundColor: preset.livery.shell }}
                        />
                        <span
                          className="h-full flex-1"
                          style={{ backgroundColor: preset.livery.accent }}
                        />
                      </span>
                      <span
                        className={`mt-1 block text-2xs uppercase tracking-[0.08em] ${
                          worn ? "text-cyan" : "text-osd-faint"
                        }`}
                      >
                        {preset.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <PrimaryButton onClick={() => settings.resetUavLivery(uav.id)}>
              Restore delivered colours
            </PrimaryButton>
            <p className="text-2xs leading-relaxed text-osd-faint">
              The shell is the airframe itself &mdash; the wing and the pod under
              it, or the plates and the arms; the accent is the tape across the
              roots and the winglets, or the pack and the propellers. It is your aircraft that is
              painted and nobody else&rsquo;s: contacts keep the red that says
              what they are, and a festival field is still twenty other people
              in their own colours. Saved with the aircraft, so a scheme is part
              of the build rather than a setting the next one inherits.
            </p>
          </section>

          <section className="space-y-4">
            <SectionLabel>Power system</SectionLabel>
            <div>
              <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
                {fuelled
                  ? "Engine and propeller"
                  : rotorcraft
                    ? "Motors, ESCs and propellers"
                    : "Motor, ESC and propeller"}
              </p>
              <OptionGroup
                columns={1}
                value={motor.id}
                onChange={(value) => settings.setUavMotor(uav.id, value)}
                options={uav.motors.map((entry) => ({
                  value: entry.id,
                  label: entry.motor,
                  hint: entry.summary,
                }))}
              />
            </div>
            <p className="text-2xs leading-relaxed text-osd-faint">
              What is bolted to{" "}
              <span className="text-osd-dim">{uav.config.name}</span>, and what
              it is flown on. The combination decides everything: a big
              low-pitch propeller on a slow motor pulls hard and cruises for
              hours, a small high-pitch one on a fast motor is quicker and
              empties the pack doing it.{" "}
              {rotorcraft
                ? "Four of each on this one, and the rating quoted is the four speed controllers together. "
                : ""}
              {fuelled
                ? "This one is a petrol two-stroke rather than a motor, so it has no controller and no cells — what it has is a displacement, an idle it never drops below, and a thirst. Two sizes up on the same airframe is an hour and a half of flying gone. "
                : ""}
              The {fuelled ? "engine" : "motor"} and the{" "}
              {fuelled ? "tank" : "pack"} both take effect on the next flight.
            </p>
            <div>
              <p className="mb-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
                {fuelled ? "Fuel tank" : "Battery"}
              </p>
              <OptionGroup
                columns={3}
                value={power.battery}
                onChange={(value) => settings.setUavBattery(uav.id, value)}
                options={[
                  ...packs.map((pack) => ({
                    value: pack.id,
                    label: formatBattery(pack),
                    hint: `${loadedMass(pack).toFixed(2)} kg${
                      pack.fuel ? " full" : ` · ${pack.cRating}C`
                    } · ${formatEndurance(
                      cruiseEndurance(
                        resolveLoadout(uav, { motor: motor.id, battery: pack.id })
                          .config,
                        motor,
                        pack,
                      ),
                    )}`,
                  })),
                  {
                    value: BATTERY_UNLIMITED,
                    label: "Unlimited",
                    hint: fuelled ? "No tank simulated" : "No pack simulated",
                  },
                ]}
              />
            </div>
            <p className="text-2xs leading-relaxed text-osd-faint">
              The {fuelled ? "tank" : "pack"} is part of the aircraft: a bigger
              one is more flying and more weight, and both are flown rather than
              quoted.{" "}
              {fuelled
                ? "It empties at the rate the throttle is actually being used and never slower than the engine's idle, so a long descent and a wait on the runway both cost something. It does not sag: the aeroplane pulls as hard on the last litre as on the first. And when it is dry the engine stops for good — no idle, no restart, and a wing with no engine on it is a glider"
                : rotorcraft
                  ? "It runs down at the rate the throttle is actually being used, sags under load, and when it is flat the motor stops — and a quadcopter with no motors is a falling object, so a long way out on a small pack is a decision with an answer"
                  : "It runs down at the rate the throttle is actually being used, sags under load, and when it is flat the motor stops — and the wing is a glider, so a long way out on a small pack is a decision"}
              . <span className="text-osd-dim">Unlimited</span> switches the{" "}
              {fuelled ? "tank" : "pack"} simulation off and flies the airframe
              at its delivered weight for as long as the mission lasts.
            </p>
          </section>

          <section className="space-y-4">
            <SectionLabel>Rates</SectionLabel>
            <Slider
              label="Roll rate"
              min={RATE_LIMITS.rate.min}
              max={RATE_LIMITS.rate.max}
              step={10}
              value={rates.rollRate}
              onChange={(value) =>
                settings.setUavRates(uav.id, { rollRate: value })
              }
              format={(value) => `${value.toFixed(0)}°/s`}
            />
            <Slider
              label="Pitch rate"
              min={RATE_LIMITS.rate.min}
              max={RATE_LIMITS.rate.max}
              step={10}
              value={rates.pitchRate}
              onChange={(value) =>
                settings.setUavRates(uav.id, { pitchRate: value })
              }
              format={(value) => `${value.toFixed(0)}°/s`}
            />
            <p className="-mt-2 text-2xs leading-relaxed text-osd-faint">
              How fast the aircraft answers the sticks, in degrees a second at
              full deflection &mdash; the same numbers Betaflight and INAV are
              set up with. They are what acro flies on: the controller holds the
              rate the stick is asking for, so the wing answers the same at 140
              km/h as at 70. Manual ignores them entirely and angle flies to the
              attitude limits under Settings instead.
            </p>
            <Slider
              label="Roll expo"
              min={RATE_LIMITS.expo.min}
              max={RATE_LIMITS.expo.max}
              step={0.05}
              value={rates.rollExpo}
              onChange={(value) =>
                settings.setUavRates(uav.id, { rollExpo: value })
              }
              format={(value) => value.toFixed(2)}
            />
            <Slider
              label="Pitch expo"
              min={RATE_LIMITS.expo.min}
              max={RATE_LIMITS.expo.max}
              step={0.05}
              value={rates.pitchExpo}
              onChange={(value) =>
                settings.setUavRates(uav.id, { pitchExpo: value })
              }
              format={(value) => value.toFixed(2)}
            />
            <p className="-mt-2 text-2xs leading-relaxed text-osd-faint">
              Expo softens the middle of the stick without touching the ends:
              full deflection is still exactly the rate above, and everything
              before it is gentler. It is what makes a fast aircraft aimable.
            </p>
            <PrimaryButton onClick={() => settings.resetUavRates(uav.id)}>
              Restore delivered rates
            </PrimaryButton>
          </section>

          <section className="space-y-3">
            <SectionLabel>Hangar</SectionLabel>
            {/* Every airframe as delivered, always here and in the order the
                hangar keeps them: nothing has to be built before there is an
                aircraft to fly. */}
            <p className="text-2xs uppercase tracking-[0.14em] text-osd-dim">
              As delivered
            </p>
            <div className="space-y-1.5">
              {STOCK_BUILDS.map((build) => (
                <BuildRow
                  key={build.id}
                  build={build}
                  stock
                  fitted={fitted?.id === build.id}
                  onSelect={() => {
                    closeBuildForms();
                    settings.selectBuild(build.id);
                  }}
                />
              ))}
            </div>
            {builds.length > 0 ? (
              <>
                <p className="pt-1 text-2xs uppercase tracking-[0.14em] text-osd-dim">
                  Saved
                </p>
                <div className="space-y-1.5">
                  {builds.map((build) => (
                    <BuildRow
                      key={build.id}
                      build={build}
                      fitted={fitted?.id === build.id}
                      renaming={renamingBuild === build.id}
                      deleting={deletingBuild === build.id}
                      builds={builds}
                      onSelect={() => {
                        closeBuildForms();
                        settings.selectBuild(build.id);
                      }}
                      onBeginRename={() => {
                        closeBuildForms();
                        setRenamingBuild(build.id);
                      }}
                      onRename={(name) => {
                        settings.renameBuild(build.id, name);
                        closeBuildForms();
                      }}
                      onBeginDelete={() => {
                        closeBuildForms();
                        setDeletingBuild(build.id);
                      }}
                      onConfirmDelete={() => {
                        settings.deleteBuild(build.id);
                        closeBuildForms();
                      }}
                      onCancel={closeBuildForms}
                    />
                  ))}
                </div>
              </>
            ) : null}

            {savingBuild ? (
              <div className="border border-hairline p-4">
                <BuildNameForm
                  label="Name this aircraft"
                  builds={builds}
                  onSubmit={(name) => {
                    const existing = builds.find((build) =>
                      sameBuildName(build.name, normaliseBuildName(name)),
                    );
                    if (existing) settings.updateBuild(existing.id);
                    else settings.saveBuild(name);
                    closeBuildForms();
                  }}
                  onCancel={closeBuildForms}
                />
              </div>
            ) : (
              <PrimaryButton
                onClick={() => {
                  closeBuildForms();
                  setSavingBuild(true);
                }}
              >
                Save this aircraft
              </PrimaryButton>
            )}

            <p className="text-2xs leading-relaxed text-osd-faint">
              Every airframe is in the hangar as it is delivered, so any of them
              can be picked here or on the setup screen and flown on any mission
              without being built first. Saving adds one of your own — the
              airframe, the motor, the pack, the rates and the paint under a
              name — so the same wing can be set up two ways without either of
              them being rebuilt; saving under a name that is already in the
              list writes over that aircraft, which is how a tune gets kept. A
              delivered aircraft is the airframe itself and cannot be renamed,
              written over or deleted: fitting one puts that airframe back
              exactly as it came.{" "}
              {fitted
                ? `On the bench: ${fitted.name}${deliveredFitted ? ", as delivered" : ""}.`
                : "The aircraft on the bench is not one of the aircraft in the list."}{" "}
              {buildsFull(builds)
                ? `The hangar holds ${MAX_BUILDS} of your own, and it is full.`
                : ""}
            </p>
          </section>
        </MenuColumns>

        <p className="mt-8 text-2xs text-osd-faint">
          The aircraft is stored in this browser only, with the rest of the
          pilot&rsquo;s settings.
        </p>
      </div>
    </div>
  );
}

/**
 * One aircraft in the hangar list.
 *
 * The row itself fits the aircraft; renaming and deleting sit under it. A
 * delete is confirmed in place rather than in a dialog, the way the roster
 * does it: the question and the answer belong to the row being asked about.
 *
 * A stock row has neither: an airframe as delivered is not the pilot's to
 * rename or throw away, and there is nothing stored behind it to delete.
 */
function BuildRow({
  build,
  stock = false,
  fitted,
  renaming = false,
  deleting = false,
  builds = [],
  onSelect,
  onBeginRename = () => {},
  onRename = () => {},
  onBeginDelete = () => {},
  onConfirmDelete = () => {},
  onCancel = () => {},
}: {
  build: AircraftBuild;
  /** True for an airframe as delivered, which is fitted but never edited. */
  stock?: boolean;
  fitted: boolean;
  onSelect: () => void;
  /**
   * Everything below is the editing a saved aircraft has and a stock one does
   * not, so a delivered row is a row and a button and nothing else.
   */
  renaming?: boolean;
  deleting?: boolean;
  builds?: readonly AircraftBuild[];
  onBeginRename?: () => void;
  onRename?: (name: string) => void;
  onBeginDelete?: () => void;
  onConfirmDelete?: () => void;
  onCancel?: () => void;
}) {
  if (renaming) {
    return (
      <div className="border border-cyan/50 p-4">
        <BuildNameForm
          label={`Rename ${build.name}`}
          initial={build.name}
          builds={builds}
          exceptId={build.id}
          onSubmit={onRename}
          onCancel={onCancel}
        />
      </div>
    );
  }

  if (deleting) {
    return (
      <div className="border border-danger/50 p-4">
        <p className="text-xs leading-relaxed text-osd">
          Delete {build.name}? The aircraft on the bench is not touched, only
          the saved setup.
        </p>
        <div className="mt-3 flex gap-2">
          <PrimaryButton tone="danger" onClick={onConfirmDelete}>
            <span className="block w-full text-center">Delete</span>
          </PrimaryButton>
          <PrimaryButton onClick={onCancel}>
            <span className="block w-full text-center">Keep</span>
          </PrimaryButton>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`border ${
        fitted ? "border-cyan/60 bg-cyan/5" : "border-hairline"
      }`}
    >
      <button
        type="button"
        onClick={fitted ? undefined : onSelect}
        className={`w-full px-4 py-3 text-left ${
          fitted ? "cursor-default" : "transition-colors hover:bg-panel-raised"
        }`}
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-2">
            {/* The paint is half of what tells two saved aircraft apart, so the
                row wears it rather than only naming it. */}
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 border border-hairline-bright"
              style={{ backgroundColor: build.livery.shell }}
            />
            <span
              className={`truncate text-sm uppercase tracking-[0.16em] ${
                fitted ? "text-cyan" : "text-osd"
              }`}
            >
              {build.name}
            </span>
          </span>
          <span className="shrink-0 text-2xs uppercase tracking-[0.14em] text-osd-faint">
            {fitted ? "Fitted" : "Fit"}
          </span>
        </span>
        <span className="mt-0.5 block text-2xs text-osd-faint">
          {describeBuild(build)}
        </span>
      </button>
      {stock ? null : (
        <div className="flex gap-4 border-t border-hairline px-4 py-2">
          <button
            type="button"
            onClick={onBeginRename}
            className="text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:text-osd"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={onBeginDelete}
            className="text-2xs uppercase tracking-[0.16em] text-osd-dim transition-colors hover:text-danger"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The name a saved aircraft is kept under.
 *
 * Saving and renaming ask the same question and differ in what a name already
 * in the list means: saving under one writes over that aircraft, which is how
 * a retuned wing is kept, while renaming onto one would leave two aircraft the
 * pilot cannot tell apart and is refused.
 */
function BuildNameForm({
  label,
  initial = "",
  builds,
  exceptId,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  builds: readonly AircraftBuild[];
  /** The build being renamed, which may keep the name it already has. */
  exceptId?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);

  const wanted = normaliseBuildName(name);
  const renaming = exceptId !== undefined;
  const replacing = renaming
    ? null
    : (builds.find((build) => sameBuildName(build.name, wanted)) ?? null);

  const rejection = renaming
    ? buildNameRejection(name, builds, exceptId)
    : wanted.length < MIN_BUILD_NAME_LENGTH
      ? `A name needs at least ${MIN_BUILD_NAME_LENGTH} characters.`
      : !replacing && buildsFull(builds)
        ? `The hangar holds ${MAX_BUILDS} aircraft and is full. Write over one, or delete one first.`
        : null;
  const showRejection = touched && rejection !== null;

  // Typing a name and pressing return is the whole interaction, so the key
  // does what the button does rather than needing the button to be found.
  const submit = (): void => {
    setTouched(true);
    if (rejection === null) onSubmit(name);
  };

  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-2xs uppercase tracking-[0.14em] text-osd-dim">
          {label}
        </span>
        <input
          autoFocus
          value={name}
          maxLength={MAX_BUILD_NAME_LENGTH}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder="Long range, sport, mapper…"
          className={`w-full border bg-void px-3 py-2 text-sm tracking-[0.1em] text-osd outline-none transition-colors focus:border-cyan ${
            showRejection ? "border-danger" : "border-hairline"
          }`}
        />
      </label>
      <p
        className={`mt-2 min-h-[1rem] text-2xs leading-relaxed ${
          showRejection ? "text-danger" : "text-osd-faint"
        }`}
      >
        {showRejection
          ? rejection
          : replacing
            ? `Writes over ${replacing.name}.`
            : `Up to ${MAX_BUILD_NAME_LENGTH} characters.`}
      </p>
      <div className="mt-2 flex gap-2">
        <PrimaryButton tone="accent" onClick={submit}>
          <span className="block w-full text-center">
            {replacing ? "Overwrite" : "Save"}
          </span>
        </PrimaryButton>
        <PrimaryButton onClick={onCancel}>
          <span className="block w-full text-center">Cancel</span>
        </PrimaryButton>
      </div>
    </div>
  );
}
