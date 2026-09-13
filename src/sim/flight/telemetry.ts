/**
 * Instrument readout for one aircraft.
 *
 * This is the only shape the HUD ever sees, which keeps React entirely
 * insulated from simulation internals. A snapshot is built at HUD refresh rate
 * (a few times a second), never per physics step.
 */

import type { FlightMode, RthStage } from "./flightModes";
import { FLIGHT_MODE } from "./flightModes";

export interface FlightTelemetry {
  /** True airspeed, m/s. */
  airspeed: number;
  /** Speed over the ground, m/s. Differs from airspeed whenever wind blows. */
  groundSpeed: number;
  /** Altitude above the WGS84 ellipsoid, metres. */
  altitude: number;
  /** Height above the terrain directly below, metres. */
  altitudeAgl: number;
  /** Positive is climbing, m/s. */
  verticalSpeed: number;
  /** 0..1. */
  throttle: number;

  /** Compass degrees, 0 = north. */
  heading: number;
  /** Nose-up positive, degrees. */
  pitch: number;
  /** Right bank positive, degrees. */
  roll: number;

  latitude: number;
  longitude: number;
  /** Terrain elevation below the aircraft, metres above the ellipsoid. */
  terrainHeight: number;

  /** Wind speed at the aircraft's height, m/s. */
  windSpeed: number;
  /** Compass direction the wind blows *from*, degrees. */
  windDirection: number;

  /** True while the video link is range-limited by a transmitter power. */
  videoLinkEnabled: boolean;
  /** Picture quality on the goggles, 1 clean to 0 snow. */
  videoQuality: number;
  /** Range at which the picture goes, metres. Infinite when not simulated. */
  videoRange: number;
  /** Slant range from the ground station to the aircraft, metres. */
  videoDistance: number;
  /** How long the picture has been gone, seconds. */
  videoLostSeconds: number;
  /** How long it may stay gone before the airframe is written off, seconds. */
  videoLossTimeout: number;

  /** Metres to the selected target, when one is selected. */
  targetDistance?: number;
  /** Compass bearing to the selected target, degrees. */
  targetBearing?: number;
  /** How clearly the target can be seen through the weather, 0..1. */
  targetVisibility?: number;

  // --- Power system ---------------------------------------------------------
  /** True while a pack is being simulated. False is an unlimited flight. */
  batteryEnabled: boolean;
  /** Charge remaining, 1 full to 0 flat. */
  batteryCharge: number;
  /** Pack voltage at the terminals, volts. */
  batteryVoltage: number;
  /** The same per cell, which is the number a pilot actually reads. */
  batteryCellVoltage: number;
  /** What the aircraft is drawing, amps. */
  batteryCurrent: number;
  /** Drawn out of the pack so far, mAh. */
  batteryConsumedMah: number;
  /** What the pack holds, mAh. */
  batteryCapacityMah: number;
  /** Flight left at the present draw, seconds. */
  batteryEnduranceSeconds: number;
  /** True once low voltage has stopped the motor and the wing is a glider. */
  batteryCut: boolean;
  /**
   * True when what is running down is a tank of petrol rather than a pack.
   *
   * The gauge is the same gauge — `batteryCharge` is how full it is either
   * way, and the endurance and the cut mean what they always meant — but three
   * of the readings beside it are electrical and an engine has none of them.
   * The OSD shows litres and litres an hour in their place, and this is what
   * tells it to.
   */
  fuelled: boolean;
  /** Petrol left in the tank, litres. Zero on anything electric. */
  fuelLitres: number;
  /** What the tank holds, litres. */
  fuelCapacityLitres: number;
  /** What the engine is drinking, litres per hour. */
  fuelBurnLitresPerHour: number;

  /** Load factor in g. */
  loadFactor: number;
  /** True while the wing is past its stall angle. */
  stalled: boolean;

