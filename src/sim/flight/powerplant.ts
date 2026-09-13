/**
 * The power system: motor, ESC, propeller and battery — or engine and tank.
 *
 * An electric wing carries exactly as much flight as its pack holds, and what
 * it does with that pack is decided by the combination bolted to the back of
 * it. That is the whole of this file: a catalogue of the motor/ESC/prop combos
 * and the LiPo packs real airframes of this class are actually flown on, the
 * propeller model that turns one of those combos into thrust, and the battery
 * that empties while it does.
 *
 * Three real effects fall out of it, and all three are things a pilot flies
 * around rather than reads about:
 *
 *   - **the pack runs down.** Current is worked out from the thrust actually
 *     being made, so a full-throttle chase costs minutes and a lazy cruise
 *     costs seconds. When it is gone the motor stops and the wing is a glider,
 *     which is exactly what happens on the field.
 *   - **voltage sags, and a tired pack is a slower aircraft.** Motor rpm
 *     follows the voltage at the terminals, thrust follows the square of rpm,
 *     so a fresh pack pulls harder than the same pack twenty minutes later.
 *     The sag deepens as the pack empties, because a nearly flat cell has far
 *     more resistance in it than a half-full one: past about a third the
 *     aircraft is noticeably softer under the same stick, it stops climbing,
 *     and only then does the ESC cut.
 *   - **the pack is part of the airframe.** A 16 Ah pack is two kilos of
 *     aircraft. Fitting one buys endurance and costs wing loading, and both
 *     show up in the flight model rather than in a menu.
 *
 * Thrust comes from the propeller formula model aircraft are actually sized
 * with (Staples): thrust falls linearly from its static value to zero at the
 * propeller's geometric pitch speed. That is precisely the shape the flight
 * model already uses — `maxThrust` and `propPitchSpeed` in `AircraftConfig` —
 * so a combo does not need a special case in the physics: it produces those
 * two numbers, and the airframe flies on them.
 *
 * Electrical power comes from momentum theory: the propeller has to shift air
 * to make thrust, and shifting it costs induced power, which is where the
 * current goes. Neither model is exact — a real prop has profile losses and a
 * real motor has a heat curve — so both carry one efficiency each, chosen so
 * the catalogue reproduces the endurance the manufacturers quote.
 *
 * Not every aircraft here is electric. A `combustion` block on a combo says the
 * thing on the front is a petrol engine rather than a motor, and a `fuel` block
 * on a pack says what it drinks is in a tank rather than in cells. The two
 * travel together and they change three things and nothing else: an engine's
 * rpm is its own rather than a voltage's, it never stops turning while there is
 * fuel in it, and what runs down is litres rather than milliamp-hours. The
 * propeller, the mass, the endurance and the aircraft they are bolted to are
 * the same code either way.
 *
 * Framework-agnostic and free of I/O: the flight model steps it, the HUD reads
 * it and the hangar builds it.
 */

import { clamp } from "../math/scalar";
import type { AircraftConfig } from "./config";

// --- Hardware ---------------------------------------------------------------

/**
 * One motor, ESC and propeller, as they are sold and flown together.
 *
 * A combo rather than three independent choices: nobody picks a propeller
 * without a motor to turn it, and the interesting decision — punch against top
 * speed against how long the pack lasts — is made by the combination.
 */
export interface MotorSpec {
  /** Stable key. Settings are stored against it, so it must not change. */
  readonly id: string;
  /** The motor as it is written on the can. */
  readonly motor: string;
  /** Unloaded rpm per volt. */
  readonly kv: number;
  /** Continuous rating of the speed controller, amps. */
  readonly escAmps: number;
  /** Propeller diameter, inches. */
  readonly propDiameter: number;
  /** Propeller pitch, inches. */
  readonly propPitch: number;
  /** Cell counts the combo is rated for; anything else is a different setup. */
  readonly cells: { readonly min: number; readonly max: number };
  /** One motor, its share of the ESC, and its propeller, kilograms. */
  readonly massKg: number;
  /**
   * How many of it the airframe carries. Left out, one.
   *
   * A wing has a motor and a quadcopter has four of the same motor, and that
   * is the whole of the difference as far as this file is concerned: the
   * thrust, the disc the air is thrown through and the weight all multiply,
   * and the propeller's pitch speed — a property of one blade — does not.
   */
  readonly count?: number;
  /**
   * Present only on petrol engines, and what makes one.
   *
   * The same idea as a `rotor` block on an airframe: a combo carrying one is a
   * different kind of thing, and every consumer that has to tell the two apart
   * tests this one field. What it replaces is small — an engine's rpm is its
   * own rather than `kv` times a voltage, and it drinks fuel rather than
   * current — so `kv`, `escAmps` and `cells` are all zero on one, which is the
   * literal truth: there is no winding, no controller and no pack.
   */
  readonly combustion?: CombustionSpec;
  /** One line for the hangar list. */
  readonly summary: string;
}

