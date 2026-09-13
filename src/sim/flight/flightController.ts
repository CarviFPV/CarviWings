/**
 * The flight controller sitting between the sticks and the airframe.
 *
 * The simulator has always flown the wing raw: whatever the pilot asked for
 * went straight to the elevons. That is manual, and it is still here. This is
 * everything else a modern wing carries — the rates a flight controller holds,
 * self-levelling, a course to hold, a height to hold, and a way home — written
 * as one controller that takes the pilot's `FlightInput` and hands back the
 * `FlightInput` the flight model should actually fly.
 *
 * Nothing here can move an aircraft. Every mode ends in a stick position, so an
 * assisted wing is flown by the same aerodynamics as an unassisted one and can
 * be stalled, over-banked and flown into a hill exactly like one. What the
 * assists buy is a pilot who does not have to.
 *
 * The layering is the one an INAV wing has:
 *
 *   manual ──────────────────────────────────────────► sticks through
 *   acro ───────────────► rate loops ────────────────► sticks
 *   angle ──────────────► attitude loops ────────────► sticks
 *   + course hold ──────► heading → bank ────────────► roll
 *   + altitude hold ────► height → climb → pitch ────► pitch, throttle
 *   RTH ────────────────► navigation, over all of it ► everything
 */

import { toHeadingPitchRoll } from "../math/quat";
import { clamp, DEG_TO_RAD, normalizeDegrees, RAD_TO_DEG } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import type { AircraftState } from "./state";
import { isAirworthy, isGrounded } from "./state";
import { stallSpeed } from "./physics";
import { tiltAngle, tiltedHoverThrottle } from "./multirotor";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import type { AutopilotGoal } from "../ai/autopilot";
import { flyToward } from "../ai/autopilot";
import type {
  AvoidanceCommand,
  TerrainAvoidanceSystem,
} from "../ai/terrainAvoidance";
import { createAvoidanceCommand } from "../ai/terrainAvoidance";
import type { TerrainSampler } from "../terrain/types";
import type {
  FlightMode,
  FlightModeSettings,
  RthStage,
} from "./flightModes";
import {
  DEFAULT_FLIGHT_MODE_SETTINGS,
  FLIGHT_MODE,
  FLIGHT_MODES,
  RTH_ARRIVAL,
  RTH_STAGE,
  returnAltitude,
} from "./flightModes";
import type { ControlRates } from "./rates";
import { rateCommand } from "./rates";
import { INTERCEPTOR_WING } from "./uav";

/**
 * Control gains for the assisted modes.
 *
 * Deliberately a little softer than the AI's: an enemy is flown by numbers and
 * a pilot is flown by hand, and a self-levelling mode that snaps is worse to
 * fly than one that settles.
 */
export const FLIGHT_MODE_GAINS = {
  /** Degrees of bank commanded per degree of heading error. */
  headingToBank: 1.6,
  /** Roll command per degree of bank error. */
  bankGain: 0.05,
  /** Roll damping per degree per second of roll rate. */
  rollRateDamping: 0.0065,
  /** Pitch command per degree of attitude error, in angle mode. */
  pitchGain: 0.05,
  /** Pitch damping per degree per second of pitch rate. */
  pitchRateDamping: 0.006,
  /** Climb demand in m/s per metre of altitude error. */
  altitudeGain: 0.12,
  /** Largest climb and descent altitude hold will ask for, m/s. */
  maxClimb: 7,
  maxSink: -7,
  /** Pitch command per m/s of vertical speed error. */
  climbGain: 0.22,
  /** Back pressure added for the load factor a bank costs. */
  bankCompensation: 0.16,
  /** Yaw command per degree of sideslip, to keep an assisted turn coordinated. */
  yawCoordination: 0.035,
  /** Airspeed margin over the stall the assists protect, as a multiplier. */
  stallMargin: 1.3,
  /** Throttle added per m/s of commanded climb, while holding altitude. */
  climbThrottle: 0.03,
  /** Throttle added per m/s the airspeed has fallen below the guard. */
  speedGuardGain: 0.08,
} as const;

/**
 * The rate loop that flies acro, in the same two terms a flight controller
 * uses on this axis.
 *
 * Proportional alone always droops: holding a rate takes a steady elevon
 * deflection, and a proportional term can only produce one out of an error, so
 * the wing would settle short of whatever it was asked for. The integral is
 * what removes that — and what makes the airframe answer the same at forty
 * metres a second as at twenty, since it simply winds on however much elevon
 * the air of the moment needs.
 *
 * There is no derivative term. The airframe's own damping derivatives are
 * strongly stabilising and the rate being chased is measured, not estimated,
 * so a D term here would only amplify the step the sticks arrive in.
 */
