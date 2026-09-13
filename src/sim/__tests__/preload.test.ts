/**
 * The preload plan: how much of the world is fetched before the sticks are
 * handed over, and how long the loading screen is allowed to spend on it.
 */

import { assert, assertClose, suite } from "./harness";
import {
  MAX_OVERVIEW_HEIGHT,
  MAX_SWEEP_BUDGET_MS,
  MAX_TERRAIN_RADIUS,
  MIN_OVERVIEW_HEIGHT,
  MIN_TERRAIN_RADIUS,
  SWEEP_LEGS,
  overviewHeightFor,
  preloadPlanFor,
  sweepBearings,
  terrainPrefillRadius,
} from "../render/preloadPlan";

export function runPreloadTests(): void {
  suite("preload: round the whole compass", () => {
    const bearings = sweepBearings();
    assert(
      bearings.length === SWEEP_LEGS - 1,
      "every point of the compass but the one already streamed is swept",
    );
    assert(
      !bearings.includes(0),
      "the opening view is not swept again — it was waited for properly",
    );
    const spacing = 360 / SWEEP_LEGS;
    assert(
      bearings.every(
        (bearing, index) => Math.abs(bearing - (index + 1) * spacing) < 1e-9,
      ),
      "the legs are spaced evenly right round the circle",
    );
    assert(
      bearings.every((bearing) => bearing > 0 && bearing < 360),
      "and every leg is a bearing off the start heading rather than a full turn",
    );
    assert(
      spacing <= 90,
      "no gap between two legs is wider than the camera can see across",
    );
  });

  suite("preload: the overview pass", () => {
    assertClose(
      overviewHeightFor(0, 60),
      MIN_OVERVIEW_HEIGHT,
      1e-6,
      "even a mission with no radius climbs high enough to stage the district",
    );
    assert(
      overviewHeightFor(3000, 60) > overviewHeightFor(1000, 60),
      "a bigger mission is staged from higher up",
    );
    assertClose(
      overviewHeightFor(50000, 60),
      MAX_OVERVIEW_HEIGHT,
      1e-6,
      "and a fifty-kilometre one is capped rather than taken literally",
    );
    assert(
      overviewHeightFor(50000, 3) < overviewHeightFor(50000, 60),
      "a pilot who pulled the view distance in is not made to wait for hills they cannot see",
    );
    assert(
      overviewHeightFor(50000, 0) >= MIN_OVERVIEW_HEIGHT,
      "and pulling it all the way in still stages the field itself",
    );
  });

  suite("preload: the elevation the flight model reads", () => {
    assertClose(
      terrainPrefillRadius(500),
      MIN_TERRAIN_RADIUS,
      1e-6,
      "the smallest field still gets the first minute of flight resolved around it",
    );
    assertClose(
      terrainPrefillRadius(2500),
      2500,
      1e-6,
      "a mission that fits inside the cap is filled in whole",
    );
    assertClose(
      terrainPrefillRadius(50000),
      MAX_TERRAIN_RADIUS,
      1e-6,
      "and a mission that does not is filled to the cap, not to a million cells",
    );
  });

  suite("preload: the budget the sweep spends", () => {
    const light = preloadPlanFor({ missionRadius: 2000, viewDistanceKm: 60 });
    const heavy = preloadPlanFor({
      missionRadius: 2000,
      viewDistanceKm: 60,
      heavy: true,
    });

    assert(
      heavy.budgetMs > light.budgetMs,
      "photogrammetry is given longer to arrive than extruded footprints",
    );
    assert(
      light.budgetMs > light.bearings.length * 1000,
      "and every leg has a second of its own at the very least",
    );
    assert(
      heavy.budgetMs <= MAX_SWEEP_BUDGET_MS,
      "however slow the link, the pilot still reaches the flight",
    );
    assert(
      light.terrainRadius === terrainPrefillRadius(2000) &&
        light.overviewHeight === overviewHeightFor(2000, 60),
      "the plan carries the same figures the parts of it work out on their own",
    );
  });
}
