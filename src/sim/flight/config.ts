/**
 * Aerodynamic and propulsion configuration for the aircraft in the hangar.
 *
 * The wing numbers describe a foam delta in the class of the airframe in
 * `FPV.png`: roughly 1.4 m span, 2.2 kg all-up with battery and FPV gear,
 * cruising near 80 km/h and topping out around 95 km/h in level flight.
 *
 * Everything is data so enemies, difficulty tiers and future airframes can
 * share one flight model with different characteristics — and an airframe that
 * is not a wing at all says so by carrying a `rotor` block, which is what
 * sends it to the multirotor model instead.
 *
 * Two fields further down say something else an airframe can be. `idleThrust`
 * is an engine rather than a motor: thrust with the stick shut, which no
 * electric aircraft has and which is most of what makes one of these fly
 * differently. `undercarriage` is wheels rather than a belly, which is what
 * lets one start on a runway rather than in somebody's hand. Together they are
 * the difference between a model aeroplane and an aeroplane, and the flight
 * model reads them both without knowing which airframe it is flying.
 */

/**
 * What makes an airframe a multirotor rather than a wing.
 *
 * A quadcopter is not a wing with the numbers changed. It makes no lift at
 * all: the rotors point up, the whole aircraft leans over to go somewhere, and
 * what stops it is bluff-body drag rather than a polar. So the fields a wing is
 * described by — the lift curve, the stall, the moment derivatives — have
 * nothing to say about one, and this block replaces them.
 *
 * An `AircraftConfig` carrying one is flown by `multirotor.ts`; the wing fields
 * on it are left at zero and nothing reads them. Everything the two airframes
 * genuinely share stays where it was: the mass, the inertia, the propeller's
 * static thrust and pitch speed, and the pack behind them.
 */
export interface RotorConfig {
  /** Rotors on the airframe. */
  readonly count: number;
  /** Distance from the centre of gravity to a rotor hub, metres. */
  readonly armLength: number;
  /**
   * Drag area across the airframe, `Cd * A` in m^2.
   *
   * What the air meets arriving on the nose or on a side: on a quadcopter the
   * stack, the arms and the pack, edge-on.
   */
  readonly frontalArea: number;
  /**
   * Drag area along the rotor axis, `Cd * A` in m^2.
   *
   * Which of these two is the bigger is the whole of what shape a multirotor
   * is. On a quadcopter it is this one, and it is what decides the top speed:
   * one doing 130 km/h is leaning over sixty-odd degrees, so it is meeting the
   * air belly-first rather than nose-first. On an airframe built *along* the
   * rotor axis instead — the X10 — it is the small one by a factor of eight,
   * because leaning that one over points it into the airflow rather than
   * turning it broadside, and that is the entire reason it is fast.
   */
  readonly axialArea: number;
  /**
   * Roll torque at full stick, as a fraction of `maxThrust * armLength`.
   *
   * Control on a multirotor is differential thrust and nothing else, so the
   * authority it has is the thrust it has: a flat pack rolls lazily, and a
   * dead one does not roll at all. About a third is what an X layout can
   * actually produce once the mixer has kept every motor inside its range.
   */
  readonly rollAuthority: number;
  /** The same about the pitch axis. */
  readonly pitchAuthority: number;
  /**
   * The same about the yaw axis.
   *
   * An order of magnitude weaker: yaw comes from the reaction torque of
   * speeding two rotors up and slowing the other two, not from thrust on an
   * arm, which is why a quadcopter rolls far faster than it spins.
   */
  readonly yawAuthority: number;
  /** Rate damping about the roll axis, N m per rad/s. */
  readonly rollDamping: number;
  readonly pitchDamping: number;
  readonly yawDamping: number;
  /**
   * Throttle at which the mixer has full differential authority, 0..1.
   *
   * Below it the rotors are running too slowly to be pushed apart much, which
   * is exactly why a quadcopter at idle in the air falls out of the sky
   * sideways instead of rolling level.
   */
  readonly authorityThrottle: number;
  /**
   * Fraction of the top speed a multirotor is actually flown between places.
   *
   * Far lower than a wing's, and not a matter of taste: a quadcopter's drag
   * goes up with the square of the speed while a wing's barely moves, so the
   * last quarter of a quad's speed range costs most of its pack. Somewhere
   * around half is where a pilot who wants to still be flying in five minutes
   * leaves it — and lower still on an airframe whose top speed and whose
   * economical speed are as far apart as an interceptor's.
   */
  readonly cruiseFraction: number;
  /** Steepest lean the assisted modes will command, degrees. */
  readonly maxTiltDeg: number;
  /**
   * Where the airframe's drag acts, metres along the rotor axis from the
   * centre of gravity. Positive is above it.
   *
   * A quadcopter is not a shuttlecock: the pack is strapped on top of the plate
   * and the arms, the props and the camera hang around and under it, so the air
   * pushes below the weight. That is a hair's breadth of offset and it is the
   * whole reason a dead one does not fall the way it was left — the turning
   * rotors absorb it without the pilot ever knowing it is there, and with them
   * stopped there is nothing absorbing it, so the aircraft leans, the lean lets
   * the air push harder, and it goes over.
   *
   * An airframe with fins on it *is* a shuttlecock, and the same number says so:
   * the couple always swings the end the air is arriving at upwind, which tips a
   * belly-first quadcopter further over and points a nose-first rocket at its
   * own flight path.
   */
  readonly dragCentreOffset: number;
}

export interface AircraftConfig {
  readonly name: string;

  // --- Mass and inertia -----------------------------------------------------
  /** All-up mass in kilograms. */
  readonly mass: number;
  /** Roll inertia about the body forward axis, kg m^2. */
  readonly inertiaRoll: number;
  /** Pitch inertia about the body left axis, kg m^2. */
  readonly inertiaPitch: number;
  /** Yaw inertia about the body up axis, kg m^2. */
  readonly inertiaYaw: number;

