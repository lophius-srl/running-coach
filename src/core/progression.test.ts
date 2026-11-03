import { describe, expect, it, vi } from "vitest";
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

describe("zoneClock : format Intl inattendu", () => {
  function withFormat(text: string) {
    const fake = { format: () => text } as unknown as Intl.DateTimeFormat;
    return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      return fake;
    } as unknown as typeof Intl.DateTimeFormat);
  }

  it.each(["11/02/2026, 00:30", "2026-11-02 00:30", "2026-11-02, 24h"])(
    "lève une erreur explicite pour « %s »",
    (text) => {
      const spy = withFormat(text);
      try {
        const clock = zoneClock(PARIS);
        expect(() => clock.localDate(0)).toThrow(
          /Format de date Intl inattendu/,
        );
        expect(() => clock.midnightMs("2026-11-02")).toThrow(
          /Format de date Intl inattendu/,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("lève une erreur explicite pour une date impossible", () => {
    const spy = withFormat("2026-13-45, 00:30");
    try {
      expect(() => zoneClock(PARIS).midnightMs("2026-11-02")).toThrow(
        /Date Intl illisible/,
      );
    } finally {
      spy.mockRestore();
    }
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

// --- QA #61 : cas limites de calendrier, de fuseau et de fenêtre glissante ---

function weekOf(
  buckets: ReturnType<typeof buildProgression>,
  start: string,
): number | undefined {
  return buckets.find((b) => b.start === start)?.count;
}

describe("heure d'été et d'hiver (Paris)", () => {
  it("la semaine du passage à l'heure d'hiver (19 oct. 2026) dure 7 × 24 h + 1 h", () => {
    const clock = zoneClock(PARIS);
    const hours =
      (clock.midnightMs("2026-10-26") - clock.midnightMs("2026-10-19")) /
      3_600_000;
    expect(hours).toBe(7 * 24 + 1);
  });

  it("la semaine du 26 oct. 2026, entièrement en heure d'hiver, dure 7 × 24 h", () => {
    const clock = zoneClock(PARIS);
    const hours =
      (clock.midnightMs("2026-11-02") - clock.midnightMs("2026-10-26")) /
      3_600_000;
    expect(hours).toBe(7 * 24);
  });

  it("la semaine du passage à l'heure d'été (22 mars 2027) dure 7 × 24 h − 1 h", () => {
    const clock = zoneClock(PARIS);
    const hours =
      (clock.midnightMs("2027-03-29") - clock.midnightMs("2027-03-22")) /
      3_600_000;
    expect(hours).toBe(7 * 24 - 1);
  });

  it("range aux bonnes semaines les courses autour du passage à l'heure d'hiver", () => {
    const now = at("2026-11-04T12:00:00Z");
    const runs = [
      run("2026-10-18T21:59:59Z"), // dim. 18 oct. 23:59:59 CEST → semaine du 12
      run("2026-10-18T22:00:00Z"), // lun. 19 oct. 00:00 CEST → semaine du 19
      run("2026-10-25T22:59:59Z"), // dim. 25 oct. 23:59:59 CET → semaine du 19
      run("2026-10-25T23:00:00Z"), // lun. 26 oct. 00:00 CET → semaine du 26
    ];
    const buckets = buildProgression(runs, "3m", "week", now, PARIS);
    expect(weekOf(buckets, "2026-10-12")).toBe(1);
    expect(weekOf(buckets, "2026-10-19")).toBe(2);
    expect(weekOf(buckets, "2026-10-26")).toBe(1);
  });

  it("range aux bonnes semaines les courses autour du passage à l'heure d'été", () => {
    const now = at("2027-04-07T12:00:00Z");
    const runs = [
      run("2027-03-21T22:59:59Z"), // dim. 21 mars 23:59:59 CET → semaine du 15
      run("2027-03-21T23:00:00Z"), // lun. 22 mars 00:00 CET → semaine du 22
      run("2027-03-28T21:30:00Z"), // dim. 28 mars 23:30 CEST → semaine du 22
      run("2027-03-28T22:00:00Z"), // lun. 29 mars 00:00 CEST → semaine du 29
    ];
    const buckets = buildProgression(runs, "3m", "week", now, PARIS);
    expect(weekOf(buckets, "2027-03-15")).toBe(1);
    expect(weekOf(buckets, "2027-03-22")).toBe(2);
    expect(weekOf(buckets, "2027-03-29")).toBe(1);
  });

  it("range une course du dimanche 23:30 l'hiver (22:30 UTC) dans la semaine qui finit", () => {
    const now = at("2026-12-09T12:00:00Z");
    const runs = [run("2026-12-06T22:30:00Z")]; // dim. 6 déc. 23:30 CET
    const buckets = buildProgression(runs, "3m", "week", now, PARIS);
    expect(weekOf(buckets, "2026-11-30")).toBe(1);
    expect(weekOf(buckets, "2026-12-07")).toBe(0);
  });
});

describe("bornes de mois et d'année (Paris)", () => {
  it("compte au 1er janvier une course du 1er janvier 00:30 à Paris (31 déc. UTC)", () => {
    const now = at("2027-01-20T12:00:00Z");
    const runs = [
      run("2026-12-31T22:59:59Z"), // 31 déc. 23:59:59 Paris
      run("2026-12-31T23:30:00Z"), // 1er janv. 00:30 Paris
    ];
    const months = buildProgression(runs, "3m", "month", now, PARIS);
    expect(months.map((b) => [b.start, b.count])).toEqual([
      ["2026-11-01", 0],
      ["2026-12-01", 1],
      ["2027-01-01", 1],
    ]);
    const weeks = buildProgression(runs, "3m", "week", now, PARIS);
    expect(weekOf(weeks, "2026-12-28")).toBe(2);
  });

  it("borne février à 28 jours", () => {
    const now = at("2027-03-10T12:00:00Z");
    const runs = [
      run("2027-02-28T22:59:00Z"), // 28 fév. 23:59 Paris
      run("2027-02-28T23:00:00Z"), // 1er mars 00:00 Paris
    ];
    const months = buildProgression(runs, "3m", "month", now, PARIS);
    expect(months.map((b) => [b.start, b.count])).toEqual([
      ["2027-01-01", 0],
      ["2027-02-01", 1],
      ["2027-03-01", 1],
    ]);
  });

  it("compte le 29 février d'une année bissextile en février", () => {
    const now = at("2028-03-10T12:00:00Z");
    const runs = [run("2028-02-29T12:00:00Z")];
    const months = buildProgression(runs, "3m", "month", now, PARIS);
    expect(months.find((b) => b.start === "2028-02-01")?.count).toBe(1);
    expect(months.find((b) => b.start === "2028-03-01")?.count).toBe(0);
  });

  it("ouvre le nouveau mois dès minuit à Paris, même si UTC est encore la veille", () => {
    const now = at("2026-11-30T23:30:00Z"); // 1er déc. 00:30 Paris
    const months = buildProgression([], "3m", "month", now, PARIS);
    expect(months.map((b) => b.start)).toEqual([
      "2026-10-01",
      "2026-11-01",
      "2026-12-01",
    ]);
  });

  it("ouvre la nouvelle semaine dès le lundi minuit à Paris", () => {
    const now = at("2026-11-08T23:30:00Z"); // lun. 9 nov. 00:30 Paris
    const weeks = buildProgression([], "3m", "week", now, PARIS);
    expect(weeks.at(-1)?.start).toBe("2026-11-09");
  });
});

describe("nombre de périodes", () => {
  const now = at("2026-11-04T12:00:00Z");
  it.each([
    ["3m", "week", 13],
    ["6m", "week", 26],
    ["1y", "week", 52],
    ["3m", "month", 3],
    ["6m", "month", 6],
    ["1y", "month", 12],
  ] as const)("%s par %s donne %i périodes", (period, group, length) => {
    expect(buildProgression([], period, group, now, PARIS)).toHaveLength(
      length,
    );
  });
});

describe("période « tout »", () => {
  const now = at("2026-11-04T12:00:00Z");

  it("avec une seule course cette semaine, donne une seule période", () => {
    const buckets = buildProgression(
      [run("2026-11-03T07:00:00Z")],
      "all",
      "week",
      now,
      PARIS,
    );
    expect(buckets.map((b) => [b.start, b.count])).toEqual([["2026-11-02", 1]]);
  });

  it("avec une seule course ancienne, va de sa semaine à la semaine en cours", () => {
    const buckets = buildProgression(
      [run("2026-10-14T07:00:00Z")],
      "all",
      "week",
      now,
      PARIS,
    );
    expect(buckets.map((b) => [b.start, b.count])).toEqual([
      ["2026-10-12", 1],
      ["2026-10-19", 0],
      ["2026-10-26", 0],
      ["2026-11-02", 0],
    ]);
  });

  it("ignore les activités hors course pour borner le début", () => {
    const runs = [
      run("2025-01-05T07:00:00Z", { sportType: "Ride" }),
      run("2026-10-28T07:00:00Z"),
    ];
    const buckets = buildProgression(runs, "all", "week", now, PARIS);
    expect(buckets[0].start).toBe("2026-10-26");
  });

  it("renvoie [] avec seulement du vélo", () => {
    const runs = [run("2026-10-28T07:00:00Z", { sportType: "Ride" })];
    expect(buildProgression(runs, "all", "week", now, PARIS)).toEqual([]);
  });
});

describe("filtrage des courses", () => {
  const now = at("2026-11-04T12:00:00Z");

  it("compte trail et course virtuelle comme de la course à pied", () => {
    const runs = [
      run("2026-11-02T07:00:00Z", { sportType: "TrailRun" }),
      run("2026-11-03T07:00:00Z", { sportType: "VirtualRun" }),
      run("2026-11-03T08:00:00Z", { sportType: "Walk" }),
    ];
    expect(buildProgression(runs, "3m", "week", now, PARIS).at(-1)?.count).toBe(
      2,
    );
  });

  it("ignore une course future ou à la date illisible", () => {
    const runs = [
      run("2026-11-04T12:00:01Z"),
      run("pas une date"),
      run("2026-11-04T12:00:00Z"),
    ];
    expect(buildProgression(runs, "3m", "week", now, PARIS).at(-1)?.count).toBe(
      1,
    );
  });

  it("ignore une course antérieure à la première période", () => {
    const runs = [run("2026-08-09T21:59:59Z")]; // dim. 9 août 23:59:59 Paris
    const buckets = buildProgression(runs, "3m", "week", now, PARIS);
    expect(buckets[0].start).toBe("2026-08-10");
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });

  it("ne pondère pas la FC d'une sortie sans temps de déplacement", () => {
    const runs = [
      run("2026-11-02T07:00:00Z", { movingTimeS: 1800, averageHeartrate: 150 }),
      run("2026-11-03T07:00:00Z", { movingTimeS: 0, averageHeartrate: 190 }),
    ];
    expect(
      buildProgression(runs, "3m", "week", now, PARIS).at(-1)?.heartrate,
    ).toBe(150);
  });

  it("laisse la FC à null quand aucune sortie de la période n'en a", () => {
    const buckets = buildProgression(
      [run("2026-11-02T07:00:00Z")],
      "3m",
      "week",
      now,
      PARIS,
    );
    expect(buckets.at(-1)).toMatchObject({ count: 1, heartrate: null });
  });
});

describe("isHistoryStale aux bornes", () => {
  const now = at("2026-11-02T12:00:00Z");
  it("ne signale pas un historique arrêté exactement 7 jours avant", () => {
    expect(isHistoryStale("2026-10-26T12:00:00Z", now)).toBe(false);
  });
  it("signale un historique arrêté 7 jours et 1 ms avant", () => {
    expect(isHistoryStale("2026-10-26T11:59:59.999Z", now)).toBe(true);
  });
});

describe("niveau glissant aux bornes des 56 jours", () => {
  const now = at("2026-11-04T12:00:00Z");
  const DAY = 24 * 3600 * 1000;
  // 10 km en 40:00 : VDOT ≈ 52.
  const fast = (startDate: string) =>
    run(startDate, { distanceM: 10_000, movingTimeS: 2400 });

  it("compte une course faite exactement 56 jours avant la fin de période", () => {
    const runs = [fast(new Date(now - 56 * DAY).toISOString())];
    const last = buildProgression(runs, "all", "week", now, PARIS).at(-1);
    expect(last?.vdot).toBe(
      Math.round((estimateFitness(runs, now)?.vdot ?? 0) * 10) / 10,
    );
    expect(last?.vdot).not.toBeNull();
  });

  it("n'en compte plus une faite 56 jours et 1 ms avant", () => {
    const runs = [fast(new Date(now - 56 * DAY - 1).toISOString())];
    const last = buildProgression(runs, "all", "week", now, PARIS).at(-1);
    expect(estimateFitness(runs, now)).toBeNull();
    expect(last?.vdot).toBeNull();
  });

  it("retombe à la meilleure course encore dans la fenêtre quand la meilleure en sort", () => {
    const runs = [
      fast("2026-08-01T07:00:00Z"), // VDOT élevé, sort de la fenêtre fin septembre
      run("2026-09-20T07:00:00Z", { distanceM: 10_000, movingTimeS: 3000 }),
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
    const values = new Set(buckets.map((b) => b.vdot));
    expect(values.size).toBeGreaterThanOrEqual(3); // null, le haut, puis le bas
  });
});

describe("coût du calcul", () => {
  // Ne mesure pas le temps : vérifie que le fuseau n'est consulté qu'aux bornes de périodes,
  // jamais par course (c'est l'appel Intl qui coûte, ≈ 1 µs chacun).
  function countZoneLookups(runs: ProgressionRun[]): number {
    const RealFormat = Intl.DateTimeFormat;
    let calls = 0;
    // Formateur instrumenté : compte les appels à format(), seule méthode utilisée.
    function CountingFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      const real = new RealFormat(locales, options);
      return {
        format: (date?: number | Date) => {
          calls += 1;
          return real.format(date);
        },
      };
    }
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(
        CountingFormat as unknown as typeof Intl.DateTimeFormat,
      );
    try {
      buildProgression(runs, "all", "week", at("2026-11-04T12:00:00Z"), PARIS);
    } finally {
      spy.mockRestore();
    }
    return calls;
  }

  it("consulte le fuseau autant de fois pour 10 ou 2 000 courses sur la même durée", () => {
    const DAY = 24 * 3600 * 1000;
    const end = at("2026-11-04T12:00:00Z");
    const spread = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        run(new Date(end - (i * 3000 * DAY) / (count - 1)).toISOString()),
      );
    const few = countZoneLookups(spread(10));
    expect(few).toBeGreaterThan(400); // ≈ une consultation par semaine sur 3 000 jours
    expect(countZoneLookups(spread(2000))).toBe(few);
  });
});
