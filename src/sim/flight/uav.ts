/**
 * The aircraft the pilot can fly, and how each of them is set up.
 *
 * A UAV is an id, an aerodynamic configuration, the rates it is flown on and
 * the power systems that can be bolted to it, so adding an airframe is adding
 * an entry here rather than threading a second config through the session, the
 * settings and the menus.
 *
 * The rates are stored per UAV for the same reason a transmitter keeps a model
 * memory: they are what makes two airframes feel different on identical
 * sticks, so they cannot be one global number. The power system is stored per
 * UAV for a stronger reason still — a motor and a pack are hardware, and the
 * pack a 2.1 m mapping wing is flown on would not fit in the bay of a 1.4 m
 * interceptor, let alone leave it able to fly.
 *
 * Nothing here assumes an aircraft is a wing. A quadcopter is an entry like
 * any other: an id, a configuration, rates and the hardware that fits it — the
 * hardware simply comes in fours, and the configuration carries the rotor
 * block that makes the flight model treat it as what it is. Nothing assumes
 * the hardware is electric either: a Skyeye's `motors` are petrol engines and
 * its `batteries` are tanks of fuel, which are chosen in the same place, stored
 * against the same keys and fitted by the same function — an engine and a tank
 * are hardware in exactly the way a motor and a pack are.
 *
 * Each airframe's own `config` describes it *as delivered*: with the combo and
 * the pack named by `defaultMotorId` and `defaultBatteryId` fitted. Fit
 * something else and `resolveLoadout` works the airframe out again from the
 * hardware, which is why what a pack weighs and what a propeller can push are
 * flown rather than written down twice.
 */

import type { AircraftConfig } from "./config";
import {
  CA35_160,
  FOAM_GLIDER,
  FT_BABY_BLENDER,
  FT_P38_LIGHTNING,
  FT_TRIPLANE_XL,
  PLAYER_WING,
  SKYEYE_2600,
  SKYEYE_3200,
  SKYEYE_3600,
  SKYEYE_5000,
  SKYEYE_6000,
  SKYWALKER_X8,
  X10_INTERCEPTOR,
} from "./config";
import type { ControlRates } from "./rates";
import { normaliseRates } from "./rates";
import type { Livery } from "./livery";
import { DEFAULT_LIVERY, normaliseLivery } from "./livery";
import type { BatterySpec, MotorSpec } from "./powerplant";
import { BATTERY_UNLIMITED, fitPowerplant, fitsMotor } from "./powerplant";

// --- Power systems ----------------------------------------------------------

/**
 * Motor, ESC and propeller combinations for the interceptor wing.
 *
 * The three ways a 1.4 m foam delta of this weight actually gets flown: the
 * 6S setup it is delivered on, a light 4S setup that trades punch for hours,
 * and a high-pitch 6S setup for people who would rather have the speed.
 */
const INTERCEPTOR_MOTORS: readonly MotorSpec[] = [
  {
    id: "x2820-920-9x5",
    motor: "SunnySky X2820 KV920",
    kv: 920,
    escAmps: 60,
    propDiameter: 9,
    propPitch: 5,
    cells: { min: 6, max: 6 },
    massKg: 0.22,
    summary: "60 A · 9×5 · 6S — as delivered",
  },
  {
    id: "x2216-1250-8x6",
    motor: "SunnySky X2216 KV1250",
    kv: 1250,
    escAmps: 40,
    propDiameter: 8,
    propPitch: 6,
    cells: { min: 4, max: 4 },
    massKg: 0.13,
    summary: "40 A · 8×6 · 4S — light and frugal",
  },
  {
    id: "at2820-1050-8x6",
    motor: "T-Motor AT2820 KV1050",
    kv: 1050,
    escAmps: 80,
    propDiameter: 8,
    propPitch: 6,
    cells: { min: 6, max: 6 },
    massKg: 0.28,
    summary: "80 A · 8×6 · 6S — high pitch speed",
  },
];

/** Packs that fit an interceptor's bay. */
const INTERCEPTOR_BATTERIES: readonly BatterySpec[] = [
  { id: "4s-3000", cells: 4, capacityMah: 3000, cRating: 50, massKg: 0.31 },
  { id: "4s-5000", cells: 4, capacityMah: 5000, cRating: 35, massKg: 0.52 },
  { id: "6s-5000", cells: 6, capacityMah: 5000, cRating: 35, massKg: 0.75 },
  { id: "6s-8000", cells: 6, capacityMah: 8000, cRating: 25, massKg: 1.18 },
];

/**
 * Motor, ESC and propeller combinations for the Skywalker X8.
 *
 * The setups the airframe is sold and flown on: the 12×6 on a KV500 that
 * nearly every mapping X8 in the world carries, the bigger 14×8 on a KV520
 * that hauls a heavy pack off a catapult, and the 4S 5010 sport setup for an
 * X8 that is being flown rather than surveyed with.
 */
const X8_MOTORS: readonly MotorSpec[] = [
  {
    id: "x4250-500-12x6",
    motor: "SunnySky X4250 KV500",
    kv: 500,
    escAmps: 60,
    propDiameter: 12,
    propPitch: 6,
    cells: { min: 6, max: 6 },
    massKg: 0.42,
    summary: "60 A · 12×6 · 6S — the survey standard",
  },
  {
    id: "4255-520-14x8",
    motor: "4255 KV520",
    kv: 520,
    escAmps: 80,
    propDiameter: 14,
    propPitch: 8,
    cells: { min: 6, max: 6 },
    massKg: 0.54,
    summary: "80 A · 14×8 · 6S — heavy-lift",
  },
  {
    id: "os5010-810-12x8",
    motor: "OS 5010 KV810",
    kv: 810,
    escAmps: 100,
    propDiameter: 12,
    propPitch: 8,
    cells: { min: 4, max: 4 },
    massKg: 0.54,
    summary: "100 A · 12×8 · 4S — sport",
  },
];

/** Packs an X8 bay swallows, which is most of them. */
const X8_BATTERIES: readonly BatterySpec[] = [
  { id: "4s-8000", cells: 4, capacityMah: 8000, cRating: 25, massKg: 0.79 },
  { id: "6s-5200", cells: 6, capacityMah: 5200, cRating: 25, massKg: 0.77 },
  { id: "6s-6500", cells: 6, capacityMah: 6500, cRating: 25, massKg: 0.96 },
  { id: "6s-12000", cells: 6, capacityMah: 12000, cRating: 15, massKg: 1.72 },
  { id: "6s-16000", cells: 6, capacityMah: 16000, cRating: 15, massKg: 2.15 },
];

/**
 * Motor, ESC and propeller sets for the CA35-160.
 *
 * Four of everything: a `count` on the combination is the whole of what makes
 * one of these a quadcopter's power system rather than a wing's, and the
 * thrust, the disc area and the weight all follow from it.
 *
 * The three ways a 160 mm frame of this weight is actually flown: the stock
 * 4S setup it ships on, the same motors behind a higher-pitch propeller for
 * people who would rather have the speed, and the 6S conversion racers put on
 * it. The ESC rating is the four controllers together, which is what the stack
 * on the frame actually is.
 */
const CA35_MOTORS: readonly MotorSpec[] = [
  {
    id: "p1604-3800-3.5x2.5",
    motor: "T-Motor P1604 KV3800",
    kv: 3800,
    escAmps: 140,
    propDiameter: 3.5,
    propPitch: 2.5,
    cells: { min: 4, max: 4 },
    massKg: 0.0175,
    count: 4,
    summary: "4 × 35 A · 3.5×2.5 tri · 4S — as delivered",
  },
  {
    id: "p1604-3800-3.5x3",
    motor: "T-Motor P1604 KV3800",
    kv: 3800,
    escAmps: 140,
    propDiameter: 3.5,
    propPitch: 3,
    cells: { min: 4, max: 4 },
    massKg: 0.018,
    count: 4,
    summary: "4 × 35 A · 3.5×3 tri · 4S — high pitch speed",
  },
  {
    id: "p1604-2650-3.5x3",
    motor: "T-Motor P1604 KV2650",
    kv: 2650,
    escAmps: 140,
    propDiameter: 3.5,
    propPitch: 3,
    cells: { min: 6, max: 6 },
    massKg: 0.0175,
    count: 4,
    summary: "4 × 35 A · 3.5×3 tri · 6S — the racing conversion",
  },
];

/**
 * Packs that fit under a CA35-160.
 *
 * The pack is most of what decides what kind of flight this is, because on a
 * quadcopter it is a third of the aircraft. The 750 is what it is delivered
 * on; the 450 is the pack a race is flown on and is over in three minutes; the
 * 1100 buys most of another two; and the lithium-ion is a different aeroplane
 * entirely — heavy, gutless, and still flying twenty minutes later.
 */
const CA35_BATTERIES: readonly BatterySpec[] = [
  { id: "4s-450", cells: 4, capacityMah: 450, cRating: 95, massKg: 0.055 },
  { id: "4s-750", cells: 4, capacityMah: 750, cRating: 120, massKg: 0.088 },
  { id: "4s-1100", cells: 4, capacityMah: 1100, cRating: 95, massKg: 0.125 },
  {
    id: "4s-liion-3000",
    cells: 4,
    capacityMah: 3000,
    cRating: 5,
    massKg: 0.185,
    chemistry: "liion",
  },
  { id: "6s-550", cells: 6, capacityMah: 550, cRating: 120, massKg: 0.092 },
];

