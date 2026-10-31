import { describe, expect, it } from "vitest";
import { stravaRunSample } from "./fitness";

const payload = {
  id: 12,
  sport_type: "TrailRun",
  type: "Run",
  start_date: "2026-10-29T07:00:00Z",
  distance: 10000,
  moving_time: 3000,
};

describe("stravaRunSample", () => {
  it("reads the fields used to estimate the level", () => {
    expect(stravaRunSample(JSON.stringify(payload))).toEqual({
      id: 12,
      sportType: "TrailRun",
      startDate: "2026-10-29T07:00:00Z",
      distanceM: 10000,
      movingTimeS: 3000,
    });
  });

  it("falls back on type without sport_type", () => {
    const old = JSON.stringify({ ...payload, sport_type: undefined });
    expect(stravaRunSample(old)?.sportType).toBe("Run");
  });

  it("falls back on type when sport_type is null", () => {
    const text = JSON.stringify({ ...payload, sport_type: null });
    expect(stravaRunSample(text)?.sportType).toBe("Run");
  });

  it("keeps a zero moving time, left to the level filters", () => {
    const text = JSON.stringify({ ...payload, moving_time: 0 });
    expect(stravaRunSample(text)?.movingTimeS).toBe(0);
  });

  it.each([
    "{oops",
    "null",
    JSON.stringify({ ...payload, id: "12" }),
    JSON.stringify({ ...payload, distance: null }),
    JSON.stringify({ ...payload, moving_time: "3000" }),
    JSON.stringify({ ...payload, start_date: 0 }),
    JSON.stringify({ ...payload, start_date: "pas une date" }),
    JSON.stringify({ ...payload, sport_type: 1, type: undefined }),
    JSON.stringify({ ...payload, moving_time: null }),
    JSON.stringify({ ...payload, distance: undefined }),
    JSON.stringify({ ...payload, id: 12.5 }),
    "[]",
    '"run"',
  ])("returns null for the unreadable payload %s", (text) => {
    expect(stravaRunSample(text)).toBeNull();
  });
});