/**
 * What makes a power system an engine rather than a motor.
 *
 * A petrol engine is not a motor with different numbers. It has one speed range
 * and it is not set by anything electrical: open the throttle and it goes from
 * its idle to its peaking rpm, and *that* is what the propeller is turned at.
 * So `idleRpm` and `maxRpm` between them replace `kv` and the pack voltage, and
 * the propeller model downstream is unchanged — the same Staples formula turns
 * an rpm and a blade into thrust whatever is spinning it.
 *
 * The consequence a pilot actually meets is the idle. An electric motor with
 * the stick shut is stopped; an engine with the stick shut is still running,
 * still turning the propeller, and still pushing the aircraft along the ground.
 * Which is why an aeroplane with one of these on the front can be started
 * standing on a runway and flown off it rather than thrown, and why the only
 * thing holding it there beforehand is that its wheels cost a little more to
 * roll than the idle is worth. `idleRpm` is the whole of that, and `idleThrust`
 * on the airframe is what it is worth.
 */
export interface CombustionSpec {
  /** Displacement, cc. What an engine of this kind is sold by. */
  readonly displacementCc: number;
  /** Crankshaft speed at full throttle with its propeller on, rev/min. */
  readonly maxRpm: number;
  /**
   * Where it settles with the throttle closed, rev/min.
   *
   * About a quarter of the peaking rpm on a carburetted two-stroke — and, since
   * thrust goes with the square of it, a sixteenth of its thrust: enough to
   * taxi the aeroplane and nowhere near enough to fly it.
   */
  readonly idleRpm: number;
  /**
   * Petrol burned per kilowatt-hour of shaft work, litres.
   *
   * Brake specific fuel consumption, in the units a tank is measured in. Model
   * two-strokes are thirsty and small ones are worse: around 1.5 L/kWh for a
   * carburetted engine of this class and half again that for a 20 cc, against
   * about 1.1 for the injected engines at the top of the range. It is the whole
   * reason the biggest airframe here stays up longest on the same tank.
   */
  readonly litresPerKwh: number;
  /**
   * Fuel burned per hour with the throttle shut, litres.
   *
   * Not a rounding error over a long flight: an engine idling on the ground
   * waiting for a clearance is drinking the same tank it is going to fly on,
   * and this is what a descent costs as well.
   */
  readonly idleLitresPerHour: number;
}

/** One LiPo pack, or one tank of petrol. */
export interface BatterySpec {
  /** Stable key. Settings are stored against it, so it must not change. */
  readonly id: string;
  /** Cells in series. Nominal pack voltage is 3.7 V a cell. */
  readonly cells: number;
  /** Nameplate capacity, milliamp-hours. */
  readonly capacityMah: number;
  /** Continuous discharge rating. */
  readonly cRating: number;
  /** Mass of the pack, kilograms. */
  readonly massKg: number;
  /**
   * What the cells are, for the label and for how hard the pack can be pushed.
   *
   * Lithium-ion carries two or three times the energy of a LiPo of the same
   * weight and will not give it up in a hurry: cells with several times the
   * internal resistance, so the pack sags under a load a LiPo would not
   * notice. That is the whole trade a long-range pack is, and it is flown
   * rather than quoted.
   */
  readonly chemistry?: "lipo" | "liion";
  /**
   * Present only on fuel tanks, and what makes one.
   *
   * A tank is a pack in every way the rest of this file cares about: it is what
   * the aircraft carries its flight in, it is part of what the aircraft weighs,
   * and it runs out. So it travels in the same list and is chosen in the same
   * place, and this block is what says the contents are litres rather than
   * cells. `cells`, `capacityMah` and `cRating` are zero on one, because a tank
   * has none of them.
   */
  readonly fuel?: FuelSpec;
}

/** What makes a pack a tank. */
export interface FuelSpec {
  /** Capacity, litres. */
  readonly litres: number;
}

/**
 * The battery setting that switches the pack simulation off.
 *
 * A string rather than a null so "no limit" is one value the settings, the
 * hangar and the session can all carry, the same way `VTX_UNLIMITED` is a
 * power level rather than an absent one. The airframe still weighs what it
 * weighs: an unlimited flight is flown at the delivered pack's all-up mass, so
 * switching the limit off changes how long the flight is and nothing else.
 */
