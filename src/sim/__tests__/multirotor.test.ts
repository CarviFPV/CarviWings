import { assert, assertBetween, assertClose, suite } from "./harness";
import { CA35_160_UAV, batteriesFor, resolveLoadout } from "../flight/uav";
import {
  PHYSICS_TIMESTEP,
  cruiseEndurance,
  cruiseSpeed,
  maxLevelSpeed,
  stallSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import {
  hoverThrottle,
  rotorThrustFraction,
  rotorTrim,
  tiltedHoverThrottle,
} from "../flight/multirotor";
import { createPowerplant } from "../flight/powerplant";
import { AIRCRAFT_ROLE, FLIGHT_STATUS, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import { FlightModeController } from "../flight/flightController";
import { FLIGHT_MODE } from "../flight/flightModes";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { LOCATION_PRESETS } from "../geo/locations";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { ROTOR_GROUND_CONTACT } from "../flight/ground";
import type { FlightInput } from "../input/types";
import { toHeadingPitchRoll } from "../math/quat";
import { MS_TO_KMH } from "../flight/telemetry";
import { RAD_TO_DEG } from "../math/scalar";
import { MESH_KIND, buildQuadMesh, meshKindFor } from "../render/aircraftMesh";
import { CA35_160, PLAYER_WING } from "../flight/config";
import { engineProfileFor, engineSound } from "../audio/soundModel";
import { previewTriangles } from "../render/aircraftPreview";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };
const STOCK = resolveLoadout(CA35_160_UAV, null);

function quad(
  overrides: Partial<{
    id: string;
    airspeed: number;
    throttle: number;
    altitude: number;
    pitchDeg: number;
    withPack: boolean;
    /** Charge on the pack aboard, 1 full. Implies one. */
    charge: number;
    /** An airframe built without a millimetre of error anywhere on it. */
    perfect: boolean;
  }> = {},
): AircraftState {
  const withPack = overrides.withPack || overrides.charge !== undefined;
  let powerplant = null;
  if (withPack && STOCK.battery) {
    powerplant = createPowerplant(STOCK.motor, STOCK.battery);
    if (overrides.charge !== undefined) {
      powerplant.consumedMah = STOCK.battery.capacityMah * (1 - overrides.charge);
      powerplant.charge = overrides.charge;
    }
  }
  return createAircraftState({
    id: overrides.id ?? "quad",
    role: AIRCRAFT_ROLE.Player,
    config: STOCK.config,
    position: V.vec3(0, 0, overrides.altitude ?? 100),
    headingDeg: 0,
    pitchDeg: overrides.pitchDeg ?? 0,
    airspeed: overrides.airspeed ?? 0,
    throttle: overrides.throttle ?? hoverThrottle(STOCK.config),
    powerplant,
    dragCentre: overrides.perfect ? V.vec3() : undefined,
  });
}

function stick(
  throttle: number,
  pitch = 0,
  roll = 0,
  yaw = 0,
): FlightInput {
  return { pitch, roll, yaw, throttle };
}

function fly(
  state: AircraftState,
  input: FlightInput,
  seconds: number,
  environment: FlightEnvironment = CALM,
): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, environment, PHYSICS_TIMESTEP);
  }
}

/** Flies the aircraft through the flight controller, as the pilot's sticks do. */
function flyAssisted(
  state: AircraftState,
  controller: FlightModeController,
  pilot: FlightInput,
  seconds: number,
): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    const out = controller.update(state, pilot, PHYSICS_TIMESTEP);
    stepFlightDynamics(state, out, CALM, PHYSICS_TIMESTEP);
  }
}

const preset = LOCATION_PRESETS[0]!;

async function flatSimulation(): Promise<{
  simulation: Simulation;
  terrain: TerrainField;
}> {
  const terrain = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => 0),
    { cellSize: 50, warmRadius: 1500, sampleBudget: 8192, detailCellSize: 0 },
  );
  await terrain.prefill(V.vec3(), 2000);
  const simulation = new Simulation({
    frame: new EnuFrame({
      latitude: preset.latitude,
      longitude: preset.longitude,
      height: 500,
    }),
    terrain,
    missionRadius: 10000,
  });
  return { simulation, terrain };
}

