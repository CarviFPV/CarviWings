/**
 * Procedural geometry for the FPV flying wing.
 *
 * Modelled on the airframe in `FPV.png`: a swept delta with sharply upturned
 * wingtips, a compact centre pod bulging below the wing, a rear pusher
 * propeller, an FPV camera at the nose, and orange marker tape across the wing
 * roots.
 *
 * Output is plain typed arrays grouped by colour. Nothing here imports Cesium
 * so the shape is defined once and could be handed to any renderer.
 *
 * Body frame (metres): X = forward, Y = left, Z = up. Origin at the centre of
 * gravity, roughly a third of the way back along the root chord.
 */

import type { AircraftConfig } from "../flight/config";
import type { Livery } from "../flight/livery";
import { rgbOf } from "../flight/livery";

/**
 * Wing span of the airframe this planform was drawn from, metres.
 *
 * A wing that is a different shape of wing gets geometry of its own; one that
 * is only a different size of this one is this one scaled, and this is what it
 * is scaled from. Kept here because it is a property of the geometry rather
 * than of any aircraft: change the stations and this changes with them.
 */
export const MESH_WING_SPAN = 1.4;

/**
 * Propeller tip to propeller tip across the diagonal of the quadcopter this
 * geometry was drawn from, metres. The multirotor's equivalent of the span
 * above, and used the same way.
 */
export const MESH_QUAD_SPAN = 0.249;

/**
 * Wing span of the foam glider this geometry was drawn from, metres. The
 * third airframe's equivalent of the two above, and used the same way.
 */
export const MESH_GLIDER_SPAN = 0.48;

/**
 * Wing span of the Skywalker X8 this geometry was drawn from, metres.
 *
 * The airframe's own span rather than a convenient number: the X8 is drawn at
 * the size it is sold at, so a renderer handed the aircraft's 2.12 m scales
 * the mesh by exactly one.
 */
export const MESH_X8_SPAN = 2.12;

/**
 * Propeller tip to propeller tip across the diagonal of the X10 Interceptor,
 * metres. The rocket's equivalent of the four above, and used the same way.
 *
 * Its widest dimension rather than its longest: the body is 560 mm and the
 * propeller arc is 337 mm across, and it is the arc that every other airframe
 * here is measured by.
 */
export const MESH_ROCKET_SPAN = 0.337;

/** The airframes there is geometry for. */
export const MESH_KIND = {
  Wing: "wing",
  Quad: "quad",
  Glider: "glider",
  X8: "x8",
  Rocket: "rocket",
  Skyeye: "skyeye",
} as const;

export type MeshKind = (typeof MESH_KIND)[keyof typeof MESH_KIND];

/**
 * What decides a part's colour once the aircraft is painted.
 *
 * The geometry is one airframe and the paint is the pilot's, so each part says
 * which of the two livery colours it wears rather than carrying a colour that
 * cannot be changed. `Fixed` is for the parts that are not paint at all — the
 * motor bell, the camera lens — which stay what they are whatever the wing is
 * covered in.
 */
export const PAINT = {
  Shell: "shell",
  Accent: "accent",
  Fixed: "fixed",
} as const;

export type PaintRole = (typeof PAINT)[keyof typeof PAINT];

export interface MeshPart {
  readonly name: string;
  /** Linear RGB in 0..1, as the airframe is delivered. */
  readonly color: readonly [number, number, number];
  /** Which livery colour this part wears, if either. */
  readonly paint: PaintRole;
  /**
   * How much of that colour it wears, 0..1.
   *
   * The underside of a wing is not the same grey as the top of it, and a
   * livery that painted both the identical colour would flatten the airframe
   * into a silhouette. The shades are the ratios the delivered palette already
   * has, so painting the shell moves every panel together and keeps the shape
   * readable.
   */
  readonly shade: number;
  readonly positions: Float64Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
}

/**
 * One propeller, in its own frame, and where it is bolted on.
 *
 * A wing has a single pusher on the back and a quadcopter has four discs on
 * arms turning about a different axis in opposite directions, so a propeller is
 * described rather than assumed: the renderer spins each group about the axis
 * it says, at the hub it says, and nothing else has to know which airframe it
 * is drawing.
 */
export interface PropellerGroup {
  readonly name: string;
  /** Hub position in body coordinates. */
  readonly origin: readonly [number, number, number];
  /** Body axis the disc turns about: forward for a wing, up for a rotor. */
  readonly axis: "x" | "z";
  /** Which way round it turns. Adjacent rotors on a quadcopter disagree. */
  readonly direction: 1 | -1;
  readonly parts: readonly MeshPart[];
}

export interface AircraftMesh {
  /** Which airframe this geometry is. */
  readonly kind: MeshKind;
  /**
   * Width the geometry was drawn at, metres.
   *
   * There is one mesh per kind of airframe and there are several airframes of
   * each kind, so a renderer draws one of a different size by scaling this.
   */
  readonly referenceSpan: number;
  readonly parts: readonly MeshPart[];
  /** Every propeller on the airframe, each in its own local frame. */
  readonly propellers: readonly PropellerGroup[];
  /** Elevon surfaces, each in a frame whose origin is on its hinge line. */
  readonly elevonParts: {
    readonly left: readonly MeshPart[];
    readonly right: readonly MeshPart[];
  };
  /**
   * Where an elevon's hinge sits in body coordinates.
   *
   * The hinge line is a constant body X, so the axis is spanwise and a single
   * rotation deflects the whole surface. Its height is taken at mid-elevon
   * span: the wing has a little dihedral, so a straight axis cannot follow the
   * hinge exactly, and splitting the difference keeps the worst-case gap at
   * full deflection under a centimetre on a 1.4 m span.
   */
  readonly elevonOrigin: readonly [number, number, number];
  /**
   * The airframe with its elevons merged in at neutral, in body coordinates.
   *
   * Aircraft whose control surfaces are never going to be resolvable are drawn
   * from this instead, which is one primitive rather than three. A flight of
   * twenty contacts is the difference between eighty draw calls and forty.
   */
  readonly staticParts: readonly MeshPart[];
  /** Where the FPV camera sits and which way it looks. */
  readonly fpvCamera: {
    readonly offset: readonly [number, number, number];
    /** Upward tilt of the camera in degrees, as an FPV pilot would set it. */
    readonly tiltDegrees: number;
  };
  readonly triangleCount: number;
}

// --- Palette taken from the photographed airframe ---------------------------
const SHELL_TOP: readonly [number, number, number] = [0.19, 0.2, 0.22];
const SHELL_BOTTOM: readonly [number, number, number] = [0.13, 0.14, 0.15];
const POD: readonly [number, number, number] = [0.16, 0.17, 0.19];
const ACCENT: readonly [number, number, number] = [1.0, 0.42, 0.05];
const MOTOR: readonly [number, number, number] = [0.08, 0.08, 0.09];
const LENS: readonly [number, number, number] = [0.05, 0.08, 0.12];

/** How dark each shell panel is against the top surface. */
const BOTTOM_SHADE = 0.69;
const POD_SHADE = 0.85;

type Point = readonly [number, number, number];

class PartBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly indices: number[] = [];
  readonly name: string;
  readonly color: readonly [number, number, number];
  readonly paint: PaintRole;
  readonly shade: number;

  constructor(
    name: string,
    color: readonly [number, number, number],
    paint: PaintRole = PAINT.Fixed,
    shade = 1,
  ) {
    this.name = name;
    this.color = color;
    this.paint = paint;
    this.shade = shade;
  }

  private pushVertex(p: Point, n: Point): number {
    const index = this.positions.length / 3;
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    return index;
  }

  /** Flat-shaded triangle; winding a-b-c defines the outward face. */
  triangle(a: Point, b: Point, c: Point): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const n: Point = [nx, ny, nz];
    const i0 = this.pushVertex(a, n);
    const i1 = this.pushVertex(b, n);
    const i2 = this.pushVertex(c, n);
    this.indices.push(i0, i1, i2);
  }

  quad(a: Point, b: Point, c: Point, d: Point): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  /**
   * A flat panel given its outline and a thickness along `axis`.
   *
   * Which way round the outline was drawn is not the caller's problem: a fin
   * and its mirror image are the same fin, and asking every call site to wind
   * one of them backwards is how a panel ends up inside out. The outline is
   * reversed here when it needs to be, so the faces of the finished plate
   * always point out of it.
   *
   * It matters because a renderer that culls back faces — which is what a
   * picture of the aircraft on a bench is drawn by — throws away the side of
   * an inside-out plate that is being looked at and keeps the one behind it.
   */
  plate(outline: readonly Point[], thickness: number, axis: 0 | 1 | 2): void {
    const half = thickness / 2;
    // Signed area of the outline in the plane the panel lies in. Its sign is
    // which way along the axis the front face would come out pointing.
    const u = ((axis + 1) % 3) as 0 | 1 | 2;
    const v = ((axis + 2) % 3) as 0 | 1 | 2;
    let area = 0;
    for (let i = 0; i < outline.length; i += 1) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      area += a[u] * b[v] - b[u] * a[v];
    }
    const wound = area < 0 ? outline.slice().reverse() : outline;
    const front = wound.map((p) => {
      const q: [number, number, number] = [p[0], p[1], p[2]];
      q[axis] += half;
      return q as Point;
    });
    const back = wound.map((p) => {
      const q: [number, number, number] = [p[0], p[1], p[2]];
      q[axis] -= half;
      return q as Point;
    });
    for (let i = 1; i + 1 < wound.length; i += 1) {
      this.triangle(front[0]!, front[i]!, front[i + 1]!);
      this.triangle(back[0]!, back[i + 1]!, back[i]!);
    }
    for (let i = 0; i < wound.length; i += 1) {
      const j = (i + 1) % wound.length;
      this.quad(front[i]!, back[i]!, back[j]!, front[j]!);
    }
  }

  /** An axis-aligned box, given its two opposite corners. */
  box(min: Point, max: Point): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const p = (x: number, y: number, z: number): Point => [x, y, z];
    // Each face wound so its normal points out of the box.
    this.quad(p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), p(x0, y0, z1));
    this.quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0));
    this.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1));
    this.quad(p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), p(x0, y0, z0));
    this.quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0));
    this.quad(p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), p(x0, y0, z0));
  }

  /** A capped cylinder standing along the body up axis. */
  column(
    centreX: number,
    centreY: number,
    bottom: number,
    top: number,
    radius: number,
    segments = 8,
  ): void {
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const x0 = centreX + Math.cos(a0) * radius;
      const y0 = centreY + Math.sin(a0) * radius;
      const x1 = centreX + Math.cos(a1) * radius;
      const y1 = centreY + Math.sin(a1) * radius;
      this.quad([x0, y0, bottom], [x1, y1, bottom], [x1, y1, top], [x0, y0, top]);
      this.triangle([centreX, centreY, top], [x0, y0, top], [x1, y1, top]);
      this.triangle([centreX, centreY, bottom], [x1, y1, bottom], [x0, y0, bottom]);
    }
  }

  build(): MeshPart | null {
    if (this.indices.length === 0) return null;
    return {
      name: this.name,
      color: this.color,
      paint: this.paint,
      shade: this.shade,
      positions: new Float64Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint16Array(this.indices),
    };
  }
}

// --- Planform ---------------------------------------------------------------

interface Station {
  /** Half-span position, metres (positive = left wing). */
  y: number;
  /** Leading edge, body X. */
  leading: number;
  /** Trailing edge, body X. */
  trailing: number;
  /** Section thickness. */
  thickness: number;
  /** Vertical offset of the chord line (dihedral). */
  z: number;
}

/**
 * One flying wing's outline, as everything that lofts one needs to know.
 *
 * There is more than one flying wing in the hangar and they are not the same
 * shape: the interceptor is a 1.4 m delta with its elevons running out to the
 * tip, and the Skywalker X8 is a 2.12 m survey wing with a deeper root, less
 * taper and a fixed panel at the tip for its fin to stand on. The loft, the
 * hinge arithmetic and the trailing-edge closures are identical on both, so
 * they are written once here and each airframe is a set of numbers rather than
 * a second copy of the same three hundred lines.
 */
interface Planform {
  /** Root-to-tip stations describing the shape. */
  readonly stations: readonly Station[];
  /** Chord fractions sampled across each section, nose to tail. */
  readonly chordSamples: readonly number[];
  /**
   * The elevon hinge, at a constant body X so the axis is spanwise.
   *
   * A flying wing has no separate elevator or ailerons: one surface per side
   * does both jobs, moving together for pitch and apart for roll, which is what
   * the flight model already commands.
   */
  readonly hingeX: number;
  /**
   * Height of the hinge, taken at mid-elevon span.
   *
   * A wing has a little dihedral, so a straight axis cannot follow the hinge
   * exactly, and splitting the difference keeps the worst-case gap at full
   * deflection under a centimetre.
   */
  readonly hingeZ: number;
  /** Station index where the elevons begin, just outboard of the pod. */
  readonly firstElevonStation: number;
  /** Station index where they end, which need not be the tip. */
  readonly lastElevonStation: number;
  /** Chord fractions across the elevon itself, hinge to trailing edge. */
  readonly elevonSamples: readonly number[];
  /** Upper surface of the section, as a fraction of thickness. */
  readonly upper: (fraction: number) => number;
  /** Lower surface, flatter than the top as a flying-wing section is. */
  readonly lower: (fraction: number) => number;
}

/** Root-to-tip stations describing the swept planform seen in the photo. */
const STATIONS: readonly Station[] = [
  { y: 0.0, leading: 0.3, trailing: -0.25, thickness: 0.055, z: 0.0 },
  { y: 0.11, leading: 0.27, trailing: -0.25, thickness: 0.05, z: 0.002 },
  { y: 0.26, leading: 0.17, trailing: -0.25, thickness: 0.038, z: 0.008 },
  { y: 0.42, leading: 0.06, trailing: -0.25, thickness: 0.026, z: 0.018 },
  { y: 0.56, leading: -0.04, trailing: -0.25, thickness: 0.017, z: 0.03 },
  { y: 0.64, leading: -0.1, trailing: -0.25, thickness: 0.012, z: 0.04 },
];

/** Chord fractions sampled across each section, nose to tail. */
const CHORD_SAMPLES = [0, 0.06, 0.18, 0.4, 0.68, 1] as const;

const ELEVON_HINGE_X = -0.16;
const ELEVON_HINGE_Z = 0.014;
/** Station index where the elevons begin, just outboard of the pod. */
const ELEVON_FIRST_STATION = 1;
/** Chord fractions across the elevon itself, hinge to trailing edge. */
const ELEVON_SAMPLES = [0, 0.45, 1] as const;

/** Upper surface of the reflexed section, as a fraction of thickness. */
function upperProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return 0.62 * Math.sin(Math.PI * Math.pow(f, 0.62));
}

/** Lower surface, flatter than the top as a flying-wing section is. */
function lowerProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return -0.3 * Math.sin(Math.PI * Math.pow(f, 0.75));
}

/** The interceptor: the swept delta in `FPV.png`. */
const WING_PLANFORM: Planform = {
  stations: STATIONS,
  chordSamples: CHORD_SAMPLES,
  hingeX: ELEVON_HINGE_X,
  hingeZ: ELEVON_HINGE_Z,
  firstElevonStation: ELEVON_FIRST_STATION,
  lastElevonStation: STATIONS.length - 1,
  elevonSamples: ELEVON_SAMPLES,
  upper: upperProfile,
  lower: lowerProfile,
};

/** Chord fraction at which the hinge crosses a station. */
function hingeFraction(plan: Planform, station: Station): number {
  const chord = station.leading - station.trailing;
  if (chord <= 1e-6) return 1;
  const f = (station.leading - plan.hingeX) / chord;
  return Math.min(0.94, Math.max(0.2, f));
}

/** True for stations that carry an elevon behind them. */
function hasElevon(plan: Planform, index: number): boolean {
  return index >= plan.firstElevonStation && index <= plan.lastElevonStation;
}

function surfacePoint(
  plan: Planform,
  station: Station,
  fraction: number,
  upper: boolean,
  sign: number,
): Point {
  const chord = station.leading - station.trailing;
  const x = station.leading - chord * fraction;
  const profile = upper ? plan.upper(fraction) : plan.lower(fraction);
  return [x, station.y * sign, station.z + profile * station.thickness];
}

