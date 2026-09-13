"use client";

/**
 * The flight soundscape, generated entirely by the Web Audio API.
 *
 * Nothing is sampled and no audio file ships with the project: the motor is an
 * oscillator bank at the propeller's blade-passing frequency, the airframe rush
 * is filtered noise, and every one-shot is an envelope over one of the two.
 * What each of them should sound like at a given moment is decided in
 * `sim/audio/soundModel.ts`, which is plain arithmetic; this only builds the
 * graph and drives it.
 *
 * Two continuous voices run for the whole flight and are retuned each frame.
 * Cues allocate a handful of nodes, play, and disconnect themselves. There is
 * no polling, no timer and no per-frame allocation.
 */

import type { EngineCondition, EngineProfile } from "@/sim/audio/soundModel";
import {
  HEALTHY_ENGINE,
  WING_ENGINE,
  engineSound,
  gateChime,
  impactStrength,
  windSound,
} from "@/sim/audio/soundModel";
import { clamp } from "@/sim/math/scalar";

export const SOUND_CUE = {
  Collision: "COLLISION",
  /** A charge going off on the wing: the collision cue, with the bang. */
  Explosion: "EXPLOSION",
  Crash: "CRASH",
  /** A belly arriving on a field: a scrape rather than a bang. */
  Touchdown: "TOUCHDOWN",
  TargetDetected: "TARGET_DETECTED",
  /** A race gate flown through: short, bright and out of the way. */
  Gate: "GATE",
  MissionComplete: "MISSION_COMPLETE",
  MissionFailed: "MISSION_FAILED",
  Launch: "LAUNCH",
  /** A lightning strike, arriving however late the distance says it should. */
  Thunder: "THUNDER",
} as const;

export type SoundCue = (typeof SOUND_CUE)[keyof typeof SOUND_CUE];

/** Shortest gap between two of the same cue, seconds. */
const CUE_COOLDOWN: Record<SoundCue, number> = {
  COLLISION: 0.12,
  EXPLOSION: 0.4,
  CRASH: 0.6,
  TOUCHDOWN: 1.5,
  TARGET_DETECTED: 1.2,
  GATE: 0.25,
  MISSION_COMPLETE: 3,
  MISSION_FAILED: 3,
  LAUNCH: 0.5,
  // Short: a flash is often three strokes, and each of them cracks.
  THUNDER: 0.12,
};

/** How quickly the continuous voices follow a change, seconds. */
const TONE_GLIDE = 0.05;
const GAIN_GLIDE = 0.08;
/** Fade applied when the flight pauses, seconds. */
const MUTE_GLIDE = 0.08;
/**
 * How deeply a written-off airframe's motor beats, as a fraction of its level.
 *
 * Under one, so even the worst of it is a motor labouring rather than a motor
 * cutting in and out — the aircraft is still flying, and the sound has to stay
 * something a pilot can fly by.
 */
const WOBBLE_DEPTH = 0.8;
/** How far damage pulls the motor's octave sharp, as a fraction of it. */
const DAMAGED_DETUNE = 0.02;

export interface FlightSoundState {
  readonly throttle: number;
  readonly airspeed: number;
  /** False once the aircraft is destroyed: the motor stops, the rush does not. */
  readonly powered: boolean;
  /**
   * What is left of the airframe, or null for one nothing has happened to.
   *
   * An `AircraftDamage` fits straight in: a machine that has been into another
   * one does not sound the way it did off the bench, and the pilot should hear
   * that without looking at the OSD.
   */
  readonly condition?: EngineCondition | null;
}

type Ctor = typeof AudioContext;

function audioContextConstructor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const scoped = window as unknown as {
    AudioContext?: Ctor;
    webkitAudioContext?: Ctor;
  };
  return scoped.AudioContext ?? scoped.webkitAudioContext ?? null;
}

/** Two seconds of white noise, reused by every voice that needs any. */
function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const length = context.sampleRate * 2;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    // Lightly integrated white noise: closer to the pink of real airflow than
    // raw white, which hisses.
    value = value * 0.86 + (Math.random() * 2 - 1) * 0.14;
    data[i] = clamp(value * 3.2, -1, 1);
  }
  return buffer;
}

export class Soundscape {
  private readonly context: AudioContext;
  private readonly noiseBuffer: AudioBuffer;
  private readonly master: GainNode;
  private readonly profile: EngineProfile;

