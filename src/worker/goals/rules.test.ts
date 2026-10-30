import { describe, expect, it } from "vitest";
import { parseDuration, utcIsoDate, validateGoal, type Goal } from "./rules";

const TODAY = "2026-10-30";
const valid: Goal = {
  distanceM: 10000,
  raceDate: "2027-04-11",
  targetTimeS: 2700,
  referenceDistanceM: 5000,
  referenceTimeS: 1380,
  availableDays: [6, 2, 4],
};

function errorsOf(input: unknown) {
  const result = validateGoal(input, TODAY);
  return result.ok ? {} : result.errors;
}

describe("parseDuration", () => {
  it.each([
    ["45:00", 2700],
    ["1:05:30", 3930],
    ["90:00", 5400],
    [" 0:59 ", 59],
  ])("parses %s", (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
  });

  it.each(["", "45", "45:60", "1:60:00", "abc", "1:2:3", "-5:00"])(
    "rejects %j",
    (text) => {
      expect(parseDuration(text)).toBeNull();
    },
  );
});

describe("utcIsoDate", () => {
  it("returns the UTC calendar date", () => {
    expect(utcIsoDate(Date.parse("2026-10-30T23:30:00Z"))).toBe("2026-10-30");
  });
});

describe("validateGoal", () => {
  it("accepts a valid goal and sorts the days", () => {
    expect(validateGoal(valid, TODAY)).toEqual({
      ok: true,
      goal: { ...valid, availableDays: [2, 4, 6] },
    });
  });

  it("accepts a goal without target time", () => {
    expect(validateGoal({ ...valid, targetTimeS: null }, TODAY).ok).toBe(true);
  });

  // Un chrono n'est vérifié qu'une fois sa distance valide (bornes propres à la distance).
  it("rejects a non-object input without checking times", () => {
    expect(Object.keys(errorsOf("oops")).sort()).toEqual([
      "availableDays",
      "distanceM",
      "raceDate",
      "referenceDistanceM",
    ]);
  });

  it.each([0, 7000, 21097.5, "10000"])("rejects distance %j", (distanceM) => {
    expect(errorsOf({ ...valid, distanceM }).distanceM).toBe(
      "Choisis une distance cible.",
    );
  });

  it("rejects an unknown reference distance", () => {
    expect(
      errorsOf({ ...valid, referenceDistanceM: 3000 }).referenceDistanceM,
    ).toBeDefined();
  });

  it.each([TODAY, "2026-10-29"])("rejects the past or today (%s)", (date) => {
    expect(errorsOf({ ...valid, raceDate: date }).raceDate).toBe(
      "La date de course doit être dans le futur.",
    );
  });

  it("accepts tomorrow", () => {
    expect(validateGoal({ ...valid, raceDate: "2026-10-31" }, TODAY).ok).toBe(
      true,
    );
  });

  it.each(["2027-02-30", "11/04/2027", "", 20270411])(
    "rejects the invalid date %j",
    (raceDate) => {
      expect(errorsOf({ ...valid, raceDate }).raceDate).toBe(
        "Saisis une date de course valide.",
      );
    },
  );

  it.each([0, -60, 2700.5, "45:00", undefined])(
    "rejects the target time %j",
    (targetTimeS) => {
      expect(errorsOf({ ...valid, targetTimeS }).targetTimeS).toMatch(
        /h:mm:ss ou mm:ss/,
      );
    },
  );

  it("rejects a time faster than the world record", () => {
    expect(errorsOf({ ...valid, targetTimeS: 1570 }).targetTimeS).toBe(
      "Ce chrono est plus rapide que le record du monde du 10 km.",
    );
    expect(validateGoal({ ...valid, targetTimeS: 1571 }, TODAY).ok).toBe(true);
  });

  it("rejects a pace slower than 15 min/km", () => {
    expect(errorsOf({ ...valid, referenceTimeS: 4501 }).referenceTimeS).toBe(
      "Ce chrono correspond à une allure plus lente que 15 min/km.",
    );
    expect(validateGoal({ ...valid, referenceTimeS: 4500 }, TODAY).ok).toBe(
      true,
    );
  });

  it("requires a reference time", () => {
    expect(
      errorsOf({ ...valid, referenceTimeS: null }).referenceTimeS,
    ).toBeDefined();
  });

  it.each([[[]], [[3]]])("rejects fewer than 2 days (%j)", (availableDays) => {
    expect(errorsOf({ ...valid, availableDays }).availableDays).toBe(
      "Coche au moins 2 jours disponibles.",
    );
  });

  it.each([[[1, 1]], [[0, 2]], [[2, 8]], [[1.5, 2]], ["1,2"]])(
    "rejects invalid days %j",
    (availableDays) => {
      expect(errorsOf({ ...valid, availableDays }).availableDays).toBe(
        "Jours disponibles invalides.",
      );
    },
  );
});
