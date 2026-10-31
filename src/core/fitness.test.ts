import { describe, expect, it } from "vitest";
import {
  estimateFitness,
  FITNESS_WINDOW_DAYS,
  MAX_DISTANCE_M,
  MAX_DURATION_S,
  MAX_VDOT,
  mergeRuns,
  MIN_DISTANCE_M,
  MIN_DURATION_S,
  runVdot,
  SLOWEST_PACE_S_PER_KM,
  type RunSample,
} from "./fitness";
import { vdot } from "./paces";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

let nextId = 1;
function run(changes: Partial<RunSample> = {}): RunSample {
  return {
    id: nextId++,
    startDate: daysAgo(3),
    sportType: "Run",
    distanceM: 10000,
    movingTimeS: 3000,
    ...changes,
  };
}

// Footings : 10 km à 6:00/km, 8 km à 6:15/km, 12 km à 6:10/km.
const easyRuns = [
  run({ distanceM: 10000, movingTimeS: 3600, startDate: daysAgo(2) }),
  run({ distanceM: 8000, movingTimeS: 3000, startDate: daysAgo(5) }),
  run({ distanceM: 12000, movingTimeS: 4440, startDate: daysAgo(9) }),
];

describe("estimateFitness", () => {
  it("renvoie null sans course", () => {
    expect(estimateFitness([], NOW)).toBeNull();
  });

  it("avec des footings seuls, retient le meilleur VDOT", () => {
    const fitness = estimateFitness(easyRuns, NOW);
    const scores = easyRuns.map((r) => vdot(r.distanceM, r.movingTimeS));

    expect(fitness?.vdot).toBe(Math.max(...scores));
    expect(fitness?.run).toBe(easyRuns[0]);
  });

  it("retient la course rapide parmi des footings", () => {
    const race = run({
      distanceM: 10000,
      movingTimeS: 2910,
      startDate: daysAgo(20),
    });
    const fitness = estimateFitness([...easyRuns, race], NOW);

    expect(fitness).toEqual({ vdot: vdot(10000, 2910), run: race });
  });

  it("à VDOT égal, retient la plus récente, puis l'id le plus grand", () => {
    const older = run({ id: 10, startDate: daysAgo(10) });
    const recent = run({ id: 5, startDate: daysAgo(4) });
    const twin = run({ id: 7, startDate: daysAgo(4) });

    expect(estimateFitness([older, recent], NOW)?.run).toBe(recent);
    expect(estimateFitness([recent, older], NOW)?.run).toBe(recent);
    expect(estimateFitness([twin, recent], NOW)?.run).toBe(twin);
    expect(estimateFitness([recent, twin], NOW)?.run).toBe(twin);
  });

  it("est déterministe et ne modifie pas l'entrée", () => {
    const runs = Object.freeze([...easyRuns]);
    expect(estimateFitness(runs, NOW)).toEqual(estimateFitness(runs, NOW));
    expect(runs).toEqual(easyRuns);
  });

  it("ignore une course plus rapide mais inexploitable", () => {
    const bike = run({ sportType: "Ride", movingTimeS: 1200 });
    expect(estimateFitness([...easyRuns, bike], NOW)?.run).toBe(easyRuns[0]);
  });

  it("renvoie null quand aucune course n'est exploitable", () => {
    expect(
      estimateFitness(
        [run({ distanceM: 2000 }), run({ sportType: "Walk" })],
        NOW,
      ),
    ).toBeNull();
  });
});

describe("runVdot : période de 8 semaines", () => {
  it("fixe la période à 56 jours", () => {
    expect(FITNESS_WINDOW_DAYS).toBe(56);
  });

  it("prend une course partie il y a 56 jours pile", () => {
    expect(runVdot(run({ startDate: daysAgo(56) }), NOW)).not.toBeNull();
  });

  it("ignore une course partie 1 ms avant la période", () => {
    const startDate = new Date(NOW - 56 * DAY_MS - 1).toISOString();
    expect(runVdot(run({ startDate }), NOW)).toBeNull();
  });

  it("prend une course partie maintenant, ignore une course future", () => {
    expect(runVdot(run({ startDate: daysAgo(0) }), NOW)).not.toBeNull();
    const future = new Date(NOW + 1000).toISOString();
    expect(runVdot(run({ startDate: future }), NOW)).toBeNull();
  });

  it("ignore une date illisible", () => {
    expect(runVdot(run({ startDate: "hier" }), NOW)).toBeNull();
  });
});

describe("runVdot : seuils d'exploitabilité", () => {
  it("fixe les seuils", () => {
    expect([MIN_DISTANCE_M, MAX_DISTANCE_M]).toEqual([3000, 43000]);
    expect([MIN_DURATION_S, MAX_DURATION_S]).toEqual([480, 21600]);
    expect(SLOWEST_PACE_S_PER_KM).toBe(900);
    expect(MAX_VDOT).toBe(85);
  });

  it.each(["Run", "TrailRun", "VirtualRun"])(
    "prend le sport %s",
    (sportType) => {
      expect(runVdot(run({ sportType }), NOW)).not.toBeNull();
    },
  );

  it.each(["Ride", "Walk", "Hike", ""])("ignore le sport %j", (sportType) => {
    expect(runVdot(run({ sportType }), NOW)).toBeNull();
  });

  it("borne la distance à [3 km, 43 km]", () => {
    const at = (distanceM: number, movingTimeS: number) =>
      runVdot(run({ distanceM, movingTimeS }), NOW);
    expect(at(3000, 900)).not.toBeNull();
    expect(at(2999, 900)).toBeNull();
    expect(at(43000, 15000)).not.toBeNull();
    expect(at(43001, 15000)).toBeNull();
  });

  it("borne la durée à [8 min, 6 h]", () => {
    const at = (distanceM: number, movingTimeS: number) =>
      runVdot(run({ distanceM, movingTimeS }), NOW);
    expect(at(3000, 480)).not.toBeNull(); // 2:40/km, VDOT ≈ 76
    expect(at(3000, 479)).toBeNull();
    expect(at(42195, 21600)).not.toBeNull();
    expect(at(42195, 21601)).toBeNull();
  });

  it("ignore une allure plus lente que 15 min/km", () => {
    expect(
      runVdot(run({ distanceM: 10000, movingTimeS: 9000 }), NOW),
    ).not.toBeNull();
    expect(
      runVdot(run({ distanceM: 10000, movingTimeS: 9001 }), NOW),
    ).toBeNull();
  });

  it("ignore une allure plus rapide que les records du monde (VDOT > 85)", () => {
    // Record du monde du 10 km (26:11) : VDOT ≈ 85,5.
    expect(
      runVdot(run({ distanceM: 10000, movingTimeS: 1571 }), NOW),
    ).toBeNull();
    expect(
      runVdot(run({ distanceM: 10000, movingTimeS: 1590 }), NOW),
    ).not.toBeNull();
  });

  it("ignore des valeurs non finies", () => {
    expect(runVdot(run({ distanceM: Number.NaN }), NOW)).toBeNull();
    expect(runVdot(run({ movingTimeS: Number.NaN }), NOW)).toBeNull();
  });
});

describe("mergeRuns", () => {
  it("fusionne par id, la version API l'emporte", () => {
    const imported = [run({ id: 100, movingTimeS: 3100 }), run({ id: 101 })];
    const api = [run({ id: 100, movingTimeS: 2900 }), run({ id: 102 })];

    expect(mergeRuns(imported, api)).toEqual([api[0], imported[1], api[1]]);
  });
});
