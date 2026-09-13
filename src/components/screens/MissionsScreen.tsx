"use client";

/**
 * The mission list.
 *
 * Free flight is on the main menu because it is not a mission; everything that
 * gives the flight a point is here, one row each. Picking one opens the globe
 * with that mode already chosen, which is the same door every mission goes
 * through.
 *
 * The list itself comes from `MISSION_MODES`, so a mode added to the
 * simulation appears here without this screen being told about it.
 */

import { SCREEN, useGameStore } from "@/state/gameStore";
import { MISSION_MODES, MISSION_MODE_INFO } from "@/sim/mission";
import { PrimaryButton } from "@/components/ui/Primitives";

export function MissionsScreen() {
  const goto = useGameStore((state) => state.goto);
  const openWorld = useGameStore((state) => state.openWorld);

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      <div className="mx-auto w-full max-w-2xl px-8 py-12">
        <header className="mb-10 flex items-end justify-between border-b border-hairline pb-5">
          <div>
            <p className="text-2xs uppercase tracking-[0.4em] text-accent">
              Missions
            </p>
            <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">
              PICK A FLIGHT
            </h1>
          </div>
          <button
            type="button"
            onClick={() => goto(SCREEN.Menu)}
            className="text-2xs uppercase tracking-[0.18em] text-osd-dim transition-colors hover:text-osd"
          >
            &larr; Main menu
          </button>
        </header>

        <nav className="space-y-4">
          {MISSION_MODES.map((mode, index) => {
            const info = MISSION_MODE_INFO[mode];
            return (
              <div key={mode}>
                <PrimaryButton
                  tone={index === 0 ? "accent" : "default"}
                  onClick={() => openWorld(mode)}
                >
                  <span className="flex items-baseline justify-between gap-4">
                    <span>{info.label}</span>
                    <span className="text-2xs tracking-[0.12em] text-osd-faint">
                      {info.tagline}
                    </span>
                  </span>
                </PrimaryButton>
                <p className="mt-2 px-1 text-2xs leading-relaxed text-osd-faint">
                  {info.description}
                </p>
              </div>
            );
          })}
        </nav>

        <p className="mt-12 text-2xs leading-relaxed text-osd-faint">
          Every mission starts on the globe: spin it, search for anywhere on
          Earth, and click where you want to fly. What the mission is made of —
          the contacts, the course, the field — is then set up over that place.
        </p>
      </div>
    </div>
  );
}
