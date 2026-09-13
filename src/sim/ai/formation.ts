/**
 * Formation flying.
 *
 * Two pilots and one piece of geometry:
 *
 *   - **the slot** — where an aircraft belongs relative to the leader, given in
 *     the leader's own frame so the whole formation turns as one shape
 *   - **the lead pilot** — flies a display routine: legs, turns, climbs,
 *     wingovers and rolls, generated from the mission seed
 *   - **the wing pilot** — holds a slot off the lead
 *
 * Like every other pilot in this simulator, both produce nothing but a
 * normalised `FlightInput`. A formation aircraft is flown by the same model
 * that flies the player: it can be blown off station by wind, it can run out of
 * speed pulling into a wingover, and it will not fly through a ridge.
 */

import { forwardAxis, toHeadingPitchRoll } from "../math/quat";
import { clamp, DEG_TO_RAD, RAD_TO_DEG } from "../math/scalar";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";
import { GRAVITY } from "../flight/config";
import type { AircraftState } from "../flight/state";
import { FLIGHT_STATUS } from "../flight/state";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import type { TerrainSampler } from "../terrain/types";
import { commandedSpeed, flyToward, headingErrorForBank } from "./autopilot";
import type { AutopilotGoal } from "./autopilot";
import type { AvoidanceCommand, TerrainAvoidanceSystem } from "./terrainAvoidance";
import { createAvoidanceCommand, liftAboveTerrain } from "./terrainAvoidance";
import type { Difficulty } from "./types";
import { DIFFICULTY } from "./types";

// --- Slots -------------------------------------------------------------------

export const FORMATION_SLOT = {
  /** Directly behind the leader, the easiest slot to hold. */
  Astern: "ASTERN",
  /** Stepped back and out to the right. */
  Right: "RIGHT",
  /** Stepped back and out to the left. */
  Left: "LEFT",
  /** Well back and wide on the right, for the second element. */
  RightWide: "RIGHT_WIDE",
  /** Well back and wide on the left. */
  LeftWide: "LEFT_WIDE",
} as const;

export type FormationSlotId = (typeof FORMATION_SLOT)[keyof typeof FORMATION_SLOT];

/**
 * One station, in metres in the leader's frame.
 *
 * Every slot sits slightly low: an aircraft stepped down can see its leader
 * against the sky, and it is out of the wake.
 */
export interface FormationSlot {
  readonly id: FormationSlotId;
  readonly label: string;
  /** Metres behind the leader. */
  readonly aft: number;
  /** Metres to the leader's right; negative is left. */
  readonly side: number;
  /** Metres above the leader; negative is below. */
  readonly stack: number;
}

/*
 * The stations are deliberately tight — tens of metres, not hundreds.
 *
 * That is partly realism (a formation strung out over a quarter of a mile is
 * not a formation) and partly geometry. A slot rotates with the leader, so an
 * aircraft parked a lever arm L out from a leader turning at radius R has to
 * fly at roughly v(1 + L/R). These wings turn inside a couple of hundred
 * metres, so a station a hundred metres out on the wing would demand a speed
 * the airframe does not have, and the outside aircraft could never hold it.
 */
export const FORMATION_SLOTS: Readonly<Record<FormationSlotId, FormationSlot>> = {
  [FORMATION_SLOT.Astern]: {
    id: FORMATION_SLOT.Astern,
    label: "Line astern",
    aft: 40,
    side: 0,
    stack: -6,
  },
  [FORMATION_SLOT.Right]: {
    id: FORMATION_SLOT.Right,
    label: "Echelon right",
    aft: 22,
    side: 20,
    stack: -6,
  },
  [FORMATION_SLOT.Left]: {
    id: FORMATION_SLOT.Left,
    label: "Echelon left",
    aft: 22,
    side: -20,
    stack: -6,
  },
  [FORMATION_SLOT.RightWide]: {
    id: FORMATION_SLOT.RightWide,
    label: "Right wide",
    aft: 46,
    side: 42,
    stack: -12,
  },
  [FORMATION_SLOT.LeftWide]: {
    id: FORMATION_SLOT.LeftWide,
    label: "Left wide",
    aft: 46,
    side: -42,
    stack: -12,
  },
};

