"use client";

import { MISSION_MODE, SCREEN, useGameStore } from "@/state/gameStore";
import { useActivePilot } from "@/state/playerStore";
import { useSettingsStore } from "@/state/settingsStore";
import { selectedBuild } from "@/sim/flight/builds";
import { uavOrDefault } from "@/sim/flight/uav";
import { MISSION_MODE_INFO } from "@/sim/mission";
import { PrimaryButton } from "@/components/ui/Primitives";
import { useIonTokenConfigured } from "@/state/ionTokenStore";

export function MainMenu() {
  const goto = useGameStore((state) => state.goto);
  const openWorld = useGameStore((state) => state.openWorld);
  const openAircraft = useGameStore((state) => state.openAircraft);
  const pilot = useActivePilot();
  const uavSettings = useSettingsStore((state) => state.uav);
  const builds = useSettingsStore((state) => state.builds);
  // What is on the bench, said on the way past: it is what every flight
  // started from either of the two entries above goes up on.
  const fitted = selectedBuild(builds, uavSettings);
  // False only once storage has been read and there is genuinely no token, so
  // the warning is never flashed at a pilot who has one saved.
  const tokenConfigured = useIonTokenConfigured();

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-void">
      <BackdropGrid />

      <div className="relative z-10 w-full max-w-lg px-8">
        <div className="mb-14">
          <p className="mb-3 text-2xs uppercase tracking-[0.5em] text-accent">
            Fixed Wing · Physical Interception
          </p>
          <h1 className="text-5xl leading-[0.95] font-light tracking-[0.08em] text-osd">
            CARVI
            <span className="block text-cyan">WINGS</span>
          </h1>
          <div className="mt-5 flex items-center gap-3">
            <span className="h-px w-16 bg-accent" />
            <p className="text-2xs uppercase tracking-[0.2em] text-osd-dim">
              No guns. The aircraft is the weapon.
            </p>
          </div>
        </div>

        {!tokenConfigured ? (
          <button
            type="button"
            onClick={() => goto(SCREEN.Settings)}
            className="mb-6 block w-full border border-amber/40 bg-amber/5 px-4 py-3 text-left transition-colors hover:border-amber hover:bg-amber/10"
          >
            <p className="text-2xs uppercase tracking-[0.16em] text-amber">
              Cesium ion token missing
            </p>
            <p className="mt-1 text-xs leading-relaxed text-osd-dim">
              The world cannot be loaded until this installation has an access
              token. It is a free one-minute sign-up, and it is entered here:{" "}
              <span className="text-osd">Settings &rarr; Cesium ion</span>.
            </p>
          </button>
        ) : null}

        <nav className="space-y-2">
          <PrimaryButton tone="accent" onClick={() => goto(SCREEN.Missions)}>
            <span className="flex items-baseline justify-between">
              <span>Missions</span>
              <span className="text-2xs tracking-[0.12em] text-osd-faint">
                Something to fly for
              </span>
            </span>
          </PrimaryButton>

          <PrimaryButton onClick={() => openWorld(MISSION_MODE.FreeFlight)}>
            <span className="flex items-baseline justify-between">
              <span>{MISSION_MODE_INFO[MISSION_MODE.FreeFlight].label}</span>
              <span className="text-2xs tracking-[0.12em] text-osd-faint">
                {MISSION_MODE_INFO[MISSION_MODE.FreeFlight].tagline}
              </span>
            </span>
          </PrimaryButton>

          {/* The other way of going flying: same globe, same aircraft, but
              stood on the field with it rather than sat behind the goggles. */}
          <PrimaryButton onClick={() => openWorld(MISSION_MODE.GroundView)}>
            <span className="flex items-baseline justify-between">
              <span>{MISSION_MODE_INFO[MISSION_MODE.GroundView].label}</span>
              <span className="text-2xs tracking-[0.12em] text-osd-faint">
                {MISSION_MODE_INFO[MISSION_MODE.GroundView].tagline}
              </span>
            </span>
          </PrimaryButton>

          <PrimaryButton onClick={() => openAircraft(SCREEN.Menu)}>
            <span className="flex items-baseline justify-between gap-4">
              <span>Aircraft builder</span>
              <span className="truncate text-2xs tracking-[0.12em] text-osd-faint">
                {fitted
                  ? fitted.name
                  : uavOrDefault(uavSettings.active).config.name}
              </span>
            </span>
          </PrimaryButton>

          <PrimaryButton onClick={() => goto(SCREEN.Controls)}>
            Controls
          </PrimaryButton>

          <PrimaryButton onClick={() => goto(SCREEN.Settings)}>
            Settings
          </PrimaryButton>

          {/* Who is flying is worth saying on the way past rather than only
              inside the screen that changes it: everything below the menu —
              the settings, the key layout, the logbook — belongs to them. */}
          <PrimaryButton onClick={() => goto(SCREEN.Pilot)}>
            <span className="flex items-baseline justify-between gap-4">
              <span>Pilot</span>
              <span className="truncate text-2xs tracking-[0.12em] text-osd-faint">
                {pilot ? pilot.callsign : "Roster and logbook"}
              </span>
            </span>
          </PrimaryButton>
        </nav>

        <p className="mt-12 text-2xs leading-relaxed text-osd-faint">
          Any of them opens the world: spin the globe, search for anywhere on
          it, and click where you want to start. Terrain and satellite imagery are
          streamed from Cesium ion; the flight model, coordinates and collisions
          run locally in a mission-local ENU frame.
        </p>
      </div>
    </div>
  );
}

/** Decorative instrument grid — pure CSS, no per-frame work. */
function BackdropGrid() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #1e2733 1px, transparent 1px), linear-gradient(to bottom, #1e2733 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 40%, rgba(55,211,232,0.10), transparent 60%), radial-gradient(ellipse at 80% 90%, rgba(255,122,24,0.08), transparent 55%)",
        }}
      />
    </>
  );
}
