/**
 * What the aircraft should sound like, as numbers.
 *
 * The Web Audio graph lives in `lib/audio`; this decides what to feed it. The
 * split is the same one used everywhere else — the part with the physics in it
 * is plain arithmetic that runs in Node, and the part that touches a browser
 * API has no judgement of its own.
 */

import { clamp, lerp } from "../math/scalar";
import type { AircraftConfig } from "../flight/config";

export interface EngineSound {
  /** Blade-passing frequency, Hz. The pitch a listener actually hears. */
  readonly frequency: number;
  /** 0..1. */
  readonly gain: number;
  /** 0..1 — how much broadband blade wash rides on the tone. */
  readonly noise: number;
  /**
   * 0..1 — how uneven the tone is, from an airframe that has been hit.
   *
   * Depth of the once-per-revolution beat: 0 is a motor straight off the
   * bench, and anything above it is a propeller or a mount that is no longer
   * true. This is the part of the sound that says *damaged* rather than
   * *loud*.
   */
  readonly roughness: number;
  /**
   * The rate that unevenness beats at, Hz.
   *
   * A propeller out of balance is heard once per turn of the shaft, so this is
   * the shaft rate — the blade-passing frequency divided by the blade count —
   * held to the band where it is still heard as unevenness. It rises with the
   * revs, which is why a damaged motor flutters at idle and growls at full
   * throttle rather than buzzing at one fixed rate.
   */
  readonly wobble: number;
}

/**
 * What a contact left of the machinery, as far as the ear is concerned.
 *
 * Structurally what `flight/damage.ts` keeps for every airframe, narrowed to
 * the two fields the noise depends on, so an `AircraftDamage` can be handed
 * straight in and this module still owes the flight model nothing.
 */
export interface EngineCondition {
  /** Structural condition: 1 as it left the bench, 0 written off. */
  readonly integrity: number;
  /** Fraction of the motor's thrust still available, 0..1. */
  readonly thrustFactor: number;
}

/** An airframe nothing has happened to yet. */
export const HEALTHY_ENGINE: EngineCondition = {
  integrity: 1,
  thrustFactor: 1,
};

export interface WindSound {
  /** 0..1. */
  readonly gain: number;
  /** Low-pass corner, Hz. Rises with speed, which is what makes it a rush. */
  readonly cutoff: number;
}

export interface EngineProfile {
  /** Motor speed with the throttle closed, rev/min. */
  readonly idleRpm: number;
  /** Motor speed at full throttle, unloaded, rev/min. */
  readonly maxRpm: number;
  readonly blades: number;
  /** Airspeed at which the propeller is fully unloaded, m/s. */
  readonly propPitchSpeed: number;
}

export const WING_ENGINE: EngineProfile = {
  // A 2.2 kg wing on a 7-inch pusher: idles audibly, and spins to about
  // twelve thousand at full power.
  idleRpm: 2200,
  maxRpm: 12600,
  blades: 2,
  propPitchSpeed: 38,
};

/**
 * The CA35-160, which sounds nothing like either wing.
 *
 * Four small three-bladed propellers turning six times as fast as a wing's
 * pusher. The blade-passing rate comes out around two kilohertz at full
 * throttle rather than four hundred hertz, which is the whole reason a
 * quadcopter going past is a scream and a wing going past is a hum.
 */
export const QUAD_ENGINE: EngineProfile = {
  idleRpm: 4500,
  maxRpm: 42000,
  blades: 3,
  propPitchSpeed: 50.6,
};

/**
 * The Foamie Glider 480, which sits between the two.
 *
 * A pair of 2.5-inch two-bladed propellers spinning to the far side of thirty
 * thousand: about twelve hundred hertz at full throttle, which is a buzz
 * rather than the wing's hum or the quadcopter's scream. And it is the only
 * airframe here that is genuinely quiet with the throttle shut, because a
 * glider with the motors off is a glider.
 */
export const GLIDER_ENGINE: EngineProfile = {
  idleRpm: 3000,
  maxRpm: 37000,
  blades: 2,
  propPitchSpeed: 39.9,
};

/**
 * The X10 Interceptor, which is the loudest thing here and the lowest of the
 * three multirotor-ish tones.
 *
 * Four two-bladed propellers rather than four three-bladed ones, turning at
 * three quarters of a racing quad's rpm because they are bigger and pulling far
 * harder. Two blades at forty-six thousand is about fifteen hundred hertz at
 * full throttle — under the CA35's scream and well over either wing — and it
 * arrives at a hundred metres a second, which is most of what makes one of
 * these frightening to be near. It idles high as well: a body this draggy is
 * never left with the motors properly shut down.
 */
export const ROCKET_ENGINE: EngineProfile = {
  idleRpm: 6000,
  maxRpm: 46200,
  blades: 2,
  propPitchSpeed: 137,
};

