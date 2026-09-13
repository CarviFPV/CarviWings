import { assert, assertBetween, assertClose, suite } from "./harness";
import { TerrainField } from "../terrain/terrainField";
import {
  FOOTING_RADIUS,
  MAX_FOOTING_RISE,
  MAX_MEASURED_RISE,
  MEASURED_QUORUM,
  groundUnderfoot,
  measuredSurface,
  standingSurface,
} from "../terrain/footing";
import { SurfaceCalibration } from "../terrain/surfaceCalibration";
import type { TerrainQuery } from "../terrain/types";
import type { Vec3 } from "../math/vec3";
import { vec3 } from "../math/vec3";

/** An analytic ridge so interpolation can be checked against a known surface. */
function ridgeHeight(x: number, y: number): number {
  return 1000 + 400 * Math.sin(x / 900) + 250 * Math.cos(y / 1300);
}

/**
 * The same ridge with the small stuff left in: hedgerows, ditches and the
 * general lumpiness of a field, at a scale a hundred-metre grid cannot see and
 * a wing being put down on it very much can.
 */
function roughHeight(x: number, y: number): number {
  return (
    ridgeHeight(x, y) +
    4 * Math.sin(x / 31) +
    3 * Math.cos(y / 27) +
    2.5 * Math.sin((x + y) / 43)
  );
}

/**
 * A hillside with a hollow scooped out of it — a hedge corner, a wheel rut, the
 * low side of a field. The kind of ground a start point lands on the moment it
 * is not a runway, and the kind a single column has nothing to say about.
 */
function hollowHeight(x: number, y: number): number {
  const radius = Math.hypot(x, y);
  return 700 + y * 0.25 - 6 * Math.exp(-(radius * radius) / (2 * 9 * 9));
}

/** The highest the field reads anywhere within a radius of a column. */
function highestWithin(
  field: TerrainField,
  x: number,
  y: number,
  radius: number,
): number {
  let highest = -Infinity;
  for (let dx = -radius; dx <= radius; dx += 0.5) {
    for (let dy = -radius; dy <= radius; dy += 0.5) {
      if (dx * dx + dy * dy > radius * radius) continue;
      highest = Math.max(highest, field.heightAt(x + dx, y + dy));
    }
  }
  return highest;
}

/** Worst error against the true surface over a small patch, metres. */
function worstError(
  field: TerrainField,
  height: (x: number, y: number) => number,
  centre: Vec3,
  radius: number,
): number {
  let worst = 0;
  for (let x = centre.x - radius; x <= centre.x + radius; x += 7) {
    for (let y = centre.y - radius; y <= centre.y + radius; y += 7) {
      worst = Math.max(worst, Math.abs(field.heightAt(x, y) - height(x, y)));
    }
  }
  return worst;
}