  // --- Geometry -------------------------------------------------------------
  /** Reference wing area, m^2. */
  readonly wingArea: number;
  /** Wing span, m. */
  readonly wingSpan: number;
  /** Mean aerodynamic chord, m. */
  readonly chord: number;
  /**
   * Radius at which two aircraft are treated as having touched, metres.
   *
   * A little wider than the airframe's own half-span: a wing is not a sphere,
   * and the extra covers the propeller arc and the parts of a pass that a
   * single radius cannot describe. What the contact then *costs* is the damage
   * model's business, and whether a charge goes off is the mission's.
   */
  readonly collisionRadius: number;

  // --- Propulsion -----------------------------------------------------------
  /** Static thrust at full throttle, newtons. */
  readonly maxThrust: number;
  /**
   * Airspeed at which the propeller stops producing thrust, m/s. Thrust falls
   * off linearly toward this speed, which is what keeps level-flight top speed
   * bounded without inventing extra drag.
   */
  readonly propPitchSpeed: number;
  /** Throttle units per second while the throttle key is held. */
  readonly throttleRate: number;
  /** Time constant of the motor spooling up or down, seconds. */
  readonly throttleLag: number;
  /**
   * Thrust with the throttle shut, as a fraction of `maxThrust`. Left out, none.
   *
   * The whole of what separates an aeroplane with an engine on it from one with
   * a motor. An electric aircraft with the stick down is a glider: the
   * propeller stops and the only thing still acting on the airframe is the air.
   * A petrol engine with the stick down is *still running* — it idles, it turns
   * the propeller, and it goes on pushing the aeroplane along.
   *
   * Everything a pilot notices about flying one follows from this number rather
   * than from anything written specially: it will not slow down on the approach
   * the way a wing does, it sits on a runway a hair short of rolling away under
   * its own power — the wheels rather than a brake are what hold it — and it is
   * the reason it can be started standing there and flown off rather than
   * having to be thrown. Worked out from the engine's own idle by
   * `fitPowerplant`, not chosen.
   */
  readonly idleThrust?: number;

  // --- Lift -----------------------------------------------------------------
  /** Lift coefficient at zero angle of attack (reflex airfoil). */
  readonly cl0: number;
  /** Lift-curve slope, per radian. */
  readonly clAlpha: number;
  /** Angle of attack where the wing stalls, radians. */
  readonly stallAngle: number;
  /** Width of the post-stall blend, radians. */
  readonly stallBlend: number;

  // --- Drag -----------------------------------------------------------------
  /** Parasitic drag coefficient. */
  readonly cd0: number;
  /** Induced drag factor, `1 / (pi * AR * e)`. */
  readonly inducedDragFactor: number;

  // --- Side force -----------------------------------------------------------
  /** Side force per radian of sideslip. */
  readonly cyBeta: number;

  // --- Pitch moment ---------------------------------------------------------
  /** Zero-lift pitching moment (positive = nose up). */
  readonly cm0: number;
  /** Longitudinal static stability, per radian; must be negative. */
  readonly cmAlpha: number;
  /** Pitch damping, per radian of normalised pitch rate; must be negative. */
  readonly cmQ: number;
  /** Elevator (elevon) pitch authority at full deflection. */
  readonly cmElevator: number;

  // --- Roll moment ----------------------------------------------------------
  /** Aileron (elevon) roll authority at full deflection. */
  readonly clAileron: number;
  /** Roll damping; must be negative. */
  readonly clP: number;
  /** Dihedral effect: roll produced by sideslip. */
  readonly clBeta: number;

  // --- Yaw moment -----------------------------------------------------------
  /** Directional stability (weathervaning); must be positive. */
  readonly cnBeta: number;
  /** Yaw damping; must be negative. */
  readonly cnR: number;
  /** Yaw authority from differential drag / thrust at full deflection. */
  readonly cnRudder: number;
  /** Adverse yaw produced by roll input. */
  readonly cnAileron: number;

  // --- Limits ---------------------------------------------------------------
  /** Airspeed below which the airframe is treated as fully stalled, m/s. */
  readonly minControlSpeed: number;
  /** Structural airspeed limit used for warnings, m/s. */
  readonly neverExceedSpeed: number;

  // --- Rotorcraft -----------------------------------------------------------
  /**
   * Present only on multirotors, and what makes one.
   *
   * Every consumer that has to tell the two apart tests this one field, so
   * "is it a quadcopter" is a property of the airframe rather than a list of
   * ids kept somewhere else.
   */
  readonly rotor?: RotorConfig;

  // --- Undercarriage --------------------------------------------------------
  /**
   * True on an aircraft that has wheels under it. Left out, it has not.
   *
   * Every other wing here lands on its belly and is launched out of somebody's
   * hand, because that is what a foam wing with nothing underneath it does. An
   * aeroplane with an undercarriage is a different proposition on the ground in
   * three ways, and this one field is what the ground model, the touchdown
   * rules and the launch all read to know it: it rolls instead of scrubbing, so
   * it can be accelerated to flying speed under its own power; it sits nose-up
   * on its gear at a height the gear decides; and it survives arriving far
   * faster than a belly ever would, because wheels are what an aeroplane is
   * meant to arrive on.
   */
  readonly undercarriage?: boolean;

  // --- Looks ----------------------------------------------------------------
  /**
   * What the airframe looks like, when the flight model does not already say.
   *
   * Two aircraft can fly on the same equations and share nothing else: a swept
   * delta, a survey wing with a payload bay in the middle of it and a tailed
   * foam glider are one set of coefficients and three completely different
   * aeroplanes to look at, to sit behind and to listen to. Nothing in the
   * physics reads this — it picks the geometry the aircraft is drawn from, the
   * camera position that comes with it and the motor tone that belongs to it.
   * A wing that says nothing is the delta, and most multirotors need no entry
   * at all: the `rotor` block already says what one is. `rocket` is the
   * exception, and it earns the entry — a rotor block says an aircraft is
   * flown by the multirotor model, and it does not say the airframe hanging
   * under those rotors is a missile standing on its tail. `skyeye` is the
   * fuselage-and-booms UAV: a wing by its equations and an aeroplane to look
   * at, with a tail on the end of two tailbooms and wheels under it.
   */
  readonly shape?: "glider" | "x8" | "rocket" | "skyeye";
}

