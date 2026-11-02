import { describe, expect, it } from "vitest";
import {
  karvonenZones,
  raceHeartRateZone,
  sessionHeartRateZone,
  validateHeartRate,
  type HeartRateZone,
} from "./heart-rate";

function zones(...bounds: number[]): HeartRateZone[] {
  return bounds.slice(0, -1).map((low, i) => ({ low, high: bounds[i + 1] }));
}

// FC repos 50, FC max 190 : réserve 140 bpm, bornes à 50, 60, 70, 80, 90 et 100 %.
const valid = {
  restingHr: 50,
  maxHr: 190,
  zones: zones(120, 134, 148, 162, 176, 190),
};

describe("karvonenZones", () => {
  it("applies resting + % × reserve at 50, 60, 70, 80, 90 and 100 %", () => {
    expect(karvonenZones(50, 190)).toEqual(zones(120, 134, 148, 162, 176, 190));
  });

  it("rounds each bound to the nearest bpm, halves up", () => {
    // Réserve 125 : 62,5 → 63 ; 75 ; 87,5 → 88 ; 100 ; 112,5 → 113 ; 125.
    expect(karvonenZones(60, 185)).toEqual(zones(123, 135, 148, 160, 173, 185));
    // Réserve 131 : 65,5 → 66 ; 78,6 → 79 ; 91,7 → 92 ; 104,8 → 105 ; 117,9 → 118.
    expect(karvonenZones(48, 179)).toEqual(zones(114, 127, 140, 153, 166, 179));
  });

  it("produces contiguous zones that end at the max heart rate", () => {
    const result = karvonenZones(55, 201);
    expect(result).toHaveLength(5);
    expect(result[4].high).toBe(201);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].low).toBe(result[i - 1].high);
    }
  });

  it("produces zones that pass validation on the input bounds", () => {
    for (const [rest, max] of [
      [30, 230],
      [120, 230],
      [30, 121],
      [100, 150],
    ]) {
      const result = validateHeartRate({
        restingHr: rest,
        maxHr: max,
        zones: karvonenZones(rest, max),
      });
      expect(result.ok).toBe(true);
    }
  });

  it("rounds exact halves up for every valid pair of heart rates", () => {
    // Référence en entiers (centièmes de bpm) : aucune erreur d'arrondi flottant.
    for (let rest = 30; rest <= 120; rest++) {
      for (let max = Math.max(rest + 1, 120); max <= 230; max++) {
        const expected = [50, 60, 70, 80, 90, 100].map((percent) =>
          Math.floor((rest * 100 + percent * (max - rest) + 50) / 100),
        );
        expect(karvonenZones(rest, max)).toEqual(zones(...expected));
      }
    }
  });

  it("produces valid zones as soon as the reserve reaches 10 bpm", () => {
    for (let rest = 30; rest <= 120; rest++) {
      for (let max = Math.max(rest + 10, 120); max <= 230; max++) {
        const result = validateHeartRate({
          restingHr: rest,
          maxHr: max,
          zones: karvonenZones(rest, max),
        });
        expect(result.ok).toBe(true);
      }
    }
  });

  it("produces empty zones for a tiny reserve, which validation rejects", () => {
    const result = validateHeartRate({
      restingHr: 119,
      maxHr: 121,
      zones: karvonenZones(119, 121),
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        zones: "Z1 : la borne basse doit être inférieure à la borne haute.",
        zone: 1,
        bound: "low",
      },
    });
  });
});