export async function runMultirotorTests(): Promise<void> {
  suite("the CA35-160 is the quadcopter it is sold as", () => {
    const config = STOCK.config;
    assertClose(config.mass, 0.293, 0.005, "293 g all up on the 750 mAh pack");
    assertBetween(
      config.maxThrust / (config.mass * 9.80665),
      6.5,
      8.5,
      "four P1604s on 3.5 inch tri-blades pull seven times its weight",
    );
    assertBetween(
      maxLevelSpeed(config) * MS_TO_KMH,
      125,
      145,
      "and take it to about 135 km/h in level flight",
    );
    assertBetween(
      cruiseEndurance(config, STOCK.motor, STOCK.battery!) / 60,
      5.5,
      6.5,
      "with a little over six minutes of cruising in the pack",
    );
    assertBetween(
      hoverThrottle(config) * 100,
      32,
      42,
      "and it hovers at a bit over a third of the stick",
    );
    assert(meshKindFor(config) === MESH_KIND.Quad, "and it is drawn as a quad");
  });

  suite("the packs on offer are the flights they are quoted as", () => {
    const motor = STOCK.motor;
    const minutes = (id: string): number => {
      const pack = CA35_160_UAV.batteries.find((b) => b.id === id)!;
      const fitted = resolveLoadout(CA35_160_UAV, { motor: motor.id, battery: id });
      return cruiseEndurance(fitted.config, motor, pack) / 60;
    };
    assertBetween(minutes("4s-450"), 2.5, 4.2, "the sprint pack is over in minutes");
    assertBetween(minutes("4s-750"), 5.5, 6.5, "the delivered pack is six of them");
    assertBetween(minutes("4s-1100"), 7.5, 9.5, "the big LiPo is most of nine");
    assertBetween(
      minutes("4s-liion-3000"),
      18,
      23,
      "and the lithium-ion pack is twenty",
    );

    // The pack is a third of the aircraft, so fitting a bigger one is felt.
    const light = resolveLoadout(CA35_160_UAV, {
      motor: motor.id,
      battery: "4s-450",
    });
    const heavy = resolveLoadout(CA35_160_UAV, {
      motor: motor.id,
      battery: "4s-liion-3000",
    });
    assert(
      heavy.config.mass > light.config.mass * 1.4,
      "the long-range pack is half an aircraft again",
    );
    assert(
      hoverThrottle(heavy.config) > hoverThrottle(light.config) + 0.05,
      "and it shows in the throttle it takes to hold a hover",
    );
  });

  suite("the propeller decides the speed, as it does on a real one", () => {
    const stock = maxLevelSpeed(STOCK.config);
    const racing = resolveLoadout(CA35_160_UAV, {
      motor: "p1604-3800-3.5x3",
      battery: "4s-450",
    });
    assertBetween(
      maxLevelSpeed(racing.config) * MS_TO_KMH,
      140,
      160,
      "the high-pitch propeller is worth another 15 km/h",
    );
    assert(
      maxLevelSpeed(racing.config) > stock,
      "which is more than the delivered one does",
    );
    assert(
      cruiseEndurance(
        racing.config,
        CA35_160_UAV.motors[1]!,
        CA35_160_UAV.batteries[0]!,
      ) <
        cruiseEndurance(STOCK.config, STOCK.motor, STOCK.battery!) * 0.75,
      "and it is paid for out of the pack",
    );
    // Every combination the hangar offers has a pack that will run it.
    for (const combo of CA35_160_UAV.motors) {
      assert(
        batteriesFor(CA35_160_UAV, combo).length > 0,
        `${combo.id} has a pack that fits it`,
      );
    }
  });

  suite("a quadcopter hovers, which is the whole of the difference", () => {
    const config = STOCK.config;
    const state = quad();
    fly(state, stick(hoverThrottle(config)), 20);
    assertClose(state.position.z, 100, 0.5, "at the hover throttle it stays put");
    assertClose(state.velocity.z, 0, 0.2, "and it is not going anywhere");

    const climbing = quad();
    fly(climbing, stick(1), 4);
    assertBetween(
      climbing.velocity.z,
      20,
      45,
      "full throttle goes up, and quickly",
    );

    const falling = quad();
    fly(falling, stick(0), 4);
    assert(
      falling.velocity.z < -15,
      "and with the motors off it is a falling object, not a glider",
    );
    assert(!falling.stalled, "there is no wing on it to stall");
    assertClose(stallSpeed(config), 0, 1e-9, "so it has no stall speed at all");
  });

  suite("the throttle is a collective and reads like one", () => {
    assertClose(
      rotorThrustFraction(1),
      1,
      1e-9,
      "full stick is all the thrust there is",
    );
    assertClose(
      rotorThrustFraction(0.5),
      0.25,
      1e-9,
      "and half of it is a quarter, because thrust goes as the square of rpm",
    );
    const config = STOCK.config;
    assert(
      tiltedHoverThrottle(config, (45 * Math.PI) / 180) >
        hoverThrottle(config) + 0.03,
      "leaning over costs power, or it costs height",
    );
  });

  suite("it is controllable with no airspeed at all", () => {
    // The thing no wing here can do: roll on the spot, hanging still in the
    // air, because the control comes out of the rotors and not out of the air.
    const state = quad();
    fly(state, stick(hoverThrottle(STOCK.config), 0, 1), 0.5);
    assert(
      state.angularVelocity.x * RAD_TO_DEG > 200,
      "full roll stick from a standstill rolls it",
    );
    assertBetween(state.airspeed, 0, 6, "and it has barely moved doing it");
  });

  suite("it leans to go somewhere, and the lean is what stops it", () => {
    const config = STOCK.config;
    const fast = rotorTrim(config, 35);
    const slow = rotorTrim(config, 10);
    assert(
      fast.tilt > slow.tilt,
      "the faster it goes the further over it has to lean",
    );
    assert(fast.drag > slow.drag * 4, "and drag climbs with the square of it");
    assertBetween(
      fast.tilt * RAD_TO_DEG,
      45,
      80,
      "flat out it is meeting the air belly-first",
    );

    // Held at the lean the trim asks for, on full power, it settles at the
    // speed the hangar quoted rather than at some other number.
    const top = maxLevelSpeed(config);
    const state = quad({ airspeed: 5 });
    const controller = new FlightModeController({
      rates: CA35_160_UAV.defaultRates,
    });
    controller.setMode(FLIGHT_MODE.Angle);
    controller.setSettings({
      ...controller.parameters,
      maxPitchDeg: 45,
      maxBankDeg: 55,
    });
    for (let i = 0; i < Math.round(45 / PHYSICS_TIMESTEP); i += 1) {
      const out = controller.update(state, stick(1, -1), PHYSICS_TIMESTEP);
      out.throttle = 1;
      stepFlightDynamics(state, out, CALM, PHYSICS_TIMESTEP);
    }
    assertClose(
      state.groundSpeed,
      top,
      top * 0.12,
      "and flat out it reaches the top speed the workbench quotes",
    );
  });

  suite("the assisted modes mean what they mean on a multirotor", () => {
    const rates = CA35_160_UAV.defaultRates;

    // Acro: the rate loop goes and gets the rate the stick asked for.
    const acro = quad();
    const acroController = new FlightModeController({ rates });
    acroController.setMode(FLIGHT_MODE.Acro);
    flyAssisted(acro, acroController, stick(hoverThrottle(STOCK.config), 0, 1), 1.5);
    assertClose(
      acro.angularVelocity.x * RAD_TO_DEG,
      rates.rollRate,
      rates.rollRate * 0.1,
      "acro holds the roll rate it was asked for",
    );

    // Angle: let the sticks go and it comes back to level.
    const angle = quad({ pitchDeg: 35 });
    const angleController = new FlightModeController({ rates });
    angleController.setMode(FLIGHT_MODE.Angle);
    flyAssisted(angle, angleController, stick(hoverThrottle(STOCK.config)), 4);
    const levelled = toHeadingPitchRoll(angle.orientation);
    assertClose(levelled.pitchDeg, 0, 3, "angle mode puts the nose back level");
    assertClose(levelled.rollDeg, 0, 3, "and the airframe upright with it");

    // Altitude hold flies it on the throttle, and leaves the pitch stick to
    // the pilot so the aircraft can still be flown somewhere.
    const held = quad();
    const heldController = new FlightModeController({ rates });
    heldController.setMode(FLIGHT_MODE.Angle);
    heldController.setAltitudeHold(true);
    flyAssisted(held, heldController, stick(0.1, -0.6), 20);
    assertClose(
      held.position.z,
      100,
      4,
      "altitude hold holds the height on the throttle, whatever the stick says",
    );
    assert(
      held.groundSpeed > 8,
      "and the pitch stick still takes it somewhere",
    );
  });

  suite("a held course is held on the yaw axis, because banking does not turn one", () => {
    const rates = CA35_160_UAV.defaultRates;

    // Bank a quadcopter and it slides sideways; the nose stays where it was.
    const banked = quad();
    const banking = new FlightModeController({ rates });
    banking.setMode(FLIGHT_MODE.Angle);
    banking.setAltitudeHold(true);
    flyAssisted(banked, banking, stick(0.1, 0, 0.8), 8);
    const slid = toHeadingPitchRoll(banked.orientation);
    assertClose(slid.headingDeg, 0, 6, "eight seconds of bank has not turned it");
    assert(
      Math.abs(banked.velocity.x) > 5,
      "it has translated sideways instead, which is what a bank does to one",
    );

    // The course hold turns it with the rudder, which is the axis that does.
    const turning = quad();
    const holding = new FlightModeController({ rates });
    holding.setMode(FLIGHT_MODE.Angle);
    holding.setCourseHold(true);
    holding.setAltitudeHold(true);
    // Nudged off heading, it comes back.
    turning.angularVelocity.z = -1.2;
    flyAssisted(turning, holding, stick(0.1), 8);
    assertClose(
      toHeadingPitchRoll(turning.orientation).headingDeg,
      0,
      5,
      "and the held course is recovered",
    );
  });

  await suite("it comes home and stops over the field", async () => {
    const { simulation } = await flatSimulation();
    const controller = new FlightModeController({
      rates: CA35_160_UAV.defaultRates,
    });
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: STOCK.config,
        position: V.vec3(0, 0, 60),
        headingDeg: 0,
        airspeed: 0,
        throttle: hoverThrottle(STOCK.config),
      },
      (aircraft, dt) =>
        controller.update(aircraft, stick(hoverThrottle(STOCK.config)), dt),
    );
    controller.setHome(V.vec3(0, 0, 60));
    // Put it a long way out, the way a pilot who has lost the picture is.
    player.position.x = 600;
    player.position.y = -400;
    controller.setReturnHome(true);

    for (let i = 0; i < 60 * 120; i += 1) simulation.update(1 / 60);
    assert(
      Math.hypot(player.position.x, player.position.y) < 40,
      "a return home brings a quadcopter back over the launch point",
    );
    assert(
      player.groundSpeed < 6,
      "and it stops there rather than circling, because it can",
    );
    assert(
      player.status === FLIGHT_STATUS.Flying,
      "and it is still flying when it gets there",
    );
  });

  await suite("it lands on its arms and takes off again straight up", async () => {
    const { simulation } = await flatSimulation();
    let input = stick(0);
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: STOCK.config,
        position: V.vec3(0, 0, 6),
        headingDeg: 0,
        airspeed: 0,
        throttle: hoverThrottle(STOCK.config),
      },
      () => input,
    );

    // Let down gently: a touch under the hover throttle is a descent.
    input = stick(hoverThrottle(STOCK.config) * 0.93);
    for (let i = 0; i < 60 * 20; i += 1) {
      simulation.update(1 / 60);
      if (player.status === FLIGHT_STATUS.Landed) break;
    }
    assert(
      player.status === FLIGHT_STATUS.Landed,
      "a gentle descent is a landing, not a crash",
    );
    assertClose(
      player.position.z,
      ROTOR_GROUND_CONTACT.restHeight,
      0.02,
      "and it sits on its arms rather than on a wing",
    );

    // And it goes straight back up, with no take-off roll of any kind.
    input = stick(1);
    for (let i = 0; i < 60 * 3; i += 1) simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Flying,
      "opening the throttle takes it off",
    );
    assert(player.position.z > 8, "straight up, from a standstill");
    assert(
      Math.hypot(player.velocity.x, player.velocity.y) < 2,
      "with no run along the ground at all",
    );
  });

  suite("the pack runs down and takes the aircraft with it", () => {
    const state = quad({ withPack: true });
    const plant = state.powerplant!;
    const start = plant.charge;
    fly(state, stick(hoverThrottle(STOCK.config)), 30);
    assert(plant.charge < start, "hovering costs the pack every second of it");
    assert(
      plant.enduranceSeconds < 12 * 60,
      "and a quadcopter's endurance is quoted in minutes",
    );
  });

  suite("the last third of the pack is flown on the stick, not read on the OSD", () => {
    // The same aircraft on the same stick three times over; the only thing that
    // changes is what is left in the pack. A tired one sags further under the
    // load it is being asked for, so it makes less thrust for the stick — which
    // the pilot meets as an aircraft that stops holding height and then stops
    // climbing, well before anything cuts.
    const hover = stick(hoverThrottle(STOCK.config));
    const fresh = quad({ charge: 1 });
    const tired = quad({ charge: 0.2 });
    fly(fresh, hover, 4);
    fly(tired, hover, 4);

    assert(fresh.velocity.z > 0, "the hover stick off the charger is a slow climb");
    assert(
      tired.velocity.z < -1,
      "and a fifth of a pack later the same stick is a descent",
    );
    assert(
      tired.powerplant!.thrustFactor < fresh.powerplant!.thrustFactor,
      "because the pack is worth less thrust than it was",
    );

    const spent = quad({ charge: 0.05 });
    fly(spent, stick(1), 2);
    assert(
      spent.velocity.z < 0,
      "and at the bottom of it full throttle does not climb at all",
    );
  });

  suite("with the pack gone it goes over instead of dropping the way it was left", () => {
    const dying = quad({ charge: 0.02, altitude: 400 });
    dying.powerplant!.cut = true;
    fly(dying, stick(0.6), 6);

    const attitude = toHeadingPitchRoll(dying.orientation);
    assert(
      Math.abs(attitude.rollDeg) > 90,
      "a quadcopter with nothing left tips off and goes over",
    );
    assert(dying.velocity.z < -15, "while it drops, because it is not a glider");

    // Which way it goes is this airframe's own millimetre of build error, so
    // two of them let go of the same hover do not arrive in the same place.
    const other = quad({ id: "another-quad", charge: 0.02, altitude: 400 });
    other.powerplant!.cut = true;
    fly(other, stick(0.6), 6);
    assert(
      V.distance(dying.position, other.position) > 1,
      "and no two of them fall the same way, because no two are built alike",
    );

    // The departure is the airframe rather than the model: one built perfectly
    // falls perfectly, which is exactly what no real one does.
    const perfect = quad({ charge: 0.02, altitude: 400, perfect: true });
    perfect.powerplant!.cut = true;
    fly(perfect, stick(0.6), 6);
    const held = toHeadingPitchRoll(perfect.orientation);
    assertClose(held.rollDeg, 0, 0.5, "a perfectly built one drops flat");
    assertClose(held.pitchDeg, 0, 0.5, "in the attitude it was left in");
  });

  suite("and it sounds like one", () => {
    const quadTone = engineSound(1, 0, engineProfileFor(CA35_160));
    const wingTone = engineSound(1, 0, engineProfileFor(PLAYER_WING));
    assert(
      quadTone.frequency > wingTone.frequency * 3,
      "four three-bladed propellers at forty thousand rpm scream where a wing hums",
    );
    assert(
      engineProfileFor(CA35_160).blades === 3,
      "and the blade count is the one on the propellers",
    );
  });

  suite("the quadcopter has geometry of its own", () => {
    const mesh = buildQuadMesh();
    assert(mesh.kind === MESH_KIND.Quad, "it is its own mesh");
    assert(mesh.propellers.length === 4, "with four propellers on it");
    assert(
      mesh.propellers.every((group) => group.axis === "z"),
      "all turning about the body up axis rather than the nose",
    );
    assert(
      mesh.propellers.filter((group) => group.direction > 0).length === 2,
      "two of them one way and two the other, as they have to be",
    );
    assert(
      mesh.elevonParts.left.length === 0 &&
        mesh.elevonParts.right.length === 0,
      "and nothing on it hinges",
    );
    assert(mesh.triangleCount > 200, "there is an aircraft there to look at");
    assertClose(
      mesh.referenceSpan,
      CA35_160.wingSpan,
      0.005,
      "drawn at the width the airframe actually is",
    );

    const triangles = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.Quad,
    });
    assert(triangles.length > 100, "and the workbench can draw a picture of it");
  });
}