export const PLAYER_WING: AircraftConfig = {
  name: "FPV Interceptor Wing",

  mass: 2.2,
  inertiaRoll: 0.36,
  inertiaPitch: 0.05,
  inertiaYaw: 0.4,

  wingArea: 0.42,
  wingSpan: 1.4,
  chord: 0.3,
  collisionRadius: 1.5,

  maxThrust: 30,
  propPitchSpeed: 38,
  throttleRate: 0.8,
  throttleLag: 0.18,

  cl0: 0.05,
  clAlpha: 4.4,
  stallAngle: 0.209, // 12 degrees
  stallBlend: 0.14, // 8 degrees

  cd0: 0.045,
  inducedDragFactor: 0.08,

  cyBeta: -0.25,

  cm0: 0.007,
  cmAlpha: -0.35,
  cmQ: -12,
  cmElevator: 0.18,

  clAileron: 0.1,
  clP: -0.5,
  clBeta: -0.06,

  cnBeta: 0.04,
  cnR: -0.06,
  cnRudder: 0.03,
  cnAileron: -0.012,

  minControlSpeed: 4,
  neverExceedSpeed: 60,
} as const;

/**
 * The Skywalker X8: the 2.12 m survey wing, as it is actually sold.
 *
 * A different aircraft to fly rather than a bigger version of the same one.
 * Twice the span, three times the roll inertia and half again the wing area on
 * a third more weight, so it is slower, steadier, far harder to throw around,
 * and it stays up for as long as the pack in it will let it. The numbers are
 * the manufacturer's: 2120 mm span, 80 dm^2 of wing, 2.5-3.0 kg all up, and a
 * cruise of 65-70 km/h on the 12x6 it is normally flown behind — that last one
 * falls out of the propeller and the drag polar rather than being written down
 * here, which is what makes it worth checking in the tests.
 *
 * Like the interceptor, the mass, thrust and pitch speed describe the airframe
 * *as delivered*; fit another motor or another pack in the hangar and they are
 * worked out again from the hardware.
 */
export const SKYWALKER_X8: AircraftConfig = {
  name: "Skywalker X8",

  mass: 2.74,
  // Roughly the interceptor's inertia scaled by mass and by the square of the
  // span it is distributed over, which is what a wing's roll inertia is.
  inertiaRoll: 1.0,
  inertiaPitch: 0.12,
  inertiaYaw: 1.12,

  wingArea: 0.8,
  wingSpan: 2.12,
  chord: 0.42,
  collisionRadius: 2.2,

  maxThrust: 24.3,
  propPitchSpeed: 24,
  throttleRate: 0.8,
  throttleLag: 0.24,

  cl0: 0.06,
  // 2 pi AR / (AR + 2) at the X8's aspect ratio of 5.6, where the interceptor
  // sits at 4.7 — a longer wing makes more lift out of the same angle.
  clAlpha: 4.6,
  stallAngle: 0.21, // 12 degrees
  stallBlend: 0.14, // 8 degrees

  cd0: 0.035,
  inducedDragFactor: 0.071,

  cyBeta: -0.3,

  cm0: 0.008,
  cmAlpha: -0.4,
  cmQ: -14,
  cmElevator: 0.16,

  clAileron: 0.08,
  clP: -0.55,
  clBeta: -0.07,

  cnBeta: 0.05,
  cnR: -0.07,
  cnRudder: 0.03,
  cnAileron: -0.012,

  minControlSpeed: 5,
  neverExceedSpeed: 45,

  // Drawn as itself rather than as a big interceptor: the pod, the fins and
  // the planform are the airframe, and none of them are the delta's.
  shape: "x8",
} as const;

/**
 * The CarviFPV CA35-160: the 160 mm quadcopter, as it is actually sold.
 *
 * A different aircraft to fly rather than a smaller wing. It makes no lift, so
 * it does not stall, cannot glide, and falls out of the sky the moment the pack
 * gives up; it hovers, which no wing here can; and it goes where it goes by
 * leaning over, which is why its top speed is decided by how much drag it
 * meets belly-first and by how fast the propellers can still screw themselves
 * through the air at that lean.
 *
 * The numbers are the frame's own: a 160 mm carbon frame, four T-Motor P1604
 * 3800 kV on 4S turning HQ 3.5x2.5x3 tri-blades behind a SpeedyBee F405 Mini
 * BLS 35 A stack and an HDZero camera, at 293 g all up on the 750 mAh 4S pack
 * it is delivered with. What that adds up to — a little over 130 km/h and the
 * far side of six minutes of cruising — falls out of the propeller model and
 * the drag areas rather than being written down here, which is what makes it
 * worth checking in the tests.
 *
 * Like every wing here, the mass, thrust and pitch speed describe the airframe *as
 * delivered*; fit another combination or another pack in the hangar and they
 * are worked out again from the hardware.
 */