function buildWing(
  plan: Planform,
  top: PartBuilder,
  bottom: PartBuilder,
): void {
  const stations = plan.stations;
  const samples = plan.chordSamples;
  const at = (station: Station, fraction: number, upper: boolean, sign: number) =>
    surfacePoint(plan, station, fraction, upper, sign);

  for (const sign of [1, -1] as const) {
    for (let s = 0; s + 1 < stations.length; s += 1) {
      const inner = stations[s]!;
      const outer = stations[s + 1]!;
      // A panel is cut back to the hinge only where the elevon runs the whole
      // width of it; the surface behind it is built separately so it can move.
      // Lofting the cut into a panel that is only half covered would take a
      // wedge out of the trailing edge instead of leaving the square-ended
      // cut-out the airframe actually has.
      const cut = hasElevon(plan, s) && hasElevon(plan, s + 1);
      const innerEnd = cut ? hingeFraction(plan, inner) : 1;
      const outerEnd = cut ? hingeFraction(plan, outer) : 1;

      for (let c = 0; c + 1 < samples.length; c += 1) {
        const f0 = samples[c]!;
        const f1 = samples[c + 1]!;

        const a = at(inner, f0 * innerEnd, true, sign);
        const b = at(outer, f0 * outerEnd, true, sign);
        const cc = at(outer, f1 * outerEnd, true, sign);
        const d = at(inner, f1 * innerEnd, true, sign);
        if (sign > 0) top.quad(a, b, cc, d);
        else top.quad(a, d, cc, b);

        const a2 = at(inner, f0 * innerEnd, false, sign);
        const b2 = at(outer, f0 * outerEnd, false, sign);
        const c2 = at(outer, f1 * outerEnd, false, sign);
        const d2 = at(inner, f1 * innerEnd, false, sign);
        if (sign > 0) bottom.quad(a2, d2, c2, b2);
        else bottom.quad(a2, b2, c2, d2);
      }

      // Close the aft edge of the panel: the blunt trailing edge on the root
      // panel, and the face the elevon hinges away from everywhere else.
      const teTopInner = at(inner, innerEnd, true, sign);
      const teTopOuter = at(outer, outerEnd, true, sign);
      const teBotInner = at(inner, innerEnd, false, sign);
      const teBotOuter = at(outer, outerEnd, false, sign);
      if (sign > 0) bottom.quad(teTopInner, teBotInner, teBotOuter, teTopOuter);
      else bottom.quad(teTopInner, teTopOuter, teBotOuter, teBotInner);

    }

    // Either end of the cut-out is a step in the surface: the wing keeps its
    // full chord up to it and stops. Rib it over, exactly as the real airframe
    // is ribbed. The far end only exists where the elevon stops short of the
    // tip; where it runs all the way out, the tip rib closes it.
    const ends =
      plan.lastElevonStation < stations.length - 1
        ? [plan.firstElevonStation, plan.lastElevonStation]
        : [plan.firstElevonStation];
    for (const index of ends) {
      const station = stations[index]!;
      const f = hingeFraction(plan, station);
      const rTop0 = at(station, f, true, sign);
      const rTop1 = at(station, 1, true, sign);
      const rBot0 = at(station, f, false, sign);
      const rBot1 = at(station, 1, false, sign);
      // The inboard rib is the outboard end of the root panel and faces out;
      // the one at the far end faces back in at the panel beyond it.
      const outward = (index === plan.lastElevonStation) === (sign > 0);
      if (outward) bottom.quad(rTop0, rTop1, rBot1, rBot0);
      else bottom.quad(rTop0, rBot0, rBot1, rTop1);
    }

    // Cap the outboard rib before the winglet takes over.
    const tip = stations[stations.length - 1]!;
    for (let c = 0; c + 1 < samples.length; c += 1) {
      const f0 = samples[c]!;
      const f1 = samples[c + 1]!;
      const t0 = at(tip, f0, true, sign);
      const t1 = at(tip, f1, true, sign);
      const b0 = at(tip, f0, false, sign);
      const b1 = at(tip, f1, false, sign);
      if (sign > 0) top.quad(t0, t1, b1, b0);
      else top.quad(t0, b0, b1, t1);
    }
  }
}

/**
 * One elevon, in a frame whose origin sits on its hinge.
 *
 * Building it hinge-relative is what lets the renderer deflect it with a
 * single rotation about the local Y axis and nothing else — no vertex is
 * touched once the mesh exists.
 */
function buildElevon(
  plan: Planform,
  part: PartBuilder,
  sign: number,
  // The underside of the surface, where the airframe is not the same colour
  // top and bottom. Left to the surface itself when it is.
  underside: PartBuilder = part,
): void {
  const stations = plan.stations;
  const samples = plan.elevonSamples;
  const ox = plan.hingeX;
  const oz = plan.hingeZ;
  const local = (p: Point): Point => [p[0] - ox, p[1], p[2] - oz];
  // Trailing-edge order has to flip with the side or the surface faces inward.
  const quad = (a: Point, b: Point, c: Point, d: Point): void => {
    if (sign > 0) part.quad(local(a), local(b), local(c), local(d));
    else part.quad(local(a), local(d), local(c), local(b));
  };

  for (
    let st = plan.firstElevonStation;
    st < plan.lastElevonStation;
    st += 1
  ) {
    const inner = stations[st]!;
    const outer = stations[st + 1]!;
    const innerHinge = hingeFraction(plan, inner);
    const outerHinge = hingeFraction(plan, outer);
    const at = (station: Station, hinge: number, g: number, upper: boolean) =>
      surfacePoint(plan, station, hinge + (1 - hinge) * g, upper, sign);

    for (let c = 0; c + 1 < samples.length; c += 1) {
      const g0 = samples[c]!;
      const g1 = samples[c + 1]!;
      quad(
        at(inner, innerHinge, g0, true),
        at(outer, outerHinge, g0, true),
        at(outer, outerHinge, g1, true),
        at(inner, innerHinge, g1, true),
      );
      // The underside winds the other way round to face down.
      const b0 = at(inner, innerHinge, g0, false);
      const b1 = at(outer, outerHinge, g0, false);
      const b2 = at(outer, outerHinge, g1, false);
      const b3 = at(inner, innerHinge, g1, false);
      if (sign > 0) underside.quad(local(b0), local(b3), local(b2), local(b1));
      else underside.quad(local(b0), local(b1), local(b2), local(b3));
    }

    // Blunt trailing edge.
    const teTopInner = at(inner, innerHinge, 1, true);
    const teTopOuter = at(outer, outerHinge, 1, true);
    const teBotInner = at(inner, innerHinge, 1, false);
    const teBotOuter = at(outer, outerHinge, 1, false);
    if (sign > 0) {
      part.quad(
        local(teTopInner),
        local(teBotInner),
        local(teBotOuter),
        local(teTopOuter),
      );
    } else {
      part.quad(
        local(teTopInner),
        local(teTopOuter),
        local(teBotOuter),
        local(teBotInner),
      );
    }
  }

  // Cap both ends so the surface reads as a separate control, not a hole.
  for (const [index, outward] of [
    [plan.firstElevonStation, false],
    [plan.lastElevonStation, true],
  ] as const) {
    const station = stations[index]!;
    const hinge = hingeFraction(plan, station);
    for (let c = 0; c + 1 < samples.length; c += 1) {
      const g0 = samples[c]!;
      const g1 = samples[c + 1]!;
      const f0 = hinge + (1 - hinge) * g0;
      const f1 = hinge + (1 - hinge) * g1;
      const t0 = surfacePoint(plan, station, f0, true, sign);
      const t1 = surfacePoint(plan, station, f1, true, sign);
      const bb0 = surfacePoint(plan, station, f0, false, sign);
      const bb1 = surfacePoint(plan, station, f1, false, sign);
      const flip = outward === (sign > 0);
      if (flip) part.quad(local(t0), local(t1), local(bb1), local(bb0));
      else part.quad(local(t0), local(bb0), local(bb1), local(t1));
    }
  }

  // The face the hinge exposes when the surface deflects.
  for (
    let st = plan.firstElevonStation;
    st < plan.lastElevonStation;
    st += 1
  ) {
    const inner = stations[st]!;
    const outer = stations[st + 1]!;
    const t0 = surfacePoint(plan, inner, hingeFraction(plan, inner), true, sign);
    const t1 = surfacePoint(plan, outer, hingeFraction(plan, outer), true, sign);
    const b0 = surfacePoint(plan, inner, hingeFraction(plan, inner), false, sign);
    const b1 = surfacePoint(plan, outer, hingeFraction(plan, outer), false, sign);
    if (sign > 0) part.quad(local(t0), local(t1), local(b1), local(b0));
    else part.quad(local(t0), local(b0), local(b1), local(t1));
  }
}

function buildWinglets(shell: PartBuilder, accent: PartBuilder): void {
  const tip = STATIONS[STATIONS.length - 1]!;
  for (const sign of [1, -1] as const) {
    // A steeply upturned tip fin, exactly as on the photographed airframe.
    const outline: Point[] = [
      [tip.leading, tip.y * sign, tip.z],
      [tip.leading + 0.02, (tip.y + 0.035) * sign, tip.z + 0.155],
      [tip.trailing + 0.03, (tip.y + 0.035) * sign, tip.z + 0.155],
      [tip.trailing, tip.y * sign, tip.z],
    ];
    if (sign < 0) outline.reverse();
    shell.plate(outline, 0.014, 1);

    // Orange leading-edge tape on the fin.
    const stripe: Point[] = [
      [tip.leading, tip.y * sign, tip.z + 0.04],
      [tip.leading + 0.019, (tip.y + 0.033) * sign, tip.z + 0.155],
      [tip.leading - 0.045, (tip.y + 0.033) * sign, tip.z + 0.155],
      [tip.leading - 0.05, tip.y * sign, tip.z + 0.04],
    ];
    if (sign < 0) stripe.reverse();
    accent.plate(stripe, 0.017, 1);
  }
}

/** Interpolates the wing surface height at an arbitrary span position. */
function stationAt(plan: Planform, y: number): Station {
  const stations = plan.stations;
  const target = Math.abs(y);
  for (let i = 0; i + 1 < stations.length; i += 1) {
    const a = stations[i]!;
    const b = stations[i + 1]!;
    if (target <= b.y) {
      const t = (target - a.y) / (b.y - a.y || 1);
      return {
        y: target,
        leading: a.leading + (b.leading - a.leading) * t,
        trailing: a.trailing + (b.trailing - a.trailing) * t,
        thickness: a.thickness + (b.thickness - a.thickness) * t,
        z: a.z + (b.z - a.z) * t,
      };
    }
  }
  return { ...(stations[stations.length - 1] as Station), y: target };
}

/** True where the trailing edge at this span position is a moving surface. */
function elevonSpans(plan: Planform, y: number): boolean {
  const first = plan.stations[plan.firstElevonStation];
  const last = plan.stations[plan.lastElevonStation];
  if (!first || !last) return false;
  const target = Math.abs(y);
  return target >= first.y && target <= last.y;
}

/** Marker tape running chordwise across the wing, band by band. */
function buildAccentStripes(
  plan: Planform,
  accent: PartBuilder,
  bands: readonly (readonly [number, number])[],
): void {
  const samples = plan.chordSamples;
  for (const sign of [1, -1] as const) {
    for (const [y0, y1] of bands) {
      const inner = stationAt(plan, y0);
      const outer = stationAt(plan, y1);
      // Tape is stuck to the fixed wing, so it stops at the hinge rather
      // than floating over an elevon that is about to move. Out where the
      // trailing edge does not move it runs the whole chord, which is how a
      // wingtip is actually taped.
      const innerEnd = elevonSpans(plan, y0) ? hingeFraction(plan, inner) : 1;
      const outerEnd = elevonSpans(plan, y1) ? hingeFraction(plan, outer) : 1;
      for (let c = 0; c + 1 < samples.length; c += 1) {
        const f0 = samples[c]!;
        const f1 = samples[c + 1]!;
        // Lift the tape a hair above the shell so it cannot z-fight.
        const lift = 0.0016;
        const a = surfacePoint(plan, inner, f0 * innerEnd, true, sign);
        const b = surfacePoint(plan, outer, f0 * outerEnd, true, sign);
        const cc = surfacePoint(plan, outer, f1 * outerEnd, true, sign);
        const d = surfacePoint(plan, inner, f1 * innerEnd, true, sign);
        const raise = (p: Point): Point => [p[0], p[1], p[2] + lift];
        if (sign > 0) accent.quad(raise(a), raise(b), raise(cc), raise(d));
        else accent.quad(raise(a), raise(d), raise(cc), raise(b));
      }
    }
  }
}

/** Where the interceptor's tape is stuck: two bands across each wing root. */
const WING_ACCENT_BANDS: readonly (readonly [number, number])[] = [
  [0.15, 0.185],
  [0.30, 0.335],
];

/** Lofted centre pod: it hangs below the wing and carries the FPV gear. */
function buildPod(pod: PartBuilder): void {
  interface Ring {
    x: number;
    halfWidth: number;
    top: number;
    bottom: number;
  }
  const rings: readonly Ring[] = [
    { x: 0.345, halfWidth: 0.018, top: 0.012, bottom: -0.02 },
    { x: 0.3, halfWidth: 0.045, top: 0.03, bottom: -0.055 },
    { x: 0.2, halfWidth: 0.062, top: 0.042, bottom: -0.078 },
    { x: 0.05, halfWidth: 0.068, top: 0.045, bottom: -0.086 },
    { x: -0.1, halfWidth: 0.06, top: 0.04, bottom: -0.072 },
    { x: -0.22, halfWidth: 0.043, top: 0.032, bottom: -0.045 },
    { x: -0.3, halfWidth: 0.03, top: 0.026, bottom: -0.026 },
  ];

  const ringPoints = (ring: Ring): Point[] => [
    [ring.x, 0, ring.top],
    [ring.x, ring.halfWidth, ring.top * 0.55],
    [ring.x, ring.halfWidth * 0.86, ring.bottom * 0.5],
    [ring.x, 0, ring.bottom],
    [ring.x, -ring.halfWidth * 0.86, ring.bottom * 0.5],
    [ring.x, -ring.halfWidth, ring.top * 0.55],
  ];

  for (let i = 0; i + 1 < rings.length; i += 1) {
    const a = ringPoints(rings[i]!);
    const b = ringPoints(rings[i + 1]!);
    for (let k = 0; k < a.length; k += 1) {
      const k2 = (k + 1) % a.length;
      // Round the ring and then aft, which is the way round that leaves the
      // outside of the pod facing out of it.
      pod.quad(a[k]!, a[k2]!, b[k2]!, b[k]!);
    }
  }

  // Nose and tail caps.
  const nose = ringPoints(rings[0]!);
  const noseTip: Point = [0.375, 0, -0.004];
  for (let k = 0; k < nose.length; k += 1) {
    pod.triangle(noseTip, nose[(k + 1) % nose.length]!, nose[k]!);
  }
  const tail = ringPoints(rings[rings.length - 1]!);
  const tailTip: Point = [-0.315, 0, 0];
  for (let k = 0; k < tail.length; k += 1) {
    pod.triangle(tailTip, tail[k]!, tail[(k + 1) % tail.length]!);
  }
}

function buildMotor(motor: PartBuilder): void {
  const segments = 10;
  const front = -0.3;
  const back = -0.352;
  const radius = 0.028;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: Point = [front, Math.cos(a0) * radius, Math.sin(a0) * radius];
    const p1: Point = [front, Math.cos(a1) * radius, Math.sin(a1) * radius];
    const q0: Point = [back, Math.cos(a0) * radius, Math.sin(a0) * radius];
    const q1: Point = [back, Math.cos(a1) * radius, Math.sin(a1) * radius];
    motor.quad(p0, q0, q1, p1);
    motor.triangle([back, 0, 0], q1, q0);
  }
}

function buildCamera(shell: PartBuilder, lens: PartBuilder): void {
  // Small FPV camera pod sitting on top of the nose.
  const x0 = 0.235;
  const x1 = 0.3;
  const halfWidth = 0.019;
  const zBottom = 0.032;
  const zTop = 0.068;
  // Drawn on the centreline and extruded a half-width each way: a camera
  // sitting off to one side of the nose is one somebody has knocked.
  const corners: Point[] = [
    [x0, 0, zBottom],
    [x1, 0, zBottom],
    [x1, 0, zTop],
    [x0, 0, zTop],
  ];
  shell.plate(corners, halfWidth * 2, 1);
  // Lens disc on the front face, tilted up the way FPV pilots mount them.
  const lensCorners: Point[] = [
    [x1 + 0.004, -0.012, zBottom + 0.008],
    [x1 + 0.012, -0.012, zTop - 0.006],
    [x1 + 0.012, 0.012, zTop - 0.006],
    [x1 + 0.004, 0.012, zBottom + 0.008],
  ];
  lens.plate(lensCorners, 0.006, 0);
}

function buildPropeller(prop: PartBuilder): void {
  const radius = 0.14;

  // Two blades, 180 degrees apart, in the propeller's own YZ disc.
  const blade = (direction: 1 | -1): Point[] => {
    const points: Point[] = [
      [0, 0.013, 0.014 * direction],
      [0, 0.018, 0.055 * direction],
      [0, 0.011, radius * direction],
      [0, -0.009, radius * 0.9 * direction],
      [0, -0.015, 0.05 * direction],
      [0, -0.011, 0.012 * direction],
    ];
    // Reversing keeps the outward face consistent for the mirrored blade.
    return direction === 1 ? points : points.slice().reverse();
  };
  prop.plate(blade(1), 0.008, 0);
  prop.plate(blade(-1), 0.008, 0);

  // Spinner cone over the hub.
  const segments = 8;
  const hubRadius = 0.016;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    prop.triangle(
      [-0.03, 0, 0],
      [0, Math.cos(a0) * hubRadius, Math.sin(a0) * hubRadius],
      [0, Math.cos(a1) * hubRadius, Math.sin(a1) * hubRadius],
    );
  }
}

