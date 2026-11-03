import { describe, expect, it } from "vitest";
import type { ProgressionRun } from "./progression";
import {
  mergeWatchRuns,
  pairWatchRuns,
  watchRunId,
  type WatchRunSample,
} from "./watch-merge";

const START = "2026-10-29T06:00:00.000Z";
const MIN_MS = 60 * 1000;

function at(offsetMs: number): string {
  return new Date(Date.parse(START) + offsetMs).toISOString();
}

type StravaRun = ProgressionRun & { name: string };

function strava(fields: Partial<StravaRun> = {}): StravaRun {
  return {
    id: 1001,
    name: "Footing du matin",
    startDate: START,
    sportType: "Run",
    distanceM: 10_000,
    movingTimeS: 3000,
    elevationGainM: 40,
    averageHeartrate: 150,
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
    elevationGainM: 52,
    averageHeartrate: 148,
    ...fields,
  };
}

const matched = (s: StravaRun, w: WatchRunSample) =>
  pairWatchRuns([s], [w]).some((p) => p.strava !== null && p.watch !== null);

describe("pairWatchRuns : tolérances", () => {
  it("rapproche à exactement 5 min d'écart de départ, pas au-delà", () => {
    expect(matched(strava(), watch({ startDate: at(5 * MIN_MS) }))).toBe(true);
    expect(matched(strava(), watch({ startDate: at(-5 * MIN_MS) }))).toBe(true);
    expect(matched(strava(), watch({ startDate: at(5 * MIN_MS + 1) }))).toBe(
      false,
    );
  });

  it("rapproche à exactement 5 % d'écart de distance (distance montre), pas au-delà", () => {
    const w = watch({ distanceM: 10_000 });
    expect(matched(strava({ distanceM: 10_500 }), w)).toBe(true);
    expect(matched(strava({ distanceM: 9500 }), w)).toBe(true);
    expect(matched(strava({ distanceM: 10_500.01 }), w)).toBe(false);
  });

  it("rapproche une sortie courte à exactement 200 m d'écart, pas au-delà", () => {
    const w = watch({ distanceM: 2000 });
    expect(matched(strava({ distanceM: 2200 }), w)).toBe(true);
    expect(matched(strava({ distanceM: 1800 }), w)).toBe(true);
    expect(matched(strava({ distanceM: 2200.01 }), w)).toBe(false);
  });

  it("exige les deux conditions : départ proche ET distance proche", () => {
    expect(matched(strava({ distanceM: 15_000 }), watch())).toBe(false);
    expect(matched(strava(), watch({ startDate: at(60 * MIN_MS) }))).toBe(
      false,
    );
  });
});

describe("pairWatchRuns : ambiguïtés", () => {
  it("retient le départ le plus proche quand deux Strava conviennent", () => {
    const far = strava({ id: 1, startDate: at(-4 * MIN_MS) });
    const near = strava({ id: 2, startDate: at(MIN_MS) });
    const pairs = pairWatchRuns([far, near], [watch()]);
    expect(pairs.find((p) => p.watch !== null)?.strava?.id).toBe(2);
    expect(pairs).toHaveLength(2);
  });

  it("utilise chaque séance une seule fois (deux montres pour une Strava)", () => {
    const first = watch({ id: 1, startDate: at(-3 * MIN_MS) });
    const second = watch({ id: 2, startDate: at(30 * 1000) });
    const pairs = pairWatchRuns([strava()], [first, second]);
    expect(pairs).toEqual([
      { strava: strava(), watch: second },
      { strava: null, watch: first },
    ]);
  });

  it("préfère la paire globalement la plus proche, pas la première dans le temps", () => {
    // W1 (0 min) et W2 (4 min 30) peuvent toutes deux prendre S1 (4 min) : W2 est plus proche.
    const s1 = strava({ id: 1, startDate: at(4 * MIN_MS) });
    const w1 = watch({ id: 1, startDate: at(0) });
    const w2 = watch({ id: 2, startDate: at(4.5 * MIN_MS) });
    const pairs = pairWatchRuns([s1], [w1, w2]);
    expect(pairs[0]).toEqual({ strava: s1, watch: w2 });
  });
});

describe("mergeWatchRuns", () => {
  it("prend les mesures de la montre, le nom, l'id et le type de Strava", () => {
    const s = strava({ sportType: "TrailRun" });
    const w = watch({ startDate: at(MIN_MS), distanceM: 10_120 });
    expect(mergeWatchRuns([s], [w])).toEqual([
      {
        id: 1001,
        name: "Footing du matin",
        sportType: "TrailRun",
        startDate: at(MIN_MS),
        distanceM: 10_120,
        movingTimeS: 2990,
        elevationGainM: 52,
        averageHeartrate: 148,
      },
    ]);
  });

  it("garde le D+ et la FC de Strava quand la montre ne les a pas", () => {
    const w = watch({ elevationGainM: null, averageHeartrate: null });
    const [run] = mergeWatchRuns([strava()], [w]);
    expect(run).toMatchObject({ elevationGainM: 40, averageHeartrate: 150 });
  });

  it("ajoute une séance montre sans Strava avec un id négatif et son type", () => {
    const w = watch({ id: 42, sportType: "TrailRun" });
    expect(mergeWatchRuns([], [w])).toEqual([{ ...w, id: -42 }]);
    expect(watchRunId(42)).toBe(-42);
  });

  it("garde une course Strava sans séance montre telle quelle", () => {
    const s = strava();
    expect(mergeWatchRuns([s], [])).toEqual([s]);
    expect(mergeWatchRuns([s], [])[0]).toBe(s);
  });

  it("ignore les séances montre qui ne sont pas des courses", () => {
    const ride = watch({ sportType: "Ride" });
    expect(mergeWatchRuns([], [ride])).toEqual([]);
    expect(mergeWatchRuns([strava()], [ride])).toEqual([strava()]);
  });

  it("ne crée pas de doublon de séance et n'a aucune collision d'id", () => {
    const runs = mergeWatchRuns(
      [
        strava({ id: 7 }),
        strava({ id: 8, startDate: at(-2 * 24 * 60 * MIN_MS) }),
      ],
      [watch({ id: 7 }), watch({ id: 9, startDate: at(24 * 60 * MIN_MS) })],
    );
    expect(runs.map((run) => run.id)).toEqual([8, 7, -9]);
  });

  it("est déterministe quel que soit l'ordre des listes", () => {
    const stravaRuns = [
      strava({ id: 1, startDate: at(-MIN_MS) }),
      strava({ id: 2, startDate: at(MIN_MS) }),
      strava({ id: 3, startDate: at(3 * 24 * 60 * MIN_MS) }),
    ];
    const watchRuns = [
      watch({ id: 1, startDate: at(0) }),
      watch({ id: 2, startDate: at(2 * MIN_MS) }),
      watch({ id: 3, startDate: at(5 * 24 * 60 * MIN_MS) }),
    ];
    const once = mergeWatchRuns(stravaRuns, watchRuns);
    const reversed = mergeWatchRuns(
      [...stravaRuns].reverse(),
      [...watchRuns].reverse(),
    );
    expect(reversed).toEqual(once);
    expect(once.map((run) => run.id)).toEqual([1, 2, 3, -3]);
  });
});