export const CA35_160: AircraftConfig = {
  name: "CarviFPV CA35-160",

  mass: 0.293,
  // Four motors of 17.5 g on 80 mm arms, and a pack and a stack inside 40 mm
  // of the middle. Small numbers, and they are the reason a quadcopter this
  // size changes attitude in the time a wing takes to notice the stick.
  inertiaRoll: 0.00045,
  inertiaPitch: 0.00045,
  inertiaYaw: 0.0008,

  // A multirotor has no wing, and nothing reads these three. They are the
  // frame's own plan area and width so that anything quoting a size — the
  // renderer scaling the model, the workbench printing a figure — has the
  // aircraft's real dimensions rather than a zero.
  wingArea: 0.026,
  /** Propeller tip to propeller tip across the diagonal. */
  wingSpan: 0.249,
  chord: 0.16,
  collisionRadius: 0.35,

  maxThrust: 21.5,
  propPitchSpeed: 50.6,
  // A quadcopter's throttle is its collective. It is flown with, not set and
  // left, so it moves quickly and the motors answer it in a twentieth of a
  // second.
  throttleRate: 1.8,
  throttleLag: 0.055,

  // No wing, so no lift curve and no stall to be past.
  cl0: 0,
  clAlpha: 0,
  stallAngle: Math.PI / 2,
  stallBlend: 0.1,

  cd0: 0,
  inducedDragFactor: 0,

  cyBeta: 0,

  cm0: 0,
  cmAlpha: 0,
  cmQ: 0,
  cmElevator: 0,

  clAileron: 0,
  clP: 0,
  clBeta: 0,

  cnBeta: 0,
  cnR: 0,
  cnRudder: 0,
  cnAileron: 0,

  minControlSpeed: 0,
  // Not a stall speed but a structural one: past about 180 km/h the airframe
  // is being asked for more than a 1.5 mm top plate and three-and-a-half-inch
  // propellers are rated to take.
  neverExceedSpeed: 50,

  rotor: {
    count: 4,
    armLength: 0.08,
    frontalArea: 0.0051,
    axialArea: 0.0077,
    // An X quadcopter at full differential puts half its thrust on one side of
    // the roll axis and takes it off the other, at the cosine of forty-five
    // degrees out along the arm. A third of thrust times arm is that, once the
    // mixer has kept every motor inside the range it actually has.
    rollAuthority: 0.3,
    pitchAuthority: 0.3,
    yawAuthority: 0.035,
    rollDamping: 0.0015,
    pitchDamping: 0.0015,
    yawDamping: 0.004,
    authorityThrottle: 0.5,
    cruiseFraction: 0.58,
    maxTiltDeg: 55,
    // Four millimetres: the 750 mAh pack sits on the top plate and everything
    // the air actually meets is under it.
    dragCentreOffset: -0.004,
  },
} as const;

/**
 * The Foamie Glider 480: the hand-launch chuck glider, converted.
 *
 * The aircraft in the photograph on issue #78 and sold by the crateful: a
 * moulded EPP glider, 480 mm across the wing and 500 mm nose to tail, blue
 * foam flecked with orange and a lump of black plastic in the nose for
 * balance. What is modelled here is the one everybody ends up with — the same
 * glider with two Happymodel EX1202.5 motors let into the wing, an aileron a
 * side cut out of its trailing edge, an elevator hinged into the tailplane, an
 * AIO board and a camera where the nose weight was, and a 2S pack under the
 * wing.
 *
 * A different aircraft to fly again, and the difference is size rather than
 * layout. At 141 g it is a fifteenth of the interceptor's weight on a wing
 * loading a fifth of it, so it stalls at walking pace, climbs at nearly its
 * own weight in thrust and is thrown about by gusts the wings do not notice.
 * It also has what neither wing has: a tail. The fin and the tailplane are the
 * glider's own, hinge for the elevator apart, and they are why it weathervanes,
 * holds a heading with nobody touching it, and — with the motors off — will
 * glide for as long as there is height to spend, which is what the airframe was
 * made to do before anyone put motors in it.
 *
 * Like every other airframe, the mass, thrust and pitch speed here describe it
 * *as delivered* — the KV6000 combination on the 720 mAh pack the listing
 * quotes ten minutes on. Fit anything else in the hangar and they are worked
 * out again from the hardware.
 */
export const FOAM_GLIDER: AircraftConfig = {
  name: "Foamie Glider 480",

  mass: 0.141,
  // Foam, two motors a hand's width out along the wing, and a pack on the
  // centreline. Roughly the interceptor's inertia scaled by mass and by the
  // square of the span it is spread over, which is what these are.
  inertiaRoll: 0.0026,
  // A bigger share of the roll figure than a flying wing's, because a glider
  // is mostly fuselage: half a metre of it, with a nose weight at one end and
  // a tail at the other.
  inertiaPitch: 0.0012,
  inertiaYaw: 0.0036,

  wingArea: 0.038,
  wingSpan: 0.48,
  chord: 0.08,
  // Half a span, and the rest is the fuselage sticking out in front of and
  // behind the wing it is measured from.
  collisionRadius: 0.4,

  maxThrust: 2.07,
  propPitchSpeed: 39.9,
  // Small motors on a light aircraft: the throttle is flown with rather than
  // set, and 2.5-inch propellers are up to speed in a tenth of a second.
  throttleRate: 1.2,
  throttleLag: 0.09,

  // A moulded foam section with a little camber under it, working at a
  // Reynolds number a tenth of the interceptor's: it makes lift at zero
  // incidence, and it gives up gently and early.
  cl0: 0.1,
  // 2 pi AR / (AR + 2) at the glider's aspect ratio of 6.1.
  clAlpha: 4.7,
  stallAngle: 0.2, // 11.5 degrees
  stallBlend: 0.13,

  // Dirtier than either wing per square metre of it: a slab fuselage, two
  // nacelles and a tail, all in the wake of a wing the size of a magazine.
  cd0: 0.045,
  inducedDragFactor: 0.062,

  cyBeta: -0.35,

  // A tail, and this is what one is worth. A tailplane a fifth of the wing's
  // area two and a half chords behind it is several times the pitch stiffness
  // of a reflexed flying wing, and it is trimmed where the glider was
  // balanced before anybody put motors in it: hands off, about 37 km/h.
  cm0: 0.09,
  cmAlpha: -0.9,
  cmQ: -22,
  // And this is why the elevator has to be in the tail rather than on the
  // wing: against a tail that stiff, a surface a hand's breadth behind the
  // centre of gravity would spend its whole travel holding the trim.
  cmElevator: 0.4,

  // Roll is the wing's job: an aileron a side, out where the trailing edge is
  // still straight.
  clAileron: 0.055,
  clP: -0.62,
  // Real dihedral, which is why it picks a dropped wing back up on its own
  // and why it rolls into a slip.
  clBeta: -0.12,

  cnBeta: 0.06,
  cnR: -0.09,
  // There is no rudder on it. What yaw there is comes from the motors being
  // half a span apart, and it is not much.
  cnRudder: 0.02,
  cnAileron: -0.01,

  minControlSpeed: 3,
  // Foam and tape. Past about 115 km/h the wing is being asked for more than
  // an EPP moulding and a row of servo horns are going to give.
  neverExceedSpeed: 32,

  shape: "glider",
} as const;

