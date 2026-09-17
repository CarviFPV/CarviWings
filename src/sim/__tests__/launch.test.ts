import { assert, assertBetween, assertClose, suite } from "./harness";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { LOCATION_PRESETS } from "../geo/locations";
import { CA35_160, PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import { groundContactFor } from "../flight/ground";
import {
  HAND_LAUNCH_AGL,
  HAND_LAUNCH_PITCH_DEG,
  HAND_LAUNCH_THROTTLE,
  PILOT_EYE_HEIGHT,
  PILOT_STANDOFF,
  airborneLaunch,
  groundLaunch,
  handLaunchSpeed,
} from "../flight/launch";
import { stallSpeed } from "../flight/physics";
import { UAVS } from "../flight/uav";
import { hoverThrottle } from "../flight/multirotor";
import type { FlightInput } from "../input/types";
import { DEG_TO_RAD } from "../math/scalar";
import { toHeadingPitchRoll } from "../math/quat";
import { TerrainField } from "../terrain/terrainField";
import {
  FOOTING_RADIUS,
  groundUnderfoot,
  standingSurface,
} from "../terrain/footing";
import { SurfaceCalibration } from "../terrain/surfaceCalibration";
import type { TerrainQuery } from "../terrain/types";
import * as V from "../math/vec3";

const preset = LOCATION_PRESETS[0]!;

/** Flat ground at the frame's own datum, which is where the pilot stands. */
async function flatTerrain(): Promise<TerrainField> {
  const field = new TerrainField(
    async (points: readonly TerrainQuery[]) => points.map(() => 0),
    { cellSize: 50, warmRadius: 1500, sampleBudget: 8192, detailCellSize: 0 },
  );
  await field.prefill(V.vec3(), 3000);
  return field;
}

/**
 * A hillside with a hollow in it, which is what a start point picked off the
 * globe lands in the moment it is not a runway: the column the flight opens on
 * sits metres below the ground a couple of paces away from it.
 */
function hollowHeight(x: number, y: number): number {
  const radius = Math.hypot(x, y);
  return y * 0.25 - 6 * Math.exp(-(radius * radius) / (2 * 9 * 9));
}

/** Ground the size of a person, around a column: what has to be cleared. */
function highestAround(field: TerrainField, x: number, y: number): number {
  let highest = -Infinity;
  for (let dx = -FOOTING_RADIUS; dx <= FOOTING_RADIUS; dx += 0.5) {
    for (let dy = -FOOTING_RADIUS; dy <= FOOTING_RADIUS; dy += 0.5) {
      if (dx * dx + dy * dy > FOOTING_RADIUS * FOOTING_RADIUS) continue;
      highest = Math.max(highest, field.heightAt(x + dx, y + dy));
    }
  }
  return highest;
}

function makeSimulation(terrain: TerrainField): Simulation {
  return new Simulation({
    frame: new EnuFrame({
      latitude: preset.latitude,
      longitude: preset.longitude,
      height: 500,
    }),
    terrain,
    missionRadius: 10000,
  });
}

/** Hands off. A launcher lets go and the pilot flies it from there. */
const handsOff = (throttle: number): FlightInput => ({
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle,
});

export async function runLaunchTests(): Promise<void> {
  suite("how a flight begins", () => {
    const thrown = groundLaunch(PLAYER_WING);
    assertClose(
      thrown.altitudeAgl,
      HAND_LAUNCH_AGL,
      1e-9,
      "a wing waits at head height, which is where it leaves the hand",
    );
    assertClose(
      thrown.pitchDeg,
      HAND_LAUNCH_PITCH_DEG,
      1e-9,
      "nose up, the way a wing is held to be thrown",
    );
    assert(thrown.held, "and it is held rather than flying or on the ground");
    assert(!thrown.grounded, "there is nothing under a wing in somebody's hand");
    assertClose(
      thrown.throttle,
      0,
      1e-9,
      "with the throttle shut, because that is where a pilot's stick is",
    );
    assertClose(
      thrown.airspeed,
      0,
      1e-9,
      "and no speed of its own until the throw gives it one",
    );
    assert(
      handLaunchSpeed(PLAYER_WING) > stallSpeed(PLAYER_WING),
      `the throw itself is hard enough to fly out of (${handLaunchSpeed(PLAYER_WING).toFixed(1)} m/s against a ${stallSpeed(PLAYER_WING).toFixed(1)} m/s stall)`,
    );

    const puttingDown = groundLaunch(CA35_160);
    assert(puttingDown.grounded, "a quadcopter starts on the ground");
    assertClose(
      puttingDown.throttle,
      0,
      1e-9,
      "with the throttle closed, because nobody threw it",
    );
    assertClose(
      puttingDown.altitudeAgl,
      groundContactFor(CA35_160).restHeight,
      1e-9,
      "sitting on its own arms rather than hovering over them",
    );
    assertClose(puttingDown.airspeed, 0, 1e-9, "and not going anywhere yet");

    assert(
      !puttingDown.held,
      "and nobody is holding it: it is on the grass on its own arms",
    );

    const mission = airborneLaunch(PLAYER_WING, 300);
    assertClose(
      mission.altitudeAgl,
      300,
      1e-9,
      "a mission begins at the height it was set up at",
    );
    assert(
      !mission.grounded && mission.airspeed > stallSpeed(PLAYER_WING),
      "already flying when it gets there",
    );
    assertClose(
      airborneLaunch(CA35_160, 300).throttle,
      hoverThrottle(CA35_160),
      1e-9,
      "and a quadcopter arrives hanging on its own rotors",
    );
    assert(
      !mission.held && !airborneLaunch(CA35_160, 300).held,
      "nothing that starts a mission is being held by anybody",
    );
  });

  await suite("a wing waits in the hand until the motor is running", async () => {
    // The failure this replaces: a wing thrown on the assumption that the
    // throttle was open, at a pilot whose stick was where every pilot's stick
    // is before a launch — shut. It was in the grass three seconds later,
    // every single time, and nothing the pilot did could have saved it.
    const terrain = await flatTerrain();
    const simulation = makeSimulation(terrain);
    const launch = groundLaunch(PLAYER_WING);
    let throttle = launch.throttle;

    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, terrain.heightAt(0, 0) + launch.altitudeAgl),
        headingDeg: 0,
        pitchDeg: launch.pitchDeg,
        airspeed: launch.airspeed,
        throttle: launch.throttle,
        grounded: launch.grounded,
        held: launch.held,
      },
      () => handsOff(throttle),
    );

    assert(
      player.status === FLIGHT_STATUS.Held,
      "it begins in the launcher's hand rather than in the air",
    );
    assertClose(
      player.altitudeAgl,
      HAND_LAUNCH_AGL,
      1e-6,
      "at head height above the field rather than inside it",
    );
    assertClose(
      toHeadingPitchRoll(player.orientation).pitchDeg,
      HAND_LAUNCH_PITCH_DEG,
      1e-6,
      "held at the angle it is going to be thrown at",
    );

    // Half a minute of a pilot getting ready, which is a long time to hold a
    // wing and no time at all to lose one in.
    for (let i = 0; i < 60 * 30; i += 1) simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Held,
      `nobody has let go of it thirty seconds later (${player.status})`,
    );
    assertClose(
      player.altitudeAgl,
      HAND_LAUNCH_AGL,
      1e-6,
      "and it has not moved an inch in that time",
    );
    assertClose(V.length(player.velocity), 0, 1e-9, "because it is being held");
    assert(
      simulation.statistics.crashes === 0,
      "so there is no way to lose an airframe before the flight has begun",
    );

    // Half throttle is a pilot doing something else with the stick, not a
    // pilot calling for the launch.
    throttle = HAND_LAUNCH_THROTTLE * 0.6;
    for (let i = 0; i < 60 * 2; i += 1) simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Held,
      `and half a stick is not a launch either (${player.status})`,
    );
    assert(
      player.throttle > 0.2,
      `though the motor answers it, which is what the launcher listens for (${player.throttle.toFixed(2)})`,
    );

    // The pilot opens the throttle. That is the launch.
    throttle = 1;
    simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Flying,
      `opening the throttle throws it (${player.status})`,
    );
    assert(
      player.airspeed > stallSpeed(PLAYER_WING),
      `and it leaves the hand flying (${player.airspeed.toFixed(1)} m/s against a ${stallSpeed(PLAYER_WING).toFixed(1)} m/s stall)`,
    );

    let lowest = player.altitudeAgl;
    for (let i = 0; i < 60 * 8; i += 1) {
      simulation.update(1 / 60);
      lowest = Math.min(lowest, player.altitudeAgl);
    }

    assert(
      player.status === FLIGHT_STATUS.Flying,
      `still flying eight seconds after the throw (${player.status})`,
    );
    assert(
      lowest > 0.5,
      `never coming back down through the grass on the way (${lowest.toFixed(2)} m at the lowest)`,
    );
    assert(
      player.altitudeAgl > 15,
      `it climbs away from the launcher (${player.altitudeAgl.toFixed(0)} m)`,
    );
    assert(
      simulation.statistics.crashes === 0 &&
        simulation.statistics.landings === 0,
      "and nothing about a launch is a landing or a crash",
    );
  });

  await suite("a held wing stands on the ground that arrives late", async () => {
    // A launch point's terrain can still be resolving while the pilot is
    // getting ready, and the height a wing is held at is re-read every step
    // rather than remembered — otherwise the first frame's guess would be
    // thrown out of a hole once the real ground turned up under it.
    let surface = 0;
    const terrain = new TerrainField(
      async (points: readonly TerrainQuery[]) => points.map(() => surface),
      { cellSize: 50, warmRadius: 1500, sampleBudget: 8192, detailCellSize: 0 },
    );
    await terrain.prefill(V.vec3(), 3000);
    const simulation = makeSimulation(terrain);
    const launch = groundLaunch(PLAYER_WING);

    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, terrain.heightAt(0, 0) + launch.altitudeAgl),
        headingDeg: 0,
        pitchDeg: launch.pitchDeg,
        airspeed: launch.airspeed,
        throttle: launch.throttle,
        grounded: launch.grounded,
        held: launch.held,
      },
      () => handsOff(0),
    );

    // The field turns out to be eighty metres higher than the globe's estimate.
    surface = 80;
    terrain.setSurfaceBias(80);
    for (let i = 0; i < 60; i += 1) simulation.update(1 / 60);

    assertClose(
      player.altitudeAgl,
      HAND_LAUNCH_AGL,
      1e-6,
      "the wing came up with the ground rather than being buried by it",
    );
    assert(
      simulation.statistics.crashes === 0,
      "and ground arriving under a launch is not a crash",
    );
  });

  await suite("and every wing in the hangar flies out of its throw", async () => {
    // The throw is worked out from the airframe rather than written down, so
    // what has to hold is that it works for all of them: a 2.1 m survey wing
    // needs a harder throw than a foam glider and gets one. An aeroplane on
    // wheels is not thrown at all and is checked below on its own terms.
    for (const uav of UAVS) {
      if (uav.config.rotor || uav.config.undercarriage) continue;
      const terrain = await flatTerrain();
      const simulation = makeSimulation(terrain);
      const launch = groundLaunch(uav.config);
      const player = simulation.spawn(
        {
          id: "player",
          role: AIRCRAFT_ROLE.Player,
          config: uav.config,
          position: V.vec3(0, 0, terrain.heightAt(0, 0) + launch.altitudeAgl),
          headingDeg: 0,
          pitchDeg: launch.pitchDeg,
          airspeed: launch.airspeed,
          throttle: launch.throttle,
          grounded: launch.grounded,
          held: launch.held,
        },
        // The pilot calls for the launch and then leaves the sticks alone: a
        // launch that only works when it is flown out of is a launch that eats
        // an airframe every time somebody blinks.
        () => handsOff(1),
      );
      let lowest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 60 * 8; i += 1) {
        simulation.update(1 / 60);
        if (player.status !== FLIGHT_STATUS.Held) {
          lowest = Math.min(lowest, player.altitudeAgl);
        }
      }
      assert(
        player.status === FLIGHT_STATUS.Flying && lowest > 0.5,
        `${uav.config.name} flies out of the throw (${lowest.toFixed(2)} m at the lowest, ${player.status})`,
      );
    }
  });

  await suite(
    "and every aeroplane on wheels leaves the ground under its own power",
    async () => {
      // No throw, no launcher and no threshold: it is standing on a runway
      // with its engine idling, and the whole launch is the throttle, the
      // roll and the rotation. The one thing that has to hold for all five is
      // that the aeroplane goes when it is asked to and not before.
      for (const uav of UAVS) {
        if (!uav.config.undercarriage) continue;
        const terrain = await flatTerrain();
        const simulation = makeSimulation(terrain);
        const launch = groundLaunch(uav.config);
        let stick: FlightInput = handsOff(0);

        const player = simulation.spawn(
          {
            id: "player",
            role: AIRCRAFT_ROLE.Player,
            config: uav.config,
            position: V.vec3(0, 0, terrain.heightAt(0, 0) + launch.altitudeAgl),
            headingDeg: 0,
            pitchDeg: launch.pitchDeg,
            airspeed: launch.airspeed,
            throttle: launch.throttle,
            grounded: launch.grounded,
            held: launch.held,
          },
          () => stick,
        );

        assert(
          player.status === FLIGHT_STATUS.Landed,
          `${uav.config.name} starts on its wheels rather than in a hand (${player.status})`,
        );

        // Ten seconds with the engine idling and nobody touching anything. It
        // is running the whole time — that is what an engine does — and the
        // wheels are what stop it running away with itself.
        for (let i = 0; i < 60 * 10; i += 1) simulation.update(1 / 60);
        assert(
          player.status === FLIGHT_STATUS.Landed,
          `${uav.config.name} is still on the runway at idle (${player.status})`,
        );
        assert(
          V.length(player.velocity) < 1,
          `${uav.config.name} has not run away on its idle (${V.length(
            player.velocity,
          ).toFixed(2)} m/s)`,
        );

        // Full throttle, stick neutral, and the aeroplane is rotated once it
        // has the speed to fly — which is a take-off rather than a heave, and
        // the difference is the whole of why one of these has a runway roll:
        // hauled off the ground from a standstill it drags its own induced
        // drag down the strip and never accelerates past it.
        //
        // The rotation is flown to an attitude rather than to a stick
        // position, because that is what a pilot does and because the two are
        // not the same thing: the elevator on one of these will ask for half
        // again the incidence the wing has, and an aeroplane rotated with the
        // stick on the stop arrives at its stall on the runway.
        const rotateSpeed = stallSpeed(uav.config) * 1.2;
        const climbAlpha = 8 * DEG_TO_RAD;
        const rotate = (): FlightInput => ({
          pitch: Math.max(
            -1,
            Math.min(1, (climbAlpha - player.angleOfAttack) * 8),
          ),
          roll: 0,
          yaw: 0,
          throttle: 1,
        });
        stick = handsOff(1);
        let rolled = 0;
        for (let i = 0; i < 60 * 40; i += 1) {
          simulation.update(1 / 60);
          if (player.status === FLIGHT_STATUS.Flying) break;
          if (player.airspeed > rotateSpeed) stick = rotate();
          rolled = V.length(player.position);
        }
        assert(
          player.status === FLIGHT_STATUS.Flying,
          `${uav.config.name} flies off the runway (${player.status})`,
        );
        // A run rather than a leap or a cross-country, and the floor is the
        // aeroplane's own size rather than a distance: a 6 m Skyeye uses four
        // hundred metres of strip and a foam triplane at a third of its wing
        // loading is off in a dozen, and both of those are the aeroplane
        // rolling until its wing will carry it rather than being hauled into
        // the air from a standstill.
        assert(
          rolled > uav.config.wingSpan * 4 && rolled < 600,
          `${uav.config.name} needs a runway rather than a step or a mile (${rolled.toFixed(
            0,
          )} m)`,
        );
        assert(
          simulation.statistics.crashes === 0,
          `${uav.config.name} took off rather than fell over`,
        );

        // And it climbs away rather than settling back on, still flown to the
        // same attitude it left the ground at.
        for (let i = 0; i < 60 * 6; i += 1) {
          stick = rotate();
          simulation.update(1 / 60);
        }
        assert(
          player.altitudeAgl > 5,
          `${uav.config.name} climbs away (${player.altitudeAgl.toFixed(1)} m)`,
        );
      }
    },
  );

  await suite("a quadcopter put down on the grass waits there", async () => {
    const terrain = await flatTerrain();
    const simulation = makeSimulation(terrain);
    const launch = groundLaunch(CA35_160);
    let throttle = launch.throttle;

    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: CA35_160,
        position: V.vec3(0, 0, terrain.heightAt(0, 0) + launch.altitudeAgl),
        headingDeg: 0,
        pitchDeg: launch.pitchDeg,
        airspeed: launch.airspeed,
        throttle: launch.throttle,
        grounded: launch.grounded,
        held: launch.held,
      },
      () => handsOff(throttle),
    );

    assert(
      player.status === FLIGHT_STATUS.Landed,
      "it begins as an aircraft on the ground rather than one that has landed there",
    );

    for (let i = 0; i < 60 * 5; i += 1) simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Landed,
      `and it is still sitting there five seconds later (${player.status})`,
    );
    assert(
      simulation.statistics.landings === 0,
      "nothing has landed, because nothing has flown",
    );
    assert(
      simulation.statistics.crashes === 0,
      "and nothing has crashed either",
    );
    assertBetween(
      player.altitudeAgl,
      0,
      0.2,
      `resting on the surface, not sunk into it (${player.altitudeAgl.toFixed(3)} m)`,
    );

    // The pilot opens the throttle, which on a multirotor is the whole launch.
    throttle = 1;
    for (let i = 0; i < 60 * 3; i += 1) simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Flying,
      `opening the throttle takes it off (${player.status})`,
    );
    assert(
      player.altitudeAgl > 5,
      `and it climbs away from the spot (${player.altitudeAgl.toFixed(1)} m)`,
    );
  });

  suite("standing on the ground that is drawn, not the one underneath", () => {
    // Photogrammetry draws its own surface a couple of metres off the height
    // field's. In the air that is nothing; on a field it is the difference
    // between standing on the grass and standing inside it, so one deliberate
    // pick of the launch point is adopted outright.
    const calibration = new SurfaceCalibration();
    calibration.prime(1002.2, 1000);
    assertClose(
      calibration.bias,
      2.2,
      1e-9,
      "the correction is applied on the first frame rather than eased in",
    );

    const clamped = new SurfaceCalibration();
    clamped.prime(1040, 1000);
    assertClose(
      clamped.bias,
      3,
      1e-9,
      "and a pick that found a roof is still held to a plausible datum offset",
    );

    const nothing = new SurfaceCalibration();
    nothing.prime(Number.NaN, 1000);
    assertClose(nothing.bias, 0, 1e-9, "a pick that found nothing changes nothing");
  });

  await suite("a launch on rough ground is not a launch inside it", async () => {
    // The bug this exists for: a start point in anything but a flat field sits
    // in a dip, and everything a ground view puts at head height over it — the
    // wing in the launcher's hand, the pilot's own eyes — goes in the dip with
    // it. The flight opens looking at the inside of the ground.
    const terrain = new TerrainField(
      async (points: readonly TerrainQuery[]) =>
        points.map((p) => hollowHeight(p.x, p.y)),
      {
        cellSize: 50,
        warmRadius: 900,
        sampleBudget: 8192,
        detailCellSize: 10,
        detailRadius: 160,
      },
    );
    await terrain.prefill(V.vec3(), 900);

    const aroundWing = highestAround(terrain, 0, 0);
    assert(
      terrain.heightAt(0, 0) + HAND_LAUNCH_AGL < aroundWing,
      "the fixture is the bug: head height over the column is below the ground around it",
    );

    const simulation = makeSimulation(terrain);
    const launch = groundLaunch(PLAYER_WING);
    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        // Exactly what the flight session puts a held wing at.
        position: V.vec3(0, 0, groundUnderfoot(terrain, 0, 0) + launch.altitudeAgl),
        headingDeg: 180,
        pitchDeg: launch.pitchDeg,
        airspeed: launch.airspeed,
        throttle: launch.throttle,
        grounded: launch.grounded,
        held: launch.held,
      },
      () => handsOff(0),
    );

    const opened = player.position.z;
    for (let i = 0; i < 60 * 3; i += 1) simulation.update(1 / 60);
    assertClose(
      player.position.z,
      opened,
      1e-6,
      "the wing is held where it opened rather than dropping into the hollow",
    );
    assert(
      player.position.z > aroundWing,
      `and it is held over the ground around it, not in it (${(player.position.z - aroundWing).toFixed(1)} m clear)`,
    );
    assert(
      simulation.statistics.crashes === 0,
      "waiting on a hillside is not a crash",
    );

    // The pilot behind it, on the same field and clearing the same ground —
    // placed the way the flight session places them, a standoff back along the
    // start heading.
    const heading = 180 * DEG_TO_RAD;
    const px = -Math.sin(heading) * PILOT_STANDOFF;
    const py = -Math.cos(heading) * PILOT_STANDOFF;
    const aroundPilot = highestAround(terrain, px, py);
    assert(
      terrain.heightAt(px, py) + PILOT_EYE_HEIGHT < aroundPilot,
      "a pilot standing on the column alone has their eyes below the rim",
    );
    assert(
      groundUnderfoot(terrain, px, py) + PILOT_EYE_HEIGHT > aroundPilot,
      "and standing on the ground underfoot puts them over it",
    );

    // Still a launch: the throw happens when it is asked for and the wing
    // flies out of it.
    let throttle = 0;
    simulation.setController("player", () => handsOff(throttle));
    throttle = 1;
    for (let i = 0; i < 60 * 4; i += 1) simulation.update(1 / 60);
    assert(
      player.status === FLIGHT_STATUS.Flying,
      `the throw still happens on the throttle (${player.status})`,
    );
    assert(
      player.altitudeAgl > HAND_LAUNCH_AGL,
      `and it climbs away from the hillside (${player.altitudeAgl.toFixed(1)} m)`,
    );
  });

  await suite("a launch in a wood is not a launch under it", async () => {
    // The height field is bare earth everywhere. Where the scene draws a
    // photogrammetry canopy over it, a wing held two metres over the earth is
    // held eleven metres inside the trees, and the pilot beside it is blind.
    // Measured at the reported start point: bare earth 783.3 m, drawn surface
    // 797.1 m.
    const EARTH = 783.3;
    const CANOPY = 797.1;
    const terrain = await flatTerrain();
    const simulation = makeSimulation(terrain);
    const launch = groundLaunch(PLAYER_WING);

    // What the flight session measures out of the scene and hands over.
    simulation.setLaunchSurface(CANOPY - EARTH);
    const earthZ = terrain.heightAt(0, 0);
    const stand = standingSurface(
      earthZ,
      groundUnderfoot(terrain, 0, 0),
      CANOPY - EARTH,
    );

    const player = simulation.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, stand + launch.altitudeAgl),
        headingDeg: 0,
        pitchDeg: launch.pitchDeg,
        airspeed: launch.airspeed,
        throttle: launch.throttle,
        grounded: launch.grounded,
        held: launch.held,
      },
      () => handsOff(0),
    );

    const canopyZ = CANOPY - EARTH;
    assert(
      earthZ + HAND_LAUNCH_AGL < canopyZ,
      "the fixture is the bug: head height over bare earth is inside the wood",
    );

    const opened = player.position.z;
    for (let i = 0; i < 60 * 3; i += 1) simulation.update(1 / 60);
    assertClose(
      player.position.z,
      opened,
      1e-6,
      "the wing stays where it opened rather than sinking into the trees",
    );
    assert(
      player.position.z > canopyZ,
      `and it waits above the canopy, not in it (${(player.position.z - canopyZ).toFixed(1)} m clear)`,
    );
    assertClose(
      player.position.z,
      canopyZ + HAND_LAUNCH_AGL,
      1e-6,
      "at head height over the surface somebody is standing on",
    );

    // The pilot goes with it: they are on the same ground the launcher is.
    assert(
      stand + PILOT_EYE_HEIGHT > canopyZ,
      "the pilot's eyes are over the canopy rather than under it",
    );

    // And nothing measured leaves a flat field exactly as it was.
    const openField = makeSimulation(await flatTerrain());
    openField.setLaunchSurface(null);
    const onGrass = openField.spawn(
      {
        id: "player",
        role: AIRCRAFT_ROLE.Player,
        config: PLAYER_WING,
        position: V.vec3(0, 0, terrain.heightAt(0, 0) + launch.altitudeAgl),
        headingDeg: 0,
        pitchDeg: launch.pitchDeg,
        airspeed: launch.airspeed,
        throttle: launch.throttle,
        grounded: launch.grounded,
        held: launch.held,
      },
      () => handsOff(0),
    );
    for (let i = 0; i < 60; i += 1) openField.update(1 / 60);
    assertClose(
      onGrass.altitudeAgl,
      HAND_LAUNCH_AGL,
      1e-6,
      "an open field is still a wing at head height over the grass",
    );
  });
}