/** The slots a player may be assigned, in the order they are offered. */
export const PLAYER_SLOTS: readonly FormationSlotId[] = [
  FORMATION_SLOT.Astern,
  FORMATION_SLOT.Right,
  FORMATION_SLOT.Left,
];

/** The order the AI fills slots in, once the player's has been taken. */
export const WINGMAN_SLOT_ORDER: readonly FormationSlotId[] = [
  FORMATION_SLOT.Right,
  FORMATION_SLOT.Left,
  FORMATION_SLOT.RightWide,
  FORMATION_SLOT.LeftWide,
  FORMATION_SLOT.Astern,
];

/**
 * How far the station is allowed to bank with the leader, degrees.
 *
 * A formation banks as one shape, so the slot has to roll with the leader —
 * but only so far. Taking the bank straight from the leader's roll angle would
 * fling the whole formation around an aileron roll, so it is blended in as the
 * sine of the roll: exact in level flight, close enough in any turn worth
 * flying, and back to level by the time the leader is inverted.
 */
const MAX_STATION_BANK_DEG = 35;

const _forward = V.vec3();
const _right = V.vec3();
const _offset = V.vec3();
const _correction = V.vec3();
const _relative = V.vec3();

/**
 * Where the given slot is right now, in local ENU metres.
 *
 * Writes into `out` and returns it; nothing is allocated. The frame is built
 * from the leader's flight path rather than from its attitude directly, so a
 * leader that is slipping or holding a wing down does not drag the whole
 * formation sideways with it.
 */
export function formationStation(
  out: Vec3,
  lead: AircraftState,
  slot: FormationSlot,
): Vec3 {
  forwardAxis(_forward, lead.orientation);
  _forward.z = 0;
  if (V.lengthSquared(_forward) < 1e-6) {
    V.set(_forward, 0, 1, 0);
  }
  V.normalize(_forward, _forward);

  // Right for a wings-level aircraft on this heading, with up straight up...
  V.set(_right, _forward.y, -_forward.x, 0);

  // ...then both rolled about the flight path with the leader, within limits.
  const rollDeg = toHeadingPitchRoll(lead.orientation).rollDeg;
  const bank = MAX_STATION_BANK_DEG * Math.sin(rollDeg * DEG_TO_RAD) * DEG_TO_RAD;
  const cos = Math.cos(bank);
  const sin = Math.sin(bank);
  const rightZ = -sin;
  const upZ = cos;
  const rightX = _right.x * cos;
  const rightY = _right.y * cos;
  const upX = _right.x * sin;
  const upY = _right.y * sin;

  out.x = lead.position.x - _forward.x * slot.aft + rightX * slot.side + upX * slot.stack;
  out.y = lead.position.y - _forward.y * slot.aft + rightY * slot.side + upY * slot.stack;
  out.z = lead.position.z + rightZ * slot.side + upZ * slot.stack;
  return out;
}

/**
 * Where the leader has to be for an aircraft already sitting at `station`, on
 * `headingDeg` and wings level, to be exactly in `slot`.
 *
 * The inverse of `formationStation` for the one case that matters at the start
 * of a flight: nothing is banked yet, so the station frame is the heading and
 * nothing else. It exists so that a formation exercise opens with the player on
 * station rather than in a stern chase, whichever way the flight was set up to
 * face.
 */
export function formationLeadFor(
  out: Vec3,
  station: Vec3,
  headingDeg: number,
  slot: FormationSlot,
): Vec3 {
  const heading = headingDeg * DEG_TO_RAD;
  const forwardX = Math.sin(heading);
  const forwardY = Math.cos(heading);
  // Right for a wings-level aircraft on this heading, as above.
  const rightX = forwardY;
  const rightY = -forwardX;

  out.x = station.x + forwardX * slot.aft - rightX * slot.side;
  out.y = station.y + forwardY * slot.aft - rightY * slot.side;
  out.z = station.z - slot.stack;
  return out;
}

// --- The routine -------------------------------------------------------------

export const MANOEUVRE = {
  /** Straight and level. The join-up leg, and the rest between everything else. */
  Cruise: "CRUISE",
  /** A steady banked turn. */
  Turn: "TURN",
  Climb: "CLIMB",
  Descend: "DESCEND",
  /** A hard climbing turn that reverses direction and comes back down. */
  Wingover: "WINGOVER",
  /** An aileron roll. The formation breaks around it and rejoins after. */
  Roll: "ROLL",
} as const;