/**
 * The X10 Interceptor: the rocket, and the fastest thing in the hangar.
 *
 * A quadcopter by its flight model and nothing like one to look at or to fly.
 * The airframe is a 560 mm streamlined body standing on four tail fins with an
 * ogive nose, an FPV camera looking out of the tip of it, and four short swept
 * pylons half way down carrying the motors in bullet nacelles — a purpose-built
 * interception drone rather than a racing frame with a fairing on it.
 *
 * Which makes it the one airframe here whose drag areas are the other way
 * round. Every other multirotor is a flat plate: small from the nose, large
 * from underneath, and the moment it leans over to go quickly it is meeting the
 * air belly-first, which is where its top speed comes from. This one is a
 * slender body lying along the rotor axis, so leaning over points it *into* the
 * airflow — the faster it goes the more it is flying nose-first, and the area
 * it is dragging through the sky falls by a factor of eight as it does. That is
 * the whole trick, and it is why 450 g on four four-inch propellers does 360
 * km/h where a 160 mm racing quad does 130.
 *
 * It is paid for at the other end. Slowly, the aircraft is a 560 mm tube held
 * broadside to its own flight path: sluggish, draggy and blown about, with none
 * of a racing quad's poise in a hover. And it is paid for in the pack — the
 * dash costs a hundred and fifty amps and empties a 1100 in about ninety
 * seconds of it, so what the ten minutes on the specification sheet really
 * means is ten minutes of loitering slowly with one interception in the middle.
 *
 * As with every airframe here, the mass, thrust and pitch speed describe it *as
 * delivered* — 2450 kV on 6S behind the 4.2x7 speed propellers, on the 1100 mAh
 * pack it ships with. Fit anything else in the hangar and they are worked out
 * again from the hardware.
 */
export const X10_INTERCEPTOR: AircraftConfig = {
  name: "X10 Interceptor",

  mass: 0.45,
  // A rocket's inertia is a quadcopter's inside out. Nearly half a kilo spread
  // over 560 mm of body is a great deal of resistance to pitching or rolling —
  // twenty-five times a 160 mm frame's — while spinning about its own axis
  // moves almost nothing, because there is almost nothing out at a radius to
  // move. So it yaws about as readily as it rolls, which no other aircraft here
  // does, and the flick a racing quad has is not available to it at all.
  inertiaRoll: 0.012,
  inertiaPitch: 0.012,
  inertiaYaw: 0.0022,

  // No wing, and nothing reads these three. They are the airframe's real
  // dimensions so that anything quoting a size has them rather than a zero:
  // the body seen side-on, the propeller tips across the diagonal, and the
  // length of it from the nose to the fins.
  wingArea: 0.049,
  wingSpan: 0.337,
  chord: 0.56,
  // Half the body's length, and the rest is the propeller arc around it.
  collisionRadius: 0.45,

  maxThrust: 63.9,
  propPitchSpeed: 137,
  // Flown on the throttle every second it is up, like any multirotor, but with
  // motors half again the size of a racing quad's answering it.
  throttleRate: 1.6,
  throttleLag: 0.07,

  // No wing, so no lift curve and no stall to be past.
  cl0: 0,
  clAlpha: 0,
  stallAngle: Math.PI / 2,
  stallBlend: 0.1,

  cd0: 0,
  inducedDragFactor: 0,

  cyBeta: 0,

  cm0: 0,
  cmAlpha: 0,
  cmQ: 0,
  cmElevator: 0,

  clAileron: 0,
  clP: 0,
  clBeta: 0,

  cnBeta: 0,
  cnR: 0,
  cnRudder: 0,
  cnAileron: 0,

  minControlSpeed: 0,
  // Not a stall speed but a structural one: 430 km/h is where the pylons and
  // the propellers stop being the parts of this that anybody is worried about.
  neverExceedSpeed: 120,

  rotor: {
    count: 4,
    // Short pylons out of the side of the body, and the reason it rolls and
    // pitches deliberately rather than sharply: half again a 160 mm frame's
    // arm against twenty-five times its inertia.
    armLength: 0.115,
    /**
     * Broadside, which on this airframe is the *large* one.
     *
     * Lower than the 0.05 m^2 of body, pylon and fin the air would actually
     * meet if the thing were flown sideways at ninety degrees, because it never
     * is: the model spreads the two areas with a cos^2/sin^2 blend, and a
     * slender body meeting the air at fifteen degrees to its axis makes far
     * less of a wake than that blend implies. This is what reproduces its drag
     * across the incidences it is genuinely flown at.
     */
    frontalArea: 0.016,
    /**
     * Nose-on, and the number the top speed is made of.
     *
     * An ogive nose, four nacelles and the fins edge-on: an eighth of the
     * broadside figure, where a 160 mm quadcopter's axial area is half again
     * its frontal one. Reverse those two and this is an ordinary fast quad.
     */
    axialArea: 0.002,
    rollAuthority: 0.3,
    pitchAuthority: 0.3,
    yawAuthority: 0.035,
    // Scaled to the airframe's own inertia, so it settles in about the time a
    // racing quad does rather than in twenty-five times as long.
    rollDamping: 0.04,
    pitchDamping: 0.04,
    yawDamping: 0.011,
    authorityThrottle: 0.5,
    /**
     * A fifth, where a racing quad's is nearly six tenths.
     *
     * Not timidity: an interceptor has two speeds and no use for the ones in
     * between. Full throttle is under a minute of pack, so it loiters at about
     * 65 km/h — where it is barely leaning and barely drawing anything — and
     * spends the difference in one run. Quoting its endurance at half its top
     * speed would quote a way nobody flies it.
     */
    cruiseFraction: 0.18,
    // Steeper than any other multirotor's, because on this airframe a steep
    // lean is not an extreme attitude: at eighty degrees it is simply pointing
    // where it is going.
    maxTiltDeg: 80,
    /**
     * Six centimetres *below* the centre of gravity — the fins.
     *
     * Fifteen times a racing quad's offset and it means the opposite thing.
     * Area behind the weight in the direction of flight is what a weathercock
     * is, and this airframe flies nose-first, so its fins are behind it: let
     * the thrust fall away and the couple that arrives swings the nose into the
     * airflow instead of tipping the aircraft out of it. A dead quadcopter
     * tumbles; a dead X10 puts its nose down and arrives like a dart.
     */
    dragCentreOffset: -0.06,
  },

  shape: "rocket",
} as const;


