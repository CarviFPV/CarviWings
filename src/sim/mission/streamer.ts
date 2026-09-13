/**
 * Streamer cutting.
 *
 * The other way a fly-in is flown. Everybody tows a couple of dozen metres of
 * crepe paper off the tail in their own colour, and the whole point of the
 * afternoon is to fly through somebody else's and take as much of it away as
 * you can. Whatever is beyond the wing that touched it falls off; whoever has
 * cut the most paper by the end of the slot has won it.
 *
 * The ribbon is not simulated as cloth. It is the tail of the aircraft's own
 * flight path, sampled every couple of metres and truncated to whatever length
 * is left of it — which is what a streamer towed at twenty-five metres a second
 * actually does, and which costs a handful of vectors per aircraft instead of a
 * solver. Cutting is a swept segment (where a wing was, to where it is) against
 * that polyline: hit it and the ribbon is cut where the wing crossed it, so a
 * pass close to the tail takes nearly all of it and one across the tip takes a
 * metre.
 *
 * Everything here is geometry and arithmetic. It reads aircraft state and never
 * writes to it, so the whole event is testable in Node without a renderer.
 */

import type { AircraftState } from "../flight/state";
import { AIRCRAFT_ROLE, isAirworthy } from "../flight/state";
import { forwardAxis } from "../math/quat";
import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec3";
import * as V from "../math/vec3";

/** How much paper everybody starts a wave with, metres. */
export const STREAMER_LENGTH = 25;

/**
 * How far apart the ribbon is sampled, metres.
 *
 * Fine enough that a turn is a curve rather than a corner, coarse enough that
 * a full-length streamer is a dozen-odd points: the whole field is walked
 * against every other aircraft on every frame, and the ribbon is the inner
 * loop of it.
 */
export const STREAMER_NODE_SPACING = 2;

/**
 * The stub that cannot be cut off, metres.
 *
 * The paper is knotted to the tail. Anything closer in than this is not a cut
 * any more, it is a collision — and the collision world is already having that
 * conversation with both airframes.
 */
export const STREAMER_STUB = 2;

/**
 * Least a pass has to take for it to count, metres.
 *
 * A wingtip that grazes the very end of a ribbon has not cut it, and crediting
 * ten centimetres of it would turn the scoreboard into a record of near
 * misses.
 */
export const MIN_STREAMER_CUT = 0.5;

/** How far out an AI pilot will go looking for somebody's ribbon, metres. */
export const STREAMER_HUNT_RANGE = 700;

/**
 * Distance in one step past which an airframe was placed rather than flown,
 * metres.
 *
 * A replacement aircraft appears at the launch point; a reset puts one back
 * where the flight began. Neither of those flew the line between the two, and
 * treating them as a pass would scythe every ribbon along it — and would drag
 * the mover's own paper across the field behind it. Well above anything a
 * frame can cover at any speed this simulator flies, and well below the jump a
 * relaunch makes.
 */
export const STREAMER_TELEPORT = 60;

/** One of the colours the field's paper comes in. */
export interface StreamerColour {
  readonly id: string;
  readonly label: string;
  /** `#rrggbb`, the way a livery stores one. */
  readonly hex: string;
}

/**
 * The paper on the roll.
 *
 * Solid colours, told apart from each other at the far end of the field, and
 * from grass, sky and cloud: a streamer event is scored by watching whose
 * colour came off, and two competitors nobody can tell apart is the one thing
 * that would break it.
 */
export const STREAMER_COLOURS: readonly StreamerColour[] = [
  { id: "red", label: "Red", hex: "#e23a1f" },
  { id: "yellow", label: "Yellow", hex: "#f2c811" },
  { id: "green", label: "Green", hex: "#33b64c" },
  { id: "blue", label: "Blue", hex: "#2470d6" },
  { id: "magenta", label: "Magenta", hex: "#d92f9a" },
  { id: "orange", label: "Orange", hex: "#f07a10" },
  { id: "cyan", label: "Cyan", hex: "#28c3d4" },
  { id: "white", label: "White", hex: "#f0f0ee" },
  { id: "violet", label: "Violet", hex: "#7a45d6" },
  { id: "lime", label: "Lime", hex: "#9bd42a" },
  { id: "pink", label: "Pink", hex: "#f28fb2" },
  { id: "teal", label: "Teal", hex: "#149c86" },
  { id: "gold", label: "Gold", hex: "#c99a24" },
  { id: "sky", label: "Sky", hex: "#6fb7f2" },
  { id: "crimson", label: "Crimson", hex: "#96122f" },
  { id: "sand", label: "Sand", hex: "#d6bb8a" },
];

