"use client";

import type { LoadingPhase } from "@/lib/cesium/flightSession";

/**
 * The steps the pilot is shown, in the order they run.
 *
 * `photorealistic` marks a step that only exists on a photogrammetry flight —
 * the mesh has to arrive before there is a world to take off over, and that
 * wait is long enough that it has to be visible rather than looking like the
 * previous step has hung.
 */
const SEQUENCE: readonly {
  phase: LoadingPhase;
  label: string;
  photorealistic?: true;
}[] = [
  { phase: "cesium", label: "Loading CesiumJS" },
  { phase: "terrain", label: "Connecting to global terrain" },
  { phase: "imagery", label: "Loading satellite imagery" },
  { phase: "viewer", label: "Creating the world" },
  { phase: "scenery", label: "Loading buildings and vegetation" },
  { phase: "origin", label: "Surveying the mission area" },
  { phase: "weather", label: "Building the weather" },
  { phase: "tiles", label: "Streaming terrain tiles" },
  {
    phase: "photogrammetry",
    label: "Streaming photorealistic 3D tiles",
    photorealistic: true,
  },
  { phase: "overview", label: "Staging the country around it" },
  { phase: "preload", label: "Streaming the sky around the field" },
  { phase: "physics", label: "Initializing physics" },
  { phase: "spawn", label: "Spawning aircraft" },
  { phase: "enemies", label: "Placing contacts" },
  { phase: "warmup", label: "Warming up the renderer" },
];

const ORDER: LoadingPhase[] = [
  "starting",
  "cesium",
  "terrain",
  "imagery",
  "viewer",
  "scenery",
  "origin",
  "weather",
  "tiles",
  "photogrammetry",
  "overview",
  "preload",
  "physics",
  "spawn",
  "enemies",
  "formation",
  "course",
  "festival",
  "warmup",
  "ready",
];

export function LoadingScreen({
  phase,
  progress,
  locationName,
  detail,
  photorealistic = false,
}: {
  phase: LoadingPhase;
  progress: number;
  locationName: string;
  /** What the current phase is doing, when it has something to say. */
  detail?: string | null;
  /** Whether this flight is waiting on a photogrammetry mesh. */
  photorealistic?: boolean;
}) {
  const currentIndex = ORDER.indexOf(phase);
  const steps = SEQUENCE.filter((step) => photorealistic || !step.photorealistic);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-void">
      <div className="w-full max-w-md px-8">
        <p className="text-2xs uppercase tracking-[0.4em] text-accent">
          Loading world
        </p>
        <h2 className="mt-2 mb-8 text-2xl font-light tracking-[0.06em]">
          {locationName}
        </h2>

        <div className="relative mb-8 h-px w-full overflow-hidden bg-hairline">
          <div
            className="absolute inset-y-0 left-0 bg-cyan transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }}
          />
          <div className="absolute inset-y-0 w-1/4 animate-sweep bg-gradient-to-r from-transparent via-cyan/50 to-transparent" />
        </div>

        {detail ? (
          <p className="-mt-6 mb-6 text-2xs leading-relaxed text-cyan/80">
            {detail}
          </p>
        ) : null}

        <ul className="space-y-2">
          {steps.map((step) => {
            const index = ORDER.indexOf(step.phase);
            const done = currentIndex > index;
            const active = currentIndex === index;
            return (
              <li
                key={step.phase}
                className="flex items-center gap-3 text-xs tracking-[0.06em]"
              >
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 ${
                    done
                      ? "bg-lime"
                      : active
                        ? "animate-warn bg-cyan"
                        : "bg-hairline-bright"
                  }`}
                />
                <span
                  className={
                    done ? "text-osd-dim" : active ? "text-osd" : "text-osd-faint"
                  }
                >
                  {step.label}
                  {active ? "..." : ""}
                </span>
              </li>
            );
          })}
        </ul>

        <p className="mt-8 text-2xs leading-relaxed text-osd-faint">
          {photorealistic
            ? "Terrain, imagery and photogrammetry stream from Cesium ion. " +
              "Flight begins only once the mesh around the spawn has finished " +
              "arriving — the first load of a new area takes the longest."
            : "Terrain and imagery stream from Cesium ion. Flight begins only " +
              "once enough of the world has arrived to fly over."}
        </p>
      </div>
    </div>
  );
}
