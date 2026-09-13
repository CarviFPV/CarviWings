/**
 * The aircraft as a picture, drawn without a 3D context.
 *
 * A pilot choosing an aircraft before a flight, or painting one on the bench,
 * wants to see the thing itself rather than read a line about it. The mesh is
 * already here and it is already plain typed arrays, so the picture is that
 * mesh projected onto a plane: a few hundred triangles, flat-shaded, and
 * rasterised into a buffer of pixels a canvas takes straight back.
 *
 * Deliberately not a Cesium scene, and not WebGL. A menu that spun up a second
 * renderer to show a wing would cost more to open than the flight it is
 * choosing an aircraft for, would need a context it might not get, and could
 * not be tested outside a browser. This way the projection is ordinary
 * arithmetic covered by `test:sim`.
 *
 * What is in front is decided per pixel rather than per triangle. Sorting the
 * triangles is nearly right and wrong exactly where it shows: the wing is
 * built from long chordwise panels and the pod hangs a couple of centimetres
 * under them, so a panel whose middle is further away than the pod lets the
 * pod through the top of the wing. A depth buffer over a few hundred triangles
 * is a few milliseconds and simply cannot do that.
 *
 * Screen space is the caller's: X to the right, Y *down*, which is what a
 * canvas wants and saves every consumer flipping it.
 */

import type { Livery } from "../flight/livery";
import { DEFAULT_LIVERY } from "../flight/livery";
import type { AircraftMesh, MeshKind, MeshPart } from "./aircraftMesh";
import { MESH_KIND, meshOfKind, partColor } from "./aircraftMesh";

/** One flat-shaded triangle, projected into the frame. */
export interface PreviewTriangle {
  /** Screen coordinates: x0, y0, x1, y1, x2, y2. */
  readonly points: readonly [number, number, number, number, number, number];
  /** Shaded colour, 0..1 per channel. */
  readonly color: readonly [number, number, number];
  /** Each vertex's distance towards the camera; larger is nearer. */
  readonly depths: readonly [number, number, number];
  /** The middle of it, which the list is sorted on. */
  readonly depth: number;
}

/** The finished picture, as the pixels a canvas takes straight back. */
export interface PreviewImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, row by row. Everything the aircraft does not cover is transparent. */
  readonly pixels: Uint8ClampedArray;
}

export interface PreviewView {
  /** Where the camera stands around the aircraft, degrees. */
  readonly azimuthDeg: number;
  /** How far above it, degrees. Positive looks down on the wing. */
  readonly elevationDeg: number;
  readonly width: number;
  readonly height: number;
  /** Fraction of the frame left empty around the aircraft, 0..0.5. */
  readonly padding?: number;
  readonly livery?: Livery;
  /** Drawn with its propellers on, as it would be sitting on a bench. */
  readonly showPropeller?: boolean;
  /** Which airframe to draw. The wing, unless it says otherwise. */
  readonly kind?: MeshKind;
}

/** The three-quarter view an airframe is photographed from. */
export const DEFAULT_PREVIEW_AZIMUTH = 34;
export const DEFAULT_PREVIEW_ELEVATION = 22;

/** Fraction of a surface's colour that reaches it with the light behind it. */
const AMBIENT = 0.42;
const DIFFUSE = 0.72;

type Vec = readonly [number, number, number];