/** Copies a part with its vertices moved, for folding a hinged piece back in. */
function translated(
  part: MeshPart,
  dx: number,
  dy: number,
  dz: number,
): MeshPart {
  const positions = new Float64Array(part.positions.length);
  for (let i = 0; i < part.positions.length; i += 3) {
    positions[i] = (part.positions[i] ?? 0) + dx;
    positions[i + 1] = (part.positions[i + 1] ?? 0) + dy;
    positions[i + 2] = (part.positions[i + 2] ?? 0) + dz;
  }
  return {
    name: `${part.name}-fixed`,
    color: part.color,
    paint: part.paint,
    shade: part.shade,
    positions,
    normals: part.normals,
    indices: part.indices,
  };
}

/**
 * What colour a part is once the aircraft is painted.
 *
 * The delivered palette is the default livery run through this same function,
 * so an unpainted aircraft is not a special case: it is one that happens to be
 * wearing the colours it was drawn in.
 */
export function partColor(
  part: MeshPart,
  livery: Livery,
): readonly [number, number, number] {
  if (part.paint === PAINT.Fixed) return part.color;
  const base = rgbOf(part.paint === PAINT.Accent ? livery.accent : livery.shell);
  return [base[0] * part.shade, base[1] * part.shade, base[2] * part.shade];
}

let cached: AircraftMesh | null = null;

/** Builds (once) and returns the flying-wing mesh. */
export function buildAircraftMesh(): AircraftMesh {
  if (cached) return cached;

  const top = new PartBuilder("shell-top", SHELL_TOP, PAINT.Shell);
  const bottom = new PartBuilder(
    "shell-bottom",
    SHELL_BOTTOM,
    PAINT.Shell,
    BOTTOM_SHADE,
  );
  const podPart = new PartBuilder("pod", POD, PAINT.Shell, POD_SHADE);
  const accent = new PartBuilder("accent", ACCENT, PAINT.Accent);
  const motor = new PartBuilder("motor", MOTOR);
  const lens = new PartBuilder("lens", LENS);
  const propeller = new PartBuilder("propeller", MOTOR);
  const elevonLeft = new PartBuilder("elevon-left", SHELL_TOP, PAINT.Shell);
  const elevonRight = new PartBuilder("elevon-right", SHELL_TOP, PAINT.Shell);

  buildWing(WING_PLANFORM, top, bottom);
  buildElevon(WING_PLANFORM, elevonLeft, 1);
  buildElevon(WING_PLANFORM, elevonRight, -1);
  buildWinglets(top, accent);
  buildAccentStripes(WING_PLANFORM, accent, WING_ACCENT_BANDS);
  buildPod(podPart);
  buildMotor(motor);
  buildCamera(podPart, lens);
  buildPropeller(propeller);

  const parts = [top, bottom, podPart, accent, motor, lens]
    .map((builder) => builder.build())
    .filter((part): part is MeshPart => part !== null);
  const propellerParts = [propeller.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const propellers: PropellerGroup[] = [
    {
      name: "propeller",
      origin: [-0.362, 0, 0],
      axis: "x",
      direction: 1,
      parts: propellerParts,
    },
  ];
  const leftParts = [elevonLeft.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const rightParts = [elevonRight.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const staticParts = [
    ...parts,
    ...[...leftParts, ...rightParts].map((part) =>
      translated(part, ELEVON_HINGE_X, 0, ELEVON_HINGE_Z),
    ),
  ];

  const triangleCount =
    [...parts, ...propellerParts, ...leftParts, ...rightParts].reduce(
      (sum, part) => sum + part.indices.length,
      0,
    ) / 3;

  cached = {
    kind: MESH_KIND.Wing,
    referenceSpan: MESH_WING_SPAN,
    parts,
    propellers,
    elevonParts: { left: leftParts, right: rightParts },
    staticParts,
    elevonOrigin: [ELEVON_HINGE_X, 0, ELEVON_HINGE_Z],
    fpvCamera: { offset: [0.3, 0, 0.052], tiltDegrees: 12 },
    triangleCount,
  };
  return cached;
}

// --- The Skywalker X8 -------------------------------------------------------

/**
 * Procedural geometry for the Skywalker X8.
 *
 * Modelled on the airframe as it is sold: 2.12 m across, a 30-degree swept
 * leading edge running unbroken from the nose to the tip, a deep moulded
 * centre pod with the payload hatch let into the top of it and the bay bulging
 * well below the wing, elevons on the outer trailing edge, a pusher turning a
 * twelve-inch propeller behind the centre section, and the tall canted fins
 * that sit on the wingtips.
 *
 * It is not the interceptor drawn bigger. Everything that makes one of these
 * recognisable at a hundred metres is a proportion the delta does not have: a
 * body deep enough to stand a camera and a survey payload in, far less taper
 * out to a tip that is still better than a third of the root, elevons that
 * stop short of that tip, and fins with real area on them rather than a pair
 * of turned-up corners.
 *
 * Same body frame as every other airframe here: X = forward, Y = left, Z = up,
 * origin at the centre of gravity, which on one of these is inside the pod,
 * between the pack and the payload bay.
 */

/**
 * Root-to-tip stations describing the X8's planform.
 *
 * The tip station is the real half-span, so the geometry is 2.12 m across
 * without the renderer scaling it: the mesh and the airframe are the same size.
 */
const X8_STATIONS: readonly Station[] = [
  { y: 0.0, leading: 0.45, trailing: -0.3, thickness: 0.078, z: 0.0 },
  { y: 0.13, leading: 0.42, trailing: -0.3, thickness: 0.07, z: 0.002 },
  { y: 0.34, leading: 0.3, trailing: -0.305, thickness: 0.056, z: 0.009 },
  { y: 0.6, leading: 0.155, trailing: -0.315, thickness: 0.042, z: 0.019 },
  { y: 0.86, leading: 0.005, trailing: -0.33, thickness: 0.03, z: 0.031 },
  { y: 1.06, leading: -0.075, trailing: -0.345, thickness: 0.022, z: 0.043 },
];

/** Chord fractions sampled across each section, nose to tail. */
const X8_CHORD_SAMPLES = [0, 0.05, 0.16, 0.38, 0.66, 1] as const;

/**
 * The elevon hinge.
 *
 * Straight and unswept across a trailing edge that is very nearly straight
 * itself, which is how the surfaces are cut on the real airframe: about a
 * hundred millimetres of chord at the root end of the surface, and rather more
 * of the little chord that is left by the time it reaches the outboard end.
 */
const X8_HINGE_X = -0.205;
const X8_HINGE_Z = 0.015;
/** Station where the elevons start, at the side of the pod. */
const X8_FIRST_ELEVON_STATION = 1;
/**
 * Station where they stop.
 *
 * Short of the tip, unlike the interceptor's: the last panel is fixed, because
 * that is the piece of wing the fin is bolted through.
 */
const X8_LAST_ELEVON_STATION = 4;
/** Chord fractions across the elevon itself, hinge to trailing edge. */
const X8_ELEVON_SAMPLES = [0, 0.45, 1] as const;

/**
 * The X8's section: thicker, blunter and flatter underneath than the delta's.
 *
 * A survey wing carries its payload inside the aerofoil and flies slowly
 * enough to want the camber, so the top is fuller and further forward and the
 * bottom is close to flat — which is also why one of them will float on for a
 * quarter of a mile with the throttle shut.
 */
function x8UpperProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return 0.6 * Math.sin(Math.PI * Math.pow(f, 0.55));
}

function x8LowerProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return -0.34 * Math.sin(Math.PI * Math.pow(f, 0.88));
}

const X8_PLANFORM: Planform = {
  stations: X8_STATIONS,
  chordSamples: X8_CHORD_SAMPLES,
  hingeX: X8_HINGE_X,
  hingeZ: X8_HINGE_Z,
  firstElevonStation: X8_FIRST_ELEVON_STATION,
  lastElevonStation: X8_LAST_ELEVON_STATION,
  elevonSamples: X8_ELEVON_SAMPLES,
  upper: x8UpperProfile,
  lower: x8LowerProfile,
};

/**
 * The tape on the outer panels, out past where the elevons stop.
 *
 * One band a side rather than the interceptor's two at the root: an X8 is
 * taped where it can be seen from the ground with the wing pointed at you,
 * and where somebody walking a field is going to find it again.
 */
const X8_ACCENT_BANDS: readonly (readonly [number, number])[] = [[0.9, 0.975]];

/** The white EPO the airframe is moulded in, and how dark each panel is. */
const X8_SHELL_TOP: readonly [number, number, number] = [0.902, 0.902, 0.882];
const X8_SHELL_BOTTOM: readonly [number, number, number] = [0.649, 0.649, 0.635];
const X8_POD: readonly [number, number, number] = [0.812, 0.812, 0.794];
const X8_HATCH: readonly [number, number, number] = [0.74, 0.74, 0.723];
const X8_BOTTOM_SHADE = 0.72;
const X8_POD_SHADE = 0.9;
const X8_HATCH_SHADE = 0.82;

/**
 * The centre pod.
 *
 * The whole point of the aircraft: a bay long enough and deep enough to put a
 * camera, a radio and a pack in, moulded into the middle of the wing. It hangs
 * a good six centimetres below the underside and stands a couple above it,
 * which is what gives an X8 its profile head-on and what a pilot is looking at
 * when they judge how level it is.
 */
interface X8Ring {
  x: number;
  halfWidth: number;
  top: number;
  bottom: number;
}

const X8_POD_RINGS: readonly X8Ring[] = [
  // Two rings across the last four centimetres of the nose: an X8's is a
  // rounded snout with a camera in the end of it, and a body that came to a
  // point would be some other aeroplane.
  { x: 0.462, halfWidth: 0.024, top: 0.022, bottom: -0.018 },
  { x: 0.435, halfWidth: 0.045, top: 0.038, bottom: -0.036 },
  { x: 0.38, halfWidth: 0.068, top: 0.055, bottom: -0.058 },
  { x: 0.3, halfWidth: 0.084, top: 0.064, bottom: -0.08 },
  { x: 0.17, halfWidth: 0.092, top: 0.069, bottom: -0.094 },
  { x: 0.02, halfWidth: 0.092, top: 0.067, bottom: -0.094 },
  { x: -0.12, halfWidth: 0.081, top: 0.059, bottom: -0.076 },
  { x: -0.24, halfWidth: 0.056, top: 0.047, bottom: -0.046 },
  { x: -0.32, halfWidth: 0.035, top: 0.037, bottom: -0.022 },
];

/**
 * One station round the pod.
 *
 * Ten points rather than the delta's six: an X8's body is a box with the
 * corners taken off it, not a teardrop, and a hexagon drawn round it reads as
 * a fuselage from a different aircraft.
 */
function x8RingPoints(ring: X8Ring): Point[] {
  const w = ring.halfWidth;
  return [
    [ring.x, 0, ring.top],
    [ring.x, w * 0.72, ring.top * 0.93],
    [ring.x, w, ring.top * 0.3],
    [ring.x, w * 0.95, ring.bottom * 0.45],
    [ring.x, w * 0.62, ring.bottom * 0.95],
    [ring.x, 0, ring.bottom],
    [ring.x, -w * 0.62, ring.bottom * 0.95],
    [ring.x, -w * 0.95, ring.bottom * 0.45],
    [ring.x, -w, ring.top * 0.3],
    [ring.x, -w * 0.72, ring.top * 0.93],
  ];
}

function buildX8Pod(pod: PartBuilder): void {
  for (let i = 0; i + 1 < X8_POD_RINGS.length; i += 1) {
    const a = x8RingPoints(X8_POD_RINGS[i]!);
    const b = x8RingPoints(X8_POD_RINGS[i + 1]!);
    for (let k = 0; k < a.length; k += 1) {
      const k2 = (k + 1) % a.length;
      pod.quad(a[k]!, a[k2]!, b[k2]!, b[k]!);
    }
  }

  // The blunt nose the aircraft is recognised by, and the tail the motor is
  // bolted into.
  const nose = x8RingPoints(X8_POD_RINGS[0]!);
  const noseTip: Point = [0.476, 0, 0.003];
  for (let k = 0; k < nose.length; k += 1) {
    pod.triangle(noseTip, nose[(k + 1) % nose.length]!, nose[k]!);
  }
  const tail = x8RingPoints(X8_POD_RINGS[X8_POD_RINGS.length - 1]!);
  const tailTip: Point = [-0.355, 0, 0.012];
  for (let k = 0; k < tail.length; k += 1) {
    pod.triangle(tailTip, tail[k]!, tail[(k + 1) % tail.length]!);
  }
}

/**
 * The payload hatch.
 *
 * A lid most of the length of the bay, sitting a few millimetres proud of the
 * pod with a lip all the way round it. It is the one panel line on the
 * airframe anybody can see from outside, and without it the pod reads as a
 * moulded lump rather than as something that opens.
 */
function buildX8Hatch(hatch: PartBuilder): void {
  const rows: readonly { x: number; halfWidth: number; z: number }[] = [
    { x: 0.315, halfWidth: 0.048, z: 0.066 },
    { x: 0.21, halfWidth: 0.066, z: 0.073 },
    { x: 0.02, halfWidth: 0.067, z: 0.072 },
    { x: -0.125, halfWidth: 0.052, z: 0.063 },
  ];
  // How far the lip drops into the shell of the pod. Deep enough that the two
  // never part company where the body is curving away underneath it.
  const skirt = 0.016;

  for (let i = 0; i + 1 < rows.length; i += 1) {
    const a = rows[i]!;
    const b = rows[i + 1]!;
    hatch.quad(
      [a.x, -a.halfWidth, a.z],
      [a.x, a.halfWidth, a.z],
      [b.x, b.halfWidth, b.z],
      [b.x, -b.halfWidth, b.z],
    );
    for (const sign of [1, -1] as const) {
      const ay = a.halfWidth * sign;
      const by = b.halfWidth * sign;
      const top0: Point = [a.x, ay, a.z];
      const bot0: Point = [a.x, ay, a.z - skirt];
      const top1: Point = [b.x, by, b.z];
      const bot1: Point = [b.x, by, b.z - skirt];
      if (sign > 0) hatch.quad(top0, bot0, bot1, top1);
      else hatch.quad(top0, top1, bot1, bot0);
    }
  }

  // The two ends of the lid.
  const front = rows[0]!;
  hatch.quad(
    [front.x, front.halfWidth, front.z],
    [front.x, -front.halfWidth, front.z],
    [front.x, -front.halfWidth, front.z - skirt],
    [front.x, front.halfWidth, front.z - skirt],
  );
  const back = rows[rows.length - 1]!;
  hatch.quad(
    [back.x, -back.halfWidth, back.z],
    [back.x, back.halfWidth, back.z],
    [back.x, back.halfWidth, back.z - skirt],
    [back.x, -back.halfWidth, back.z - skirt],
  );
}

/**
 * The tip fins.
 *
 * Slabs of foam with real area on them, swept on the leading edge, standing
 * above the wing only and canted out at the top — which is what an X8 has
 * instead of the delta's turned-up corners, and most of why it holds a heading
 * on its own with nobody touching the sticks.
 */
function buildX8Fins(shell: PartBuilder, accent: PartBuilder): void {
  const tip = X8_STATIONS[X8_STATIONS.length - 1]!;
  // Just inboard of the tip rib, so the fin is planted in the wing rather than
  // balanced on the edge of it.
  const root = tip.y - 0.008;
  const rootZ = tip.z + 0.004;
  const height = 0.15;
  const topZ = rootZ + height;
  const cant = 0.028;
  // The fin covers the back of the tip chord and overhangs the trailing edge a
  // little; the leading edge is raked and the trailing edge stands up.
  const rootLead = -0.145;
  const topLead = -0.228;
  const topTrail = -0.338;
  const rootTrail = -0.352;

  for (const sign of [1, -1] as const) {
    const outline: Point[] = [
      [rootLead, root * sign, rootZ],
      [topLead, (root + cant) * sign, topZ],
      [topTrail, (root + cant) * sign, topZ],
      [rootTrail, root * sign, rootZ],
    ];
    if (sign < 0) outline.reverse();
    shell.plate(outline, 0.012, 1);

    // A band of tape across the top of the fin: the part of the aircraft that
    // stays visible when it is on its side a long way out.
    const drop = 0.05;
    const f = 1 - drop / height;
    const band: Point[] = [
      [rootLead + (topLead - rootLead) * f, (root + cant * f) * sign, topZ - drop],
      [topLead, (root + cant) * sign, topZ],
      [topTrail, (root + cant) * sign, topZ],
      [rootTrail + (topTrail - rootTrail) * f, (root + cant * f) * sign, topZ - drop],
    ];
    if (sign < 0) band.reverse();
    accent.plate(band, 0.015, 1);
  }
}

/**
 * The pusher, in the back of the pod.
 *
 * A 42 mm outrunner on the tail of the body with the propeller behind the
 * centre section, which is where every X8 puts one: out of the airflow over
 * the wing, out of the way of the payload, and high enough that a landing on
 * the belly does not go through it.
 */
const X8_PROP_AXIS_Z = 0.02;
const X8_PROP_X = -0.382;
/** Twelve inches across, which is what the delivered combo turns. */
const X8_PROP_RADIUS = (12 * 0.0254) / 2;

function buildX8Motor(motor: PartBuilder): void {
  const segments = 12;
  const front = -0.3;
  const back = -0.374;
  const radius = 0.031;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const ring = (x: number, angle: number): Point => [
      x,
      Math.cos(angle) * radius,
      X8_PROP_AXIS_Z + Math.sin(angle) * radius,
    ];
    const p0 = ring(front, a0);
    const p1 = ring(front, a1);
    const q0 = ring(back, a0);
    const q1 = ring(back, a1);
    motor.quad(p0, q0, q1, p1);
    motor.triangle([back, 0, X8_PROP_AXIS_Z], q1, q0);
  }
}

