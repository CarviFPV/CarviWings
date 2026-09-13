import { assert, assertBetween, assertClose, suite } from "./harness";
import {
  FOAM_GLIDER_UAV,
  INTERCEPTOR_WING,
  batteriesFor,
  deliveredBattery,
  deliveredMotor,
  motorOrDefault,
  resolveLoadout,
} from "../flight/uav";
import {
  PHYSICS_TIMESTEP,
  cruiseEndurance,
  maxLevelSpeed,
  stallSpeed,
  stepFlightDynamics,
} from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import { createPowerplant, fitsMotor } from "../flight/powerplant";
import { FOAM_GLIDER, GRAVITY, PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import type { AircraftConfig } from "../flight/config";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import { MS_TO_KMH } from "../flight/telemetry";
import { CA35_160 } from "../flight/config";
import { engineProfileFor, engineSound } from "../audio/soundModel";
import {
  MESH_KIND,
  buildGliderMesh,
  meshKindFor,
} from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import * as V from "../math/vec3";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 300 };

/** The glider as it is delivered: KV6000 on the 720, which is the listing. */
const STOCK = resolveLoadout(FOAM_GLIDER_UAV, null);

/** One loadout out of the catalogue, worked out from the hardware. */
function fitted(motorId: string, batteryId: string) {
  return resolveLoadout(FOAM_GLIDER_UAV, {
    motor: motorId,
    battery: batteryId,
  });
}

function endurance(motorId: string, batteryId: string): number {
  const loadout = fitted(motorId, batteryId);
  const pack = loadout.battery ?? deliveredBattery(FOAM_GLIDER_UAV);
  return cruiseEndurance(loadout.config, loadout.motor, pack);
}

function aircraft(
  config: AircraftConfig,
  overrides: Partial<{
    airspeed: number;
    throttle: number;
    altitude: number;
    pitchDeg: number;
    rollDeg: number;
    withPack: boolean;
  }> = {},
): AircraftState {
  return createAircraftState({
    id: "glider",
    role: AIRCRAFT_ROLE.Player,
    config,
    position: V.vec3(0, 0, overrides.altitude ?? 400),
    headingDeg: 0,
    pitchDeg: overrides.pitchDeg ?? 0,
    rollDeg: overrides.rollDeg ?? 0,
    airspeed: overrides.airspeed ?? 0,
    throttle: overrides.throttle ?? 0,
    powerplant: overrides.withPack
      ? createPowerplant(STOCK.motor, deliveredBattery(FOAM_GLIDER_UAV))
      : null,
  });
}

function stick(pitch = 0, roll = 0, throttle = 0): FlightInput {
  const input = createFlightInput();
  input.pitch = pitch;
  input.roll = roll;
  input.throttle = throttle;
  return input;
}

function fly(state: AircraftState, input: FlightInput, seconds: number): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
  }
}

/**
 * Height given up and ground covered over a dead-stick glide, metres.
 *
 * Let go at the speed the polar says is its best, hands off the sticks and the
 * motors stopped, then averaged over long enough that the phugoid it settles
 * into does not decide the answer.
 */
function glide(config: AircraftConfig): { sink: number; ratio: number } {
  const speed = bestGlideSpeed(config);
  const state = aircraft(config, { airspeed: speed, altitude: 800 });
  // Let the trim settle before anything is measured.
  fly(state, stick(), 6);
  const height = state.position.z;
  const start = V.vec3(state.position.x, state.position.y, 0);
  const seconds = 40;
  fly(state, stick(), seconds);
  const lost = height - state.position.z;
  const distance = Math.hypot(
    state.position.x - start.x,
    state.position.y - start.y,
  );
  return { sink: lost / seconds, ratio: distance / Math.max(lost, 1e-6) };
}

/** Airspeed for the flattest glide, m/s: where induced drag equals parasitic. */
function bestGlideSpeed(config: AircraftConfig): number {
  const cl = Math.sqrt(config.cd0 / config.inducedDragFactor);
  return Math.sqrt(
    (2 * config.mass * GRAVITY) / (1.225 * config.wingArea * cl),
  );
}