export const RATE_LOOP_GAINS = {
  /** Stick per degree per second of rate error. */
  proportional: 0.0025,
  /** Stick per degree of accumulated error. */
  integral: 0.02,
  /**
   * Largest error the integral will carry, degrees.
   *
   * Sixty is enough to command full stick on its own, so the loop can still
   * ask the airframe for everything it has, and bounded so an authority it
   * does not have — a wing torn in half, an aircraft dropped below flying
   * speed — cannot wind up into a stop it then takes seconds to come out of.
   */
  integralLimit: 60,
} as const;

/**
 * Control gains for an assisted multirotor.
 *
 * A separate set rather than the wing's with different numbers, because the
 * axes do different jobs. A banked wing turns; a banked quadcopter slides
 * sideways and keeps pointing where it was, so a course is held on the yaw
 * axis and not on the roll one. A wing holds height with the elevator and
 * trades speed for it; a quadcopter holds height with the throttle, because
 * that is the only thing on it that makes the aircraft go up.
 */
export const ROTOR_MODE_GAINS = {
  /** Yaw command per degree of heading error, holding a course. */
  headingGain: 0.02,
  /** Yaw damping per degree per second of yaw rate. */
  yawRateDamping: 0.0035,
  /** Roll or pitch command per degree of attitude error, in angle mode. */
  tiltGain: 0.05,
  /** Attitude damping per degree per second of rotation. */
  tiltRateDamping: 0.006,
  /** Climb demand in m/s per metre of altitude error. */
  altitudeGain: 0.5,
  /** Largest climb and descent altitude hold will ask for, m/s. */
  maxClimb: 6,
  maxSink: -5,
  /** Throttle per m/s of vertical speed error. */
  climbGain: 0.06,
} as const;

/**
 * The rate loop for a multirotor.
 *
 * Far softer than the wing's, and it has to be. A wing's elevon has to shift a
 * couple of kilograms through the air and the rate it produces depends on how
 * fast that air is arriving; a 293 g quadcopter's rotors can put fifty
 * thousand degrees a second squared into it whatever the airspeed, so a loop
 * tuned for the wing would answer a stick movement with a bounce.
 */
export const ROTOR_RATE_LOOP_GAINS = {
  proportional: 0.0005,
  integral: 0.005,
  integralLimit: 40,
} as const;

/** The two terms a rate loop is tuned with, whichever airframe it is flying. */
export interface RateLoopGains {
  readonly proportional: number;
  readonly integral: number;
  readonly integralLimit: number;
}

/** Stick deflection that counts as the pilot asking for something. */
export const STICK_DEADBAND = 0.08;
/** Deflection that takes a return home off the pilot's hands and back onto them. */
export const OVERRIDE_DEFLECTION = 0.25;

/** How close to the return altitude counts as having reached it, metres. */
const CLIMB_TOLERANCE = 8;
/** A climb-first leg is abandoned after this long, whatever it reached. */
const CLIMB_TIMEOUT = 45;
/** How far ahead the climb-first leg aims, metres. */
const CLIMB_LEAD = 3000;
/** How far round the loiter circle the aircraft aims, degrees. */
const LOITER_LEAD = 55;
/** Sink rate flown on the way down to a return landing, m/s. */
const LAND_SINK = 2;
/**
 * Height above home the descending circle is left at, metres.
 *
 * From here the approach is committed: it stops chasing the field and goes
 * straight ahead, wings level, because a wing that is still turning when it
 * meets the ground puts a tip in first and that is a crash rather than a
 * landing.
 */
const LAND_FINAL_AGL = 40;
/** How far ahead the committed approach aims, metres. */
const LAND_RUNOUT = 1500;
/**
 * How far below home the descent is aimed, metres.
 *
 * Aiming exactly at the surface makes the loop flare out and float; a couple
 * of metres under it keeps a gentle sink on all the way to the touchdown.
 */
const LAND_UNDERSHOOT = 2;
/**
 * Power left on for the committed approach.
 *
 * Enough to hold the return speed all the way down rather than to arrive
 * slowly: a wing dragged in behind the power curve dutch-rolls, and putting a
 * tip in at twenty degrees of sideslip is a crash whatever the sink rate was.
 */
const LAND_THROTTLE = 0.4;
/** How often the terrain probes are re-run, seconds. */
const AVOIDANCE_INTERVAL = 0.25;
/** Clearance a return home keeps over the ground, metres. */
const AVOIDANCE_MARGIN = 70;

/** What the flight controller is doing, for the instruments to report. */
export interface FlightModeStatus {
  mode: FlightMode;
  courseHold: boolean;
  altitudeHold: boolean;
  returnHome: boolean;
  /** Which part of a return is being flown, or null when none is. */
  rthStage: RthStage | null;
  /** The course being held, degrees. Meaningless unless `courseHold`. */
  heldCourse: number;
  /** The height being held, local metres. Meaningless unless `altitudeHold`. */
  heldAltitude: number;
  /** Horizontal distance to home, metres. */
  homeDistance: number;
  /** Compass bearing to home, degrees. */
  homeBearing: number;
}