export const BATTERY_UNLIMITED = "unlimited";

// --- Constants --------------------------------------------------------------

/** Nominal cell voltage, volts. What a pack is named on. */
export const CELL_NOMINAL_VOLTS = 3.7;
/** A cell straight off the charger. */
export const CELL_FULL_VOLTS = 4.2;
/** Loaded cell voltage at which an ESC cuts the motor to save the pack. */
export const CELL_CUTOFF_VOLTS = 3.2;
/** Resting cell voltage at which a cut motor is allowed back. */
const CELL_RECOVER_VOLTS = 3.5;

/**
 * Rpm actually reached under a matched propeller, as a fraction of `kv * V`.
 *
 * A loaded motor never turns its unloaded rpm; a propeller sized for the motor
 * costs roughly a sixth of it.
 */
const PROP_LOAD_FACTOR = 0.85;
/**
 * Static thrust constant of the propeller model, N per rpm per inch-unit.
 *
 * The empirical constant model props are sized with, unchanged.
 */
const STAPLES_THRUST_K = 4.392399e-8;
/** Geometric pitch speed per rpm per inch of pitch, m/s. */
const PITCH_SPEED_K = 4.23333e-4;

/**
 * Propulsive efficiency of the propeller.
 *
 * Momentum theory gives the induced power a propeller cannot avoid; a real
 * blade also has to drag itself through the air, and this is the whole of that
 * loss. Chosen so the catalogue reproduces the endurance the airframes are
 * sold on.
 */
const PROP_EFFICIENCY = 0.62;
/** Motor and ESC together, shaft watts out per electrical watt in. */
const DRIVE_EFFICIENCY = 0.85;
/** The whole chain: watts of useful propulsion per watt out of the pack. */
export const POWERTRAIN_EFFICIENCY = PROP_EFFICIENCY * DRIVE_EFFICIENCY;
/**
 * What the rest of the aircraft draws, amps.
 *
 * Flight controller, servos, camera and video transmitter. It is small beside
 * the motor and it never stops, which is why a wing left sitting with the
 * motor off still comes home with a flatter pack than it left with.
 */
export const AVIONICS_AMPS = 1.1;

/** Internal resistance of one LiPo cell at the reference capacity, ohms. */
const CELL_RESISTANCE_OHM = 0.0045;
/**
 * Charge below which a pack starts to fight back, 0..1.
 *
 * A cell's internal resistance is not a constant: it sits still over the whole
 * plateau and then climbs steeply once the pack is nearly empty. The last third
 * is where a pilot meets it, and it is the difference between an aircraft that
 * is merely lower on volts and one that visibly has nothing left — the same
 * stick sags the pack further, so it makes less thrust, so the aircraft stops
 * climbing well before the ESC ever cuts the motor.
 */
export const SAG_KNEE_CHARGE = 0.35;
/** How many times its plateau resistance a pack has left at the very bottom. */
const SAG_AT_EMPTY = 2.6;
/**
 * The same for a lithium-ion cell.
 *
 * Several times a LiPo's, which is the reason a long-range pack is flown
 * gently: hold full throttle on one and the terminal voltage falls far enough
 * that the controller cuts the motor to save it.
 */
const LIION_CELL_RESISTANCE_OHM = 0.016;
/** Capacity that resistance is quoted at, mAh. Bigger packs sag less. */
const RESISTANCE_REFERENCE_MAH = 5000;

/** Seconds the endurance estimate averages current over. */
const ENDURANCE_SMOOTHING = 6;

/** Air density the catalogue's quoted figures are worked out at, kg/m^3. */
const REFERENCE_DENSITY = 1.225;

/**
 * Mass of a litre of petrol, kilograms.
 *
 * A full 28 litre tank is twenty kilos of aeroplane, which is a quarter of what
 * the airframe carrying it weighs — so a tank costs wing loading exactly the
 * way a pack does, and is fitted the same way.
 */
export const FUEL_DENSITY_KG_PER_LITRE = 0.74;

/** Litres left in a tank below which the engine will not keep running. */
const FUEL_DRY_LITRES = 1e-4;

/**
 * The LiPo discharge curve, as (state of charge, volts per cell) pairs.
 *
 * The shape is what makes a pack readable: it falls off the charge voltage
 * quickly, sits on a long flat plateau where the voltmeter tells you almost
 * nothing, then drops off a cliff at the end. Interpolated linearly between
 * the points, which is as much resolution as an OSD can show.
 */
