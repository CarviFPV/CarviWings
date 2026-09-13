import { assert, assertClose, suite } from "./harness";
import {
  MAX_BUILDS,
  MAX_BUILD_NAME_LENGTH,
  STOCK_BUILDS,
  applyBuild,
  buildFromSettings,
  buildMatchesSettings,
  buildNameRejection,
  buildsFull,
  createBuildId,
  describeBuild,
  fittedAircraft,
  findStockBuild,
  hangarAircraft,
  isStockBuildId,
  normaliseBuildName,
  normaliseBuilds,
  resolveBuild,
  selectedBuild,
  stockBuildFor,
  stockBuildId,
} from "../flight/builds";
import type { AircraftBuild } from "../flight/builds";
import { BATTERY_UNLIMITED } from "../flight/powerplant";
import { RATE_LIMITS } from "../flight/rates";
import {
  DEFAULT_UAV_SETTINGS,
  INTERCEPTOR_WING,
  SKYWALKER_X8_UAV,
  UAVS,
  deliveredBattery,
  deliveredMotor,
  liveryFor,
  loadoutFor,
  ratesFor,
  withBattery,
  withMotor,
} from "../flight/uav";
import type { UavSettings } from "../flight/uav";

/** The bench with one aircraft set up on it, as a pilot would leave it. */
function bench(): UavSettings {
  const selected: UavSettings = {
    ...DEFAULT_UAV_SETTINGS,
    active: SKYWALKER_X8_UAV.id,
  };
  const withPack = withBattery(
    withMotor(selected, SKYWALKER_X8_UAV.id, "os5010-810-12x8"),
    SKYWALKER_X8_UAV.id,
    "4s-8000",
  );
  return {
    ...withPack,
    rates: {
      ...withPack.rates,
      [SKYWALKER_X8_UAV.id]: {
        ...SKYWALKER_X8_UAV.defaultRates,
        rollRate: 240,
      },
    },
  };
}