export interface FlightControllerOptions {
  readonly settings?: FlightModeSettings;
  /** The airframe's stick rates. Defaults to the interceptor wing's. */
  readonly rates?: ControlRates;
  /** Used to work out the ground height at home. */
  readonly terrain?: TerrainSampler | null;
  /** Keeps a return home off the hills it would otherwise fly into. */
  readonly avoidance?: TerrainAvoidanceSystem | null;
}

type MutableGoal = { -readonly [K in keyof AutopilotGoal]: AutopilotGoal[K] };

export class FlightModeController {
  private settings: FlightModeSettings;
  private rates: ControlRates;
  private readonly terrain: TerrainSampler | null;
  private readonly avoidance: TerrainAvoidanceSystem | null;

  /** Accumulated rate error on each axis, degrees. */
  private rollError = 0;
  private pitchError = 0;

  private mode: FlightMode;
  private courseHold = false;
  private altitudeHold = false;
  private returnHome = false;

  /** Latched on the next step rather than at the moment a switch is thrown. */
  private latchCourse = false;
  private latchAltitude = false;

  private heldCourse = 0;
  private heldAltitude = 0;

  private readonly home = V.vec3();
  private homeGround = 0;
  private homeDistance = 0;
  private homeBearing = 0;

  private rthStage: RthStage = RTH_STAGE.Cruise;
  private rthAltitude = 0;
  private rthCourse = 0;
  private climbSeconds = 0;
  private loiterSign = 1;
  private landAltitude = 0;
  /** Latched when the approach commits; NaN until then. */
  private landCourse = Number.NaN;

  private avoidanceTimer = 0;
  private readonly avoidanceCommand: AvoidanceCommand = createAvoidanceCommand();

  private readonly output: FlightInput = createFlightInput();
  private readonly goalTarget = V.vec3();
  private readonly goal: MutableGoal = {
    target: this.goalTarget,
    speed: 22,
    throttle: 0.6,
    maxBank: 45,
    climbBias: 0,
    headingBias: 0,
    aimMode: "altitude",
  };
  private readonly status: FlightModeStatus = {
    mode: FLIGHT_MODE.Acro,
    courseHold: false,
    altitudeHold: false,
    returnHome: false,
    rthStage: null,
    heldCourse: 0,
    heldAltitude: 0,
    homeDistance: 0,
    homeBearing: 0,
  };

  constructor(options: FlightControllerOptions = {}) {
    this.settings = options.settings ?? DEFAULT_FLIGHT_MODE_SETTINGS;
    this.rates = options.rates ?? INTERCEPTOR_WING.defaultRates;
    this.terrain = options.terrain ?? null;
    this.avoidance = options.avoidance ?? null;
    this.mode = this.settings.defaultMode;
  }

  // --- Configuration -------------------------------------------------------

  /**
   * Applies a change to the parameters mid-flight.
   *
   * The engaged modes are deliberately left alone: a pilot who raises the bank
   * limit from the pause menu wants a wider turn, not their altitude hold
   * dropped.
   */
  setSettings(settings: FlightModeSettings): void {
    this.settings = settings;
  }

  get parameters(): FlightModeSettings {
    return this.settings;
  }

  /**
   * Re-tunes the rates mid-flight.
   *
   * The accumulated error goes with them: it was wound on to hold the old
   * rate, and carrying it across would answer the first stick movement after
   * the change with the deflection the previous tune had settled at.
   */
  setRates(rates: ControlRates): void {
    this.rates = rates;
    this.rollError = 0;
    this.pitchError = 0;
  }

  get controlRates(): ControlRates {
    return this.rates;
  }

  /**
   * Records where home is.
   *
   * The launch point, once, for the whole flight — not wherever a replacement
   * airframe happened to appear. A return home that came back to the last
   * crash site would be no use to anybody.
   */
  setHome(position: Vec3): void {
    V.copy(this.home, position);
    this.homeGround = this.terrain
      ? this.terrain.heightAt(position.x, position.y)
      : position.z;
  }

  get homePoint(): Readonly<Vec3> {
    return this.home;
  }

  // --- Switches ------------------------------------------------------------

  get activeMode(): FlightMode {
    return this.mode;
  }

  /** Steps to the next stabilisation mode: manual, acro, angle, and round. */
  cycleMode(): FlightMode {
    const next =
      FLIGHT_MODES[
        (FLIGHT_MODES.indexOf(this.mode) + 1) % FLIGHT_MODES.length
      ];
    this.setMode(next ?? FLIGHT_MODE.Acro);
    return this.mode;
  }

  setMode(mode: FlightMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Whatever the rate loops had wound on was for the mode being left.
    this.rollError = 0;
    this.pitchError = 0;
  }