/**
 * The Skyeye series, which is not a motor at all and does not sound like one.
 *
 * A petrol two-stroke swinging a two-bladed propeller two feet across at seven
 * thousand rpm: two hundred and forty hertz at full power, where a foam wing is
 * four hundred and a racing quadcopter is two thousand. That is an octave below
 * everything else here and it is not a hum, it is a bark — the lowest, loudest
 * and least electric thing in the hangar.
 *
 * The idle is the part that matters. Every other airframe here is silent with
 * the stick down, because the motor has stopped. This one is not: it sits at
 * eighteen hundred rpm, sixty hertz, an unmistakable lumpy throb that says the
 * aeroplane is alive and will move the moment it is asked to. A pilot who has
 * flown one of these knows where the throttle is with their eyes shut.
 */
export const PISTON_ENGINE: EngineProfile = {
  idleRpm: 1800,
  maxRpm: 7300,
  blades: 2,
  propPitchSpeed: 41,
};

/** The motor tone that belongs to an airframe. */
export function engineProfileFor(config: AircraftConfig): EngineProfile {
  if (config.shape === "rocket") return ROCKET_ENGINE;
  if (config.rotor) return QUAD_ENGINE;
  if (config.shape === "skyeye") return PISTON_ENGINE;
  return config.shape === "glider" ? GLIDER_ENGINE : WING_ENGINE;
}

/** Reference speed for the airframe rush, m/s. */
const WIND_REFERENCE_SPEED = 34;
const WIND_FLOOR_SPEED = 3;

/**
 * How much of the revs a motor loses when its drive is gone.
 *
 * Not all of them: a wing that has taken the propeller off its tail is still
 * carrying a motor, and what is left of the blade still turns. But it is
 * turning against a broken load, so it never sings the way it did — which is
 * the pitch drop a pilot hears the moment after the hit.
 */
const WRECKED_RPM_LOSS = 0.32;
/** How much of the tone a lost drive takes with it. */
const WRECKED_GAIN_LOSS = 0.3;
/** Broadband wash a written-off airframe adds to its own tone. */
const WRECKED_NOISE = 0.45;
/** How heavily bent structure and a spoiled propeller each beat the tone. */
const STRUCTURE_ROUGHNESS = 0.6;
const DRIVE_ROUGHNESS = 0.8;
/**
 * The band the once-per-revolution beat is heard in, Hz.
 *
 * Below a few hertz a beat is not a beat, it is the motor being turned up and
 * down; and a racing quadcopter's shaft rate at full song is most of a
 * kilohertz, which stops being unevenness and starts being a second tone
 * fighting the first. Held between the two, every airframe here answers damage
 * with the same recognisable lumpiness rather than five unrelated noises.
 */
const MIN_WOBBLE_HZ = 4;
const MAX_WOBBLE_HZ = 190;

/**
 * How badly a contact spoiled the noise, 0..1.
 *
 * Two different things make a motor sound wrong and an airframe collects them
 * separately. Structure is the airframe around it: torn foam and a bent mount
 * that the whole machine now shakes through, which is what a wing strike
 * leaves. Drive is the motor and the propeller themselves, which is what a hit
 * from behind takes. Either alone is audible; a hit that does both is the one
 * that sounds like the aircraft is coming apart.
 */
function engineHarm(condition: EngineCondition): number {
  const structure = clamp(1 - condition.integrity, 0, 1);
  const lostDrive = clamp(1 - condition.thrustFactor, 0, 1);
  return clamp(
    STRUCTURE_ROUGHNESS * structure + DRIVE_ROUGHNESS * lostDrive,
    0,
    1,
  );
}

/**
 * Motor tone from throttle, airspeed and what is left of the airframe.
 *
 * Frequency is the blade-passing rate, which is what gives a propeller its
 * pitch — the specification's low, medium and high at 0%, 50% and 100% falls
 * out of the motor's own rev range rather than being imposed on top of it.
 *
 * Airspeed matters as well as throttle. A propeller flying faster than its
 * pitch is being driven by the air rather than driving it, so a closed
 * throttle in a dive still turns the motor and still makes a noise. Without
 * that the aircraft goes silent exactly when it is going fastest.
 *
 * Damage matters too, and it is meant to be heard before it is read off the
 * OSD. A machine that has met another one turns slower for the same stick,
 * loses some of its tone, gains a wash of broken-blade noise over the top of
 * it, and — the part that actually says *hit* — starts beating once per turn
 * of the shaft, because nothing back there is true any more. All four grow
 * with the damage, so the third contact sounds worse than the first.
 */
