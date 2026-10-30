import { describe, expect, it } from "vitest";
import { paceSecondsPerKm, parseRun, summarizeRecentRuns } from "./recent";

const NOW_MS = Date.parse("2026-10-30T04:00:00.000Z");

const payload = (fields: Record<string, unknown>) =>
  JSON.stringify({
    id: 1,
    name: "Footing",
    start_date: "2026-10-29T06:00:00Z",
    distance: 10000,
    moving_time: 3000,
    ...fields,
  });

describe("paceSecondsPerKm", () => {
  it("divides the moving time by the distance in km", () => {
    expect(paceSecondsPerKm(10000, 3000)).toBe(300);
    expect(paceSecondsPerKm(5500, 1650)).toBe(300);
  });

  it("is null for a zero distance", () => {
    expect(paceSecondsPerKm(0, 600)).toBeNull();
  });
});

describe("parseRun", () => {
  it("keeps only the displayed fields", () => {
    expect(
      parseRun(payload({ average_heartrate: 148.3, map: { polyline: "x" } })),
    ).toEqual({
      id: 1,
      name: "Footing",
      startDate: "2026-10-29T06:00:00Z",
      distanceM: 10000,
      movingTimeS: 3000,
      paceSPerKm: 300,
      averageHeartrate: 148.3,
    });
  });

  it("leaves the heart rate empty when Strava has none", () => {
    expect(parseRun(payload({}))?.averageHeartrate).toBeNull();
    expect(
      parseRun(payload({ average_heartrate: "150" }))?.averageHeartrate,
    ).toBeNull();
    expect(
      parseRun(payload({ average_heartrate: 0 }))?.averageHeartrate,
    ).toBeNull();
  });

  it("leaves a negative heart rate empty", () => {
    expect(
      parseRun(payload({ average_heartrate: -1 }))?.averageHeartrate,
    ).toBeNull();
  });

  it("keeps a zero-distance run with an unknown pace", () => {
    const run = parseRun(payload({ distance: 0, moving_time: 600 }));

    expect(run?.distanceM).toBe(0);
    expect(run?.paceSPerKm).toBeNull();
  });

  it("defaults a missing name to an empty string", () => {
    expect(parseRun(payload({ name: null }))?.name).toBe("");
  });

  it.each([
    ["invalid JSON", "not json"],
    ["null", "null"],
    ["an array", "[]"],
    ["a missing id", payload({ id: undefined })],
    ["a string id", payload({ id: "1" })],
    ["a missing start date", payload({ start_date: undefined })],
    ["an invalid start date", payload({ start_date: "hier" })],
    ["a missing distance", payload({ distance: undefined })],
    ["a negative distance", payload({ distance: -1 })],
    ["a missing moving time", payload({ moving_time: undefined })],
    ["a string moving time", payload({ moving_time: "3000" })],
  ])("rejects %s", (_label, raw) => {
    expect(parseRun(raw)).toBeNull();
  });
});

describe("summarizeRecentRuns", () => {
  it("lists runs of the last 7 days, most recent first, with totals", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, start_date: "2026-10-25T06:00:00Z" }),
        payload({ id: 2, start_date: "2026-10-29T06:00:00Z", distance: 5000 }),
        payload({ id: 3, start_date: "2026-10-27T06:00:00Z" }),
      ],
      NOW_MS,
    );

    expect(summary.runs.map((run) => run.id)).toEqual([2, 3, 1]);
    expect(summary.total).toEqual({
      count: 3,
      distanceM: 25000,
      movingTimeS: 9000,
    });
  });

  it("excludes runs started more than 7 days ago", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, start_date: "2026-10-23T04:00:00Z" }), // pile 7 jours
        payload({ id: 2, start_date: "2026-10-23T03:59:59Z" }),
      ],
      NOW_MS,
    );

    expect(summary.runs.map((run) => run.id)).toEqual([1]);
  });

  it("compares start dates as instants, whatever their UTC offset", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, start_date: "2026-10-23T06:00:00+02:00" }), // = 04:00Z, pile 7 jours
        payload({ id: 2, start_date: "2026-10-23T05:59:59+02:00" }),
      ],
      NOW_MS,
    );

    expect(summary.runs.map((run) => run.id)).toEqual([1]);
  });

  it("keeps the input order for runs started at the same time", () => {
    const sameStart = { start_date: "2026-10-28T06:00:00Z" };
    const summary = summarizeRecentRuns(
      [payload({ id: 7, ...sameStart }), payload({ id: 3, ...sameStart })],
      NOW_MS,
    );

    expect(summary.runs.map((run) => run.id)).toEqual([7, 3]);
  });

  it("counts a zero-distance run in the totals", () => {
    const summary = summarizeRecentRuns(
      [payload({ id: 1 }), payload({ id: 2, distance: 0, moving_time: 600 })],
      NOW_MS,
    );

    expect(summary.total).toEqual({
      count: 2,
      distanceM: 10000,
      movingTimeS: 3600,
    });
  });

  it("skips malformed payloads without failing", () => {
    const summary = summarizeRecentRuns(["{}", "oops", payload({})], NOW_MS);

    expect(summary.runs.map((run) => run.id)).toEqual([1]);
  });

  it("returns an empty list and zero totals without runs", () => {
    expect(summarizeRecentRuns([], NOW_MS)).toEqual({
      runs: [],
      total: { count: 0, distanceM: 0, movingTimeS: 0 },
    });
  });
});