const DISCHARGE_CURVE: readonly (readonly [number, number])[] = [
  [0.0, 3.2],
  [0.05, 3.45],
  [0.1, 3.57],
  [0.2, 3.66],
  [0.4, 3.75],
  [0.6, 3.83],
  [0.8, 3.95],
  [0.9, 4.05],
  [1.0, CELL_FULL_VOLTS],
];

// --- Propeller and pack arithmetic ------------------------------------------

/** True for a petrol engine rather than an electric motor. */
export function isCombustion(motor: MotorSpec): boolean {
  return motor.combustion !== undefined;
}

/** True for a tank of petrol rather than a pack of cells. */
export function isFuelTank(battery: BatterySpec): boolean {
  return battery.fuel !== undefined;
}

/** Nominal voltage of a pack, volts. The number it is sold under. */
export function nominalVoltage(battery: BatterySpec): number {
  return battery.cells * CELL_NOMINAL_VOLTS;
}

/**
 * Rpm the combo turns on a given terminal voltage.
 *
 * An engine ignores the voltage, because there is nothing electrical deciding
 * how fast it goes: it turns its own peaking rpm at full throttle and its own
 * idle with the stick shut, and the caller has already said which of those it
 * is asking about by handing over a `throttle`.
 */
export function propellerRpm(
  motor: MotorSpec,
  volts: number,
  throttle = 1,
): number {
  const engine = motor.combustion;
  if (engine) {
    const power = clamp(throttle, 0, 1);
    return engine.idleRpm + (engine.maxRpm - engine.idleRpm) * power;
  }
  return Math.max(volts, 0) * motor.kv * PROP_LOAD_FACTOR;
}

/**
 * Airspeed at which the propeller stops producing thrust, m/s.
 *
 * The speed the propeller would screw itself forward at if the air were solid:
 * arrive that fast and the blade has no angle of attack left to work with.
 * This is what bounds level-flight top speed.
 */
export function pitchSpeed(motor: MotorSpec, volts: number): number {
  return PITCH_SPEED_K * propellerRpm(motor, volts) * motor.propPitch;
}

/** Propellers the combination turns. One, unless it says otherwise. */
export function propellerCount(motor: MotorSpec): number {
  return Math.max(1, Math.round(motor.count ?? 1));
}

/** Static thrust at full throttle, newtons, from every propeller together. */
export function staticThrust(motor: MotorSpec, volts: number): number {
  const rpm = propellerRpm(motor, volts);
  const geometry =
    Math.pow(motor.propDiameter, 3.5) / Math.sqrt(motor.propPitch);
  return (
    STAPLES_THRUST_K *
    rpm *
    geometry *
    pitchSpeed(motor, volts) *
    propellerCount(motor)
  );
}

/** Swept area of the propeller discs together, m^2. */
export function discArea(motor: MotorSpec): number {
  const radius = (motor.propDiameter * 0.0254) / 2;
  return Math.PI * radius * radius * propellerCount(motor);
}

/**
 * Electrical power drawn to hold a thrust at an airspeed, watts.
 *
 * Momentum theory: thrust is air thrown backwards, and throwing it costs
 * `T * (V + vi)` where `vi` is how much faster the propeller has to move the
 * air than it is already arriving. Solved from `T = 2 rho A vi (V + vi)`,
 * which is what makes a hovering propeller expensive and a cruising one cheap.
 */
export function electricalPower(
  motor: MotorSpec,
  thrust: number,
  airspeed: number,
  density = REFERENCE_DENSITY,
): number {
  if (!(thrust > 0)) return 0;
  const v = Math.max(airspeed, 0);
  const area = discArea(motor);
  const induced =
    0.5 * (-v + Math.sqrt(v * v + (2 * thrust) / (density * area)));
  return (thrust * (v + induced)) / POWERTRAIN_EFFICIENCY;
}

/**
 * Shaft power the engine has to make to hold a thrust at an airspeed, watts.
 *
 * The same momentum theory `electricalPower` is built on, stopped one stage
 * earlier: a propeller costs what it costs whatever is turning it, and what
 * differs is only how much has to be burned or drawn to get there. An engine
 * has no controller and no windings to heat, so the propeller's own efficiency
 * is the whole of the loss between the crankshaft and the air.
 */
export function shaftPower(
  motor: MotorSpec,
  thrust: number,
  airspeed: number,
  density = REFERENCE_DENSITY,
): number {
  if (!(thrust > 0)) return 0;
  const v = Math.max(airspeed, 0);
  const area = discArea(motor);
  const induced =
    0.5 * (-v + Math.sqrt(v * v + (2 * thrust) / (density * area)));
  return (thrust * (v + induced)) / PROP_EFFICIENCY;
}