/**
 * Motor, ESC and propeller sets for the Foamie Glider 480.
 *
 * Two of everything, the same way the quadcopter has four: what a twin costs
 * in weight and gives in thrust follows from the `count`, and the propeller's
 * pitch speed — a property of one blade — does not.
 *
 * The ways a converted chuck glider of this size is actually flown. The
 * KV6000 on 2S is the combination the airframe is described on and the one the
 * ten minutes is quoted at; the KV4500 is the same motor turning more slowly
 * for people who would rather stay up; the high-pitch propeller is for people
 * who would rather not; and the 3S conversion is what happens when somebody
 * finds out how little of the pack these motors actually draw. The ESC rating
 * is both controllers on the AIO board together, which is what is really
 * bolted into the fuselage.
 */
const GLIDER_MOTORS: readonly MotorSpec[] = [
  {
    id: "ex1202.5-6000-2.5x2.5",
    motor: "Happymodel EX1202.5 KV6000",
    kv: 6000,
    escAmps: 24,
    propDiameter: 2.5,
    propPitch: 2.5,
    cells: { min: 2, max: 2 },
    massKg: 0.0075,
    count: 2,
    summary: "2 × 12 A · 2.5×2.5 · 2S — as delivered",
  },
  {
    id: "ex1202.5-4500-2.5x2.5",
    motor: "Happymodel EX1202.5 KV4500",
    kv: 4500,
    escAmps: 24,
    propDiameter: 2.5,
    propPitch: 2.5,
    cells: { min: 2, max: 2 },
    massKg: 0.0075,
    count: 2,
    summary: "2 × 12 A · 2.5×2.5 · 2S — quiet and frugal",
  },
  {
    id: "ex1202.5-6000-2.5x3",
    motor: "Happymodel EX1202.5 KV6000",
    kv: 6000,
    escAmps: 24,
    propDiameter: 2.5,
    propPitch: 3,
    cells: { min: 2, max: 2 },
    massKg: 0.0077,
    count: 2,
    summary: "2 × 12 A · 2.5×3 · 2S — high pitch speed",
  },
  {
    id: "ex1202.5-4500-2.5x2.5-3s",
    motor: "Happymodel EX1202.5 KV4500",
    kv: 4500,
    escAmps: 24,
    propDiameter: 2.5,
    propPitch: 2.5,
    cells: { min: 3, max: 3 },
    massKg: 0.0075,
    count: 2,
    summary: "2 × 12 A · 2.5×2.5 · 3S — the fast conversion",
  },
];

/**
 * Packs that fit under a glider's wing.
 *
 * On a 90 g airframe the pack is a third of the aeroplane, so choosing one is
 * choosing what kind of flight this is far more than it is on a wing. The 720
 * is what the listing quotes its ten minutes on; the 450 is what it is thrown
 * off a hill with when the point is the gliding; the 1000 is most of another
 * two minutes at the cost of a wing loading it can feel; and the pair of
 * 18650s is a different aeroplane entirely — heavy, gutless, slow to answer,
 * and still up there half an hour later.
 */
const GLIDER_BATTERIES: readonly BatterySpec[] = [
  { id: "2s-450", cells: 2, capacityMah: 450, cRating: 75, massKg: 0.026 },
  { id: "2s-720", cells: 2, capacityMah: 720, cRating: 50, massKg: 0.04 },
  { id: "2s-1000", cells: 2, capacityMah: 1000, cRating: 35, massKg: 0.055 },
  {
    id: "2s-liion-3000",
    cells: 2,
    capacityMah: 3000,
    cRating: 5,
    massKg: 0.09,
    chemistry: "liion",
  },
  { id: "3s-550", cells: 3, capacityMah: 550, cRating: 75, massKg: 0.048 },
];

/**
 * Motor, ESC and propeller sets for the X10 Interceptor.
 *
 * Four of everything, like the quadcopter, and the interesting part is the
 * propeller rather than the motor. What makes an airframe fast in this model is
 * pitch speed — the speed at which the blade stops having any angle of attack
 * left to work with — and pitch speed is rpm times pitch. Both of those have a
 * ceiling: a blade tip cannot be taken far past three quarters of the speed of
 * sound without the propeller coming apart, and the tip speed is rpm times
 * *diameter*. So the way to 500 km/h is a small diameter turning very fast
 * behind a great deal of pitch, and that is what these are: four-inch
 * propellers cut at a pitch two thirds again their own diameter, which is a
 * speed-record ratio rather than anything sold for a racing quad. They pull
 * badly below 50 km/h and they are the whole reason it goes this fast above it.
 *
 * The ESC rating is the four controllers together, which is what the stack in
 * the body actually is.
 */
const X10_MOTORS: readonly MotorSpec[] = [
  {
    id: "sr2306-2450-4.2x7",
    motor: "Seboar SR2306 KV2450",
    kv: 2450,
    escAmps: 240,
    propDiameter: 4.2,
    propPitch: 7,
    cells: { min: 6, max: 6 },
    massKg: 0.031,
    count: 4,
    summary: "4 × 60 A · 4.2×7 · 6S — as delivered",
  },
  {
    id: "sr2306-2450-4.2x7.5",
    motor: "Seboar SR2306 KV2450",
    kv: 2450,
    escAmps: 240,
    propDiameter: 4.2,
    propPitch: 7.5,
    cells: { min: 6, max: 6 },
    massKg: 0.031,
    count: 4,
    summary: "4 × 60 A · 4.2×7.5 · 6S — the record propeller",
  },
  {
    id: "sr2306-1900-4.2x7",
    motor: "Seboar SR2306 KV1900",
    kv: 1900,
    escAmps: 200,
    propDiameter: 4.2,
    propPitch: 7,
    cells: { min: 6, max: 6 },
    massKg: 0.029,
    count: 4,
    summary: "4 × 50 A · 4.2×7 · 6S — long loiter",
  },
  {
    id: "sr2306-1850-4.2x7",
    motor: "Seboar SR2306 KV1850",
    kv: 1850,
    escAmps: 240,
    propDiameter: 4.2,
    propPitch: 7,
    cells: { min: 8, max: 8 },
    massKg: 0.031,
    count: 4,
    summary: "4 × 60 A · 4.2×7 · 8S — the high-voltage conversion",
  },
];

/**
 * Packs that go into an X10's body.
 *
 * A long thin bay, so the choice is how much of the body is battery. The 1100
 * is what it is delivered on and the one the ten minutes is quoted against; the
 * 850 is what it is flown on when somebody wants the acceleration and knows the
 * interception is going to be over quickly; the 1300 buys another minute and a
 * half of loiter at the cost of a hover it can feel. The 8S pack is for the
 * high-voltage conversion, and it is the same aircraft flown more efficiently
 * rather than a faster one.
 *
 * The lithium-ion is the interesting one. It doubles the loiter — twenty-odd
 * minutes of sitting in the sky waiting for something to come past, which is
 * what an interceptor spends most of its life doing — and it cannot give up
 * current in a hurry, so the airframe sags hard the moment the dash it was
 * waiting for actually starts. Whether that is a good trade is the whole
 * question a pack is chosen on.
 */
const X10_BATTERIES: readonly BatterySpec[] = [
  { id: "6s-850", cells: 6, capacityMah: 850, cRating: 120, massKg: 0.135 },
  { id: "6s-1100", cells: 6, capacityMah: 1100, cRating: 120, massKg: 0.175 },
  { id: "6s-1300", cells: 6, capacityMah: 1300, cRating: 95, massKg: 0.2 },
  {
    id: "6s-liion-3000",
    cells: 6,
    capacityMah: 3000,
    cRating: 5,
    massKg: 0.29,
    chemistry: "liion",
  },
  { id: "8s-1100", cells: 8, capacityMah: 1100, cRating: 95, massKg: 0.23 },
];

/**
 * Motor, ESC and propeller combinations for the FT Triplane XL.
 *
 * One motor and four propellers, which is what a barnstormer's catalogue
 * actually looks like: the 2814 is the aeroplane's motor and what changes it
 * from one aircraft into another is the blade in front of it. A triplane tops
 * out where its propeller runs out of pitch and nowhere near where it runs out
 * of thrust, so the choice here is not power against economy the way it is on
 * a wing — it is thrust against speed, and both ends of it are useful.
 *
 * The ESC ratings are the one place these do not read straight off the kit.
 * Flite Test specify a 40 A controller, which is a burst rating covering a
 * full-throttle static pull rather than a continuous one, and the figure this
 * simulator quotes against a controller is what the combination asks for
 * standing still with the stick open. So the delivered setup carries the 60 A
 * that will actually hold it, and the one combination genuinely inside 40 A —
 * the big slow 13x4 — says so.
 */
const TRIPLANE_MOTORS: readonly MotorSpec[] = [
  {
    id: "ft2814-1100-12x4.5",
    motor: "FT 2814 KV1100",
    kv: 1100,
    escAmps: 60,
    propDiameter: 12,
    propPitch: 4.5,
    cells: { min: 3, max: 3 },
    massKg: 0.093,
    summary: "60 A · 12×4.5 · 3S — as delivered",
  },
  {
    id: "ft2814-900-13x4",
    motor: "FT 2814 KV900",
    kv: 900,
    escAmps: 40,
    propDiameter: 13,
    propPitch: 4,
    cells: { min: 3, max: 3 },
    massKg: 0.093,
    summary: "40 A · 13×4 · 3S — the big slow propeller",
  },
  {
    id: "ft2814-1100-11x5.5",
    motor: "FT 2814 KV1100",
    kv: 1100,
    escAmps: 50,
    propDiameter: 11,
    propPitch: 5.5,
    cells: { min: 3, max: 3 },
    massKg: 0.093,
    summary: "50 A · 11×5.5 · 3S — less pull, more speed",
  },
  {
    id: "2814-800-12x6-4s",
    motor: "2814 KV800",
    kv: 800,
    escAmps: 60,
    propDiameter: 12,
    propPitch: 6,
    cells: { min: 4, max: 4 },
    massKg: 0.098,
    summary: "60 A · 12×6 · 4S — the four-cell conversion",
  },
];

