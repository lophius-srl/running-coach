import { describe, expect, it } from "vitest";
import { vdot } from "../../core/paces";
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

  it("is null for a zero moving time", () => {
    expect(paceSecondsPerKm(5000, 0)).toBeNull();
  });
});

describe("parseRun", () => {
  it("keeps only the displayed fields", () => {
    expect(
      parseRun(
        payload({
          sport_type: "TrailRun",
          workout_type: 1,
          average_heartrate: 148.3,
          max_heartrate: 181,
          total_elevation_gain: 245,
          distance: 8450,
          elapsed_time: 3210,
          max_speed: 5,
          average_cadence: 86.4,
          elev_low: -12.4,
          elev_high: 230.6,
          suffer_score: 87,
          pr_count: 2,
          achievement_count: 5,
          kudos_count: 0,
          map: { polyline: "x" },
        }),
      ),
    ).toEqual({
      id: 1,
      name: "Footing",
      startDate: "2026-10-29T06:00:00Z",
      startDateLocal: null,
      sportType: "TrailRun",
      surface: "trail",
      workout: "race",
      distanceM: 8450,
      movingTimeS: 3000,
      elapsedTimeS: 3210,
      pauseS: 210,
      paceSPerKm: 3000 / 8.45,
      maxPaceSPerKm: 200,
      averageHeartrate: 148.3,
      maxHeartrate: 181,
      cadenceSpm: 173,
      elevationGainM: 245,
      elevationPerKm: 29,
      elevLowM: -12.4,
      elevHighM: 230.6,
      sufferScore: 87,
      prCount: 2,
      achievementCount: 5,
      kudosCount: 0,
    });
  });

  it("leaves every optional field empty when Strava has none", () => {
    expect(parseRun(payload({}))).toMatchObject({
      sportType: "",
      surface: "road",
      workout: null,
      elapsedTimeS: null,
      pauseS: null,
      maxPaceSPerKm: null,
      maxHeartrate: null,
      cadenceSpm: null,
      elevLowM: null,
      elevHighM: null,
      sufferScore: null,
      prCount: null,
      achievementCount: null,
      kudosCount: null,
    });
  });

  it.each([
    ["a string", "12"],
    ["a negative number", -3],
    ["an infinite number", Infinity],
    ["null", null],
    ["a boolean", true],
  ])("leaves optional figures empty when they are %s", (_label, value) => {
    const run = parseRun(
      payload({
        elapsed_time: value,
        max_speed: value,
        max_heartrate: value,
        average_cadence: value,
        suffer_score: value,
        pr_count: value,
        achievement_count: value,
        kudos_count: value,
      }),
    );
    expect(run).toMatchObject({
      elapsedTimeS: null,
      pauseS: null,
      maxPaceSPerKm: null,
      maxHeartrate: null,
      cadenceSpm: null,
      sufferScore: null,
      prCount: null,
      achievementCount: null,
      kudosCount: null,
    });
  });

  it("leaves non-finite or non-numeric altitudes empty", () => {
    const raw = `{"id":1,"start_date":"2026-10-29T06:00:00Z","distance":10000,"moving_time":3000,"elev_low":-1e999,"elev_high":"230"}`;
    expect(parseRun(raw)).toMatchObject({ elevLowM: null, elevHighM: null });
  });

  it("ignores fractional counts and a zero max speed or cadence", () => {
    expect(
      parseRun(payload({ pr_count: 1.5, max_speed: 0, average_cadence: 0 })),
    ).toMatchObject({ prCount: null, maxPaceSPerKm: null, cadenceSpm: null });
  });

  it.each([
    ["slower than the average pace", 3],
    ["more than 3 times the average speed", 10.1],
  ])("ignores a max speed %s", (_label, maxSpeed) => {
    // Vitesse moyenne : 10 km en 3 000 s = 3,33 m/s.
    expect(
      parseRun(payload({ max_speed: maxSpeed }))?.maxPaceSPerKm,
    ).toBeNull();
  });

  it("keeps a max speed up to 3 times the average speed", () => {
    expect(parseRun(payload({ max_speed: 10 }))?.maxPaceSPerKm).toBe(100);
  });

  it("keeps the local start time Strava sends with a fake Z suffix", () => {
    expect(
      parseRun(payload({ start_date_local: "2026-10-29T07:00:00Z" }))
        ?.startDateLocal,
    ).toBe("2026-10-29T07:00:00Z");
  });

  it.each([
    undefined,
    "demain",
    1730000000,
    "2026-10-29T07:00:00+09:00",
    "2026-10-29T07:00:00.000Z",
    "2026-10-29",
  ])("leaves the local start time empty when it is %o", (local) => {
    expect(
      parseRun(payload({ start_date_local: local }))?.startDateLocal,
    ).toBeNull();
  });

  it("never reports a negative pause when the elapsed time is shorter", () => {
    expect(parseRun(payload({ elapsed_time: 2900 }))?.pauseS).toBe(0);
  });

  it.each([
    [{ sport_type: "Run" }, "road"],
    [{ sport_type: "TrailRun" }, "trail"],
    [{ sport_type: "Run", trainer: true }, "treadmill"],
    [{ sport_type: "TrailRun", trainer: true }, "treadmill"],
    [{ sport_type: "VirtualRun" }, "treadmill"],
    [{ type: "Run", trainer: "true" }, "road"],
  ])("reads the surface of %o as %s", (fields, surface) => {
    expect(parseRun(payload(fields))?.surface).toBe(surface);
  });

  it.each([
    [0, null],
    [1, "race"],
    [2, "long"],
    [3, "intervals"],
    [12, null],
    ["1", null],
    ["constructor", null],
  ])("reads workout_type %o as %s", (workoutType, workout) => {
    expect(parseRun(payload({ workout_type: workoutType }))?.workout).toBe(
      workout,
    );
  });

  it("leaves the elevation gain and its ratio empty when Strava has none", () => {
    for (const raw of [
      payload({}),
      payload({ total_elevation_gain: "120" }),
      payload({ total_elevation_gain: -5 }),
      payload({ total_elevation_gain: null }),
    ]) {
      expect(parseRun(raw)).toMatchObject({
        elevationGainM: null,
        elevationPerKm: null,
      });
    }
  });

  it("leaves the elevation gain empty when it is not a finite number", () => {
    const raw = (gain: string) =>
      `{"id":1,"start_date":"2026-10-29T06:00:00Z","distance":10000,"moving_time":3000,"total_elevation_gain":${gain}}`;
    for (const gain of [
      "1e999",
      "-1e999",
      "true",
      "[120]",
      '{"m":120}',
      '""',
    ]) {
      expect(parseRun(raw(gain))).toMatchObject({
        elevationGainM: null,
        elevationPerKm: null,
      });
    }
  });

  it("keeps a fractional elevation gain as Strava sends it", () => {
    expect(
      parseRun(payload({ total_elevation_gain: 12.3, distance: 10000 })),
    ).toMatchObject({ elevationGainM: 12.3, elevationPerKm: 1 });
  });

  it("still returns the run when only the elevation gain is unusable", () => {
    expect(parseRun(payload({ total_elevation_gain: "abc" }))?.id).toBe(1);
  });

  it("keeps a zero elevation gain (flat or treadmill run)", () => {
    expect(parseRun(payload({ total_elevation_gain: 0 }))).toMatchObject({
      elevationGainM: 0,
      elevationPerKm: 0,
    });
  });

  it("has no elevation ratio for a zero distance", () => {
    expect(
      parseRun(payload({ total_elevation_gain: 10, distance: 0 })),
    ).toMatchObject({ elevationGainM: 10, elevationPerKm: null });
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

describe("parseRun edge cases (QA #60)", () => {
  it.each([10, 11])("ignores the cycling workout_type %i", (workoutType) => {
    expect(
      parseRun(payload({ workout_type: workoutType }))?.workout,
    ).toBeNull();
  });

  it.each([1, "yes", null])(
    "does not treat a non-boolean trainer %o as a treadmill",
    (trainer) => {
      expect(parseRun(payload({ sport_type: "Run", trainer }))?.surface).toBe(
        "road",
      );
    },
  );

  it("falls back on the legacy type when sport_type is missing", () => {
    expect(parseRun(payload({ type: "TrailRun" }))).toMatchObject({
      sportType: "TrailRun",
      surface: "trail",
    });
  });

  it("prefers sport_type over the legacy type", () => {
    expect(
      parseRun(payload({ sport_type: "VirtualRun", type: "Run" }))?.surface,
    ).toBe("treadmill");
  });

  it("reports no pause when elapsed and moving times are equal", () => {
    expect(parseRun(payload({ elapsed_time: 3000 }))?.pauseS).toBe(0);
  });

  it("leaves the relative effort empty when suffer_score is null", () => {
    expect(parseRun(payload({ suffer_score: null }))?.sufferScore).toBeNull();
  });

  it("keeps a zero kudos count", () => {
    expect(parseRun(payload({ kudos_count: 0 }))?.kudosCount).toBe(0);
  });

  it("drops inconsistent altitudes whose low is above the high", () => {
    expect(parseRun(payload({ elev_low: 230, elev_high: 12 }))).toMatchObject({
      elevLowM: null,
      elevHighM: null,
    });
  });

  it("keeps a flat run whose low and high altitudes are equal", () => {
    expect(parseRun(payload({ elev_low: 35, elev_high: 35 }))).toMatchObject({
      elevLowM: 35,
      elevHighM: 35,
    });
  });

  it("does not expose the map nor any unknown Strava field", () => {
    const run = parseRun(
      payload({ map: { summary_polyline: "x" }, athlete: { id: 7 } }),
    );
    expect(run).not.toHaveProperty("map");
    expect(run).not.toHaveProperty("athlete");
  });
});

describe("summarizeRecentRuns insights", () => {
  const zones = [
    { low: 100, high: 120 },
    { low: 120, high: 140 },
    { low: 140, high: 160 },
    { low: 160, high: 175 },
    { low: 175, high: 190 },
  ];

  it("situates each run against the current level, heart rate zones and week", () => {
    const summary = summarizeRecentRuns(
      [
        // 5:30/km : endurance à VDOT 50 (5:07 – 5:38/km).
        payload({
          id: 1,
          sport_type: "Run",
          moving_time: 3300,
          average_heartrate: 150,
        }),
        payload({
          id: 2,
          start_date: "2026-10-28T06:00:00Z",
          sport_type: "Run",
          distance: 30000,
        }),
      ],
      NOW_MS,
      { vdot: 50, heartRateZones: zones },
    );

    expect(summary.runs[0]).toMatchObject({
      id: 1,
      paceZone: "endurance",
      heartRateZone: 3,
      metersPerBeat: 10000 / 55 / 150,
      vdot: vdot(10000, 3300),
      weekShare: 0.25,
    });
    expect(summary.runs[1]).toMatchObject({
      heartRateZone: null,
      metersPerBeat: null,
      weekShare: 0.75,
    });
  });

  it("leaves the zones empty without level nor heart rate zones", () => {
    const [run] = summarizeRecentRuns(
      [payload({ sport_type: "Run", average_heartrate: 150 })],
      NOW_MS,
    ).runs;

    expect(run).toMatchObject({ paceZone: null, heartRateZone: null });
  });

  it("gives no pace zone to a trail run, whose pace depends on the climb", () => {
    const [run] = summarizeRecentRuns(
      [payload({ sport_type: "TrailRun" })],
      NOW_MS,
      { vdot: 50, heartRateZones: null },
    ).runs;

    expect(run.paceZone).toBeNull();
  });

  it("gives no pace zone to intervals, whose mean pace mixes efforts and recoveries", () => {
    const [run] = summarizeRecentRuns(
      [payload({ sport_type: "Run", workout_type: 3, moving_time: 3300 })],
      NOW_MS,
      { vdot: 50, heartRateZones: null },
    ).runs;

    expect(run.paceZone).toBeNull();
  });

  it("gives no VDOT to a trail run", () => {
    const [run] = summarizeRecentRuns(
      [payload({ sport_type: "TrailRun", moving_time: 3300 })],
      NOW_MS,
    ).runs;

    expect(run.vdot).toBeNull();
  });

  it("has no VDOT for a run too short or without a running sport type", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, sport_type: "Run", distance: 2000, moving_time: 600 }),
        payload({ id: 2, start_date: "2026-10-28T06:00:00Z" }),
      ],
      NOW_MS,
    );

    expect(summary.runs.map((run) => run.vdot)).toEqual([null, null]);
  });

  it("has no week share when the week distance is zero", () => {
    const [run] = summarizeRecentRuns([payload({ distance: 0 })], NOW_MS).runs;

    expect(run.weekShare).toBeNull();
  });
});

