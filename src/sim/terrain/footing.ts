/**
 * The ground somebody is standing on, as opposed to the column under them.
 *
 * A height field is a grid, and between its corners it is a flat sheet
 * stretched over whatever the ground actually does. Over a runway that is the
 * same surface; over anything with shape in it — a bank, a ditch, a stony
 * slope, the lip of a quarry — the interpolated sheet cuts the corners, and it
 * cuts them *downwards* exactly where the ground rises fastest. The finer grid
 * the field keeps close in narrows that to a metre or two. A metre or two is
 * nothing at circuit height and it is the whole story at head height: the RC
 * ground view puts the pilot's eyes 1.7 m over the ground, and a launch point
 * on a hillside spends most of that margin on the gap between the sheet and
 * the hill. What is left of it, the surface the renderer draws — which is the
 * same data at whatever tile level has streamed in, not the level the field
 * sampled — takes the rest, and the flight opens looking at the inside of the
 * ground.
 *
 * The fix is to stop treating one column as the ground. A person standing on a
 * slope is standing on the whole patch their feet and the ground around them
 * occupy, and what they can see over is the top of it. So the ground underfoot
 * is read as the highest the field goes within a couple of paces, which is the
 * same answer as the column itself wherever the ground is flat — a field, a
 * beach, a runway, everywhere this was never wrong — and a step up out of the
 * dip wherever it is not.
 *
 * The rise is capped, because a launch point picked on the edge of a cliff has
 * a hundred metres of ground within a couple of paces of it and the pilot is
 * standing on the edge rather than on top of the cliff.
 */

import type { TerrainSampler } from "./types";

/**
 * How far around a stand the ground is read, metres.
 *
 * A couple of paces: far enough to reach into the neighbouring cells of the
 * close-in grid, which is where the corners the interpolation cut off are, and
 * near enough that it is still the ground the person is on rather than the
 * next field along.
 */
export const FOOTING_RADIUS = 8;

/**
 * The most a stand is ever raised above its own column on the strength of the
 * height field alone, metres.
 *
 * Terrain relief this side of a cliff is metres, and a launch point on the lip
 * of one is a launch point on the lip of one — the pilot is standing at the
 * edge looking out, not hovering level with the top. This is a guess made from
 * a grid, so it is held to what a guess is worth; a surface somebody actually
 * measured gets `MAX_MEASURED_RISE` instead.
 */
export const MAX_FOOTING_RISE = 10;

/**
 * The most a stand is raised onto a surface that was measured rather than
 * guessed, metres.
 *
 * The height field describes bare earth. What the scene draws over it need not:
 * a photorealistic tileset reconstructs the trees, and a forest floor is
 * fifteen or twenty metres under its own canopy. A pilot put at head height
 * over the bare earth in a wood is standing inside the wood — which is the
 * same failure as standing inside a hill and looks exactly like it.
 *
 * So a reading taken off the scene is trusted a long way further than a guess
 * off the grid: it is not an estimate of the ground, it is the ground, and the
 * only sane place to stand in a forest is on top of it. The limit is here to
 * catch a reading that cannot be a surface anybody is standing on rather than
 * to second-guess a tall one — it is above the tallest tree on Earth.
 */
export const MAX_MEASURED_RISE = 150;

/**
 * Where the ground is read, as fractions of the radius.
 *
 * Two rings rather than one: the close-in grid is sampled every ten metres, so
 * a single ring at one radius can sit inside one cell the whole way round and
 * find nothing the centre did not already say.
 */
const FOOTING_PATTERN: readonly (readonly [number, number])[] = (() => {
  const pattern: [number, number][] = [];
  for (const scale of [0.5, 1]) {
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      pattern.push([Math.sin(angle) * scale, Math.cos(angle) * scale]);
    }
  }
  return pattern;
})();

/**
 * The ground under somebody standing at this column, in local ENU metres.
 *
 * Cached reads only, so this is as cheap as the column it is standing in for
 * and can be called every frame. Columns the field has no sample for are
 * skipped rather than counted as sea level, the same rule collision and line
 * of sight work under: missing data is missing data, not a hole to fall in.
 */