export function runGliderTests(): void {
  suite("the foam glider is the aircraft in the photograph", () => {
    const config = STOCK.config;
    assertClose(
      config.wingSpan,
      0.48,
      1e-9,
      "480 mm across, which is what the listing measures",
    );
    assertClose(
      config.mass,
      0.141,
      0.002,
      "and 141 g with two motors and the 720 in it",
    );
    assertBetween(
      stallSpeed(config) * MS_TO_KMH,
      24,
      30,
      "it stalls at a walking pace, as an aircraft this light on this much wing does",
    );
    assertBetween(
      maxLevelSpeed(config) * MS_TO_KMH,
      85,
      100,
      "and still goes somewhere: a pair of 2.5-inch propellers on 141 g is quick",
    );
    assert(
      maxLevelSpeed(config) < config.neverExceedSpeed,
      "though not fast enough to pull the foam apart",
    );
    assertBetween(
      config.maxThrust / (config.mass * GRAVITY),
      1.3,
      1.7,
      "it climbs at more than its own weight in thrust",
    );

    // The number the listing is sold on, and the one the issue asks for.
    const stock = endurance(
      deliveredMotor(FOAM_GLIDER_UAV).id,
      deliveredBattery(FOAM_GLIDER_UAV).id,
    );
    assertBetween(
      stock / 60,
      9,
      11.5,
      "and the 720 mAh 2S pack is the ten minutes it is sold on",
    );
  });

  suite("the pack is a third of the aeroplane, and it shows", () => {
    const stock = fitted("ex1202.5-6000-2.5x2.5", "2s-720");
    const sprint = fitted("ex1202.5-6000-2.5x2.5", "2s-450");
    const long = fitted("ex1202.5-6000-2.5x2.5", "2s-liion-3000");

    assert(
      sprint.config.mass < stock.config.mass &&
        long.config.mass > stock.config.mass,
      "a pack is weight before it is anything else",
    );
    assert(
      stallSpeed(long.config) > stallSpeed(stock.config) &&
        stallSpeed(sprint.config) < stallSpeed(stock.config),
      "so the pack in it decides how slowly it can be flown",
    );
    assert(
      endurance("ex1202.5-6000-2.5x2.5", "2s-450") <
        endurance("ex1202.5-6000-2.5x2.5", "2s-720"),
      "the small pack is a shorter flight",
    );
    assert(
      endurance("ex1202.5-6000-2.5x2.5", "2s-liion-3000") > 30 * 60,
      "and the pair of 18650s is a different aeroplane: half an hour of it",
    );

    const stockMotor = motorOrDefault(FOAM_GLIDER_UAV, "ex1202.5-6000-2.5x2.5");
    const threeCell = motorOrDefault(
      FOAM_GLIDER_UAV,
      "ex1202.5-4500-2.5x2.5-3s",
    );
    assert(
      batteriesFor(FOAM_GLIDER_UAV, stockMotor).every(
        (pack) => pack.cells === 2,
      ),
      "a 2S combination is only offered the 2S packs",
    );
    assert(
      batteriesFor(FOAM_GLIDER_UAV, threeCell).every((pack) => pack.cells === 3),
      "and the 3S conversion only the 3S one",
    );
    assert(
      !fitsMotor(stockMotor, { ...deliveredBattery(FOAM_GLIDER_UAV), cells: 3 }),
      "which is a cell count rather than a rule kept somewhere else",
    );
  });

  suite("and so does what is bolted to the wing", () => {
    const stock = maxLevelSpeed(fitted("ex1202.5-6000-2.5x2.5", "2s-720").config);
    const gentle = maxLevelSpeed(
      fitted("ex1202.5-4500-2.5x2.5", "2s-720").config,
    );
    const pitched = maxLevelSpeed(fitted("ex1202.5-6000-2.5x3", "2s-720").config);
    const converted = maxLevelSpeed(
      fitted("ex1202.5-4500-2.5x2.5-3s", "3s-550").config,
    );

    assert(
      gentle < stock,
      "the same motor turning more slowly is a slower aeroplane",
    );
    assert(
      endurance("ex1202.5-4500-2.5x2.5", "2s-720") >
        endurance("ex1202.5-6000-2.5x2.5", "2s-720"),
      "and one that stays up longer, which is the whole point of it",
    );
    assert(pitched > stock, "more pitch is more speed");
    assert(
      converted > stock,
      "and the 3S conversion is the fastest of them",
    );
    assert(
      [stock, gentle, pitched, converted].every(
        (speed) => speed < FOAM_GLIDER.neverExceedSpeed,
      ),
      "and none of them will fly the wings off it",
    );
  });

  suite("with the motors off it is still a glider", () => {
    const glider = glide(STOCK.config);
    const interceptor = glide(resolveLoadout(INTERCEPTOR_WING, null).config);

    assert(
      glider.ratio > 7,
      "dead stick it goes seven metres forward for every one down",
    );
    assert(
      glider.sink < 1.3,
      "and gives that height up slowly enough to look for somewhere to land",
    );
    assert(
      glider.sink < interceptor.sink * 0.85,
      "far more slowly than a wing four times its wing loading",
    );
    assert(
      stallSpeed(STOCK.config) < stallSpeed(PLAYER_WING) * 0.85,
      "which is what a fifth of the wing loading buys",
    );
  });

  suite("the tail is what makes it fly itself", () => {
    // Pulled into a stall and then let go of. A tailed glider drops the nose
    // and flies out of it; that is what the tailplane is for.
    const state = aircraft(STOCK.config, { airspeed: 12, throttle: 0 });
    fly(state, stick(1), 2.5);
    assert(state.stalled, "hauling back on it at 43 km/h will stall it");
    fly(state, stick(), 3);
    assert(
      !state.stalled,
      "and letting go of the stick is the whole of the recovery",
    );
    assert(
      state.airspeed > stallSpeed(STOCK.config),
      "it comes out of it flying rather than falling",
    );

    assert(
      FOAM_GLIDER.cmAlpha < PLAYER_WING.cmAlpha,
      "a tail on an arm is stiffer in pitch than a reflexed wing",
    );
    assert(
      FOAM_GLIDER.cnBeta > PLAYER_WING.cnBeta,
      "and a fin weathervanes harder than a pair of winglets",
    );
  });

  suite("the glider has geometry of its own", () => {
    const mesh = buildGliderMesh();
    assert(
      meshKindFor(FOAM_GLIDER) === MESH_KIND.Glider,
      "the airframe says which aircraft it is drawn as",
    );
    assert(
      meshKindFor(PLAYER_WING) === MESH_KIND.Wing &&
        meshKindFor(CA35_160) === MESH_KIND.Quad,
      "and the other two still say what they are",
    );
    assert(mesh.kind === MESH_KIND.Glider, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      FOAM_GLIDER.wingSpan,
      0.005,
      "drawn at the width the airframe actually is",
    );
    assert(mesh.propellers.length === 2, "with a propeller on each wing");
    assert(
      mesh.propellers.every((group) => group.axis === "x"),
      "both turning about the nose, the way a tractor propeller does",
    );
    assert(
      mesh.propellers.filter((group) => group.direction > 0).length === 1,
      "and counter-rotating, so it has no torque roll to hold out",
    );
    assert(
      mesh.propellers.every((group) => Math.abs(group.origin[1]) > 0.05),
      "out on the wing rather than on the centreline",
    );

    const extent = (parts: readonly { positions: Float64Array }[]) => {
      let maxX = -Infinity, minX = Infinity, minY = Infinity, maxY = -Infinity;
      for (const part of parts) {
        for (let i = 0; i < part.positions.length; i += 3) {
          minX = Math.min(minX, part.positions[i] ?? 0);
          maxX = Math.max(maxX, part.positions[i] ?? 0);
          minY = Math.min(minY, part.positions[i + 1] ?? 0);
          maxY = Math.max(maxY, part.positions[i + 1] ?? 0);
        }
      }
      return { minX, maxX, minY, maxY };
    };
    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "a moving surface a side, which on this one is the elevator",
    );
    assert(
      mesh.elevonOrigin[0] < -0.15,
      "hinged in the tail rather than on the wing, where the pitch authority is",
    );
    const left = extent(mesh.elevonParts.left);
    const right = extent(mesh.elevonParts.right);
    assertClose(
      left.maxX,
      0,
      1e-9,
      "hinged at the origin of its own frame, so a rotation is all it takes",
    );
    assert(left.minX < 0, "and the surface extends aft of it");
    assert(left.minY > 0 && right.maxY < 0, "one surface per side");
    assertClose(
      left.maxY,
      -right.minY,
      1e-9,
      "and they mirror each other exactly",
    );

    const triangles = (parts: readonly { indices: Uint16Array }[]) =>
      parts.reduce((sum, part) => sum + part.indices.length, 0) / 3;
    assertClose(
      triangles(mesh.staticParts),
      triangles(mesh.parts) +
        triangles(mesh.elevonParts.left) +
        triangles(mesh.elevonParts.right),
      1e-9,
      "the merged airframe drawn for distant contacts loses no geometry",
    );
    assert(mesh.triangleCount > 200, "there is an aircraft there to look at");
    assert(
      mesh.fpvCamera.offset[0] > 0.2,
      "and the camera is on the nose, where the ballast used to be",
    );

    const picture = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.Glider,
    });
    assert(picture.length > 100, "and the workbench can draw a picture of it");
  });

  suite("and it sounds like a pair of small propellers", () => {
    const profile = engineProfileFor(FOAM_GLIDER);
    const glider = engineSound(1, 0, profile);
    const wing = engineSound(1, 0, engineProfileFor(PLAYER_WING));
    const quad = engineSound(1, 0, engineProfileFor(CA35_160));
    assert(profile.blades === 2, "two blades, as they are on the propellers");
    assert(
      glider.frequency > wing.frequency * 2,
      "2.5 inches spinning to thirty-odd thousand buzzes where a wing hums",
    );
    assert(
      glider.frequency < quad.frequency,
      "and still nothing like the scream of four three-bladed ones",
    );
  });
}
