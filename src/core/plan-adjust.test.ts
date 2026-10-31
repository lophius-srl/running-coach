import { describe, expect, it } from "vitest";
import type { RunSample } from "./fitness";
import { adjustedDuration, adjustPlan } from "./plan-adjust";
import type { WeekPlan } from "./plan";

// Début du plan : minuit à Paris le lundi 2026-11-02 (UTC+1). Les courses sont datées par
// rapport à cet instant : la fenêtre est [START − 7 j, START[.
const START = Date.parse("2026-11-01T23:00:00.000Z");
const TODAY = "2026-11-02";
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
    startDate: new Date(START - daysAgo * DAY_MS).toISOString(),
    sportType: "Run",
    distanceM: 10000,
    movingTimeS: movingMin * 60,
  };
}

const adjust = (p: WeekPlan, runs: RunSample[], today = TODAY) =>
  adjustPlan(p, runs, START, today);

const durations = (runs: RunSample[], today = TODAY) =>
  adjust(plan, runs, today).sessions.map((s) => s.durationMin);

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
    const adjusted = adjust(plan, [run(1, 100), run(3, 121, 2)]);
    expect(adjusted.adjustment).toBeNull();
    expect(adjusted.sessions).toEqual(
      plan.sessions.map((s) => ({ ...s, planned: null })),
    );
  });

  it("does not reduce at exactly 1.3 × the planned volume (221 min)", () => {
    expect(durations([run(1, 221)])).toEqual([50, 45, 75]);
  });

  it("cuts easy sessions by 15 % above 1.3 × the planned volume", () => {
    const adjusted = adjust(plan, [run(1, 222)]);
    expect(adjusted.adjustment).toEqual({
      kind: "high_volume",
      reason:
        "Volume récent élevé (222 min courues dans les 7 jours avant le plan pour 170 min prévues) : footings et sortie longue −15 %.",
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

  it("sums only runs of the 7 days before the plan start", () => {
    expect(durations([run(7, 150), run(2, 100, 2)])).toEqual([50, 40, 65]);
    expect(durations([run(7.01, 150), run(2, 100, 2)])).toEqual([50, 45, 75]);
    expect(durations([run(-0.1, 150), run(2, 100, 2)])).toEqual([50, 45, 75]);
  });

  it("ignores activities that are not runs", () => {
    const ride = { ...run(1, 300), sportType: "Ride" };
    expect(durations([ride, run(2, 30, 2)])).toEqual([50, 45, 75]);
  });

  it("restarts gently after 7 days without running", () => {
    const adjusted = adjust(plan, [run(7.01, 60)]);
    expect(adjusted.adjustment).toEqual({
      kind: "restart",
      reason:
        "Aucune course enregistrée depuis 7 jours : reprise en douceur, séances de qualité remplacées par du footing et durées −30 %.",
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

  it("does not adjust without any known run in the 8 weeks before the plan", () => {
    expect(adjust(plan, []).adjustment).toBeNull();
    expect(adjust(plan, [run(56.01, 60)]).adjustment).toBeNull();
    // Borne incluse, comme la fenêtre du niveau (fitness.ts).
    expect(adjust(plan, [run(56, 60)]).adjustment?.kind).toBe("restart");
  });

  it("does not adjust a plan without sessions", () => {
    const empty = { ...plan, sessions: [] };
    expect(adjust(empty, [run(1, 600)])).toEqual({
      ...empty,
      adjustment: null,
    });
  });

  it("is deterministic", () => {
    const runs = [run(1, 300)];
    expect(adjust(plan, runs)).toEqual(adjust(plan, runs));
  });
});

describe("adjustPlan — cas limites (QA #16)", () => {
  const sessionsOf = (adjusted: ReturnType<typeof adjustPlan>) =>
    adjusted.sessions.map(({ kind, durationMin }) => ({ kind, durationMin }));

  it("counts a run exactly 7 × 24 h before the plan start, not one just before", () => {
    expect(adjust(plan, [run(7, 300)]).adjustment?.kind).toBe("high_volume");
    expect(adjust(plan, [run(7.01, 300)]).adjustment?.kind).toBe("restart");
  });

  it("counts a run just inside the 7-day window and does not restart", () => {
    const justInside = {
      ...run(0, 60),
      startDate: new Date(START - 7 * DAY_MS + 1000).toISOString(),
    };
    expect(adjust(plan, [justInside]).adjustment).toBeNull();
  });

  it("does not count a run starting exactly at the plan start", () => {
    expect(durations([run(0, 222), run(1, 10, 2)])).toEqual([50, 45, 75]);
  });

  it("ignores future runs, also for the restart rule", () => {
    const adjusted = adjust(plan, [run(-1, 300), run(10, 60, 2)]);
    expect(adjusted.adjustment?.kind).toBe("restart");
  });

  it("compares instants, whatever the time zone of the start date", () => {
    // 2026-10-26T00:30+01:00 = 2026-10-25T23:30 UTC : 6 j 23 h 30 avant START, dans la fenêtre.
    const offset = { ...run(0, 222), startDate: "2026-10-26T00:30:00+01:00" };
    expect(durations([offset])).toEqual([50, 40, 65]);
    // 2026-10-25T23:30+01:00 = 22:30 UTC : 7 j 30 min avant START, hors fenêtre.
    const outside = { ...offset, startDate: "2026-10-25T23:30:00+01:00" };
    expect(adjust(plan, [outside]).adjustment?.kind).toBe("restart");
  });

  it("ignores non-run activities for the restart rule", () => {
    const ride = { ...run(1, 120), sportType: "Ride" };
    expect(adjust(plan, [ride, run(10, 60, 2)]).adjustment?.kind).toBe(
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
    const adjusted = adjust(preRace, [run(10, 60)]);
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
    const adjusted = adjust(short, [run(1, 600)]);
    expect(adjusted.sessions).toMatchObject([
      { durationMin: 15, planned: null },
    ]);
  });

  it("restart on a plan without quality session only shortens the sessions", () => {
    const easy: WeekPlan = {
      ...plan,
      sessions: [plan.sessions[1], plan.sessions[2]],
    };
    const adjusted = adjust(easy, [run(10, 60)]);
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
    expect(sessionsOf(adjust(quality, [run(10, 60)]))).toEqual([
      { kind: "endurance", durationMin: 45 },
      { kind: "endurance", durationMin: 30 },
    ]);
  });

  it("does not mutate the plan nor the runs", () => {
    const planCopy = JSON.parse(JSON.stringify(plan));
    const runs = [run(1, 300)];
    const runsCopy = JSON.parse(JSON.stringify(runs));
    adjust(plan, runs);
    expect(plan).toEqual(planCopy);
    expect(runs).toEqual(runsCopy);
  });
});

describe("adjustPlan — semaine en cours et affûtage (review #16)", () => {
  it("never reduces a taper week for a high volume, but can restart it", () => {
    const taper: WeekPlan = {
      ...plan,
      phase: "taper",
      sessions: [plan.sessions[0], plan.sessions[1]],
    };
    expect(adjust(taper, [run(1, 600)]).adjustment).toBeNull();
    expect(adjust(taper, [run(10, 60)]).adjustment?.kind).toBe("restart");
  });

  it("returns no adjustment when no session changes (race pace only)", () => {
    const racePaceOnly: WeekPlan = {
      ...plan,
      phase: "specific",
      sessions: [{ ...plan.sessions[0], kind: "race_pace" }],
    };
    const adjusted = adjust(racePaceOnly, [run(1, 600)]);
    expect(adjusted.adjustment).toBeNull();
    expect(adjusted.sessions).toMatchObject([{ planned: null }]);
  });

  it("returns no adjustment once the plan is over", () => {
    expect(adjust(plan, [run(1, 600)], "2026-11-09").adjustment).toBeNull();
    expect(adjust(plan, [run(10, 60)], "2026-11-09").adjustment).toBeNull();
    expect(durations([run(1, 600)], "2026-11-09")).toEqual([50, 45, 75]);
  });

  it("returns no adjustment when every session to change is past", () => {
    expect(adjust(plan, [run(1, 600)], "2026-11-08").adjustment).toBeNull();
  });

  it("keeps past sessions as planned in the middle of the week", () => {
    const adjusted = adjust(plan, [run(10, 60)], "2026-11-04");
    expect(adjusted.adjustment?.kind).toBe("restart");
    expect(adjusted.sessions).toMatchObject([
      { kind: "vma", durationMin: 50, description: "VMA", planned: null },
      { kind: "endurance", durationMin: 30 },
      { kind: "long", durationMin: 55 },
    ]);
    expect(durations([run(1, 222)], "2026-11-06")).toEqual([50, 45, 65]);
  });

  it("keeps the restart after a run on day 2 of the plan", () => {
    const dayTwo = run(-1.5, 30, 2); // mardi 3 novembre
    const adjusted = adjust(plan, [run(10, 60), dayTwo], "2026-11-04");
    expect(adjusted.adjustment?.kind).toBe("restart");
  });

  it("keeps the high-volume cut while the reduced week is run", () => {
    const week = [run(-1.5, 50, 2), run(-3.5, 40, 3)];
    const adjusted = adjust(plan, [run(1, 222), ...week], "2026-11-06");
    expect(adjusted.adjustment?.reason).toMatch(/222 min .* −15 %/);
  });
});
