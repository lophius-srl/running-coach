import { describe, expect, it } from "vitest";
import type { HeartRateSettings } from "../../core/heart-rate";
import type { SessionKind } from "../../core/plan";
import type { AdjustedPlan } from "../../core/plan-adjust";
import { withTargets } from "./view";

const settings: HeartRateSettings = {
  restingHr: 50,
  maxHr: 190,
  zones: [120, 134, 148, 162, 176].map((low) => ({ low, high: low + 14 })),
};

function planOf(...kinds: SessionKind[]): AdjustedPlan {
  return {
    weekStart: "2026-11-02",
    phase: "specific",
    adjustment: null,
    sessions: kinds.map((kind, i) => ({
      date: `2026-11-0${i + 2}`,
      kind,
      durationMin: 40,
      description: "",
      planned: null,
    })),
  };
}

function targetZones(plan: AdjustedPlan, raceDistanceM: number | null) {
  return withTargets(plan, null, { settings, raceDistanceM }).sessions.map(
    (session) => session.targetHeartRate?.zone ?? null,
  );
}

describe("withTargets", () => {
  it("maps each session kind to its heart rate zone", () => {
    const plan = planOf("endurance", "long", "recovery", "threshold", "vma");
    expect(targetZones(plan, 10000)).toEqual([2, 2, 1, 4, 5]);
  });

  it.each([
    [5000, 5],
    [10000, 4],
    [21098, 4],
    [42195, 3],
  ])("maps race pace on %s m to Z%s, with its bounds", (distanceM, zone) => {
    const [session] = withTargets(planOf("race_pace"), null, {
      settings,
      raceDistanceM: distanceM,
    }).sessions;
    expect(session.targetHeartRate).toEqual({
      zone,
      ...settings.zones[zone - 1],
    });
  });

  it("has no heart rate target without zones, or for race pace without a goal", () => {
    const plan = planOf("endurance", "race_pace");
    expect(
      withTargets(plan, null, { settings: null, raceDistanceM: 10000 })
        .sessions[0].targetHeartRate,
    ).toBeNull();
    expect(targetZones(plan, null)).toEqual([2, null]);
  });
});
