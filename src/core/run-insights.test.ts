import { describe, expect, it } from "vitest";
import { trainingPaces } from "./paces";
import {
  heartRateZone,
  metersPerBeat,
  paceZone,
  weekShare,
} from "./run-insights";

describe("paceZone", () => {
  // Allures publiées à VDOT 50 (src/core/paces.ts), pour caler les bornes sur l'affichage.
  const paces = trainingPaces({
    distanceM: 10000,
    targetTimeS: null,
    vdot: 50,
  });

  it.each([
    [paces.endurance.slowSPerKm + 30, "recovery"],
    [paces.endurance.slowSPerKm - 1, "endurance"],
    [paces.endurance.fastSPerKm + 1, "endurance"],
    [paces.endurance.fastSPerKm - 10, "tempo"],
    [paces.threshold.slowSPerKm - 0.4, "threshold"],
    [paces.vma.slowSPerKm + 3, "above_threshold"],
    [paces.vma.fastSPerKm, "vma"],
    [paces.vma.fastSPerKm - 20, "vma"],
  ])("puts a %f s/km run in %s at VDOT 50", (pace, zone) => {
    expect(paceZone(pace, 50)).toBe(zone);
  });

  it("is unknown without a pace or a level", () => {
    expect(paceZone(null, 50)).toBeNull();
    expect(paceZone(300, null)).toBeNull();
    expect(paceZone(0, 50)).toBeNull();
  });
});

describe("heartRateZone", () => {
  const zones = [
    { low: 100, high: 120 },
    { low: 120, high: 140 },
    { low: 140, high: 160 },
    { low: 160, high: 175 },
    { low: 175, high: 190 },
  ];

  it.each([
    [100, 1],
    [119.9, 1],
    [120, 2],
    [152, 3],
    [175, 5],
    [200, 5],
  ])("puts %f bpm in zone %i", (heartrate, zone) => {
    expect(heartRateZone(heartrate, zones)).toBe(zone);
  });

  it("is unknown below Z1, without heart rate or without zones", () => {
    expect(heartRateZone(90, zones)).toBeNull();
    expect(heartRateZone(null, zones)).toBeNull();
    expect(heartRateZone(150, null)).toBeNull();
  });
});

describe("metersPerBeat", () => {
  it("divides the speed in m/min by the mean heart rate", () => {
    // 10 km en 50 min = 200 m/min, à 150 bpm.
    expect(metersPerBeat(10000, 3000, 150)).toBeCloseTo(1.333, 3);
  });

  it("is unknown without heart rate, distance or time", () => {
    expect(metersPerBeat(10000, 3000, null)).toBeNull();
    expect(metersPerBeat(10000, 3000, 0)).toBeNull();
    expect(metersPerBeat(0, 3000, 150)).toBeNull();
    expect(metersPerBeat(10000, 0, 150)).toBeNull();
  });
});

describe("weekShare", () => {
  it("is the run distance over the week distance", () => {
    expect(weekShare(5000, 20000)).toBe(0.25);
  });

  it("is unknown for an empty week", () => {
    expect(weekShare(0, 0)).toBeNull();
  });
});