/**
 * The Airmobi Skyeye series: the aeroplanes in the hangar.
 *
 * Five airframes rather than one, because the series is five airframes: the
 * 2600, 3200, 3600, 5000 and 6000, each named for its span in millimetres, from
 * a 2.6 m surveying platform to a 6 m machine that weighs as much as the pilot
 * flying it. They are one aeroplane in every respect but size — a carbon
 * fuselage pod with the payload in the nose, a high tapered wing, two tailbooms
 * carrying an inverted V-tail, a pusher propeller between them and a fixed
 * tricycle undercarriage underneath — and that is exactly what makes the set
 * worth having: it is the same aircraft asked to be seven times heavier, and
 * everything that follows from the weight follows here too.
 *
 * Two things separate every one of them from everything else in the hangar, and
 * both are the point of the series.
 *
 * The first is the **engine**. Not a motor: a petrol two-stroke, with an idle.
 * A wing here with the stick down is a glider — the propeller stops, and the
 * only thing still acting on the airframe is air. One of these with the stick
 * down is still running, still turning its propeller, and still being pushed
 * along by it. That single fact is most of what makes it a different aeroplane
 * to fly: it will not slow down on the approach the way a wing does, it wants
 * to keep rolling on the ground, and it needs the engine deliberately starved
 * rather than merely left alone.
 *
 * The second is the **undercarriage**. Nobody is going to hand-launch 25 kg of
 * aeroplane with an engine turning on the front of it, and nobody has to: it
 * stands on three wheels, and a flight begins with the engine idling on a
 * runway. Open the throttle, roll, rotate, fly — and land the same way, on
 * wheels, at a speed a foam belly would come apart at.
 *
 * They are also the only aircraft here that are genuinely *heavy*, and the
 * numbers say so before anything else does. The 6000 has forty times the roll
 * inertia of a Skywalker X8 on twice its span: it goes where it is pointed and
 * it goes there in its own time, and the way to fly one well is to decide early
 * and stop asking. That, and the hours: the 3600 carries eleven and a half
 * litres of petrol and stays up for four and a half hours on it, which is
 * longer than every electric airframe here put together.
 *
 * As with every airframe, the mass, thrust, pitch speed and idle describe each
 * one *as delivered* — the engine and the tank named by its hangar entry. Fit
 * another engine or another tank and they are worked out again from the
 * hardware, which is why what a full tank weighs and what an engine will burn
 * are flown rather than written down twice.
 */

/** Coefficients every Skyeye shares, because they are the same aeroplane. */
const SKYEYE_COMMON = {
  // A cambered UAV section rather than a reflexed flying-wing one: it makes
  // lift sitting still on the runway, which is what a wing on an aeroplane
  // that has to rotate off a nosewheel is for.
  cl0: 0.15,
  stallAngle: 0.21, // 12 degrees
  stallBlend: 0.14, // 8 degrees

  // A fuselage, two booms and a tail: far more keel than any wing here, which
  // is why one of these tracks through a crosswind instead of being pushed
  // sideways by it.
  cyBeta: -0.5,

  // A real tailplane on a real moment arm. Stiff in pitch and trimmed, hands
  // off, a little under its own cruise — and the elevator has to be strong to
  // work against it, which is what rotates the aeroplane off the runway.
  //
  // Strong, but not limitless, and where it stops is deliberate: against this
  // much stability, full back stick asks for about eighteen degrees of
  // incidence. That is past the stall, so the aeroplane can be flown into one
  // and has to be flown out of it — and it is nowhere near the twenty-five an
  // unbounded elevator would command, which would mean rotating off a runway
  // and arriving at the stall in the same movement.
  cm0: 0.1,
  cmAlpha: -1.0,
  cmQ: -22,
  cmElevator: 0.2,

  // Ailerons out on the wing panels rather than the whole trailing edge, on a
  // long wing with dihedral in it: deliberate in roll, and it picks a dropped
  // wing back up by itself.
  clAileron: 0.06,
  clP: -0.58,
  clBeta: -0.09,

  // Two fins a long way behind the centre of gravity, and — alone in this
  // hangar — rudders that actually do something, which is how a landing on
  // wheels is kept straight.
  cnBeta: 0.09,
  cnR: -0.12,
  cnRudder: 0.06,
  cnAileron: -0.012,

  // A petrol engine is set and left rather than flown with, and it answers
  // slowly: there is a flywheel, a carburettor and a propeller the size of a
  // dustbin lid between the stick and the thrust.
  throttleRate: 0.6,

  undercarriage: true,
  shape: "skyeye",
} as const;

/**
 * The Skyeye 2600 — the compact one, and the liveliest of the five.
 *
 * 2.6 m of full carbon at 6.5 kg empty, on a 20 cc engine and five litres of
 * petrol: fifteen kilos all up, which is its own maximum. It is the only Skyeye
 * that can be picked up by one person and the only one that feels quick, and it
 * pays for its size in drag — the same pod, the same booms and the same fixed
 * undercarriage on a third of the wing is proportionally a far dirtier
 * aeroplane, which is why the smallest one here is also the thirstiest per hour
 * in the air and stays up for two and a half of them rather than four.
 */