/**
 * Packs that go under a Triplane XL's hatch.
 *
 * The 3300 is the kit's own and the aeroplane is balanced around it — the
 * centre of gravity is 63.5 mm behind the middle wing's leading edge and the
 * pack is most of what puts it there. The 2200 is eighty grams off an aeroplane
 * that only weighs 1.76 kg, and it shows: it hangs on the propeller more
 * willingly, and it is over in eleven minutes rather than seventeen. The 5000
 * is the other way — a scale flight of twenty-five minutes rather than an
 * aerobatic one, bought with a fifth again the wing loading on the lightest
 * thing about this aeroplane. And the two four-cell packs are for the
 * conversion, which is the same aeroplane going faster.
 */
const TRIPLANE_BATTERIES: readonly BatterySpec[] = [
  { id: "3s-2200", cells: 3, capacityMah: 2200, cRating: 35, massKg: 0.185 },
  { id: "3s-3300", cells: 3, capacityMah: 3300, cRating: 30, massKg: 0.265 },
  { id: "3s-5000", cells: 3, capacityMah: 5000, cRating: 25, massKg: 0.39 },
  { id: "4s-2200", cells: 4, capacityMah: 2200, cRating: 35, massKg: 0.245 },
  { id: "4s-3300", cells: 4, capacityMah: 3300, cRating: 30, massKg: 0.35 },
];

/**
 * Motor, ESC and propeller combinations for the FT P-38 Lightning.
 *
 * Everything here is two of it, which is the whole of what makes this airframe
 * different in a catalogue: `count` multiplies the thrust, the disc the air is
 * thrown through and the weight, exactly as it does on a quadcopter, and the
 * `escAmps` quoted is both controllers together because that is what is
 * actually bolted into the aeroplane.
 *
 * The kit's own combination needs a word, because Flite Test's two pages do not
 * quite agree with each other. The Power Pack C Radial v.2 Twin ships 10×4.5
 * blades — it is the three-cell pack with a second motor added to it — and the
 * P-38 asks for a four-cell battery. The motor's own specification says a
 * ten-inch propeller on three cells *or* a nine-inch one on four, and the
 * arithmetic in `powerplant.ts` agrees with it rather emphatically: the ten-inch
 * blade on four cells asks for 105 A standing still, against the 80 A of
 * controller in the box. So the aeroplane is delivered here the way Flite Test
 * specify the motor — the same 4.5 pitch, one inch smaller across, on the
 * kit's 4S — and the blades that come in the box are the combination below it,
 * flown on the three cells they are meant for.
 */
const P38_MOTORS: readonly MotorSpec[] = [
  {
    id: "radial2218-1180-9x4.5",
    motor: "FT Radial 2218 KV1180",
    kv: 1180,
    escAmps: 80,
    propDiameter: 9,
    propPitch: 4.5,
    cells: { min: 4, max: 4 },
    massKg: 0.115,
    count: 2,
    summary: "2 × 40 A · 9×4.5 · 4S — as delivered",
  },
  {
    id: "radial2218-1180-10x4.5",
    motor: "FT Radial 2218 KV1180",
    kv: 1180,
    escAmps: 80,
    propDiameter: 10,
    propPitch: 4.5,
    cells: { min: 3, max: 3 },
    massKg: 0.117,
    count: 2,
    summary: "2 × 40 A · 10×4.5 · 3S — the blades in the box",
  },
  {
    id: "radial2218-1180-9x6",
    motor: "FT Radial 2218 KV1180",
    kv: 1180,
    escAmps: 100,
    propDiameter: 9,
    propPitch: 6,
    cells: { min: 4, max: 4 },
    massKg: 0.12,
    count: 2,
    summary: "2 × 50 A · 9×6 · 4S — high pitch speed",
  },
  {
    id: "radial2814-1050-10x5",
    motor: "FT Radial 2814 KV1050",
    kv: 1050,
    escAmps: 120,
    propDiameter: 10,
    propPitch: 5,
    cells: { min: 4, max: 4 },
    massKg: 0.145,
    count: 2,
    summary: "2 × 60 A · 10×5 · 4S — the big-motor conversion",
  },
];

/**
 * Packs that go into a P-38's hatch.
 *
 * The 2300 mAh 4S is the kit's, and it is the one the aeroplane is balanced
 * around: the pack goes into the gondola ahead of the wing and is most of what
 * puts the centre of gravity 45 mm behind the leading edge. The 3000 is what
 * the shops list against the airframe instead and is worth four more minutes
 * for eighty grams; the 4000 is a cruise rather than a sortie. The two
 * three-cell packs are for the blades in the box, which is a slower and
 * noticeably longer-legged aeroplane.
 */
const P38_BATTERIES: readonly BatterySpec[] = [
  { id: "3s-2200", cells: 3, capacityMah: 2200, cRating: 35, massKg: 0.19 },
  { id: "3s-3300", cells: 3, capacityMah: 3300, cRating: 30, massKg: 0.27 },
  { id: "4s-2300", cells: 4, capacityMah: 2300, cRating: 35, massKg: 0.27 },
  { id: "4s-3000", cells: 4, capacityMah: 3000, cRating: 35, massKg: 0.35 },
  { id: "4s-4000", cells: 4, capacityMah: 4000, cRating: 30, massKg: 0.44 },
];


/**
 * Motor, ESC and propeller combinations for the FT Baby Blender.
 *
 * The kit calls for Power Pack C and that is the first of these: the FT Radial
 * 2218 KV1180, a 40 A controller and the HQ 10x4.5 that comes in the box, on
 * the three cells the aeroplane is sold to fly on. It is a lot of motor for a
 * 397 g airframe — that combination pulls nearly three times the aeroplane's
 * weight — and it is what makes a foam biplane do the things on the listing.
 *
 * The second is the same motor on the blade its own specification asks for,
 * the 10x4.7, which is a hair more of everything. The third is Power Pack B,
 * one size down: the Radial 2212B on a nine-inch blade is barely half the
 * thrust and it turns the aeroplane back into the gentle four-channel trainer
 * the description starts by describing. And the fourth is four cells on the
 * nine-inch blade the 2218 is specified for above three — the conversion, and
 * the only way this airframe goes anywhere quickly, because what limits it on
 * the kit's setup is not power but a big slow propeller.
 */
const BABY_BLENDER_MOTORS: readonly MotorSpec[] = [
  {
    id: "radial2218-1180-10x4.5",
    motor: "FT Radial 2218 KV1180",
    kv: 1180,
    escAmps: 40,
    propDiameter: 10,
    propPitch: 4.5,
    cells: { min: 3, max: 3 },
    massKg: 0.117,
    summary: "40 A · 10×4.5 · 3S — Power Pack C, as delivered",
  },
  {
    id: "radial2218-1180-10x4.7",
    motor: "FT Radial 2218 KV1180",
    kv: 1180,
    escAmps: 40,
    propDiameter: 10,
    propPitch: 4.7,
    cells: { min: 3, max: 3 },
    massKg: 0.117,
    summary: "40 A · 10×4.7 · 3S — the blade the motor is specified for",
  },
  {
    id: "radial2212-1050-9x4.5",
    motor: "FT Radial 2212B KV1050",
    kv: 1050,
    escAmps: 25,
    propDiameter: 9,
    propPitch: 4.5,
    cells: { min: 3, max: 3 },
    massKg: 0.088,
    summary: "25 A · 9×4.5 · 3S — Power Pack B, and half the thrust",
  },
  {
    id: "radial2218-1180-9x4.5-4s",
    motor: "FT Radial 2218 KV1180",
    kv: 1180,
    escAmps: 40,
    propDiameter: 9,
    propPitch: 4.5,
    cells: { min: 4, max: 4 },
    massKg: 0.118,
    summary: "40 A · 9×4.5 · 4S — the four-cell conversion",
  },
];

/**
 * Packs that go under a Baby Blender's hatch.
 *
 * The kit asks for a three-cell pack between 1300 and 2200 mAh and the store
 * sells it with an 1800, which is the one the aeroplane is balanced around:
 * the pack goes into the power pod ahead of the wing and is most of what puts
 * the centre of gravity 80 mm behind the top wing's leading edge. The 1300 is
 * thirty-five grams off an aeroplane that only weighs 567, and it shows —
 * it hangs on the propeller more willingly and it is over sooner. The 2200 is
 * the other end of the same range. The two four-cell packs are for the
 * conversion, and there is no larger one here on purpose: this is a 610 mm
 * aeroplane, and the pod will not take one.
 */
const BABY_BLENDER_BATTERIES: readonly BatterySpec[] = [
  { id: "3s-1300", cells: 3, capacityMah: 1300, cRating: 45, massKg: 0.115 },
  { id: "3s-1800", cells: 3, capacityMah: 1800, cRating: 45, massKg: 0.15 },
  { id: "3s-2200", cells: 3, capacityMah: 2200, cRating: 35, massKg: 0.185 },
  { id: "4s-1300", cells: 4, capacityMah: 1300, cRating: 45, massKg: 0.15 },
  { id: "4s-1800", cells: 4, capacityMah: 1800, cRating: 45, massKg: 0.2 },
];

