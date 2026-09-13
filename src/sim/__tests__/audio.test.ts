import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  PISTON_ENGINE,
  QUAD_ENGINE,
  ROCKET_ENGINE,
  WING_ENGINE,
  engineSound,
  gateChime,
  impactStrength,
  windSound,
} from "../audio/soundModel";
import type { EngineCondition } from "../audio/soundModel";
import {
  IMPACT_SECTOR,
  applyDamage,
  createDamage,
  createImpact,
} from "../flight/damage";
import * as V from "../math/vec3";

export function runAudioTests(): void {
  suite("motor responds to throttle", () => {
    const idle = engineSound(0, 0);
    const half = engineSound(0.5, 0);
    const full = engineSound(1, 0);

    assert(
      idle.frequency < half.frequency && half.frequency < full.frequency,
      "closed, half and full throttle are three different pitches",
    );
    assert(
      idle.gain < half.gain && half.gain < full.gain,
      "and three different volumes",
    );
    assertBetween(
      idle.frequency,
      40,
      120,
      "an idling motor is a low hum a listener can actually hear",
    );
    assertBetween(
      full.frequency,
      300,
      600,
      "and full power is a tone, not a screech beyond the speakers",
    );

    let previous = -1;
    let monotonic = true;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const f = engineSound(t, 0).frequency;
      if (f <= previous) monotonic = false;
      previous = f;
    }
    assert(monotonic, "opening the throttle always raises the pitch");
  });

  suite("the propeller is driven by the air too", () => {
    const idleStill = engineSound(0, 0);
    const idleDiving = engineSound(0, 55);
    assert(
      idleDiving.frequency > idleStill.frequency,
      "a closed throttle in a dive still turns the propeller",
    );
    assert(
      idleDiving.gain > idleStill.gain,
      "so the aircraft does not fall silent exactly when it is fastest",
    );
    assert(
      idleDiving.gain < engineSound(1, 55).gain,
      "but windmilling never sounds like power",
    );
  });

  suite("motor output stays inside the mixer", () => {
    for (const throttle of [0, 0.25, 0.5, 0.75, 1]) {
      for (const speed of [0, 20, 40, 90]) {
        const sound = engineSound(throttle, speed);
        assertBetween(
          sound.gain,
          0,
          1,
          `gain is normalised at throttle ${throttle}, ${speed} m/s`,
        );
        assertBetween(
          sound.noise,
          0,
          1,
          `blade wash is normalised at throttle ${throttle}, ${speed} m/s`,
        );
        assert(
          Number.isFinite(sound.frequency) && sound.frequency > 0,
          `frequency is usable at throttle ${throttle}, ${speed} m/s`,
        );
      }
    }
    assertClose(
      engineSound(2, 0).frequency,
      engineSound(1, 0).frequency,
      1e-9,
      "throttle beyond full is clamped rather than extrapolated",
    );
  });

  suite("airframe rush follows airspeed", () => {
    const parked = windSound(0);
    const cruise = windSound(28);
    const dive = windSound(60);
    assertClose(parked.gain, 0, 1e-9, "a stationary aircraft makes no rush");
    assert(
      cruise.gain > parked.gain && dive.gain > cruise.gain,
      "and it builds with speed",
    );
    assert(
      dive.gain - cruise.gain > cruise.gain - parked.gain,
      "faster than linearly, the way aerodynamic noise actually does",
    );
    assert(dive.cutoff > cruise.cutoff, "and brightens as well as gets louder");
    for (const speed of [0, 10, 30, 80, 200]) {
      const sound = windSound(speed);
      assertBetween(sound.gain, 0, 1, `rush is normalised at ${speed} m/s`);
      assertBetween(sound.cutoff, 20, 20000, `and audible at ${speed} m/s`);
    }
  });

  suite("impacts are scaled by how hard they were", () => {
    assert(
      impactStrength(90) > impactStrength(20),
      "a fast collision sounds heavier than a slow one",
    );
    assertBetween(impactStrength(0), 0, 1, "a graze still makes a sound");
    assertClose(
      impactStrength(400),
      1,
      1e-9,
      "and an impossible closing speed does not exceed full scale",
    );
    assertClose(
      impactStrength(-60),
      impactStrength(60),
      1e-9,
      "closing and opening are the same collision",
    );
  });

  suite("a gate crossing is heard over the aeroplane", () => {
    const start = gateChime(0);
    const last = gateChime(1);

    assert(
      last.frequency > start.frequency,
      "the course climbs a scale, so a late gate rings higher than an early one",
    );
    assert(
      last.level > start.level,
      "and rings harder, so the run builds as it is flown",
    );
    assertClose(
      last.frequency,
      start.frequency * 2,
      1e-6,
      "and lands an octave up on the last gate before the finish",
    );

    const motor = engineSound(1, 30);
    assert(
      start.frequency > motor.frequency * 2,
      "the quietest gate still sits clear of a motor at racing throttle",
    );
    assertBetween(
      start.frequency,
      1000,
      4000,
      "and in the band the ear is sharpest in, where the rush cannot bury it",
    );
    assertBetween(
      last.resolve,
      1000,
      5000,
      "which the top of the scale never rings out of",
    );

    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const chime = gateChime(t);
      assert(
        chime.frequency >= previous,
        `gate at ${t.toFixed(2)} of the course never rings lower than the one before`,
      );
      previous = chime.frequency;
      assert(
        chime.resolve > chime.frequency,
        `the second note is above the first at ${t.toFixed(2)}`,
      );
      assertBetween(
        chime.level,
        0,
        0.5,
        `the chime is mixed sanely at ${t.toFixed(2)}`,
      );
      assertBetween(
        chime.swish,
        0,
        0.5,
        `and so is the air at ${t.toFixed(2)}`,
      );
      assertBetween(
        chime.resolve,
        20,
        20000,
        `both notes are audible at ${t.toFixed(2)}`,
      );
    }

    assertClose(
      gateChime(-4).frequency,
      start.frequency,
      1e-9,
      "a gate before the start line is the start line",
    );
    assertClose(
      gateChime(9).frequency,
      last.frequency,
      1e-9,
      "and nothing rings past the top of the scale",
    );
  });

  suite("a machine that has been hit is heard to have been", () => {
    const clean = engineSound(0.7, 30);
    const knocked = engineSound(0.7, 30, WING_ENGINE, {
      integrity: 0.8,
      thrustFactor: 1,
    });
    const wrecked = engineSound(0.7, 30, WING_ENGINE, {
      integrity: 0.35,
      thrustFactor: 0.4,
    });

    assertClose(
      clean.roughness,
      0,
      1e-9,
      "an airframe nothing has happened to runs smooth",
    );
    assert(
      knocked.roughness > clean.roughness &&
        wrecked.roughness > knocked.roughness,
      "and every contact after that beats harder than the one before",
    );
    assert(
      knocked.noise > clean.noise && wrecked.noise > knocked.noise,
      "the blade wash builds with the damage as well",
    );
    assert(
      wrecked.frequency < clean.frequency,
      "a motor that has lost its drive no longer sings at the same pitch",
    );
    assert(wrecked.gain < clean.gain, "or as loudly, at the same throttle");
    assertClose(
      knocked.frequency,
      clean.frequency,
      1e-9,
      "but a wing strike that left the motor alone does not change its revs",
    );

    let previous = -1;
    let rising = true;
    for (let integrity = 1; integrity >= 0; integrity -= 0.05) {
      const hurt = engineSound(0.7, 30, WING_ENGINE, {
        integrity,
        thrustFactor: 1,
      });
      if (hurt.roughness < previous) rising = false;
      previous = hurt.roughness;
      assertBetween(
        hurt.roughness,
        0,
        1,
        `the beat is normalised at ${integrity.toFixed(2)} integrity`,
      );
      assertBetween(
        hurt.noise,
        0,
        1,
        `and so is the wash at ${integrity.toFixed(2)} integrity`,
      );
    }
    assert(rising, "losing more of the airframe never sounds better");

    const gone = engineSound(1, 0, WING_ENGINE, {
      integrity: 0,
      thrustFactor: 0,
    });
    assertBetween(
      gone.roughness,
      0.99,
      1,
      "and a write-off is as rough as the tone goes, never past it",
    );
    assert(
      gone.frequency > 0,
      "with something still turning: a broken motor is not a stopped one",
    );
  });

  suite("the damaged motor beats once per turn of the shaft", () => {
    const hurt: EngineCondition = { integrity: 0.5, thrustFactor: 0.6 };
    for (const profile of [
      WING_ENGINE,
      QUAD_ENGINE,
      ROCKET_ENGINE,
      PISTON_ENGINE,
    ]) {
      const idle = engineSound(0, 0, profile, hurt);
      const full = engineSound(1, 0, profile, hurt);
      assert(
        full.wobble >= idle.wobble,
        "opening the throttle never slows the beat down",
      );
      for (const sound of [idle, full]) {
        assertBetween(
          sound.wobble,
          4,
          190,
          "and it stays somewhere the ear reads as unevenness",
        );
        assert(
          sound.wobble <= sound.frequency,
          "a shaft never turns faster than its own blades pass",
        );
      }
      assertClose(
        idle.wobble,
        Math.min(idle.frequency / profile.blades, 190),
        1e-9,
        "which is the blade-passing rate shared over the blades",
      );
    }
  });

  suite("contacts add up in the motor's voice", () => {
    // The damage the flight model itself keeps, fed straight to the sound: a
    // wing that clips another aircraft three times sounds worse each time.
    const damage = createDamage();
    const impact = createImpact();
    impact.sector = IMPACT_SECTOR.Wing;
    V.set(impact.contact, 0, 1, 0);

    let previous = engineSound(0.7, 28, WING_ENGINE, damage).roughness;
    assertClose(previous, 0, 1e-9, "the aircraft takes off sounding right");

    for (let hit = 1; hit <= 3; hit += 1) {
      applyDamage(damage, impact, 0.15);
      const sound = engineSound(0.7, 28, WING_ENGINE, damage);
      assert(
        sound.roughness > previous,
        `contact ${hit} is heard on top of the ones before it`,
      );
      previous = sound.roughness;
    }

    // And the hit that takes the motor itself is the loudest change of all.
    const tail = createImpact();
    tail.sector = IMPACT_SECTOR.Tail;
    V.set(tail.contact, -1, 0, 0);
    const before = engineSound(0.7, 28, WING_ENGINE, damage);
    applyDamage(damage, tail, 0.2);
    const after = engineSound(0.7, 28, WING_ENGINE, damage);
    assert(
      after.frequency < before.frequency && after.gain < before.gain,
      "losing the propeller takes the revs and the tone with it",
    );
  });

  suite("the engine profile is the aircraft's", () => {
    const custom = { ...WING_ENGINE, blades: 3 };
    assert(
      engineSound(1, 0, custom).frequency > engineSound(1, 0).frequency,
      "a three-bladed propeller sounds higher at the same revs",
    );
  });
}