describe("summarizeRecentRuns insights edge cases (QA #60)", () => {
  it("gives a pace zone to a treadmill run", () => {
    const [run] = summarizeRecentRuns(
      [payload({ sport_type: "VirtualRun", moving_time: 3300 })],
      NOW_MS,
      { vdot: 50, heartRateZones: null },
    ).runs;

    expect(run.paceZone).toBe("endurance");
  });

  it("has no efficiency for a zero-distance run with heart rate", () => {
    const [run] = summarizeRecentRuns(
      [payload({ distance: 0, average_heartrate: 150 })],
      NOW_MS,
    ).runs;

    expect(run.metersPerBeat).toBeNull();
  });

  it("gives a zero share to a zero-distance run in a non-empty week", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, distance: 0 }),
        payload({ id: 2, start_date: "2026-10-28T06:00:00Z" }),
      ],
      NOW_MS,
    );

    expect(summary.runs.map((run) => run.weekShare)).toEqual([0, 1]);
  });

  it("has a VDOT for a run of exactly 3 km and none just below", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, sport_type: "Run", distance: 3000, moving_time: 900 }),
        payload({
          id: 2,
          start_date: "2026-10-28T06:00:00Z",
          sport_type: "Run",
          distance: 2999,
          moving_time: 900,
        }),
      ],
      NOW_MS,
    );

    expect(summary.runs[0].vdot).toBe(vdot(3000, 900));
    expect(summary.runs[1].vdot).toBeNull();
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
      elevationGainM: null,
      elevationPerKm: null,
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

  it("excludes runs starting in the future", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, start_date: "2026-10-30T04:00:00Z" }), // maintenant
        payload({ id: 2, start_date: "2026-10-30T04:00:01Z" }),
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

  it("orders runs started at the same time by decreasing id", () => {
    const sameStart = { start_date: "2026-10-28T06:00:00Z" };
    const summary = summarizeRecentRuns(
      [
        payload({ id: 3, ...sameStart }),
        payload({ id: 7, ...sameStart }),
        payload({ id: 5, ...sameStart }),
      ],
      NOW_MS,
    );

    expect(summary.runs.map((run) => run.id)).toEqual([7, 5, 3]);
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
      elevationGainM: null,
      elevationPerKm: null,
    });
  });

  it("sums the elevation gain and divides it by the total distance", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, total_elevation_gain: 245, distance: 8450 }),
        payload({ id: 2, total_elevation_gain: 0, distance: 10000 }),
      ],
      NOW_MS,
    );

    expect(summary.total).toMatchObject({
      elevationGainM: 245,
      elevationPerKm: 13, // 245 m / 18,45 km = 13,3
    });
  });

  it("leaves runs without elevation gain out of the overall ratio", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, total_elevation_gain: 100, distance: 5000 }),
        payload({ id: 2, distance: 15000 }),
      ],
      NOW_MS,
    );

    expect(summary.total).toMatchObject({
      elevationGainM: 100,
      elevationPerKm: 20,
    });
  });

  it("leaves the overall ratio empty when every run with elevation gain has a zero distance", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, total_elevation_gain: 30, distance: 0 }),
        payload({ id: 2, distance: 10000 }),
      ],
      NOW_MS,
    );

    expect(summary.total).toMatchObject({
      elevationGainM: 30,
      elevationPerKm: null,
    });
  });

  it("adds the elevation gain of a zero-distance run to the overall ratio", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, total_elevation_gain: 50, distance: 0 }),
        payload({ id: 2, total_elevation_gain: 100, distance: 10000 }),
      ],
      NOW_MS,
    );

    expect(summary.total).toMatchObject({
      elevationGainM: 150,
      elevationPerKm: 15,
    });
  });

  it("computes the overall ratio from the totals, not as a mean of run ratios", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, total_elevation_gain: 100, distance: 5000 }), // 20 m/km
        payload({ id: 2, total_elevation_gain: 0, distance: 15000 }), // 0 m/km
      ],
      NOW_MS,
    );

    expect(summary.total.elevationPerKm).toBe(5); // et non 10
  });

  it("leaves the elevation gain of runs older than 7 days out of the totals", () => {
    const summary = summarizeRecentRuns(
      [
        payload({ id: 1, total_elevation_gain: 100 }),
        payload({
          id: 2,
          total_elevation_gain: 900,
          start_date: "2026-10-20T06:00:00Z",
        }),
      ],
      NOW_MS,
    );

    expect(summary.total).toMatchObject({
      elevationGainM: 100,
      elevationPerKm: 10,
    });
  });

  it("skips malformed payloads without failing", () => {
    const summary = summarizeRecentRuns(["{}", "oops", payload({})], NOW_MS);

    expect(summary.runs.map((run) => run.id)).toEqual([1]);
  });

  it("returns an empty list and zero totals without runs", () => {
    expect(summarizeRecentRuns([], NOW_MS)).toEqual({
      runs: [],
      total: {
        count: 0,
        distanceM: 0,
        movingTimeS: 0,
        elevationGainM: null,
        elevationPerKm: null,
      },
    });
  });
});