/**
 * Engines, propellers and tanks for the Skyeye series.
 *
 * A different kind of catalogue, and it is the `combustion` block that makes it
 * one: no kv, no controller and no cells, because a petrol engine has none of
 * them. What it has instead is a displacement, the rpm it peaks at with a
 * propeller of that size on it, the rpm it idles at, and how thirsty it is —
 * and the same Staples propeller model turns those into the thrust and the
 * pitch speed the airframe flies on, exactly as it does for a motor.
 *
 * The engines are the ones each airframe is actually sold to take, from the
 * compatibility the series is published with: 20-35 cc on the 2600, 50-80 on
 * the 3200, 50-100 on the 3600, 150-180 on the 5000 and the injected 180 on the
 * 6000. Fitting one is choosing between a thirsty aeroplane that goes quickly
 * and a frugal one that stays up, and the choice is far starker than it is on
 * anything electric here — an engine two sizes up on the same airframe is an
 * hour and a half of flying gone.
 *
 * The interesting number on any of them is the last one but two. Two-strokes
 * are dreadful engines and small two-strokes are worse: a 20 cc burns nearly
 * three litres of petrol for every kilowatt-hour it puts into the propeller,
 * where the fuel-injected 180 on the flagship manages it on one. That single
 * figure is why the largest and heaviest aeroplane in the series is also the
 * one that stays up longest.
 */

/** The 20-35 cc engines a Skyeye 2600 is sold to take. */
const SKYEYE_2600_ENGINES: readonly MotorSpec[] = [
  {
    id: "dle20-16x11",
    motor: "DLE-20 · 16×11",
    kv: 0,
    escAmps: 0,
    propDiameter: 16,
    propPitch: 11,
    cells: { min: 0, max: 0 },
    massKg: 2.1,
    combustion: {
      displacementCc: 20,
      maxRpm: 8200,
      idleRpm: 1900,
      litresPerKwh: 2.9,
      idleLitresPerHour: 0.32,
    },
    summary: "20 cc · 16×11 — as delivered",
  },
  {
    id: "dle30-17x11",
    motor: "DLE-30 · 17×11",
    kv: 0,
    escAmps: 0,
    propDiameter: 17,
    propPitch: 11,
    cells: { min: 0, max: 0 },
    massKg: 2.55,
    combustion: {
      displacementCc: 30,
      maxRpm: 7900,
      idleRpm: 1900,
      litresPerKwh: 2.7,
      idleLitresPerHour: 0.4,
    },
    summary: "30 cc · 17×11 — more off the runway",
  },
  {
    id: "da35-17x13",
    motor: "DA-35 · 17×13",
    kv: 0,
    escAmps: 0,
    propDiameter: 17,
    propPitch: 13,
    cells: { min: 0, max: 0 },
    massKg: 2.8,
    combustion: {
      displacementCc: 35,
      maxRpm: 8000,
      idleRpm: 2000,
      litresPerKwh: 2.5,
      idleLitresPerHour: 0.45,
    },
    summary: "35 cc · 17×13 — the fast one, and it drinks",
  },
];

/**
 * Tanks that go in a 2600.
 *
 * Five litres is what the airframe is sold around; the small tank is what it is
 * flown on when the payload is heavy and the sortie is short, and the big one
 * fills the bay behind the wing spar at the cost of most of the payload.
 */
const SKYEYE_2600_TANKS: readonly BatterySpec[] = [
  { id: "tank-3.5", cells: 0, capacityMah: 0, cRating: 0, massKg: 0.42, fuel: { litres: 3.5 } },
  { id: "tank-5", cells: 0, capacityMah: 0, cRating: 0, massKg: 0.55, fuel: { litres: 5 } },
  { id: "tank-6.5", cells: 0, capacityMah: 0, cRating: 0, massKg: 0.68, fuel: { litres: 6.5 } },
];

/** The 50-80 cc engines a Skyeye 3200 is sold to take. */
const SKYEYE_3200_ENGINES: readonly MotorSpec[] = [
  {
    id: "dle55-20x12",
    motor: "DLE-55RA · 20×12",
    kv: 0,
    escAmps: 0,
    propDiameter: 20,
    propPitch: 12,
    cells: { min: 0, max: 0 },
    massKg: 3.6,
    combustion: {
      displacementCc: 55,
      maxRpm: 7600,
      idleRpm: 1800,
      litresPerKwh: 1.9,
      idleLitresPerHour: 0.55,
    },
    summary: "55 cc · 20×12 — as delivered",
  },
  {
    id: "da70-21x13",
    motor: "DA-70 · 21×13",
    kv: 0,
    escAmps: 0,
    propDiameter: 21,
    propPitch: 13,
    cells: { min: 0, max: 0 },
    massKg: 4.1,
    combustion: {
      displacementCc: 70,
      maxRpm: 7300,
      idleRpm: 1800,
      litresPerKwh: 1.85,
      idleLitresPerHour: 0.62,
    },
    summary: "70 cc · 21×13 — heavy-lift",
  },
  {
    id: "da80-22x13",
    motor: "DA-80 · 22×13",
    kv: 0,
    escAmps: 0,
    propDiameter: 22,
    propPitch: 13,
    cells: { min: 0, max: 0 },
    massKg: 4.45,
    combustion: {
      displacementCc: 80,
      maxRpm: 7100,
      idleRpm: 1750,
      litresPerKwh: 1.85,
      idleLitresPerHour: 0.72,
    },
    summary: "80 cc · 22×13 — everything the frame is rated for",
  },
];

/** Tanks that go in a 3200. Six litres is the kit's own. */
const SKYEYE_3200_TANKS: readonly BatterySpec[] = [
  { id: "tank-4", cells: 0, capacityMah: 0, cRating: 0, massKg: 0.5, fuel: { litres: 4 } },
  { id: "tank-6", cells: 0, capacityMah: 0, cRating: 0, massKg: 0.7, fuel: { litres: 6 } },
  { id: "tank-9", cells: 0, capacityMah: 0, cRating: 0, massKg: 0.92, fuel: { litres: 9 } },
];

/** The 50-100 cc engines a Skyeye 3600 is sold to take. */
const SKYEYE_3600_ENGINES: readonly MotorSpec[] = [
  {
    id: "da100-22x13",
    motor: "DA-100 twin · 22×13",
    kv: 0,
    escAmps: 0,
    propDiameter: 22,
    propPitch: 13,
    cells: { min: 0, max: 0 },
    massKg: 5.2,
    combustion: {
      displacementCc: 100,
      maxRpm: 7400,
      idleRpm: 1800,
      litresPerKwh: 1.85,
      idleLitresPerHour: 0.8,
    },
    summary: "100 cc · 22×13 — as delivered",
  },
  {
    id: "dle55-3600-20x12",
    motor: "DLE-55RA · 20×12",
    kv: 0,
    escAmps: 0,
    propDiameter: 20,
    propPitch: 12,
    cells: { min: 0, max: 0 },
    massKg: 3.6,
    combustion: {
      displacementCc: 55,
      maxRpm: 7600,
      idleRpm: 1800,
      litresPerKwh: 1.9,
      idleLitresPerHour: 0.55,
    },
    summary: "55 cc · 20×12 — the endurance fit, and an hour more of it",
  },
  {
    id: "dle85-22x13",
    motor: "DLE-85 · 22×13",
    kv: 0,
    escAmps: 0,
    propDiameter: 22,
    propPitch: 13,
    cells: { min: 0, max: 0 },
    massKg: 4.6,
    combustion: {
      displacementCc: 85,
      maxRpm: 7100,
      idleRpm: 1750,
      litresPerKwh: 1.85,
      idleLitresPerHour: 0.72,
    },
    summary: "85 cc · 22×13 — a single in place of the twin",
  },
];

/**
 * Tanks that go in a 3600.
 *
 * The 11.5 is not a tank strapped in, it is the fuselage cabin: the airframe is
 * built around it, and it is the whole reason this one stays up for four and a
 * half hours. The 6 is a ferry fit for a short sortie with a heavy payload.
 */
const SKYEYE_3600_TANKS: readonly BatterySpec[] = [
  { id: "tank-6", cells: 0, capacityMah: 0, cRating: 0, massKg: 0.7, fuel: { litres: 6 } },
  { id: "tank-11.5", cells: 0, capacityMah: 0, cRating: 0, massKg: 1, fuel: { litres: 11.5 } },
  { id: "tank-14", cells: 0, capacityMah: 0, cRating: 0, massKg: 1.2, fuel: { litres: 14 } },
];

/** The 150-180 cc engines a Skyeye 5000 is sold to take. */
const SKYEYE_5000_ENGINES: readonly MotorSpec[] = [
  {
    id: "da150-26x14",
    motor: "DA-150 twin · 26×14",
    kv: 0,
    escAmps: 0,
    propDiameter: 26,
    propPitch: 14,
    cells: { min: 0, max: 0 },
    massKg: 7.5,
    combustion: {
      displacementCc: 150,
      maxRpm: 6800,
      idleRpm: 1700,
      litresPerKwh: 1.5,
      idleLitresPerHour: 0.9,
    },
    summary: "150 cc · 26×14 — as delivered",
  },
  {
    id: "3w170-27x15",
    motor: "3W-170 twin · 27×15",
    kv: 0,
    escAmps: 0,
    propDiameter: 27,
    propPitch: 15,
    cells: { min: 0, max: 0 },
    massKg: 8.2,
    combustion: {
      displacementCc: 170,
      maxRpm: 6600,
      idleRpm: 1700,
      litresPerKwh: 1.5,
      idleLitresPerHour: 1.05,
    },
    summary: "170 cc · 27×15 — full load off a short strip",
  },
  {
    id: "sp180-28x15",
    motor: "Sky Power SP-180 EFI · 28×15",
    kv: 0,
    escAmps: 0,
    propDiameter: 28,
    propPitch: 15,
    cells: { min: 0, max: 0 },
    massKg: 8.5,
    combustion: {
      displacementCc: 180,
      maxRpm: 6600,
      idleRpm: 1650,
      litresPerKwh: 1.05,
      idleLitresPerHour: 0.9,
    },
    summary: "180 cc injected · 28×15 — more power and two hours more of it",
  },
];

