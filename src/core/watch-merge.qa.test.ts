// QA de l'issue #69 : cas limites de la fusion montre ↔ Strava (src/core/watch-merge).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSample } from "./fitness";
import {
  mergeWatchRuns,
  pairWatchRuns,
  type WatchRunSample,
} from "./watch-merge";

const START = "2026-10-29T06:00:00.000Z";
const SEC_MS = 1000;
const MIN_MS = 60 * SEC_MS;
const DAY_MS = 24 * 60 * MIN_MS;

const at = (offsetMs: number) =>
  new Date(Date.parse(START) + offsetMs).toISOString();

function strava(fields: Partial<RunSample> = {}): RunSample {
  return {
    id: 1001,
    startDate: START,
    sportType: "Run",
    distanceM: 10_000,
    movingTimeS: 3000,
    ...fields,
  };
}

function watch(fields: Partial<WatchRunSample> = {}): WatchRunSample {
  return {
    id: 7,
    startDate: START,
    sportType: "Run",
    distanceM: 10_000,
    movingTimeS: 2990,
    elevationGainM: null,
    averageHeartrate: null,
    ...fields,
  };
}

const isMatched = (s: RunSample, w: WatchRunSample) =>
  mergeWatchRuns([s], [w]).length === 1;

afterEach(() => vi.restoreAllMocks());

describe("mergeWatchRuns : bornes du départ", () => {
  it("fusionne à 5 min pile d'écart", () => {
    expect(isMatched(strava(), watch({ startDate: at(5 * MIN_MS) }))).toBe(
      true,
    );
  });

  it("ne fusionne pas à 5 min + 1 s d'écart, dans un sens comme dans l'autre", () => {
    const gap = 5 * MIN_MS + SEC_MS;
    expect(isMatched(strava(), watch({ startDate: at(gap) }))).toBe(false);
    expect(isMatched(strava(), watch({ startDate: at(-gap) }))).toBe(false);
  });

  it("compare des instants, pas des chaînes (« Z » contre « .000Z » et décalage horaire)", () => {
    const s = strava({ startDate: "2026-10-29T06:00:00Z" });
    expect(isMatched(s, watch({ startDate: "2026-10-29T06:04:59.000Z" }))).toBe(
      true,
    );
    expect(
      isMatched(s, watch({ startDate: "2026-10-29T07:03:00+01:00" })),
    ).toBe(true);
  });

  it("ne fusionne pas une séance montre datée à l'heure locale (1 h d'écart avec l'UTC Strava)", () => {
    expect(isMatched(strava(), watch({ startDate: at(60 * MIN_MS) }))).toBe(
      false,
    );
  });
});

describe("mergeWatchRuns : bornes de la distance", () => {
  it("fusionne à 5 % pile d'une longue sortie (500 m sur 10 km)", () => {
    expect(isMatched(strava({ distanceM: 9500 }), watch())).toBe(true);
  });

  it("ne fusionne pas juste au-delà de 5 % d'une longue sortie", () => {
    expect(isMatched(strava({ distanceM: 9499 }), watch())).toBe(false);
  });

  it("fusionne à 200 m pile d'une courte sortie (où 5 % ne font que 100 m)", () => {
    const w = watch({ distanceM: 2000 });
    expect(isMatched(strava({ distanceM: 2200 }), w)).toBe(true);
    expect(isMatched(strava({ distanceM: 2201 }), w)).toBe(false);
  });

  it("fusionne une séance montre à 0 m avec une sortie Strava de 200 m au plus", () => {
    const w = watch({ distanceM: 0 });
    expect(isMatched(strava({ distanceM: 200 }), w)).toBe(true);
    expect(isMatched(strava({ distanceM: 0 }), w)).toBe(true);
  });

  it("ne fusionne pas une séance montre à 0 m avec une vraie sortie Strava", () => {
    expect(
      isMatched(strava({ distanceM: 5000 }), watch({ distanceM: 0 })),
    ).toBe(false);
  });

  it("garde une séance montre à 0 m sans Strava, avec un id négatif", () => {
    const merged = mergeWatchRuns([], [watch({ id: 3, distanceM: 0 })]);
    expect(merged).toEqual([expect.objectContaining({ id: -3, distanceM: 0 })]);
  });
});

