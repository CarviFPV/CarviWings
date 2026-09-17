import { assert, assertBetween, assertClose, suite } from "./harness";
import { viewMagnification } from "../render/detailBudget";
import { PLAYER_WING, SKYWALKER_X8 } from "../flight/config";
import { PHYSICS_TIMESTEP, stepFlightDynamics } from "../flight/physics";
import type { FlightEnvironment } from "../flight/physics";
import { AIRCRAFT_ROLE, FLIGHT_STATUS, createAircraftState } from "../flight/state";
import type { AircraftState } from "../flight/state";
import type { FlightInput } from "../input/types";
import { createFlightInput } from "../input/types";
import * as V from "../math/vec3";
import {
  MESH_KIND,
  buildAircraftMesh,
  buildBabyBlenderMesh,
  buildGliderMesh,
  buildP38Mesh,
  buildQuadMesh,
  buildTriplaneMesh,
  buildX8Mesh,
  meshKindFor,
} from "../render/aircraftMesh";
import type { MeshPart } from "../render/aircraftMesh";
import { previewTriangles } from "../render/aircraftPreview";
import {
  GATE_TONE,
  buildGateFrame,
  gateCornerRadius,
  gateFrameDepth,
  gateFrameThickness,
} from "../render/raceGateMesh";
import type { GateOpening, GateSlab, GateTone } from "../render/raceGateMesh";

const CALM: FlightEnvironment = { wind: V.vec3(), originHeight: 500 };

function spawn(): AircraftState {
  return createAircraftState({
    id: "test",
    role: AIRCRAFT_ROLE.Player,
    config: PLAYER_WING,
    position: V.vec3(0, 0, 400),
    headingDeg: 0,
    airspeed: 24,
    throttle: 0.6,
  });
}

function hold(state: AircraftState, input: FlightInput, seconds: number): void {
  const steps = Math.round(seconds / PHYSICS_TIMESTEP);
  for (let i = 0; i < steps; i += 1) {
    stepFlightDynamics(state, input, CALM, PHYSICS_TIMESTEP);
  }
}

function control(pitch: number, roll: number): FlightInput {
  const input = createFlightInput();
  input.pitch = pitch;
  input.roll = roll;
  input.throttle = 0.6;
  return input;
}

/** The box a set of parts occupies, in body coordinates. */
function extent(parts: readonly { positions: Float64Array }[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  const box = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const part of parts) {
    for (let i = 0; i < part.positions.length; i += 3) {
      const x = part.positions[i] ?? 0;
      const y = part.positions[i + 1] ?? 0;
      const z = part.positions[i + 2] ?? 0;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
      box.minZ = Math.min(box.minZ, z);
      box.maxZ = Math.max(box.maxZ, z);
    }
  }
  return box;
}