/** The propeller, in its own frame with the hub at zero. */
function buildX8Propeller(prop: PartBuilder): void {
  const radius = X8_PROP_RADIUS;

  // Two wide blades: a 12x6 on a survey wing is a slow, broad thing next to
  // the interceptor's 9x5, and it looks like one turning over on the bench.
  const blade = (direction: 1 | -1): Point[] => {
    const points: Point[] = [
      [0, 0.016, 0.016 * direction],
      [0, 0.023, 0.062 * direction],
      [0, 0.014, radius * direction],
      [0, -0.012, radius * 0.9 * direction],
      [0, -0.019, 0.056 * direction],
      [0, -0.013, 0.014 * direction],
    ];
    return direction === 1 ? points : points.slice().reverse();
  };
  prop.plate(blade(1), 0.009, 0);
  prop.plate(blade(-1), 0.009, 0);

  // Spinner behind the disc, as a pusher's is.
  const segments = 10;
  const hubRadius = 0.019;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    prop.triangle(
      [-0.034, 0, 0],
      [0, Math.cos(a0) * hubRadius, Math.sin(a0) * hubRadius],
      [0, Math.cos(a1) * hubRadius, Math.sin(a1) * hubRadius],
    );
  }
}

/** The camera, let into the top of the nose where a survey one carries it. */
function buildX8Camera(shell: PartBuilder, lens: PartBuilder): void {
  const x0 = 0.335;
  const x1 = 0.412;
  const halfWidth = 0.023;
  const zBottom = 0.028;
  const zTop = 0.076;
  const corners: Point[] = [
    [x0, 0, zBottom],
    [x1, 0, zBottom],
    [x1, 0, zTop],
    [x0, 0, zTop],
  ];
  shell.plate(corners, halfWidth * 2, 1);
  // Barely tilted: a wing that cruises at four degrees of alpha wants the
  // horizon where the horizon is.
  const lensCorners: Point[] = [
    [x1 + 0.004, -0.014, zBottom + 0.016],
    [x1 + 0.009, -0.014, zTop - 0.007],
    [x1 + 0.009, 0.014, zTop - 0.007],
    [x1 + 0.004, 0.014, zBottom + 0.016],
  ];
  lens.plate(lensCorners, 0.007, 0);
}

let cachedX8: AircraftMesh | null = null;

/** Builds (once) and returns the Skywalker X8 mesh. */
export function buildX8Mesh(): AircraftMesh {
  if (cachedX8) return cachedX8;

  const top = new PartBuilder("x8-top", X8_SHELL_TOP, PAINT.Shell);
  const bottom = new PartBuilder(
    "x8-bottom",
    X8_SHELL_BOTTOM,
    PAINT.Shell,
    X8_BOTTOM_SHADE,
  );
  const podPart = new PartBuilder("x8-pod", X8_POD, PAINT.Shell, X8_POD_SHADE);
  const hatch = new PartBuilder("x8-hatch", X8_HATCH, PAINT.Shell, X8_HATCH_SHADE);
  const accent = new PartBuilder("x8-accent", ACCENT, PAINT.Accent);
  const motor = new PartBuilder("x8-motor", MOTOR);
  const lens = new PartBuilder("x8-lens", LENS);
  const propeller = new PartBuilder("x8-propeller", MOTOR);
  const elevonLeft = new PartBuilder("x8-elevon-left", X8_SHELL_TOP, PAINT.Shell);
  const elevonRight = new PartBuilder("x8-elevon-right", X8_SHELL_TOP, PAINT.Shell);
  // The undersides are the same foam as the underside of the wing they are cut
  // from, and on a white airframe a surface that stayed the colour of the top
  // reads as a panel somebody has replaced.
  const elevonUnderLeft = new PartBuilder(
    "x8-elevon-left-bottom",
    X8_SHELL_BOTTOM,
    PAINT.Shell,
    X8_BOTTOM_SHADE,
  );
  const elevonUnderRight = new PartBuilder(
    "x8-elevon-right-bottom",
    X8_SHELL_BOTTOM,
    PAINT.Shell,
    X8_BOTTOM_SHADE,
  );

  buildWing(X8_PLANFORM, top, bottom);
  buildElevon(X8_PLANFORM, elevonLeft, 1, elevonUnderLeft);
  buildElevon(X8_PLANFORM, elevonRight, -1, elevonUnderRight);
  buildX8Fins(top, accent);
  buildAccentStripes(X8_PLANFORM, accent, X8_ACCENT_BANDS);
  buildX8Pod(podPart);
  buildX8Hatch(hatch);
  buildX8Motor(motor);
  buildX8Camera(podPart, lens);
  buildX8Propeller(propeller);

  const parts = [top, bottom, podPart, hatch, accent, motor, lens]
    .map((builder) => builder.build())
    .filter((part): part is MeshPart => part !== null);
  const propellerParts = [propeller.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const propellers: PropellerGroup[] = [
    {
      name: "x8-propeller",
      origin: [X8_PROP_X, 0, X8_PROP_AXIS_Z],
      axis: "x",
      direction: 1,
      parts: propellerParts,
    },
  ];
  const leftParts = [elevonLeft.build(), elevonUnderLeft.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const rightParts = [elevonRight.build(), elevonUnderRight.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const staticParts = [
    ...parts,
    ...[...leftParts, ...rightParts].map((part) =>
      translated(part, X8_HINGE_X, 0, X8_HINGE_Z),
    ),
  ];

  const triangleCount =
    [...parts, ...propellerParts, ...leftParts, ...rightParts].reduce(
      (sum, part) => sum + part.indices.length,
      0,
    ) / 3;

  cachedX8 = {
    kind: MESH_KIND.X8,
    referenceSpan: MESH_X8_SPAN,
    parts,
    propellers,
    elevonParts: { left: leftParts, right: rightParts },
    staticParts,
    elevonOrigin: [X8_HINGE_X, 0, X8_HINGE_Z],
    fpvCamera: { offset: [0.412, 0, 0.062], tiltDegrees: 8 },
    triangleCount,
  };
  return cachedX8;
}

// --- The quadcopter ---------------------------------------------------------

/**
 * Procedural geometry for the CA35-160.
 *
 * Modelled on the frame as it is sold: a 160 mm true-X carbon bottom plate with
 * four arms out to the motors, a 20x20 stack between the plates, a pack strapped
 * on top, and a camera in a tilted mount at the front. Nothing here is a wing,
 * so nothing here hinges: a multirotor's control surfaces are its own rotors.
 *
 * Same body frame as the wing: X = forward, Y = left, Z = up, origin at the
 * centre of gravity, which on one of these is the middle of the stack.
 */

/** Half the diagonal wheelbase along each axis: the motors sit at (+/-a, +/-a). */
const QUAD_ARM = 0.16 / 2 / Math.SQRT2;
/** Propeller radius: three and a half inches across. */
const QUAD_PROP_RADIUS = (3.5 * 0.0254) / 2;
/** Height of the propeller discs above the centre of gravity. */
const QUAD_PROP_Z = 0.021;

const CARBON: readonly [number, number, number] = [0.11, 0.115, 0.125];
const CARBON_DARK: readonly [number, number, number] = [0.08, 0.084, 0.09];
const PACK: readonly [number, number, number] = [0.16, 0.35, 0.45];
const STACK: readonly [number, number, number] = [0.05, 0.055, 0.06];

/** How dark each carbon panel is against the top plate. */
const ARM_SHADE = 0.78;
const PACK_SHADE = 0.9;

/** The four motor positions, front-left first and round the frame. */
const QUAD_MOTORS: readonly (readonly [number, number, 1 | -1])[] = [
  [QUAD_ARM, QUAD_ARM, 1],
  [QUAD_ARM, -QUAD_ARM, -1],
  [-QUAD_ARM, -QUAD_ARM, 1],
  [-QUAD_ARM, QUAD_ARM, -1],
];

/** Bottom plate and the four arms coming off it, all one piece of carbon. */
function buildQuadPlates(bottom: PartBuilder, top: PartBuilder): void {
  const z = -0.006;
  const thickness = 0.003;

  // The centre plate. Cut off at the corners, the way one is milled so the
  // arms can be as wide as they are without the plate weighing anything.
  bottom.plate(
    [
      [0.036, -0.014, z],
      [0.024, -0.026, z],
      [-0.030, -0.026, z],
      [-0.042, -0.014, z],
      [-0.042, 0.014, z],
      [-0.030, 0.026, z],
      [0.024, 0.026, z],
      [0.036, 0.014, z],
    ],
    thickness,
    2,
  );

  // Four arms, tapering from the plate out to the motor mounts.
  for (const [mx, my] of QUAD_MOTORS) {
    const sx = Math.sign(mx);
    const sy = Math.sign(my);
    // Across the arm, at right angles to the direction it runs in.
    const nx = -sy * 0.0106;
    const ny = sx * 0.0106;
    const tipX = -sy * 0.0078;
    const tipY = sx * 0.0078;
    const rootX = sx * 0.018;
    const rootY = sy * 0.018;
    const outline: Point[] = [
      [rootX + nx, rootY + ny, z],
      [mx + tipX, my + tipY, z],
      [mx - tipX, my - tipY, z],
      [rootX - nx, rootY - ny, z],
    ];
    // Winding has to follow the quadrant or two of the four arms face down.
    if (sx * sy < 0) outline.reverse();
    bottom.plate(outline, thickness, 2);
  }

  // Top plate: the thin one, and the only flat surface on the aircraft big
  // enough for a livery to show on.
  const tz = 0.026;
  top.plate(
    [
      [0.034, -0.019, tz],
      [-0.032, -0.019, tz],
      [-0.032, 0.019, tz],
      [0.034, 0.019, tz],
    ],
    0.0015,
    2,
  );
}

/** Motor bells, standoffs and the flight controller stack between the plates. */
function buildQuadHardware(motors: PartBuilder, stack: PartBuilder): void {
  for (const [mx, my] of QUAD_MOTORS) {
    // The bell, sitting on top of the arm, and the hub the propeller runs on.
    motors.column(mx, my, -0.004, 0.016, 0.008, 10);
    motors.column(mx, my, 0.016, QUAD_PROP_Z, 0.0035, 6);
  }
  // Four standoffs holding the top plate off the bottom one.
  for (const sx of [1, -1] as const) {
    for (const sy of [1, -1] as const) {
      stack.column(sx * 0.024, sy * 0.016, -0.003, 0.026, 0.0025, 6);
    }
  }
  // The 20x20 stack itself: flight controller over speed controller.
  stack.box([-0.014, -0.014, -0.002], [0.014, 0.014, 0.021]);
}

/** The pack, strapped across the top plate where every one of them lives. */
function buildQuadPack(pack: PartBuilder): void {
  pack.box([-0.034, -0.017, 0.0275], [0.026, 0.017, 0.0485]);
}

/**
 * The camera, in a mount tilted back the way an FPV pilot sets one.
 *
 * The tilt is the aircraft's, not a preference: a quadcopter flies leaning
 * forward, so the camera has to look up out of the airframe by about as much
 * as the airframe is going to lean for the horizon to sit where the pilot
 * expects it.
 */
function buildQuadCamera(shell: PartBuilder, lens: PartBuilder): void {
  const tilt = (25 * Math.PI) / 180;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const cx = 0.042;
  const cz = 0.018;
  const half = 0.0125;
  // A square camera face, rotated back about the spanwise axis.
  const face = (out: number, up: number): Point => [
    cx + out * cos - up * sin,
    0,
    cz + out * sin + up * cos,
  ];
  const body: Point[] = [
    face(-0.012, -0.012),
    face(0.004, -0.012),
    face(0.004, 0.012),
    face(-0.012, 0.012),
  ];
  shell.plate(body, half * 2, 1);
  const glass: Point[] = [
    face(0.005, -0.006),
    face(0.008, -0.006),
    face(0.008, 0.006),
    face(0.005, 0.006),
  ];
  lens.plate(glass, 0.012, 1);
}

/** One three-bladed propeller, in the disc's own frame with the hub at zero. */
function buildQuadPropeller(prop: PartBuilder, direction: 1 | -1): void {
  const radius = QUAD_PROP_RADIUS;
  for (let blade = 0; blade < 3; blade += 1) {
    const angle = (blade / 3) * Math.PI * 2;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    // Out along the blade, and across it. The chord swaps sides with the
    // direction of rotation, which is what makes a pair of counter-rotating
    // propellers visibly a pair.
    const at = (out: number, across: number): Point => {
      const w = across * direction;
      return [out * ca - w * sa, out * sa + w * ca, 0];
    };
    const outline: Point[] = [
      at(0.006, -0.005),
      at(0.018, -0.010),
      at(radius * 0.9, -0.006),
      at(radius, 0.002),
      at(0.024, 0.010),
      at(0.008, 0.006),
    ];
    if (direction < 0) outline.reverse();
    prop.plate(outline, 0.0014, 2);
  }
  prop.column(0, 0, -0.002, 0.004, 0.007, 8);
}

let cachedQuad: AircraftMesh | null = null;

/** Builds (once) and returns the quadcopter mesh. */
export function buildQuadMesh(): AircraftMesh {
  if (cachedQuad) return cachedQuad;

  const bottom = new PartBuilder("quad-bottom", CARBON_DARK, PAINT.Shell, ARM_SHADE);
  const top = new PartBuilder("quad-top", CARBON, PAINT.Shell);
  const motors = new PartBuilder("quad-motors", MOTOR);
  const stack = new PartBuilder("quad-stack", STACK);
  const pack = new PartBuilder("quad-pack", PACK, PAINT.Accent, PACK_SHADE);
  const camera = new PartBuilder("quad-camera", CARBON, PAINT.Shell);
  const lens = new PartBuilder("quad-lens", LENS);

  buildQuadPlates(bottom, top);
  buildQuadHardware(motors, stack);
  buildQuadPack(pack);
  buildQuadCamera(camera, lens);

  const parts = [bottom, top, motors, stack, pack, camera, lens]
    .map((builder) => builder.build())
    .filter((part): part is MeshPart => part !== null);

  const propellers: PropellerGroup[] = [];
  for (let i = 0; i < QUAD_MOTORS.length; i += 1) {
    const entry = QUAD_MOTORS[i] as readonly [number, number, 1 | -1];
    const [mx, my, direction] = entry;
    const builder = new PartBuilder(`quad-prop-${i}`, MOTOR, PAINT.Accent, 0.55);
    buildQuadPropeller(builder, direction);
    const built = builder.build();
    if (!built) continue;
    propellers.push({
      name: builder.name,
      origin: [mx, my, QUAD_PROP_Z],
      axis: "z",
      direction,
      parts: [built],
    });
  }

  const triangleCount =
    [...parts, ...propellers.flatMap((group) => group.parts)].reduce(
      (sum, part) => sum + part.indices.length,
      0,
    ) / 3;

  cachedQuad = {
    kind: MESH_KIND.Quad,
    referenceSpan: MESH_QUAD_SPAN,
    parts,
    propellers,
    // Nothing hinges on a multirotor: it is steered by its own rotors, so the
    // airframe is one rigid piece and the animated and static forms are equal.
    elevonParts: { left: [], right: [] },
    elevonOrigin: [0, 0, 0],
    staticParts: parts,
    fpvCamera: { offset: [0.05, 0, 0.026], tiltDegrees: 25 },
    triangleCount,
  };
  return cachedQuad;
}

// --- The rocket -------------------------------------------------------------

/**
 * Procedural geometry for the X10 Interceptor.
 *
 * Modelled on the airframe in the photographs on issue #108: a 560 mm moulded
 * body with an ogive nose and a camera window let into it, four short swept
 * pylons half way down carrying the motors in bullet nacelles, two-bladed
 * propellers above them, and four fins at the base that the whole thing stands
 * on. Nothing here hinges — like the quadcopter, its control surfaces are its
 * own rotors.
 *
 * Same body frame as everything else: X = forward, Y = left, Z = up, origin at
 * the centre of gravity. What is different is where the aircraft *is* in that
 * frame. Every other airframe here lies along X; this one lies along Z, because
 * on a multirotor Z is the rotor axis and this is a rocket built around one. So
 * the geometry stands up in the body frame exactly as the real thing stands on
 * its fins, and it leans over to fly the same way the flight model leans it.
 */

/** Half the diagonal wheelbase along each axis: the motors sit at (+/-a, +/-a). */
const ROCKET_ARM = 0.115 / Math.SQRT2;
/** Propeller radius: 4.2 inches across. */
const ROCKET_PROP_RADIUS = (4.2 * 0.0254) / 2;
/** Height of the propeller discs above the centre of gravity. */
const ROCKET_PROP_Z = 0.035;
/** Where the body's nose finishes, and where its base does. */
const ROCKET_NOSE_Z = 0.338;
const ROCKET_TAIL_Z = -0.2;
/** Facets around the body. Enough that an ogive reads as one at ten metres. */
const ROCKET_SEGMENTS = 12;

const ROCKET_SHELL: readonly [number, number, number] = [0.085, 0.09, 0.1];
const ROCKET_TRIM: readonly [number, number, number] = [0.62, 0.03, 0.08];

/** How dark each moulding is against the body. */
const ROCKET_PYLON_SHADE = 0.82;
const ROCKET_FIN_SHADE = 0.9;

/** The four motor positions, front-left first and round the airframe. */
const ROCKET_MOTORS: readonly (readonly [number, number, 1 | -1])[] = [
  [ROCKET_ARM, ROCKET_ARM, 1],
  [ROCKET_ARM, -ROCKET_ARM, -1],
  [-ROCKET_ARM, -ROCKET_ARM, 1],
  [-ROCKET_ARM, ROCKET_ARM, -1],
];

/** One station of a body of revolution: a height on the axis and a radius. */
interface BodyStation {
  readonly z: number;
  readonly radius: number;
}

/**
 * The body: an ogive nose over a parallel middle, closed by a short boat-tail.
 *
 * Widest where the pylons come out of it, which is where the pack and the stack
 * are and where the centre of gravity has to be for the fins to be behind it.
 */
const ROCKET_BODY_STATIONS: readonly BodyStation[] = [
  { z: 0.323, radius: 0.009 },
  { z: 0.303, radius: 0.018 },
  { z: 0.275, radius: 0.027 },
  { z: 0.24, radius: 0.035 },
  { z: 0.19, radius: 0.041 },
  { z: 0.1, radius: 0.044 },
  { z: 0.0, radius: 0.044 },
  { z: -0.08, radius: 0.0435 },
  { z: -0.145, radius: 0.039 },
  { z: ROCKET_TAIL_Z, radius: 0.031 },
];

/** One nacelle: a bullet, blunt where the motor sits and pointed behind it. */
const ROCKET_NACELLE_STATIONS: readonly BodyStation[] = [
  { z: 0.021, radius: 0.0145 },
  { z: 0.0, radius: 0.0175 },
  { z: -0.04, radius: 0.018 },
  { z: -0.09, radius: 0.0165 },
  { z: -0.13, radius: 0.011 },
  { z: -0.158, radius: 0.003 },
];

/** A ring of points about a vertical axis, counter-clockwise seen from above. */
function rocketRing(
  centreX: number,
  centreY: number,
  station: BodyStation,
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < ROCKET_SEGMENTS; i += 1) {
    const angle = (i / ROCKET_SEGMENTS) * Math.PI * 2;
    points.push([
      centreX + Math.cos(angle) * station.radius,
      centreY + Math.sin(angle) * station.radius,
      station.z,
    ]);
  }
  return points;
}

/**
 * A body of revolution lofted through its stations, nose up.
 *
 * Stations run from the nose down, the nose is closed with a fan onto a point
 * on the axis, and the base is closed flat — which is what a boat-tail with a
 * motor mount in the end of it actually is.
 */
function buildRocketLathe(
  part: PartBuilder,
  centreX: number,
  centreY: number,
  stations: readonly BodyStation[],
  noseZ: number,
): void {
  const rings = stations.map((station) => rocketRing(centreX, centreY, station));

  const first = rings[0];
  if (!first) return;
  const tip: Point = [centreX, centreY, noseZ];
  for (let k = 0; k < first.length; k += 1) {
    part.triangle(tip, first[k]!, first[(k + 1) % first.length]!);
  }

  for (let i = 0; i + 1 < rings.length; i += 1) {
    const upper = rings[i]!;
    const lower = rings[i + 1]!;
    for (let k = 0; k < upper.length; k += 1) {
      const k2 = (k + 1) % upper.length;
      part.quad(upper[k]!, lower[k]!, lower[k2]!, upper[k2]!);
    }
  }

  const last = rings[rings.length - 1]!;
  const centre: Point = [centreX, centreY, last[0]![2]];
  for (let k = 0; k < last.length; k += 1) {
    part.triangle(centre, last[(k + 1) % last.length]!, last[k]!);
  }
}

/**
 * One pylon: a little wing, chord along the body and span out to a nacelle.
 *
 * Swept, so the tip sits lower than the root — which is what the photographs
 * show and what keeps the propeller discs clear of the widest part of the body.
 * Lofted between two sections rather than drawn as a flat plate, because the
 * two sides of it are not in the same plane once the arm runs diagonally.
 */
function buildRocketPylon(part: PartBuilder, mx: number, my: number): void {
  const length = Math.hypot(mx, my) || 1;
  const ux = mx / length;
  const uy = my / length;
  // Across the pylon, at right angles to the direction it runs in.
  const px = -uy;
  const py = ux;

  const section = (
    radius: number,
    halfThickness: number,
    top: number,
    bottom: number,
  ): Point[] => [
    [ux * radius + px * halfThickness, uy * radius + py * halfThickness, top],
    [ux * radius - px * halfThickness, uy * radius - py * halfThickness, top],
    [ux * radius - px * halfThickness, uy * radius - py * halfThickness, bottom],
    [ux * radius + px * halfThickness, uy * radius + py * halfThickness, bottom],
  ];

  const root = section(0.032, 0.012, 0.035, -0.095);
  const tip = section(length, 0.0085, -0.008, -0.1);

  for (let k = 0; k < root.length; k += 1) {
    const k2 = (k + 1) % root.length;
    part.quad(root[k]!, root[k2]!, tip[k2]!, tip[k]!);
  }
  part.quad(root[3]!, root[2]!, root[1]!, root[0]!);
  part.quad(tip[0]!, tip[1]!, tip[2]!, tip[3]!);
}

/**
 * The four fins, on the axes rather than under the pylons.
 *
 * They are the undercarriage as well as the tail: an X10 is stood on them on
 * the grass, which is why the aircraft has no arms to sit on the way a
 * quadcopter does and why the base of the body never touches the ground.
 */
function buildRocketFins(part: PartBuilder): void {
  /** Outline in (out, z), from the top of the root round to the bottom of it. */
  const outline: readonly (readonly [number, number])[] = [
    [0.036, -0.07],
    [0.088, -0.175],
    [0.088, -0.222],
    [0.03, -0.222],
  ];
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
  ] as const) {
    const points: Point[] = outline.map(([out, z]) =>
      axis === 0 ? [out * sign, 0, z] : [0, out * sign, z],
    );
    part.plate(points, 0.005, axis === 0 ? 1 : 0);
  }
}