/**
 * Tanks that go in a 5000.
 *
 * The 28 is the Kevlar-reinforced one the airframe is sold with, and it is
 * twenty kilos of petrol: a quarter of the aeroplane's maximum weight is what
 * it is going to burn.
 */
const SKYEYE_5000_TANKS: readonly BatterySpec[] = [
  { id: "tank-20", cells: 0, capacityMah: 0, cRating: 0, massKg: 1.7, fuel: { litres: 20 } },
  { id: "tank-28", cells: 0, capacityMah: 0, cRating: 0, massKg: 2.1, fuel: { litres: 28 } },
  { id: "tank-36", cells: 0, capacityMah: 0, cRating: 0, massKg: 2.6, fuel: { litres: 36 } },
];

/** What goes on the nose of a 6000, injected first. */
const SKYEYE_6000_ENGINES: readonly MotorSpec[] = [
  {
    id: "sp180efi-28x16",
    motor: "Sky Power SP-180 EFI · 28×16",
    kv: 0,
    escAmps: 0,
    propDiameter: 28,
    propPitch: 16,
    cells: { min: 0, max: 0 },
    massKg: 8.5,
    combustion: {
      displacementCc: 180,
      maxRpm: 6600,
      idleRpm: 1650,
      litresPerKwh: 1.05,
      idleLitresPerHour: 0.9,
    },
    summary: "180 cc injected · 28×16 — as delivered",
  },
  {
    id: "3w196efi-29x17",
    motor: "3W-196 EFI · 29×17",
    kv: 0,
    escAmps: 0,
    propDiameter: 29,
    propPitch: 17,
    cells: { min: 0, max: 0 },
    massKg: 9.1,
    combustion: {
      displacementCc: 196,
      maxRpm: 6500,
      idleRpm: 1650,
      litresPerKwh: 1.05,
      idleLitresPerHour: 1,
    },
    summary: "196 cc injected · 29×17 — the fastest thing in the series",
  },
  {
    id: "3w170-6000-27x15",
    motor: "3W-170 twin · 27×15",
    kv: 0,
    escAmps: 0,
    propDiameter: 27,
    propPitch: 15,
    cells: { min: 0, max: 0 },
    massKg: 8.2,
    combustion: {
      displacementCc: 170,
      maxRpm: 6600,
      idleRpm: 1700,
      litresPerKwh: 1.5,
      idleLitresPerHour: 1.05,
    },
    summary: "170 cc carburetted · 27×15 — cheaper, and it shows in the hours",
  },
];

/** Tanks that go in a 6000. The same 28 litres as the 5000, flown further. */
const SKYEYE_6000_TANKS: readonly BatterySpec[] = [
  { id: "tank-22", cells: 0, capacityMah: 0, cRating: 0, massKg: 1.8, fuel: { litres: 22 } },
  { id: "tank-28", cells: 0, capacityMah: 0, cRating: 0, massKg: 2.1, fuel: { litres: 28 } },
  { id: "tank-36", cells: 0, capacityMah: 0, cRating: 0, massKg: 2.6, fuel: { litres: 36 } },
];

// --- Airframes --------------------------------------------------------------

export interface Uav {
  /** Stable key. Settings are stored against it, so it must not change. */
  readonly id: string;
  /** One line for the hangar list. */
  readonly summary: string;
  /** The airframe as delivered: default combo fitted, default pack aboard. */
  readonly config: AircraftConfig;
  /**
   * What the airframe weighs with nothing electrical in it, kilograms.
   *
   * Structure, servos, flight controller and FPV gear. The motor and the pack
   * are added back by whichever loadout is fitted, which is what makes a 16 Ah
   * pack cost wing loading instead of costing nothing.
   */
  readonly dryMassKg: number;
  /**
   * The rates the airframe is delivered on.
   *
   * Chosen to fly close to what the bare aerodynamics do at cruise, so the
   * default feel is the one the simulator has always had, and the sliders move
   * away from it in both directions.
   */
  readonly defaultRates: ControlRates;
  /**
   * The colours the airframe is delivered in.
   *
   * A property of the aircraft rather than a preference: a survey wing comes
   * out of the box white and an interceptor comes out of it grey, and the
   * pilot repaints from there.
   */
  readonly defaultLivery: Livery;
  /** Motor, ESC and propeller combinations that fit this airframe. */
  readonly motors: readonly MotorSpec[];
  /** Packs its bay will take. Which of them a combo can run is a cell count. */
  readonly batteries: readonly BatterySpec[];
  /** The combo it is delivered with, and which `config` describes. */
  readonly defaultMotorId: string;
  /** The pack it is delivered with, and whose weight `config` includes. */
  readonly defaultBatteryId: string;
}

export const INTERCEPTOR_WING: Uav = {
  id: "interceptor-wing",
  summary: "1.4 m foam delta, 2.2 kg, 95 km/h",
  config: PLAYER_WING,
  dryMassKg: 1.23,
  defaultRates: {
    rollRate: 360,
    pitchRate: 130,
    rollExpo: 0.15,
    pitchExpo: 0.2,
  },
  defaultLivery: DEFAULT_LIVERY,
  motors: INTERCEPTOR_MOTORS,
  batteries: INTERCEPTOR_BATTERIES,
  defaultMotorId: "x2820-920-9x5",
  defaultBatteryId: "6s-5000",
};

export const SKYWALKER_X8_UAV: Uav = {
  id: "skywalker-x8",
  summary: "2.1 m survey wing, 2.7 kg, 70 km/h, an hour of it",
  config: SKYWALKER_X8,
  dryMassKg: 1.55,
  // Twice the span and three times the roll inertia: an X8 is flown in wide,
  // deliberate movements, and delivering it on an interceptor's rates would
  // only ask the sticks for a roll the airframe is never going to produce.
  defaultRates: {
    rollRate: 180,
    pitchRate: 85,
    rollExpo: 0.2,
    pitchExpo: 0.25,
  },
  // The airframe is sold as bare white foam and almost every one flying is
  // still that colour, with tape on the wingtips so it can be found again.
  defaultLivery: { shell: "#e6e6e1", accent: "#ff6b0d" },
  motors: X8_MOTORS,
  batteries: X8_BATTERIES,
  defaultMotorId: "x4250-500-12x6",
  defaultBatteryId: "6s-5200",
};

/**
 * The CA35-160: the quadcopter in the hangar.
 *
 * The one airframe here that is not a wing, and it is not flown like one. It
 * hovers, it turns on the spot, it has no stall to fall out of and no glide to
 * come home on, and it will out-accelerate every wing here and out-turn them
 * at any speed they can reach. What it will not do is stay up: a wing on a
 * big pack is an hour of flying and this is minutes, because holding a
 * quadcopter in the air costs power every second it is there.
 */
export const CA35_160_UAV: Uav = {
  id: "ca35-160",
  summary: "160 mm quadcopter, 293 g, 130 km/h, six minutes of it",
  config: CA35_160,
  dryMassKg: 0.135,
  // Racing rates. A quadcopter of this size will do the better part of a
  // thousand degrees a second and is flown that way; delivering it on a wing's
  // rates would make a 293 g aircraft feel like a 2.7 kg one.
  defaultRates: {
    rollRate: 720,
    pitchRate: 660,
    rollExpo: 0.3,
    pitchExpo: 0.3,
  },
  // Bare carbon with a bright arm, which is what nearly every one of these
  // looks like and the only way to tell which way it is pointing at range.
  defaultLivery: { shell: "#1d1f23", accent: "#37d3e8" },
  motors: CA35_MOTORS,
  batteries: CA35_BATTERIES,
  defaultMotorId: "p1604-3800-3.5x2.5",
  defaultBatteryId: "4s-750",
};

/**
 * The Foamie Glider 480: the toy in the hangar, and it is not a toy to fly.
 *
 * The smallest, lightest and slowest aircraft here by a distance, and the only
 * one that is genuinely a glider: shut the motors down on it and it does not
 * come down, it goes somewhere. It stalls at a walking pace and recovers by
 * itself, it climbs at a slope no wing here can hold, and it turns inside
 * anything with wings on it — but it is 141 g in a sky that has weather in it,
 * and a gust that a 2.7 kg survey wing rides through will put this on its
 * back. Flying it well is flying the air rather than the aircraft.
 */
export const FOAM_GLIDER_UAV: Uav = {
  id: "foam-glider",
  summary: "480 mm foam glider, 141 g, 94 km/h, ten minutes of it",
  config: FOAM_GLIDER,
  // The moulding with the nose weight dug out, two servos, an AIO board, a
  // receiver and a camera. The motors and the pack are added back by whatever
  // is fitted, and on an airframe this light both of them matter.
  dryMassKg: 0.086,
  // Livelier than a wing and nothing like a quadcopter: full-span surfaces on
  // a 480 mm span will roll it quickly, and the tail means it stops where it
  // is put rather than carrying on round.
  defaultRates: {
    rollRate: 300,
    pitchRate: 120,
    rollExpo: 0.2,
    pitchExpo: 0.2,
  },
  // The foam it is moulded in: blue, flecked with orange, exactly as the
  // photograph. Repainting it is two colours away, like every other airframe.
  defaultLivery: { shell: "#2a4bc8", accent: "#f08a1e" },
  motors: GLIDER_MOTORS,
  batteries: GLIDER_BATTERIES,
  defaultMotorId: "ex1202.5-6000-2.5x2.5",
  defaultBatteryId: "2s-720",
};