/** The colour the `index`th competitor tows, wrapping round the roll. */
export function streamerColour(index: number): StreamerColour {
  const wrapped = ((index % STREAMER_COLOURS.length) + STREAMER_COLOURS.length) %
    STREAMER_COLOURS.length;
  return STREAMER_COLOURS[wrapped] as StreamerColour;
}

/**
 * What that competitor is called on the board.
 *
 * The colour, until the roll runs out and a second one of it goes up, and then
 * the colour and a number — which is exactly how a field with two red
 * streamers on it talks about them.
 */
export function streamerLabel(index: number): string {
  const colour = streamerColour(index);
  const cycle = Math.floor(index / STREAMER_COLOURS.length);
  return cycle === 0 ? colour.label : `${colour.label} ${cycle + 1}`;
}

/** How a competitor is entered for the event. */
export interface StreamerEntry {
  /**
   * Who this is, for as long as the day lasts.
   *
   * Not the aircraft: a wave is a fresh set of airframes with fresh ids, and a
   * pilot who has been cutting paper all afternoon does not start again
   * because they went and got another aeroplane out of the car.
   */
  readonly competitorId: string;
  readonly label: string;
  /** `#rrggbb`. The paper, and what the aircraft towing it is painted in. */
  readonly color: string;
  readonly isPlayer: boolean;
}

/** A ribbon in the air, as the renderer and the AI see it. */
export interface Streamer {
  /** The airframe towing it right now. */
  readonly aircraftId: string;
  readonly competitorId: string;
  readonly color: string;
  readonly isPlayer: boolean;
  /**
   * The ribbon, tow point first and tip last, in local ENU metres.
   *
   * Owned by the field and rewritten in place every frame. Read it, draw it,
   * fly at it — do not keep it.
   */
  readonly points: Vec3[];
  /** Metres of paper still on the tail. */
  length: number;
}

/** One piece of paper leaving one tail. */
export interface StreamerCut {
  /** The airframe that flew through it. */
  readonly cutterId: string;
  readonly cutterCompetitor: string;
  readonly cutterLabel: string;
  readonly ownerId: string;
  readonly ownerCompetitor: string;
  readonly ownerLabel: string;
  /** Metres taken off, which is what the cut is worth. */
  readonly length: number;
  /** Where the wing crossed the ribbon, local ENU metres. Owned by the cut. */
  readonly position: Vec3;
  readonly cutterIsPlayer: boolean;
  readonly ownerIsPlayer: boolean;
}

/** One competitor's afternoon. */
export interface StreamerScore {
  readonly competitorId: string;
  readonly label: string;
  readonly color: string;
  readonly isPlayer: boolean;
  /** Metres taken off other people. This is what wins the event. */
  readonly cut: number;
  /** How many separate passes that took. */
  readonly cuts: number;
  /** Metres of their own paper lost to everybody else. */
  readonly lost: number;
  /** Metres still trailing behind them. */
  readonly remaining: number;
  /** False while they are on the ground waiting for the field to clear. */
  readonly flying: boolean;
  /** 1-based place, by metres cut. */
  readonly position: number;
}

/** The board, as the OSD and the debrief read it. */
export interface StreamerStandings {
  /** Best first. */
  readonly standings: readonly StreamerScore[];
  /** The pilot's own line, when they are entered. */
  readonly player: StreamerScore | null;
  /** Paper cut by everybody, metres. */
  readonly cutTotal: number;
  /** Metres the leader is on. */
  readonly best: number;
}

interface ScoreRecord {
  readonly competitorId: string;
  label: string;
  color: string;
  isPlayer: boolean;
  cut: number;
  cuts: number;
  lost: number;
  remaining: number;
  flying: boolean;
}