export const SKYEYE_2600: AircraftConfig = {
  name: "Skyeye 2600",

  mass: 14.75,
  // Fifteen kilos spread over 2.6 m. Nineteen times a Skywalker X8's roll
  // inertia, and the reason the smallest aeroplane here still rolls like an
  // aeroplane rather than like a wing.
  inertiaRoll: 6.74,
  inertiaPitch: 4.07,
  inertiaYaw: 10.81,

  wingArea: 0.7,
  wingSpan: 2.6,
  chord: 0.31,
  // Half a span and the propeller arc behind it.
  collisionRadius: 1.6,

  maxThrust: 67.9,
  propPitchSpeed: 38.2,
  throttleRate: SKYEYE_COMMON.throttleRate,
  throttleLag: 0.5,
  // A 20 cc idling at 1900 of its 8200 rpm: a twentieth of its thrust, which is
  // three and a half newtons against the six and a half its wheels cost to
  // roll. So it sits still with the engine running, and moves the moment the
  // throttle is opened past a hair.
  idleThrust: 0.054,

  cl0: SKYEYE_COMMON.cl0,
  // 2 pi AR / (AR + 2) at the 2600's aspect ratio of 9.7.
  clAlpha: 5.21,
  stallAngle: SKYEYE_COMMON.stallAngle,
  stallBlend: SKYEYE_COMMON.stallBlend,

  // Dirtier than any other Skyeye by half: the fixed gear, the pod and the
  // booms are the same fittings on a much smaller aeroplane.
  cd0: 0.066,
  inducedDragFactor: 0.0412,

  cyBeta: SKYEYE_COMMON.cyBeta,

  cm0: SKYEYE_COMMON.cm0,
  cmAlpha: SKYEYE_COMMON.cmAlpha,
  cmQ: SKYEYE_COMMON.cmQ,
  cmElevator: SKYEYE_COMMON.cmElevator,

  clAileron: SKYEYE_COMMON.clAileron,
  clP: SKYEYE_COMMON.clP,
  clBeta: SKYEYE_COMMON.clBeta,

  cnBeta: SKYEYE_COMMON.cnBeta,
  cnR: SKYEYE_COMMON.cnR,
  cnRudder: SKYEYE_COMMON.cnRudder,
  cnAileron: SKYEYE_COMMON.cnAileron,

  minControlSpeed: 8,
  // Carbon and a wing spar, not foam: 160 km/h is where the airframe rather
  // than the propeller becomes the thing to worry about.
  neverExceedSpeed: 45,

  undercarriage: SKYEYE_COMMON.undercarriage,
  shape: SKYEYE_COMMON.shape,
} as const;

/**
 * The Skyeye 3200 — the workhorse, and the odd one out.
 *
 * Sold as the Mugin 3220 as often as under its own name, and the only airframe
 * in the series that is not carbon: a wood and fibreglass composite, 2348 mm
 * long, and 12.45 kg empty against the 3600's 11.5 on a shorter wing. Which is
 * the whole character of it — it is the heaviest airframe per metre of span
 * here, so it carries the least of its 25 kg as anything useful and stays up
 * for three hours where the lighter aeroplane beside it manages four and a
 * half. What it is instead is cheap, replaceable and sold as a bare kit, which
 * is why more of these are flying than of anything else in the series.
 */
export const SKYEYE_3200: AircraftConfig = {
  name: "Skyeye 3200",

  mass: 23.34,
  inertiaRoll: 16.36,
  inertiaPitch: 11.6,
  inertiaYaw: 27.96,

  wingArea: 0.92,
  wingSpan: 3.22,
  chord: 0.33,
  collisionRadius: 1.95,

  maxThrust: 133.1,
  propPitchSpeed: 38.6,
  throttleRate: SKYEYE_COMMON.throttleRate,
  throttleLag: 0.6,
  idleThrust: 0.056,

  cl0: SKYEYE_COMMON.cl0,
  // 2 pi AR / (AR + 2) at an aspect ratio of 11.3.
  clAlpha: 5.34,
  stallAngle: SKYEYE_COMMON.stallAngle,
  stallBlend: SKYEYE_COMMON.stallBlend,

  // Wood and glass rather than moulded carbon, and it shows in the finish.
  cd0: 0.052,
  inducedDragFactor: 0.0353,

  cyBeta: SKYEYE_COMMON.cyBeta,

  cm0: SKYEYE_COMMON.cm0,
  cmAlpha: SKYEYE_COMMON.cmAlpha,
  cmQ: SKYEYE_COMMON.cmQ,
  cmElevator: SKYEYE_COMMON.cmElevator,

  clAileron: SKYEYE_COMMON.clAileron,
  clP: SKYEYE_COMMON.clP,
  clBeta: SKYEYE_COMMON.clBeta,

  cnBeta: SKYEYE_COMMON.cnBeta,
  cnR: SKYEYE_COMMON.cnR,
  cnRudder: SKYEYE_COMMON.cnRudder,
  cnAileron: SKYEYE_COMMON.cnAileron,

  minControlSpeed: 9,
  neverExceedSpeed: 48,

  undercarriage: SKYEYE_COMMON.undercarriage,
  shape: SKYEYE_COMMON.shape,
} as const;

/**
 * The Skyeye 3600 — the long-endurance one, and the best aeroplane of the five.
 *
 * 3.6 m of full carbon at 11.5 kg empty: lighter than the smaller 3200 and
 * carrying the same 8 kg of payload, on eleven and a half litres of petrol
 * built into the fuselage cabin. That combination is the reason it is the
 * airframe the series is known for — four and a half hours in the air, which is
 * longer than every electric aircraft in this hangar added together, and it
 * will do it with a camera under it and come back and land on its wheels.
 */
export const SKYEYE_3600: AircraftConfig = {
  name: "Skyeye 3600",

  mass: 28.71,
  inertiaRoll: 25.15,
  inertiaPitch: 15.13,
  inertiaYaw: 40.29,

  wingArea: 1.02,
  wingSpan: 3.6,
  chord: 0.32,
  collisionRadius: 2.15,

  maxThrust: 183.4,
  propPitchSpeed: 40.7,
  throttleRate: SKYEYE_COMMON.throttleRate,
  throttleLag: 0.65,
  idleThrust: 0.059,

  cl0: SKYEYE_COMMON.cl0,
  // 2 pi AR / (AR + 2) at an aspect ratio of 12.7.
  clAlpha: 5.43,
  stallAngle: SKYEYE_COMMON.stallAngle,
  stallBlend: SKYEYE_COMMON.stallBlend,

  cd0: 0.046,
  inducedDragFactor: 0.0306,

  cyBeta: SKYEYE_COMMON.cyBeta,

  cm0: SKYEYE_COMMON.cm0,
  cmAlpha: SKYEYE_COMMON.cmAlpha,
  cmQ: SKYEYE_COMMON.cmQ,
  cmElevator: SKYEYE_COMMON.cmElevator,

  clAileron: SKYEYE_COMMON.clAileron,
  clP: SKYEYE_COMMON.clP,
  clBeta: SKYEYE_COMMON.clBeta,

  cnBeta: SKYEYE_COMMON.cnBeta,
  cnR: SKYEYE_COMMON.cnR,
  cnRudder: SKYEYE_COMMON.cnRudder,
  cnAileron: SKYEYE_COMMON.cnAileron,

  minControlSpeed: 9,
  neverExceedSpeed: 52,

  undercarriage: SKYEYE_COMMON.undercarriage,
  shape: SKYEYE_COMMON.shape,
} as const;

