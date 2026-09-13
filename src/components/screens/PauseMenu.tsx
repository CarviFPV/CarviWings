"use client";

import { useState } from "react";
import { SCREEN, useGameStore } from "@/state/gameStore";
import { PrimaryButton } from "@/components/ui/Primitives";
import {
  WEATHER_PROFILES,
  weatherStateFromPreset,
  withSkyCoverage,
} from "@/sim/environment/types";
import { SettingsScreen } from "./SettingsScreen";
import { WeatherEditor } from "./WeatherEditor";
import { TimeEditor } from "./TimeEditor";

type Pane = "menu" | "settings" | "environment";

export function PauseMenu() {
  const setPaused = useGameStore((state) => state.setPaused);
  const restart = useGameStore((state) => state.restartMission);
  const exitToMenu = useGameStore((state) => state.exitToMenu);
  const goto = useGameStore((state) => state.goto);
  const [pane, setPane] = useState<Pane>("menu");

  // The overlay is as wide as the pane inside it needs: the button list reads
  // as a column, while the settings and the weather lay themselves out across
  // whatever width the window has so neither has to be scrolled through.
  const width =
    pane === "menu"
      ? "max-w-md"
      : pane === "settings"
        ? "max-w-[88rem]"
        : "max-w-4xl";

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-void/85 backdrop-blur-sm">
      <div className={`w-full px-8 ${width}`}>
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            <p className="mb-1 text-2xs uppercase tracking-[0.4em] text-accent">
              Flight suspended
            </p>
            <h2 className="text-3xl font-light tracking-[0.08em]">PAUSED</h2>
          </div>
          {/* Out of the scrolling pane, so the way back never has to be
              scrolled to. */}
          {pane !== "menu" ? (
            <button
              type="button"
              onClick={() => setPane("menu")}
              className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
            >
              &larr; Pause menu
            </button>
          ) : null}
        </div>

        {pane === "menu" ? (
          <nav className="space-y-2">
            <PrimaryButton tone="accent" onClick={() => setPaused(false)}>
              Resume
            </PrimaryButton>
            <PrimaryButton onClick={() => setPane("environment")}>
              Time &amp; weather
            </PrimaryButton>
            <PrimaryButton onClick={() => setPane("settings")}>
              Settings
            </PrimaryButton>
            <PrimaryButton onClick={() => restart()}>
              Restart mission
            </PrimaryButton>
            <PrimaryButton
              tone="danger"
              onClick={() => {
                exitToMenu();
                goto(SCREEN.Menu);
              }}
            >
              Exit to menu
            </PrimaryButton>
          </nav>
        ) : (
          <div className="max-h-[74vh] overflow-y-auto border border-hairline bg-panel p-6">
            {pane === "settings" ? <SettingsScreen embedded /> : <EnvironmentPane />}
          </div>
        )}

        <p className="mt-8 text-2xs text-osd-faint">
          Press <span className="text-osd">ESC</span> to resume.
        </p>
      </div>
    </div>
  );
}

/**
 * The sky, changed on a flight that is already in the air.
 *
 * The same choices as mission setup and the same effect, except that they land
 * on the running flight: the light, the cloud, the fog and the wind all move to
 * the new profile without the aircraft leaving the air.
 */
function EnvironmentPane() {
  const mission = useGameStore((state) => state.mission);
  const setSky = useGameStore((state) => state.setSky);
  const setTimeOfDay = useGameStore((state) => state.setTimeOfDay);
  if (!mission) return null;

  // A mission always carries the sky it is being flown in. A configuration
  // that only names a preset is one this panel can still edit, so it is
  // resolved into the state the panel works in rather than refused.
  const sky =
    mission.sky ??
    withSkyCoverage(
      weatherStateFromPreset(mission.weather),
      mission.cloudCover ?? WEATHER_PROFILES[mission.weather].cloudCoverage,
    );

  return (
    <div className="space-y-6">
      <TimeEditor
        timeOfDay={mission.timeOfDay}
        clock={mission.clock}
        latitude={mission.latitude}
        longitude={mission.longitude}
        onTime={setTimeOfDay}
        columns={3}
      />

      <WeatherEditor
        sky={sky}
        latitude={mission.latitude}
        longitude={mission.longitude}
        terrainHeight={null}
        seed={mission.seed}
        columns={4}
        onSky={setSky}
      />

      <p className="text-2xs text-osd-faint">
        Changes take effect straight away and are kept if the mission is
        restarted.
      </p>
    </div>
  );
}