  toggleCourseHold(): boolean {
    this.setCourseHold(!this.courseHold);
    return this.courseHold;
  }

  setCourseHold(on: boolean): void {
    if (on === this.courseHold) return;
    this.courseHold = on;
    this.latchCourse = on;
  }

  toggleAltitudeHold(): boolean {
    this.setAltitudeHold(!this.altitudeHold);
    return this.altitudeHold;
  }

  setAltitudeHold(on: boolean): void {
    if (on === this.altitudeHold) return;
    this.altitudeHold = on;
    this.latchAltitude = on;
  }

  toggleReturnHome(): boolean {
    this.setReturnHome(!this.returnHome);
    return this.returnHome;
  }

  /**
   * Starts or abandons a return home.
   *
   * Coming out of one re-latches whatever holds were engaged underneath it, so
   * the aircraft picks up the course and height it is on rather than snapping
   * back to the ones it left ten kilometres ago.
   */
  setReturnHome(on: boolean): void {
    if (on === this.returnHome) return;
    this.returnHome = on;
    // A return flies its own loops, so whatever the rate loops were holding is
    // stale by the time the aircraft is handed back.
    this.rollError = 0;
    this.pitchError = 0;
    if (on) {
      // The stage and the altitude are worked out on the first step, where
      // there is an aircraft to read them from.
      this.rthStage = RTH_STAGE.Climb;
      this.climbSeconds = 0;
      this.rthAltitude = Number.NaN;
    } else {
      this.latchCourse = this.courseHold;
      this.latchAltitude = this.altitudeHold;
    }
  }

  /** Puts every assist away. Used when the airframe is replaced. */
  reset(): void {
    this.mode = this.settings.defaultMode;
    this.courseHold = false;
    this.altitudeHold = false;
    this.returnHome = false;
    this.latchCourse = false;
    this.latchAltitude = false;
    this.rollError = 0;
    this.pitchError = 0;
  }

  // --- Reporting -----------------------------------------------------------

  /**
   * What the controller is doing. Allocation-free: the same object comes back
   * every call, so callers read it rather than keep it.
   */
  describe(): FlightModeStatus {
    const s = this.status;
    s.mode = this.mode;
    s.courseHold = this.courseHold;
    s.altitudeHold = this.altitudeHold;
    s.returnHome = this.returnHome;
    s.rthStage = this.returnHome ? this.rthStage : null;
    s.heldCourse = this.heldCourse;
    s.heldAltitude = this.heldAltitude;
    s.homeDistance = this.homeDistance;
    s.homeBearing = this.homeBearing;
    return s;
  }

  // --- Flying --------------------------------------------------------------

  /**
   * Turns the pilot's stick positions into the ones the airframe flies.
   *
   * Allocation-free, and called once per physics step: the returned input is
   * reused, so the flight model must consume it before the next call.
   */
  update(state: AircraftState, pilot: FlightInput, dt: number): FlightInput {
    const out = this.output;
    out.pitch = pilot.pitch;
    out.roll = pilot.roll;
    out.yaw = pilot.yaw;
    out.throttle = pilot.throttle;

    const dx = this.home.x - state.position.x;
    const dy = this.home.y - state.position.y;
    this.homeDistance = Math.hypot(dx, dy);
    this.homeBearing = normalizeDegrees(Math.atan2(dx, dy) * RAD_TO_DEG);

    // There is nothing to stabilise on the ground and nothing to fly in a
    // wreck. Both put the assists away rather than leaving a mode engaged that
    // is quietly doing nothing.
    if (!isAirworthy(state.status) || isGrounded(state.status)) {
      this.courseHold = false;
      this.altitudeHold = false;
      this.returnHome = false;
      // A wing on its belly is not rotating and cannot be made to: the rate
      // loops would spend a take-off roll winding elevon on against a rate
      // the ground is holding at zero, and hand the pilot full stick the
      // moment it flew off.
      this.rollError = 0;
      this.pitchError = 0;
      return out;
    }

    if (this.returnHome) {
      const override =
        this.settings.rth.allowStickOverride && stickMoved(pilot);
      if (override) {
        this.setReturnHome(false);
      } else {
        return this.flyHome(state, dt, out);
      }
    }

    return this.stabilise(state, pilot, dt, out);
  }

  /** The rate loops, angle mode and the two holds, in overriding order. */
  private stabilise(
    state: AircraftState,
    pilot: FlightInput,
    dt: number,
    out: FlightInput,
  ): FlightInput {
    return state.config.rotor
      ? this.stabiliseRotor(state, pilot, dt, out)
      : this.stabiliseWing(state, pilot, dt, out);
  }

