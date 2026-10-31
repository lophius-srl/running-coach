import { describe, expect, it } from "vitest";
import type { PlanSessionView } from "../worker/plans/view";
import {
  formatPlanDay,
  formatSessionDuration,
  replacedKindLabel,
  formatPlanPeriod,
  isPlanOver,
  planErrorMessage,
} from "./plan";

describe("formatPlanDay", () => {
  it("formats a calendar date without time zone shift", () => {
    expect(formatPlanDay("2026-11-03")).toBe("mardi 3 nov.");
    expect(formatPlanDay("2026-11-08")).toBe("dimanche 8 nov.");
  });
});

describe("planErrorMessage", () => {
  it("explains each refusal", () => {
    expect(planErrorMessage("no_goal")).toMatch(/objectif/);
    expect(planErrorMessage("no_days")).toMatch(/jours disponibles/);
    expect(planErrorMessage("no_paces")).toMatch(/allures/);
    expect(planErrorMessage("race_passed")).toMatch(/passée/);
  });

  it.each([undefined, "toString", 409])("falls back for %s", (error) => {
    expect(planErrorMessage(error)).toMatch(/réessaie/);
  });
});

describe("formatPlanPeriod", () => {
  it("shows the 7 days covered, across months", () => {
    expect(formatPlanPeriod("2026-11-03")).toBe(
      "Du mardi 3 nov. au lundi 9 nov.",
    );
    expect(formatPlanPeriod("2026-11-28")).toBe(
      "Du samedi 28 nov. au vendredi 4 déc.",
    );
  });
});

describe("isPlanOver", () => {
  it("is over once its last day has passed", () => {
    expect(isPlanOver("2026-11-03", "2026-11-03")).toBe(false);
    expect(isPlanOver("2026-11-03", "2026-11-09")).toBe(false);
    expect(isPlanOver("2026-11-03", "2026-11-10")).toBe(true);
    expect(isPlanOver("2026-12-28", "2027-01-04")).toBe(true);
  });
});

describe("adjusted sessions", () => {
  const session: PlanSessionView = {
    date: "2026-11-03",
    kind: "endurance",
    durationMin: 35,
    description: "",
    targetPace: null,
    planned: null,
  };

  it("shows the planned duration and kind only when changed", () => {
    expect(formatSessionDuration(session)).toBe("35 min");
    expect(replacedKindLabel(session)).toBeNull();
    const adjusted = { ...session, planned: { kind: "vma", durationMin: 50 } };
    expect(formatSessionDuration(adjusted as PlanSessionView)).toBe(
      "35 min (prévu 50)",
    );
    expect(replacedKindLabel(adjusted as PlanSessionView)).toBe(
      "prévu : Fractionné VMA",
    );
    const sameKind = {
      ...session,
      planned: { kind: "endurance", durationMin: 45 },
    };
    expect(replacedKindLabel(sameKind as PlanSessionView)).toBeNull();
  });
});
