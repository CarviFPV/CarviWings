"use client";

/**
 * Screen router.
 *
 * The only stateful component above the flight view. It also reads the pilot
 * roster and the installation's ion token after mount, which keeps the
 * server-rendered markup and the first client render identical, and is what
 * decides whose settings the rest of the application then loads.
 */

import { useEffect } from "react";
import type { ReactNode } from "react";

import { SCREEN, useGameStore } from "@/state/gameStore";
import { usePlayerStore } from "@/state/playerStore";
import { useIonTokenStore, useIonTokenSource } from "@/state/ionTokenStore";
import { ION_TOKEN_SOURCE } from "@/lib/cesium/ionToken";

import { MainMenu } from "@/components/screens/MainMenu";
import { MissionsScreen } from "@/components/screens/MissionsScreen";
import { MissionSetup } from "@/components/screens/MissionSetup";
import { ControlsScreen } from "@/components/screens/ControlsScreen";
import { ControllerScreen } from "@/components/screens/ControllerScreen";
import { SettingsScreen } from "@/components/screens/SettingsScreen";
import { AircraftScreen } from "@/components/screens/AircraftScreen";
import { PilotScreen } from "@/components/screens/PilotScreen";
import { DebriefScreen } from "@/components/screens/DebriefScreen";
import { IonTokenScreen } from "@/components/screens/IonTokenScreen";
import { FlightView } from "@/components/flight/FlightView";
import { WorldView } from "@/components/world/WorldView";
import { MusicLayer } from "@/components/audio/MusicLayer";

export function GameRoot() {
  const screen = useGameStore((state) => state.screen);
  const debrief = useGameStore((state) => state.debrief);
  const hydrated = usePlayerStore((state) => state.hydrated);
  const pilotCount = usePlayerStore((state) => state.roster.players.length);
  const tokenHydrated = useIonTokenStore((state) => state.hydrated);
  const tokenPrompted = useIonTokenStore((state) => state.prompted);
  const tokenSource = useIonTokenSource();

  useEffect(() => {
    // Deferred so the persisted values never differ from the SSR output. The
    // settings, the key layout and the controller profiles are not rehydrated
    // here: they belong to a pilot, and this is what works out which one, so
    // it loads them once it knows. The token belongs to the installation
    // rather than to any pilot, so it is simply loaded alongside.
    void usePlayerStore.getState().hydrate();
    void useIonTokenStore.getState().hydrate();
  }, []);

  // There is no world to fly over until this installation has a token, so an
  // installation that has never been asked for one is asked here, before
  // anything else — ahead of the roster below, because the token is the
  // machine's and the callsign is the person's. Once. Answering it, with a
  // token or with "look around first", is the end of it: a pilot who later
  // clears the token meant to, and gets the warning on the menu rather than
  // the welcome screen again. Same rule as the roster about waiting for
  // storage: guessing before it has been read would flash the prompt at
  // everybody who has already answered it.
  if (tokenHydrated && !tokenPrompted && tokenSource === ION_TOKEN_SOURCE.None) {
    return (
      <Shell>
        <IonTokenScreen />
      </Shell>
    );
  }

  // Nothing can be configured before there is somebody to configure it for, so
  // a first run goes to the roster and cannot leave it until a pilot exists.
  // Until storage has been read there is no way to tell a first run from a
  // returning one, and guessing would flash the wrong screen at both.
  if (hydrated && pilotCount === 0) {
    return (
      <Shell>
        <PilotScreen />
      </Shell>
    );
  }

  return (
    <Shell>
      {screen === SCREEN.Menu ? <MainMenu /> : null}
      {screen === SCREEN.Missions ? <MissionsScreen /> : null}
      {screen === SCREEN.World ? <WorldView /> : null}
      {screen === SCREEN.Setup ? <MissionSetup /> : null}
      {screen === SCREEN.Controls ? <ControlsScreen /> : null}
      {screen === SCREEN.Controller ? <ControllerScreen /> : null}
      {screen === SCREEN.Aircraft ? <AircraftScreen /> : null}
      {screen === SCREEN.Settings ? <SettingsScreen /> : null}
      {screen === SCREEN.Pilot ? <PilotScreen /> : null}
      {screen === SCREEN.Flying ? <FlightView /> : null}
      {screen === SCREEN.Debrief && debrief ? (
        <DebriefScreen
          statistics={debrief.statistics}
          status={debrief.status}
          reason={debrief.reason}
        />
      ) : null}
    </Shell>
  );
}

/**
 * The frame every screen is drawn in, and the one thing that outlives them.
 *
 * The music is mounted here rather than in a screen: it plays across the menu,
 * the globe and the flight, and a station is changed when the mission is, not
 * when the screen is.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="h-screen w-screen overflow-hidden bg-void">
      {children}
      <MusicLayer />
    </main>
  );
}