  /** What is left of the airframe after the contacts it has taken, 0..1. */
  integrity: number;
  /** True once a mid-air has left a mark the pilot can feel. */
  damaged: boolean;
  /** How much of the control the elevons still have, 0..1. */
  controlAuthority: number;
  /** True once the airframe has stopped flying and is only falling. */
  disabled: boolean;
  /**
   * True while the airframe has not started flying: on its belly sliding or
   * stopped, or held ready to be thrown.
   */
  grounded: boolean;
  /** True while a wing is waiting in the launcher's hand for the throttle. */
  held: boolean;
  /** True once it has stopped moving, with the airframe intact. */
  landed: boolean;
  /** Horizontal distance from the mission origin, metres. */
  distanceFromOrigin: number;
  /** True once the aircraft leaves the mission radius. */
  outsideMissionArea: boolean;

  // --- Flight controller ----------------------------------------------------
  /** Which stabilisation the sticks are being flown through. */
  flightMode: FlightMode;
  /** True while the flight controller is flying the roll axis to a heading. */
  courseHold: boolean;
  /** True while it is flying the pitch axis to a height. */
  altitudeHold: boolean;
  /** True while it is bringing the aircraft home on its own. */
  returnHome: boolean;
  /** Which part of the return is being flown, or null when none is. */
  rthStage: RthStage | null;
  /** The course being held, degrees. Meaningless unless `courseHold`. */
  heldCourse: number;
  /**
   * The height being held, metres above the ellipsoid — the same datum as
   * `altitude`, so the two can be read against each other. Meaningless unless
   * `altitudeHold`.
   */
  heldAltitude: number;
  /** Horizontal distance back to the launch point, metres. */
  homeDistance: number;
  /** Compass bearing back to the launch point, degrees. */
  homeBearing: number;
}

export function createTelemetry(): FlightTelemetry {
  return {
    airspeed: 0,
    groundSpeed: 0,
    altitude: 0,
    altitudeAgl: 0,
    verticalSpeed: 0,
    throttle: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    latitude: 0,
    longitude: 0,
    terrainHeight: 0,
    windSpeed: 0,
    windDirection: 0,
    videoLinkEnabled: false,
    videoQuality: 1,
    videoRange: Number.POSITIVE_INFINITY,
    videoDistance: 0,
    videoLostSeconds: 0,
    videoLossTimeout: 0,
    batteryEnabled: false,
    batteryCharge: 1,
    batteryVoltage: 0,
    batteryCellVoltage: 0,
    batteryCurrent: 0,
    batteryConsumedMah: 0,
    batteryCapacityMah: 0,
    batteryEnduranceSeconds: Number.POSITIVE_INFINITY,
    batteryCut: false,
    fuelled: false,
    fuelLitres: 0,
    fuelCapacityLitres: 0,
    fuelBurnLitresPerHour: 0,
    loadFactor: 1,
    stalled: false,
    integrity: 1,
    damaged: false,
    controlAuthority: 1,
    disabled: false,
    grounded: false,
    held: false,
    landed: false,
    distanceFromOrigin: 0,
    outsideMissionArea: false,
    flightMode: FLIGHT_MODE.Acro,
    courseHold: false,
    altitudeHold: false,
    returnHome: false,
    rthStage: null,
    heldCourse: 0,
    heldAltitude: 0,
    homeDistance: 0,
    homeBearing: 0,
  };
}

/** Cumulative mission statistics, shown on the debrief screen. */
export interface FlightStatistics {
  flightTime: number;
  distanceFlown: number;
  maxAltitude: number;
  maxAltitudeAgl: number;
  maxAirspeed: number;
  averageAirspeed: number;
  enemiesDestroyed: number;
  collisions: number;
  crashes: number;
  /** Times the airframe was put down on the ground and survived it. */
  landings: number;
}

export function createStatistics(): FlightStatistics {
  return {
    flightTime: 0,
    distanceFlown: 0,
    maxAltitude: 0,
    maxAltitudeAgl: 0,
    maxAirspeed: 0,
    averageAirspeed: 0,
    enemiesDestroyed: 0,
    collisions: 0,
    crashes: 0,
    landings: 0,
  };
}

export const MS_TO_KMH = 3.6;

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}
