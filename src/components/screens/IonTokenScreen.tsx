"use client";

/**
 * Where the Cesium ion token is entered.
 *
 * The simulator streams the real Earth, and streaming it needs an account with
 * somebody's name on it. That used to mean an environment variable and a
 * rebuild, which is a reasonable thing to ask of whoever is developing it and
 * an unreasonable one to ask of somebody who just downloaded a flight
 * simulator — so the token is typed in here instead, kept in this browser, and
 * changed from the settings screen afterwards.
 *
 * One panel, three places: the first-run prompt below, the settings screen, and
 * the configuration error that a flight fails with, which is exactly where a
 * wrong token needs fixing.
 */

import { useState } from "react";

import {
  ION_TOKEN_ENV_VAR,
  ION_TOKEN_SOURCE,
  normaliseIonToken,
  type IonTokenSource,
} from "@/lib/cesium/ionToken";
import { ionTokenComplaint } from "@/sim/config/ionToken";
import {
  useIonTokenSource,
  useIonTokenStore,
} from "@/state/ionTokenStore";
import { PrimaryButton } from "@/components/ui/Primitives";

/** Where to go and what to ask for, for somebody who has never seen ion. */
export function IonTokenHelp() {
  return (
    <div className="border border-hairline bg-panel">
      <div className="border-b border-hairline px-4 py-2">
        <span className="text-2xs uppercase tracking-[0.18em] text-osd-dim">
          How to get a token
        </span>
      </div>
      <ol className="space-y-3 px-4 py-4 text-xs leading-relaxed text-osd-dim">
        <li>
          <span className="text-osd">1.</span> Make a free Cesium ion account at{" "}
          <TokenLink href="https://ion.cesium.com/signup">
            ion.cesium.com/signup
          </TokenLink>
          . The free Community plan covers personal, non-commercial flying; no
          card is asked for.
        </li>
        <li>
          <span className="text-osd">2.</span> Open{" "}
          <TokenLink href="https://ion.cesium.com/tokens">
            ion.cesium.com/tokens
          </TokenLink>
          . A new account already has one called{" "}
          <span className="text-osd">Default Token</span>, which is enough — or
          press <span className="text-osd">Create token</span> and give it access
          to <span className="text-osd">Cesium World Terrain</span> and{" "}
          <span className="text-osd">Bing Maps Aerial</span> imagery.
        </li>
        <li>
          <span className="text-osd">3.</span> Click the token to copy it. It is
          a long string of letters and digits in three blocks, starting with{" "}
          <span className="text-osd">eyJ</span>.
        </li>
        <li>
          <span className="text-osd">4.</span> Paste it above and press{" "}
          <span className="text-osd">Save token</span>. It is kept in this
          browser, on this machine, and is sent nowhere but to Cesium.
        </li>
      </ol>
    </div>
  );
}

function TokenLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-cyan underline decoration-cyan/40 underline-offset-2"
    >
      {children}
    </a>
  );
}

/**
 * The field itself: paste, save, reveal, clear.
 *
 * The token is masked by default rather than because it is a password — it is
 * public client configuration and it is going into a browser bundle either way
 * — but a 200-character string is unreadable in a text box regardless, and the
 * pilot who is screen-sharing a flight would rather it were not on the screen.
 */
