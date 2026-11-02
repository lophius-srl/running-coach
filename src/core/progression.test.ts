import { describe, expect, it } from "vitest";
import { estimateFitness } from "./fitness";
import {
  addMonths,
  bucketStart,
  buildProgression,
  isGrouping,
  isHistoryStale,
  isPeriod,
  progressionStartMs,
  zoneClock,
  type ProgressionRun,
} from "./progression";

const PARIS = "Europe/Paris";
let nextId = 1;

function run(
  startDate: string,
  overrides: Partial<ProgressionRun> = {},
): ProgressionRun {
  return {
    id: nextId++,
    startDate,
    sportType: "Run",
    distanceM: 10_000,
    movingTimeS: 3000,
    elevationGainM: null,
    averageHeartrate: null,
    ...overrides,
  };
}

const at = (iso: string) => Date.parse(iso);

describe("calendrier", () => {
  it.each([
    ["2026-11-02", "2026-11-02"], // lundi
    ["2026-11-08", "2026-11-02"], // dimanche
    ["2027-01-01", "2026-12-28"], // semaine à cheval sur deux années
    ["2026-10-01", "2026-09-28"], // semaine à cheval sur deux mois
  ])("le lundi de la semaine du %s est le %s", (day, monday) => {
    expect(bucketStart(day, "week")).toBe(monday);
  });

  it("ramène au 1er du mois et avance de mois en mois", () => {
    expect(bucketStart("2026-02-28", "month")).toBe("2026-02-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -2)).toBe("2025-11-01");
  });

  it("donne la date et le minuit locaux de Paris, heure d'été comprise", () => {
    const clock = zoneClock(PARIS);
    expect(clock.localDate(at("2026-11-01T23:30:00Z"))).toBe("2026-11-02");
    expect(clock.midnightMs("2026-07-01")).toBe(at("2026-06-30T22:00:00Z"));
    expect(clock.midnightMs("2026-12-01")).toBe(at("2026-11-30T23:00:00Z"));
  });
});

describe("paramètres", () => {
  it("valide période et regroupement", () => {
    expect(isPeriod("3m")).toBe(true);
    expect(isPeriod("2y")).toBe(false);
    expect(isGrouping("month")).toBe(true);
    expect(isGrouping("day")).toBe(false);
  });

  it("commence 13 semaines ou 3 mois avant, période en cours comprise", () => {
    const now = at("2026-11-04T12:00:00Z");
    expect(progressionStartMs("3m", "week", now, PARIS)).toBe(
      at("2026-08-09T22:00:00Z"), // lundi 10 août, heure d'été
    );
    expect(progressionStartMs("3m", "month", now, PARIS)).toBe(
      at("2026-08-31T22:00:00Z"),
    );
    expect(progressionStartMs("all", "week", now, PARIS)).toBeNull();
  });
});

describe("isHistoryStale", () => {
  const now = at("2026-11-02T12:00:00Z");
  it("signale un historique absent ou arrêté il y a plus de 7 jours", () => {
    expect(isHistoryStale(null, now)).toBe(true);
    expect(isHistoryStale("2026-10-20T07:00:00Z", now)).toBe(true);
    expect(isHistoryStale("2026-10-30T07:00:00Z", now)).toBe(false);
  });
});

describe("buildProgression", () => {
  const now = at("2026-11-04T12:00:00Z"); // mercredi

  it("remplit les semaines vides à 0 et laisse allure, FC et niveau à null", () => {
    const buckets = buildProgression([], "3m", "week", now, PARIS);
    expect(buckets).toHaveLength(13);
    expect(buckets[0].start).toBe("2026-08-10");
    expect(buckets[12].start).toBe("2026-11-02");
    expect(buckets[12]).toEqual({
      start: "2026-11-02",
      count: 0,
      distanceM: 0,
      movingTimeS: 0,
      elevationGainM: 0,
      longestM: 0,
      paceSPerKm: null,
      heartrate: null,
      vdot: null,
    });
  });

  it("range une course du dimanche soir selon l'heure de Paris", () => {
    // Dimanche 1er nov. 23:30 à Paris = 22:30 UTC : semaine du 26 oct.
    // Lundi 2 nov. 00:30 à Paris = dimanche 23:30 UTC : semaine du 2 nov.
    const runs = [
      run("2026-11-01T22:30:00Z", { distanceM: 5000, movingTimeS: 1500 }),
      run("2026-11-01T23:30:00Z", { distanceM: 8000, movingTimeS: 2400 }),
    ];
    const buckets = buildProgression(runs, "3m", "week", now, PARIS);
    expect(buckets.at(-2)).toMatchObject({
      start: "2026-10-26",
      distanceM: 5000,
    });
    expect(buckets.at(-1)).toMatchObject({
      start: "2026-11-02",
      distanceM: 8000,
    });
  });

  it("répartit une semaine à cheval sur deux mois selon le jour, par mois", () => {
    const runs = [run("2026-09-30T07:00:00Z"), run("2026-10-02T07:00:00Z")];
    const weeks = buildProgression(runs, "3m", "week", now, PARIS);
    expect(weeks.find((b) => b.start === "2026-09-28")?.count).toBe(2);
    const months = buildProgression(runs, "3m", "month", now, PARIS);
    expect(months.map((b) => [b.start, b.count])).toEqual([
      ["2026-09-01", 1],
      ["2026-10-01", 1],
      ["2026-11-01", 0],
    ]);
  });

  it("passe le changement d'année", () => {
    const janNow = at("2027-01-06T12:00:00Z");
    const runs = [run("2026-12-31T08:00:00Z"), run("2027-01-01T08:00:00Z")];
    const weeks = buildProgression(runs, "3m", "week", janNow, PARIS);
    expect(weeks.at(-2)).toMatchObject({ start: "2026-12-28", count: 2 });
    expect(weeks.at(-1)?.start).toBe("2027-01-04");
    const months = buildProgression(runs, "3m", "month", janNow, PARIS);
    expect(months.map((b) => b.start)).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ]);
  });

  it("pondère l'allure par la distance et la FC par le temps", () => {
    const runs = [
      // 4:00/km sur 5 km et 6:00/km sur 15 km → 110 min / 20 km = 5:30/km
      run("2026-11-02T07:00:00Z", {
        distanceM: 5000,
        movingTimeS: 1200,
        averageHeartrate: 170,
        elevationGainM: 40,
      }),
      run("2026-11-03T07:00:00Z", {
        distanceM: 15_000,
        movingTimeS: 5400,
        averageHeartrate: 140,
        elevationGainM: null,
      }),
      run("2026-11-04T07:00:00Z", { distanceM: 3000, movingTimeS: 900 }),
    ];
    const last = buildProgression(runs.slice(0, 2), "3m", "week", now, PARIS);
    expect(last.at(-1)).toMatchObject({
      count: 2,
      distanceM: 20_000,
      movingTimeS: 6600,
      elevationGainM: 40,
      longestM: 15_000,
      paceSPerKm: 330,
      heartrate: Math.round((170 * 1200 + 140 * 5400) / 6600),
    });
    // Une sortie sans FC ne pèse pas dans la FC moyenne.
    const all = buildProgression(runs, "3m", "week", now, PARIS);
    expect(all.at(-1)?.heartrate).toBe(last.at(-1)?.heartrate);
  });

  it("ignore les activités qui ne sont pas de la course à pied", () => {
    const runs = [
      run("2026-11-02T07:00:00Z", { sportType: "Ride", distanceM: 40_000 }),
    ];
    expect(buildProgression(runs, "3m", "week", now, PARIS).at(-1)?.count).toBe(
      0,
    );
  });

  it("borne « tout » à la première course et renvoie [] sans course", () => {
    const runs = [run("2026-10-14T07:00:00Z"), run("2026-09-09T07:00:00Z")];
    const buckets = buildProgression(runs, "all", "week", now, PARIS);
    expect(buckets[0].start).toBe("2026-09-07");
    expect(buckets.at(-1)?.start).toBe("2026-11-02");
    expect(buildProgression([], "all", "month", now, PARIS)).toEqual([]);
  });

  it("donne le niveau glissant d'estimateFitness à chaque fin de période", () => {
    const runs = [
      run("2026-06-01T07:00:00Z", { distanceM: 10_000, movingTimeS: 2400 }),
      run("2026-07-20T07:00:00Z", { distanceM: 10_000, movingTimeS: 2700 }),
      run("2026-10-01T07:00:00Z", { distanceM: 5000, movingTimeS: 1300 }),
      run("2026-10-10T07:00:00Z", { distanceM: 10_000, movingTimeS: 2900 }),
    ];
    const buckets = buildProgression(runs, "6m", "week", now, PARIS);
    const clock = zoneClock(PARIS);
    buckets.forEach((bucket, i) => {
      const next = buckets[i + 1]?.start;
      const end = next ? clock.midnightMs(next) - 1 : now;
      const expected = estimateFitness(runs, end)?.vdot ?? null;
      expect(bucket.vdot).toBe(
        expected === null ? null : Math.round(expected * 10) / 10,
      );
    });
    // La course du 1er juin compte encore 8 semaines plus tard, plus après.
    expect(buckets.some((b) => b.vdot === null)).toBe(true);
  });

  // Temps CPU mesuré sous Node (performance.now est figé dans workerd) : ≈ 3 ms par appel sur
  // 10 ans en hebdomadaire, ≈ 10 ms au tout premier appel non optimisé.
  it("agrège plusieurs années d'historique (≈ 2 000 courses)", () => {
    const runs = Array.from({ length: 2000 }, (_, i) =>
      run(new Date(now - i * 1.6 * 24 * 3600 * 1000).toISOString(), {
        distanceM: 5000 + (i % 15) * 1000,
        movingTimeS: (5000 + (i % 15) * 1000) * (0.27 + (i % 7) * 0.01),
        averageHeartrate: 140 + (i % 20),
        elevationGainM: i % 50,
      }),
    );
    const buckets = buildProgression(runs, "all", "week", now, PARIS);
    expect(buckets.length).toBeGreaterThan(450);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(2000);
  });
});
