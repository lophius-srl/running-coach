import { describe, expect, it } from "vitest";
import {
  dayGap,
  generateWeekPlan,
  HARD_KINDS,
  isoWeekday,
  planPhase,
  weekTemplate,
  type PlanInput,
  type PlanPhase,
} from "./plan";

// 2026-11-02 est un lundi.
const MONDAY = "2026-11-02";
const input: PlanInput = {
  availableDays: [2, 4, 6],
  raceDate: "2027-04-11",
  distanceM: 10000,
  today: MONDAY,
};

const PHASES: PlanPhase[] = ["development", "specific", "taper"];

// Toutes les combinaisons d'au moins 2 jours (120).
const DAY_SETS: number[][] = [];
for (let mask = 0; mask < 128; mask++) {
  const days = [1, 2, 3, 4, 5, 6, 7].filter((day) => mask & (1 << (day - 1)));
  if (days.length >= 2) DAY_SETS.push(days);
}

function hardDays(template: Map<number, string>): number[] {
  return [...template]
    .filter(([, kind]) => HARD_KINDS.has(kind as never))
    .map(([day]) => day);
}

describe("planPhase", () => {
  it.each([
    ["2026-11-03", "taper"],
    ["2026-11-16", "taper"],
    ["2026-11-17", "specific"],
    ["2026-12-28", "specific"],
    ["2026-12-29", "development"],
    ["2027-04-11", "development"],
  ])("race on %s gives %s", (raceDate, phase) => {
    expect(planPhase(MONDAY, raceDate)).toBe(phase);
  });

  it.each([MONDAY, "2026-11-01"])("returns null for a race on %s", (race) => {
    expect(planPhase(MONDAY, race)).toBeNull();
  });
});

describe("dayGap", () => {
  it("treats Sunday and Monday as neighbours", () => {
    expect(dayGap(7, 1)).toBe(1);
    expect(dayGap(1, 7)).toBe(1);
    expect(dayGap(2, 6)).toBe(3);
  });
});

describe("weekTemplate", () => {
  it.each(PHASES)(
    "never puts two hard sessions on consecutive days, Sunday→Monday included (%s)",
    (phase) => {
      for (const days of DAY_SETS) {
        const hard = hardDays(weekTemplate(days, phase));
        for (const a of hard) {
          for (const b of hard) {
            if (a !== b) expect(dayGap(a, b), `${days}`).toBeGreaterThan(1);
          }
        }
      }
    },
  );

  it.each(PHASES)("gives one session per available day (%s)", (phase) => {
    for (const days of DAY_SETS) {
      expect([...weekTemplate(days, phase).keys()].sort()).toEqual(days);
    }
  });

  it("always plans exactly one long run, on Sunday when available", () => {
    for (const days of DAY_SETS) {
      const template = weekTemplate(days, "development");
      const longDays = [...template].filter(([, kind]) => kind === "long");
      const expected = days.includes(7)
        ? 7
        : days.includes(6)
          ? 6
          : Math.max(...days);
      expect(longDays).toEqual([[expected, "long"]]);
    }
  });

  it("puts the long run on Saturday without Sunday", () => {
    expect(weekTemplate([1, 3, 6], "development").get(6)).toBe("long");
  });

  it("keeps a single hard session when the two days follow each other", () => {
    expect([...weekTemplate([6, 7], "development")]).toEqual([
      [7, "long"],
      [6, "endurance"],
    ]);
    expect(weekTemplate([1, 7], "specific").get(1)).toBe("recovery");
  });

  it("plans 1 quality session up to 3 days, 2 from 4 days, 1 in taper", () => {
    const quality = (days: number[], phase: PlanPhase) =>
      hardDays(weekTemplate(days, phase)).length - 1;
    expect(quality([2, 4, 7], "development")).toBe(1);
    expect(quality([1, 3, 5, 7], "development")).toBe(2);
    expect(quality([1, 2, 3, 4, 5, 6, 7], "specific")).toBe(2);
    expect(quality([1, 3, 5, 7], "taper")).toBe(1);
  });

  it("picks quality types by phase", () => {
    const kinds = (phase: PlanPhase) =>
      [...weekTemplate([1, 2, 3, 4, 5, 6, 7], phase)].sort(([a], [b]) => a - b);
    expect(kinds("development")).toEqual([
      [1, "recovery"],
      [2, "endurance"],
      [3, "vma"],
      [4, "endurance"],
      [5, "threshold"],
      [6, "endurance"],
      [7, "long"],
    ]);
    expect(weekTemplate([1, 3, 5, 7], "specific").get(3)).toBe("race_pace");
    expect(weekTemplate([1, 3, 5, 7], "taper").get(3)).toBe("race_pace");
  });
});

