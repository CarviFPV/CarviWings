import { assert, assertClose, suite } from "./harness";
import {
  clampToViewportEdge,
  isOnScreen,
  targetScreenDirection,
} from "../hud/targetTracking";
import {
  MINIMAP_ORIENTATION,
  minimapHeadingRotation,
  minimapRangeRings,
  projectToMinimap,
} from "../hud/minimapProjection";
import type { MinimapProjection } from "../hud/minimapProjection";
import { Simulation } from "../engine/simulation";
import { EnuFrame } from "../geo/enuFrame";
import { LOCATION_PRESETS } from "../geo/locations";
import { PLAYER_WING } from "../flight/config";
import { AIRCRAFT_ROLE, FLIGHT_STATUS } from "../flight/state";
import { TerrainField } from "../terrain/terrainField";
import type { TerrainQuery } from "../terrain/types";
import { RAD_TO_DEG } from "../math/scalar";
import * as V from "../math/vec3";

// Camera flying north, level: forward = +Y, up = +Z, right = +X.
const CAM_POSITION = V.vec3(0, 0, 500);
const CAM_FORWARD = V.vec3(0, 1, 0);
const CAM_UP = V.vec3(0, 0, 1);
const CAM_RIGHT = V.vec3(1, 0, 0);

function direction(x: number, y: number, z: number) {
  return targetScreenDirection(
    CAM_POSITION,
    CAM_FORWARD,
    CAM_UP,
    CAM_RIGHT,
    V.vec3(x, y, z),
  );
}