export function IonTokenPanel({
  onSaved,
  autoFocus = false,
}: {
  /** Called once a token has actually been stored. */
  onSaved?: () => void;
  autoFocus?: boolean;
}) {
  const stored = useIonTokenStore((state) => state.token);
  const save = useIonTokenStore((state) => state.save);
  const clear = useIonTokenStore((state) => state.clear);
  const source = useIonTokenSource();

  const [draft, setDraft] = useState(stored);
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);

  const cleaned = normaliseIonToken(draft);
  const complaint = draft.trim().length > 0 ? ionTokenComplaint(cleaned) : null;
  const unchanged = cleaned === stored && stored.length > 0;

  const commit = (): void => {
    if (!save(draft)) return;
    // Shown back as it was stored, so a paste that arrived wrapped in quotes or
    // with a `NAME=` in front visibly loses them rather than silently.
    setDraft(normaliseIonToken(draft));
    setSaved(true);
    onSaved?.();
  };

  return (
    <div>
      <label className="block">
        <span className="mb-1 flex items-baseline justify-between gap-4">
          <span className="text-2xs uppercase tracking-[0.14em] text-osd-dim">
            Cesium ion access token
          </span>
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            className="text-2xs uppercase tracking-[0.14em] text-osd-faint transition-colors hover:text-osd"
          >
            {revealed ? "Hide" : "Show"}
          </button>
        </span>
        <input
          type={revealed ? "text" : "password"}
          value={draft}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
          className="w-full border border-hairline bg-void px-3 py-2 font-mono text-sm tracking-tight text-osd outline-none transition-colors focus:border-cyan"
        />
      </label>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <PrimaryButton
          tone="accent"
          disabled={cleaned.length === 0 || unchanged}
          onClick={commit}
        >
          {stored.length > 0 ? "Replace token" : "Save token"}
        </PrimaryButton>
        {stored.length > 0 ? (
          <PrimaryButton
            tone="danger"
            onClick={() => {
              clear();
              setDraft("");
              setSaved(false);
            }}
          >
            Forget it
          </PrimaryButton>
        ) : null}
      </div>

      {complaint ? (
        <p className="mt-3 text-2xs leading-relaxed text-amber">{complaint}</p>
      ) : null}

      {saved ? (
        <p className="mt-3 text-2xs leading-relaxed text-lime">
          Saved. It takes effect on the next flight — nothing needs restarting.
        </p>
      ) : null}

      <p className="mt-3 text-2xs leading-relaxed text-osd-faint">
        <TokenStatus source={source} stored={stored} />
      </p>
    </div>
  );
}

/** What the simulator will actually fly on, said plainly. */
function TokenStatus({
  source,
  stored,
}: {
  source: IonTokenSource;
  stored: string;
}) {
  if (source === ION_TOKEN_SOURCE.Entered) {
    return (
      <>
        A token is saved in this browser ({stored.length} characters) and every
        pilot here flies on it. It is stored on this machine only, and never
        leaves it except to Cesium.
      </>
    );
  }
  if (source === ION_TOKEN_SOURCE.Environment) {
    return (
      <>
        This build carries a token in <code>{ION_TOKEN_ENV_VAR}</code>, so the
        world already loads. Saving one here overrides it, for this browser
        only.
      </>
    );
  }
  return (
    <>
      No token is configured, so there is no world to fly over yet. A build run
      from a checkout can also take one from <code>{ION_TOKEN_ENV_VAR}</code> in{" "}
      <code>.env.local</code>.
    </>
  );
}

/**
 * The first thing a new installation shows.
 *
 * Before the roster, deliberately: a token belongs to the installation and a
 * callsign to a person, and asking somebody to name themselves for a simulator
 * that cannot yet draw the Earth is the wrong order to do the two in.
 */
export function IonTokenScreen() {
  const dismiss = useIonTokenStore((state) => state.dismissPrompt);

  return (
    <div className="h-full w-full overflow-y-auto bg-void">
      <div className="mx-auto w-full max-w-2xl px-8 py-12">
        <p className="text-2xs uppercase tracking-[0.4em] text-accent">
          First run
        </p>
        <h1 className="mt-2 text-3xl font-light tracking-[0.06em]">
          CONNECT THE WORLD
        </h1>
        <p className="mt-4 mb-8 text-sm leading-relaxed text-osd-dim">
          CarviWings is flown over the real Earth: the terrain under the wing
          and the imagery on it are streamed live from Cesium ion. That needs a
          free access token of your own — one for this installation, not one per
          pilot. It takes about a minute, and the simulator will remember it.
        </p>

        <div className="mb-8 border border-hairline bg-panel px-5 py-5">
          <IonTokenPanel autoFocus />
        </div>

        <IonTokenHelp />

        <div className="mt-8">
          <PrimaryButton onClick={() => dismiss()}>
            Look around first
          </PrimaryButton>
          <p className="mt-2 text-2xs leading-relaxed text-osd-faint">
            The menus, the aircraft builder and the controls all work without a
            token. Anything that opens the globe will not, and will bring you
            back here. The token can be entered later under{" "}
            <span className="text-osd-dim">Settings &rarr; Cesium ion</span>.
          </p>
        </div>
      </div>
    </div>
  );
}
