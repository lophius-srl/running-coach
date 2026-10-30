import { describe, expect, it } from "vitest";
import {
  formatDistance,
  formatDuration,
  formatPace,
  formatStartDate,
} from "./format";

describe("formatDistance", () => {
  it("shows kilometres with two decimals", () => {
    expect(formatDistance(8432)).toBe("8,43 km");
    expect(formatDistance(0)).toBe("0,00 km");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00:00"],
    [59.6, "0:01:00"],
    [3000, "0:50:00"],
    [3725, "1:02:05"],
    [36000, "10:00:00"],
  ])("formats %s s as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe("formatPace", () => {
  it.each([
    [300, "5:00/km"],
    [299.6, "5:00/km"],
    [334.4, "5:34/km"],
    [65, "1:05/km"],
  ])("formats %s s/km as %s", (pace, expected) => {
    expect(formatPace(pace)).toBe(expected);
  });

  it("shows a dash when the pace is unknown", () => {
    expect(formatPace(null)).toBe("–");
  });
});

describe("formatStartDate", () => {
  it("shows the day and time of the start", () => {
    const formatted = formatStartDate("2026-10-29T06:05:00Z", "UTC");
    expect(formatted).toContain("29");
    expect(formatted).toContain("oct");
    expect(formatted).toContain("06:05");
  });
});