/**
 * The camera, let into the slope of the nose.
 *
 * It looks along the body rather than out of the side of it, because on a
 * tail-sitter those are the same decision: the aircraft is pointing where it is
 * going only once it has leaned over, so a camera set square to the body would
 * spend the whole flight looking at the ground. Sixty-five degrees off the nose
 * is the compromise every one of these is delivered with — steeply up in a
 * hover, and the horizon a little under the middle of the picture at the lean
 * it does its work at.
 */
function buildRocketCamera(shell: PartBuilder, lens: PartBuilder): void {
  const tilt = (65 * Math.PI) / 180;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const cx = 0.026;
  const cz = 0.27;
  // A square camera face on the slope of the nose, rotated up out of the body
  // about the spanwise axis: `out` runs along the way it is looking.
  const face = (out: number, up: number): Point => [
    cx + out * cos - up * sin,
    0,
    cz + out * sin + up * cos,
  ];
  shell.plate(
    [
      face(-0.014, -0.011),
      face(0.004, -0.011),
      face(0.004, 0.011),
      face(-0.014, 0.011),
    ],
    0.022,
    1,
  );
  lens.plate(
    [
      face(0.005, -0.006),
      face(0.009, -0.006),
      face(0.009, 0.006),
      face(0.005, 0.006),
    ],
    0.012,
    1,
  );
}

/** One two-bladed propeller, in the disc's own frame with the hub at zero. */
function buildRocketPropeller(prop: PartBuilder, direction: 1 | -1): void {
  const radius = ROCKET_PROP_RADIUS;
  for (let blade = 0; blade < 2; blade += 1) {
    const angle = blade * Math.PI;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const at = (out: number, across: number): Point => {
      const w = across * direction;
      return [out * ca - w * sa, out * sa + w * ca, 0];
    };
    // Narrow and barely cambered: a propeller cut at more pitch than diameter
    // is mostly edge, which is why it pulls so badly slowly.
    const outline: Point[] = [
      at(0.008, -0.005),
      at(0.02, -0.009),
      at(radius * 0.88, -0.007),
      at(radius, 0.001),
      at(0.026, 0.009),
      at(0.01, 0.006),
    ];
    if (direction < 0) outline.reverse();
    prop.plate(outline, 0.0016, 2);
  }
  prop.column(0, 0, -0.002, 0.005, 0.0075, 8);
}

let cachedRocket: AircraftMesh | null = null;

/** Builds (once) and returns the rocket mesh. */
export function buildRocketMesh(): AircraftMesh {
  if (cachedRocket) return cachedRocket;

  const body = new PartBuilder("rocket-body", ROCKET_SHELL, PAINT.Shell);
  const pylons = new PartBuilder(
    "rocket-pylons",
    ROCKET_SHELL,
    PAINT.Shell,
    ROCKET_PYLON_SHADE,
  );
  const fins = new PartBuilder(
    "rocket-fins",
    ROCKET_SHELL,
    PAINT.Shell,
    ROCKET_FIN_SHADE,
  );
  const bells = new PartBuilder("rocket-bells", ROCKET_TRIM, PAINT.Accent);
  const lens = new PartBuilder("rocket-lens", LENS);

  buildRocketLathe(body, 0, 0, ROCKET_BODY_STATIONS, ROCKET_NOSE_Z);
  buildRocketFins(fins);
  buildRocketCamera(body, lens);
  for (const [mx, my] of ROCKET_MOTORS) {
    buildRocketPylon(pylons, mx, my);
    buildRocketLathe(pylons, mx, my, ROCKET_NACELLE_STATIONS, 0.028);
    // The bell itself, and the hub the propeller runs on.
    bells.column(mx, my, 0.021, 0.03, 0.0125, 10);
    bells.column(mx, my, 0.03, ROCKET_PROP_Z, 0.004, 6);
  }

  const parts = [body, pylons, fins, bells, lens]
    .map((builder) => builder.build())
    .filter((part): part is MeshPart => part !== null);

  const propellers: PropellerGroup[] = [];
  for (let i = 0; i < ROCKET_MOTORS.length; i += 1) {
    const entry = ROCKET_MOTORS[i] as readonly [number, number, 1 | -1];
    const [mx, my, direction] = entry;
    const builder = new PartBuilder(
      `rocket-prop-${i}`,
      MOTOR,
      PAINT.Accent,
      0.3,
    );
    buildRocketPropeller(builder, direction);
    const built = builder.build();
    if (!built) continue;
    propellers.push({
      name: builder.name,
      origin: [mx, my, ROCKET_PROP_Z],
      axis: "z",
      direction,
      parts: [built],
    });
  }

  const triangleCount =
    [...parts, ...propellers.flatMap((group) => group.parts)].reduce(
      (sum, part) => sum + part.indices.length,
      0,
    ) / 3;

  cachedRocket = {
    kind: MESH_KIND.Rocket,
    referenceSpan: MESH_ROCKET_SPAN,
    parts,
    propellers,
    // Nothing hinges: like the quadcopter, it is steered by its own rotors, so
    // the airframe is one rigid piece and the animated and static forms agree.
    elevonParts: { left: [], right: [] },
    elevonOrigin: [0, 0, 0],
    staticParts: parts,
    // In the nose, looking along it. The tilt is the whole of what makes a
    // tail-sitter flyable: at rest it is a view of the sky, and at the lean it
    // cruises at it is a view of the horizon.
    fpvCamera: { offset: [0.028, 0, 0.275], tiltDegrees: 65 },
    triangleCount,
  };
  return cachedRocket;
}

// --- The foam glider --------------------------------------------------------

/**
 * Procedural geometry for the Foamie Glider 480.
 *
 * Modelled on the glider in the photograph: a moulded EPP hand-launch glider,
 * 480 mm across and 500 mm nose to tail, with a slab fuselage, a black plastic
 * ballast cap on the nose, a straight wing with real dihedral and swept,
 * upturned tips, and a fin and tailplane on the back. The powered conversion
 * is what is actually drawn — two motors let into the wing leading edge, a
 * servo-driven surface a side on the trailing edge, and a camera where the
 * nose weight used to be.
 *
 * Same body frame as the wing: X = forward, Y = left, Z = up, origin at the
 * centre of gravity, which on this one sits just behind the wing leading edge.
 */

/** Root-to-tip stations describing the glider's planform. */
const GLIDER_STATIONS: readonly Station[] = [
  { y: 0.0, leading: 0.078, trailing: -0.017, thickness: 0.008, z: 0.014 },
  { y: 0.05, leading: 0.078, trailing: -0.017, thickness: 0.0075, z: 0.017 },
  { y: 0.14, leading: 0.072, trailing: -0.017, thickness: 0.006, z: 0.027 },
  { y: 0.19, leading: 0.058, trailing: -0.017, thickness: 0.005, z: 0.033 },
  { y: 0.225, leading: 0.032, trailing: -0.008, thickness: 0.0035, z: 0.042 },
  { y: 0.24, leading: 0.012, trailing: 0.0, thickness: 0.0025, z: 0.054 },
];

/** Chord fractions sampled across each section, nose to tail. */
const GLIDER_CHORD_SAMPLES = [0, 0.05, 0.15, 0.35, 0.65, 1] as const;

/**
 * The ailerons, and the line they are cut on.
 *
 * A surface a side out of the wing trailing edge, which is where roll comes
 * from on this one. They are built in their own hinge-relative frame like any
 * other control surface and then folded straight back into the wing, because
 * what actually moves in the picture is the elevator: there is one pair of
 * hinged surfaces per airframe, and on an aeroplane with a tail the one worth
 * spending it on is the tail.
 */
const GLIDER_HINGE_X = -0.001;
const GLIDER_HINGE_Z = 0.025;
/** Stations the ailerons run between: the fuselage side out to the tip panel. */
const GLIDER_ELEVON_FIRST_STATION = 1;
const GLIDER_ELEVON_LAST_STATION = 3;
/** Chord fractions across the surface itself, hinge to trailing edge. */
const GLIDER_ELEVON_SAMPLES = [0, 0.5, 1] as const;

/**
 * The elevator, and where it hinges.
 *
 * Half of the tailplane's chord, split at the fin into a half a side, and the
 * surface the flight model's pitch authority actually is: against a tail this
 * stiff nothing on the wing would move the aircraft in pitch at all. The two
 * halves are driven together, so what a pilot sees is an elevator; the flight
 * model deflects them apart as well, which is the aileron command showing up
 * on the only surface there is to show it on.
 */
const GLIDER_ELEVATOR_HINGE_X = -0.205;
const GLIDER_ELEVATOR_HINGE_Z = 0.016;
/** Half-span of the tailplane, and where the elevator clears the fin. */
const GLIDER_TAIL_HALF_SPAN = 0.075;
const GLIDER_TAIL_ROOT_GAP = 0.006;

/** Foam and hardware colours, as the airframe comes out of the bag. */
const FOAM_TOP: readonly [number, number, number] = [0.165, 0.294, 0.784];
const FOAM_BOTTOM: readonly [number, number, number] = [0.119, 0.212, 0.565];
const FOAM_FLECK: readonly [number, number, number] = [0.941, 0.541, 0.118];
const NOSE_BLOCK: readonly [number, number, number] = [0.05, 0.052, 0.058];

/** How dark each foam panel is against the top of the wing. */
const GLIDER_BOTTOM_SHADE = 0.72;
const GLIDER_BODY_SHADE = 0.86;
const GLIDER_TAIL_SHADE = 0.93;

/** True for stations that carry a moving surface behind them. */
function hasGliderElevon(index: number): boolean {
  return (
    index >= GLIDER_ELEVON_FIRST_STATION && index <= GLIDER_ELEVON_LAST_STATION
  );
}

/** Chord fraction at which the hinge crosses a station. */
function gliderHingeFraction(station: Station): number {
  const chord = station.leading - station.trailing;
  if (chord <= 1e-6) return 1;
  const f = (station.leading - GLIDER_HINGE_X) / chord;
  return Math.min(0.94, Math.max(0.2, f));
}

/**
 * The foam section, as a fraction of thickness.
 *
 * Nothing like the delta's reflexed aerofoil: a moulded glider wing is a
 * curved top and a nearly flat bottom, which is what makes it fly as slowly
 * as it does and why it will not hold inverted for long.
 */
function gliderUpperProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return 0.9 * Math.sin(Math.PI * Math.pow(f, 0.55));
}

function gliderLowerProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return -0.18 * Math.sin(Math.PI * Math.pow(f, 0.9));
}

function gliderSurfacePoint(
  station: Station,
  fraction: number,
  upper: boolean,
  sign: number,
): Point {
  const chord = station.leading - station.trailing;
  const x = station.leading - chord * fraction;
  const profile = upper
    ? gliderUpperProfile(fraction)
    : gliderLowerProfile(fraction);
  return [x, station.y * sign, station.z + profile * station.thickness];
}

function buildGliderWing(top: PartBuilder, bottom: PartBuilder): void {
  for (const sign of [1, -1] as const) {
    for (let s = 0; s + 1 < GLIDER_STATIONS.length; s += 1) {
      const inner = GLIDER_STATIONS[s]!;
      const outer = GLIDER_STATIONS[s + 1]!;
      // A panel is cut back to the hinge only where the aileron runs the whole
      // width of it. Lofting the cut into a panel that is only half covered
      // would take a slice out of the trailing edge instead of leaving the
      // square-ended cut-out the foam actually has.
      const cut = hasGliderElevon(s) && hasGliderElevon(s + 1);
      const innerEnd = cut ? gliderHingeFraction(inner) : 1;
      const outerEnd = cut ? gliderHingeFraction(outer) : 1;

      for (let c = 0; c + 1 < GLIDER_CHORD_SAMPLES.length; c += 1) {
        const f0 = GLIDER_CHORD_SAMPLES[c]!;
        const f1 = GLIDER_CHORD_SAMPLES[c + 1]!;

        const a = gliderSurfacePoint(inner, f0 * innerEnd, true, sign);
        const b = gliderSurfacePoint(outer, f0 * outerEnd, true, sign);
        const cc = gliderSurfacePoint(outer, f1 * outerEnd, true, sign);
        const d = gliderSurfacePoint(inner, f1 * innerEnd, true, sign);
        if (sign > 0) top.quad(a, b, cc, d);
        else top.quad(a, d, cc, b);

        const a2 = gliderSurfacePoint(inner, f0 * innerEnd, false, sign);
        const b2 = gliderSurfacePoint(outer, f0 * outerEnd, false, sign);
        const c2 = gliderSurfacePoint(outer, f1 * outerEnd, false, sign);
        const d2 = gliderSurfacePoint(inner, f1 * innerEnd, false, sign);
        if (sign > 0) bottom.quad(a2, d2, c2, b2);
        else bottom.quad(a2, b2, c2, d2);
      }

      // Close the back of the panel: the blunt trailing edge where the wing
      // is fixed, and the face the surface hinges away from where it is not.
      const teTopInner = gliderSurfacePoint(inner, innerEnd, true, sign);
      const teTopOuter = gliderSurfacePoint(outer, outerEnd, true, sign);
      const teBotInner = gliderSurfacePoint(inner, innerEnd, false, sign);
      const teBotOuter = gliderSurfacePoint(outer, outerEnd, false, sign);
      if (sign > 0) bottom.quad(teTopInner, teBotInner, teBotOuter, teTopOuter);
      else bottom.quad(teTopInner, teTopOuter, teBotOuter, teBotInner);

    }

    // Either end of the cut-out is a step in the surface: the wing keeps its
    // full chord up to it and stops. Rib it over, which is exactly what the
    // foam does either side of a taped hinge.
    for (const index of [
      GLIDER_ELEVON_FIRST_STATION,
      GLIDER_ELEVON_LAST_STATION,
    ] as const) {
      const station = GLIDER_STATIONS[index]!;
      const f = gliderHingeFraction(station);
      const rTop0 = gliderSurfacePoint(station, f, true, sign);
      const rTop1 = gliderSurfacePoint(station, 1, true, sign);
      const rBot0 = gliderSurfacePoint(station, f, false, sign);
      const rBot1 = gliderSurfacePoint(station, 1, false, sign);
      // The inboard rib is the outboard end of the root panel and faces out;
      // the outboard one faces back in at the tip panel.
      const outward = (index === GLIDER_ELEVON_LAST_STATION) === (sign > 0);
      if (outward) bottom.quad(rTop0, rTop1, rBot1, rBot0);
      else bottom.quad(rTop0, rBot0, rBot1, rTop1);
    }

    // Cap the tip rib.
    const tip = GLIDER_STATIONS[GLIDER_STATIONS.length - 1]!;
    for (let c = 0; c + 1 < GLIDER_CHORD_SAMPLES.length; c += 1) {
      const f0 = GLIDER_CHORD_SAMPLES[c]!;
      const f1 = GLIDER_CHORD_SAMPLES[c + 1]!;
      const t0 = gliderSurfacePoint(tip, f0, true, sign);
      const t1 = gliderSurfacePoint(tip, f1, true, sign);
      const b0 = gliderSurfacePoint(tip, f0, false, sign);
      const b1 = gliderSurfacePoint(tip, f1, false, sign);
      if (sign > 0) top.quad(t0, t1, b1, b0);
      else top.quad(t0, b0, b1, t1);
    }
  }
}

/** One trailing-edge surface, in a frame whose origin sits on its hinge. */
function buildGliderElevon(part: PartBuilder, sign: number): void {
  const ox = GLIDER_HINGE_X;
  const oz = GLIDER_HINGE_Z;
  const local = (p: Point): Point => [p[0] - ox, p[1], p[2] - oz];
  const quad = (a: Point, b: Point, c: Point, d: Point): void => {
    if (sign > 0) part.quad(local(a), local(b), local(c), local(d));
    else part.quad(local(a), local(d), local(c), local(b));
  };
  const at = (station: Station, g: number, upper: boolean): Point => {
    const hinge = gliderHingeFraction(station);
    return gliderSurfacePoint(station, hinge + (1 - hinge) * g, upper, sign);
  };

  for (
    let st = GLIDER_ELEVON_FIRST_STATION;
    st < GLIDER_ELEVON_LAST_STATION;
    st += 1
  ) {
    const inner = GLIDER_STATIONS[st]!;
    const outer = GLIDER_STATIONS[st + 1]!;

    for (let c = 0; c + 1 < GLIDER_ELEVON_SAMPLES.length; c += 1) {
      const g0 = GLIDER_ELEVON_SAMPLES[c]!;
      const g1 = GLIDER_ELEVON_SAMPLES[c + 1]!;
      quad(
        at(inner, g0, true),
        at(outer, g0, true),
        at(outer, g1, true),
        at(inner, g1, true),
      );
      const b0 = at(inner, g0, false);
      const b1 = at(outer, g0, false);
      const b2 = at(outer, g1, false);
      const b3 = at(inner, g1, false);
      if (sign > 0) part.quad(local(b0), local(b3), local(b2), local(b1));
      else part.quad(local(b0), local(b1), local(b2), local(b3));
    }

    // Blunt trailing edge.
    const teTopInner = at(inner, 1, true);
    const teTopOuter = at(outer, 1, true);
    const teBotInner = at(inner, 1, false);
    const teBotOuter = at(outer, 1, false);
    if (sign > 0) {
      quad(teTopInner, teBotInner, teBotOuter, teTopOuter);
    } else {
      part.quad(
        local(teTopInner),
        local(teTopOuter),
        local(teBotOuter),
        local(teBotInner),
      );
    }
  }

  // Cap both ends, and close the face the hinge exposes when it deflects.
  for (const index of [
    GLIDER_ELEVON_FIRST_STATION,
    GLIDER_ELEVON_LAST_STATION,
  ] as const) {
    const station = GLIDER_STATIONS[index]!;
    // The inboard end of the surface faces the root and the outboard end the
    // tip, which is the other way round from the wing rib it sits against.
    const inward = (index === GLIDER_ELEVON_FIRST_STATION) === (sign > 0);
    for (let c = 0; c + 1 < GLIDER_ELEVON_SAMPLES.length; c += 1) {
      const g0 = GLIDER_ELEVON_SAMPLES[c]!;
      const g1 = GLIDER_ELEVON_SAMPLES[c + 1]!;
      const t0 = at(station, g0, true);
      const t1 = at(station, g1, true);
      const b0 = at(station, g0, false);
      const b1 = at(station, g1, false);
      if (inward) part.quad(local(t0), local(t1), local(b1), local(b0));
      else part.quad(local(t0), local(b0), local(b1), local(t1));
    }
  }

  for (
    let st = GLIDER_ELEVON_FIRST_STATION;
    st < GLIDER_ELEVON_LAST_STATION;
    st += 1
  ) {
    const inner = GLIDER_STATIONS[st]!;
    const outer = GLIDER_STATIONS[st + 1]!;
    const t0 = at(inner, 0, true);
    const t1 = at(outer, 0, true);
    const b0 = at(inner, 0, false);
    const b1 = at(outer, 0, false);
    if (sign > 0) part.quad(local(t0), local(t1), local(b1), local(b0));
    else part.quad(local(t0), local(b0), local(b1), local(t1));
  }
}

/**
 * The fuselage: a slab of foam, deeper than it is wide.
 *
 * Lofted through rings like the wing's pod, but the shape is a different
 * argument entirely — this one is a keel, and it is most of what makes the
 * glider hold a heading with nobody touching it.
 */
interface GliderRing {
  x: number;
  halfWidth: number;
  top: number;
  bottom: number;
}

const GLIDER_BODY: readonly GliderRing[] = [
  { x: 0.25, halfWidth: 0.007, top: 0.004, bottom: -0.011 },
  { x: 0.22, halfWidth: 0.013, top: 0.011, bottom: -0.021 },
  { x: 0.16, halfWidth: 0.018, top: 0.017, bottom: -0.029 },
  { x: 0.08, halfWidth: 0.019, top: 0.021, bottom: -0.031 },
  { x: 0.0, halfWidth: 0.018, top: 0.02, bottom: -0.029 },
  { x: -0.08, halfWidth: 0.014, top: 0.018, bottom: -0.022 },
  { x: -0.16, halfWidth: 0.01, top: 0.015, bottom: -0.013 },
  { x: -0.235, halfWidth: 0.006, top: 0.013, bottom: -0.007 },
];

/** Rings ahead of this one are the black plastic cap, not foam. */
const GLIDER_NOSE_RINGS = 3;

function gliderRingPoints(ring: GliderRing): Point[] {
  return [
    [ring.x, 0, ring.top],
    [ring.x, ring.halfWidth, ring.top * 0.6],
    [ring.x, ring.halfWidth * 0.8, ring.bottom * 0.55],
    [ring.x, 0, ring.bottom],
    [ring.x, -ring.halfWidth * 0.8, ring.bottom * 0.55],
    [ring.x, -ring.halfWidth, ring.top * 0.6],
  ];
}

function buildGliderBody(shell: PartBuilder, nose: PartBuilder): void {
  for (let i = 0; i + 1 < GLIDER_BODY.length; i += 1) {
    // The cap is a moulded lump of plastic pushed onto the front of the foam,
    // and it is the whole reason one of these balances where it does.
    const part = i + 1 <= GLIDER_NOSE_RINGS ? nose : shell;
    const a = gliderRingPoints(GLIDER_BODY[i]!);
    const b = gliderRingPoints(GLIDER_BODY[i + 1]!);
    for (let k = 0; k < a.length; k += 1) {
      const k2 = (k + 1) % a.length;
      part.quad(a[k]!, a[k2]!, b[k2]!, b[k]!);
    }
  }

  const front = gliderRingPoints(GLIDER_BODY[0]!);
  const noseTip: Point = [0.265, 0, -0.004];
  for (let k = 0; k < front.length; k += 1) {
    nose.triangle(noseTip, front[(k + 1) % front.length]!, front[k]!);
  }
  const back = gliderRingPoints(GLIDER_BODY[GLIDER_BODY.length - 1]!);
  const tailTip: Point = [-0.25, 0, 0.004];
  for (let k = 0; k < back.length; k += 1) {
    shell.triangle(tailTip, back[k]!, back[(k + 1) % back.length]!);
  }
}

/**
 * Fin and tailplane.
 *
 * The glider's own, left alone by the conversion and doing the job they were
 * moulded for: the fin is why it weathervanes and the tailplane is why it
 * flies out of a stall on its own instead of falling out of one.
 */
function buildGliderTail(tail: PartBuilder): void {
  const fin: Point[] = [
    [-0.145, 0, 0.014],
    [-0.203, 0, 0.08],
    [-0.242, 0, 0.08],
    [-0.25, 0, 0.014],
  ];
  tail.plate(fin, 0.006, 1);

  // The tailplane ahead of the hinge line. What is behind it is the elevator,
  // and that is built in its own frame so it can move.
  const z = GLIDER_ELEVATOR_HINGE_Z;
  const hinge = GLIDER_ELEVATOR_HINGE_X;
  const span = GLIDER_TAIL_HALF_SPAN;
  const stabiliser: Point[] = [
    [-0.15, 0, z],
    [-0.184, span, z],
    [hinge, span, z],
    [hinge, -span, z],
    [-0.184, -span, z],
  ];
  tail.plate(stabiliser, 0.004, 2);
}

/**
 * One half of the elevator, in a frame whose origin sits on its hinge.
 *
 * Built hinge-relative for the same reason every other moving surface here is:
 * the renderer deflects it with a single rotation about the local Y axis and
 * never touches a vertex.
 */
function buildGliderElevator(part: PartBuilder, sign: number): void {
  const hinge = GLIDER_ELEVATOR_HINGE_X;
  const inner = GLIDER_TAIL_ROOT_GAP * sign;
  const outer = GLIDER_TAIL_HALF_SPAN * sign;
  const outline: Point[] = [
    [0, inner, 0],
    [0, outer, 0],
    [-0.242 - hinge, outer, 0],
    [-0.25 - hinge, inner, 0],
  ];
  // Reversing keeps the outward face consistent on the mirrored half.
  if (sign < 0) outline.reverse();
  part.plate(outline, 0.004, 2);
}

/** Where the motors sit: half a span apart, let into the leading edge. */
const GLIDER_MOTOR_Y = 0.11;
const GLIDER_MOTOR_Z = 0.022;
/** Propeller radius: two and a half inches across. */
const GLIDER_PROP_RADIUS = (2.5 * 0.0254) / 2;
const GLIDER_PROP_X = 0.101;

/** The two nacelles, cut into the wing and pointing where the aircraft does. */
function buildGliderNacelles(motors: PartBuilder): void {
  const segments = 10;
  const front = 0.096;
  const back = 0.05;
  const radius = 0.011;
  for (const sign of [1, -1] as const) {
    const y = GLIDER_MOTOR_Y * sign;
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0: Point = [
        front,
        y + Math.cos(a0) * radius,
        GLIDER_MOTOR_Z + Math.sin(a0) * radius,
      ];
      const p1: Point = [
        front,
        y + Math.cos(a1) * radius,
        GLIDER_MOTOR_Z + Math.sin(a1) * radius,
      ];
      const q0: Point = [back, p0[1], p0[2]];
      const q1: Point = [back, p1[1], p1[2]];
      motors.quad(p0, q0, q1, p1);
      motors.triangle([front, y, GLIDER_MOTOR_Z], p0, p1);
    }
  }
}

/** The camera, sitting on the cap where the ballast used to be. */
function buildGliderCamera(nose: PartBuilder, lens: PartBuilder): void {
  const x0 = 0.2;
  const x1 = 0.245;
  const halfWidth = 0.011;
  const zBottom = 0.012;
  const zTop = 0.036;
  const corners: Point[] = [
    [x0, 0, zBottom],
    [x1, 0, zBottom],
    [x1, 0, zTop],
    [x0, 0, zTop],
  ];
  nose.plate(corners, halfWidth * 2, 1);
  const lensCorners: Point[] = [
    [x1 + 0.002, -0.007, zBottom + 0.005],
    [x1 + 0.007, -0.007, zTop - 0.004],
    [x1 + 0.007, 0.007, zTop - 0.004],
    [x1 + 0.002, 0.007, zBottom + 0.005],
  ];
  lens.plate(lensCorners, 0.004, 0);
}

/**
 * The flecks through the foam.
 *
 * EPP of this kind is moulded from beads of two colours, and the speckle is
 * the first thing anybody notices about one. Scattered from a fixed sequence
 * rather than a random one so the aircraft is the same aircraft every time it
 * is drawn, and laid on the upper surface only, which is the side anybody
 * looking at it from above can see.
 */
function buildGliderSpeckles(accent: PartBuilder): void {
  const count = 26;
  const lift = 0.0006;
  for (let i = 0; i < count; i += 1) {
    // Two irrationals stepped round the unit interval: it scatters far more
    // evenly than a random sequence of the same length, and it never clumps.
    const spanwise = (i * 0.6180339887) % 1;
    const chordwise = (i * 0.7548776662) % 1;
    const sign = i % 2 === 0 ? 1 : -1;
    const y = 0.02 + spanwise * 0.2;
    const f = 0.08 + chordwise * 0.7;
    const station = gliderStationAt(y);
    const size = 0.006 + ((i * 7) % 5) * 0.0018;
    const half = size / 2;
    const chord = Math.max(station.leading - station.trailing, 1e-6);
    const df = half / chord;
    const dy = half / 0.24;
    const corner = (fo: number, yo: number): Point => {
      const at = gliderStationAt(Math.max(0.005, y + yo * 0.24));
      const p = gliderSurfacePoint(
        at,
        Math.min(0.96, Math.max(0.02, f + fo)),
        true,
        sign,
      );
      return [p[0], p[1], p[2] + lift];
    };
    const a = corner(-df, -dy);
    const b = corner(-df, dy);
    const c = corner(df, dy);
    const d = corner(df, -dy);
    if (sign > 0) accent.quad(a, b, c, d);
    else accent.quad(a, d, c, b);
  }
}

