import { describe, expect, it } from "vitest";
import {
  APP_TIME_ZONE,
  localIsoDate,
  parseDuration,
  validateGoal,
  zonedMidnightMs,
  type Goal,
} from "./rules";

const TODAY = "2026-10-30";
const valid: Goal = {
  distanceM: 10000,
  raceDate: "2027-04-11",
  targetTimeS: 2700,
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

describe("zonedMidnightMs", () => {
  it.each([
    ["2026-11-02", "2026-11-01T23:00:00.000Z"], // heure d'hiver (UTC+1)
    ["2026-07-02", "2026-07-01T22:00:00.000Z"], // heure d'été (UTC+2)
    ["2026-03-29", "2026-03-28T23:00:00.000Z"], // jour du passage à l'heure d'été
    ["2026-10-25", "2026-10-24T22:00:00.000Z"], // jour du retour à l'heure d'hiver
  ])("returns midnight in Paris on %s", (date, expected) => {
    expect(new Date(zonedMidnightMs(date, APP_TIME_ZONE)).toISOString()).toBe(
      expected,
    );
  });

  it("returns UTC midnight in UTC", () => {
    expect(zonedMidnightMs("2026-11-02", "UTC")).toBe(
      Date.parse("2026-11-02T00:00:00Z"),
    );
  });
});

describe("localIsoDate", () => {
  const paris = (iso: string) => localIsoDate(Date.parse(iso), APP_TIME_ZONE);

  it("returns the calendar date in Paris, in winter and summer time", () => {
    expect(paris("2026-11-02T22:59:59.999Z")).toBe("2026-11-02");
    expect(paris("2026-11-02T23:30:00Z")).toBe("2026-11-03");
    expect(paris("2026-07-01T21:59:59.999Z")).toBe("2026-07-01");
    expect(paris("2026-07-01T22:30:00Z")).toBe("2026-07-02");
  });

  it("follows the requested time zone", () => {
    expect(localIsoDate(Date.parse("2026-10-30T23:30:00Z"), "UTC")).toBe(
      "2026-10-30",
    );
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
    ]);
  });

  it.each([0, 7000, 21097.5, "10000"])("rejects distance %j", (distanceM) => {
    expect(errorsOf({ ...valid, distanceM }).distanceM).toBe(
      "Choisis une distance cible.",
    );
  });

  // #46 : le chrono de référence n'existe plus ; un ancien client qui l'envoie n'est pas bloqué.
  it("ignores a legacy reference time, valid or not, and drops it", () => {
    const legacy = { ...valid, referenceDistanceM: 3000, referenceTimeS: "x" };

    expect(validateGoal(legacy, TODAY)).toEqual({
      ok: true,
      goal: { ...valid, availableDays: [2, 4, 6] },
    });
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

  it("treats a missing target time as no target", () => {
    const withoutTarget: Partial<Goal> = { ...valid };
    delete withoutTarget.targetTimeS;
    expect(validateGoal(withoutTarget, TODAY)).toEqual({
      ok: true,
      goal: { ...valid, targetTimeS: null, availableDays: [2, 4, 6] },
    });
  });

  it("rejects more than 7 days", () => {
    expect(
      errorsOf({ ...valid, availableDays: [1, 2, 3, 4, 5, 6, 7, 1] })
        .availableDays,
    ).toBe("Jours disponibles invalides.");
  });

  it.each([0, -60, 2700.5, "45:00"])(
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
    expect(errorsOf({ ...valid, targetTimeS: 9001 }).targetTimeS).toBe(
      "Ce chrono correspond à une allure plus lente que 15 min/km.",
    );
    expect(validateGoal({ ...valid, targetTimeS: 9000 }, TODAY).ok).toBe(true);
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

describe("parseDuration edge cases", () => {
  it.each([
    ["0:00", 0],
    ["00:00:59", 59],
    ["\t1:00\n", 60],
    ["100:00:00", 360000],
  ])("parses %j as %i s", (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
  });

  it.each([
    "1:60",
    "1:5",
    "1:05:5",
    "1:5:00",
    "1:00:00:00",
    "1 :00",
    "+1:00",
    "1:00.5",
    "٣:٠٠",
  ])("rejects %j", (text) => {
    expect(parseDuration(text)).toBeNull();
  });

  it("returns a duration that validateGoal rejects when it is absurdly large", () => {
    const seconds = parseDuration("999999999999999999:00");

    expect(errorsOf({ ...valid, targetTimeS: seconds }).targetTimeS).toMatch(
      /h:mm:ss ou mm:ss/,
    );
  });
});

describe("validateGoal edge cases", () => {
  it("accepts 29 February of a leap year", () => {
    expect(validateGoal({ ...valid, raceDate: "2028-02-29" }, TODAY).ok).toBe(
      true,
    );
  });

  it.each([
    "2027-02-29",
    "2026-1-5",
    "2027-13-01",
    "2027-04-11T00:00:00Z",
    " 2027-04-11",
    null,
  ])("rejects the invalid date %j", (raceDate) => {
    expect(errorsOf({ ...valid, raceDate }).raceDate).toBe(
      "Saisis une date de course valide.",
    );
  });

  it.each([
    [5000, 755, 754, 4500, 4501],
    [10000, 1571, 1570, 9000, 9001],
    [21098, 3402, 3401, 18988, 18989],
    [42195, 7235, 7234, 37975, 37976],
  ])(
    "bounds the target time on %i m (record %i s, max %i s)",
    (distanceM, record, faster, slowest, slower) => {
      const errorsFor = (targetTimeS: number) =>
        errorsOf({ ...valid, distanceM, targetTimeS }).targetTimeS;

      expect(errorsFor(record)).toBeUndefined();
      expect(errorsFor(faster)).toMatch(/record du monde/);
      expect(errorsFor(slowest)).toBeUndefined();
      expect(errorsFor(slower)).toMatch(/15 min\/km/);
    },
  );

  it("rejects an empty string as target time (only null means no target)", () => {
    expect(errorsOf({ ...valid, targetTimeS: "" }).targetTimeS).toMatch(
      /h:mm:ss ou mm:ss/,
    );
  });

  it("accepts every day of the week", () => {
    const result = validateGoal(
      { ...valid, availableDays: [7, 6, 5, 4, 3, 2, 1] },
      TODAY,
    );

    expect(result.ok && result.goal.availableDays).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it.each([
    [["1", "2"]],
    [[true, 2]],
    [[Number.NaN, 2]],
    [null],
    [{}],
    [[1, 2, 2]],
  ])("rejects invalid days %j", (availableDays) => {
    expect(errorsOf({ ...valid, availableDays }).availableDays).toBe(
      "Jours disponibles invalides.",
    );
  });

  it.each([null, [], 42])("rejects the non-object payload %j", (input) => {
    expect(validateGoal(input, TODAY).ok).toBe(false);
  });

  it("keeps only the known fields of the input", () => {
    const result = validateGoal({ ...valid, userId: 2, extra: "x" }, TODAY);

    expect(result.ok && Object.keys(result.goal).sort()).toEqual(
      Object.keys(valid).sort(),
    );
  });

  it("does not mutate the input days when sorting", () => {
    const availableDays = [6, 2];
    validateGoal({ ...valid, availableDays }, TODAY);

    expect(availableDays).toEqual([6, 2]);
  });
});