describe("validateHeartRate", () => {
  it("accepts valid settings and keeps only the expected fields", () => {
    const result = validateHeartRate({
      ...valid,
      extra: 1,
      zones: valid.zones.map((zone) => ({ ...zone, name: "x" })),
    });
    expect(result).toEqual({ ok: true, settings: valid });
  });

  it.each([
    [29, false],
    [30, true],
    [120, true],
    [121, false],
    [55.5, false],
    ["55", false],
    [null, false],
  ])("checks the resting heart rate %s (valid: %s)", (restingHr, ok) => {
    const result = validateHeartRate({
      ...valid,
      restingHr,
      maxHr: 230,
      zones: zones(130, 140, 150, 160, 170, 230),
    });
    expect(result.ok ? null : result.errors.restingHr).toBe(
      ok ? null : "Saisis ta FC repos en bpm, entre 30 et 120.",
    );
  });

  it.each([
    [119, false],
    [120, true],
    [230, true],
    [231, false],
    [Number.NaN, false],
    [undefined, false],
  ])("checks the max heart rate %s (valid: %s)", (maxHr, ok) => {
    const result = validateHeartRate({
      restingHr: 30,
      maxHr,
      zones: zones(60, 70, 80, 90, 100, 110),
    });
    expect(result.ok ? null : (result.errors.maxHr ?? null)).toBe(
      ok ? null : "Saisis ta FC max en bpm, entre 120 et 230.",
    );
  });

  it("requires the resting heart rate below the max", () => {
    const result = validateHeartRate({
      restingHr: 120,
      maxHr: 120,
      zones: valid.zones,
    });
    expect(result).toEqual({
      ok: false,
      errors: { maxHr: "Ta FC max doit être supérieure à ta FC repos." },
    });
  });

  it("requires exactly five zones", () => {
    for (const bad of [undefined, "zones", [], valid.zones.slice(0, 4)]) {
      const result = validateHeartRate({ ...valid, zones: bad });
      expect(result.ok ? null : result.errors.zones).toBe(
        "Renseigne les 5 zones.",
      );
    }
  });

  it("rejects six zones", () => {
    const six = [...valid.zones, { low: 190, high: 200 }];
    const result = validateHeartRate({ ...valid, maxHr: 200, zones: six });
    expect(result.ok ? null : result.errors.zones).toBe(
      "Renseigne les 5 zones.",
    );
  });

  it.each([
    ["infinite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["null", null],
    ["a boolean", true],
  ])("rejects a %s zone bound", (_label, low) => {
    const bad = valid.zones.map((zone, i) =>
      i === 0 ? { ...zone, low } : zone,
    );
    expect(validateHeartRate({ ...valid, zones: bad })).toEqual({
      ok: false,
      errors: {
        zones: "Z1 : saisis les deux bornes en bpm (nombres entiers).",
        zone: 1,
        bound: "low",
      },
    });
  });

  it.each([-50, Number.POSITIVE_INFINITY, 1e21, "", [55], { value: 55 }])(
    "rejects the resting heart rate %s",
    (restingHr) => {
      const result = validateHeartRate({ ...valid, restingHr });
      expect(result.ok ? null : result.errors.restingHr).toBe(
        "Saisis ta FC repos en bpm, entre 30 et 120.",
      );
    },
  );

  it("rejects a negative zone bound as below the resting heart rate", () => {
    const bad = valid.zones.map((zone, i) =>
      i === 0 ? { ...zone, low: -120 } : zone,
    );
    expect(validateHeartRate({ ...valid, zones: bad })).toEqual({
      ok: false,
      errors: {
        zones:
          "Z1 : la borne basse ne peut pas être sous ta FC repos (50 bpm).",
        zone: 1,
        bound: "low",
      },
    });
  });

  it("rejects a top bound above the max heart rate even when all zones are contiguous", () => {
    const result = validateHeartRate({
      ...valid,
      zones: zones(120, 134, 148, 162, 176, 191),
    });
    expect(result.ok ? null : result.errors).toEqual({
      zones: "Z5 : la borne haute ne peut pas dépasser ta FC max (190 bpm).",
      zone: 5,
      bound: "high",
    });
  });

  it("requires integer bounds", () => {
    const bad = valid.zones.map((zone, i) =>
      i === 2 ? { low: 148, high: "162" } : zone,
    );
    expect(validateHeartRate({ ...valid, zones: bad })).toEqual({
      ok: false,
      errors: {
        zones: "Z3 : saisis les deux bornes en bpm (nombres entiers).",
        zone: 3,
        bound: "high",
      },
    });
    const notObject = [...valid.zones.slice(0, 4), null];
    expect(validateHeartRate({ ...valid, zones: notObject })).toEqual({
      ok: false,
      errors: {
        zones: "Z5 : saisis les deux bornes en bpm (nombres entiers).",
        zone: 5,
        bound: "low",
      },
    });
  });

  it("rejects a zone whose low bound is not below its high bound", () => {
    const bad = zones(120, 134, 148, 148, 176, 190);
    expect(validateHeartRate({ ...valid, zones: bad })).toEqual({
      ok: false,
      errors: {
        zones: "Z3 : la borne basse doit être inférieure à la borne haute.",
        zone: 3,
        bound: "low",
      },
    });
  });

  it("rejects a gap between two zones", () => {
    const bad = valid.zones.map((zone, i) =>
      i === 1 ? { low: 135, high: 148 } : zone,
    );
    expect(validateHeartRate({ ...valid, zones: bad })).toEqual({
      ok: false,
      errors: {
        zones:
          "Z2 : la borne basse doit être égale à la borne haute de Z1 (134 bpm), sans chevauchement ni trou.",
        zone: 2,
        bound: "low",
      },
    });
  });

  it("rejects an overlap between two zones", () => {
    const bad = valid.zones.map((zone, i) =>
      i === 4 ? { low: 170, high: 190 } : zone,
    );
    expect(validateHeartRate({ ...valid, zones: bad })).toEqual({
      ok: false,
      errors: {
        zones:
          "Z5 : la borne basse doit être égale à la borne haute de Z4 (176 bpm), sans chevauchement ni trou.",
        zone: 5,
        bound: "low",
      },
    });
  });

  it("rejects decreasing zones", () => {
    const result = validateHeartRate({
      ...valid,
      zones: [...valid.zones].reverse(),
    });
    expect(result.ok).toBe(false);
  });

  it("keeps the zones between the resting and max heart rates", () => {
    expect(validateHeartRate({ ...valid, restingHr: 120 })).toEqual({
      ok: true,
      settings: { ...valid, restingHr: 120 },
    });
    expect(validateHeartRate({ ...valid, restingHr: 121 })).toMatchObject({
      ok: false,
    });
    expect(
      validateHeartRate({
        ...valid,
        restingHr: 119,
        zones: zones(118, 134, 148, 162, 176, 190),
      }),
    ).toEqual({
      ok: false,
      errors: {
        zones:
          "Z1 : la borne basse ne peut pas être sous ta FC repos (119 bpm).",
        zone: 1,
        bound: "low",
      },
    });
    expect(validateHeartRate({ ...valid, maxHr: 189 })).toEqual({
      ok: false,
      errors: {
        zones: "Z5 : la borne haute ne peut pas dépasser ta FC max (189 bpm).",
        zone: 5,
        bound: "high",
      },
    });
  });

  it("reports every invalid field at once", () => {
    const result = validateHeartRate(null);
    expect(result.ok ? null : Object.keys(result.errors).sort()).toEqual([
      "maxHr",
      "restingHr",
      "zones",
    ]);
  });
});

describe("sessionHeartRateZone", () => {
  it.each([
    ["endurance", 2],
    ["long", 2],
    ["recovery", 1],
    ["threshold", 4],
    ["vma", 5],
  ] as const)("maps %s to Z%s whatever the race", (kind, zone) => {
    expect(sessionHeartRateZone(kind, 42195)).toBe(zone);
    expect(sessionHeartRateZone(kind, null)).toBe(zone);
  });

  it.each([
    [5000, 5],
    [10000, 4],
    [21098, 4],
    [42195, 3],
  ])("maps race pace on %s m to Z%s", (distanceM, zone) => {
    expect(sessionHeartRateZone("race_pace", distanceM)).toBe(zone);
    expect(raceHeartRateZone(distanceM)).toBe(zone);
  });

  it("has no zone for race pace without a race distance", () => {
    expect(sessionHeartRateZone("race_pace", null)).toBeNull();
  });
});