/** Interpolates the glider's wing section at an arbitrary span position. */
function gliderStationAt(y: number): Station {
  const target = Math.abs(y);
  for (let i = 0; i + 1 < GLIDER_STATIONS.length; i += 1) {
    const a = GLIDER_STATIONS[i]!;
    const b = GLIDER_STATIONS[i + 1]!;
    if (target <= b.y) {
      const t = (target - a.y) / (b.y - a.y || 1);
      return {
        y: target,
        leading: a.leading + (b.leading - a.leading) * t,
        trailing: a.trailing + (b.trailing - a.trailing) * t,
        thickness: a.thickness + (b.thickness - a.thickness) * t,
        z: a.z + (b.z - a.z) * t,
      };
    }
  }
  return {
    ...(GLIDER_STATIONS[GLIDER_STATIONS.length - 1] as Station),
    y: target,
  };
}

/** One two-bladed propeller, in the disc's own frame with the hub at zero. */
function buildGliderPropeller(prop: PartBuilder, direction: 1 | -1): void {
  const radius = GLIDER_PROP_RADIUS;
  const blade = (side: 1 | -1): Point[] => {
    const points: Point[] = [
      [0, 0.004 * direction, 0.004 * side],
      [0, 0.006 * direction, 0.013 * side],
      [0, 0.004 * direction, radius * side],
      [0, -0.003 * direction, radius * 0.92 * side],
      [0, -0.005 * direction, 0.012 * side],
      [0, -0.003 * direction, 0.004 * side],
    ];
    return side === 1 ? points : points.slice().reverse();
  };
  prop.plate(blade(1), 0.0012, 0);
  prop.plate(blade(-1), 0.0012, 0);

  // The bell of the motor behind the propeller, which is all a 1202.5 is.
  const segments = 8;
  const hubRadius = 0.006;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    prop.triangle(
      [0.006, 0, 0],
      [0, Math.cos(a0) * hubRadius, Math.sin(a0) * hubRadius],
      [0, Math.cos(a1) * hubRadius, Math.sin(a1) * hubRadius],
    );
  }
}

let cachedGlider: AircraftMesh | null = null;

/** Builds (once) and returns the foam glider mesh. */
export function buildGliderMesh(): AircraftMesh {
  if (cachedGlider) return cachedGlider;

  const top = new PartBuilder("glider-top", FOAM_TOP, PAINT.Shell);
  const bottom = new PartBuilder(
    "glider-bottom",
    FOAM_BOTTOM,
    PAINT.Shell,
    GLIDER_BOTTOM_SHADE,
  );
  const body = new PartBuilder(
    "glider-body",
    FOAM_TOP,
    PAINT.Shell,
    GLIDER_BODY_SHADE,
  );
  const tail = new PartBuilder(
    "glider-tail",
    FOAM_TOP,
    PAINT.Shell,
    GLIDER_TAIL_SHADE,
  );
  const nose = new PartBuilder("glider-nose", NOSE_BLOCK);
  const motors = new PartBuilder("glider-motors", MOTOR);
  const lens = new PartBuilder("glider-lens", LENS);
  const speckle = new PartBuilder("glider-speckle", FOAM_FLECK, PAINT.Accent);
  const aileronLeft = new PartBuilder("glider-aileron-left", FOAM_TOP, PAINT.Shell);
  const aileronRight = new PartBuilder(
    "glider-aileron-right",
    FOAM_TOP,
    PAINT.Shell,
  );
  const elevatorLeft = new PartBuilder(
    "glider-elevator-left",
    FOAM_TOP,
    PAINT.Shell,
    GLIDER_TAIL_SHADE,
  );
  const elevatorRight = new PartBuilder(
    "glider-elevator-right",
    FOAM_TOP,
    PAINT.Shell,
    GLIDER_TAIL_SHADE,
  );

  buildGliderWing(top, bottom);
  buildGliderElevon(aileronLeft, 1);
  buildGliderElevon(aileronRight, -1);
  buildGliderElevator(elevatorLeft, 1);
  buildGliderElevator(elevatorRight, -1);
  buildGliderBody(body, nose);
  buildGliderTail(tail);
  buildGliderNacelles(motors);
  buildGliderCamera(nose, lens);
  buildGliderSpeckles(speckle);

  // The ailerons are drawn where they sit and stay there: the hinge line is
  // visible in the wing, and the surface the pilot watches move is the tail.
  const ailerons = [aileronLeft.build(), aileronRight.build()]
    .filter((part): part is MeshPart => part !== null)
    .map((part) => translated(part, GLIDER_HINGE_X, 0, GLIDER_HINGE_Z));
  const parts = [
    ...[top, bottom, body, tail, nose, motors, lens, speckle]
      .map((builder) => builder.build())
      .filter((part): part is MeshPart => part !== null),
    ...ailerons,
  ];

  // Counter-rotating, the way a twin is set up when somebody has thought about
  // it: two propellers turning the same way put a torque roll into an aircraft
  // this light that the pilot then has to hold out on the sticks all flight.
  const propellers: PropellerGroup[] = [];
  for (const sign of [1, -1] as const) {
    const direction: 1 | -1 = sign > 0 ? 1 : -1;
    const builder = new PartBuilder(
      `glider-prop-${sign > 0 ? "left" : "right"}`,
      MOTOR,
    );
    buildGliderPropeller(builder, direction);
    const built = builder.build();
    if (!built) continue;
    propellers.push({
      name: builder.name,
      origin: [GLIDER_PROP_X, GLIDER_MOTOR_Y * sign, GLIDER_MOTOR_Z],
      axis: "x",
      direction,
      parts: [built],
    });
  }

  const leftParts = [elevatorLeft.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const rightParts = [elevatorRight.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const staticParts = [
    ...parts,
    ...[...leftParts, ...rightParts].map((part) =>
      translated(part, GLIDER_ELEVATOR_HINGE_X, 0, GLIDER_ELEVATOR_HINGE_Z),
    ),
  ];

  const triangleCount =
    [
      ...parts,
      ...propellers.flatMap((group) => group.parts),
      ...leftParts,
      ...rightParts,
    ].reduce((sum, part) => sum + part.indices.length, 0) / 3;

  cachedGlider = {
    kind: MESH_KIND.Glider,
    referenceSpan: MESH_GLIDER_SPAN,
    parts,
    propellers,
    elevonParts: { left: leftParts, right: rightParts },
    elevonOrigin: [GLIDER_ELEVATOR_HINGE_X, 0, GLIDER_ELEVATOR_HINGE_Z],
    staticParts,
    // On the nose cap, looking a little up and over the wing: there is no pod
    // to sit in on one of these, and the camera goes where the ballast was.
    fpvCamera: { offset: [0.248, 0, 0.026], tiltDegrees: 15 },
    triangleCount,
  };
  return cachedGlider;
}

// --- The Skyeye series ------------------------------------------------------

/**
 * Procedural geometry for the Airmobi Skyeye.
 *
 * The first aeroplane in the hangar rather than the fifth wing: a carbon
 * fuselage pod with the payload in the nose, a high tapered wing on top of it,
 * two tailbooms out of the wing carrying a tailplane and a fin apiece, a pusher
 * propeller turning between them, and — the part the rest of the simulator
 * cares about — a fixed tricycle undercarriage underneath. Every one of those
 * is something no other airframe here has.
 *
 * Drawn at the 3600's size, which is the middle of the series and the airframe
 * it is best known as, and every other Skyeye is this one scaled: they are the
 * same aeroplane between 2.6 and 6 metres. That is also why the wheels are
 * where they are — the undercarriage holds the aircraft's reference point a
 * twelfth of its span off the ground, and `wheeledGroundContact` uses exactly
 * that fraction, so a Skyeye of any size stands on its wheels rather than
 * hovering over them or sinking into the field.
 *
 * The tail drawn here is the twin-boom tailplane-and-fins the 2600, 3200, 3600
 * and 6000 carry; the 5000 is sold with an inverted V on the same booms, which
 * is a difference in its specification rather than in how any of them fly.
 *
 * Same body frame as everything else: X = forward, Y = left, Z = up, origin at
 * the centre of gravity, which on one of these is inside the fuselage at about
 * a quarter of the wing chord.
 */

/**
 * Wing span of the Skyeye this geometry was drawn from, metres.
 *
 * The 3600's own span, so a renderer handed that airframe scales the mesh by
 * exactly one and the other four by the ratio of their spans to it.
 */
export const MESH_SKYEYE_SPAN = 3.6;

/** Root-to-tip stations describing the Skyeye's tapered high wing. */
const SKYEYE_STATIONS: readonly Station[] = [
  { y: 0.0, leading: 0.1, trailing: -0.3, thickness: 0.052, z: 0.115 },
  { y: 0.22, leading: 0.1, trailing: -0.3, thickness: 0.05, z: 0.117 },
  { y: 0.62, leading: 0.085, trailing: -0.285, thickness: 0.044, z: 0.128 },
  { y: 1.05, leading: 0.06, trailing: -0.255, thickness: 0.036, z: 0.145 },
  { y: 1.48, leading: 0.03, trailing: -0.215, thickness: 0.028, z: 0.165 },
  { y: 1.8, leading: 0.005, trailing: -0.175, thickness: 0.02, z: 0.182 },
];

/** Chord fractions sampled across each section, nose to tail. */
const SKYEYE_CHORD_SAMPLES = [0, 0.04, 0.14, 0.36, 0.66, 1] as const;

/**
 * The ailerons, and the line they are cut on.
 *
 * Out on the panels past the booms, where a real aeroplane puts them, and
 * stopping short of the tip. They are drawn where they sit rather than moved:
 * on an aircraft with a tail the surface a pilot watches is the elevator, and
 * there is one pair of hinged surfaces per airframe to spend.
 */
const SKYEYE_HINGE_X = -0.19;
const SKYEYE_HINGE_Z = 0.155;
const SKYEYE_FIRST_AILERON_STATION = 3;
const SKYEYE_LAST_AILERON_STATION = 4;
const SKYEYE_AILERON_SAMPLES = [0, 0.5, 1] as const;

/**
 * The Skyeye's section: a cambered UAV aerofoil.
 *
 * Nothing like a flying wing's reflexed section, because it does not have to
 * trim itself — there is a tailplane a metre and a half behind it doing that.
 * So it is fuller on top and properly undercambered, which is what makes lift
 * at the incidence the aeroplane sits at on its undercarriage and is why it can
 * be rotated off a runway rather than thrown.
 */
function skyeyeUpperProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return 0.66 * Math.sin(Math.PI * Math.pow(f, 0.5));
}

function skyeyeLowerProfile(f: number): number {
  if (f <= 0 || f >= 1) return 0;
  return -0.26 * Math.sin(Math.PI * Math.pow(f, 0.9));
}

const SKYEYE_PLANFORM: Planform = {
  stations: SKYEYE_STATIONS,
  chordSamples: SKYEYE_CHORD_SAMPLES,
  hingeX: SKYEYE_HINGE_X,
  hingeZ: SKYEYE_HINGE_Z,
  firstElevonStation: SKYEYE_FIRST_AILERON_STATION,
  lastElevonStation: SKYEYE_LAST_AILERON_STATION,
  elevonSamples: SKYEYE_AILERON_SAMPLES,
  upper: skyeyeUpperProfile,
  lower: skyeyeLowerProfile,
};

/** A band across each outer panel, so it can be seen at three kilometres. */
const SKYEYE_ACCENT_BANDS: readonly (readonly [number, number])[] = [
  [1.5, 1.72],
];

/** Where the booms run, and how thick they are. */
const SKYEYE_BOOM_Y = 0.62;
const SKYEYE_BOOM_Z = 0.085;
const SKYEYE_BOOM_RADIUS = 0.028;
const SKYEYE_BOOM_FRONT = 0.07;
const SKYEYE_BOOM_BACK = -1.46;

/** The tailplane, and the elevator hinged into the back of it. */
const SKYEYE_TAIL_Z = 0.375;
const SKYEYE_TAIL_HALF_SPAN = 0.66;
const SKYEYE_TAIL_ROOT_GAP = 0.012;
const SKYEYE_ELEVATOR_HINGE_X = -1.36;
const SKYEYE_TAIL_LEAD = -1.27;
const SKYEYE_TAIL_TRAIL = -1.45;

/** The pusher, between the booms and behind the fuselage. */
const SKYEYE_PROP_X = -0.73;
const SKYEYE_PROP_AXIS_Z = 0.055;
/** Twenty-two inches across, which is what the delivered engine turns. */
const SKYEYE_PROP_RADIUS = (22 * 0.0254) / 2;

/**
 * The undercarriage, and the whole reason this aeroplane is different.
 *
 * A twelfth of the span below the aircraft's reference point is where the
 * wheels touch, which is `wheeledGroundContact`'s resting height and therefore
 * where the aircraft is actually held: draw them anywhere else and it stands on
 * air or buries its nosewheel. The nose leg is forward of the centre of gravity
 * and the mains are just behind it, which is what a tricycle undercarriage is
 * and why one of these sits nose-up and rotates rather than tipping onto its
 * back.
 */
const SKYEYE_GROUND_Z = -MESH_SKYEYE_SPAN / 12;
const SKYEYE_NOSE_WHEEL_X = 0.6;
const SKYEYE_NOSE_WHEEL_RADIUS = 0.065;
const SKYEYE_MAIN_WHEEL_X = -0.06;
const SKYEYE_MAIN_WHEEL_Y = 0.36;
const SKYEYE_MAIN_WHEEL_RADIUS = 0.08;

/** Carbon, glass and rubber, as one comes off the trailer. */
const SKYEYE_SHELL_TOP: readonly [number, number, number] = [0.72, 0.75, 0.78];
const SKYEYE_SHELL_BOTTOM: readonly [number, number, number] = [0.5, 0.53, 0.57];
const SKYEYE_POD: readonly [number, number, number] = [0.63, 0.66, 0.7];
const SKYEYE_ACCENT: readonly [number, number, number] = [0.12, 0.21, 0.31];
const SKYEYE_TYRE: readonly [number, number, number] = [0.07, 0.07, 0.075];

const SKYEYE_BOTTOM_SHADE = 0.7;
const SKYEYE_POD_SHADE = 0.88;
const SKYEYE_TAIL_SHADE = 0.94;

/**
 * The fuselage, lofted through a handful of rounded cross-sections.
 *
 * A pod rather than a tube: deep and flat-sided where the payload and the tank
 * live, drawn in to a cone at the back for the propeller, and tapering to a
 * blunt nose with the camera in it. The top decking is flat under the wing
 * root, because that is where the wing bolts on.
 *
 * Each entry is a station: how far forward, how wide, and how far the skin
 * reaches above and below the centreline there.
 */
const SKYEYE_BODY: readonly (readonly [number, number, number, number])[] = [
  [0.95, 0.022, 0.024, -0.024],
  [0.85, 0.058, 0.056, -0.062],
  [0.7, 0.096, 0.086, -0.1],
  [0.45, 0.114, 0.1, -0.12],
  [0.1, 0.115, 0.106, -0.125],
  [-0.2, 0.104, 0.1, -0.11],
  [-0.45, 0.076, 0.086, -0.076],
  [-0.6, 0.05, 0.07, -0.046],
  [-0.7, 0.03, 0.058, -0.022],
];

/** How many facets each fuselage section is drawn with. */
const SKYEYE_BODY_SEGMENTS = 10;

/** One point on a fuselage station: an ellipse squared off a little. */
function skyeyeBodyPoint(
  station: readonly [number, number, number, number],
  angle: number,
): Point {
  const [x, halfWidth, top, bottom] = station;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // A superellipse rather than a circle, which is what a moulded pod is: flat
  // sides and a flat top decking with the corners rounded off.
  const shape = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 0.78);
  const height = s >= 0 ? top : -bottom;
  return [x, shape(c) * halfWidth, shape(s) * height];
}

