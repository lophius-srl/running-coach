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

describe("adjustPlan — cas limites (QA #16)", () => {
  const sessionsOf = (adjusted: ReturnType<typeof adjustPlan>) =>
    adjusted.sessions.map(({ kind, durationMin }) => ({ kind, durationMin }));

  it("counts a run exactly 7 days old as outside the window and restarts", () => {
    expect(adjustPlan(plan, [run(7, 300)], NOW).adjustment?.kind).toBe(
      "restart",
    );
  });

  it("counts a run just inside the 7-day window and does not restart", () => {
    const justInside = {
      ...run(0, 60),
      startDate: new Date(NOW - 7 * DAY_MS + 1000).toISOString(),
    };
    expect(adjustPlan(plan, [justInside], NOW).adjustment).toBeNull();
  });

  it("counts a run starting exactly now", () => {
    expect(durations([run(0, 222)])).toEqual([50, 40, 65]);
  });

  it("ignores future runs, also for the restart rule", () => {
    const adjusted = adjustPlan(plan, [run(-1, 300), run(10, 60, 2)], NOW);
    expect(adjusted.adjustment?.kind).toBe("restart");
  });

  it("compares instants, whatever the time zone of the start date", () => {
    // 2026-10-26T11:30+01:00 = 10:30 UTC : 6 j 23 h 30 avant NOW, donc dans la fenêtre.
    const offset = { ...run(0, 222), startDate: "2026-10-26T11:30:00+01:00" };
    expect(durations([offset])).toEqual([50, 40, 65]);
    // 2026-10-26T10:30+01:00 = 09:30 UTC : 7 j 30 min avant NOW, hors fenêtre.
    const outside = { ...offset, startDate: "2026-10-26T10:30:00+01:00" };
    expect(adjustPlan(plan, [outside], NOW).adjustment?.kind).toBe("restart");
  });

  it("ignores non-run activities for the restart rule", () => {
    const ride = { ...run(1, 120), sportType: "Ride" };
    expect(adjustPlan(plan, [ride, run(10, 60, 2)], NOW).adjustment?.kind).toBe(
      "restart",
    );
  });

  it("counts trail and virtual runs in the recent volume", () => {
    const trail = { ...run(1, 150), sportType: "TrailRun" };
    const virtual = { ...run(2, 72, 2), sportType: "VirtualRun" };
    expect(durations([trail, virtual])).toEqual([50, 40, 65]);
  });

  it("restart keeps 25-min pre-race footings at the 20-min floor", () => {
    const preRace: WeekPlan = {
      weekStart: "2026-11-02",
      phase: "taper",
      sessions: [
        {
          date: "2026-11-03",
          kind: "endurance",
          durationMin: 25,
          description: "F",
        },
        {
          date: "2026-11-04",
          kind: "endurance",
          durationMin: 20,
          description: "F",
        },
      ],
    };
    const adjusted = adjustPlan(preRace, [run(10, 60)], NOW);
    expect(adjusted.adjustment?.kind).toBe("restart");
    expect(adjusted.sessions).toMatchObject([
      { durationMin: 20, planned: { kind: "endurance", durationMin: 25 } },
      { durationMin: 20, planned: null },
    ]);
  });

  it("never lengthens a session shorter than the 20-min floor", () => {
    const short: WeekPlan = {
      ...plan,
      sessions: [
        {
          date: "2026-11-03",
          kind: "recovery",
          durationMin: 15,
          description: "R",
        },
      ],
    };
    const adjusted = adjustPlan(short, [run(1, 600)], NOW);
    expect(adjusted.sessions).toMatchObject([
      { durationMin: 15, planned: null },
    ]);
  });

  it("restart on a plan without quality session only shortens the sessions", () => {
    const easy: WeekPlan = {
      ...plan,
      sessions: [plan.sessions[1], plan.sessions[2]],
    };
    const adjusted = adjustPlan(easy, [run(10, 60)], NOW);
    expect(sessionsOf(adjusted)).toEqual([
      { kind: "endurance", durationMin: 30 },
      { kind: "long", durationMin: 55 },
    ]);
    expect(adjusted.sessions.map((s) => s.description)).toEqual(["F", "SL"]);
  });

  it("restart turns every quality kind into a footing", () => {
    const quality: WeekPlan = {
      ...plan,
      sessions: [
        {
          date: "2026-11-03",
          kind: "threshold",
          durationMin: 65,
          description: "S",
        },
        {
          date: "2026-11-05",
          kind: "race_pace",
          durationMin: 45,
          description: "AS",
        },
      ],
    };
    expect(sessionsOf(adjustPlan(quality, [run(10, 60)], NOW))).toEqual([
      { kind: "endurance", durationMin: 45 },
      { kind: "endurance", durationMin: 30 },
    ]);
  });

  it("does not mutate the plan nor the runs", () => {
    const planCopy = JSON.parse(JSON.stringify(plan));
    const runs = [run(1, 300)];
    const runsCopy = JSON.parse(JSON.stringify(runs));
    adjustPlan(plan, runs, NOW);
    expect(plan).toEqual(planCopy);
    expect(runs).toEqual(runsCopy);
  });
});