/**
 * The X10 Interceptor: the rocket in the hangar.
 *
 * The second airframe here that is not a wing, and it is not the first one
 * either. It flies on the same equations as the quadcopter — no lift, no
 * stall, no glide, and steered entirely by its own rotors — but everything
 * those equations are handed is different. It is a slender body lying along
 * the rotor axis rather than a plate hanging under one, so leaning over points
 * it into the airflow instead of turning it broadside, and that is worth three
 * times a racing quad's top speed on four-inch propellers. It has a rocket's
 * inertia rather than a quad's, so it pitches and rolls deliberately and spins
 * about its own axis as readily as it rolls. And it has fins, which is the only
 * thing in the hangar with any weathercock stability that is not a wing.
 *
 * What it costs is everything a quadcopter is otherwise good at. It is
 * unhappy slowly, it is blown about in a hover, it will not turn inside
 * anything, and full throttle empties the pack in well under a minute. It is
 * an aircraft for arriving somewhere quickly, once.
 */
export const X10_INTERCEPTOR_UAV: Uav = {
  id: "x10-interceptor",
  summary: "560 mm rocket quad, 450 g, 364 km/h, ten minutes of it",
  config: X10_INTERCEPTOR,
  // The moulded body, the fins, the pylons, the stack, the camera and the
  // video transmitter. The motors and the pack are added back by whatever is
  // fitted, and on this airframe the pack is nearly half the aircraft.
  dryMassKg: 0.151,
  // Between a wing's rates and a quadcopter's, and the same about both axes,
  // because on a body of revolution they are the same axis twice: there is no
  // sense in which this one rolls more readily than it pitches. Ask it for a
  // racing quad's seven hundred degrees a second and twenty-five times the
  // inertia simply will not answer.
  defaultRates: {
    rollRate: 400,
    pitchRate: 400,
    rollExpo: 0.25,
    pitchExpo: 0.25,
  },
  // Matte black with red motor bells, which is how it is photographed and how
  // every one of them is delivered.
  defaultLivery: { shell: "#17181c", accent: "#c8102e" },
  motors: X10_MOTORS,
  batteries: X10_BATTERIES,
  defaultMotorId: "sr2306-2450-4.2x7",
  defaultBatteryId: "6s-1100",
};

/**
 * The FT Triplane XL: the aeroplane in the hangar that is not a UAV.
 *
 * Everything else here was designed to do a job — survey a field, race a gate,
 * intercept something, carry a camera for four hours. This was designed to be
 * flown, and it is a hundred and ten years old: Flite Test's Fokker Dr.I in
 * foam board, three wings on struts, a skid on the back, and a repertoire that
 * stops at the loop, the roll, the hammerhead and the spin because that is
 * what there was in 1917.
 *
 * It is also the slowest and the most heavily winged thing in the simulator.
 * Fifty-six kilometres an hour flat out is well under two thirds of what the
 * 141 g foam glider will do and a sixth of the X10; it stalls at twenty-four,
 * which is a brisk walk; and it will not be flown anywhere in a hurry. What it
 * does instead is fly at all in places nothing else here can — it is off the
 * ground in a dozen metres and down again in as few, and on the lightest wing
 * loading in the hangar a gust is something to be enjoyed rather than
 * survived.
 *
 * The other thing that is new is the undercarriage. There are aeroplanes here
 * on wheels already, but a Skyeye is a tricycle and this is a taildragger: it
 * sits back on its skid with the wing at twelve degrees, which is nearly all
 * the incidence it has. So it does not rotate off a runway — it reaches the
 * speed at which it is already flying and goes, and the elevator's job on the
 * ground is to hold the tail down rather than to lift the nose.
 */
export const FT_TRIPLANE_XL_UAV: Uav = {
  id: "ft-triplane-xl",
  summary: "1.23 m foam triplane, 1.76 kg, 56 km/h, and it lands anywhere",
  config: FT_TRIPLANE_XL,
  // The kit at its published 1429 g without a pack, less the motor, plus the
  // pan-and-tilt FPV mount, camera and video transmitter that make it one of
  // these rather than a line-of-sight aeroplane. The motor and the pack are
  // added back by whatever is fitted.
  dryMassKg: 1.4,
  // A scale roll rate, and it is the airframe's rather than a preference:
  // ailerons on one wing out of three, on a span shorter than the
  // interceptor's, will not produce more. Pitch is the other half of the
  // aeroplane and gets rather more of the stick, because a triplane loops in
  // its own length.
  defaultRates: {
    rollRate: 140,
    pitchRate: 85,
    rollExpo: 0.3,
    pitchExpo: 0.3,
  },
  // Red, with a linen cowl and struts. Flite Test sell it as the Red Baron
  // flying again and there is no second scheme anybody builds one in.
  defaultLivery: { shell: "#a8161d", accent: "#e6dcc3" },
  motors: TRIPLANE_MOTORS,
  batteries: TRIPLANE_BATTERIES,
  defaultMotorId: "ft2814-1100-12x4.5",
  defaultBatteryId: "3s-3300",
};

/**
 * The FT P-38 Lightning: the first aeroplane here with two of anything.
 *
 * Flite Test's Master Series P-38 in water-resistant foam board, 57.5 inches
 * across, and the only twin in the hangar. Everything else here has one motor
 * or four of them arranged in a circle; this has two, a fifth of the span out
 * on either side, turning opposite ways because the kit ships opposite-handed
 * blades and because that is what a Lightning does.
 *
 * It is the conventional aeroplane the hangar did not have. The interceptor and
 * the X8 are wings, the Dr.I is a barnstormer, the Skyeyes are working UAVs,
 * and this is a fighter: a taper-winged aeroplane on a warbird's loading, with
 * a tail on each of two booms, that is flown at a speed and turned rather than
 * parked at an attitude. Twenty-one ounces to the square foot is two and a half
 * times the triplane's, so it stalls at 34 km/h where that one stalls at 24,
 * and it wants a circuit flown round it.
 *
 * What the booms are worth is the way it tracks. Two fins on half a metre of
 * arm each give it the strongest weathervane in the hangar and the heaviest
 * damping in pitch, so it holds a line through rough air the way nothing else
 * here does — and it pays for it in roll, which is modest on purpose. The real
 * one had the same complaint until somebody fitted hydraulic ailerons to it.
 */
export const FT_P38_LIGHTNING_UAV: Uav = {
  id: "ft-p38-lightning",
  summary: "1.46 m foam twin, 1.75 kg, 89 km/h, and two of everything",
  config: FT_P38_LIGHTNING,
  // The airframe without its motors or a pack: the board and plywood in the
  // kit, the four nine-gram servos and the 30 cm extensions the booms need, a
  // receiver, and the pan-and-tilt camera and video transmitter that make it
  // one of these rather than a line-of-sight warbird. Flite Test do not publish
  // a weight for this airframe, so it is built up from what goes into one. The
  // motors, their controllers and the pack are added back by whatever is
  // fitted.
  dryMassKg: 1.25,
  // A warbird's rates rather than a wing's. Roll is what the airframe will
  // actually give — outboard ailerons on a 1.46 m span, and they are the one
  // thing a P-38 was ever criticised for — and pitch is where the aeroplane
  // is: two long booms damp it, so the stick can be given rather more of it
  // without the aircraft feeling nervous.
  defaultRates: {
    rollRate: 190,
    pitchRate: 95,
    rollExpo: 0.2,
    pitchExpo: 0.25,
  },
  // Olive drab over the identification bands the Eighth Air Force painted on
  // their booms and tails, which is the scheme the kit is built in and the one
  // that makes a twin-boom aeroplane readable end-on.
  defaultLivery: { shell: "#4d5340", accent: "#e8e4d6" },
  motors: P38_MOTORS,
  batteries: P38_BATTERIES,
  defaultMotorId: "radial2218-1180-9x4.5",
  defaultBatteryId: "4s-2300",
};


/**
 * The FT Baby Blender: the smallest aeroplane here, and the most over-powered.
 *
 * Flite Test's four-channel biplane, 610 mm across and 567 g, and the fourth
 * aeroplane in the Swappable Series — which means the whole nose of it slides
 * out: the motor, the controller and the pack live in a foam board pod that is
 * shared with every other swappable Flite Test have drawn, and the airframe is
 * what is left when you pull it.
 *
 * It is the aeroplane the hangar had nothing like. The wings and the UAVs are
 * flown somewhere; the triplane is flown slowly; this is flown *at* something,
 * and then flown out of it upside down. Nine and a half ounces to the square
 * foot means it stalls at 27 km/h and a 10x4.5 on three cells means it will
 * not do much over 64, so the whole of the envelope fits inside a park — and
 * inside that envelope it has two and three quarter times its own weight in
 * thrust, which is more than anything else in the simulator that is not a
 * multirotor. What that buys is the vertical: it goes up until the pilot stops
 * asking, and it will hang on the propeller at an attitude the flying wings
 * fall out of.
 *
 * The second thing it is, is the first biplane. Two wings a 99 mm gap apart
 * are not one wing of twice the area — the pair interfere, and interfering is
 * the point: they shed a quarter less vortex between them than a single wing
 * carrying the same lift on the same span would, which is the entire reason
 * anybody stacked wings. What it costs is a cell of aspect ratio 1.9, the
 * stubbiest shape here, and a top speed that a 141 g toy glider beats.
 */