  /**
   * The same modes on a multirotor.
   *
   * Every one of them means what it means on a quadcopter rather than what it
   * means on a wing: acro is the rate loops, angle leans the airframe to the
   * stick, a held course is held on the yaw axis, and a held altitude is held
   * on the throttle with the pitch stick left to the pilot — which is what
   * makes altitude hold on a multirotor a mode you can actually fly around in
   * rather than one that flies you in a circle.
   */
  private stabiliseRotor(
    state: AircraftState,
    pilot: FlightInput,
    dt: number,
    out: FlightInput,
  ): FlightInput {
    const s = this.settings;
    const g = ROTOR_MODE_GAINS;
    const rotor = state.config.rotor;
    const angles = toHeadingPitchRoll(state.orientation);
    const rollRateDeg = state.angularVelocity.x * RAD_TO_DEG;
    const pitchRateDeg = -state.angularVelocity.y * RAD_TO_DEG;
    const yawRateDeg = -state.angularVelocity.z * RAD_TO_DEG;

    if (this.latchCourse) {
      this.heldCourse = angles.headingDeg;
      this.latchCourse = false;
    }
    if (this.latchAltitude) {
      this.heldAltitude = state.position.z;
      this.latchAltitude = false;
    }

    const angle = this.mode === FLIGHT_MODE.Angle;
    const acro = this.mode === FLIGHT_MODE.Acro;
    if (!angle && !acro && !this.courseHold && !this.altitudeHold) return out;

    // --- Roll and pitch -----------------------------------------------------
    const tiltLimit = rotor?.maxTiltDeg ?? 55;
    if (angle) {
      const bank = clamp(
        pilot.roll * s.maxBankDeg,
        -tiltLimit,
        tiltLimit,
      );
      out.roll = clamp(
        (bank - angles.rollDeg) * g.tiltGain - rollRateDeg * g.tiltRateDamping,
        -1,
        1,
      );
      const nose = clamp(pilot.pitch * s.maxPitchDeg, -tiltLimit, tiltLimit);
      out.pitch = clamp(
        (nose - angles.pitchDeg) * g.tiltGain -
          pitchRateDeg * g.tiltRateDamping,
        -1,
        1,
      );
      this.rollError = 0;
      this.pitchError = 0;
    } else if (acro) {
      out.roll = this.holdRate(
        rateCommand(pilot.roll, this.rates.rollRate, this.rates.rollExpo),
        rollRateDeg,
        dt,
        "roll",
        ROTOR_RATE_LOOP_GAINS,
      );
      out.pitch = this.holdRate(
        rateCommand(pilot.pitch, this.rates.pitchRate, this.rates.pitchExpo),
        pitchRateDeg,
        dt,
        "pitch",
        ROTOR_RATE_LOOP_GAINS,
      );
    } else {
      // Manual, under one of the holds: the sticks are the mixer.
      this.rollError = 0;
      this.pitchError = 0;
    }

    // --- Yaw ----------------------------------------------------------------
    // This is where a course is held on a multirotor. Banking one does not
    // turn it, it slides it sideways, so a heading is a yaw problem — and the
    // yaw stick walks the held course, the way the roll stick walks a wing's.
    if (this.courseHold) {
      if (Math.abs(pilot.yaw) > STICK_DEADBAND) {
        this.heldCourse = normalizeDegrees(
          this.heldCourse + pilot.yaw * s.courseTrimRate * dt,
        );
      }
      const error = ((this.heldCourse - angles.headingDeg + 540) % 360) - 180;
      out.yaw = clamp(
        error * g.headingGain - yawRateDeg * g.yawRateDamping,
        -1,
        1,
      );
    }

    // --- Throttle -----------------------------------------------------------
    if (this.altitudeHold) {
      if (Math.abs(pilot.pitch) > STICK_DEADBAND && !angle && !acro) {
        // Nothing else is using the pitch stick, so it walks the height.
        this.heldAltitude += pilot.pitch * s.altitudeTrimRate * dt;
      }
      const climb = clamp(
        (this.heldAltitude - state.position.z) * g.altitudeGain,
        g.maxSink,
        g.maxClimb,
      );
      const packFactor = state.powerplant ? state.powerplant.thrustFactor : 1;
      const hover = tiltedHoverThrottle(
        state.config,
        tiltAngle(angles.pitchDeg, angles.rollDeg),
        packFactor * state.damage.thrustFactor,
      );
      out.throttle = clamp(
        hover + (climb - state.velocity.z) * g.climbGain,
        0,
        1,
      );
    }

    return out;
  }

