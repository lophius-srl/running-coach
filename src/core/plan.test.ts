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

  it("plans 1 quality session up to 4 days, 2 from 5 days, 1 in taper", () => {
    const quality = (days: number[], phase: PlanPhase) =>
      hardDays(weekTemplate(days, phase)).length - 1;
    expect(quality([2, 4, 7], "development")).toBe(1);
    expect(quality([1, 3, 5, 7], "development")).toBe(1);
    expect(quality([1, 3, 4, 5, 7], "development")).toBe(2);
    expect(quality([1, 2, 3, 4, 5, 6, 7], "specific")).toBe(2);
    expect(quality([1, 3, 5, 7], "taper")).toBe(1);
  });

  it("plans nothing without an available day", () => {
    expect(weekTemplate([], "development").size).toBe(0);
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

  it("turns the long run into a footing 5 days or less before the race", () => {
    const sundayRun = (raceDate: string) =>
      generateWeekPlan({
        ...input,
        availableDays: [2, 7],
        raceDate,
      })?.sessions.find((s) => s.date === "2026-11-08");
    expect(sundayRun("2026-11-14")).toMatchObject({ kind: "long" }); // J-6
    expect(sundayRun("2026-11-13")).toMatchObject({
      kind: "endurance",
      durationMin: 35,
    }); // J-5
  });

  it("returns null when the race is today or past", () => {
    expect(generateWeekPlan({ ...input, raceDate: MONDAY })).toBeNull();
    expect(generateWeekPlan({ ...input, raceDate: "2026-10-01" })).toBeNull();
  });
});

describe("generateWeekPlan — cas limites", () => {
  const kinds = (plan: ReturnType<typeof generateWeekPlan>) =>
    plan?.sessions.map(({ date, kind }) => [date, kind]);

  it("plans exactly one long run in a week without race, whatever the start day", () => {
    for (let offset = 0; offset < 7; offset++) {
      const today = `2026-11-0${2 + offset}`;
      for (const days of DAY_SETS) {
        const plan = generateWeekPlan({ ...input, today, availableDays: days });
        const longRuns = plan!.sessions.filter((s) => s.kind === "long");
        expect(longRuns, `${today} ${days}`).toHaveLength(1);
        expect(plan!.sessions).toHaveLength(days.length);
      }
    }
  });

  it("gives every session a positive duration and a description", () => {
    for (const raceDate of ["2026-11-10", "2026-12-20", "2027-04-11"]) {
      for (const distanceM of [5000, 10000, 21098, 42195]) {
        const plan = generateWeekPlan({
          ...input,
          raceDate,
          distanceM,
          availableDays: [1, 2, 3, 4, 5, 6, 7],
        });
        for (const session of plan!.sessions) {
          expect(session.durationMin).toBeGreaterThan(0);
          expect(session.description.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("puts the long run on the last weekday when only weekdays are available", () => {
    const plan = generateWeekPlan({ ...input, availableDays: [1, 2, 3, 4, 5] });
    expect(kinds(plan)).toEqual([
      ["2026-11-02", "vma"],
      ["2026-11-03", "endurance"],
      ["2026-11-04", "threshold"],
      ["2026-11-05", "endurance"],
      ["2026-11-06", "long"],
    ]);
  });

  it("does not depend on the order or duplicates of available days", () => {
    expect(generateWeekPlan({ ...input, availableDays: [6, 2, 4, 2] })).toEqual(
      generateWeekPlan(input),
    );
  });

  it("does not modify its input", () => {
    const days = [6, 2, 4];
    generateWeekPlan({ ...input, availableDays: days });
    expect(days).toEqual([6, 2, 4]);
  });

  it("skips a race day that is an available day", () => {
    const plan = generateWeekPlan({
      ...input,
      availableDays: [2, 4, 6],
      raceDate: "2026-11-05",
    });
    expect(kinds(plan)).toEqual([["2026-11-03", "endurance"]]);
  });

  it("plans only a short easy run today when the race is tomorrow", () => {
    const plan = generateWeekPlan({
      ...input,
      availableDays: [1, 7],
      raceDate: "2026-11-03",
    });
    expect(plan?.phase).toBe("taper");
    expect(plan?.sessions).toEqual([
      expect.objectContaining({
        date: "2026-11-02",
        kind: "endurance",
        durationMin: 25,
      }),
    ]);
  });

  it("drops the long run planned on race day but keeps the quality session", () => {
    const plan = generateWeekPlan({
      ...input,
      availableDays: [1, 3, 5],
      raceDate: "2026-11-06",
    });
    expect(
      plan?.sessions.map(({ date, kind, durationMin }) => [
        date,
        kind,
        durationMin,
      ]),
    ).toEqual([
      ["2026-11-02", "race_pace", 45],
      ["2026-11-04", "endurance", 25],
    ]);
  });

  it.each([
    ["2026-11-16", "taper"],
    ["2026-11-17", "specific"],
    ["2026-12-28", "specific"],
    ["2026-12-29", "development"],
  ])("uses the exact phase bound for a race on %s", (raceDate, phase) => {
    expect(generateWeekPlan({ ...input, raceDate })?.phase).toBe(phase);
  });

  it("crosses the year boundary with real weekdays", () => {
    const plan = generateWeekPlan({
      ...input,
      today: "2026-12-29", // un mardi
      raceDate: "2027-04-11",
      availableDays: [5, 7],
    });
    expect(kinds(plan)).toEqual([
      ["2027-01-01", "vma"],
      ["2027-01-03", "long"],
    ]);
  });

  it("handles a leap day", () => {
    const plan = generateWeekPlan({
      ...input,
      today: "2028-02-28", // un lundi
      raceDate: "2028-06-01",
      availableDays: [2, 4],
    });
    expect(plan?.sessions.map((s) => s.date)).toEqual([
      "2028-02-29",
      "2028-03-02",
    ]);
  });
});