/** Which vertex of a part a position is, with coincident ones merged. */
function weldedVertices(part: MeshPart): number[] {
  const seen = new Map<string, number>();
  const welded: number[] = [];
  for (let i = 0; i < part.positions.length; i += 3) {
    const key = `${(part.positions[i] ?? 0).toFixed(6)},${(
      part.positions[i + 1] ?? 0
    ).toFixed(6)},${(part.positions[i + 2] ?? 0).toFixed(6)}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, welded.length);
      welded.push(welded.length);
    } else {
      welded.push(existing);
    }
  }
  return welded;
}

/**
 * The triangles of a part, grouped into the closed solids among them.
 *
 * A part is whatever pieces happen to share a colour — a wing surface, which
 * is open, and the two fins on the end of it, which are not. Only the closed
 * ones can be asked which way round they are built, so the open ones are found
 * by the edge that has nothing on the other side of it and dropped. Whether a
 * solid is wound consistently is a separate question and deliberately not
 * asked here: a body lofted one way round and capped the other is exactly the
 * fault worth catching, so it has to survive this and fail the check itself.
 *
 * Triangles are returned as their offsets into the index array.
 */
function closedSolids(part: MeshPart): number[][] {
  const welded = weldedVertices(part);
  const at = (i: number): number => welded[part.indices[i] ?? 0] ?? 0;
  // Union-find over the welded vertices: one group per connected piece.
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let root = v;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < part.indices.length; i += 3) {
    parent.set(at(i), find(at(i)));
    union(at(i), at(i + 1));
    union(at(i + 1), at(i + 2));
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < part.indices.length; i += 3) {
    const root = find(at(i));
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }

  const solids: number[][] = [];
  for (const group of groups.values()) {
    // Closed means every edge has a triangle on both sides of it, whichever
    // way round the two of them are wound.
    const edges = new Map<string, number>();
    for (const i of group) {
      for (let e = 0; e < 3; e += 1) {
        const a = at(i + e);
        const b = at(i + ((e + 1) % 3));
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    let closed = true;
    for (const count of edges.values()) {
      if (count !== 2) {
        closed = false;
        break;
      }
    }
    if (closed) solids.push(group);
  }
  return solids;
}

/**
 * True when every triangle of a closed solid agrees which side is outside.
 *
 * Two triangles sharing an edge walk it in opposite directions when they are
 * wound the same way round, so one direction walked twice is a face that has
 * been turned over — which is what a lofted body capped the other way round
 * is, and what a renderer that culls back faces then draws the wrong side of.
 */
function windsConsistently(part: MeshPart, triangles: readonly number[]): boolean {
  const welded = weldedVertices(part);
  const at = (i: number): number => welded[part.indices[i] ?? 0] ?? 0;
  const walked = new Set<string>();
  for (const i of triangles) {
    for (let e = 0; e < 3; e += 1) {
      const key = `${at(i + e)}>${at(i + ((e + 1) % 3))}`;
      if (walked.has(key)) return false;
      walked.add(key);
    }
  }
  return true;
}

/** The volume a closed solid encloses, negative if it is built inside out. */
function signedVolume(part: MeshPart, triangles: readonly number[]): number {
  const corner = (i: number): readonly [number, number, number] => {
    const v = (part.indices[i] ?? 0) * 3;
    return [
      part.positions[v] ?? 0,
      part.positions[v + 1] ?? 0,
      part.positions[v + 2] ?? 0,
    ];
  };
  let total = 0;
  for (const i of triangles) {
    // Six times the volume of the tetrahedron the triangle makes with the
    // origin, which sums over a closed surface to the volume inside it — with
    // the sign of the winding on it.
    const a = corner(i);
    const b = corner(i + 1);
    const c = corner(i + 2);
    total +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) +
        a[1] * (b[2] * c[0] - b[0] * c[2]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return total;
}

/** The openings a course is laid out with, and the start line above them. */
const GATE_OPENINGS: readonly GateOpening[] = [
  { halfWidth: 12, halfHeight: 10 },
  { halfWidth: 26, halfHeight: 20 },
  { halfWidth: 44.2, halfHeight: 34 },
];

/** One box of a gate seen straight down the opening, as a flat rectangle. */
interface FlatSlab {
  readonly tone: GateTone;
  readonly y: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;
  readonly halfAcross: number;
  readonly halfAlong: number;
}

/**
 * The frame flattened onto the plane of the gate.
 *
 * What a pilot has to get through is the silhouette, so every question below
 * is asked of the frame side-on: depth drops out, and the trigonometry that
 * lays each box onto the frame is done once rather than per sample.
 */
function flatten(slabs: readonly GateSlab[]): readonly FlatSlab[] {
  return slabs.map((slab) => ({
    tone: slab.tone,
    y: slab.offset[1],
    z: slab.offset[2],
    cos: Math.cos(slab.roll),
    sin: Math.sin(slab.roll),
    halfAcross: slab.size[1] / 2,
    halfAlong: slab.size[2] / 2,
  }));
}

function covers(slab: FlatSlab, y: number, z: number): boolean {
  const dy = y - slab.y;
  const dz = z - slab.z;
  return (
    Math.abs(dy * slab.cos + dz * slab.sin) <= slab.halfAcross &&
    Math.abs(dz * slab.cos - dy * slab.sin) <= slab.halfAlong
  );
}

function spanOf(opening: GateOpening): string {
  return `${opening.halfWidth * 2}m by ${opening.halfHeight * 2}m`;
}

export function runRenderTests(): void {
  suite("the airframe has moving control surfaces", () => {
    const mesh = buildAircraftMesh();
    assert(mesh.elevonParts.left.length > 0, "there is a left elevon");
    assert(mesh.elevonParts.right.length > 0, "and a right one");

    const left = extent(mesh.elevonParts.left);
    const right = extent(mesh.elevonParts.right);
    assertClose(
      left.maxX,
      0,
      1e-9,
      "the elevon's own frame starts at the hinge, so a rotation is all it takes",
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
      parts.reduce((sum, p) => sum + p.indices.length, 0) / 3;
    assertClose(
      triangles(mesh.staticParts),
      triangles(mesh.parts) +
        triangles(mesh.elevonParts.left) +
        triangles(mesh.elevonParts.right),
      1e-9,
      "the merged airframe drawn for distant contacts loses no geometry",
    );
  });

  suite("the X8 is drawn as an X8", () => {
    const mesh = buildX8Mesh();
    assert(
      meshKindFor(SKYWALKER_X8) === MESH_KIND.X8,
      "the airframe says which aircraft it is drawn as",
    );
    assert(
      meshKindFor(PLAYER_WING) === MESH_KIND.Wing,
      "and the interceptor is still the delta rather than a small X8",
    );
    assert(mesh.kind === MESH_KIND.X8, "it is its own mesh");
    assertClose(
      mesh.referenceSpan,
      SKYWALKER_X8.wingSpan,
      1e-9,
      "drawn at the 2.12 m the airframe actually is",
    );

    const wing = extent(mesh.parts.filter((part) => part.name === "x8-top"));
    assertClose(
      wing.maxY,
      SKYWALKER_X8.wingSpan / 2,
      0.035,
      "the wing itself reaches the half-span, fins aside",
    );
    assertBetween(
      wing.maxX - wing.minX,
      0.36 * mesh.referenceSpan,
      0.44 * mesh.referenceSpan,
      "and it is the length an X8 is for its span: 880 mm on 2120",
    );

    // A swept wing with a root chord half again what the delta carries for its
    // span is most of what makes one of these recognisable from above.
    const pod = extent(mesh.parts.filter((part) => part.name === "x8-pod"));
    assert(
      pod.minZ < -0.05 && pod.maxZ > 0.05,
      "the payload bay hangs well below the wing and stands proud above it",
    );
    assert(
      pod.maxY > 0.08 && pod.maxY < 0.12,
      "and it is the best part of two hundred millimetres across",
    );
    assertClose(
      pod.maxY,
      -pod.minY,
      1e-9,
      "square on the centreline, camera and all",
    );
    const hatch = mesh.parts.find((part) => part.name === "x8-hatch");
    assert(hatch !== undefined, "with the payload hatch let into the top of it");

    const fins = extent(mesh.parts.filter((part) => part.name === "x8-top"));
    assert(
      fins.maxZ > 0.15,
      "the tip fins stand a good 150 mm above the wing",
    );
    assert(
      fins.maxY > SKYWALKER_X8.wingSpan / 2,
      "and are canted outwards, the way the mouldings are",
    );

    assert(mesh.propellers.length === 1, "one pusher");
    const [pusher] = mesh.propellers;
    assert(pusher !== undefined && pusher.axis === "x", "turning about the nose");
    assert(
      (pusher?.origin[0] ?? 0) < -0.35,
      "behind the trailing edge of the centre section, where an X8 puts it",
    );
    const disc = extent(pusher?.parts ?? []);
    assertBetween(
      disc.maxZ,
      0.14,
      0.16,
      "and it is the twelve-inch propeller the airframe is delivered with",
    );

    assert(
      mesh.fpvCamera.offset[0] > 0.38,
      "the camera is in the nose of the pod",
    );
    assertBetween(
      mesh.fpvCamera.tiltDegrees,
      0,
      12,
      "and barely tilted, because a survey wing cruises nearly level",
    );
  });

  suite("the X8's elevons are the outer trailing edge", () => {
    const mesh = buildX8Mesh();
    assert(
      mesh.elevonParts.left.length > 0 && mesh.elevonParts.right.length > 0,
      "there is a surface a side",
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
    assert(
      left.maxY < mesh.referenceSpan / 2 - 0.1,
      "stopping short of the tip, which is the panel the fin is bolted through",
    );
    assert(
      mesh.elevonParts.left.some((part) => part.shade < 1),
      "and the underside of one is the shade the underside of the wing is",
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
    assert(mesh.triangleCount > 400, "there is an aircraft there to look at");

    const picture = previewTriangles({
      azimuthDeg: 34,
      elevationDeg: 22,
      width: 240,
      height: 160,
      kind: MESH_KIND.X8,
    });
    assert(picture.length > 200, "and the workbench can draw a picture of it");
  });

  suite("every face points out of the aircraft it is on", () => {
    // A picture of an aircraft on the bench is drawn with the faces turned
    // away from the camera thrown out, so a part built inside out does not
    // look wrong — it disappears, and what is drawn instead is the far wall of
    // it. Every closed piece of every airframe is checked the one way that
    // catches it: a solid wound outwards encloses a positive volume.
    for (const [name, mesh] of [
      ["the interceptor", buildAircraftMesh()],
      ["the X8", buildX8Mesh()],
      ["the quadcopter", buildQuadMesh()],
      ["the glider", buildGliderMesh()],
      ["the triplane", buildTriplaneMesh()],
      ["the P-38", buildP38Mesh()],
      ["the Baby Blender", buildBabyBlenderMesh()],
    ] as const) {
      let solids = 0;
      let inverted = 0;
      const parts = [
        ...mesh.parts,
        ...mesh.elevonParts.left,
        ...mesh.elevonParts.right,
        ...mesh.propellers.flatMap((group) => group.parts),
      ];
      for (const part of parts) {
        for (const solid of closedSolids(part)) {
          solids += 1;
          if (!windsConsistently(part, solid)) inverted += 1;
          else if (signedVolume(part, solid) <= 0) inverted += 1;
        }
      }
      assert(solids > 4, `${name} is built out of solid pieces`);
      assert(
        inverted === 0,
        `and every one of ${name}'s is wound the right way out`,
      );
    }
  });

  suite("elevons follow the pilot", () => {
    const neutral = spawn();
    hold(neutral, control(0, 0), 1);
    assertClose(neutral.elevonLeft, 0, 1e-6, "hands off, the surfaces centre");
    assertClose(neutral.elevonRight, 0, 1e-6, "both of them");

    const pitching = spawn();
    hold(pitching, control(1, 0), 0.6);
    assert(pitching.elevonLeft > 0.3, "pulling back raises the left surface");
    assertClose(
      pitching.elevonRight,
      pitching.elevonLeft,
      1e-6,
      "and the right one by the same amount, which is what pitches a wing",
    );

    const rolling = spawn();
    hold(rolling, control(0, 1), 0.6);
    assert(
      rolling.elevonRight > 0.3 && rolling.elevonLeft < -0.3,
      "rolling right raises the right surface and drops the left",
    );
    assertClose(
      rolling.elevonRight,
      -rolling.elevonLeft,
      1e-6,
      "symmetrically, which is what rolls it",
    );

    const both = spawn();
    hold(both, control(1, 1), 0.6);
    assert(
      both.elevonRight > both.elevonLeft,
      "pitch and roll together deflect the two surfaces differently",
    );
    for (const value of [both.elevonLeft, both.elevonRight]) {
      assertBetween(
        value,
        -0.39,
        0.39,
        "and neither exceeds the servo's travel",
      );
    }
  });

  suite("the surfaces take time to move", () => {
    const state = spawn();
    hold(state, control(1, 0), 0.02);
    const early = state.elevonLeft;
    assert(
      early > 0 && early < 0.35,
      "a full-deflection command does not snap the surface across instantly",
    );
    hold(state, control(1, 0), 0.5);
    assert(
      state.elevonLeft > early,
      "but it keeps moving until it gets there",
    );
  });

  suite("a wrecked aircraft stops flying its surfaces", () => {
    const state = spawn();
    hold(state, control(1, 1), 0.5);
    assert(Math.abs(state.elevonRight) > 0.1, "deflected while flying");
    state.status = FLIGHT_STATUS.Crashing;
    hold(state, control(1, 1), 0.6);
    assertClose(
      state.elevonRight,
      0,
      1e-6,
      "and centred once nobody is flying it",
    );
  });

  suite("a race gate frames a clear opening", () => {
    for (const opening of GATE_OPENINGS) {
      const frame = flatten(buildGateFrame(opening));
      const span = spanOf(opening);

      // The largest ellipse the opening holds. What the clock scores is the
      // rectangle around it, so anything drawn inside here would be scenery
      // the pilot flew through and was credited for.
      let blocked = 0;
      for (let i = 0; i < 96; i += 1) {
        const angle = (i / 96) * Math.PI * 2;
        for (let step = 0; step <= 10; step += 1) {
          const out = (step / 10) * 0.995;
          const y = Math.cos(angle) * opening.halfWidth * out;
          const z = Math.sin(angle) * opening.halfHeight * out;
          if (frame.some((slab) => covers(slab, y, z))) blocked += 1;
        }
      }
      assert(blocked === 0, `the opening of a ${span} gate is clear`);

      // The rounding takes the corners and nothing else: between them the
      // opening is open to its full height.
      const radius = gateCornerRadius(opening);
      let clipped = 0;
      for (let i = -40; i <= 40; i += 1) {
        const y = ((opening.halfWidth - radius * 1.1) * i) / 40;
        for (const sz of [1, -1]) {
          const z = sz * opening.halfHeight * 0.995;
          if (frame.some((slab) => covers(slab, y, z))) clipped += 1;
        }
      }
      assert(
        clipped === 0,
        `and a ${span} gate is open to its full height between the corners`,
      );
    }
  });

  suite("the frame closes round the gate", () => {
    for (const opening of GATE_OPENINGS) {
      const frame = flatten(buildGateFrame(opening));
      const thickness = gateFrameThickness(opening.halfWidth);
      const reach =
        Math.hypot(opening.halfWidth, opening.halfHeight) + thickness * 2;
      const span = spanOf(opening);

      // Every way out of the opening crosses the frame. A gate is built from
      // one outline drawn at four distances from the opening, and a corner
      // where two boxes failed to meet would be a slot of daylight through the
      // side of it.
      let gaps = 0;
      let bare = 0;
      let split = 0;
      for (let i = 0; i < 96; i += 1) {
        const angle = ((i + 0.5) / 96) * Math.PI * 2;
        const cy = Math.cos(angle);
        const cz = Math.sin(angle);
        let banded = false;
        let edged = false;
        let started = false;
        let daylight = false;
        let broken = false;
        for (let r = 0; r <= reach; r += 0.05) {
          let hit = false;
          let trim = false;
          for (const slab of frame) {
            if (!covers(slab, cy * r, cz * r)) continue;
            hit = true;
            if (slab.tone === GATE_TONE.Band) banded = true;
            if (slab.tone === GATE_TONE.Trim) trim = true;
          }
          if (!hit) {
            if (started) daylight = true;
            continue;
          }
          // Coming back onto the frame after leaving it means the layers have
          // pulled apart somewhere, which is a slot of sky through the side of
          // the gate rather than a frame.
          if (daylight) broken = true;
          started = true;
          edged = trim;
        }
        if (!banded) gaps += 1;
        if (!edged) bare += 1;
        if (broken) split += 1;
      }
      assert(gaps === 0, `a ${span} gate is banded the whole way round`);
      assert(
        bare === 0,
        `and its dark edge is the last of it, whichever way out`,
      );
      assert(
        split === 0,
        `and a ${span} gate is solid across the frame, with no sky through it`,
      );
    }
  });

  suite("a gate is a band, a liner and a dark edge", () => {
    const opening = GATE_OPENINGS[1] as GateOpening;
    const slabs = buildGateFrame(opening);
    const depth = gateFrameDepth(opening.halfWidth);
    const band = slabs.filter((slab) => slab.tone === GATE_TONE.Band);
    const liner = slabs.filter((slab) => slab.tone === GATE_TONE.Liner);
    const trim = slabs.filter((slab) => slab.tone === GATE_TONE.Trim);

    assert(
      band.length > 0 && liner.length > 0 && trim.length > 0,
      "every gate is all three",
    );
    assert(
      band.every((slab) => Math.abs(slab.size[0] - depth) < 1e-9),
      "the band is the depth of the frame",
    );
    assert(
      liner.every((slab) => Math.abs(slab.offset[0]) > depth / 2),
      "and the liner stands proud of it rather than lining the tunnel through",
    );
    assertClose(
      liner.reduce((sum, slab) => sum + slab.offset[0], 0),
      0,
      1e-9,
      "on the face a pilot arrives at and the one they leave by alike",
    );

    assertClose(
      gateFrameThickness(1),
      gateFrameThickness(2),
      1e-9,
      "the tightest gate still gets a frame thick enough to see",
    );
    assert(
      gateFrameThickness(26) > gateFrameThickness(12),
      "a wider gate gets a heavier frame, so it reads the same at range",
    );
    assertClose(
      gateFrameThickness(400),
      gateFrameThickness(4000),
      1e-9,
      "and past a point it stops growing, because a gate is not a wall",
    );
  });

  suite("a zoomed view does not quietly ask for more world", () => {
    // The ground view's own two ends: the eye wide open on a model close in,
    // and shut down on one at the far side of the field.
    const wide = 65;
    const narrow = 15;

    assertClose(
      viewMagnification(wide, wide),
      1,
      1e-9,
      "a view that is not narrowed magnifies nothing",
    );
    assertClose(
      viewMagnification(narrow, wide),
      Math.tan((wide / 2) * (Math.PI / 180)) /
        Math.tan((narrow / 2) * (Math.PI / 180)),
      1e-9,
      "and one that is narrowed magnifies by the ratio of the half-angles",
    );
    assertBetween(
      viewMagnification(narrow, wide),
      4.8,
      4.9,
      "which at the ends of the ground view's zoom is about five times over",
    );

    // The renderer's threshold is relaxed by exactly this, so the tile chosen
    // at the narrow end is the tile that was chosen at the wide one.
    const sse = 2;
    assertClose(
      sse * viewMagnification(narrow, wide) * Math.tan((narrow / 2) * (Math.PI / 180)),
      sse * Math.tan((wide / 2) * (Math.PI / 180)),
      1e-9,
      "threshold times half-angle is what decides a tile, and it does not move",
    );

    assert(
      viewMagnification(40, wide) > 1 &&
        viewMagnification(40, wide) < viewMagnification(narrow, wide),
      "halfway out is halfway between, rather than a step at either end",
    );

    assertClose(
      viewMagnification(90, wide),
      1,
      1e-9,
      "a view wider than the plain one is never a reason to draw more world",
    );
    for (const bad of [0, -10, 180, 400, Number.NaN, Number.POSITIVE_INFINITY]) {
      assertClose(
        viewMagnification(bad, wide),
        1,
        1e-9,
        `an angle of ${bad} changes nothing`,
      );
      assertClose(
        viewMagnification(narrow, bad),
        1,
        1e-9,
        `and neither does a plain view of ${bad}`,
      );
    }
  });
}
