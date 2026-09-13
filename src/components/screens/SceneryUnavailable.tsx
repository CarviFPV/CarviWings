"use client";

/**
 * Shown when the photogrammetry could not be opened.
 *
 * The simulator used to answer this by quietly loading OpenStreetMap buildings
 * instead and flying on, which is the wrong call twice over: the pilot chose
 * the photorealistic world, and the substitution was invisible until they were
 * already airborne over extruded footprints. The failure is stated instead, and
 * the substitution is offered as a button rather than made on their behalf.
 */

import { GOOGLE_MAPS_KEY_ENV_VAR, hasGoogleMapsKey } from "@/lib/cesium/googleKey";
import { WORLD_DETAIL } from "@/lib/cesium/scenery";
import { SCREEN, useGameStore } from "@/state/gameStore";
import { useSettingsStore } from "@/state/settingsStore";
import { PrimaryButton } from "@/components/ui/Primitives";

export function SceneryUnavailable({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  const goto = useGameStore((state) => state.goto);
  const restart = useGameStore((state) => state.restartMission);
  const setSetting = useSettingsStore((state) => state.set);
  const keyed = hasGoogleMapsKey();

  const flyWithBuildings = (): void => {
    setSetting("worldDetail", WORLD_DETAIL.Buildings);
    restart();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-void">
      <div className="w-full max-w-xl px-8 py-12">
        <p className="text-2xs uppercase tracking-[0.4em] text-danger">
          Photorealistic scenery unavailable
        </p>
        <h2 className="mt-2 mb-4 text-2xl font-light tracking-[0.04em]">
          {title}
        </h2>
        <p className="mb-8 text-sm leading-relaxed text-osd-dim">{detail}</p>

        <div className="mb-8 border border-hairline bg-panel">
          <div className="border-b border-hairline px-4 py-2">
            <span className="text-2xs uppercase tracking-[0.18em] text-osd-dim">
              What usually causes this
            </span>
          </div>
          <ul className="space-y-3 px-4 py-4 text-xs leading-relaxed text-osd-dim">
            <li>
              <span className="text-osd">A cold first request.</span> The tiles
              come from a session that has to be opened before anything streams,
              and the first one of the day is the slow one. It has already been
              retried; trying again a minute later usually works.
            </li>
            {keyed ? (
              <li>
                <span className="text-osd">The Maps Platform key.</span> Check
                that the key in{" "}
                <code className="text-osd">{GOOGLE_MAPS_KEY_ENV_VAR}</code> has
                the Map Tiles API enabled and allows this origin.
              </li>
            ) : (
              <li>
                <span className="text-osd">The ion allowance.</span> Without a
                Maps Platform key the mesh is metered against your Cesium ion
                account. Check that it has the{" "}
                <a
                  href="https://ion.cesium.com/assetdepot/2275207"
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan underline decoration-cyan/40 underline-offset-2"
                >
                  Google Photorealistic 3D Tiles
                </a>{" "}
                asset added and monthly allowance left, or set{" "}
                <code className="text-osd">{GOOGLE_MAPS_KEY_ENV_VAR}</code> to
                bill Google directly.
              </li>
            )}
            <li>
              <span className="text-osd">No coverage.</span> Google has no mesh
              everywhere. Where it has none, fly the buildings instead.
            </li>
          </ul>
        </div>

        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => restart()}>Try again</PrimaryButton>
          <PrimaryButton onClick={flyWithBuildings}>
            Fly with buildings
          </PrimaryButton>
          <PrimaryButton onClick={() => goto(SCREEN.Menu)}>
            Main menu
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