export type Manoeuvre = (typeof MANOEUVRE)[keyof typeof MANOEUVRE];

export const MANOEUVRE_LABELS: Readonly<Record<Manoeuvre, string>> = {
  [MANOEUVRE.Cruise]: "Straight and level",
  [MANOEUVRE.Turn]: "Turn",
  [MANOEUVRE.Climb]: "Climb",
  [MANOEUVRE.Descend]: "Descent",
  [MANOEUVRE.Wingover]: "Wingover",
  [MANOEUVRE.Roll]: "Aileron roll",
};

export interface RoutineStep {
  readonly type: Manoeuvre;
  readonly seconds: number;
  /** Bank to hold, degrees. Signed: positive turns right. */
  readonly bankDeg: number;
  /** Climb rate to hold, m/s. */
  readonly climb: number;
}

/** Seconds of straight and level at the start, so the flight can join up. */
export const JOIN_UP_SECONDS = 30;
/** Climb and descent rate flown through a wingover, m/s. */
const WINGOVER_CLIMB = 5;

interface StepTemplate {
  readonly type: Manoeuvre;
  readonly seconds: number;
  readonly bankDeg: number;
  readonly climb: number;
}

/**
 * What each difficulty is willing to fly.
 *
 * The airframe is identical at every setting, as everywhere else in this
 * simulator — what changes is how hard the leader makes the slot work.
 */
const ROUTINE_MENUS: Readonly<Record<Difficulty, readonly StepTemplate[]>> = {
  [DIFFICULTY.Easy]: [
    { type: MANOEUVRE.Cruise, seconds: 22, bankDeg: 0, climb: 0 },
    { type: MANOEUVRE.Turn, seconds: 26, bankDeg: 18, climb: 0 },
    { type: MANOEUVRE.Climb, seconds: 18, bankDeg: 0, climb: 3 },
    { type: MANOEUVRE.Descend, seconds: 18, bankDeg: 0, climb: -3 },
  ],
  [DIFFICULTY.Normal]: [
    { type: MANOEUVRE.Cruise, seconds: 16, bankDeg: 0, climb: 0 },
    { type: MANOEUVRE.Turn, seconds: 24, bankDeg: 26, climb: 0 },
    { type: MANOEUVRE.Turn, seconds: 18, bankDeg: 34, climb: 0 },
    { type: MANOEUVRE.Climb, seconds: 16, bankDeg: 0, climb: 4.5 },
    { type: MANOEUVRE.Descend, seconds: 16, bankDeg: 0, climb: -4.5 },
    { type: MANOEUVRE.Wingover, seconds: 22, bankDeg: 38, climb: 0 },
  ],
  [DIFFICULTY.Hard]: [
    { type: MANOEUVRE.Cruise, seconds: 12, bankDeg: 0, climb: 0 },
    { type: MANOEUVRE.Turn, seconds: 20, bankDeg: 38, climb: 0 },
    { type: MANOEUVRE.Turn, seconds: 16, bankDeg: 48, climb: 2 },
    { type: MANOEUVRE.Climb, seconds: 14, bankDeg: 0, climb: 6 },
    { type: MANOEUVRE.Descend, seconds: 14, bankDeg: 0, climb: -6 },
    { type: MANOEUVRE.Wingover, seconds: 20, bankDeg: 48, climb: 0 },
    { type: MANOEUVRE.Roll, seconds: 4, bankDeg: 0, climb: 0 },
  ],
};

export interface RoutineOptions {
  readonly seed: string;
  readonly difficulty: Difficulty;
  /** How long the whole display should last, seconds. */
  readonly seconds: number;
}

/**
 * Builds a display routine from the mission seed.
 *
 * Always opens with a straight leg long enough to join up on, never repeats a
 * manoeuvre back to back, and alternates the direction of every turn so the
 * formation works both wings and stays roughly over the same piece of ground.
 * The last step is trimmed so the routine is exactly the length asked for.
 */