  /** The wing's own loops. */
  private stabiliseWing(
    state: AircraftState,
    pilot: FlightInput,
    dt: number,
    out: FlightInput,
  ): FlightInput {
    const s = this.settings;
    const g = FLIGHT_MODE_GAINS;
    const angles = toHeadingPitchRoll(state.orientation);
    const rollRateDeg = state.angularVelocity.x * RAD_TO_DEG;
    const pitchRateDeg = -state.angularVelocity.y * RAD_TO_DEG;

    if (this.latchCourse) {
      this.heldCourse = angles.headingDeg;
      this.latchCourse = false;
    }
    if (this.latchAltitude) {
      this.heldAltitude = state.position.z;
      this.latchAltitude = false;
    }

    const angle = this.mode === FLIGHT_MODE.Angle;
    const acro = this.mode === FLIGHT_MODE.Acro;
    const assisted = angle || this.courseHold || this.altitudeHold;
    if (!assisted && !acro) return out;

    // --- Roll ---------------------------------------------------------------
    if (this.courseHold) {
      // The roll stick walks the course being held rather than banking the
      // wing: this is a heading knob, which is what makes it flyable with one
      // hand while the other does something else.
      if (Math.abs(pilot.roll) > STICK_DEADBAND) {
        this.heldCourse = normalizeDegrees(
          this.heldCourse + pilot.roll * s.courseTrimRate * dt,
        );
      }
      const error = ((this.heldCourse - angles.headingDeg + 540) % 360) - 180;
      const bank = clamp(
        error * g.headingToBank,
        -s.maxBankDeg,
        s.maxBankDeg,
      );
      out.roll = holdBank(bank, angles.rollDeg, rollRateDeg);
      this.rollError = 0;
    } else if (angle) {
      out.roll = holdBank(
        pilot.roll * s.maxBankDeg,
        angles.rollDeg,
        rollRateDeg,
      );
      this.rollError = 0;
    } else if (acro) {
      // The stick is a roll rate, and the loop goes and gets it.
      const demand = rateCommand(
        pilot.roll,
        this.rates.rollRate,
        this.rates.rollExpo,
      );
      out.roll = this.holdRate(demand, rollRateDeg, dt, "roll");
    } else {
      // Manual, under a height being held: the roll stick is the elevons.
      this.rollError = 0;
    }

    // --- Pitch and throttle -------------------------------------------------
    if (this.altitudeHold) {
      if (Math.abs(pilot.pitch) > STICK_DEADBAND) {
        this.heldAltitude += pilot.pitch * s.altitudeTrimRate * dt;
      }
      const climb = clamp(
        (this.heldAltitude - state.position.z) * g.altitudeGain,
        g.maxSink,
        g.maxClimb,
      );
      let pitch = (climb - state.velocity.z) * g.climbGain;
      // A banked wing has to pull harder just to hold height.
      const load = 1 / Math.max(Math.cos(angles.rollDeg * DEG_TO_RAD), 0.25);
      pitch += (load - 1) * g.bankCompensation;
      out.pitch = clamp(pitch, -1, 1);

      // The pilot still owns the power. Altitude hold only leans on it: a
      // little for the climb it is asking for, and as much as it takes to keep
      // the wing off the stall, because a height held by the elevator alone is
      // held by trading away the speed that makes it possible.
      let throttle = pilot.throttle + Math.max(0, climb) * g.climbThrottle;
      const guard = this.stallGuard(state);
      if (state.airspeed < guard) {
        throttle += (guard - state.airspeed) * g.speedGuardGain;
      }
      out.throttle = clamp(throttle, 0, 1);
      this.pitchError = 0;
    } else if (angle) {
      const target = pilot.pitch * s.maxPitchDeg;
      out.pitch = clamp(
        (target - angles.pitchDeg) * g.pitchGain -
          pitchRateDeg * g.pitchRateDamping,
        -1,
        1,
      );
      this.pitchError = 0;
    } else if (acro) {
      const demand = rateCommand(
        pilot.pitch,
        this.rates.pitchRate,
        this.rates.pitchExpo,
      );
      out.pitch = this.holdRate(demand, pitchRateDeg, dt, "pitch");
    } else {
      // Manual, under a course being held: the pitch stick is the elevons.
      this.pitchError = 0;
    }

    // Acro is the airframe with a gyro on it, not an assist: it holds the rate
    // it was asked for and nothing else. No stall guard, and no coordination —
    // the yaw stick is the pilot's, and a wing can be flown into a stall in
    // acro exactly as it can in manual, which is the point of the mode.
    if (!assisted) return out;

    // --- Stall protection ---------------------------------------------------
    // The assists are allowed to fly the aircraft, not to hold it in a stall.
    const guard = this.stallGuard(state);
    if (state.airspeed < guard) {
      out.pitch = Math.min(out.pitch, 0) - (guard - state.airspeed) * 0.09;
      out.pitch = clamp(out.pitch, -1, 1);
    }

    // --- Yaw ----------------------------------------------------------------
    // Only when the pilot is not asking for sideslip themselves.
    if (Math.abs(pilot.yaw) <= STICK_DEADBAND) {
      out.yaw = clamp(
        state.sideslip * RAD_TO_DEG * g.yawCoordination,
        -0.5,
        0.5,
      );
    }

    return out;
  }