/**
 * Petrol burned to hold a thrust at an airspeed, litres per hour.
 *
 * Brake specific fuel consumption against the shaft work being asked for, and
 * never below the idle burn: an engine coasting down from height with the stick
 * shut is still running, and a tank does not care that the pilot has stopped
 * asking for anything.
 */
export function fuelBurn(
  motor: MotorSpec,
  thrust: number,
  airspeed: number,
  density = REFERENCE_DENSITY,
): number {
  const engine = motor.combustion;
  if (!engine) return 0;
  const kilowatts = shaftPower(motor, thrust, airspeed, density) / 1000;
  return Math.max(
    kilowatts * engine.litresPerKwh,
    engine.idleLitresPerHour,
  );
}

/** Resting voltage of one cell at a state of charge, volts. */
export function cellVoltage(charge: number): number {
  const soc = clamp(charge, 0, 1);
  for (let i = 1; i < DISCHARGE_CURVE.length; i += 1) {
    const [lowSoc, lowVolts] = DISCHARGE_CURVE[i - 1] as [number, number];
    const [highSoc, highVolts] = DISCHARGE_CURVE[i] as [number, number];
    if (soc <= highSoc) {
      const span = highSoc - lowSoc;
      const t = span > 0 ? (soc - lowSoc) / span : 0;
      return lowVolts + (highVolts - lowVolts) * t;
    }
  }
  return CELL_FULL_VOLTS;
}

/**
 * How much harder than its plateau a pack is to pull from at a state of charge.
 *
 * One above the knee, and rising to `SAG_AT_EMPTY` as the pack empties. The
 * curve is squared rather than straight because that is the shape the cells
 * have: nothing for most of the flight, then all of it at once in the last
 * third, which is why the aircraft goes off in the final minute rather than
 * fading evenly from the first.
 */
export function sagFactor(charge: number): number {
  const soc = clamp(charge, 0, 1);
  if (soc >= SAG_KNEE_CHARGE) return 1;
  const spent = 1 - soc / SAG_KNEE_CHARGE;
  return 1 + (SAG_AT_EMPTY - 1) * spent * spent;
}

/**
 * Internal resistance of a pack, ohms.
 *
 * Cells in series add their resistance; a bigger cell has less of it, which is
 * why a 16 Ah pack barely moves under a load that pulls a 3 Ah pack down by
 * half a volt a cell. A tired pack has more of it than a fresh one — see
 * `sagFactor` — so the same aircraft on the same stick is weaker at the end of
 * the flight than it was in the middle of it.
 */
export function packResistance(battery: BatterySpec, charge = 1): number {
  const scale = RESISTANCE_REFERENCE_MAH / Math.max(battery.capacityMah, 1);
  const perCell =
    battery.chemistry === "liion" ? LIION_CELL_RESISTANCE_OHM : CELL_RESISTANCE_OHM;
  return battery.cells * perCell * Math.min(scale, 3) * sagFactor(charge);
}

/**
 * True while a pack can be fitted to a combo.
 *
 * Two tests, and the first one is not a subtlety: an engine will not run on a
 * battery and a motor will not run on petrol, so the two catalogues never mix
 * however well the numbers line up. What is left is the cell count, which is
 * the whole of the compatibility question inside either kind.
 */
export function fitsMotor(motor: MotorSpec, battery: BatterySpec): boolean {
  if (isCombustion(motor) !== isFuelTank(battery)) return false;
  return battery.cells >= motor.cells.min && battery.cells <= motor.cells.max;
}

// --- Runtime ----------------------------------------------------------------

/**
 * The live power system of one aircraft.
 *
 * Mutated in place by `stepPowerplant`, which runs inside the physics step and
 * must not allocate. Everything on it is a reading a pilot would actually have
 * on the OSD.
 */