export interface StreamerFieldOptions {
  /** Metres of paper a fresh ribbon carries. */
  readonly length?: number;
  /** Metres between ribbon nodes. */
  readonly spacing?: number;
}

const _tow = V.vec3();
const _forward = V.vec3();
const _closest = V.vec3();

/**
 * Every ribbon in the air, and what has come off which.
 *
 * Stepped once a frame with the whole aircraft list. It is handed airframes
 * and gives back cuts; who is allowed to launch, when the slot ends and what
 * any of it means is the festival's business, not this one's.
 */
export class StreamerField {
  private readonly fullLength: number;
  private readonly spacing: number;

  /** Ribbons by the airframe towing them. */
  private readonly ribbons = new Map<string, Streamer>();
  /**
   * The same ribbons as a list.
   *
   * Kept beside the map rather than built on demand: every pilot on the field
   * asks for the ribbons several times a second, and a fifty-aircraft fly-in
   * that allocated an array for each of those asks would spend its afternoon
   * in the collector.
   */
  private readonly list: Streamer[] = [];
  /** The board, which outlives the airframes on it. */
  private readonly scores = new Map<string, ScoreRecord>();
  /** Where each airframe was last seen, so a pass is a swept segment. */
  private readonly lastSeen = new Map<string, Vec3>();
  private readonly cuts: StreamerCut[] = [];
  /** This frame's aircraft by id. Reused: a step must not allocate. */
  private readonly byId = new Map<string, AircraftState>();
  /** Entry order, which is the order the board falls back on. */
  private readonly order: string[] = [];
  /**
   * The board, until something moves it.
   *
   * Read every frame by whoever is drawing the OSD and rebuilt only when a cut
   * lands or somebody is entered: sorting fifty competitors sixty times a
   * second to find out that nothing has changed is the sort of thing that
   * makes a crowded field stutter.
   */
  private board: StreamerStandings | null = null;

  constructor(options: StreamerFieldOptions = {}) {
    this.fullLength = Math.max(options.length ?? STREAMER_LENGTH, STREAMER_STUB);
    this.spacing = Math.max(options.spacing ?? STREAMER_NODE_SPACING, 0.25);
  }

  /** The ribbons in the air. Live objects: read them, do not keep them. */
  get streamers(): readonly Streamer[] {
    return this.list;
  }

  /** The ribbon one airframe is towing, if it has one. */
  streamerOf(aircraftId: string): Streamer | null {
    return this.ribbons.get(aircraftId) ?? null;
  }

  /**
   * Puts a full roll on one airframe.
   *
   * Called by whoever put the aircraft in the sky, because that is who knows
   * whose aeroplane it is. Attaching a second time — a fresh airframe for the
   * same pilot after a wave — is a new ribbon on the same scoreline.
   */
  attach(aircraftId: string, entry: StreamerEntry): Streamer {
    // Whatever this airframe was towing is gone first, so a replacement roll
    // on the same id cannot be marked down by the ribbon it replaces.
    this.detach(aircraftId);

    const record = this.record(entry);
    record.remaining = this.fullLength;
    record.flying = true;

    const streamer: Streamer = {
      aircraftId,
      competitorId: entry.competitorId,
      color: entry.color,
      isPlayer: entry.isPlayer,
      points: [],
      length: this.fullLength,
    };
    this.ribbons.set(aircraftId, streamer);
    this.list.push(streamer);
    this.lastSeen.delete(aircraftId);
    this.board = null;
    return streamer;
  }

  /** Takes a ribbon out of play, leaving its owner's score where it is. */
  detach(aircraftId: string): void {
    const streamer = this.ribbons.get(aircraftId);
    if (!streamer) return;
    const record = this.scores.get(streamer.competitorId);
    if (record) record.flying = false;
    this.ribbons.delete(aircraftId);
    const index = this.list.indexOf(streamer);
    if (index >= 0) this.list.splice(index, 1);
    this.lastSeen.delete(aircraftId);
    this.board = null;
  }

  /** Clears the sky of paper. The board is untouched: the day carries on. */
  clear(): void {
    for (const id of [...this.ribbons.keys()]) this.detach(id);
  }