  /**
   * Elevon command that puts a measured rotation rate on the demanded one.
   *
   * Proportional and integral, in degrees per second and degrees. The integral
   * is only kept when it is not being asked to push a command that is already
   * against its stop further into it, which is what stops a wing that has run
   * out of authority — too slow, too damaged, or simply asked for more than it
   * has — from carrying a wound-up deflection into the recovery.
   */
  private holdRate(
    demandDeg: number,
    measuredDeg: number,
    dt: number,
    axis: "roll" | "pitch",
    gains: RateLoopGains = RATE_LOOP_GAINS,
  ): number {
    const g = gains;
    const error = demandDeg - measuredDeg;
    const carried = axis === "roll" ? this.rollError : this.pitchError;
    const accumulated = clamp(
      carried + error * dt,
      -g.integralLimit,
      g.integralLimit,
    );

    const raw = error * g.proportional + accumulated * g.integral;
    const command = clamp(raw, -1, 1);
    if (Math.abs(raw) < 1 || raw * error < 0) {
      if (axis === "roll") this.rollError = accumulated;
      else this.pitchError = accumulated;
    }
    return command;
  }

  /** Airspeed the assists will not let the wing fall below, m/s. */
  private stallGuard(state: AircraftState): number {
    return (
      stallSpeed(state.config, undefined, state.damage.liftFactor) *
      FLIGHT_MODE_GAINS.stallMargin
    );
  }

  // --- Return home ---------------------------------------------------------

  /**
   * Brings the aircraft back to where the flight started.
   *
   * Four stages, and which of them the return opens on is the pilot's setting:
   * climb to the return altitude before turning back, then fly home at it, then
   * either circle over the field or spiral down onto it.
   */
  private flyHome(
    state: AircraftState,
    dt: number,
    out: FlightInput,
  ): FlightInput {
    const rth = this.settings.rth;
    const s = this.settings;

    if (!Number.isFinite(this.rthAltitude)) {
      this.rthAltitude = returnAltitude(rth, state.position.z, this.homeGround);
      this.rthCourse = toHeadingPitchRoll(state.orientation).headingDeg;
      // Nothing to climb through: either the pilot does not want the climb
      // first, or the aircraft is already at the height it would climb to.
      this.rthStage =
        rth.climbFirst && state.position.z < this.rthAltitude - CLIMB_TOLERANCE
          ? RTH_STAGE.Climb
          : RTH_STAGE.Cruise;
      this.climbSeconds = 0;
    }

    this.advanceStage(state, dt);
    this.stepAvoidance(state, dt);

    const goal = this.goal;
    goal.speed = rth.cruiseSpeed;
    goal.throttle = 0.6;
    goal.maxBank = s.maxBankDeg;
    goal.climbBias = this.avoidanceCommand.climbDemand;
    goal.headingBias = this.avoidanceCommand.headingOffset;
    goal.aimMode = "altitude";

    // A multirotor comes home a different way. It has no minimum speed, so it
    // does not have to circle to wait and does not have to fly an approach to
    // arrive: it stops over the field and, if it is landing, comes straight
    // down onto it. Trying to fly a wing's spiral approach on a quadcopter
    // would only spend the pack it came home to save.
    const rotorcraft = state.config.rotor !== undefined;

    switch (this.rthStage) {
      case RTH_STAGE.Climb: {
        // Straight ahead on the course it was engaged on, going up.
        const course = this.rthCourse * DEG_TO_RAD;
        this.goalTarget.x = state.position.x + Math.sin(course) * CLIMB_LEAD;
        this.goalTarget.y = state.position.y + Math.cos(course) * CLIMB_LEAD;
        this.goalTarget.z = this.rthAltitude;
        break;
      }
      case RTH_STAGE.Cruise: {
        this.goalTarget.x = this.home.x;
        this.goalTarget.y = this.home.y;
        this.goalTarget.z = this.rthAltitude;
        break;
      }
      case RTH_STAGE.Loiter: {
        if (rotorcraft) {
          // Holding station over home, which is what loitering means on an
          // aircraft that can stop.
          this.goalTarget.x = this.home.x;
          this.goalTarget.y = this.home.y;
          this.goalTarget.z = this.rthAltitude;
          break;
        }
        this.circlePoint(state, this.rthAltitude);
        break;
      }
      case RTH_STAGE.Land: {
        this.landAltitude = Math.max(
          this.landAltitude - LAND_SINK * dt,
          this.homeGround - LAND_UNDERSHOOT,
        );
        if (rotorcraft) {
          // Straight down onto the spot it took off from.
          this.goalTarget.x = this.home.x;
          this.goalTarget.y = this.home.y;
          this.goalTarget.z = this.landAltitude;
          break;
        }
        if (this.landAltitude > this.homeGround + LAND_FINAL_AGL) {
          this.circlePoint(state, this.landAltitude);
          break;
        }
        // Committed. One course, held to the ground.
        if (!Number.isFinite(this.landCourse)) {
          this.landCourse = toHeadingPitchRoll(state.orientation).headingDeg;
        }
        const course = this.landCourse * DEG_TO_RAD;
        this.goalTarget.x = state.position.x + Math.sin(course) * LAND_RUNOUT;
        this.goalTarget.y = state.position.y + Math.cos(course) * LAND_RUNOUT;
        this.goalTarget.z = this.landAltitude;
        goal.throttle = LAND_THROTTLE;
        goal.speed = rth.cruiseSpeed;
        break;
      }
    }

    return flyToward(state, goal, out);
  }

