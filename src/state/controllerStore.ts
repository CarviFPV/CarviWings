"use client";

/**
 * Controller profiles, persisted to localStorage and keyed by device.
 *
 * A pilot may well have a game pad and a transmitter plugged in on different
 * days, and a calibration is only meaningful for the device it was taken from,
 * so profiles are stored per device rather than as one global mapping.
 *
 * Anything loaded from storage is reconciled against the hardware actually
 * present before it is used: settings outlive the devices they were written
 * for, and a profile naming channels a controller no longer has would command
 * silence rather than announce a problem.
 *
 * Profiles belong to a pilot as well as to a device — the expo and the dead
 * zone on a stick are a preference, not a measurement — so the player store
 * points this store at that pilot's storage key when they take over.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GamepadDevice } from "@/sim/input/gamepad";
import type { ControllerProfile } from "@/sim/input/controllerProfile";
import {
  defaultProfile,
  reconcileProfile,
} from "@/sim/input/controllerProfile";

interface ControllerStore {
  profiles: Record<string, ControllerProfile>;
  saveProfile(profile: ControllerProfile): void;
  forgetProfile(deviceId: string): void;
  /** Drops every calibration, which is what a different pilot starts from. */
  forgetAll(): void;
}

export const useControllerStore = create<ControllerStore>()(
  persist(
    (set) => ({
      profiles: {},
      saveProfile: (profile) =>
        set((state) => ({
          profiles: { ...state.profiles, [profile.deviceId]: profile },
        })),
      forgetProfile: (deviceId) =>
        set((state) => {
          const profiles = { ...state.profiles };
          delete profiles[deviceId];
          return { profiles };
        }),
      forgetAll: () => set({ profiles: {} }),
    }),
    {
      name: "fpv-wing-controllers",
      storage: createJSONStorage(() => localStorage),
      // Loaded by the player store, once it knows whose calibration this is.
      skipHydration: true,
      version: 1,
    },
  ),
);

/**
 * The profile to fly a device with.
 *
 * A device that has never been calibrated still gets a usable mapping, so a
 * game pad plugged in for the first time flies immediately and the interface
 * can say the layout is a guess rather than pretending nothing is connected.
 */
export function profileForDevice(
  device: GamepadDevice,
  stored: Record<string, ControllerProfile>,
): ControllerProfile {
  const existing = stored[device.id];
  if (existing) {
    return reconcileProfile(existing, device.axisCount, device.buttonCount);
  }
  return defaultProfile(
    device.id,
    device.mapping,
    device.axisCount,
    device.buttonCount,
  );
}