  /**
   * Advances every ribbon and works out what was cut this frame.
   *
   * No timestep: a ribbon is the tail of a flight path rather than a thing
   * with its own dynamics, so what moves it is the aircraft having moved, and
   * a frame that took twice as long simply laid down twice as much paper.
   *
   * The returned array is reused, so consume it before stepping again.
   */
  update(aircraft: readonly AircraftState[]): readonly StreamerCut[] {
    this.cuts.length = 0;

    const byId = this.byId;
    byId.clear();
    for (const state of aircraft) byId.set(state.id, state);

    // A ribbon whose airframe has gone, or stopped being an aircraft, is off
    // the field: it goes down with the wreck and stops being worth anything to
    // anybody. Walked backwards so that dropping one does not skip the next.
    for (let i = this.list.length - 1; i >= 0; i -= 1) {
      const streamer = this.list[i] as Streamer;
      const owner = byId.get(streamer.aircraftId);
      if (!owner || !isAirworthy(owner.status)) {
        this.detach(streamer.aircraftId);
        continue;
      }
      this.advance(streamer, owner);
    }

    this.cutPass(aircraft, byId);

    // Only now: every pass this frame is measured from where the airframes
    // were at the start of it, so two aircraft crossing are not each judged
    // against the other's finished move.
    for (const state of aircraft) {
      if (!isAirworthy(state.status)) {
        this.lastSeen.delete(state.id);
        continue;
      }
      const seen = this.lastSeen.get(state.id);
      if (seen) V.copy(seen, state.position);
      else this.lastSeen.set(state.id, V.clone(state.position));
    }

    for (const streamer of this.ribbons.values()) {
      const record = this.scores.get(streamer.competitorId);
      if (record) record.remaining = streamer.length;
    }

    return this.cuts;
  }

  /** The board as it stands. Rebuilt only when it has moved. */
  standings(): StreamerStandings {
    if (this.board) return this.board;

    const ranked = this.order
      .map((id) => this.scores.get(id))
      .filter((record): record is ScoreRecord => record !== undefined)
      .sort((a, b) => b.cut - a.cut || b.remaining - a.remaining);

    let cutTotal = 0;
    for (const record of ranked) cutTotal += record.cut;

    const standings = ranked.map((record, index) => ({
      competitorId: record.competitorId,
      label: record.label,
      color: record.color,
      isPlayer: record.isPlayer,
      cut: record.cut,
      cuts: record.cuts,
      lost: record.lost,
      remaining: record.remaining,
      flying: record.flying,
      position: index + 1,
    }));

    this.board = {
      standings,
      player: standings.find((entry) => entry.isPlayer) ?? null,
      cutTotal,
      best: standings[0]?.cut ?? 0,
    };
    return this.board;
  }

  private record(entry: StreamerEntry): ScoreRecord {
    const existing = this.scores.get(entry.competitorId);
    if (existing) {
      existing.label = entry.label;
      existing.color = entry.color;
      existing.isPlayer = entry.isPlayer;
      return existing;
    }
    const record: ScoreRecord = {
      competitorId: entry.competitorId,
      label: entry.label,
      color: entry.color,
      isPlayer: entry.isPlayer,
      cut: 0,
      cuts: 0,
      lost: 0,
      remaining: this.fullLength,
      flying: true,
    };
    this.scores.set(entry.competitorId, record);
    this.order.push(entry.competitorId);
    return record;
  }

  /**
   * Walks one ribbon along behind its aircraft.
   *
   * The head is wherever the tail is now; everything behind it is where the
   * tail has been, frozen the moment the aircraft is a node's worth of air
   * further on. A ribbon put up this frame is laid out straight off the tail
   * at full length, because a streamer that had to grow for ten seconds is ten
   * seconds nobody can cut anything.
   */
  private advance(streamer: Streamer, owner: AircraftState): void {
    towPoint(_tow, owner);
    const points = streamer.points;

    // An airframe that was put somewhere rather than flown there brings its
    // paper with it: a fresh aircraft on the flight line is not towing a
    // ribbon stretched back to wherever the last one went in.
    if (
      points.length > 0 &&
      V.distance(points[0] as Vec3, _tow) > STREAMER_TELEPORT
    ) {
      points.length = 0;
    }

    if (points.length === 0) {
      forwardAxis(_forward, owner.orientation);
      const nodes = Math.max(Math.ceil(streamer.length / this.spacing), 1);
      for (let i = 0; i <= nodes; i += 1) {
        const back = Math.min((i * streamer.length) / nodes, streamer.length);
        points.push(V.addScaled(V.vec3(), _tow, _forward, -back));
      }
      return;
    }

    const head = points[0] as Vec3;
    // The node the head has been dragging: frozen once there is a node's worth
    // of air between it and where the tail has got to.
    if (points.length === 1 || V.distance(head, points[1] as Vec3) >= this.spacing) {
      points.splice(1, 0, V.clone(head));
    }
    V.copy(head, _tow);
    this.trim(streamer);
  }

