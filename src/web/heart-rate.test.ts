import { describe, expect, it } from "vitest";
import { validateHeartRate } from "../core/heart-rate";
import {
  computeZones,
  EMPTY_HEART_RATE_FORM,
  formatHeartRateTarget,
  toHeartRateForm,
  toHeartRateInput,
} from "./heart-rate";

const settings = {
  restingHr: 50,
  maxHr: 190,
  zones: [120, 134, 148, 162, 176].map((low) => ({ low, high: low + 14 })),
};

describe("heart rate form", () => {
  it("round-trips saved settings", () => {
    expect(toHeartRateInput(toHeartRateForm(settings))).toEqual(settings);
  });

  it("starts with 5 empty zones, which validation rejects with clear messages", () => {
    expect(EMPTY_HEART_RATE_FORM.zones).toHaveLength(5);
    const result = validateHeartRate(toHeartRateInput(EMPTY_HEART_RATE_FORM));
    expect(result).toEqual({
      ok: false,
      errors: {
        restingHr: "Saisis ta FC repos en bpm, entre 30 et 120.",
        maxHr: "Saisis ta FC max en bpm, entre 120 et 230.",
        zones: "Z1 : saisis les deux bornes en bpm (nombres entiers).",
        zone: 1,
        bound: "low",
      },
    });
  });

  it("trims spaces and accepts digits only", () => {
    const form = toHeartRateForm(settings);
    expect(toHeartRateInput({ ...form, restingHr: " 52 " }).restingHr).toBe(52);
    for (const text of ["190.5", "128.", "0x80", "1e2", "-60", "+60", "6 0"]) {
      expect(toHeartRateInput({ ...form, maxHr: text }).maxHr).toBeNaN();
    }
  });
});

describe("computeZones", () => {
  it("fills the 5 zones with Karvonen and keeps the heart rates", () => {
    const form = { ...EMPTY_HEART_RATE_FORM, restingHr: "50", maxHr: "190" };
    expect(computeZones(form)).toEqual({ form: toHeartRateForm(settings) });
  });

  it("returns only the heart rate errors when they are invalid", () => {
    expect(
      computeZones({ ...EMPTY_HEART_RATE_FORM, restingHr: "", maxHr: "190" }),
    ).toEqual({
      errors: { restingHr: "Saisis ta FC repos en bpm, entre 30 et 120." },
    });
    expect(
      computeZones({ ...EMPTY_HEART_RATE_FORM, restingHr: "60", maxHr: "50" }),
    ).toEqual({
      errors: { maxHr: "Saisis ta FC max en bpm, entre 120 et 230." },
    });
    expect(
      computeZones({
        ...EMPTY_HEART_RATE_FORM,
        restingHr: "120",
        maxHr: "120",
      }),
    ).toEqual({
      errors: { maxHr: "Ta FC max doit être supérieure à ta FC repos." },
    });
  });
});

describe("computeZones with a small heart rate reserve", () => {
  const compute = (restingHr: string, maxHr: string) =>
    computeZones({ ...EMPTY_HEART_RATE_FORM, restingHr, maxHr });

  it("refuses to compute below 10 bpm of reserve", () => {
    for (const [rest, max] of [
      ["119", "121"],
      ["111", "120"],
    ]) {
      expect(compute(rest, max)).toEqual({
        errors: {
          maxHr:
            "L'écart entre FC repos et FC max est trop faible pour calculer des zones.",
        },
      });
    }
  });

  it("computes valid zones from 10 bpm of reserve", () => {
    const result = compute("110", "120");
    expect(
      "form" in result && validateHeartRate(toHeartRateInput(result.form)).ok,
    ).toBe(true);
  });
});

describe("formatHeartRateTarget", () => {
  it("shows the zone and its bounds", () => {
    expect(formatHeartRateTarget({ zone: 2, low: 128, high: 141 })).toBe(
      "Z2 · 128–141 bpm",
    );
  });
});
