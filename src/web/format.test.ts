import { describe, expect, it } from "vitest";
import {
  formatDistance,
  formatDuration,
  formatHeartrate,
  formatPace,
  formatStartDate,
} from "./format";

describe("formatDistance", () => {
  it("shows kilometres with two decimals", () => {
    expect(formatDistance(8432)).toBe("8,43 km");
    expect(formatDistance(0)).toBe("0,00 km");
  });

  it("rounds half-way distances up to the next 10 m", () => {
    expect(formatDistance(9995)).toBe("10,00 km");
    expect(formatDistance(1005)).toBe("1,01 km");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00:00"],
    [59.5, "0:01:00"],
    [59.6, "0:01:00"],
    [3599.5, "1:00:00"],
    [3600, "1:00:00"],
    [3000, "0:50:00"],
    [3725, "1:02:05"],
    [36000, "10:00:00"],
    [360000, "100:00:00"],
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
    [59.5, "1:00/km"],
    [599.5, "10:00/km"],
    [0, "0:00/km"],
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

  it("shows the start in the requested time zone", () => {
    const lateEvening = "2026-10-29T23:30:00Z";
    const utc = formatStartDate(lateEvening, "UTC");
    const paris = formatStartDate(lateEvening, "Europe/Paris");

    expect(utc).toContain("29");
    expect(utc).toContain("23:30");
    expect(paris).toContain("30");
    expect(paris).toContain("00:30");
  });
});

describe("formatHeartrate", () => {
  it("rounds the average heart rate to the nearest beat", () => {
    expect(formatHeartrate(151.6)).toBe("152 bpm");
    expect(formatHeartrate(140)).toBe("140 bpm");
  });

  it("shows a dash when the heart rate is unknown", () => {
    expect(formatHeartrate(null)).toBe("–");
  });
});