export function engineSound(
  throttle: number,
  airspeed: number,
  profile: EngineProfile = WING_ENGINE,
  condition: EngineCondition = HEALTHY_ENGINE,
): EngineSound {
  const power = clamp(throttle, 0, 1);
  const harm = engineHarm(condition);
  const lostDrive = clamp(1 - condition.thrustFactor, 0, 1);
  const commandedRpm =
    lerp(profile.idleRpm, profile.maxRpm, power) *
    (1 - WRECKED_RPM_LOSS * lostDrive);

  // Windmilling: the airflow alone would turn the prop at roughly the rate
  // its pitch implies. Whichever is faster is what the motor actually does.
  const windmillRpm =
    (clamp(airspeed, 0, profile.propPitchSpeed * 1.6) /
      Math.max(profile.propPitchSpeed, 1)) *
    profile.maxRpm *
    0.55;
  const rpm = Math.max(commandedRpm, windmillRpm);

  const frequency = (rpm / 60) * profile.blades;

  // Loudness follows power rather than revs, so a windmilling prop is heard
  // but never drowns out the airframe.
  const driven = 0.12 + 0.88 * Math.pow(power, 0.7);
  const windmilling = windmillRpm > commandedRpm ? 0.28 : 0;
  const gain = clamp(
    Math.max(driven * 0.85 * (1 - WRECKED_GAIN_LOSS * lostDrive), windmilling),
    0,
    1,
  );

  // A loaded propeller is rougher than an idling one, and a broken one is
  // rougher than either.
  const noise = clamp(0.18 + 0.42 * power + WRECKED_NOISE * harm, 0, 1);

  return {
    frequency,
    gain,
    noise,
    roughness: harm,
    // Once per revolution: the shaft rate, which is the blade-passing rate
    // shared out over the blades that pass at it.
    wobble: clamp(
      frequency / Math.max(profile.blades, 1),
      MIN_WOBBLE_HZ,
      MAX_WOBBLE_HZ,
    ),
  };
}

/**
 * Airframe rush from airspeed.
 *
 * Aerodynamic noise goes roughly with the square of speed, so the rush is
 * barely there on the ground and dominant in a dive — which is the cue a pilot
 * actually flies by when the horizon is not helping.
 */
export function windSound(airspeed: number): WindSound {
  const speed = Math.max(0, airspeed - WIND_FLOOR_SPEED);
  const ratio = speed / WIND_REFERENCE_SPEED;
  const gain = clamp(ratio * ratio * 0.55, 0, 0.85);
  const cutoff = clamp(300 + ratio * 2600, 300, 5200);
  return { gain, cutoff };
}

/** What flying through a race gate sounds like. */
export interface GateChime {
  /** The note the crossing rings on, Hz. */
  readonly frequency: number;
  /** The note it lands on a moment later, Hz. */
  readonly resolve: number;
  /** 0..1 — how loud the two notes are. */
  readonly level: number;
  /** 0..1 — the air through the frame, under the notes. */
  readonly swish: number;
}

/**
 * The note the start of a course rings on, Hz.
 *
 * High deliberately. A wing at racing throttle is a few hundred hertz of motor
 * with the airframe rush piled on top of it, and a gate that rings down there
 * is a gate the pilot does not hear. C6 is well clear of the motor, and the
 * octave above it is the band the ear is sharpest in — which is how a chime
 * this quiet cuts through a rush that is nowhere near as far below it.
 */
const GATE_BASE_HZ = 1046.5;
/**
 * The scale a course climbs, in semitones from the base.
 *
 * Major pentatonic, ending on the octave: any two gates in a row are
 * consonant, wherever on the course they fall, so a fast course reads as a
 * run rather than as a series of beeps.
 */
const GATE_SCALE = [0, 2, 4, 7, 9, 12] as const;

/**
 * What one gate crossing sounds like, from how far round the course it is.
 *
 * A gate is not just a chirp: it is the moment the frame goes past, so it is
 * air first and then a note. And the note climbs — a gate late in the race
 * rings higher and louder than the one off the start line, which is what makes
 * a course sound like it is being flown rather than like the same event
 * happening ten times.
 *
 * @param progress 0 on the start line, 1 at the finish.
 */
export function gateChime(progress: number): GateChime {
  const along = clamp(progress, 0, 1);
  const degree = Math.round(along * (GATE_SCALE.length - 1));
  const step = GATE_SCALE[degree] as number;
  const frequency = GATE_BASE_HZ * Math.pow(2, step / 12);
  return {
    frequency,
    // A fifth over the top of it: two notes read as something happening, where
    // one on its own reads as an instrument complaining.
    resolve: frequency * 1.5,
    level: lerp(0.2, 0.3, along),
    swish: lerp(0.16, 0.24, along),
  };
}

/**
 * How hard a collision sounded, 0..1.
 *
 * Closing speed, not absolute speed: two aircraft converging head-on hit far
 * harder than one overtaking another, and the sound should say so.
 */
export function impactStrength(closingSpeed: number): number {
  return clamp(Math.abs(closingSpeed) / 90, 0.18, 1);
}