function normalise(v: Vec): Vec {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec, b: Vec): Vec {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The camera basis for a view.
 *
 * `towards` points from the aircraft at the camera, so a face is turned away
 * when its normal has a negative component along it, and a vertex is nearer
 * the camera the larger its component is.
 */
function basis(view: PreviewView): {
  right: Vec;
  up: Vec;
  towards: Vec;
} {
  const azimuth = (view.azimuthDeg * Math.PI) / 180;
  // Clamped short of straight down: a camera on the axis has no horizon to
  // work its "right" out from, and the picture would flip as it crossed.
  const elevation =
    (Math.max(-85, Math.min(85, view.elevationDeg)) * Math.PI) / 180;
  const towards: Vec = [
    Math.cos(elevation) * Math.cos(azimuth),
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
  ];
  const right = normalise(cross([0, 0, 1], towards));
  const up = cross(towards, right);
  return { right, up, towards };
}

/** Every part the picture is made of, in the frame they are drawn in. */
function previewParts(
  mesh: AircraftMesh,
  showPropeller: boolean,
): { part: MeshPart; offset: Vec }[] {
  const parts = mesh.staticParts.map((part) => ({
    part,
    offset: [0, 0, 0] as Vec,
  }));
  if (showPropeller) {
    for (const group of mesh.propellers) {
      for (const part of group.parts) {
        parts.push({ part, offset: group.origin as Vec });
      }
    }
  }
  return parts;
}

/**
 * The aircraft projected into a frame, back to front.
 *
 * Orthographic rather than perspective: this is a picture of an aircraft on a
 * bench, and a wide-angle lens on a two-metre wing at arm's length bends it in
 * a way that makes a delta look like a different planform.
 */
export function previewTriangles(view: PreviewView): PreviewTriangle[] {
  const mesh = meshOfKind(view.kind ?? MESH_KIND.Wing);
  const livery = view.livery ?? DEFAULT_LIVERY;
  const { right, up, towards } = basis(view);
  const parts = previewParts(mesh, view.showPropeller ?? true);

  // The light sits over the camera's left shoulder, which is where a hangar
  // photograph puts it: the top of the wing is lit, the underside is not, and
  // the two are told apart without an outline being drawn round anything.
  const light = normalise([
    right[0] * -0.45 + up[0] * 0.72 + towards[0] * 0.52,
    right[1] * -0.45 + up[1] * 0.72 + towards[1] * 0.52,
    right[2] * -0.45 + up[2] * 0.72 + towards[2] * 0.52,
  ]);

  // Two passes: the extent of the projected airframe decides the scale, and
  // the scale cannot be known until every vertex has been projected once.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const projected: Float64Array[] = [];
  for (const { part, offset } of parts) {
    const count = part.positions.length / 3;
    const flat = new Float64Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const p: Vec = [
        (part.positions[i * 3] ?? 0) + offset[0],
        (part.positions[i * 3 + 1] ?? 0) + offset[1],
        (part.positions[i * 3 + 2] ?? 0) + offset[2],
      ];
      const x = dot(p, right);
      const y = dot(p, up);
      const z = dot(p, towards);
      flat[i * 3] = x;
      flat[i * 3 + 1] = y;
      flat[i * 3 + 2] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    projected.push(flat);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return [];

  const padding = Math.max(0, Math.min(0.45, view.padding ?? 0.08));
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(
    (view.width * (1 - padding * 2)) / spanX,
    (view.height * (1 - padding * 2)) / spanY,
  );
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const toScreenX = (x: number): number =>
    view.width / 2 + (x - centreX) * scale;
  // Screen Y runs down the frame while the view's does not, so it is flipped
  // here rather than by everybody drawing one of these.
  const toScreenY = (y: number): number =>
    view.height / 2 - (y - centreY) * scale;

  const triangles: PreviewTriangle[] = [];
  for (let p = 0; p < parts.length; p += 1) {
    const entry = parts[p];
    const flat = projected[p];
    if (!entry || !flat) continue;
    const { part } = entry;
    const base = partColor(part, livery);
    for (let i = 0; i < part.indices.length; i += 3) {
      const a = part.indices[i] ?? 0;
      const b = part.indices[i + 1] ?? 0;
      const c = part.indices[i + 2] ?? 0;
      // The mesh is flat-shaded, so all three vertices of a face carry the
      // same normal and the first of them is the face.
      const n: Vec = [
        part.normals[a * 3] ?? 0,
        part.normals[a * 3 + 1] ?? 0,
        part.normals[a * 3 + 2] ?? 0,
      ];
      const facing = dot(n, towards);
      if (facing <= 0) continue;

      const shade = AMBIENT + DIFFUSE * Math.max(0, dot(n, light));
      triangles.push({
        points: [
          toScreenX(flat[a * 3] ?? 0),
          toScreenY(flat[a * 3 + 1] ?? 0),
          toScreenX(flat[b * 3] ?? 0),
          toScreenY(flat[b * 3 + 1] ?? 0),
          toScreenX(flat[c * 3] ?? 0),
          toScreenY(flat[c * 3 + 1] ?? 0),
        ],
        color: [
          Math.min(1, base[0] * shade),
          Math.min(1, base[1] * shade),
          Math.min(1, base[2] * shade),
        ],
        depths: [
          flat[a * 3 + 2] ?? 0,
          flat[b * 3 + 2] ?? 0,
          flat[c * 3 + 2] ?? 0,
        ],
        depth:
          ((flat[a * 3 + 2] ?? 0) +
            (flat[b * 3 + 2] ?? 0) +
            (flat[c * 3 + 2] ?? 0)) /
          3,
      });
    }
  }

  // Furthest first. The depth buffer is what decides visibility, but a
  // consumer drawing these as plain filled paths still gets a nearly right
  // picture out of them, and the order makes the rasteriser below write over
  // itself less often.
  triangles.sort((first, second) => first.depth - second.depth);
  return triangles;
}

/**
 * The aircraft rasterised into a buffer of pixels.
 *
 * Flat colour and a depth test, which is the whole of it: there is no texture,
 * no transparency and no second light. Draw it at twice the size it is shown
 * at and the downscale is the anti-aliasing.
 */
export function previewImage(view: PreviewView): PreviewImage {
  const width = Math.max(0, Math.floor(view.width));
  const height = Math.max(0, Math.floor(view.height));
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (width === 0 || height === 0) return { width, height, pixels };

  const depths = new Float64Array(width * height).fill(-Infinity);
  for (const triangle of previewTriangles({ ...view, width, height })) {
    const [x0, y0, x1, y1, x2, y2] = triangle.points;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    // A triangle seen exactly edge-on covers nothing and would divide by zero.
    if (Math.abs(area) < 1e-9) continue;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));

    const red = Math.round(triangle.color[0] * 255);
    const green = Math.round(triangle.color[1] * 255);
    const blue = Math.round(triangle.color[2] * 255);
    const [d0, d1, d2] = triangle.depths;

    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        // Barycentric, in units of the whole triangle, so the three weights
        // sum to one and interpolate the depth across it.
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const index = y * width + x;
        const depth = w0 * d0 + w1 * d1 + w2 * d2;
        if (depth <= (depths[index] ?? -Infinity)) continue;
        depths[index] = depth;
        const offset = index * 4;
        pixels[offset] = red;
        pixels[offset + 1] = green;
        pixels[offset + 2] = blue;
        pixels[offset + 3] = 255;
      }
    }
  }

  return { width, height, pixels };
}

/** A shaded colour in the form a canvas takes it. */
export function cssColor(color: readonly [number, number, number]): string {
  const channel = (value: number): number =>
    Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${channel(color[0])},${channel(color[1])},${channel(color[2])})`;
}