export const FT_BABY_BLENDER_UAV: Uav = {
  id: "ft-baby-blender",
  summary: "0.61 m foam biplane, 567 g, 64 km/h, and it goes straight up",
  config: FT_BABY_BLENDER,
  // The kit at its published 14 oz without a pack, less the motor, controller
  // and blade, plus the micro camera and video transmitter that make it one of
  // these rather than a line-of-sight park aeroplane. Twenty grams of FPV gear
  // is a lot on an airframe this size and it is deliberately the lightest
  // installation in the hangar. The power pod's contents and the pack are
  // added back by whatever is fitted.
  dryMassKg: 0.3,
  // Aerobatic rates, and the kit's own expo: Flite Test set one of these up
  // with 30% on both sticks. The rates themselves are the kit's two throws put
  // where a transmitter setting belongs — the airframe's coefficients carry the
  // full thirty degrees, and these ask for about what the low rate would give
  // in roll and rather more than it in pitch, because a biplane that loops in
  // its own length wants the elevator.
  defaultRates: {
    rollRate: 360,
    pitchRate: 160,
    rollExpo: 0.3,
    pitchExpo: 0.3,
  },
  // Bare white water-resistant board with a red cowl and struts, which is how
  // the kit photographs and roughly what every one of them ends up as once the
  // decal sheet is on.
  defaultLivery: { shell: "#eceae4", accent: "#c8322c" },
  motors: BABY_BLENDER_MOTORS,
  batteries: BABY_BLENDER_BATTERIES,
  defaultMotorId: "radial2218-1180-10x4.5",
  defaultBatteryId: "3s-1800",
};

/**
 * The Skyeye series: five aeroplanes, and the only ones here with engines.
 *
 * They are one entry each rather than one entry with a size on it, because the
 * five are five airframes: they share a shape and a way of being flown and
 * nothing else. A 2600 is fifteen kilos and lands in a field; a 6000 is a
 * hundred and fifteen and needs a runway and a van to get to it. What they have
 * in common is what separates all of them from everything else in this hangar —
 * a petrol engine that idles rather than stops, wheels rather than a belly, and
 * hours rather than minutes.
 *
 * The rates go down as the aeroplanes go up, and they are not a preference: ask
 * a 6000 for the interceptor's 360 degrees a second and forty times the roll
 * inertia will simply not answer. What is set here is close to what each
 * airframe will actually produce at its own cruise, so full stick is a real
 * command rather than an aspiration.
 */

/**
 * The Skyeye 2600: the small one, and the one to learn the series on.
 *
 * It is the only Skyeye that behaves at all like the rest of the hangar — light
 * enough to be thrown about a little, quick enough to be interesting, and small
 * enough to be flown off grass. Everything that makes the series what it is is
 * already here in miniature: the engine idling on the runway, the roll and the
 * rotation, and two and a half hours of fuel, which is fifteen times what the
 * quadcopter beside it has.
 */
export const SKYEYE_2600_UAV: Uav = {
  id: "skyeye-2600",
  summary: "2.6 m petrol UAV, 15 kg, 93 km/h, two and a half hours",
  config: SKYEYE_2600,
  // The carbon airframe at its published 6.5 kg empty, plus the servos, the
  // autopilot, the radios and a light survey payload in the nose. The engine
  // and the tank are added back by whatever is fitted.
  dryMassKg: 8.4,
  defaultRates: {
    rollRate: 150,
    pitchRate: 70,
    rollExpo: 0.2,
    pitchExpo: 0.25,
  },
  // Unpainted carbon with a high-visibility wing: what a survey platform
  // actually looks like on a strip, and the only way to tell which way it is
  // pointing at two kilometres.
  defaultLivery: { shell: "#20232a", accent: "#ff8a1e" },
  motors: SKYEYE_2600_ENGINES,
  batteries: SKYEYE_2600_TANKS,
  defaultMotorId: "dle20-16x11",
  defaultBatteryId: "tank-5",
};

/**
 * The Skyeye 3200: the workhorse, and the heaviest airframe for its size.
 *
 * Wood and fibreglass rather than carbon, sold as a bare kit and flown by more
 * people than the rest of the series together. It carries the least of its
 * weight as anything useful and stays up for three hours where the lighter 3600
 * beside it manages four and a half — and it costs a fraction of it, which is
 * the entire argument for one.
 */
export const SKYEYE_3200_UAV: Uav = {
  id: "skyeye-3200",
  summary: "3.2 m petrol UAV, 25 kg, 108 km/h, three hours",
  config: SKYEYE_3200,
  dryMassKg: 14.6,
  defaultRates: {
    rollRate: 120,
    pitchRate: 60,
    rollExpo: 0.2,
    pitchExpo: 0.25,
  },
  // White glass with a red tail, which is how the kit arrives and how nearly
  // every one of them is still flying.
  defaultLivery: { shell: "#eceae4", accent: "#c8332b" },
  motors: SKYEYE_3200_ENGINES,
  batteries: SKYEYE_3200_TANKS,
  defaultMotorId: "dle55-20x12",
  defaultBatteryId: "tank-6",
};

/**
 * The Skyeye 3600: the long-endurance one, and the best aeroplane of the five.
 *
 * Lighter than the 3200 on a longer wing and carrying the same payload, with
 * eleven and a half litres built into the fuselage. Four and a half hours in
 * the air — longer than every electric airframe in this hangar added together —
 * and it will spend all of them holding a camera steady over the same valley
 * and then come back and land on its wheels.
 */
export const SKYEYE_3600_UAV: Uav = {
  id: "skyeye-3600",
  summary: "3.6 m petrol UAV, 30 kg, 119 km/h, four and a half hours",
  config: SKYEYE_3600,
  dryMassKg: 14,
  defaultRates: {
    rollRate: 110,
    pitchRate: 55,
    rollExpo: 0.2,
    pitchExpo: 0.25,
  },
  // Grey over white: the surveillance scheme, and hard to see against cloud
  // from below, which is rather the point of one of these.
  defaultLivery: { shell: "#b9bfc6", accent: "#1f3550" },
  motors: SKYEYE_3600_ENGINES,
  batteries: SKYEYE_3600_TANKS,
  defaultMotorId: "da100-22x13",
  defaultBatteryId: "tank-11.5",
};

/**
 * The Skyeye 5000: the heavy one, and the first that is not a model aeroplane.
 *
 * Sixty-six kilos with a full tank, an inverted V-tail, disc brakes on the
 * wheels and eight hours of fuel. It has the best glide of the five and a
 * hundred and twelve times a Skywalker X8's roll inertia, so it goes exactly
 * where it is pointed and takes its time getting there. Flying one is deciding
 * early and then waiting.
 */
export const SKYEYE_5000_UAV: Uav = {
  id: "skyeye-5000",
  summary: "5 m petrol UAV, 90 kg, 115 km/h, eight hours",
  config: SKYEYE_5000,
  dryMassKg: 36,
  defaultRates: {
    rollRate: 80,
    pitchRate: 45,
    rollExpo: 0.25,
    pitchExpo: 0.3,
  },
  // Maritime grey with an orange tail: a cargo and coastal-patrol airframe,
  // painted so it can be found again on the water.
  defaultLivery: { shell: "#6d7681", accent: "#ff6a13" },
  motors: SKYEYE_5000_ENGINES,
  batteries: SKYEYE_5000_TANKS,
  defaultMotorId: "da150-26x14",
  defaultBatteryId: "tank-28",
};

/**
 * The Skyeye 6000: the flagship, and the largest aircraft in the hangar.
 *
 * Six metres of wing and ten hours of injected endurance, on the same tank the
 * 5000 empties in eight — the whole argument for fuel injection, made in litres
 * per hour rather than claimed. It has more roll inertia than everything else
 * in this hangar combined, and a turn on it is something a pilot begins and
 * then waits for. Flown as what it is, it is the most capable airframe here.
 */
export const SKYEYE_6000_UAV: Uav = {
  id: "skyeye-6000",
  summary: "6 m petrol UAV, 115 kg, 131 km/h, nine hours",
  config: SKYEYE_6000,
  dryMassKg: 39,
  defaultRates: {
    rollRate: 70,
    pitchRate: 40,
    rollExpo: 0.25,
    pitchExpo: 0.3,
  },
  // The long-range logistics scheme: white with a blue flash, because at this
  // size it is an aeroplane sharing airspace rather than a model.
  defaultLivery: { shell: "#f2f3f5", accent: "#1b6ac9" },
  motors: SKYEYE_6000_ENGINES,
  batteries: SKYEYE_6000_TANKS,
  defaultMotorId: "sp180efi-28x16",
  defaultBatteryId: "tank-28",
};

export const UAVS: readonly Uav[] = [
  INTERCEPTOR_WING,
  SKYWALKER_X8_UAV,
  FOAM_GLIDER_UAV,
  FT_TRIPLANE_XL_UAV,
  FT_P38_LIGHTNING_UAV,
  FT_BABY_BLENDER_UAV,
  CA35_160_UAV,
  X10_INTERCEPTOR_UAV,
  SKYEYE_2600_UAV,
  SKYEYE_3200_UAV,
  SKYEYE_3600_UAV,
  SKYEYE_5000_UAV,
  SKYEYE_6000_UAV,
];

export const DEFAULT_UAV_ID = INTERCEPTOR_WING.id;

/** The UAV with that id, or null when nothing in the hangar answers to it. */
export function findUav(id: string): Uav | null {
  return UAVS.find((uav) => uav.id === id) ?? null;
}

/** The UAV with that id, falling back to the default rather than failing. */
export function uavOrDefault(id: string | null | undefined): Uav {
  return (id ? findUav(id) : null) ?? INTERCEPTOR_WING;
}

