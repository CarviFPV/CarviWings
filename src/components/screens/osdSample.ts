/**
 * A flight that is not happening, for the layout editor to draw over.
 *
 * Every field is filled with something a pilot would recognise as plausible
 * mid-flight, and — importantly — with something that switches every
 * conditional element on: a pack aboard, a video link, a target locked, a race
 * in progress. An element the editor cannot show is an element the pilot
 * cannot place.
 */

import type { FlightTelemetry } from "@/sim/flight/telemetry";
import { createTelemetry } from "@/sim/flight/telemetry";
import { FLIGHT_MODE } from "@/sim/flight/flightModes";
import type { RaceProgress } from "@/sim/mission";

export const SAMPLE_TELEMETRY: FlightTelemetry = {
  ...createTelemetry(),
  airspeed: 24.6,
  groundSpeed: 27.1,
  altitude: 612,
  altitudeAgl: 184,
  verticalSpeed: 1.8,
  throttle: 0.62,
  heading: 47,
  pitch: 4,
  roll: -12,
  latitude: 46.94809,
  longitude: 7.44744,
  terrainHeight: 428,
  windSpeed: 6.2,
  windDirection: 285,
  videoLinkEnabled: true,
  videoQuality: 0.88,
  videoRange: 8000,
  videoDistance: 2400,
  targetDistance: 1420,
  targetBearing: 96,
  targetVisibility: 0.9,
  batteryEnabled: true,
  batteryCharge: 0.63,
  batteryVoltage: 22.4,
  batteryCellVoltage: 3.73,
  batteryCurrent: 18,
  batteryConsumedMah: 2220,
  batteryCapacityMah: 6000,
  batteryEnduranceSeconds: 640,
  loadFactor: 1.4,
  integrity: 1,
  controlAuthority: 1,
  distanceFromOrigin: 2380,
  // One live warning, so the warning stack has something in it to be dragged
  // by. The mildest of them: it says where the aircraft is, not that anything
  // is wrong with it.
  outsideMissionArea: true,
  flightMode: FLIGHT_MODE.Angle,
  courseHold: true,
  altitudeHold: true,
  heldCourse: 47,
  heldAltitude: 610,
  homeDistance: 2380,
  homeBearing: 231,
};

export const SAMPLE_RACE: RaceProgress = {
  started: true,
  finished: false,
  gatesPassed: 4,
  gateCount: 12,
  nextGate: 4,
  elapsed: 48.3,
  position: 2,
  racerCount: 4,
  gapToLeader: 210,
  standings: [],
};