export function buildRoutine(options: RoutineOptions): RoutineStep[] {
  const rng = createRng(`${options.seed}:routine`);
  const menu = ROUTINE_MENUS[options.difficulty];
  const total = Math.max(options.seconds, JOIN_UP_SECONDS + 10);

  const steps: RoutineStep[] = [
    { type: MANOEUVRE.Cruise, seconds: JOIN_UP_SECONDS, bankDeg: 0, climb: 0 },
  ];
  let elapsed = JOIN_UP_SECONDS;
  let previous: Manoeuvre = MANOEUVRE.Cruise;
  let direction = rng.next() < 0.5 ? 1 : -1;

  while (elapsed < total) {
    let template = menu[rng.int(0, menu.length - 1)] as StepTemplate;
    // One retry is enough to break up a repeat without biasing the routine
    // toward whatever happens to be next in the menu.
    if (template.type === previous) {
      template = menu[rng.int(0, menu.length - 1)] as StepTemplate;
    }
    if (template.bankDeg !== 0 || template.type === MANOEUVRE.Roll) {
      direction = -direction;
    }

    const remaining = total - elapsed;
    // The routine has to come out at exactly the length asked for, and a
    // three-second stub of a wingover is not a manoeuvre. Whatever is left over
    // is given to the step already being flown.
    if (remaining < template.seconds * 0.5) {
      const last = steps[steps.length - 1] as RoutineStep;
      steps[steps.length - 1] = { ...last, seconds: last.seconds + remaining };
      break;
    }
    const seconds = Math.min(template.seconds, remaining);
    steps.push({
      type: template.type,
      seconds,
      bankDeg: template.bankDeg * direction,
      climb: template.climb,
    });
    elapsed += seconds;
    previous = template.type;
  }

  return steps;
}

/** Total length of a routine, seconds. */
export function routineSeconds(steps: readonly RoutineStep[]): number {
  let total = 0;
  for (const step of steps) total += step.seconds;
  return total;
}

// --- The lead pilot ----------------------------------------------------------

/** How often the leader re-plans. Flying happens every physics step. */
const THINK_INTERVAL = 1 / 10;
/** How far ahead the leader aims, metres. */
const LEAD_LOOKAHEAD = 450;
/** Cruise speed for the whole formation, m/s. */
export const FORMATION_SPEED = 24;
/** Cruise throttle before the speed loop corrects it. */
const FORMATION_THROTTLE = 0.6;
/** Height band the leader keeps above the ground, metres. */
const LEAD_MIN_AGL = 160;
const LEAD_MAX_AGL = 900;
/**
 * How far out the leader turns back toward the mission origin, as a fraction of
 * the mission radius. The display stays over the area the player chose.
 */
const LEASH_FACTOR = 0.55;

export interface FormationLeadOptions {
  readonly id: string;
  readonly routine: readonly RoutineStep[];
  readonly terrain: TerrainSampler;
  readonly terrainAvoidance: TerrainAvoidanceSystem;
  readonly missionRadius: number;
  /** Clearance the leader keeps above terrain, metres. */
  readonly terrainMargin?: number;
  /**
   * The fastest the display is flown, m/s.
   *
   * The formation cruise was written when the whole flight was interceptors.
   * A flight can be flown on anything in the hangar now, so it is held to the
   * aeroplane the leader is in — and to the one the pilot is in, because a
   * lead nobody can stay with is not a formation. Left out, the cruise stands.
   */
  readonly speedReference?: number;
}

export interface FormationLeadDebug {
  readonly manoeuvre: Manoeuvre;
  readonly stepIndex: number;
  readonly elapsed: number;
  readonly total: number;
  /** 0..1 through the whole routine. */
  readonly progress: number;
  readonly finished: boolean;
}

/**
 * Flies the display.
 *
 * The routine is flown as a commanded heading and a commanded height that the
 * pilot integrates and then chases — not as a path the aircraft is placed on.
 * A leader that cannot hold the bank it was asked for simply does not complete
 * the turn, which is the correct outcome rather than a bug.
 */
export class FormationLeadPilot {
  readonly id: string;
  readonly routine: readonly RoutineStep[];
  readonly totalSeconds: number;

  private readonly terrain: TerrainSampler;
  private readonly terrainAvoidance: TerrainAvoidanceSystem;
  private readonly missionRadius: number;
  private readonly terrainMargin: number;
  private readonly speedReference: number | null;

  private elapsed = 0;
  private stepIndex = 0;
  private stepElapsed = 0;
  private started = false;
  private commandedHeading = 0;
  private commandedAltitude = 0;

