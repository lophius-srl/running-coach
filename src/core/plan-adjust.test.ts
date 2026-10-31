import { describe, expect, it } from "vitest";
import type { RunSample } from "./fitness";
import { adjustedDuration, adjustPlan } from "./plan-adjust";
import type { WeekPlan } from "./plan";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const DAY_MS = 86_400_000;

// 170 min prévues : VMA 50, footing 45, sortie longue 75.
const plan: WeekPlan = {
  weekStart: "2026-11-02",
  phase: "development",
  sessions: [
    { date: "2026-11-03", kind: "vma", durationMin: 50, description: "VMA" },
    {
      date: "2026-11-05",
      kind: "endurance",
      durationMin: 45,
      description: "F",
    },
    { date: "2026-11-07", kind: "long", durationMin: 75, description: "SL" },
  ],
};

function run(daysAgo: number, movingMin: number, id = 1): RunSample {
  return {
    id,
    startDate: new Date(NOW - daysAgo * DAY_MS).toISOString(),
    sportType: "Run",
    distanceM: 10000,
    movingTimeS: movingMin * 60,
  };
}

const durations = (runs: RunSample[]) =>
  adjustPlan(plan, runs, NOW).sessions.map((s) => s.durationMin);

describe("adjustedDuration", () => {
  it.each([
    [45, 0.15, 40], // 38,25 → 40
    [75, 0.15, 65], // 63,75 → 65
    [75, 0.25, 55], // 56,25 → 55
    [25, 0.3, 20], // 17,5 → 20
    [20, 0.3, 20], // plancher 20 min
    [15, 0.3, 15], // jamais au-dessus de la durée prévue
  ])("%i min −%f → %i min", (duration, cut, expected) => {
    expect(adjustedDuration(duration, cut)).toBe(expected);
  });
});

describe("adjustPlan", () => {
  it("leaves the plan unchanged when the recent volume is close to the plan", () => {
    const adjusted = adjustPlan(plan, [run(1, 100), run(3, 121, 2)], NOW);
    expect(adjusted.adjustment).toBeNull();
    expect(adjusted.sessions).toEqual(
      plan.sessions.map((s) => ({ ...s, planned: null })),
    );
  });

  it("does not reduce at exactly 1.3 × the planned volume (221 min)", () => {
    expect(durations([run(1, 221)])).toEqual([50, 45, 75]);
  });

  it("cuts easy sessions by 15 % above 1.3 × the planned volume", () => {
    const adjusted = adjustPlan(plan, [run(1, 222)], NOW);
    expect(adjusted.adjustment).toEqual({
      kind: "high_volume",
      reason:
        "Volume récent élevé (222 min courues en 7 jours pour 170 min prévues) : footings et sortie longue −15 %.",
    });
    expect(adjusted.sessions).toEqual([
      { ...plan.sessions[0], planned: null },
      {
        ...plan.sessions[1],
        durationMin: 40,
        planned: { kind: "endurance", durationMin: 45 },
      },
      {
        ...plan.sessions[2],
        durationMin: 65,
        planned: { kind: "long", durationMin: 75 },
      },
    ]);
  });

  it("cuts by 15 % at exactly 1.6 × and by 25 % above", () => {
    expect(durations([run(1, 272)])).toEqual([50, 40, 65]);
    expect(durations([run(1, 273)])).toEqual([50, 35, 55]);
  });

  it("sums only runs of the last 7 days", () => {
    expect(durations([run(6.9, 150), run(2, 100, 2)])).toEqual([50, 40, 65]);
    expect(durations([run(7, 150), run(2, 100, 2)])).toEqual([50, 45, 75]);
    expect(durations([run(-0.1, 150), run(2, 100, 2)])).toEqual([50, 45, 75]);
  });

  it("ignores activities that are not runs", () => {
    const ride = { ...run(1, 300), sportType: "Ride" };
    expect(durations([ride, run(2, 30, 2)])).toEqual([50, 45, 75]);
  });

  it("restarts gently after 7 days without running", () => {
    const adjusted = adjustPlan(plan, [run(7, 60)], NOW);
    expect(adjusted.adjustment).toEqual({
      kind: "restart",
      reason:
        "Aucune course depuis 7 jours : reprise en douceur, séances de qualité remplacées par du footing et durées −30 %.",
    });
    expect(adjusted.sessions).toMatchObject([
      {
        kind: "endurance",
        durationMin: 35,
        planned: { kind: "vma", durationMin: 50 },
      },
      {
        kind: "endurance",
        durationMin: 30,
        planned: { kind: "endurance", durationMin: 45 },
      },
      {
        kind: "long",
        durationMin: 55,
        planned: { kind: "long", durationMin: 75 },
      },
    ]);
    expect(adjusted.sessions[0].description).toMatch(/reprise en douceur/);
  });

  it("does not adjust without any known run in the last 8 weeks", () => {
    expect(adjustPlan(plan, [], NOW).adjustment).toBeNull();
    expect(adjustPlan(plan, [run(56, 60)], NOW).adjustment).toBeNull();
    expect(adjustPlan(plan, [run(55.9, 60)], NOW).adjustment?.kind).toBe(
      "restart",
    );
  });

  it("does not adjust a plan without sessions", () => {
    const empty = { ...plan, sessions: [] };
    expect(adjustPlan(empty, [run(1, 600)], NOW)).toEqual({
      ...empty,
      adjustment: null,
    });
  });

  it("is deterministic", () => {
    const runs = [run(1, 300)];
    expect(adjustPlan(plan, runs, NOW)).toEqual(adjustPlan(plan, runs, NOW));
  });
});