export function groundUnderfoot(
  terrain: TerrainSampler,
  localX: number,
  localY: number,
  radius = FOOTING_RADIUS,
  limit = MAX_FOOTING_RISE,
): number {
  const column = terrain.heightAt(localX, localY);
  // Nothing is known about this ground yet, so there is nothing to stand on
  // but the fallback the field handed back.
  if (!terrain.hasCoverage(localX, localY)) return column;

  let highest = column;
  for (const [dx, dy] of FOOTING_PATTERN) {
    const x = localX + dx * radius;
    const y = localY + dy * radius;
    if (!terrain.hasCoverage(x, y)) continue;
    const height = terrain.heightAt(x, y);
    if (height > highest) highest = height;
  }
  return Math.min(highest, column + limit);
}

/**
 * How far below the height field a reading is still evidence about the ground,
 * metres.
 *
 * A globe tile that has not refined sags, and a sagging reading is not somewhere
 * to stand — but it is still a witness, and one that disagrees with a lone high
 * reading is exactly the witness that matters. Anything further down than this
 * is not a reading at all: a height sample whose ray found nothing comes back as
 * a point near the centre of the Earth rather than as null.
 */
export const MAX_MEASURED_DROP = 200;

/**
 * How close two readings must be to count as looking at the same thing, metres.
 *
 * Loose, because the thing being measured is loose. A canopy over three metres
 * of ground is not a plane — crowns are metres apart in height, and a tolerance
 * tighter than the roughness of the surface finds no two readings that agree
 * and throws the whole canopy away as unbelievable. Measured in the Amazon with
 * two metres: the wood was rejected and the pilot put on the forest floor,
 * two metres inside it.
 *
 * It does not have to be tight to do its job. What it is screening out is a ray
 * that found nothing, and those miss by hundreds of metres rather than by five.
 */
export const MEASURED_AGREEMENT = 5;

/** How many readings have to agree before one is believed. */
export const MEASURED_QUORUM = 3;

/**
 * The surface a stand is on, from the readings taken around it.
 *
 * Not the highest of them, which is the obvious answer and the wrong one. A
 * scene height sample is only as settled as the tiles under it, and an unsettled
 * one does not fail cleanly: it comes back finite and absurd, a thousand metres
 * up or six million down, and the highest reading of a batch is precisely the
 * one such an answer wins. Measured while a globe was still refining: readings
 * of +1137 m and -6 346 943 m over ground that is flat to a quarter of a metre.
 *
 * So a reading has to be corroborated before it is believed. Anything outside
 * the band the ground could possibly be in is dropped outright, and of what is
 * left, the highest reading that `MEASURED_QUORUM` readings agree with wins.
 * Real ground is agreed on by its neighbours — a canopy, a roof and a field all
 * have breadth. A ray that found nothing has nothing to agree with it.
 *
 * Returns null when nothing is corroborated, which means "no measurement",
 * not "no ground": the caller keeps whatever it had.
 */
export function measuredSurface(
  picks: readonly (number | null | undefined)[],
  column: number,
  limit = MAX_MEASURED_RISE,
): number | null {
  const plausible: number[] = [];
  for (const pick of picks) {
    if (pick === null || pick === undefined || !Number.isFinite(pick)) continue;
    if (pick < column - MAX_MEASURED_DROP) continue;
    if (pick > column + limit) continue;
    plausible.push(pick);
  }
  if (plausible.length < MEASURED_QUORUM) return null;

  let best: number | null = null;
  for (const value of plausible) {
    let agreeing = 0;
    for (const other of plausible) {
      if (Math.abs(other - value) <= MEASURED_AGREEMENT) agreeing += 1;
    }
    if (agreeing < MEASURED_QUORUM) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

/**
 * The ground a stand is set on, given the height field and what the scene is
 * drawing at the same column.
 *
 * Three answers in order of authority. A measured surface above the field is
 * the ground the pilot can see, and wins — that is the canopy, the roof, the
 * mesh that the elevation data knows nothing about. A measured surface *below*
 * the field is the globe sagging at a tile level that has not refined yet, and
 * is discarded: it is a hole in the picture, not somewhere to stand. With no
 * measurement at all the field's own footing is all there is.
 *
 * @param column    What the height field reads at this column, metres.
 * @param underfoot `groundUnderfoot` at the same column, metres.
 * @param drawn     Height of the surface the scene draws there, or null.
 */
export function standingSurface(
  column: number,
  underfoot: number,
  drawn: number | null,
  limit = MAX_MEASURED_RISE,
): number {
  if (drawn === null || !Number.isFinite(drawn)) return underfoot;
  if (drawn <= underfoot) return underfoot;
  return Math.min(drawn, column + limit);
}