  /** Cuts the polyline back to the length the ribbon actually has left. */
  private trim(streamer: Streamer): void {
    const points = streamer.points;
    let acc = 0;
    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1] as Vec3;
      const node = points[i] as Vec3;
      const remaining = streamer.length - acc;
      if (remaining <= 0) {
        points.length = i;
        return;
      }
      const segment = V.distance(previous, node);
      if (segment >= remaining) {
        if (segment > 1e-6) {
          V.lerpVec3(node, previous, node, remaining / segment);
        }
        points.length = i + 1;
        return;
      }
      acc += segment;
    }
  }

  /** Everybody's wings against everybody else's paper. */
  private cutPass(
    aircraft: readonly AircraftState[],
    byId: Map<string, AircraftState>,
  ): void {
    for (const streamer of this.list) {
      const owner = byId.get(streamer.aircraftId);
      if (!owner) continue;

      for (const cutter of aircraft) {
        // Nothing left worth taking: the knot is not a cut.
        if (streamer.length <= STREAMER_STUB + MIN_STREAMER_CUT) break;
        if (cutter.id === streamer.aircraftId) continue;
        if (!isAirworthy(cutter.status)) continue;

        const reach = cutter.config.collisionRadius;
        const from = this.lastSeen.get(cutter.id) ?? cutter.position;
        // The same rule from the other side: nobody cuts anything on the way
        // back to the flight line.
        if (V.distance(from, cutter.position) > STREAMER_TELEPORT) continue;
        // Nothing beyond the length of the ribbon plus the reach of the wing
        // and the ground it covered this frame can possibly have touched it.
        const span =
          streamer.length + reach + V.distance(from, cutter.position) + this.spacing;
        if (V.distance(cutter.position, owner.position) > span) continue;

        const hit = findCut(streamer, from, cutter.position, reach);
        if (hit === null) continue;

        const at = Math.max(hit, STREAMER_STUB);
        const lost = streamer.length - at;
        if (lost < MIN_STREAMER_CUT) continue;

        const position = pointAt(V.vec3(), streamer, at);
        streamer.length = at;
        this.trim(streamer);
        this.credit(streamer, cutter, lost, position);
      }
    }
  }

  /** Puts one cut on the board and reports it. */
  private credit(
    streamer: Streamer,
    cutter: AircraftState,
    lost: number,
    position: Vec3,
  ): void {
    const owner = this.scores.get(streamer.competitorId);
    if (owner) {
      owner.lost += lost;
      owner.remaining = streamer.length;
    }

    const cutterRibbon = this.ribbons.get(cutter.id);
    const cutterRecord = cutterRibbon
      ? this.scores.get(cutterRibbon.competitorId)
      : undefined;
    if (cutterRecord) {
      cutterRecord.cut += lost;
      cutterRecord.cuts += 1;
    }

    this.board = null;
    this.cuts.push({
      cutterId: cutter.id,
      cutterCompetitor: cutterRibbon?.competitorId ?? cutter.id,
      cutterLabel: cutterRecord?.label ?? cutter.id,
      ownerId: streamer.aircraftId,
      ownerCompetitor: streamer.competitorId,
      ownerLabel: owner?.label ?? streamer.aircraftId,
      length: lost,
      position,
      cutterIsPlayer:
        cutterRibbon?.isPlayer ?? cutter.role === AIRCRAFT_ROLE.Player,
      ownerIsPlayer: streamer.isPlayer,
    });
  }
}

/**
 * Where a ribbon is tied on.
 *
 * Just behind the airframe rather than through the middle of it, so the first
 * segment of paper is not inside the aeroplane towing it and nobody can cut a
 * ribbon by flying at the wing it is attached to.
 */
