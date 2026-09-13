"use client";

/**
 * Shown when Cesium cannot be configured.
 *
 * The globe is never replaced with a procedural stand-in when the token is
 * missing or ion is unreachable — that would hide a real problem behind a fake
 * Earth. The failure is stated plainly along with how to fix it, and when the
 * fix is a token it is fixed here: the field is on the screen the flight
 * failed on rather than in a text file the pilot has to go and find.
 */

import { ION_TOKEN_ENV_VAR } from "@/lib/cesium/ionToken";
import { SCREEN, useGameStore } from "@/state/gameStore";
import { PrimaryButton } from "@/components/ui/Primitives";
import { IonTokenHelp, IonTokenPanel } from "./IonTokenScreen";

export function ConfigurationError({
  title,
  detail,
  onRetry,
  tokenSetup = false,
}: {
  title: string;
  detail: string;
  /** What "try again" does. Defaults to relaunching the current mission. */
  onRetry?: () => void;
  /**
   * Whether the ion token is a plausible fix for this failure.
   *
   * A missing token or an ion that turned the request down is a token
   * question; a browser without WebGL is not, and offering a token field for
   * one would be an answer to a question nobody asked.
   */
  tokenSetup?: boolean;
}) {
  const goto = useGameStore((state) => state.goto);
  const restart = useGameStore((state) => state.restartMission);
  const retry = onRetry ?? restart;

  return (
    // `items-start` with an auto margin rather than `items-center`: a centred
    // flex child taller than the viewport has its top cut off and cannot be
    // scrolled back to, and this screen grew a token field.
    <div className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-void">
      <div className="my-auto w-full max-w-xl px-8 py-12">
        <p className="text-2xs uppercase tracking-[0.4em] text-danger">
          Configuration error
        </p>
        <h2 className="mt-2 mb-4 text-2xl font-light tracking-[0.04em]">
          {title}
        </h2>
        <p className="mb-8 text-sm leading-relaxed text-osd-dim">{detail}</p>

        {tokenSetup ? (
          <>
            <div className="mb-4 border border-hairline bg-panel px-5 py-5">
              <IonTokenPanel />
            </div>
            <div className="mb-4">
              <IonTokenHelp />
            </div>
            <p className="mb-8 text-2xs leading-relaxed text-osd-faint">
              A build run from a checkout can take a token from{" "}
              <code className="text-osd">{ION_TOKEN_ENV_VAR}</code> in{" "}
              <code className="text-osd">.env.local</code> instead. That one is
              inlined when the bundle is built, so it needs the dev server
              restarting; a token entered above does not.
            </p>
          </>
        ) : null}

        <div className="flex gap-2">
          <PrimaryButton onClick={() => retry()}>Try again</PrimaryButton>
          <PrimaryButton onClick={() => goto(SCREEN.Menu)}>
            Main menu
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