  private readonly input: FlightInput = createFlightInput();
  private readonly goalTarget = V.vec3();
  private readonly avoidance: AvoidanceCommand = createAvoidanceCommand();
  private goal: AutopilotGoal;
  private thinkAccumulator = THINK_INTERVAL;

  constructor(options: FormationLeadOptions) {
    this.id = options.id;
    this.routine = options.routine;
    this.totalSeconds = routineSeconds(options.routine);
    this.terrain = options.terrain;
    this.terrainAvoidance = options.terrainAvoidance;
    this.missionRadius = options.missionRadius;
    this.terrainMargin = options.terrainMargin ?? 120;
    this.speedReference = options.speedReference ?? null;
    this.goal = {
      target: this.goalTarget,
      speed: FORMATION_SPEED,
      throttle: FORMATION_THROTTLE,
      maxBank: 30,
      climbBias: 0,
      headingBias: 0,
    };
  }

  get step(): RoutineStep | null {
    return (this.routine[this.stepIndex] as RoutineStep | undefined) ?? null;
  }

  get manoeuvre(): Manoeuvre {
    return this.step?.type ?? MANOEUVRE.Cruise;
  }

  get finished(): boolean {
    return this.elapsed >= this.totalSeconds;
  }

  get progress(): number {
    return this.totalSeconds > 0
      ? clamp(this.elapsed / this.totalSeconds, 0, 1)
      : 1;
  }

  get debug(): FormationLeadDebug {
    return {
      manoeuvre: this.manoeuvre,
      stepIndex: this.stepIndex,
      elapsed: this.elapsed,
      total: this.totalSeconds,
      progress: this.progress,
      finished: this.finished,
    };
  }

  /** The `AircraftController` the simulation calls every physics step. */
  control = (self: AircraftState, dt: number): FlightInput => {
    if (self.status !== FLIGHT_STATUS.Flying) return neutral(this.input);

    if (!this.started) {
      const angles = toHeadingPitchRoll(self.orientation);
      this.commandedHeading = angles.headingDeg;
      this.commandedAltitude = self.position.z;
      this.started = true;
    }

    this.advance(self, dt);

    this.thinkAccumulator += dt;
    if (this.thinkAccumulator >= THINK_INTERVAL) {
      this.terrainAvoidance.evaluate(self, this.terrainMargin, this.avoidance);
      this.thinkAccumulator = 0;
    }

    // An aileron roll is flown on the stick. There is no fly-to-point goal that
    // produces one, and pretending otherwise would give a wallowing barrel roll
    // rather than the crisp one a display needs. A multirotor is not asked for
    // one at all: full aileron on a quadcopter is a flip, and a flip held for
    // the length of a display step is an aircraft arriving in the field. It
    // flies the step as the leg it is, which is what a quadcopter display is.
    const step = this.step;
    if (step && step.type === MANOEUVRE.Roll && !self.config.rotor) {
      this.input.roll = step.bankDeg >= 0 ? 1 : -1;
      this.input.pitch = 0.08;
      this.input.yaw = 0;
      this.input.throttle = 0.75;
      return this.input;
    }

    this.buildGoal(self);
    return flyToward(self, this.goal, this.input);
  };

  /** Walks the routine clock forward and updates what is being commanded. */
  private advance(self: AircraftState, dt: number): void {
    this.elapsed += dt;
    this.stepElapsed += dt;

    let step = this.step;
    while (step && this.stepElapsed >= step.seconds) {
      this.stepElapsed -= step.seconds;
      this.stepIndex += 1;
      step = this.step;
    }
    if (!step) {
      // Routine over: hold what is being flown until the mission ends.
      this.stepIndex = this.routine.length;
      this.integrate(self, 0, 0, dt);
      return;
    }

    let bank = step.bankDeg;
    let climb = step.climb;
    if (step.type === MANOEUVRE.Wingover) {
      // Up and over on the first half, down and out on the second.
      const half = step.seconds / 2;
      climb = this.stepElapsed < half ? WINGOVER_CLIMB : -WINGOVER_CLIMB;
    }
    if (step.type === MANOEUVRE.Roll) {
      bank = 0;
      climb = 0;
    }
    this.integrate(self, bank, climb, dt);
  }