export interface Powerplant {
  readonly motor: MotorSpec;
  readonly battery: BatterySpec;
  /** Charge remaining, 1 full to 0 flat. */
  charge: number;
  /** Drawn out of the pack so far, mAh. Zero on an engine. */
  consumedMah: number;
  /**
   * Petrol left in the tank, litres. Zero on an electric aircraft.
   *
   * The gauge a pilot of one of these actually flies on. `charge` is the same
   * number as a fraction, so everything that already reads a state of charge —
   * the OSD arc, the low warning, the endurance estimate — reads a tank without
   * knowing there is one.
   */
  fuelLitres: number;
  /** What the engine is drinking right now, litres per hour. */
  fuelBurnLitresPerHour: number;
  /** Pack voltage with no load on it, volts. */
  restingVoltage: number;
  /** Pack voltage at the terminals right now, volts. */
  voltage: number;
  /** What the aircraft is drawing, amps. */
  current: number;
  /** Current averaged over the last few seconds, for the endurance estimate. */
  averageCurrent: number;
  /**
   * Seconds the average has been running for.
   *
   * The averaging window grows to `ENDURANCE_SMOOTHING` rather than starting
   * there, so the estimate is honest from the first step instead of spending
   * its first few seconds climbing out of whatever it was seeded with.
   */
  averagedSeconds: number;
  /** Flight left at the present draw, seconds. */
  enduranceSeconds: number;
  /**
   * Thrust available as a fraction of the airframe's rated thrust.
   *
   * Rpm follows the voltage at the terminals and thrust follows the square of
   * rpm, so this is the square of the voltage ratio: above one on a pack
   * straight off the charger, below it on a tired one, and zero once the ESC
   * has cut the motor.
   */
  thrustFactor: number;
  /** True once low voltage has stopped the motor. */
  cut: boolean;
}

export function createPowerplant(
  motor: MotorSpec,
  battery: BatterySpec,
): Powerplant {
  const plant: Powerplant = {
    motor,
    battery,
    charge: 1,
    consumedMah: 0,
    fuelLitres: 0,
    fuelBurnLitresPerHour: 0,
    restingVoltage: 0,
    voltage: 0,
    current: 0,
    averageCurrent: AVIONICS_AMPS,
    averagedSeconds: 0,
    enduranceSeconds: 0,
    thrustFactor: 1,
    cut: false,
  };
  resetPowerplant(plant);
  return plant;
}

/** Puts a full pack — or a full tank — on the aircraft. */
function resetPowerplant(plant: Powerplant): void {
  plant.charge = 1;
  plant.consumedMah = 0;
  plant.averagedSeconds = 0;
  plant.cut = false;

  const fuel = plant.battery.fuel;
  if (fuel) {
    // Nothing electrical to report: an engine has no pack behind it, and a
    // gauge reading nought volts is the honest answer rather than a fault.
    plant.restingVoltage = 0;
    plant.voltage = 0;
    plant.fuelLitres = fuel.litres;
    plant.fuelBurnLitresPerHour = plant.motor.combustion
      ? plant.motor.combustion.idleLitresPerHour
      : 0;
    plant.current = 0;
    // Seeded at the idle burn rather than at nothing, for the same reason the
    // electric side is seeded at the avionics draw: an endurance estimate that
    // starts from zero spends its first few seconds claiming for ever.
    plant.averageCurrent = plant.fuelBurnLitresPerHour;
    // A petrol engine makes the thrust it makes: there is no pack behind it to
    // sag, so it pulls exactly as hard on the last litre as on the first.
    plant.thrustFactor = 1;
    plant.enduranceSeconds = fuelEnduranceAt(
      plant,
      plant.fuelBurnLitresPerHour,
    );
    return;
  }

  plant.restingVoltage = plant.battery.cells * CELL_FULL_VOLTS;
  plant.voltage = plant.restingVoltage;
  plant.fuelLitres = 0;
  plant.fuelBurnLitresPerHour = 0;
  plant.current = AVIONICS_AMPS;
  plant.averageCurrent = AVIONICS_AMPS;
  plant.thrustFactor = voltageThrustFactor(plant, plant.voltage);
  plant.enduranceSeconds = enduranceAt(plant, plant.averageCurrent);
}

/** Thrust multiplier a terminal voltage is worth, against the pack's nominal. */
function voltageThrustFactor(plant: Powerplant, volts: number): number {
  const ratio = volts / nominalVoltage(plant.battery);
  return clamp(ratio * ratio, 0, 2);
}

/** Flight remaining at a burn, seconds. */
function fuelEnduranceAt(plant: Powerplant, litresPerHour: number): number {
  if (litresPerHour <= 1e-6) return Number.POSITIVE_INFINITY;
  return (Math.max(plant.fuelLitres, 0) / litresPerHour) * 3600;
}

/** Flight remaining at a draw, seconds. */
function enduranceAt(plant: Powerplant, amps: number): number {
  const remainingMah = Math.max(
    plant.battery.capacityMah - plant.consumedMah,
    0,
  );
  if (amps <= 1e-3) return Number.POSITIVE_INFINITY;
  return (remainingMah / (amps * 1000)) * 3600;
}

