/**
 * The shape of a race gate.
 *
 * A gate is a marker, not a structure. Nothing is holding it up and nothing
 * would be flying into it if it were real: it exists to say "the hole is
 * here, it is this big, and it is this way round" to a pilot closing on it at
 * forty metres a second with a hundred lines of terrain behind it. So the
 * shape is chosen for how it reads at range rather than for what a welder
 * could build — a thick rounded-square frame in one bright colour, a pale
 * liner standing proud around the opening, and a dark edge round the outside
 * so the whole thing keeps its outline against sky, snow or a sunlit ridge.
 *
 * Drawn from the gates in the FPV racing simulators pilots actually fly, and
 * deliberately not a copy of any one of them: the proportions here are set by
 * this simulator's own gates, which are tens of metres across because they are
 * flown by fixed wings rather than by quads; the colours are the ones the rest
 * of the game already uses for the gate being flown at and for the finish; and
 * there is no lettering anywhere on the frame, so nothing has to be legible
 * for the gate to be readable.
 *
 * Framework-agnostic, like the aircraft mesh: what comes out is a list of
 * boxes in the gate's own axes — x through the opening, y across it, z up —
 * which a renderer places with the gate's model matrix and colours by whatever
 * the race says the gate is doing. Nothing here imports Cesium, so the
 * geometry is arithmetic covered by `test:sim` rather than something only
 * judgeable by squinting at a screen.
 */

import { clamp } from "../math/scalar";

/** Which part of the frame a box belongs to, and so what colour it takes. */
export const GATE_TONE = {
  /** The wide band, which carries the colour the race gives the gate. */
  Band: "BAND",
  /** The pale liner around the opening, on both faces. */
  Liner: "LINER",
  /** The dark edge around the outside of the frame. */
  Trim: "TRIM",
} as const;

export type GateTone = (typeof GATE_TONE)[keyof typeof GATE_TONE];

/** One box of the frame, in the gate's own axes. */
export interface GateSlab {
  readonly tone: GateTone;
  /** Centre of the box: x through the gate, y across it, z up. Metres. */
  readonly offset: readonly [number, number, number];
  /**
   * Extents of the box before it is rolled: through the gate, across the
   * frame, and along the run of it. Metres.
   */
  readonly size: readonly [number, number, number];
  /**
   * Roll about the through-axis that lays the box onto the frame, radians.
   *
   * Zero lays the box against one side of the opening with its width pointing
   * outwards; every other piece of the frame, corners included, is that same
   * box turned round the opening.
   */
  readonly roll: number;
}

