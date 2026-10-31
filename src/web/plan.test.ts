import { describe, expect, it } from "vitest";
import { formatPlanDay, planErrorMessage } from "./plan";

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