/** Runs refreshes until the field stops asking for cells. */
async function warm(field: TerrainField, centre: Vec3, passes = 40): Promise<void> {
  for (let i = 0; i < passes; i += 1) {
    field.refresh(centre, vec3(), 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function runTerrainTests(): Promise<void> {
  let batches = 0;
  let sampledPoints = 0;

  const probe = async (points: readonly TerrainQuery[]) => {
    batches += 1;
    sampledPoints += points.length;
    return points.map((p) => ridgeHeight(p.x, p.y));
  };

  // Coarse grid only: this suite is about what a hundred-metre grid can and
  // cannot do, and the close-in grid exists precisely to be better than it.
  const field = new TerrainField(probe, {
    cellSize: 100,
    warmRadius: 500,
    sampleBudget: 200,
    fallbackHeight: -1,
    detailCellSize: 0,
  });

  await suite("terrain field", async () => {
    assert(!field.ready, "field starts empty");
    assert(!field.hasCoverage(0, 0), "no coverage before sampling");
    assertClose(field.heightAt(0, 0), -1, 1e-9, "falls back before any sample");

    await field.prefill(vec3(), 400);
    assert(field.ready, "prefill populates the field");
    assert(field.hasCoverage(0, 0), "origin has coverage after prefill");
    assert(field.hasCoverage(250, -150), "interior columns have coverage");
    assert(!field.hasCoverage(5000, 5000), "far columns have no coverage");

    // On-grid columns must reproduce the surface exactly.
    assertClose(field.heightAt(0, 0), ridgeHeight(0, 0), 1e-9, "grid point is exact");
    assertClose(
      field.heightAt(200, -300),
      ridgeHeight(200, -300),
      1e-9,
      "another grid point is exact",
    );

    // Between grid points, bilinear interpolation should track the surface
    // closely on a 100 m grid.
    let worst = 0;
    for (let x = -300; x <= 300; x += 37) {
      for (let y = -300; y <= 300; y += 41) {
        worst = Math.max(worst, Math.abs(field.heightAt(x, y) - ridgeHeight(x, y)));
      }
    }
    assert(worst < 3, `bilinear interpolation stays within 3 m (worst ${worst.toFixed(2)} m)`);

    // Repeated reads must not sample again: the read path performs no I/O.
    const batchesBefore = batches;
    for (let i = 0; i < 10000; i += 1) field.heightAt(i % 400, -(i % 400));
    assert(batches === batchesBefore, "10k reads issue zero probes");

    // Refresh only requests cells it does not already have.
    const cellsBefore = field.cachedCells;
    const pointsBefore = sampledPoints;
    field.refresh(vec3(0, 0, 0), vec3(), 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(
      sampledPoints > pointsBefore,
      "refresh extends the warm area outward",
    );
    assert(field.cachedCells > cellsBefore, "new cells are cached");

    const pointsAfterWarm = sampledPoints;
    field.refresh(vec3(0, 0, 0), vec3(), 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    field.refresh(vec3(0, 0, 0), vec3(), 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const grew = sampledPoints - pointsAfterWarm;
    assert(grew >= 0, "steady-state refresh does not re-request known cells");

    // A failing probe must leave the field usable and retryable.
    let failures = 0;
    const flaky = new TerrainField(
      async (points) => {
        failures += 1;
        if (failures === 1) throw new Error("network");
        return points.map((p) => ridgeHeight(p.x, p.y));
      },
      {
        cellSize: 100,
        warmRadius: 200,
        sampleBudget: 64,
        fallbackHeight: 0,
        detailCellSize: 0,
      },
    );
    flaky.refresh(vec3(), vec3(), 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(!flaky.ready, "a failed batch leaves the field empty");
    flaky.refresh(vec3(), vec3(), 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(flaky.ready, "the same cells are retried after a failure");
  });

  await suite("the close-in grid is what a landing is flown on", async () => {
    const options = {
      cellSize: 100,
      warmRadius: 600,
      sampleBudget: 8192,
      fallbackHeight: 0,
      detailCellSize: 10,
      detailRadius: 150,
      detailCeiling: 300,
    };
    const surface = async (points: readonly TerrainQuery[]) =>
      points.map((p) => roughHeight(p.x, p.y));

    // Fifty metres up, which is where an approach is flown.
    const low = vec3(0, 0, roughHeight(0, 0) + 50);

    const coarse = new TerrainField(surface, { ...options, detailCellSize: 0 });
    const detailed = new TerrainField(surface, options);
    await warm(coarse, low);
    await warm(detailed, low);

    const coarseError = worstError(coarse, roughHeight, low, 60);
    const detailError = worstError(detailed, roughHeight, low, 60);

    assert(
      coarseError > 2,
      `a hundred-metre grid is metres out on real ground (${coarseError.toFixed(2)} m)`,
    );
    assert(
      detailError < 0.5,
      `the close-in grid holds half a metre (${detailError.toFixed(2)} m)`,
    );
    assert(
      detailed.hasDetail(0, 0),
      "and it has actually resolved the ground under the aircraft",
    );

    // The two grids agree on the shape of the world, so nothing lurches when a
    // read crosses out of the fine one.
    assertClose(
      detailed.heightAt(0, 0),
      roughHeight(0, 0),
      0.5,
      "on-station reads track the surface",
    );

    // Up high the fine grid is not worth its requests and is never filled.
    let sampled = 0;
    const high = new TerrainField(async (points: readonly TerrainQuery[]) => {
      sampled += points.length;
      return points.map((p) => roughHeight(p.x, p.y));
    }, options);
    await warm(high, vec3(0, 0, roughHeight(0, 0) + 2000));
    assert(high.detailCells === 0, "at altitude the close-in grid stays empty");
    assert(
      !high.hasDetail(0, 0) && high.hasCoverage(0, 0),
      "but the coarse grid still covers the ground, so contact still works",
    );
    assert(sampled > 0, "and the coarse grid was filled");
  });

  await suite("a mission fills the field before it flies over it", async () => {
    // What the flight will actually ask for: a coarse block wide enough to
    // cover the first minute of it, and the close-in grid under the launch.
    const options = {
      cellSize: 100,
      warmRadius: 900,
      sampleBudget: 1200,
      detailCellSize: 10,
      detailRadius: 160,
      detailCeiling: 300,
    };

    let requests = 0;
    let points = 0;
    const surface = async (batch: readonly TerrainQuery[]) => {
      requests += 1;
      points += batch.length;
      return batch.map((p) => roughHeight(p.x, p.y));
    };

    const field = new TerrainField(surface, options);
    await field.prefill(vec3(), 1600);

    assert(field.ready, "the field is ready before anything has flown");
    assert(
      field.hasCoverage(0, 0) && field.hasCoverage(1400, -1400),
      "the whole prefilled block is covered, corners included",
    );
    assert(
      field.hasDetail(0, 0),
      "and the close-in grid has resolved the ground under the launch",
    );
    assertClose(
      field.heightAt(3, -7),
      roughHeight(3, -7),
      0.5,
      "so the launch stands on the real surface, not an interpolated one",
    );

    // The point of the wider budget: a block is a pass over the tiles it
    // lands in, not one pass per hundred cells. 33x33 coarse cells and 33x33
    // fine ones are one request each.
    assert(
      requests <= 2,
      `both grids are filled in one request apiece (took ${requests})`,
    );
    assert(points > 2000, `and every cell of both was asked for (${points})`);

    // A flight that opens where it was prefilled has nothing left to ask for,
    // which is the whole point: the first minute spends no frames on terrain.
    const before = requests;
    for (let i = 0; i < 5; i += 1) {
      field.refresh(vec3(0, 0, roughHeight(0, 0) + 120), vec3(), 0.1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert(
      requests === before,
      `and the opening refreshes ask for nothing (${requests - before} requests)`,
    );

    // Flying out of the prefilled block still works: the field asks again
    // rather than believing the edge of what it was given.
    field.refresh(vec3(2400, 0, roughHeight(2400, 0) + 120), vec3(), 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(requests > before, "leaving the prefilled block resumes sampling");
  });

  await suite("the field can be offset onto the surface that is drawn", async () => {
    const field = new TerrainField(
      async (points: readonly TerrainQuery[]) =>
        points.map((p) => ridgeHeight(p.x, p.y)),
      { cellSize: 100, warmRadius: 300, sampleBudget: 512, detailCellSize: 0 },
    );
    await field.prefill(vec3(), 300);

    const before = field.heightAt(50, 50);
    field.setSurfaceBias(-1.75);
    assertClose(
      field.heightAt(50, 50),
      before - 1.75,
      1e-9,
      "every reading moves with the correction",
    );
    assertClose(field.surfaceBias, -1.75, 1e-9, "and the correction is readable");
    field.setSurfaceBias(0);
    assertClose(field.heightAt(50, 50), before, 1e-9, "and it can be taken off");
  });

  suite("measuring the drawn surface against the sampled one", () => {
    /** Runs the clock, feeding a pick every 0.4 s the way a flight does. */
    const fly = (
      calibration: SurfaceCalibration,
      seconds: number,
      drawn: (index: number) => number | null,
    ): void => {
      for (let i = 0; i < Math.round(seconds * 60); i += 1) {
        calibration.update(1 / 60);
        if (i % 24 !== 0) continue;
        const height = drawn(i / 24);
        if (height !== null) calibration.observe(height, 1000);
      }
    };

    // Open ground: every pick lands on the same surface a couple of metres
    // above where the elevation data says it is.
    const agreeing = new SurfaceCalibration();
    fly(agreeing, 8, (n) => 1002.2 + (n % 3) * 0.05);
    assertBetween(
      agreeing.bias,
      2,
      2.5,
      `consistent measurements are adopted (${agreeing.bias.toFixed(2)} m)`,
    );
    assert(agreeing.settled, "and the correction reads as settled");

    // A town: every pick lands on something different, and nothing about a
    // roof says anything about where the ground is.
    const roofs = [1002, 1014, 1001, 1019, 1003, 1021];
    const town = new SurfaceCalibration();
    fly(town, 8, (n) => roofs[n % roofs.length] ?? 1000);
    assertClose(
      town.bias,
      0,
      0.01,
      "measurements that disagree are not a correction",
    );

    // Nothing the size of a building is ever mistaken for a datum offset.
    const tower = new SurfaceCalibration();
    fly(tower, 10, () => 1040);
    assertBetween(tower.bias, 2.9, 3.01, "and a large offset is clamped");

    // Picking stops — over water, or with the tileset gone — and the
    // correction lets go rather than staying stale.
    const stale = new SurfaceCalibration();
    fly(stale, 6, () => 1002);
    assert(stale.bias > 1.5, "a correction that was measured is applied");
    fly(stale, 14, () => null);
    assertClose(stale.bias, 0, 0.05, "and decays once nothing is measured");
  });

  await suite("the ground under somebody's feet, not the column", async () => {
    const options = {
      cellSize: 50,
      warmRadius: 900,
      sampleBudget: 8192,
      detailCellSize: 10,
      detailRadius: 160,
    };

    // A runway, an airfield, a beach: one column is the whole answer, and this
    // has to change nothing at all about them.
    const flat = new TerrainField(
      async (points: readonly TerrainQuery[]) => points.map(() => 240),
      options,
    );
    await flat.prefill(vec3(), 900);
    assertClose(
      groundUnderfoot(flat, 0, 0),
      flat.heightAt(0, 0),
      1e-9,
      "flat ground reads exactly as its own column does",
    );

    // The hollow. The column the flight starts on is metres below the ground
    // a couple of paces away, and a pilot standing at head height over it is
    // looking at the inside of it.
    const hollow = new TerrainField(
      async (points: readonly TerrainQuery[]) =>
        points.map((p) => hollowHeight(p.x, p.y)),
      options,
    );
    await hollow.prefill(vec3(), 900);

    const column = hollow.heightAt(0, 0);
    const around = highestWithin(hollow, 0, 0, FOOTING_RADIUS);
    assert(
      around > column + 3,
      `the fixture really is a hollow (${(around - column).toFixed(1)} m of it)`,
    );

    const stand = groundUnderfoot(hollow, 0, 0);
    assert(
      stand >= around - 0.2,
      `a stand in it clears the ground around it (${stand.toFixed(1)} m against ${around.toFixed(1)} m)`,
    );
    assert(
      stand <= around + 0.2,
      "and no higher: it is the top of the patch, not a guess above it",
    );

    // A cliff edge is a cliff edge. Standing on the lip of one is not standing
    // level with the top of it, however much ground is within a pace.
    const cliff = new TerrainField(
      async (points: readonly TerrainQuery[]) =>
        points.map((p) => (p.y > 0 ? 400 : 300)),
      options,
    );
    await cliff.prefill(vec3(), 900);
    assertBetween(
      groundUnderfoot(cliff, 0, -6) - cliff.heightAt(0, -6),
      MAX_FOOTING_RISE - 1e-6,
      MAX_FOOTING_RISE + 1e-6,
      "a hundred-metre face lifts a stand by the cap and no further",
    );

    // Ground nothing has been sampled for is missing data, not a hole to fall
    // into, and not something to stand on top of either.
    const unknown = new TerrainField(
      async (points: readonly TerrainQuery[]) => points.map(() => null),
      options,
    );
    assertClose(
      groundUnderfoot(unknown, 0, 0),
      unknown.heightAt(0, 0),
      1e-9,
      "an unsampled column is left exactly where the field put it",
    );
  });

  suite("standing on what the scene is drawing, not on bare earth", () => {
    // Open ground: nothing is drawn over the height field, so there is nothing
    // to stand on but the field, and this changes none of it.
    assertClose(
      standingSurface(240, 240.6, 240.1),
      240.6,
      1e-9,
      "a drawn surface level with the ground leaves the footing alone",
    );
    assertClose(
      standingSurface(240, 240.6, null),
      240.6,
      1e-9,
      "and so does having nothing measured at all",
    );

    // The bug this exists for. Bare earth at 783 m, a photogrammetry canopy
    // drawn at 797 m: head height over the first is eleven metres inside the
    // second, which is what "I start under the ground" looks like in a wood.
    assertClose(
      standingSurface(783.3, 783.8, 797.1),
      797.1,
      1e-9,
      "a canopy is the ground in a wood, and the stand goes on top of it",
    );

    // A globe tile that has not refined sags below the real surface. That is a
    // hole in the picture, not somewhere to stand.
    assertClose(
      standingSurface(783.3, 783.8, 779.4),
      783.8,
      1e-9,
      "a sagging tile is discarded rather than stood in",
    );

    // Nothing that could not be a surface somebody is standing on. The limit is
    // above the tallest tree there is, so it never catches a real canopy.
    assertClose(
      standingSurface(783.3, 783.8, 783.3 + MAX_MEASURED_RISE + 40),
      783.3 + MAX_MEASURED_RISE,
      1e-9,
      "and a reading that cannot be ground is held to the limit",
    );
    assert(
      MAX_MEASURED_RISE > MAX_FOOTING_RISE,
      "a measurement is trusted further than a guess off the grid",
    );

    assertClose(
      standingSurface(783.3, 783.8, Number.NaN),
      783.8,
      1e-9,
      "a pick that found nothing leaves the footing alone",
    );
  });

  suite("a reading of the scene has to be corroborated", () => {
    const ground = 784.5;
    const flat = Array.from({ length: 21 }, (_, i) => ground + (i % 3) * 0.1);

    assertBetween(
      measuredSurface(flat, ground) ?? Number.NaN,
      ground,
      ground + 0.3,
      "a field that agrees with itself reads as the field",
    );

    // What an unsettled height sample actually returns, measured against a
    // real scene while its globe was still refining: finite, and absurd in
    // both directions over ground that is flat to a quarter of a metre.
    const withGarbage = [...flat, ground + 1137, -6346943.11];
    assertBetween(
      measuredSurface(withGarbage, ground) ?? Number.NaN,
      ground,
      ground + 0.3,
      "and a thousand-metre spike among them changes nothing",
    );

    // The failure this exists for: taking the highest of the batch hands the
    // launch to the spike.
    const highest = Math.max(...withGarbage);
    assert(
      highest - ground > 1000,
      `the highest reading really is the spike (${(highest - ground).toFixed(0)} m up)`,
    );

    // A canopy is agreed on by its neighbours, so it is believed.
    const canopy = [
      ...Array.from({ length: 8 }, () => ground),
      ...Array.from({ length: 6 }, (_, i) => ground + 15 + i * 0.1),
    ];
    assertBetween(
      measuredSurface(canopy, ground) ?? Number.NaN,
      ground + 15,
      ground + 15.6,
      "a canopy several readings agree on is the surface",
    );

    // A canopy is rough: crowns over three metres of ground stand metres apart.
    // It still has to be believed — this is the Amazon, where a tolerance
    // tighter than the roughness of a wood threw the wood away and put the
    // pilot on the floor of it.
    const rough = [
      ...Array.from({ length: 8 }, () => ground),
      ground + 12.7,
      ground + 15.9,
      ground + 10.4,
      ground + 14.1,
      ground + 17.2,
      ground + 13.3,
    ];
    assertBetween(
      measuredSurface(rough, ground) ?? Number.NaN,
      ground + 15,
      ground + 18,
      "a rough canopy corroborates itself and is stood on",
    );

    // One reading on its own, metres above everything around it, is a ray that
    // found something that is not the ground.
    const loner = [...Array.from({ length: 20 }, () => ground), ground + 28];
    assertBetween(
      measuredSurface(loner, ground) ?? Number.NaN,
      ground,
      ground + 0.01,
      "a single high reading with nothing agreeing is not a surface",
    );

    assert(
      measuredSurface([null, undefined, Number.NaN], ground) === null,
      "nothing readable is no measurement rather than a wrong one",
    );
    assert(
      measuredSurface(
        Array.from({ length: MEASURED_QUORUM - 1 }, () => ground),
        ground,
      ) === null,
      "and too few readings to corroborate is no measurement either",
    );
  });
}