  /**
   * Turns the commanded bank into a heading rate the way a coordinated turn
   * does, and holds the commanded height inside a band above the ground.
   */
  private integrate(
    self: AircraftState,
    bankDeg: number,
    climb: number,
    dt: number,
  ): void {
    const speed = Math.max(self.airspeed, 12);
    const turnRate =
      ((GRAVITY * Math.tan(bankDeg * DEG_TO_RAD)) / speed) * RAD_TO_DEG;

    // The display stays over the mission area: past the leash the leader turns
    // for home at whatever rate it was already turning at.
    const fromOrigin = Math.hypot(self.position.x, self.position.y);
    if (fromOrigin > this.missionRadius * LEASH_FACTOR) {
      const homeBearing =
        (Math.atan2(-self.position.x, -self.position.y) * RAD_TO_DEG + 360) % 360;
      const error = ((homeBearing - this.commandedHeading + 540) % 360) - 180;
      const rate = Math.max(Math.abs(turnRate), 8);
      this.commandedHeading += clamp(error, -rate * dt, rate * dt);
    } else {
      this.commandedHeading += turnRate * dt;
    }
    this.commandedHeading = (this.commandedHeading + 360) % 360;

    this.commandedAltitude += climb * dt;
    const ground = this.terrain.heightAt(self.position.x, self.position.y);
    this.commandedAltitude = clamp(
      this.commandedAltitude,
      ground + LEAD_MIN_AGL,
      ground + LEAD_MAX_AGL,
    );
  }

  private buildGoal(self: AircraftState): void {
    const heading = this.commandedHeading * DEG_TO_RAD;
    V.set(
      this.goalTarget,
      self.position.x + Math.sin(heading) * LEAD_LOOKAHEAD,
      self.position.y + Math.cos(heading) * LEAD_LOOKAHEAD,
      this.commandedAltitude,
    );
    liftAboveTerrain(this.terrain, this.goalTarget, this.terrainMargin);

    const step = this.step;
    const bank = step ? Math.abs(step.bankDeg) : 0;
    this.goal = {
      target: this.goalTarget,
      speed: commandedSpeed(self.config, FORMATION_SPEED, this.speedReference),
      throttle: FORMATION_THROTTLE,
      maxBank: clamp(bank + 15, 25, 70),
      climbBias: this.avoidance.climbDemand,
      headingBias: this.avoidance.headingOffset,
    };
  }
}

// --- The wing pilot ----------------------------------------------------------

/**
 * How often a wingman re-aims at its slot.
 *
 * Far more often than it re-probes the terrain: in a 40-degree turn the slot
 * sweeps several metres a tenth of a second, and station keeping is exactly the
 * job where that difference shows.
 */
const STATION_INTERVAL = 1 / 30;
/** How far along the demanded velocity the autopilot is pointed, metres. */
const STATION_LOOKAHEAD = 160;
/** Closing speed demanded per metre off station, m/s per metre. */
const CLOSURE_GAIN = 0.25;
/**
 * Damping on the closing speed already being carried.
 *
 * Without it the correction is a position loop with a lag in it and nothing
 * opposing the overshoot, which is a wingman that swings through its slot and
 * back out the other side for the whole display.
 */
const CLOSURE_DAMPING = 0.8;
/** Most a wingman will add to the slot's own velocity to close on it, m/s. */
const CLOSURE_LIMIT = 10;
/** Smoothing on the computed slot velocity, per second. */
const STATION_VELOCITY_RATE = 8;
/** Hardest bank still treated as a coordinated turn the formation follows. */
const MAX_TURN_BANK_DEG = 70;

export interface FormationWingOptions {
  readonly id: string;
  readonly slot: FormationSlot;
  readonly terrain: TerrainSampler;
  readonly terrainAvoidance: TerrainAvoidanceSystem;
  /** The aircraft this one is flying on. */
  readonly getLead: () => AircraftState | null;
  /** Clearance kept above terrain, metres. */
  readonly terrainMargin?: number;
  /** Hardest bank this pilot will command, degrees. */
  readonly maxBank?: number;
  /** The fastest it is flown, m/s, on the same terms as the leader's. */
  readonly speedReference?: number;
}

export interface FormationWingDebug {
  readonly slot: FormationSlotId;
  readonly stationError: number;
  readonly hasLead: boolean;
}

/**
 * Holds a slot.
 *
 * Station keeping is two corrections at once: the autopilot points the aircraft
 * at where the slot will be in a moment, and a closure term trims the speed so
 * it arrives rather than sails past. Without the second one a wingman flying at
 * the formation speed can never close a gap it has already opened.
 */