  private readonly engineGain: GainNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly fundamental: OscillatorNode;
  private readonly harmonic: OscillatorNode;
  private readonly harmonicGain: GainNode;
  private readonly engineNoise: AudioBufferSourceNode;
  private readonly engineNoiseFilter: BiquadFilterNode;
  private readonly engineNoiseGain: GainNode;
  private readonly wobble: OscillatorNode;
  private readonly wobbleDepth: GainNode;

  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly windNoise: AudioBufferSourceNode;

  private readonly lastCueAt = new Map<SoundCue, number>();
  private volume: number;
  private muted = false;
  private destroyed = false;

  private constructor(
    context: AudioContext,
    volume: number,
    profile: EngineProfile,
  ) {
    this.context = context;
    this.volume = clamp(volume, 0, 1);
    this.profile = profile;
    this.noiseBuffer = createNoiseBuffer(context);

    this.master = context.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(context.destination);

    // --- Motor ------------------------------------------------------------
    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.master);

    this.engineFilter = context.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 2400;
    this.engineFilter.Q.value = 0.7;
    this.engineFilter.connect(this.engineGain);

    this.fundamental = context.createOscillator();
    this.fundamental.type = "sawtooth";
    this.fundamental.frequency.value = 80;
    this.fundamental.connect(this.engineFilter);

    // A second voice an octave up gives the motor its edge under power.
    this.harmonicGain = context.createGain();
    this.harmonicGain.gain.value = 0.15;
    this.harmonicGain.connect(this.engineFilter);
    this.harmonic = context.createOscillator();
    this.harmonic.type = "square";
    this.harmonic.frequency.value = 160;
    this.harmonic.connect(this.harmonicGain);

    this.engineNoiseGain = context.createGain();
    this.engineNoiseGain.gain.value = 0;
    this.engineNoiseGain.connect(this.engineGain);
    this.engineNoiseFilter = context.createBiquadFilter();
    this.engineNoiseFilter.type = "bandpass";
    this.engineNoiseFilter.frequency.value = 900;
    this.engineNoiseFilter.Q.value = 0.8;
    this.engineNoiseFilter.connect(this.engineNoiseGain);
    this.engineNoise = context.createBufferSource();
    this.engineNoise.buffer = this.noiseBuffer;
    this.engineNoise.loop = true;
    this.engineNoise.connect(this.engineNoiseFilter);

    // Damage: a propeller or a mount that is no longer true beats once per
    // turn of the shaft. It is the whole motor voice that beats, tone and
    // blade wash together, so the oscillator is summed into the motor's own
    // gain rather than given a voice of its own — silent at full depth zero,
    // which is what an undamaged airframe runs at.
    this.wobbleDepth = context.createGain();
    this.wobbleDepth.gain.value = 0;
    this.wobbleDepth.connect(this.engineGain.gain);
    this.wobble = context.createOscillator();
    this.wobble.type = "sine";
    this.wobble.frequency.value = 12;
    this.wobble.connect(this.wobbleDepth);

    // --- Airframe ---------------------------------------------------------
    this.windGain = context.createGain();
    this.windGain.gain.value = 0;
    this.windGain.connect(this.master);
    this.windFilter = context.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 600;
    this.windFilter.Q.value = 0.5;
    this.windFilter.connect(this.windGain);
    this.windNoise = context.createBufferSource();
    this.windNoise.buffer = this.noiseBuffer;
    this.windNoise.loop = true;
    this.windNoise.connect(this.windFilter);