/**
 * Advances the pack by one physics step.
 *
 * `thrust` is what the propeller actually made this step and `inflow` the air
 * arriving down its axis, because that — not the throttle stick — is what the
 * pack is paying for: the same stick position costs half as much in a dive as
 * it does hanging off the propeller at walking pace.
 *
 * The voltage the next step's thrust is scaled by is the one measured under
 * this step's load. At 240 Hz that lag is worth microvolts, and it is what
 * keeps the whole thing a straight line instead of an equation solved every
 * frame.
 */
export function stepPowerplant(
  plant: Powerplant,
  thrust: number,
  inflow: number,
  density: number,
  dt: number,
): void {
  if (plant.battery.fuel) {
    stepFuelSystem(plant, thrust, inflow, density, dt);
    return;
  }

  const motorAmps = plant.cut
    ? 0
    : Math.min(
        electricalPower(plant.motor, thrust, inflow, density) /
          Math.max(plant.voltage, 1),
        plant.motor.escAmps,
      );
  const amps = motorAmps + AVIONICS_AMPS;

  plant.consumedMah += (amps * 1000 * dt) / 3600;
  plant.charge = clamp(
    1 - plant.consumedMah / Math.max(plant.battery.capacityMah, 1),
    0,
    1,
  );

  plant.restingVoltage = plant.battery.cells * cellVoltage(plant.charge);
  plant.voltage = Math.max(
    plant.restingVoltage - amps * packResistance(plant.battery, plant.charge),
    0,
  );
  plant.current = amps;

  // The ESC watches the loaded voltage and stops the motor before the pack is
  // damaged; with the motor off the pack recovers a little, and it is allowed
  // back only once it has recovered properly. That is why a flat wing gives
  // the pilot one more short burst and then nothing.
  const loadedCell = plant.voltage / plant.battery.cells;
  const restingCell = plant.restingVoltage / plant.battery.cells;
  if (!plant.cut) {
    if (plant.charge <= 0 || loadedCell < CELL_CUTOFF_VOLTS) plant.cut = true;
  } else if (plant.charge > 0 && restingCell > CELL_RECOVER_VOLTS) {
    plant.cut = false;
  }

  plant.thrustFactor = plant.cut ? 0 : voltageThrustFactor(plant, plant.voltage);

  plant.averagedSeconds += dt;
  const window = Math.min(plant.averagedSeconds, ENDURANCE_SMOOTHING);
  const blend = window > dt ? 1 - Math.exp(-dt / window) : 1;
  plant.averageCurrent += (amps - plant.averageCurrent) * blend;
  plant.enduranceSeconds = enduranceAt(plant, plant.averageCurrent);
}

/**
 * The same step for an aircraft running on petrol.
 *
 * Simpler than a pack in every way that matters, and different in the one way a
 * pilot notices. There is no sag: an engine pulls as hard on the last litre as
 * on the first, so the aircraft that took off is the aircraft that lands. There
 * is no recovery either — a tank that has run dry stays dry, and the propeller
 * stops for good rather than giving the pilot one more burst — so the moment
 * the needle reaches the bottom the aeroplane is a glider and stays one.
 *
 * And the engine drinks whether it is being asked for anything or not. The
 * burn is the shaft work the propeller is being turned against, floored at the
 * idle burn, which is what makes a long descent cost fuel and an aeroplane held
 * on the runway waiting cost more than nothing.
 */
function stepFuelSystem(
  plant: Powerplant,
  thrust: number,
  inflow: number,
  density: number,
  dt: number,
): void {
  const capacity = Math.max(plant.battery.fuel?.litres ?? 0, 1e-6);
  const burn = plant.cut ? 0 : fuelBurn(plant.motor, thrust, inflow, density);

  plant.fuelLitres = Math.max(plant.fuelLitres - (burn * dt) / 3600, 0);
  plant.charge = clamp(plant.fuelLitres / capacity, 0, 1);
  plant.fuelBurnLitresPerHour = burn;
  if (plant.fuelLitres <= FUEL_DRY_LITRES) plant.cut = true;
  plant.thrustFactor = plant.cut ? 0 : 1;

  plant.averagedSeconds += dt;
  const window = Math.min(plant.averagedSeconds, ENDURANCE_SMOOTHING);
  const blend = window > dt ? 1 - Math.exp(-dt / window) : 1;
  // The average rides on the same field the electric side uses, in litres per
  // hour rather than amps: one smoothed number, one endurance estimate.
  plant.averageCurrent += (burn - plant.averageCurrent) * blend;
  plant.enduranceSeconds = plant.cut
    ? 0
    : fuelEnduranceAt(plant, plant.averageCurrent);
}

// --- Fitting a power system to an airframe ----------------------------------

