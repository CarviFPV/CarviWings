/**
 * Enemy AI states and difficulty.
 *
 * The AI never touches an aircraft's position or attitude. It produces the same
 * normalised `FlightInput` a pilot's keyboard does, and the shared flight model
 * turns that into motion — an enemy is subject to exactly the same stall,
 * inertia and terrain as the player.
 */

export const AI_STATE = {
  /** Flying the assigned route, watching. */
  Patrol: "PATROL",
  /** Something was noticed; closing in to confirm it. */
  Search: "SEARCH",
  /** Confirmed contact, running an intercept on the predicted position. */
  Intercept: "INTERCEPT",
  /** Inside ramming range, flying the collision. */
  Attack: "ATTACK",
  /** Overshot or badly out of position; breaking off to reset. */
  Evade: "EVADE",
  /**
   * Spotted an interceptor coming and decided not to fight it. Running, at
   * power, until the pilot judges it has broken contact.
   */
  Flee: "FLEE",
  /** No longer flying. */
  Crashed: "CRASHED",
} as const;

export type AiState = (typeof AI_STATE)[keyof typeof AI_STATE];

export const DIFFICULTY = {
  Easy: "EASY",
  Normal: "NORMAL",
  Hard: "HARD",
} as const;

export type Difficulty = (typeof DIFFICULTY)[keyof typeof DIFFICULTY];

/**
 * What a difficulty setting actually changes.
 *
 * Deliberately nothing about the airframe: which aircraft the contacts are
 * flying is the mission's opposition setting, and whatever it says they fly it
 * with the identical limits at every difficulty. What varies is how well they
 * see, how quickly they react, how far ahead they aim, and how hard they are
 * willing to manoeuvre — the pilot, not the aeroplane.
 */
export interface DifficultyProfile {
  readonly id: Difficulty;
  readonly label: string;
  readonly description: string;

  // --- Perception -----------------------------------------------------------
  /** Confidence gained per second while the target is clearly visible. */
  readonly detectionRate: number;
  /** Confidence lost per second while it is not. */
  readonly forgetRate: number;
  /** Scales the visibility system's sight range for this pilot. */
  readonly sightRangeFactor: number;
  /** Full-angle cone within which a contact is spotted quickly, degrees. */
  readonly fieldOfView: number;
  /** How much attention is paid outside that cone, 0..1. */
  readonly peripheralFactor: number;

  // --- Decision -------------------------------------------------------------
  /** Seconds a transition condition must hold before the AI acts on it. */
  readonly reactionTime: number;
  /** 0 = pure pursuit (aims where you are), 1 = perfect lead. */
  readonly prediction: number;
  /** Range at which it commits to the ramming pass, metres. */
  readonly attackRange: number;
  /** Seconds spent resetting after an overshoot. */
  readonly evadeDuration: number;

  // --- Flying ---------------------------------------------------------------
  /** Hardest bank the AI will command, degrees. */
  readonly maxBank: number;
  /** Nominal cruise throttle on patrol. Each pilot varies around it. */
  readonly patrolThrottle: number;
  /** How far a pilot's own cruise throttle sits either side of that nominal. */
  readonly throttleVariation: number;
  /** Throttle once committed. Never above the player's own maximum. */
  readonly attackThrottle: number;
  /** Throttle while running from a contact. */
  readonly fleeThrottle: number;
  /**
   * Chance this pilot runs from a contact rather than turning to fight it,
   * decided once per engagement. A nervous pilot runs from most things it
   * sees; a confident one almost never does.
   */
  readonly evasionChance: number;
  /** Extra terrain clearance this pilot keeps, metres. */
  readonly terrainMargin: number;
}

export const DIFFICULTY_PROFILES: Readonly<
  Record<Difficulty, DifficultyProfile>
> = {
  [DIFFICULTY.Easy]: {
    id: DIFFICULTY.Easy,
    label: "Easy",
    description: "Slow to notice you, aims where you are rather than where you will be.",
    detectionRate: 0.35,
    forgetRate: 0.55,
    sightRangeFactor: 0.55,
    fieldOfView: 100,
    peripheralFactor: 0.12,
    reactionTime: 1.6,
    prediction: 0.2,
    attackRange: 250,
    evadeDuration: 7,
    maxBank: 40,
    patrolThrottle: 0.55,
    throttleVariation: 0.07,
    attackThrottle: 0.9,
    fleeThrottle: 0.92,
    evasionChance: 0.6,
    terrainMargin: 140,
  },
  [DIFFICULTY.Normal]: {
    id: DIFFICULTY.Normal,
    label: "Normal",
    description: "Sees you at reasonable range and leads the shot.",
    detectionRate: 0.7,
    forgetRate: 0.3,
    sightRangeFactor: 0.85,
    fieldOfView: 130,
    peripheralFactor: 0.25,
    reactionTime: 0.8,
    prediction: 0.65,
    attackRange: 360,
    evadeDuration: 5,
    maxBank: 55,
    patrolThrottle: 0.6,
    throttleVariation: 0.06,
    attackThrottle: 1,
    fleeThrottle: 0.96,
    evasionChance: 0.35,
    terrainMargin: 100,
  },
  [DIFFICULTY.Hard]: {
    id: DIFFICULTY.Hard,
    label: "Hard",
    description: "Picks you up early, predicts well and commits hard.",
    detectionRate: 1.2,
    forgetRate: 0.14,
    sightRangeFactor: 1,
    fieldOfView: 170,
    peripheralFactor: 0.4,
    reactionTime: 0.3,
    prediction: 0.95,
    attackRange: 500,
    evadeDuration: 3.5,
    maxBank: 70,
    patrolThrottle: 0.65,
    throttleVariation: 0.05,
    attackThrottle: 1,
    fleeThrottle: 1,
    evasionChance: 0.15,
    terrainMargin: 70,
  },
} as const;

/** Confidence at which a contact counts as confirmed. */
export const CONFIRM_CONFIDENCE = 0.6;
/** Confidence at which the AI starts investigating. */
export const NOTICE_CONFIDENCE = 0.18;
/** Below this the contact is considered lost. */
export const LOST_CONFIDENCE = 0.05;