export class FormationWingPilot {
  readonly id: string;
  readonly slot: FormationSlot;

  private readonly terrain: TerrainSampler;
  private readonly terrainAvoidance: TerrainAvoidanceSystem;
  private readonly getLead: () => AircraftState | null;
  private readonly terrainMargin: number;
  private readonly maxBank: number;
  private readonly speedReference: number | null;

  private readonly input: FlightInput = createFlightInput();
  private readonly goalTarget = V.vec3();
  private readonly station = V.vec3();
  private readonly stationVelocity = V.vec3();
  private readonly demand = V.vec3();
  private readonly avoidance: AvoidanceCommand = createAvoidanceCommand();
  private goal: AutopilotGoal;
  private thinkAccumulator = THINK_INTERVAL;
  private stationAccumulator = STATION_INTERVAL;
  private stationError = 0;
  private stationTracked = false;
  private turnBankDeg = 0;

  constructor(options: FormationWingOptions) {
    this.id = options.id;
    this.slot = options.slot;
    this.terrain = options.terrain;
    this.terrainAvoidance = options.terrainAvoidance;
    this.getLead = options.getLead;
    this.terrainMargin = options.terrainMargin ?? 110;
    this.maxBank = options.maxBank ?? 65;
    this.speedReference = options.speedReference ?? null;
    this.goal = {
      target: this.goalTarget,
      speed: FORMATION_SPEED,
      throttle: FORMATION_THROTTLE,
      maxBank: this.maxBank,
      climbBias: 0,
      headingBias: 0,
    };
  }

  get debug(): FormationWingDebug {
    return {
      slot: this.slot.id,
      stationError: this.stationError,
      hasLead: this.getLead() !== null,
    };
  }

  /** The `AircraftController` the simulation calls every physics step. */
  control = (self: AircraftState, dt: number): FlightInput => {
    if (self.status !== FLIGHT_STATUS.Flying) return neutral(this.input);

    this.thinkAccumulator += dt;
    if (this.thinkAccumulator >= THINK_INTERVAL) {
      this.terrainAvoidance.evaluate(self, this.terrainMargin, this.avoidance);
      this.thinkAccumulator = 0;
    }

    this.stationAccumulator += dt;
    if (this.stationAccumulator >= STATION_INTERVAL) {
      this.buildGoal(self, this.stationAccumulator);
      this.stationAccumulator = 0;
    }

    return flyToward(self, this.goal, this.input);
  };

  private buildGoal(self: AircraftState, dt: number): void {
    const lead = this.getLead();
    if (!lead || lead.status !== FLIGHT_STATUS.Flying) {
      // Nothing to fly on: hold heading and height rather than wander off.
      forwardAxis(_forward, self.orientation);
      V.addScaled(this.goalTarget, self.position, _forward, 600);
      this.goalTarget.z = self.position.z;
      liftAboveTerrain(this.terrain, this.goalTarget, this.terrainMargin);
      this.stationError = Number.POSITIVE_INFINITY;
      this.stationTracked = false;
      this.turnBankDeg = 0;
      this.goal = {
        target: this.goalTarget,
        speed: commandedSpeed(self.config, FORMATION_SPEED, this.speedReference),
        throttle: FORMATION_THROTTLE,
        maxBank: this.maxBank,
        climbBias: this.avoidance.climbDemand,
        headingBias: this.avoidance.headingOffset,
      };
      return;
    }

    formationStation(this.station, lead, this.slot);
    this.trackStationVelocity(lead, dt);
    V.subtract(_offset, this.station, self.position);
    this.stationError = V.length(_offset);

    /*
     * Fly the slot's velocity, not the slot.
     *
     * Chasing the point itself does not work in a turn: the leader's radius is
     * under a hundred metres, so a wingman a station away is most of a radius
     * off the centre, and pure pursuit settles into a stable orbit alongside
     * the formation instead of closing on it. What the aircraft actually needs
     * is the velocity the slot has — which is the leader's, rotated by however
     * fast the formation is turning — plus enough of a correction to walk in
     * from wherever it currently is.
     */
    V.scale(_correction, _offset, CLOSURE_GAIN);
    V.subtract(_relative, self.velocity, this.stationVelocity);
    V.addScaled(_correction, _correction, _relative, -CLOSURE_DAMPING);
    const magnitude = V.length(_correction);
    if (magnitude > CLOSURE_LIMIT) {
      V.scale(_correction, _correction, CLOSURE_LIMIT / magnitude);
    }
    V.add(this.demand, this.stationVelocity, _correction);

    const horizontal = Math.hypot(this.demand.x, this.demand.y);
    if (horizontal > 1e-3) {
      V.set(
        this.goalTarget,
        self.position.x + (this.demand.x / horizontal) * STATION_LOOKAHEAD,
        self.position.y + (this.demand.y / horizontal) * STATION_LOOKAHEAD,
        // Height is flown against the slot itself: an altitude loop holds it
        // far more steadily than a projected velocity vector does.
        this.station.z,
      );
    } else {
      V.copy(this.goalTarget, this.station);
    }
    liftAboveTerrain(this.terrain, this.goalTarget, this.terrainMargin);

    this.goal = {
      target: this.goalTarget,
      speed: commandedSpeed(
        self.config,
        clamp(V.length(this.demand), 12, 40),
        this.speedReference,
      ),
      throttle: FORMATION_THROTTLE,
      // The slot's own rate of climb is fed forward for the same reason the
      // turn is: the altitude loop is proportional, so matching a leader's
      // climb without it costs a standing thirty or forty metres of sag.
      climbBias: this.avoidance.climbDemand + this.stationVelocity.z,
      maxBank: this.maxBank,
      headingBias:
        this.avoidance.headingOffset + this.turnFeedforward(self.airspeed),
    };
  }