/**
 * The airframe as it flies with a given power system fitted.
 *
 * The airframe's own configuration describes it as delivered; this is the same
 * airframe with a different motor on the back and a different pack in the bay,
 * so exactly three numbers move: what it weighs, how hard it pulls, and how
 * fast the propeller can still push it.
 */
export function fitPowerplant(
  config: AircraftConfig,
  dryMassKg: number,
  motor: MotorSpec,
  battery: BatterySpec,
): AircraftConfig {
  const volts = nominalVoltage(battery);
  return {
    ...config,
    mass: dryMassKg + motor.massKg * propellerCount(motor) + loadedMass(battery),
    maxThrust: staticThrust(motor, volts),
    propPitchSpeed: pitchSpeed(motor, volts),
    idleThrust: idleThrustFraction(motor),
  };
}

/**
 * What a pack or a tank puts on the aeroplane, kilograms.
 *
 * A tank's own `massKg` is the empty tank, because what is in it is a separate
 * decision from what it is made of — and it is the fuel that is the weight: an
 * 11.5 litre tank is eight and a half kilos of petrol around a kilo of plastic.
 *
 * The aircraft is flown at its full-tank weight for the whole flight rather
 * than lightening as it burns, exactly as an electric one is flown at its
 * pack's weight. Modelling burn-off would move the aircraft's mass under the
 * flight model mid-flight, and every airframe here is set up once and flown.
 */
export function loadedMass(battery: BatterySpec): number {
  const fuel = battery.fuel;
  if (!fuel) return battery.massKg;
  return battery.massKg + fuel.litres * FUEL_DENSITY_KG_PER_LITRE;
}

/**
 * Thrust with the throttle shut, as a fraction of the airframe's rated thrust.
 *
 * Zero on anything electric: a stopped motor pushes nothing, which is why every
 * wing here glides the moment the stick comes down. An engine is the other way
 * round — it is still running — and what its idle is worth falls straight out
 * of the propeller rather than being a number somebody chose: thrust goes with
 * the square of rpm, so an engine idling at a quarter of its peaking speed is
 * making a sixteenth of its thrust.
 */
export function idleThrustFraction(motor: MotorSpec): number {
  const engine = motor.combustion;
  if (!engine || engine.maxRpm <= 0) return 0;
  const ratio = clamp(engine.idleRpm / engine.maxRpm, 0, 1);
  return ratio * ratio;
}

/**
 * Current the combo asks for standing still at full throttle, amps.
 *
 * The hardest a setup is ever worked: static, at full throttle, is where a
 * propeller is doing the most work for the least airspeed. Quoted against the
 * ESC's own rating in the hangar, and deliberately *not* clamped to it — the
 * point of the number is to show a combo asking for more than its controller
 * is rated to give.
 */
export function motorDemandAmps(
  motor: MotorSpec,
  battery: BatterySpec,
): number {
  // An engine has no controller to overrun and nothing to measure in amps.
  const volts = nominalVoltage(battery);
  if (volts <= 0) return 0;
  return electricalPower(motor, staticThrust(motor, volts), 0) / volts;
}

/**
 * Fuel an engine burns standing still at full throttle, litres per hour.
 *
 * The engine's equivalent of `staticCurrent`, and the hardest it is ever
 * worked: full throttle, no airspeed, the propeller doing the most work for
 * the least return. What a run-up on the runway actually costs.
 */
export function staticBurn(motor: MotorSpec): number {
  if (!isCombustion(motor)) return 0;
  return fuelBurn(motor, staticThrust(motor, 0), 0);
}

/** The same with the ESC's limit and the avionics applied: what is drawn. */
export function staticCurrent(motor: MotorSpec, battery: BatterySpec): number {
  return Math.min(motorDemandAmps(motor, battery), motor.escAmps) + AVIONICS_AMPS;
}

/** A pack — or a tank — the way it is written on the label. */
export function formatBattery(battery: BatterySpec): string {
  const fuel = battery.fuel;
  if (fuel) {
    const litres =
      Number.isInteger(fuel.litres) ? fuel.litres.toFixed(0) : fuel.litres.toFixed(1);
    return `${litres} L`;
  }
  const capacity =
    battery.capacityMah >= 10000
      ? `${(battery.capacityMah / 1000).toFixed(0)} Ah`
      : `${battery.capacityMah} mAh`;
  const chemistry = battery.chemistry === "liion" ? " Li-ion" : "";
  return `${battery.cells}S ${capacity}${chemistry}`;
}

/** Endurance, in the units a pilot plans a flight in. */
export function formatEndurance(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unlimited";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes <= 0) return `${rest} s`;
  return `${minutes} min ${rest.toString().padStart(2, "0")} s`;
}
