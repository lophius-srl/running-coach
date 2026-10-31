import { describe, expect, it } from "vitest";
import {
  formatDay,
  formatDistance,
  formatDuration,
  formatHeartrate,
  formatPace,
  formatPaceRange,
  formatRunName,
  formatSpeedRange,
  formatStartDate,
  localIsoDate,
} from "./format";
import { parseDuration } from "../worker/goals/rules";

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

describe("formatPaceRange", () => {
  it("formats a range from the fastest to the slowest pace", () => {
    expect(formatPaceRange(305, 320)).toBe("5:05 – 5:20/km");
    expect(formatPaceRange(599.6, 605)).toBe("10:00 – 10:05/km");
  });
});

describe("formatSpeedRange", () => {
  it("converts a pace range to km/h, from the slowest to the fastest", () => {
    // 5:00/km = 12 km/h ; 6:00/km = 10 km/h.
    expect(formatSpeedRange(300, 360)).toBe("10,0 – 12,0 km/h");
    // 5:05/km ≈ 11,80 km/h ; 5:11/km ≈ 11,58 km/h.
    expect(formatSpeedRange(305, 311)).toBe("11,6 – 11,8 km/h");
  });
});

describe("formatDay", () => {
  it("shows the calendar day with the full month and year", () => {
    expect(formatDay("2021-03-14T07:02:11.000Z", "UTC")).toBe("14 mars 2021");
  });

  it("shows the day in the requested time zone", () => {
    expect(formatDay("2021-12-31T23:30:00.000Z", "Europe/Paris")).toBe(
      "1 janvier 2022",
    );
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

  it.each([
    [150.5, "151 bpm"],
    [150.49, "150 bpm"],
    [149.999, "150 bpm"],
  ])("rounds %s half up to %s", (heartrate, expected) => {
    expect(formatHeartrate(heartrate)).toBe(expected);
  });

  it("keeps three-digit heart rates whole", () => {
    expect(formatHeartrate(205.2)).toBe("205 bpm");
  });

  it("shows a dash when the heart rate is unknown", () => {
    expect(formatHeartrate(null)).toBe("–");
  });
});

describe("formatRunName", () => {
  it("keeps the Strava name, without surrounding spaces", () => {
    expect(formatRunName("Sortie longue")).toBe("Sortie longue");
    expect(formatRunName("  Fractionné  ")).toBe("Fractionné");
  });

  it.each(["", "   "])("falls back to a default title for %j", (name) => {
    expect(formatRunName(name)).toBe("Course sans titre");
  });
});

describe("localIsoDate", () => {
  it("formats the local calendar date with zero padding", () => {
    expect(localIsoDate(new Date(2027, 3, 1, 23, 59))).toBe("2027-04-01");
  });
});

// Le formulaire réaffiche un chrono enregistré avec formatDuration : il doit se relire tel quel.
describe("formatDuration and parseDuration", () => {
  it.each([59, 1380, 2700, 3402, 7235, 37975])(
    "round-trip %i s so a saved goal stays editable",
    (seconds) => {
      expect(parseDuration(formatDuration(seconds))).toBe(seconds);
    },
  );
});