export function towPoint(out: Vec3, state: AircraftState): Vec3 {
  forwardAxis(_forward, state.orientation);
  return V.addScaled(out, state.position, _forward, -state.config.collisionRadius);
}

/** The point `arc` metres down a ribbon from the tail. Writes into `out`. */
export function pointAt(out: Vec3, streamer: Streamer, arc: number): Vec3 {
  const points = streamer.points;
  if (points.length === 0) return V.set(out, 0, 0, 0);

  const wanted = clamp(arc, 0, streamer.length);
  let acc = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1] as Vec3;
    const node = points[i] as Vec3;
    const segment = V.distance(previous, node);
    if (acc + segment >= wanted) {
      const t = segment > 1e-6 ? (wanted - acc) / segment : 0;
      return V.lerpVec3(out, previous, node, t);
    }
    acc += segment;
  }
  return V.copy(out, points[points.length - 1] as Vec3);
}

/**
 * Where a wing crossed a ribbon, as metres from the tail, or null if it did
 * not.
 *
 * The wing is a swept segment — where it was, to where it is — because at
 * twenty-five metres a second an aircraft covers most of a node between
 * frames, and a point test would fly a wing straight through the paper about
 * as often as it caught it. Of everything it touched, the crossing nearest the
 * tail is the one that counts: that is where the ribbon parts, and everything
 * beyond it is what falls away.
 */
export function findCut(
  streamer: Streamer,
  from: Vec3,
  to: Vec3,
  reach: number,
): number | null {
  const points = streamer.points;
  let acc = 0;
  let best: number | null = null;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1] as Vec3;
    const node = points[i] as Vec3;
    const segment = V.distance(previous, node);
    const hit = segmentApproach(previous, node, from, to);
    if (hit.distance <= reach) {
      const arc = acc + hit.at * segment;
      if (best === null || arc < best) best = arc;
    }
    acc += segment;
    if (acc >= streamer.length) break;
  }

  return best;
}

/** What one pilot has decided to go after. */
export interface StreamerQuarry {
  /** The airframe towing the ribbon. */
  readonly ownerId: string;
  /** Where on that ribbon to fly, local ENU metres. */
  readonly aim: Readonly<Vec3>;
  /** Metres from the hunter to that point. */
  readonly range: number;
  /** Metres of paper still on it. */
  readonly length: number;
}

export interface QuarryOptions {
  /**
   * How far down the ribbon from the tail to fly, 0..1.
   *
   * The whole nerve of the event. Nought is the knot on somebody's tail, which
   * takes the lot and is one bad judgement away from a mid-air; one is the very
   * tip, which is safe and worth a metre.
   */
  readonly aimFraction: number;
  /** How far out a ribbon is worth crossing the field for, metres. */
  readonly searchRange?: number;
}

/**
 * The ribbon a pilot should be flying at, if any is worth it.
 *
 * Nearest first and nothing clever: everybody on the field can see everybody
 * else's paper, and what separates a good hunter from a bad one is how close
 * to the knot they are willing to fly, not who they picked.
 *
 * Writes the aim point into `out`.
 */
export function chooseQuarry(
  out: Vec3,
  field: StreamerField,
  self: AircraftState,
  options: QuarryOptions,
): StreamerQuarry | null {
  const searchRange = options.searchRange ?? STREAMER_HUNT_RANGE;
  const fraction = clamp(options.aimFraction, 0, 1);

  let bestRange = searchRange;
  let quarry: StreamerQuarry | null = null;

  for (const streamer of field.streamers) {
    if (streamer.aircraftId === self.id) continue;
    if (streamer.length <= STREAMER_STUB + MIN_STREAMER_CUT) continue;

    // Aimed at a share of what is left rather than a fixed distance down it: a
    // ribbon somebody has already taken most of is a short ribbon, and flying
    // at where the tip used to be is flying at nothing.
    const arc = STREAMER_STUB + (streamer.length - STREAMER_STUB) * fraction;
    pointAt(_closest, streamer, arc);
    const range = V.distance(_closest, self.position);
    if (range >= bestRange) continue;

    bestRange = range;
    V.copy(out, _closest);
    quarry = {
      ownerId: streamer.aircraftId,
      aim: out,
      range,
      length: streamer.length,
    };
  }

  return quarry;
}