  /** Moves the return on to its next stage when this one is finished. */
  private advanceStage(state: AircraftState, dt: number): void {
    const rth = this.settings.rth;
    const arrival = Math.max(rth.loiterRadiusMetres, 60);

    if (this.rthStage === RTH_STAGE.Climb) {
      this.climbSeconds += dt;
      // A wing that cannot reach the altitude must not climb at it forever:
      // past the timeout it turns for home and keeps climbing on the way,
      // which is the same thing a pilot would do.
      if (
        state.position.z >= this.rthAltitude - CLIMB_TOLERANCE ||
        this.climbSeconds >= CLIMB_TIMEOUT
      ) {
        this.rthStage = RTH_STAGE.Cruise;
      }
      return;
    }

    const stopping = state.config.rotor !== undefined;
    if (
      this.rthStage === RTH_STAGE.Cruise &&
      this.homeDistance <= (stopping ? Math.min(arrival, 25) : arrival)
    ) {
      if (rth.arrival === RTH_ARRIVAL.Land) {
        this.rthStage = RTH_STAGE.Land;
        this.landAltitude = Math.max(state.position.z, this.homeGround);
        this.landCourse = Number.NaN;
      } else {
        this.rthStage = RTH_STAGE.Loiter;
      }
      this.loiterSign = circleDirection(state, this.home);
    }
  }

  /** A point on the circle held over home, one lead angle ahead. */
  private circlePoint(state: AircraftState, altitude: number): void {
    const radius = this.settings.rth.loiterRadiusMetres;
    const rx = state.position.x - this.home.x;
    const ry = state.position.y - this.home.y;
    const angle =
      Math.atan2(ry, rx) + this.loiterSign * LOITER_LEAD * DEG_TO_RAD;
    this.goalTarget.x = this.home.x + Math.cos(angle) * radius;
    this.goalTarget.y = this.home.y + Math.sin(angle) * radius;
    this.goalTarget.z = altitude;
  }

  /**
   * Re-runs the terrain probes a few times a second and holds the answer.
   *
   * A return home is exactly the flight nobody is watching — the pilot has lost
   * the picture, or their nerve — so it is the one that most needs to know
   * about the ridge it is pointed at.
   */
  private stepAvoidance(state: AircraftState, dt: number): void {
    // Not on the way down. Terrain avoidance exists to keep an aircraft off
    // the ground, and the one stage that is deliberately going there would
    // spend the rest of the flight being told to climb away from its own
    // landing.
    if (this.rthStage === RTH_STAGE.Land) {
      this.avoidanceCommand.active = false;
      this.avoidanceCommand.climbDemand = 0;
      this.avoidanceCommand.headingOffset = 0;
      return;
    }
    if (!this.avoidance) return;
    this.avoidanceTimer += dt;
    if (this.avoidanceTimer < AVOIDANCE_INTERVAL) return;
    this.avoidanceTimer = 0;
    this.avoidance.evaluate(state, AVOIDANCE_MARGIN, this.avoidanceCommand);
  }
}

/** Roll command that puts the wing on a bank angle and keeps it there. */
function holdBank(
  targetBankDeg: number,
  bankDeg: number,
  rollRateDeg: number,
): number {
  const g = FLIGHT_MODE_GAINS;
  return clamp(
    (targetBankDeg - bankDeg) * g.bankGain - rollRateDeg * g.rollRateDamping,
    -1,
    1,
  );
}

/** True once the pilot has moved a stick far enough to mean it. */
function stickMoved(pilot: FlightInput): boolean {
  return (
    Math.abs(pilot.pitch) > OVERRIDE_DEFLECTION ||
    Math.abs(pilot.roll) > OVERRIDE_DEFLECTION ||
    Math.abs(pilot.yaw) > OVERRIDE_DEFLECTION
  );
}

/**
 * Which way round a circle to go: whichever the aircraft is already going.
 *
 * Arriving overhead and reversing the turn to pick an arbitrary direction
 * wastes the height and the speed the return just spent getting there.
 */
function circleDirection(state: AircraftState, centre: Vec3): number {
  const rx = state.position.x - centre.x;
  const ry = state.position.y - centre.y;
  const cross = rx * state.velocity.y - ry * state.velocity.x;
  return cross >= 0 ? 1 : -1;
}