  /**
   * Works out how fast the slot is moving.
   *
   * Computed rather than measured. Differencing the station point looks like
   * the honest way to do it and is not: the leader's roll never sits perfectly
   * still, and a slot fifty metres out on the wing turns a degree of roll
   * wobble into metres of movement, so the difference comes back as tens of
   * metres a second of noise that the wingman then chases.
   *
   * A slot on a turning leader moves at the leader's own velocity plus the
   * rotation of the formation about it, and the rate of that rotation is what
   * a coordinated turn at the leader's bank gives. Both are smooth.
   */
  private trackStationVelocity(lead: AircraftState, dt: number): void {
    const horizontal = Math.max(Math.hypot(lead.velocity.x, lead.velocity.y), 8);
    const rollDeg = toHeadingPitchRoll(lead.orientation).rollDeg;
    // Past ninety degrees the leader is not turning, it is rolling, and the
    // formation is not expected to follow it round.
    this.turnBankDeg =
      Math.abs(rollDeg) > 90 ? 0 : clamp(rollDeg, -MAX_TURN_BANK_DEG, MAX_TURN_BANK_DEG);

    const omega =
      (GRAVITY * Math.tan(this.turnBankDeg * DEG_TO_RAD)) / horizontal;
    const leverX = this.station.x - lead.position.x;
    const leverY = this.station.y - lead.position.y;
    V.set(
      _offset,
      lead.velocity.x + omega * leverY,
      lead.velocity.y - omega * leverX,
      lead.velocity.z,
    );

    if (!this.stationTracked || dt <= 0) {
      this.stationTracked = true;
      V.copy(this.stationVelocity, _offset);
      return;
    }
    V.lerpVec3(
      this.stationVelocity,
      this.stationVelocity,
      _offset,
      1 - Math.exp(-STATION_VELOCITY_RATE * dt),
    );
  }

  /**
   * The heading offset that holds the formation's turn.
   *
   * The autopilot's heading loop is proportional, so sustaining a turn costs a
   * standing heading error — around twenty degrees in a hard one. Left alone
   * that error is a wingman permanently pointing outside the turn and sliding
   * wide of its slot, so the turn the formation is already in is fed forward
   * and only what is left over has to be corrected. What that error works out
   * to depends on the speed it is flown at, so the autopilot is asked rather
   * than assumed.
   */
  private turnFeedforward(airspeed: number): number {
    return headingErrorForBank(
      clamp(this.turnBankDeg, -this.maxBank, this.maxBank),
      airspeed,
    );
  }
}

function neutral(input: FlightInput): FlightInput {
  input.pitch = 0;
  input.roll = 0;
  input.yaw = 0;
  input.throttle = 0;
  return input;
}