function buildSkyeyeBody(body: PartBuilder): void {
  const segments = SKYEYE_BODY_SEGMENTS;
  for (let i = 0; i + 1 < SKYEYE_BODY.length; i += 1) {
    const front = SKYEYE_BODY[i]!;
    const back = SKYEYE_BODY[i + 1]!;
    for (let j = 0; j < segments; j += 1) {
      const a0 = (j / segments) * Math.PI * 2;
      const a1 = ((j + 1) / segments) * Math.PI * 2;
      body.quad(
        skyeyeBodyPoint(front, a0),
        skyeyeBodyPoint(back, a0),
        skyeyeBodyPoint(back, a1),
        skyeyeBodyPoint(front, a1),
      );
    }
  }
  // Caps: the nose is closed and the tail cone runs into the engine mount.
  const nose = SKYEYE_BODY[0]!;
  const tail = SKYEYE_BODY[SKYEYE_BODY.length - 1]!;
  for (let j = 0; j < segments; j += 1) {
    const a0 = (j / segments) * Math.PI * 2;
    const a1 = ((j + 1) / segments) * Math.PI * 2;
    body.triangle(
      [nose[0] + 0.03, 0, 0],
      skyeyeBodyPoint(nose, a1),
      skyeyeBodyPoint(nose, a0),
    );
    body.triangle(
      [tail[0], 0, SKYEYE_PROP_AXIS_Z],
      skyeyeBodyPoint(tail, a0),
      skyeyeBodyPoint(tail, a1),
    );
  }
}

/** The payload hatch let into the bottom of the nose, where the camera lives. */
function buildSkyeyeHatch(hatch: PartBuilder, lens: PartBuilder): void {
  const outline: Point[] = [
    [0.78, 0.048, -0.09],
    [0.78, -0.048, -0.09],
    [0.5, -0.072, -0.128],
    [0.5, 0.072, -0.128],
  ];
  hatch.plate(outline, 0.012, 2);

  // The camera looking out of the front of the nose, which on a survey
  // aeroplane is where the FPV feed comes from rather than a pod on top.
  const glass: Point[] = [
    [0.912, -0.03, -0.006],
    [0.918, -0.03, 0.042],
    [0.918, 0.03, 0.042],
    [0.912, 0.03, -0.006],
  ];
  lens.plate(glass, 0.008, 0);
}

/** The two tailbooms, under the wing and out to the tail. */
function buildSkyeyeBooms(booms: PartBuilder): void {
  const segments = 10;
  for (const sign of [1, -1] as const) {
    const y = SKYEYE_BOOM_Y * sign;
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const ring = (x: number, angle: number): Point => [
        x,
        y + Math.cos(angle) * SKYEYE_BOOM_RADIUS,
        SKYEYE_BOOM_Z + Math.sin(angle) * SKYEYE_BOOM_RADIUS,
      ];
      const p0 = ring(SKYEYE_BOOM_FRONT, a0);
      const p1 = ring(SKYEYE_BOOM_FRONT, a1);
      const q0 = ring(SKYEYE_BOOM_BACK, a0);
      const q1 = ring(SKYEYE_BOOM_BACK, a1);
      booms.quad(p0, q0, q1, p1);
      booms.triangle([SKYEYE_BOOM_FRONT, y, SKYEYE_BOOM_Z], p0, p1);
      booms.triangle([SKYEYE_BOOM_BACK, y, SKYEYE_BOOM_Z], q1, q0);
    }
  }
}

/**
 * The tail: a fin on the end of each boom and the tailplane bridging them.
 *
 * Only the part of the tailplane ahead of the hinge is here. What is behind it
 * is the elevator, and that is built in its own hinge-relative frame so the
 * renderer can deflect it with a single rotation.
 */
function buildSkyeyeTail(tail: PartBuilder): void {
  for (const sign of [1, -1] as const) {
    const y = SKYEYE_BOOM_Y * sign;
    const fin: Point[] = [
      [-1.14, y, SKYEYE_BOOM_Z],
      [-1.3, y, SKYEYE_TAIL_Z + 0.03],
      [-1.46, y, SKYEYE_TAIL_Z + 0.03],
      [-1.46, y, SKYEYE_BOOM_Z],
    ];
    if (sign < 0) fin.reverse();
    tail.plate(fin, 0.016, 1);
  }

  const z = SKYEYE_TAIL_Z;
  const span = SKYEYE_TAIL_HALF_SPAN;
  const stabiliser: Point[] = [
    [SKYEYE_TAIL_LEAD, span, z],
    [SKYEYE_ELEVATOR_HINGE_X, span, z],
    [SKYEYE_ELEVATOR_HINGE_X, -span, z],
    [SKYEYE_TAIL_LEAD, -span, z],
  ];
  tail.plate(stabiliser, 0.016, 2);
}

/** One half of the elevator, in a frame whose origin sits on its hinge. */
function buildSkyeyeElevator(part: PartBuilder, sign: number): void {
  const inner = SKYEYE_TAIL_ROOT_GAP * sign;
  const outer = SKYEYE_TAIL_HALF_SPAN * sign;
  const back = SKYEYE_TAIL_TRAIL - SKYEYE_ELEVATOR_HINGE_X;
  const outline: Point[] = [
    [0, inner, 0],
    [0, outer, 0],
    [back, outer, 0],
    [back, inner, 0],
  ];
  if (sign < 0) outline.reverse();
  part.plate(outline, 0.014, 2);
}

/** One wheel: a disc turning about the body's left axis. */
function buildSkyeyeWheel(
  part: PartBuilder,
  x: number,
  y: number,
  z: number,
  radius: number,
  width: number,
): void {
  const segments = 12;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const rim = (angle: number, side: number): Point => [
      x + Math.cos(angle) * radius,
      y + side * (width / 2),
      z + Math.sin(angle) * radius,
    ];
    part.quad(rim(a0, 1), rim(a1, 1), rim(a1, -1), rim(a0, -1));
    part.triangle([x, y + width / 2, z], rim(a1, 1), rim(a0, 1));
    part.triangle([x, y - width / 2, z], rim(a0, -1), rim(a1, -1));
  }
}

/**
 * The undercarriage: a steerable nose leg and two mains on a bowed spring.
 *
 * The mains sit a little behind the centre of gravity and the nose leg well
 * ahead of it, which is what stops the aeroplane sitting back on its tail and
 * what lets the elevator lift the nose off first.
 */
function buildSkyeyeGear(legs: PartBuilder, tyres: PartBuilder): void {
  const noseWheelZ = SKYEYE_GROUND_Z + SKYEYE_NOSE_WHEEL_RADIUS;
  legs.box(
    [SKYEYE_NOSE_WHEEL_X - 0.016, -0.014, noseWheelZ],
    [SKYEYE_NOSE_WHEEL_X + 0.016, 0.014, -0.09],
  );
  buildSkyeyeWheel(
    tyres,
    SKYEYE_NOSE_WHEEL_X,
    0,
    noseWheelZ,
    SKYEYE_NOSE_WHEEL_RADIUS,
    0.036,
  );

  const mainWheelZ = SKYEYE_GROUND_Z + SKYEYE_MAIN_WHEEL_RADIUS;
  for (const sign of [1, -1] as const) {
    // A single bowed leg a side, as a composite spring undercarriage is: it
    // leaves the fuselage narrow and high and reaches the ground wide and low.
    const leg: Point[] = [
      [SKYEYE_MAIN_WHEEL_X - 0.03, 0.05 * sign, -0.1],
      [SKYEYE_MAIN_WHEEL_X + 0.03, 0.05 * sign, -0.1],
      [SKYEYE_MAIN_WHEEL_X + 0.026, SKYEYE_MAIN_WHEEL_Y * sign, mainWheelZ],
      [SKYEYE_MAIN_WHEEL_X - 0.026, SKYEYE_MAIN_WHEEL_Y * sign, mainWheelZ],
    ];
    if (sign < 0) leg.reverse();
    legs.plate(leg, 0.014, 2);
    buildSkyeyeWheel(
      tyres,
      SKYEYE_MAIN_WHEEL_X,
      SKYEYE_MAIN_WHEEL_Y * sign,
      mainWheelZ,
      SKYEYE_MAIN_WHEEL_RADIUS,
      0.042,
    );
  }
}

/** The engine, sitting in the back of the fuselage ahead of the propeller. */
function buildSkyeyeEngine(engine: PartBuilder): void {
  const segments = 10;
  const front = -0.62;
  const back = -0.72;
  const radius = 0.05;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const ring = (x: number, angle: number): Point => [
      x,
      Math.cos(angle) * radius,
      SKYEYE_PROP_AXIS_Z + Math.sin(angle) * radius,
    ];
    engine.quad(ring(front, a0), ring(back, a0), ring(back, a1), ring(front, a1));
    engine.triangle([back, 0, SKYEYE_PROP_AXIS_Z], ring(back, a1), ring(back, a0));
  }
  // Two cylinder heads out of the sides of it, which is what a petrol twin
  // looks like and the one part of this aeroplane that is unmistakably an
  // engine rather than a motor.
  for (const sign of [1, -1] as const) {
    engine.box(
      [-0.7, 0.05 * sign, SKYEYE_PROP_AXIS_Z - 0.03],
      [-0.63, 0.115 * sign, SKYEYE_PROP_AXIS_Z + 0.04],
    );
  }
}

/** The propeller, in its own frame with the hub at zero. */
function buildSkyeyePropeller(prop: PartBuilder): void {
  const radius = SKYEYE_PROP_RADIUS;
  // Two long, narrow wooden blades: a 22-inch propeller on a petrol engine is
  // a slower, thinner thing than anything electric here turns, and at seven
  // thousand rpm it is the loudest.
  const blade = (direction: 1 | -1): Point[] => {
    const points: Point[] = [
      [0, 0.022, 0.03 * direction],
      [0, 0.032, 0.11 * direction],
      [0, 0.019, radius * direction],
      [0, -0.014, radius * 0.92 * direction],
      [0, -0.026, 0.1 * direction],
      [0, -0.018, 0.028 * direction],
    ];
    return direction === 1 ? points : points.slice().reverse();
  };
  prop.plate(blade(1), 0.012, 0);
  prop.plate(blade(-1), 0.012, 0);

  const segments = 10;
  const hubRadius = 0.03;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    prop.triangle(
      [-0.05, 0, 0],
      [0, Math.cos(a0) * hubRadius, Math.sin(a0) * hubRadius],
      [0, Math.cos(a1) * hubRadius, Math.sin(a1) * hubRadius],
    );
  }
}

let cachedSkyeye: AircraftMesh | null = null;

/** Builds (once) and returns the Skyeye mesh. */
export function buildSkyeyeMesh(): AircraftMesh {
  if (cachedSkyeye) return cachedSkyeye;

  const top = new PartBuilder("skyeye-top", SKYEYE_SHELL_TOP, PAINT.Shell);
  const bottom = new PartBuilder(
    "skyeye-bottom",
    SKYEYE_SHELL_BOTTOM,
    PAINT.Shell,
    SKYEYE_BOTTOM_SHADE,
  );
  const body = new PartBuilder("skyeye-body", SKYEYE_POD, PAINT.Shell, SKYEYE_POD_SHADE);
  const hatch = new PartBuilder(
    "skyeye-hatch",
    SKYEYE_SHELL_BOTTOM,
    PAINT.Shell,
    SKYEYE_BOTTOM_SHADE,
  );
  const booms = new PartBuilder("skyeye-booms", SKYEYE_POD, PAINT.Shell, SKYEYE_POD_SHADE);
  const tail = new PartBuilder(
    "skyeye-tail",
    SKYEYE_SHELL_TOP,
    PAINT.Shell,
    SKYEYE_TAIL_SHADE,
  );
  const accent = new PartBuilder("skyeye-accent", SKYEYE_ACCENT, PAINT.Accent);
  const legs = new PartBuilder("skyeye-gear", MOTOR);
  const tyres = new PartBuilder("skyeye-tyres", SKYEYE_TYRE);
  const engine = new PartBuilder("skyeye-engine", MOTOR);
  const lens = new PartBuilder("skyeye-lens", LENS);
  const propeller = new PartBuilder("skyeye-propeller", MOTOR);
  const aileronLeft = new PartBuilder(
    "skyeye-aileron-left",
    SKYEYE_SHELL_TOP,
    PAINT.Shell,
  );
  const aileronRight = new PartBuilder(
    "skyeye-aileron-right",
    SKYEYE_SHELL_TOP,
    PAINT.Shell,
  );
  const aileronUnderLeft = new PartBuilder(
    "skyeye-aileron-left-bottom",
    SKYEYE_SHELL_BOTTOM,
    PAINT.Shell,
    SKYEYE_BOTTOM_SHADE,
  );
  const aileronUnderRight = new PartBuilder(
    "skyeye-aileron-right-bottom",
    SKYEYE_SHELL_BOTTOM,
    PAINT.Shell,
    SKYEYE_BOTTOM_SHADE,
  );
  const elevatorLeft = new PartBuilder(
    "skyeye-elevator-left",
    SKYEYE_SHELL_TOP,
    PAINT.Shell,
    SKYEYE_TAIL_SHADE,
  );
  const elevatorRight = new PartBuilder(
    "skyeye-elevator-right",
    SKYEYE_SHELL_TOP,
    PAINT.Shell,
    SKYEYE_TAIL_SHADE,
  );

  buildWing(SKYEYE_PLANFORM, top, bottom);
  buildElevon(SKYEYE_PLANFORM, aileronLeft, 1, aileronUnderLeft);
  buildElevon(SKYEYE_PLANFORM, aileronRight, -1, aileronUnderRight);
  buildAccentStripes(SKYEYE_PLANFORM, accent, SKYEYE_ACCENT_BANDS);
  buildSkyeyeBody(body);
  buildSkyeyeHatch(hatch, lens);
  buildSkyeyeBooms(booms);
  buildSkyeyeTail(tail);
  buildSkyeyeElevator(elevatorLeft, 1);
  buildSkyeyeElevator(elevatorRight, -1);
  buildSkyeyeGear(legs, tyres);
  buildSkyeyeEngine(engine);
  buildSkyeyePropeller(propeller);

  // The ailerons are drawn where they sit and stay there: the hinge line is in
  // the wing, and the surface that moves is the elevator on the tail.
  const ailerons = [
    aileronLeft.build(),
    aileronUnderLeft.build(),
    aileronRight.build(),
    aileronUnderRight.build(),
  ]
    .filter((part): part is MeshPart => part !== null)
    .map((part) => translated(part, SKYEYE_HINGE_X, 0, SKYEYE_HINGE_Z));
  const parts = [
    ...[top, bottom, body, hatch, booms, tail, accent, legs, tyres, engine, lens]
      .map((builder) => builder.build())
      .filter((part): part is MeshPart => part !== null),
    ...ailerons,
  ];

  const propellerParts = [propeller.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const propellers: PropellerGroup[] = [
    {
      name: "skyeye-propeller",
      origin: [SKYEYE_PROP_X, 0, SKYEYE_PROP_AXIS_Z],
      axis: "x",
      direction: 1,
      parts: propellerParts,
    },
  ];

  const leftParts = [elevatorLeft.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const rightParts = [elevatorRight.build()].filter(
    (part): part is MeshPart => part !== null,
  );
  const staticParts = [
    ...parts,
    ...[...leftParts, ...rightParts].map((part) =>
      translated(part, SKYEYE_ELEVATOR_HINGE_X, 0, SKYEYE_TAIL_Z),
    ),
  ];

  const triangleCount =
    [...parts, ...propellerParts, ...leftParts, ...rightParts].reduce(
      (sum, part) => sum + part.indices.length,
      0,
    ) / 3;

  cachedSkyeye = {
    kind: MESH_KIND.Skyeye,
    referenceSpan: MESH_SKYEYE_SPAN,
    parts,
    propellers,
    elevonParts: { left: leftParts, right: rightParts },
    elevonOrigin: [SKYEYE_ELEVATOR_HINGE_X, 0, SKYEYE_TAIL_Z],
    staticParts,
    // Out of the nose, barely tilted: the camera on one of these is the
    // payload's, and it is looking where the aeroplane is going.
    fpvCamera: { offset: [0.93, 0, 0.018], tiltDegrees: 4 },
    triangleCount,
  };
  return cachedSkyeye;
}

/** The geometry for one kind of airframe. */
export function meshOfKind(kind: MeshKind): AircraftMesh {
  if (kind === MESH_KIND.Quad) return buildQuadMesh();
  if (kind === MESH_KIND.Glider) return buildGliderMesh();
  if (kind === MESH_KIND.X8) return buildX8Mesh();
  if (kind === MESH_KIND.Rocket) return buildRocketMesh();
  if (kind === MESH_KIND.Skyeye) return buildSkyeyeMesh();
  return buildAircraftMesh();
}

/**
 * Which geometry an airframe is drawn from.
 *
 * The airframe says it itself: a rotor block makes it a multirotor, and an
 * airframe that is a different shape of one — a wing or a rotorcraft alike —
 * says which one it is. So an airframe added to the hangar is drawn as the kind
 * of aircraft it is without anything having to be listed here as well.
 *
 * The shape is asked first for exactly one reason: a rocket has a rotor block
 * too, and a rotor block only says how an aircraft flies.
 */
export function meshKindFor(config: AircraftConfig): MeshKind {
  if (config.shape === "rocket") return MESH_KIND.Rocket;
  if (config.rotor) return MESH_KIND.Quad;
  if (config.shape === "glider") return MESH_KIND.Glider;
  if (config.shape === "skyeye") return MESH_KIND.Skyeye;
  return config.shape === "x8" ? MESH_KIND.X8 : MESH_KIND.Wing;
}

/** The geometry an airframe is drawn from. */
export function meshFor(config: AircraftConfig): AircraftMesh {
  return meshOfKind(meshKindFor(config));
}