export function runBuildTests(): void {
  suite("a saved aircraft is the bench written down", () => {
    const settings = bench();
    const build = buildFromSettings(settings, "one", "Sport X8");

    assert(build.uav === SKYWALKER_X8_UAV.id, "it saves the airframe fitted");
    assert(build.motor === "os5010-810-12x8", "with the combo bolted to it");
    assert(build.battery === "4s-8000", "and the pack in the bay");
    assertClose(build.rates.rollRate, 240, 1e-9, "on the rates it was tuned to");
    assert(
      buildMatchesSettings(settings, build),
      "and the bench it came off is holding it",
    );

    // Anything the pilot then changes takes the selection with it, which is
    // what makes a stored selected-build identifier the wrong idea.
    const retuned: UavSettings = {
      ...settings,
      rates: {
        ...settings.rates,
        [SKYWALKER_X8_UAV.id]: {
          ...settings.rates[SKYWALKER_X8_UAV.id],
          rollRate: 241,
        },
      },
    } as UavSettings;
    assert(
      !buildMatchesSettings(retuned, build),
      "one degree a second away from it is no longer that aircraft",
    );
    assert(
      !buildMatchesSettings(
        withBattery(settings, SKYWALKER_X8_UAV.id, BATTERY_UNLIMITED),
        build,
      ),
      "and neither is the same wing flown without the pack simulated",
    );
    assert(
      !buildMatchesSettings({ ...settings, active: INTERCEPTOR_WING.id }, build),
      "nor the same setup with a different airframe on the bench",
    );
  });

  suite("fitting a saved aircraft leaves the rest of the hangar alone", () => {
    const settings = bench();
    const x8 = buildFromSettings(settings, "one", "Sport X8");

    // Somebody flies the interceptor, tunes it, and comes back to the X8.
    const interceptor: UavSettings = {
      ...settings,
      active: INTERCEPTOR_WING.id,
      rates: {
        ...settings.rates,
        [INTERCEPTOR_WING.id]: {
          ...INTERCEPTOR_WING.defaultRates,
          pitchRate: 111,
        },
      },
    };
    const refitted = applyBuild(interceptor, x8);

    assert(refitted.active === SKYWALKER_X8_UAV.id, "the build is on the bench");
    assert(
      buildMatchesSettings(refitted, x8),
      "exactly as it was saved, hardware and tune",
    );
    assertClose(
      ratesFor(refitted, INTERCEPTOR_WING.id).pitchRate,
      111,
      1e-9,
      "and the aircraft that was not named keeps its own tune",
    );
  });

  suite("the selected aircraft is whichever one the bench matches", () => {
    const settings = bench();
    const sport = buildFromSettings(settings, "one", "Sport X8");
    const mapper: AircraftBuild = {
      id: "two",
      name: "Mapper",
      uav: SKYWALKER_X8_UAV.id,
      motor: "x4250-500-12x6",
      battery: "6s-16000",
      rates: SKYWALKER_X8_UAV.defaultRates,
      livery: SKYWALKER_X8_UAV.defaultLivery,
    };
    const builds = [sport, mapper];

    assert(selectedBuild(builds, settings)?.id === "one", "the one fitted");
    assert(
      selectedBuild(builds, applyBuild(settings, mapper))?.id === "two",
      "and fitting the other one selects the other one",
    );
    assert(
      selectedBuild(builds, DEFAULT_UAV_SETTINGS) === null,
      "a bench holding nothing anybody saved selects nothing",
    );
  });

  suite("every airframe is an aircraft before anything is built", () => {
    assert(
      STOCK_BUILDS.length === UAVS.length,
      "there is one delivered aircraft for each airframe in the hangar",
    );

    for (const uav of UAVS) {
      const stock = stockBuildFor(uav.id);
      assert(
        stock.id === stockBuildId(uav.id) && isStockBuildId(stock.id),
        `${uav.id} has a stock identifier of its own`,
      );
      assert(stock.uav === uav.id, `${uav.id} names its own airframe`);
      assert(
        stock.motor === deliveredMotor(uav).id &&
          stock.battery === deliveredBattery(uav).id,
        `${uav.id} is delivered with the hardware the airframe ships with`,
      );
      assert(
        findStockBuild(stock.id)?.name === uav.config.name,
        `${uav.id} is listed under the airframe's own name`,
      );

      // The whole point: fitting it needs nothing saved and nothing built.
      const fitted = applyBuild(DEFAULT_UAV_SETTINGS, stock);
      assert(
        fitted.active === uav.id && buildMatchesSettings(fitted, stock),
        `${uav.id} can be picked and flown as delivered`,
      );
      assert(
        fittedAircraft([], fitted)?.id === stock.id,
        `${uav.id} is what the bench is holding once it is fitted`,
      );
    }

    assert(
      findStockBuild("stock:a-flying-carpet") === null,
      "and an airframe the simulator does not have is not delivered either",
    );
  });

  suite("fitting a delivered aircraft puts the airframe back as it came", () => {
    const modified = bench();
    assert(
      fittedAircraft([], modified) === null,
      "a bench nobody would recognise is holding no aircraft from the list",
    );

    const stock = stockBuildFor(SKYWALKER_X8_UAV.id);
    const refitted = applyBuild(modified, stock);

    assert(
      loadoutFor(refitted, SKYWALKER_X8_UAV.id).motor ===
        deliveredMotor(SKYWALKER_X8_UAV).id,
      "the combo it is delivered with goes back on",
    );
    assertClose(
      ratesFor(refitted, SKYWALKER_X8_UAV.id).rollRate,
      SKYWALKER_X8_UAV.defaultRates.rollRate,
      1e-9,
      "and the tune it is delivered on",
    );
    assert(
      liveryFor(refitted, SKYWALKER_X8_UAV.id).shell ===
        SKYWALKER_X8_UAV.defaultLivery.shell,
      "and the paint it is delivered in",
    );
    assert(
      fittedAircraft([], refitted)?.id === stock.id,
      "which is the delivered aircraft, selected by being what is on the bench",
    );
  });

  suite("a saved aircraft answers before the airframe it was saved from", () => {
    const delivered = applyBuild(DEFAULT_UAV_SETTINGS, stockBuildFor(INTERCEPTOR_WING.id));
    const stock = stockBuildFor(INTERCEPTOR_WING.id);
    const named = buildFromSettings(delivered, "one", "Stock, but mine");

    assert(
      fittedAircraft([], delivered)?.id === stock.id,
      "with nothing saved, the bench is holding the airframe as delivered",
    );
    assert(
      fittedAircraft([named], delivered)?.id === "one",
      "and once the pilot has named that setup, the list calls it what they do",
    );
    assert(
      selectedBuild([named], delivered)?.id === "one",
      "the saved-only lookup is unchanged by any of this",
    );
    assert(
      selectedBuild([], delivered) === null,
      "and still says nothing saved matches a delivered aircraft",
    );

    const hangar = hangarAircraft([named]);
    assert(
      hangar.length === STOCK_BUILDS.length + 1 &&
        hangar[hangar.length - 1]?.id === "one",
      "the hangar list is every airframe as delivered, then what was saved",
    );
    assert(
      !describeBuild(stock).startsWith(INTERCEPTOR_WING.config.name),
      "a delivered aircraft's line does not say the airframe's name twice",
    );
    assert(
      describeBuild(stock).includes("km/h"),
      "it says what is in it and how fast it goes instead",
    );
  });

  suite("a name is held to something a pilot can pick out of a list", () => {
    const builds: readonly AircraftBuild[] = [
      buildFromSettings(bench(), "one", "Sport X8"),
    ];

    assert(
      normaliseBuildName("  long   range \n mapper  ") === "long range mapper",
      "the typing is tidied out of a name",
    );
    assert(
      normaliseBuildName("x".repeat(80)).length === MAX_BUILD_NAME_LENGTH,
      "and a name is only ever as long as the list can show",
    );
    assert(
      buildNameRejection("A", builds) !== null,
      "a single letter is not a name",
    );
    assert(
      buildNameRejection("sport x8", builds) !== null,
      "and a name already in the list is refused, whatever its case",
    );
    assert(
      buildNameRejection("sport x8", builds, "one") === null,
      "except to the aircraft that already holds it, which is a rename",
    );
    assert(buildNameRejection("Mapper", builds) === null, "a fresh name is fine");
    assert(
      buildNameRejection(INTERCEPTOR_WING.config.name, builds) !== null,
      "an airframe's own name belongs to the aircraft as delivered",
    );
    assert(
      buildNameRejection(
        INTERCEPTOR_WING.config.name.toLocaleUpperCase(),
        builds,
        "one",
      ) !== null,
      "which a rename cannot take either, whatever its case",
    );
    assert(!buildsFull(builds), "and one aircraft is not a full hangar");
    assert(
      buildsFull(new Array(MAX_BUILDS).fill(builds[0] as AircraftBuild)),
      "which is what a full one is",
    );
  });

  suite("identifiers are unique, even when the random source is not", () => {
    const taken = ["aaaaaaaaaa"];
    assert(
      createBuildId([], () => 0) === "aaaaaaaaaa",
      "the alphabet is drawn from as given",
    );
    assert(
      createBuildId(taken, () => 0) === "build-1",
      "and a source that keeps drawing the same identifier still produces a new one",
    );
    assert(
      createBuildId([], Math.random) !== createBuildId([], Math.random),
      "two draws from a real source are two identifiers",
    );
  });

  suite("saved aircraft are repaired on the way out of storage", () => {
    const builds = normaliseBuilds([
      // Sound, and kept.
      {
        id: "keep",
        name: "  Mapper  ",
        uav: SKYWALKER_X8_UAV.id,
        motor: "x4250-500-12x6",
        battery: "6s-16000",
        rates: { rollRate: 9000, pitchRate: 85, rollExpo: 0.2, pitchExpo: 0.25 },
      },
      // Hardware nobody sells any more: repaired to what it is delivered with.
      {
        id: "hardware",
        name: "Antique",
        uav: INTERCEPTOR_WING.id,
        motor: "a-motor-that-was-discontinued",
        battery: "a-pack-that-melted",
      },
      // Range simulation switched off, which is a setting and not a fault.
      {
        id: "unlimited",
        name: "Endless",
        uav: INTERCEPTOR_WING.id,
        motor: "x2820-920-9x5",
        battery: BATTERY_UNLIMITED,
      },
      // Dropped: an airframe this build of the simulator does not have.
      { id: "gone", name: "Carpet", uav: "a-flying-carpet" },
      // Dropped: nothing anybody could pick out of a list.
      { id: "nameless", uav: INTERCEPTOR_WING.id },
      // Dropped: a second aircraft under an identifier already in use.
      { id: "keep", name: "Impostor", uav: INTERCEPTOR_WING.id },
      // Dropped: an aircraft claiming to be an airframe as delivered, which
      // would hide the one the hangar derives rather than adding anything.
      {
        id: stockBuildId(INTERCEPTOR_WING.id),
        name: "Shadow",
        uav: INTERCEPTOR_WING.id,
      },
      "not an aircraft at all",
    ]);

    assert(builds.length === 3, "only the aircraft that are aircraft survive");
    const kept = builds[0] as AircraftBuild;
    assert(kept.name === "Mapper", "a name comes back tidied");
    assertClose(
      kept.rates.rollRate,
      RATE_LIMITS.rate.max,
      1e-9,
      "an absurd rate is clamped rather than flown",
    );

    const antique = builds[1] as AircraftBuild;
    assert(
      antique.motor === deliveredMotor(INTERCEPTOR_WING).id,
      "hardware that no longer exists falls back to what the airframe is delivered with",
    );
    assert(
      antique.battery === deliveredBattery(INTERCEPTOR_WING).id,
      "and so does the pack",
    );

    assert(
      (builds[2] as AircraftBuild).battery === BATTERY_UNLIMITED,
      "flying without a pack simulated is kept, because it was chosen",
    );

    assert(
      normaliseBuilds(undefined).length === 0,
      "nothing at all is no saved aircraft rather than a failure",
    );
    assert(
      normaliseBuilds(
        new Array(MAX_BUILDS + 4).fill(null).map((_, index) => ({
          id: `build-${index}`,
          name: `Wing ${index}`,
          uav: INTERCEPTOR_WING.id,
        })),
      ).length === MAX_BUILDS,
      "and a storage block holding more than the hangar does is cut to it",
    );
  });

  suite("a saved aircraft flies the airframe the hardware makes it", () => {
    const settings = bench();
    const sport = buildFromSettings(settings, "one", "Sport X8");
    const heavy: AircraftBuild = {
      ...sport,
      id: "two",
      name: "Mapper",
      motor: "x4250-500-12x6",
      battery: "6s-16000",
    };

    const sportLoadout = resolveBuild(sport);
    const heavyLoadout = resolveBuild(heavy);

    assert(
      heavyLoadout.config.mass > sportLoadout.config.mass,
      "the bigger pack is carried rather than quoted",
    );
    assertClose(
      sportLoadout.config.mass,
      resolveBuild(sport).config.mass,
      1e-9,
      "and fitting the same build twice gives the same aircraft",
    );
    assert(
      describeBuild(sport).includes(SKYWALKER_X8_UAV.config.name),
      "the line under the name says which airframe it is",
    );
    assert(
      loadoutFor(applyBuild(DEFAULT_UAV_SETTINGS, heavy), heavy.uav).battery ===
        "6s-16000",
      "and fitting it puts that pack in the bay",
    );
  });
}