/** The combo with that id on that airframe, or its delivered one. */
export function motorOrDefault(uav: Uav, id: string | null | undefined): MotorSpec {
  const found = id ? uav.motors.find((motor) => motor.id === id) : null;
  return found ?? deliveredMotor(uav);
}

/** The combo an airframe is delivered with. */
export function deliveredMotor(uav: Uav): MotorSpec {
  const motor =
    uav.motors.find((entry) => entry.id === uav.defaultMotorId) ??
    uav.motors[0];
  if (!motor) throw new Error(`${uav.id} has no power system`);
  return motor;
}

/** The pack an airframe is delivered with. */
export function deliveredBattery(uav: Uav): BatterySpec {
  const battery =
    uav.batteries.find((entry) => entry.id === uav.defaultBatteryId) ??
    uav.batteries[0];
  if (!battery) throw new Error(`${uav.id} has no battery`);
  return battery;
}

/** The packs that will run a given combo, in catalogue order. */
export function batteriesFor(uav: Uav, motor: MotorSpec): readonly BatterySpec[] {
  return uav.batteries.filter((battery) => fitsMotor(motor, battery));
}

/**
 * The pack the loadout is flown on, or null when range is not simulated.
 *
 * A pack whose cell count the combo cannot run is not flown on: switching to a
 * 4S motor with a 6S pack selected fits the first pack that combo will take
 * rather than pretending the old one is still in the bay.
 */
export function batteryFor(
  uav: Uav,
  motor: MotorSpec,
  id: string | null | undefined,
): BatterySpec | null {
  if (id === BATTERY_UNLIMITED) return null;
  const fitting = batteriesFor(uav, motor);
  const found = id ? fitting.find((battery) => battery.id === id) : null;
  if (found) return found;
  const delivered = deliveredBattery(uav);
  return fitsMotor(motor, delivered) ? delivered : (fitting[0] ?? null);
}

// --- Settings ---------------------------------------------------------------

/** Which power system one airframe is set up with. */
export interface PowerLoadout {
  readonly motor: string;
  /** A pack id, or `BATTERY_UNLIMITED` to fly without one being simulated. */
  readonly battery: string;
}

/**
 * Which UAV is being flown, and how every one of them is set up.
 *
 * Rates and loadouts are kept for aircraft that are not currently selected:
 * switching to another airframe and back finds the tune and the hardware where
 * they were left, which is the whole point of storing them per UAV.
 */
export interface UavSettings {
  readonly active: string;
  readonly rates: Readonly<Record<string, ControlRates>>;
  readonly power: Readonly<Record<string, PowerLoadout>>;
  /** How each airframe is painted. Kept per aircraft, like the rest of this. */
  readonly livery: Readonly<Record<string, Livery>>;
}

function defaultRates(): Record<string, ControlRates> {
  const rates: Record<string, ControlRates> = {};
  for (const uav of UAVS) rates[uav.id] = uav.defaultRates;
  return rates;
}

function defaultLiveries(): Record<string, Livery> {
  const livery: Record<string, Livery> = {};
  for (const uav of UAVS) livery[uav.id] = uav.defaultLivery;
  return livery;
}

function defaultPower(): Record<string, PowerLoadout> {
  const power: Record<string, PowerLoadout> = {};
  for (const uav of UAVS) {
    power[uav.id] = {
      motor: deliveredMotor(uav).id,
      battery: deliveredBattery(uav).id,
    };
  }
  return power;
}

export const DEFAULT_UAV_SETTINGS: UavSettings = {
  active: DEFAULT_UAV_ID,
  rates: defaultRates(),
  power: defaultPower(),
  livery: defaultLiveries(),
};

/**
 * Repairs UAV settings loaded from storage.
 *
 * Settings outlive the version of the simulator that wrote them: a tune or a
 * loadout stored against an airframe that has since been removed is dropped,
 * an airframe added since gets its own defaults, hardware nobody sells any
 * more falls back to what the airframe is delivered with, and every number is
 * clamped on the way through rather than reaching the flight controller.
 */
export function normaliseUavSettings(stored: unknown): UavSettings {
  const raw = (stored ?? {}) as Partial<Record<keyof UavSettings, unknown>>;
  const storedRates = (raw.rates ?? {}) as Record<string, unknown>;
  const storedPower = (raw.power ?? {}) as Record<string, unknown>;
  const storedLivery = (raw.livery ?? {}) as Record<string, unknown>;

  const rates: Record<string, ControlRates> = {};
  const power: Record<string, PowerLoadout> = {};
  const livery: Record<string, Livery> = {};
  for (const uav of UAVS) {
    rates[uav.id] = normaliseRates(storedRates[uav.id], uav.defaultRates);
    power[uav.id] = normaliseLoadout(uav, storedPower[uav.id]);
    livery[uav.id] = normaliseLivery(storedLivery[uav.id], uav.defaultLivery);
  }

  return {
    active:
      typeof raw.active === "string" && findUav(raw.active)
        ? raw.active
        : DEFAULT_UAV_ID,
    rates,
    power,
    livery,
  };
}

function normaliseLoadout(uav: Uav, stored: unknown): PowerLoadout {
  const raw = (stored ?? {}) as Partial<Record<keyof PowerLoadout, unknown>>;
  const motor = motorOrDefault(
    uav,
    typeof raw.motor === "string" ? raw.motor : null,
  );
  if (raw.battery === BATTERY_UNLIMITED) {
    return { motor: motor.id, battery: BATTERY_UNLIMITED };
  }
  const battery = batteryFor(
    uav,
    motor,
    typeof raw.battery === "string" ? raw.battery : null,
  );
  return {
    motor: motor.id,
    battery: battery ? battery.id : BATTERY_UNLIMITED,
  };
}

/** The rates one UAV is set up on, whatever the stored table is missing. */
export function ratesFor(settings: UavSettings, id: string): ControlRates {
  return settings.rates[id] ?? uavOrDefault(id).defaultRates;
}

/** The rates the aircraft currently selected is flown on. */
export function activeRates(settings: UavSettings): ControlRates {
  return ratesFor(settings, settings.active);
}

/** The colours one UAV is painted in, whatever the stored table is missing. */
export function liveryFor(settings: UavSettings, id: string): Livery {
  return normaliseLivery(settings.livery?.[id], uavOrDefault(id).defaultLivery);
}

/** The colours the aircraft currently selected is painted in. */
export function activeLivery(settings: UavSettings): Livery {
  return liveryFor(settings, settings.active);
}

/**
 * The same settings with one airframe repainted.
 *
 * A colour that cannot be read leaves that colour where it was rather than
 * reverting it: this is a live edit, and a value nobody can parse is a change
 * that was never made, not an instruction to strip the paint.
 */
export function withLivery(
  settings: UavSettings,
  id: string,
  change: Partial<Livery>,
): UavSettings {
  const uav = uavOrDefault(id);
  const current = liveryFor(settings, uav.id);
  return {
    ...settings,
    livery: {
      ...settings.livery,
      [uav.id]: normaliseLivery({ ...current, ...change }, current),
    },
  };
}

/** The loadout one UAV is set up with, repaired against the catalogue. */
export function loadoutFor(settings: UavSettings, id: string): PowerLoadout {
  return normaliseLoadout(uavOrDefault(id), settings.power[id]);
}

/**
 * The same settings with a different combo on one airframe.
 *
 * Changing the motor can change what the bay will run: a 4S combo cannot be
 * flown on the 6S pack that was in it, so the pack moves with the motor rather
 * than leaving the hangar holding a setup that does not exist.
 */
export function withMotor(
  settings: UavSettings,
  id: string,
  motorId: string,
): UavSettings {
  const uav = uavOrDefault(id);
  const current = loadoutFor(settings, id);
  return {
    ...settings,
    power: {
      ...settings.power,
      [uav.id]: normaliseLoadout(uav, {
        motor: motorId,
        battery: current.battery,
      }),
    },
  };
}

/** The same settings with a different pack on one airframe. */
export function withBattery(
  settings: UavSettings,
  id: string,
  batteryId: string,
): UavSettings {
  const uav = uavOrDefault(id);
  const current = loadoutFor(settings, id);
  return {
    ...settings,
    power: {
      ...settings.power,
      [uav.id]: normaliseLoadout(uav, {
        motor: current.motor,
        battery: batteryId,
      }),
    },
  };
}

// --- Fitting ----------------------------------------------------------------

/** An airframe with a particular power system in it. */
export interface UavLoadout {
  readonly uav: Uav;
  readonly motor: MotorSpec;
  /** The pack aboard, or null when the flight is flown without a range limit. */
  readonly battery: BatterySpec | null;
  /** The airframe as it flies with that hardware fitted. */
  readonly config: AircraftConfig;
}

/**
 * Works one airframe out from the hardware in it.
 *
 * An unlimited flight still carries the delivered pack's weight: taking the
 * range limit off is a decision about how long the flight is, not a licence to
 * fly an airframe two kilos lighter than the one in the hangar.
 */
export function resolveLoadout(
  uav: Uav,
  loadout: PowerLoadout | null | undefined,
): UavLoadout {
  const motor = motorOrDefault(uav, loadout?.motor);
  const battery = batteryFor(uav, motor, loadout?.battery ?? null);
  const ballast = battery ?? deliveredBattery(uav);
  return {
    uav,
    motor,
    battery,
    config: fitPowerplant(uav.config, uav.dryMassKg, motor, ballast),
  };
}

/** The loadout the aircraft currently selected is set up with. */
export function activeLoadout(settings: UavSettings): UavLoadout {
  const uav = uavOrDefault(settings.active);
  return resolveLoadout(uav, loadoutFor(settings, uav.id));
}