describe("mergeWatchRuns : ambiguïtés", () => {
  it("une Strava pour deux montres : la plus proche est fusionnée, l'autre reste seule", () => {
    const merged = mergeWatchRuns(
      [strava()],
      [
        watch({ id: 1, startDate: at(-2 * MIN_MS), distanceM: 10_100 }),
        watch({ id: 2, startDate: at(MIN_MS), distanceM: 10_200 }),
      ],
    );
    expect(merged.map((run) => [run.id, run.distanceM])).toEqual([
      [1001, 10_200],
      [-1, 10_100],
    ]);
  });

  it("deux Strava pour une montre : la plus proche prend les mesures, l'autre reste intacte", () => {
    const far = strava({ id: 1, startDate: at(3 * MIN_MS), distanceM: 9900 });
    const near = strava({ id: 2, startDate: at(-MIN_MS), distanceM: 9800 });
    const merged = mergeWatchRuns([far, near], [watch()]);
    expect(merged).toHaveLength(2);
    expect(merged.find((run) => run.id === 2)?.distanceM).toBe(10_000);
    expect(merged.find((run) => run.id === 1)).toBe(far);
  });

  it("à écart égal, départage de façon déterministe (le départ le plus tôt)", () => {
    const before = strava({ id: 20, startDate: at(-2 * MIN_MS) });
    const after = strava({ id: 10, startDate: at(2 * MIN_MS) });
    for (const list of [
      [before, after],
      [after, before],
    ]) {
      const pairs = pairWatchRuns(list, [watch()]);
      expect(pairs.find((pair) => pair.watch !== null)?.strava?.id).toBe(20);
    }
  });

  it("n'utilise jamais une séance deux fois sur une série de sorties rapprochées", () => {
    // Fractionné découpé en 4 activités Strava de 1 km toutes les 2 min, 4 séances montre.
    const stravaRuns = [0, 1, 2, 3].map((n) =>
      strava({ id: 100 + n, startDate: at(n * 2 * MIN_MS), distanceM: 1000 }),
    );
    const watchRuns = [0, 1, 2, 3].map((n) =>
      watch({
        id: n + 1,
        startDate: at(n * 2 * MIN_MS + SEC_MS),
        distanceM: 1000,
      }),
    );
    const pairs = pairWatchRuns(stravaRuns, watchRuns);
    expect(pairs).toHaveLength(4);
    expect(pairs.map((pair) => [pair.strava?.id, pair.watch?.id])).toEqual([
      [100, 1],
      [101, 2],
      [102, 3],
      [103, 4],
    ]);
  });
});

describe("mergeWatchRuns : coût linéaire (2 000 sorties CSV, 500 séances montre)", () => {
  // Compte les lectures de distance : une par paire examinée (+ une par fusion, recopie).
  function counted<T extends object>(run: T, reads: { n: number }): T {
    return new Proxy(run, {
      get(target, prop, receiver) {
        if (prop === "distanceM") reads.n += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  }

  function dataset(reads: { n: number }) {
    // Une sortie par jour pendant 2 000 jours, à la même heure.
    const stravaRuns: RunSample[] = [];
    for (let day = 0; day < 2000; day += 1) {
      stravaRuns.push(
        counted(strava({ id: day + 1, startDate: at(day * DAY_MS) }), reads),
      );
    }
    // 500 séances montre : les 400 dernières sorties (2 min après) et 100 sans Strava (6 h après).
    const watchRuns: WatchRunSample[] = [];
    for (let n = 0; n < 500; n += 1) {
      const day = n < 400 ? 1600 + n : 1500 + n;
      const offset = n < 400 ? 2 * MIN_MS : 6 * 60 * MIN_MS;
      watchRuns.push(
        counted(
          watch({ id: n + 1, startDate: at(day * DAY_MS + offset) }),
          reads,
        ),
      );
    }
    return { stravaRuns, watchRuns };
  }

  it("lit chaque date une seule fois", () => {
    const { stravaRuns, watchRuns } = dataset({ n: 0 });
    const parse = vi.spyOn(Date, "parse");
    mergeWatchRuns(stravaRuns, watchRuns);
    expect(parse).toHaveBeenCalledTimes(2500);
  });

  it("n'examine que les paires de la fenêtre de 5 min (≤ n + m lectures de distance)", () => {
    const reads = { n: 0 };
    const { stravaRuns, watchRuns } = dataset(reads);
    const merged = mergeWatchRuns(stravaRuns, watchRuns);
    expect(merged).toHaveLength(2100);
    expect(merged.filter((run) => run.id < 0)).toHaveLength(100);
    expect(reads.n).toBeLessThanOrEqual(2500);
  });
});