describe("generateWeekPlan", () => {
  it("returns one dated session per available day, with type, duration and description", () => {
    expect(generateWeekPlan(input)).toEqual({
      weekStart: MONDAY,
      phase: "development",
      sessions: [
        {
          date: "2026-11-03",
          kind: "vma",
          durationMin: 50,
          description: expect.stringContaining("8 × 400 m à allure VMA"),
        },
        {
          date: "2026-11-05",
          kind: "endurance",
          durationMin: 45,
          description: expect.stringContaining("Footing en endurance"),
        },
        {
          date: "2026-11-07",
          kind: "long",
          durationMin: 75,
          description: expect.stringContaining("Sortie longue"),
        },
      ],
    });
  });

  it("is deterministic", () => {
    expect(generateWeekPlan({ ...input })).toEqual(generateWeekPlan(input));
  });

  it("covers the 7 days from today, in date order", () => {
    const plan = generateWeekPlan({ ...input, today: "2026-11-05" });
    expect(plan?.weekStart).toBe("2026-11-05");
    expect(plan?.sessions.map((s) => s.date)).toEqual([
      "2026-11-05",
      "2026-11-07",
      "2026-11-10",
    ]);
  });

  it("keeps hard sessions apart on real dates for every weekday start", () => {
    for (let offset = 0; offset < 7; offset++) {
      const today = `2026-11-0${2 + offset}`;
      for (const days of DAY_SETS) {
        const hard = generateWeekPlan({ ...input, today, availableDays: days })!
          .sessions.filter((s) => HARD_KINDS.has(s.kind))
          .map((s) => isoWeekday(s.date));
        for (const a of hard) {
          for (const b of hard) {
            if (a !== b) expect(dayGap(a, b)).toBeGreaterThan(1);
          }
        }
      }
    }
  });

  it("scales sessions with the race distance and the phase", () => {
    const long = (distanceM: number, raceDate: string) =>
      generateWeekPlan({ ...input, distanceM, raceDate })?.sessions.at(-1);
    expect(long(5000, "2027-04-11")?.durationMin).toBe(60);
    expect(long(42195, "2027-04-11")?.durationMin).toBe(120);
    expect(long(42195, "2026-12-20")?.durationMin).toBe(135);
    expect(long(42195, "2026-11-15")?.durationMin).toBe(75);
    const specific = generateWeekPlan({ ...input, raceDate: "2026-12-20" });
    expect(specific?.phase).toBe("specific");
    expect(specific?.sessions[0]).toMatchObject({
      kind: "race_pace",
      durationMin: 65,
      description: expect.stringContaining("4 × 2 000 m à allure course"),
    });
  });

  it("stops before the race and eases off the two days before it", () => {
    const plan = generateWeekPlan({
      ...input,
      availableDays: [1, 3, 5, 6, 7],
      raceDate: "2026-11-08",
    });
    expect(plan?.phase).toBe("taper");
    expect(
      plan?.sessions.map(({ date, kind, durationMin }) => [
        date,
        kind,
        durationMin,
      ]),
    ).toEqual([
      ["2026-11-02", "recovery", 30],
      ["2026-11-04", "race_pace", 45],
      ["2026-11-06", "endurance", 25],
      ["2026-11-07", "endurance", 25],
    ]);
    const raceThursday = generateWeekPlan({
      ...input,
      availableDays: [3, 7],
      raceDate: "2026-11-05",
    });
    expect(raceThursday?.sessions).toEqual([
      {
        date: "2026-11-04",
        kind: "endurance",
        durationMin: 25,
        description: expect.stringContaining("arriver frais"),
      },
    ]);
  });

  it("returns null when the race is today or past", () => {
    expect(generateWeekPlan({ ...input, raceDate: MONDAY })).toBeNull();
    expect(generateWeekPlan({ ...input, raceDate: "2026-10-01" })).toBeNull();
  });
});