export async function runHudTests(): Promise<void> {
  suite("target screen direction", () => {
    const ahead = direction(0, 1000, 500);
    assert(ahead.inFront, "a target down the nose is in front");
    assertClose(Math.hypot(ahead.x, ahead.y), 0, 1e-9, "dead ahead has no offset");

    const right = direction(400, 1000, 500);
    assert(right.inFront, "a target ahead and right is in front");
    assert(right.x > 0.9, "a target to the right reads right on screen");
    assertClose(right.y, 0, 1e-9, "a level target has no vertical offset");

    const above = direction(0, 1000, 900);
    assert(above.y < -0.9, "a target above reads upward (screen Y is down)");

    const below = direction(0, 1000, 100);
    assert(below.y > 0.9, "a target below reads downward");

    // The projection inverts behind the camera; the sign must not.
    const behindRight = direction(400, -1000, 500);
    assert(!behindRight.inFront, "a target astern is not in front");
    assert(
      behindRight.x > 0.9,
      "a target behind and to the right still reads 'turn right'",
    );

    const dead = direction(0, -1000, 500);
    assert(!dead.inFront, "a target directly astern is not in front");
    assertClose(dead.y, 1, 1e-9, "directly astern points down by convention");

    const unit = direction(300, 500, 700);
    assertClose(
      Math.hypot(unit.x, unit.y),
      1,
      1e-9,
      "the screen direction is a unit vector",
    );
  });

  suite("viewport edge clamping", () => {
    const width = 1280;
    const height = 800;
    // Wider inset on the sides, where the OSD columns live.
    const insetX = 168;
    const insetY = 80;

    const right = clampToViewportEdge(width, height, insetX, insetY, 1, 0);
    assertClose(right.x, width - insetX, 1e-9, "due right stops inboard of the OSD column");
    assertClose(right.y, height / 2, 1e-9, "due right stays vertically centred");

    const up = clampToViewportEdge(width, height, insetX, insetY, 0, -1);
    assertClose(up.x, width / 2, 1e-9, "due up stays horizontally centred");
    assertClose(up.y, insetY, 1e-9, "due up lands on the top inset");

    // A diagonal must stop at whichever edge it reaches first.
    const diagonal = clampToViewportEdge(width, height, insetX, insetY, 0.707, 0.707);
    assertClose(diagonal.y, height - insetY, 1e-6, "the diagonal hits the short edge");
    assert(diagonal.x < width - insetX, "and stops short of the long edge");

    const inside = clampToViewportEdge(width, height, insetX, insetY, 0, 0);
    assertClose(inside.x, width / 2, 1e-9, "a degenerate direction stays centred");

    // The indicator must never overlap the OSD gutters.
    for (const angle of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
      const radians = (angle * Math.PI) / 180;
      const point = clampToViewportEdge(
        width,
        height,
        insetX,
        insetY,
        Math.sin(radians),
        -Math.cos(radians),
      );
      assert(
        point.x >= insetX - 1e-6 && point.x <= width - insetX + 1e-6,
        `bearing ${angle} stays clear of the side gutters`,
      );
      assert(
        point.y >= insetY - 1e-6 && point.y <= height - insetY + 1e-6,
        `bearing ${angle} stays inside the vertical inset`,
      );
    }

    assert(isOnScreen(640, 400, width, height, 48), "the centre is on screen");
    assert(!isOnScreen(10, 400, width, height, 48), "the far left edge is not");
    assert(!isOnScreen(640, 795, width, height, 48), "the bottom edge is not");
  });

  suite("minimap projection", () => {
    const northUp: MinimapProjection = {
      playerX: 0,
      playerY: 0,
      headingDeg: 0,
      metresPerPixel: 10,
      orientation: MINIMAP_ORIENTATION.NorthUp,
    };

    const north = projectToMinimap(northUp, 0, 1000);
    assertClose(north.x, 0, 1e-9, "1 km north has no lateral offset");
    assertClose(north.y, -100, 1e-9, "1 km north is 100 px up the map");

    const east = projectToMinimap(northUp, 1000, 0);
    assertClose(east.x, 100, 1e-9, "1 km east is 100 px right");
    assertClose(east.y, 0, 1e-9, "1 km east has no vertical offset");

    // Heading up with the nose north must agree with north up.
    const headingNorth: MinimapProjection = {
      ...northUp,
      orientation: MINIMAP_ORIENTATION.HeadingUp,
    };
    const same = projectToMinimap(headingNorth, 1000, 1000);
    const reference = projectToMinimap(northUp, 1000, 1000);
    assertClose(same.x, reference.x, 1e-9, "heading 000 matches north up (x)");
    assertClose(same.y, reference.y, 1e-9, "heading 000 matches north up (y)");

    // Flying east: things to the east are ahead, things north are to port.
    const headingEast: MinimapProjection = {
      ...northUp,
      headingDeg: 90,
      orientation: MINIMAP_ORIENTATION.HeadingUp,
    };
    const ahead = projectToMinimap(headingEast, 1000, 0);
    assertClose(ahead.x, 0, 1e-9, "flying east, an eastern contact is dead ahead");
    assertClose(ahead.y, -100, 1e-9, "and 100 px up the map");

    const port = projectToMinimap(headingEast, 0, 1000);
    assertClose(port.x, -100, 1e-9, "flying east, a northern contact is to port");
    assertClose(port.y, 0, 1e-9, "and level with the aircraft");

    // The map is centred on the player wherever it is.
    const offset: MinimapProjection = {
      ...northUp,
      playerX: 5000,
      playerY: -3000,
    };
    const centred = projectToMinimap(offset, 5000, -3000);
    assertClose(Math.hypot(centred.x, centred.y), 0, 1e-9, "the player sits at the centre");

    // Symbol rotation.
    assertClose(
      minimapHeadingRotation(northUp, 90) * RAD_TO_DEG,
      90,
      1e-9,
      "north up rotates symbols by their absolute heading",
    );
    assertClose(
      minimapHeadingRotation(headingEast, 90) * RAD_TO_DEG,
      0,
      1e-9,
      "heading up rotates symbols relative to the player",
    );
    assertClose(
      minimapHeadingRotation(headingEast, 180) * RAD_TO_DEG,
      90,
      1e-9,
      "a contact heading south reads 90 deg right of an eastbound player",
    );

    const rings = minimapRangeRings(3000);
    assert(rings.length === 3, "three range rings");
    assertClose(rings[0]!, 3000, 1e-9, "the outer ring is the full range");
  });

  await suite("target selection", async () => {
    const preset = LOCATION_PRESETS[0]!;
    const frame = new EnuFrame({
      latitude: preset.latitude,
      longitude: preset.longitude,
      height: 2000,
    });
    const terrain = new TerrainField(
      async (points: readonly TerrainQuery[]) => points.map(() => -2000),
      { cellSize: 100 },
    );
    await terrain.prefill(V.vec3(), 3000);

    const simulation = new Simulation({
      frame,
      terrain,
      missionRadius: 20000,
    });

    const player = simulation.spawn({
      id: "player",
      role: AIRCRAFT_ROLE.Player,
      config: PLAYER_WING,
      position: V.vec3(0, 0, 500),
      headingDeg: 0,
      airspeed: 25,
      throttle: 0.7,
    });

    assert(simulation.target === null, "nothing is tracked with no contacts");
    assert(simulation.enemyCount === 0, "no enemies at the start");

    const far = simulation.spawn({
      id: "far",
      role: AIRCRAFT_ROLE.Enemy,
      config: PLAYER_WING,
      position: V.vec3(0, 2000, 500),
      headingDeg: 180,
      airspeed: 24,
      throttle: 0.6,
    });
    const near = simulation.spawn({
      id: "near",
      role: AIRCRAFT_ROLE.Enemy,
      config: PLAYER_WING,
      position: V.vec3(0, 600, 500),
      headingDeg: 180,
      airspeed: 24,
      throttle: 0.6,
    });

    simulation.update(1 / 60);
    assert(simulation.enemyCount === 2, "both contacts are counted");
    assert(simulation.target?.id === "near", "the nearest contact is tracked");

    const telemetry = simulation.telemetry();
    assert(telemetry.targetDistance !== undefined, "telemetry reports target range");
    assertClose(
      telemetry.targetDistance ?? 0,
      V.distance(player.position, near.position),
      1,
      "target range matches the actual separation",
    );
    assertClose(
      telemetry.targetBearing ?? -1,
      0,
      6,
      "a contact due north bears roughly 000",
    );

    assert(
      simulation.targetPosition().count === 2,
      "the HUD is told how many contacts there are to choose between",
    );
    assert(
      simulation.targetPosition().index === 1,
      "and that the nearest is the one boxed",
    );

    simulation.cycleTarget();
    assert(simulation.target?.id === "far", "cycling steps to the next contact");
    assert(
      simulation.targetPosition().index === 2,
      "and the readout follows it, so the pilot can see the selection move",
    );
    simulation.cycleTarget();
    assert(simulation.target?.id === "near", "cycling wraps back around");
    assert(simulation.targetPosition().index === 1, "and so does the readout");

    // Losing the tracked contact must fall back rather than leave a dead lock.
    near.status = FLIGHT_STATUS.Destroyed;
    simulation.update(1 / 60);
    assert(simulation.enemyCount === 1, "a destroyed contact stops counting");
    assert(simulation.target?.id === "far", "tracking falls back to what is left");

    assert(
      simulation.targetPosition().count === 1,
      "a destroyed contact drops out of the count too",
    );

    far.status = FLIGHT_STATUS.Destroyed;
    simulation.update(1 / 60);
    assert(simulation.target === null, "nothing is tracked once all are gone");
    assert(
      simulation.targetPosition().index === 0,
      "and the readout says so rather than pointing at a wreck",
    );
    assert(
      simulation.telemetry().targetDistance === undefined,
      "telemetry drops the target readout",
    );
  });
}