/** What a gate leaves open, in metres from the centre of the opening. */
export interface GateOpening {
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * Thickness of the frame across itself, as a fraction of the opening's
 * half-width.
 *
 * Proportional rather than fixed: a gate is a thing seen from half a kilometre
 * away at a hundred kilometres an hour, and a frame a metre and a half thick
 * is a hairline at that range — the first version of this was invisible
 * against anything but open sky. Scaling it with the opening keeps a wide gate
 * looking like a gate and a tight one looking tight.
 */
const FRAME_FRACTION = 0.12;
/** Floor and ceiling on that, metres. */
const MIN_FRAME = 3;
const MAX_FRAME = 6;
/**
 * How deep the frame is through the gate, in frame thicknesses.
 *
 * A slab rather than a sheet: the inside of the frame is a short tunnel, and
 * seeing down it is most of what tells a pilot at an angle how square they are
 * onto the opening.
 */
const DEPTH_FRACTION = 0.8;
/** Share of the thickness given to the dark edge round the outside. */
const TRIM_SHARE = 0.15;
/**
 * How deep that edge is, in band depths.
 *
 * A little more than the band it wraps, so it stands proud of both faces and
 * the outline survives being looked at from an angle rather than only head-on.
 */
const TRIM_DEPTH = 1.1;
/** Share of what is left given to the liner round the opening. */
const LINER_SHARE = 0.36;
/** How thick that liner is, in band depths. */
const LINER_DEPTH = 0.16;
/**
 * Corner radius, as a fraction of the opening's smaller half-extent.
 *
 * The corners are the whole reason this reads as a gate rather than as a
 * bright rectangle: a rounded frame has an unmistakable inside, and the eye
 * finds the middle of it without having to trace four bars. The rounding eats
 * a sliver of each corner of the opening, which costs nothing — the frame is
 * scenery, and the crossing test the race is scored on is the rectangle.
 */
const CORNER_FRACTION = 0.3;
/**
 * How many boxes each quarter turn is cut into.
 *
 * Four is where the rounding stops reading as a chamfer at the range a gate is
 * actually flown at, and it keeps the longest course the mode allows inside
 * two thousand boxes. That is one draw either way — but the geometry is
 * combined on the main thread while the pilot is waiting on the grid, so the
 * corner is bought rather than free.
 */
const CORNER_CHORDS = 4;
/**
 * How far consecutive boxes run past each other, in frame thicknesses.
 *
 * The frame is one outline drawn at several distances from the opening, and
 * the further out a layer sits the wider the wedge of nothing left at each
 * joint. Lapping the boxes fills those wedges from the inside, at the price of
 * a small ear of each box sticking out past the turn. Half a thickness covers
 * the widest wedge the corners open; much more than that and the ears grow far
 * enough to show daylight around themselves, which is the artefact this is
 * here to remove.
 */
const LAP = 0.5;

/** Thickness of the frame across itself, metres. */
export function gateFrameThickness(halfWidth: number): number {
  return clamp(halfWidth * FRAME_FRACTION, MIN_FRAME, MAX_FRAME);
}

/** Depth of the frame through the gate, metres. */
export function gateFrameDepth(halfWidth: number): number {
  return gateFrameThickness(halfWidth) * DEPTH_FRACTION;
}

/** Radius the corners of the opening are rounded off with, metres. */
export function gateCornerRadius(opening: GateOpening): number {
  return Math.min(opening.halfWidth, opening.halfHeight) * CORNER_FRACTION;
}

/** One straight run of the outline: where it is, and which way is out. */
interface Run {
  readonly y: number;
  readonly z: number;
  /** Outward normal in the plane of the gate. Unit length. */
  readonly ny: number;
  readonly nz: number;
  readonly length: number;
}

/**
 * The edge of the opening, as a closed loop of straight runs.
 *
 * Everything the frame is made of hangs off this one loop: a layer is the loop
 * pushed outwards by however far that layer sits from the opening. That is
 * what keeps the liner, the band and the trim exactly concentric — they are
 * the same polygon, not three separate approximations of the same curve that
 * would leave slivers between them at the corners.
 */
function outline(opening: GateOpening, radius: number): readonly Run[] {
  const hw = opening.halfWidth;
  const hh = opening.halfHeight;
  const runs: Run[] = [
    { y: hw, z: 0, ny: 1, nz: 0, length: 2 * (hh - radius) },
    { y: -hw, z: 0, ny: -1, nz: 0, length: 2 * (hh - radius) },
    { y: 0, z: hh, ny: 0, nz: 1, length: 2 * (hw - radius) },
    { y: 0, z: -hh, ny: 0, nz: -1, length: 2 * (hw - radius) },
  ];

  const step = Math.PI / 2 / CORNER_CHORDS;
  // Chord of the arc, and how far its middle sits in from the arc itself.
  const chord = 2 * radius * Math.sin(step / 2);
  const inset = radius * Math.cos(step / 2);
  for (const sy of [1, -1]) {
    for (const sz of [1, -1]) {
      const cy = sy * (hw - radius);
      const cz = sz * (hh - radius);
      for (let i = 0; i < CORNER_CHORDS; i += 1) {
        const angle = (i + 0.5) * step;
        const ny = sy * Math.cos(angle);
        const nz = sz * Math.sin(angle);
        runs.push({
          y: cy + inset * ny,
          z: cz + inset * nz,
          ny,
          nz,
          length: chord,
        });
      }
    }
  }
  return runs;
}

/** One layer of the frame's cross-section, measured out from the opening. */
interface Layer {
  readonly tone: GateTone;
  /** Distance from the edge of the opening to the middle of the layer. */
  readonly radius: number;
  /** How much of the frame's thickness the layer takes. */
  readonly width: number;
  /** How deep it is through the gate. */
  readonly depth: number;
  /** Where it sits along the through-axis. */
  readonly x: number;
}

/**
 * The frame's cross-section: what a saw cut through one side would show.
 *
 * A band across nearly the whole thickness, a dark edge taking the outside of
 * it, and the liner as two thin plates standing proud of the faces rather than
 * as a ring of its own — so the tunnel through the gate stays the band's
 * colour, which is what the frame is recognised by from an angle.
 */
function profile(halfWidth: number): readonly Layer[] {
  const thickness = gateFrameThickness(halfWidth);
  const depth = gateFrameDepth(halfWidth);
  const trim = thickness * TRIM_SHARE;
  const band = thickness - trim;
  const liner = band * LINER_SHARE;
  const linerDepth = depth * LINER_DEPTH;
  const stand = (depth + linerDepth) / 2;
  return [
    { tone: GATE_TONE.Band, radius: band / 2, width: band, depth, x: 0 },
    {
      tone: GATE_TONE.Trim,
      radius: band + trim / 2,
      width: trim,
      depth: depth * TRIM_DEPTH,
      x: 0,
    },
    {
      tone: GATE_TONE.Liner,
      radius: liner / 2,
      width: liner,
      depth: linerDepth,
      x: stand,
    },
    {
      tone: GATE_TONE.Liner,
      radius: liner / 2,
      width: liner,
      depth: linerDepth,
      x: -stand,
    },
  ];
}

/**
 * One gate's frame, as boxes.
 *
 * Outside the opening everywhere the rounding does not reach: what the race
 * scores is the rectangle `halfWidth` by `halfHeight`, and the frame stands
 * clear of all of it but the four corners it rounds off, so the hole a pilot
 * aims at is the hole the clock agrees they flew through.
 */
export function buildGateFrame(opening: GateOpening): readonly GateSlab[] {
  const radius = gateCornerRadius(opening);
  const layers = profile(opening.halfWidth);
  const lap = gateFrameThickness(opening.halfWidth) * LAP;
  const slabs: GateSlab[] = [];

  for (const run of outline(opening, radius)) {
    const roll = Math.atan2(run.nz, run.ny);
    for (const layer of layers) {
      slabs.push({
        tone: layer.tone,
        offset: [
          layer.x,
          run.y + run.ny * layer.radius,
          run.z + run.nz * layer.radius,
        ],
        size: [layer.depth, layer.width, run.length + lap],
        roll,
      });
    }
  }
  return slabs;
}