    const now = context.currentTime;
    this.fundamental.start(now);
    this.harmonic.start(now);
    this.engineNoise.start(now);
    this.windNoise.start(now);
    this.wobble.start(now);
  }

  /**
   * Builds the graph, or returns null where Web Audio is unavailable.
   *
   * Silence is a perfectly reasonable outcome — a browser without the API, or
   * one that will not start a context — and it is not an error worth stopping
   * a flight for.
   */
  static create(
    volume: number,
    profile: EngineProfile = WING_ENGINE,
  ): Soundscape | null {
    const Ctor = audioContextConstructor();
    if (!Ctor) return null;
    try {
      const context = new Ctor({ latencyHint: "interactive" });
      const soundscape = new Soundscape(context, volume, profile);
      void soundscape.resume();
      return soundscape;
    } catch {
      return null;
    }
  }

  /**
   * Browsers refuse to start a context without a gesture behind it.
   *
   * Starting a flight is a click, so this normally succeeds immediately; it is
   * safe to call again from an input handler if it did not.
   */
  async resume(): Promise<void> {
    if (this.destroyed) return;
    if (this.context.state === "running") return;
    try {
      await this.context.resume();
    } catch {
      // Still waiting for a gesture. Nothing to do but stay quiet.
    }
  }

  get running(): boolean {
    return !this.destroyed && this.context.state === "running";
  }

  setVolume(volume: number): void {
    if (this.destroyed) return;
    this.volume = clamp(volume, 0, 1);
    this.applyMaster();
  }

  /** Silences everything without tearing the graph down, e.g. while paused. */
  setMuted(muted: boolean): void {
    if (this.destroyed || this.muted === muted) return;
    this.muted = muted;
    this.applyMaster();
  }

  private applyMaster(): void {
    const target = this.muted ? 0 : this.volume;
    this.master.gain.setTargetAtTime(
      target,
      this.context.currentTime,
      MUTE_GLIDE,
    );
  }

  /** Retunes the continuous voices. Cheap enough to call every frame. */
  update(state: FlightSoundState): void {
    if (this.destroyed) return;
    const now = this.context.currentTime;

    const engine = state.powered
      ? engineSound(
          state.throttle,
          state.airspeed,
          this.profile,
          state.condition ?? HEALTHY_ENGINE,
        )
      : { frequency: 40, gain: 0, noise: 0, roughness: 0, wobble: 12 };

    this.fundamental.frequency.setTargetAtTime(
      engine.frequency,
      now,
      TONE_GLIDE,
    );
    // The octave is only an octave while the machinery is true. A damaged one
    // is pulled slightly sharp of it, so the two voices beat against each
    // other instead of locking: a motor that no longer sounds like one note.
    this.harmonic.frequency.setTargetAtTime(
      engine.frequency * 2 * (1 + DAMAGED_DETUNE * engine.roughness),
      now,
      TONE_GLIDE,
    );
    // The motor opens up as well as gets louder: a closed throttle is muffled
    // and full power is bright.
    this.engineFilter.frequency.setTargetAtTime(
      900 + engine.gain * 3200,
      now,
      GAIN_GLIDE,
    );
    this.engineNoiseFilter.frequency.setTargetAtTime(
      clamp(engine.frequency * 2.4, 200, 6000),
      now,
      GAIN_GLIDE,
    );
    this.engineNoiseGain.gain.setTargetAtTime(
      engine.noise * engine.gain * 0.35,
      now,
      GAIN_GLIDE,
    );
    const level = engine.gain * 0.32;
    this.engineGain.gain.setTargetAtTime(level, now, GAIN_GLIDE);

    // The beat rides on that level, so it grows with the damage and disappears
    // with the motor: a wreck on its way down is not a rough motor, it is no
    // motor at all.
    this.wobble.frequency.setTargetAtTime(engine.wobble, now, TONE_GLIDE);
    this.wobbleDepth.gain.setTargetAtTime(
      level * engine.roughness * WOBBLE_DEPTH,
      now,
      GAIN_GLIDE,
    );

    const wind = windSound(state.airspeed);
    this.windFilter.frequency.setTargetAtTime(wind.cutoff, now, GAIN_GLIDE);
    this.windGain.gain.setTargetAtTime(wind.gain * 0.42, now, GAIN_GLIDE);
  }

  /**
   * Plays a one-shot.
   *
   * `strength` is 0..1: how hard it was for the impact cues, and for a race
   * gate how far round the course it was. A burst of collisions in one frame
   * is collapsed by the per-cue cooldown rather than allowed to build a wall of
   * nodes.
   */
  cue(kind: SoundCue, strength = 1, delay = 0): void {
    if (this.destroyed || this.muted) return;
    const scheduled = this.context.currentTime + Math.max(0, delay);
    const now = scheduled;
    const last = this.lastCueAt.get(kind);
    if (last !== undefined && now - last < CUE_COOLDOWN[kind]) return;
    this.lastCueAt.set(kind, now);

    const level = clamp(strength, 0, 1);
    switch (kind) {
      case SOUND_CUE.Collision:
        this.impact(now, 0.34, 190, 70, 0.5 * level + 0.2);
        break;
      case SOUND_CUE.Explosion:
        // The crack of the airframe first, then the charge underneath it:
        // long, low and loud enough that there is no doubt what happened.
        this.impact(now, 0.22, 900, 150, 0.45 * level + 0.3);
        this.impact(now + 0.03, 1.5, 90, 32, 0.6 * level + 0.4);
        break;
      case SOUND_CUE.Crash:
        this.impact(now, 0.85, 120, 44, 0.55 * level + 0.35);
        break;
      case SOUND_CUE.Touchdown:
        // Long, soft and dull: foam scrubbing along the ground, with none of
        // the low thump that makes an impact sound like a break.
        this.impact(now, 1.1, 320, 90, 0.28 * level + 0.12);
        break;
      case SOUND_CUE.TargetDetected:
        this.blip(now, 880, 0.07, 0.14);
        this.blip(now + 0.09, 1320, 0.09, 0.14);
        break;
      case SOUND_CUE.Gate: {
        // The frame going past, and then the gate counted: a swipe of air
        // first, two notes over the top of it, and all of it gone well before
        // the next gate needs looking at. `strength` is how far round the
        // course this gate was, so the chime climbs as the race is flown.
        const chime = gateChime(level);
        this.whoosh(now, 0.16, 900, 3000, chime.swish, 1.1);
        this.blip(now + 0.02, chime.frequency, 0.1, chime.level);
        this.blip(now + 0.1, chime.resolve, 0.16, chime.level * 0.8);
        break;
      }
      case SOUND_CUE.MissionComplete:
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          this.blip(now + i * 0.11, f, 0.16, 0.13);
        });
        break;
      case SOUND_CUE.MissionFailed:
        this.blip(now, 392, 0.22, 0.14);
        this.blip(now + 0.2, 261.63, 0.5, 0.13);
        break;
      case SOUND_CUE.Launch:
        this.whoosh(now, 0.5);
        break;
      case SOUND_CUE.Thunder:
        // A close strike cracks before it rumbles; a distant one is only the
        // rumble, which is what `strength` ends up deciding.
        if (level > 0.55) this.impact(now, 0.3, 2600, 220, 0.35 * level);
        this.impact(now + 0.05, 2.6, 260, 38, 0.55 * level + 0.1);
        this.impact(now + 0.4, 3.4, 140, 26, 0.35 * level + 0.08);
        break;
    }
  }

  /** A filtered noise burst over a low thump: the shape of something hitting. */
  private impact(
    at: number,
    duration: number,
    cutoffStart: number,
    thumpHz: number,
    level: number,
  ): void {
    const context = this.context;

    const burst = context.createBufferSource();
    burst.buffer = this.noiseBuffer;
    burst.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoffStart * 8, at);
    filter.frequency.exponentialRampToValueAtTime(cutoffStart, at + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    burst.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    burst.start(at);
    burst.stop(at + duration + 0.05);
    burst.onended = () => {
      burst.disconnect();
      filter.disconnect();
      gain.disconnect();
    };

    const thump = context.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(thumpHz * 2.2, at);
    thump.frequency.exponentialRampToValueAtTime(thumpHz, at + duration * 0.7);
    const thumpGain = context.createGain();
    thumpGain.gain.setValueAtTime(0.0001, at);
    thumpGain.gain.linearRampToValueAtTime(level * 0.9, at + 0.012);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    thump.connect(thumpGain);
    thumpGain.connect(this.master);
    thump.start(at);
    thump.stop(at + duration + 0.05);
    thump.onended = () => {
      thump.disconnect();
      thumpGain.disconnect();
    };
  }

  /** A short tone, for the instrument-panel cues. */
  private blip(
    at: number,
    frequency: number,
    duration: number,
    level: number,
  ): void {
    const context = this.context;
    const osc = context.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(frequency, at);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  /**
   * Rising band-passed noise: air moving past, over whatever time it takes.
   *
   * Half a second from a low band is an airframe leaving the rail; a sixth of
   * a second from a high one is a gate frame going by.
   */
  private whoosh(
    at: number,
    duration: number,
    from = 240,
    to = 1900,
    level = 0.22,
    q = 1.6,
  ): void {
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, at);
    filter.frequency.exponentialRampToValueAtTime(to, at + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(level, at + duration * 0.45);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(at);
    source.stop(at + duration + 0.05);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      const now = this.context.currentTime;
      this.fundamental.stop(now);
      this.harmonic.stop(now);
      this.engineNoise.stop(now);
      this.windNoise.stop(now);
      this.wobble.stop(now);
    } catch {
      // Already stopped.
    }
    void this.context.close().catch(() => undefined);
  }

  /** Exposed so a collision can be scaled by how hard it actually was. */
  static impactStrength = impactStrength;
}