/**
 * The same, aimed at one particular ribbon.
 *
 * What a pilot who has already picked somebody asks for. Nobody at a streamer
 * event changes their mind every tenth of a second: you commit to a tail, you
 * work it, and you look for another one when it is gone or you have lost it.
 */
export function quarryOf(
  out: Vec3,
  field: StreamerField,
  ownerId: string,
  aimFraction: number,
): StreamerQuarry | null {
  const streamer = field.streamerOf(ownerId);
  if (!streamer) return null;
  if (streamer.length <= STREAMER_STUB + MIN_STREAMER_CUT) return null;

  const fraction = clamp(aimFraction, 0, 1);
  const arc = STREAMER_STUB + (streamer.length - STREAMER_STUB) * fraction;
  pointAt(out, streamer, arc);
  return { ownerId, aim: out, range: 0, length: streamer.length };
}

/** A length of paper written the way the OSD and the debrief say it. */
export function formatStreamerLength(metres: number): string {
  return `${metres.toFixed(metres < 10 ? 1 : 0)} m`;
}

/** How the event reads once the slot is over. */
export function streamerSummary(standings: StreamerStandings): string {
  const player = standings.player;
  if (!player) return "Streamer cut: nothing on the board.";

  const cut = formatStreamerLength(player.cut);
  const field = standings.standings.length;
  const place = ordinal(player.position);
  const kept =
    player.remaining > 0
      ? ` ${formatStreamerLength(player.remaining)} of your own still on the tail.`
      : " Nothing left of your own.";

  if (player.position === 1) {
    return `Streamer cut: ${cut} taken off the field and nobody took more.${kept}`;
  }
  const leader = standings.standings[0];
  return `Streamer cut: ${cut}, ${place} of ${field}${
    leader ? ` behind ${leader.label} on ${formatStreamerLength(leader.cut)}` : ""
  }.${kept}`;
}

/** 1st, 2nd, 3rd, and everything after it. */
export function ordinal(position: number): string {
  const tens = position % 100;
  if (tens >= 11 && tens <= 13) return `${position}th`;
  const unit = position % 10;
  if (unit === 1) return `${position}st`;
  if (unit === 2) return `${position}nd`;
  if (unit === 3) return `${position}rd`;
  return `${position}th`;
}

interface Approach {
  /** Closest distance between the two segments, metres. */
  readonly distance: number;
  /** Where on the first segment that happened, 0..1. */
  readonly at: number;
}

const _d1 = V.vec3();
const _d2 = V.vec3();
const _r = V.vec3();
const _pa = V.vec3();
const _pb = V.vec3();
const _approach: { distance: number; at: number } = { distance: 0, at: 0 };

/**
 * How close two segments came, and where on the first one.
 *
 * The standard clamped-parameter solution: solve the unconstrained closest
 * approach of the two infinite lines, clamp onto both segments, and re-solve
 * the one that moved. Written out rather than pulled in because it is the only
 * place in the simulator that needs it, and it is the inner loop of the whole
 * event.
 */
function segmentApproach(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): Approach {
  V.subtract(_d1, q1, p1);
  V.subtract(_d2, q2, p2);
  V.subtract(_r, p1, p2);

  const a = V.dot(_d1, _d1);
  const e = V.dot(_d2, _d2);
  const f = V.dot(_d2, _r);

  let s = 0;
  let t = 0;

  if (a <= 1e-9 && e <= 1e-9) {
    // Both degenerate: two points.
    _approach.distance = V.distance(p1, p2);
    _approach.at = 0;
    return _approach;
  }

  if (a <= 1e-9) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = V.dot(_d1, _r);
    if (e <= 1e-9) {
      s = clamp(-c / a, 0, 1);
    } else {
      const b = V.dot(_d1, _d2);
      const denom = a * e - b * b;
      s = denom > 1e-9 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  V.addScaled(_pa, p1, _d1, s);
  V.addScaled(_pb, p2, _d2, t);
  _approach.distance = V.distance(_pa, _pb);
  _approach.at = s;
  return _approach;
}