/**
 * The Skyeye 5000 — the heavy one, and the first that is not a model aeroplane.
 *
 * A 5 m span, 32 kg empty, 90 kg maximum, and a 150 cc twin turning a 26-inch
 * propeller between the booms. Everything about it is a size up rather than a
 * model of a size up: an inverted V-tail, a Kevlar-lined 28 litre tank, booms
 * that come apart in two for shipping, and — uniquely here — disc brakes on the
 * wheels, because sixty-odd kilos rolling onto a runway at 100 km/h has to be
 * stopped by something.
 *
 * To fly it is the aeroplane the whole series has been building toward. The
 * best glide of the five, eight hours of fuel, and a hundred and twelve times
 * the roll inertia of a Skywalker X8: it goes exactly where it is pointed, and
 * it takes its time getting there.
 */
export const SKYEYE_5000: AircraftConfig = {
  name: "Skyeye 5000",

  mass: 66.32,
  inertiaRoll: 112.08,
  inertiaPitch: 66.98,
  inertiaYaw: 179.07,

  wingArea: 2.05,
  wingSpan: 5.0,
  chord: 0.47,
  collisionRadius: 2.9,

  maxThrust: 288.3,
  propPitchSpeed: 40.3,
  throttleRate: SKYEYE_COMMON.throttleRate,
  throttleLag: 0.8,
  idleThrust: 0.0625,

  cl0: SKYEYE_COMMON.cl0,
  // 2 pi AR / (AR + 2) at an aspect ratio of 12.2.
  clAlpha: 5.4,
  stallAngle: SKYEYE_COMMON.stallAngle,
  stallBlend: SKYEYE_COMMON.stallBlend,

  // Moulded carbon at a size where the fittings stop mattering: the cleanest
  // airframe here bar the 6000.
  cd0: 0.038,
  inducedDragFactor: 0.0318,

  cyBeta: SKYEYE_COMMON.cyBeta,

  cm0: SKYEYE_COMMON.cm0,
  cmAlpha: SKYEYE_COMMON.cmAlpha,
  cmQ: SKYEYE_COMMON.cmQ,
  cmElevator: SKYEYE_COMMON.cmElevator,

  clAileron: SKYEYE_COMMON.clAileron,
  clP: SKYEYE_COMMON.clP,
  clBeta: SKYEYE_COMMON.clBeta,

  cnBeta: SKYEYE_COMMON.cnBeta,
  cnR: SKYEYE_COMMON.cnR,
  cnRudder: SKYEYE_COMMON.cnRudder,
  cnAileron: SKYEYE_COMMON.cnAileron,

  minControlSpeed: 10,
  neverExceedSpeed: 50,

  undercarriage: SKYEYE_COMMON.undercarriage,
  shape: SKYEYE_COMMON.shape,
} as const;

/**
 * The Skyeye 6000 — the flagship, and the largest aircraft in the hangar.
 *
 * Six metres of wing, 115 kg at maximum, 30 kg of payload and ten hours of
 * fuel-injected endurance out of the same 28 litre tank the 5000 empties in
 * eight — which is the whole argument for injection, and it is made here rather
 * than claimed: the engine is simply more efficient per kilowatt-hour, so the
 * bigger, heavier aeroplane stays up longer.
 *
 * It is also, by a distance, the least like an FPV aircraft of anything here.
 * It has more roll inertia than the entire rest of the hangar combined, it
 * needs a runway rather than a field, and a turn on it is something you begin
 * and then wait for. Flown as what it is — a machine for being somewhere far
 * away for a very long time — it is the most capable airframe in the
 * simulator.
 */
export const SKYEYE_6000: AircraftConfig = {
  name: "Skyeye 6000",

  mass: 70.32,
  inertiaRoll: 171.13,
  inertiaPitch: 101.26,
  inertiaYaw: 272.39,

  wingArea: 2.5,
  wingSpan: 6.0,
  chord: 0.475,
  collisionRadius: 3.4,

  maxThrust: 376.3,
  propPitchSpeed: 44.7,
  throttleRate: SKYEYE_COMMON.throttleRate,
  throttleLag: 0.85,
  idleThrust: 0.0625,

  cl0: SKYEYE_COMMON.cl0,
  // 2 pi AR / (AR + 2) at an aspect ratio of 14.4, the highest here.
  clAlpha: 5.52,
  stallAngle: SKYEYE_COMMON.stallAngle,
  stallBlend: SKYEYE_COMMON.stallBlend,

  cd0: 0.032,
  inducedDragFactor: 0.0263,

  cyBeta: SKYEYE_COMMON.cyBeta,

  cm0: SKYEYE_COMMON.cm0,
  cmAlpha: SKYEYE_COMMON.cmAlpha,
  cmQ: SKYEYE_COMMON.cmQ,
  cmElevator: SKYEYE_COMMON.cmElevator,

  clAileron: SKYEYE_COMMON.clAileron,
  clP: SKYEYE_COMMON.clP,
  clBeta: SKYEYE_COMMON.clBeta,

  cnBeta: SKYEYE_COMMON.cnBeta,
  cnR: SKYEYE_COMMON.cnR,
  cnRudder: SKYEYE_COMMON.cnRudder,
  cnAileron: SKYEYE_COMMON.cnAileron,

  minControlSpeed: 9,
  neverExceedSpeed: 55,

  undercarriage: SKYEYE_COMMON.undercarriage,
  shape: SKYEYE_COMMON.shape,
} as const;

/** Standard gravity, m/s^2. */
export const GRAVITY = 9.80665;
