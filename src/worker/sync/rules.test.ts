import { describe, expect, it } from "vitest";
import {
  isRun,
  partitionActivities,
  purgeCutoff,
  syncWindowStart,
} from "./rules";

const NOW_MS = Date.parse("2026-10-30T04:00:00.000Z");

describe("isRun", () => {
  it.each(["Run", "TrailRun", "VirtualRun"])("keeps sport_type %s", (kind) => {
    expect(isRun({ id: 1, sport_type: kind, type: "Run" })).toBe(true);
  });

  it.each(["Ride", "Walk", "Hike", "Swim"])("rejects sport_type %s", (kind) => {
    expect(isRun({ id: 1, sport_type: kind, type: kind })).toBe(false);
  });

  it("lets sport_type take precedence over type", () => {
    expect(isRun({ id: 1, sport_type: "Walk", type: "Run" })).toBe(false);
  });

  it("falls back to type when sport_type is missing", () => {
    expect(isRun({ id: 1, type: "Run" })).toBe(true);
    expect(isRun({ id: 1, type: "Ride" })).toBe(false);
    expect(isRun({ id: 1 })).toBe(false);
  });
});

describe("time window", () => {
  it("starts the Strava query 7 days ago, in epoch seconds", () => {
    expect(syncWindowStart(NOW_MS)).toBe(
      Date.parse("2026-10-23T04:00:00.000Z") / 1000,
    );
  });

  it("purges what was fetched more than 7 days ago, in fetched_at format", () => {
    expect(purgeCutoff(NOW_MS)).toBe("2026-10-23T04:00:00.000Z");
  });
});

describe("partitionActivities", () => {
  it("separates runs from other activities", () => {
    const { runs, otherIds } = partitionActivities([
      { id: 1, sport_type: "Run" },
      { id: 2, sport_type: "Ride" },
      { id: 3, sport_type: "TrailRun" },
    ]);

    expect(runs.map((run) => run.id)).toEqual([1, 3]);
    expect(otherIds).toEqual([2]);
  });

  it("deduplicates by id, keeping the last occurrence", () => {
    const { runs } = partitionActivities([
      { id: 1, sport_type: "Run", name: "first" },
      { id: 1, sport_type: "Run", name: "second" },
    ]);

    expect(runs).toEqual([{ id: 1, sport_type: "Run", name: "second" }]);
  });

  it("ignores items without a valid id", () => {
    const { runs, otherIds } = partitionActivities([
      null,
      "x",
      { sport_type: "Run" },
      { id: "1", sport_type: "Run" },
      { id: 1.5, sport_type: "Run" },
    ]);

    expect(runs).toEqual([]);
    expect(otherIds).toEqual([]);
  });
});
