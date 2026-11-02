import { applyD1Migrations, env } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { app } from "../index";
import type { Bindings } from "../env";
import { resetDatabase } from "../test-db";
import type { ProgressionResponse } from "../../core/progression";
import { stravaProgressionRun } from "./routes";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
  ).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T10:00:00.000Z")); // mercredi
});

afterEach(() => {
  vi.useRealTimers();
});

async function sessionCookie(userId: number) {
  const cookie = await generateSignedCookie(
    "session",
    `${userId}.9999999999`,
    testEnv.SESSION_SECRET,
    { prefix: "host", secure: true, path: "/" },
  );
  return cookie.split(";")[0];
}

async function getProgression(query: string, userId: number | null = 1) {
  const headers: Record<string, string> = {};
  if (userId !== null) headers.Cookie = await sessionCookie(userId);
  return app.request(
    `https://coach.example/api/progression${query}`,
    { headers },
    testEnv,
  );
}

async function importRun(
  userId: number,
  id: number,
  startDate: string,
  distanceM = 10_000,
  sportType = "Run",
) {
  await env.DB.prepare(
    `INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m,
       moving_time_s, elevation_gain_m, average_heartrate)
     VALUES (?, ?, ?, ?, ?, ?, 50, 150)`,
  )
    .bind(userId, id, startDate, sportType, distanceM, distanceM * 0.3)
    .run();
}

async function syncRun(userId: number, payload: Record<string, unknown>) {
  await env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, ?, '2026-11-04T08:00:00.000Z')",
  )
    .bind(payload.id, userId, JSON.stringify(payload))
    .run();
}

describe("GET /api/progression", () => {
  it("exige une session", async () => {
    const response = await getProgression("?period=3m&group=week", null);
    expect(response.status).toBe(401);
  });

  it.each([
    "",
    "?period=3m",
    "?group=week",
    "?period=2y&group=week",
    "?period=3m&group=day",
    "?period=3M&group=week",
  ])("refuse les paramètres invalides %s", async (query) => {
    const response = await getProgression(query);
    expect(response.status).toBe(400);
  });

  it("renvoie des séries vides sans historique ni course récente", async () => {
    const response = await getProgression("?period=all&group=week");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      period: "all",
      group: "week",
      buckets: [],
      lastRunDate: null,
      lastImportedRunDate: null,
      historyStale: true,
    });
  });

  it("fusionne historique et API par id, l'API l'emporte", async () => {
    await importRun(1, 7, "2026-11-02T07:00:00.000Z", 10_000);
    await importRun(1, 8, "2026-10-20T07:00:00.000Z", 6000);
    await importRun(2, 9, "2026-11-02T07:00:00.000Z", 30_000); // autre utilisateur
    await syncRun(1, {
      id: 7,
      sport_type: "Run",
      start_date: "2026-11-02T07:00:00Z",
      distance: 12_000,
      moving_time: 3600,
      total_elevation_gain: 80,
      average_heartrate: 145,
    });
    const response = await getProgression("?period=3m&group=week");
    const body = await response.json<ProgressionResponse>();
    expect(body.buckets).toHaveLength(13);
    expect(body.buckets.at(-1)).toMatchObject({
      start: "2026-11-02",
      count: 1,
      distanceM: 12_000,
      elevationGainM: 80,
      heartrate: 145,
    });
    expect(body.buckets.at(-3)).toMatchObject({
      start: "2026-10-19",
      count: 1,
    });
    expect(Date.parse(body.lastRunDate ?? "")).toBe(
      Date.parse("2026-11-02T07:00:00Z"),
    );
    expect(body.lastImportedRunDate).toBe("2026-11-02T07:00:00.000Z");
    expect(body.historyStale).toBe(false);
  });

  it("signale un historique en retard et compte la course API la plus récente", async () => {
    await importRun(1, 1, "2025-03-10T07:00:00.000Z");
    await syncRun(1, {
      id: 2,
      sport_type: "Run",
      start_date: "2026-11-03T07:00:00Z",
      distance: 8000,
      moving_time: 2400,
    });
    const body = await (
      await getProgression("?period=all&group=month")
    ).json<ProgressionResponse>();
    expect(body.historyStale).toBe(true);
    expect(body.lastImportedRunDate).toBe("2025-03-10T07:00:00.000Z");
    expect(body.lastRunDate).toBe("2026-11-03T07:00:00Z");
    expect(body.buckets[0].start).toBe("2025-03-01");
    expect(body.buckets.at(-1)?.start).toBe("2026-11-01");
  });

  it("lit 8 semaines avant la période pour le niveau de la première", async () => {
    // 10 km en 40:00 le 1er juillet : compte encore dans la semaine du 10 août.
    await env.DB.prepare(
      `INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s)
       VALUES (1, 3, '2026-07-01T07:00:00.000Z', 'Run', 10000, 2400)`,
    ).run();
    const body = await (
      await getProgression("?period=3m&group=week")
    ).json<ProgressionResponse>();
    expect(body.buckets[0].start).toBe("2026-08-10");
    expect(body.buckets[0].count).toBe(0);
    expect(body.buckets[0].vdot).toBeGreaterThan(50);
  });
});

describe("stravaProgressionRun", () => {
  const base = {
    id: 4,
    sport_type: "Run",
    start_date: "2026-11-03T07:00:00Z",
    distance: 8000,
    moving_time: 2400,
  };

  it("lit le D+ et la FC moyenne", () => {
    const run = stravaProgressionRun(
      JSON.stringify({
        ...base,
        total_elevation_gain: 42,
        average_heartrate: 151.2,
      }),
    );
    expect(run).toMatchObject({ elevationGainM: 42, averageHeartrate: 151.2 });
  });

  it("met à null un D+ ou une FC absents ou incohérents", () => {
    const run = stravaProgressionRun(
      JSON.stringify({
        ...base,
        total_elevation_gain: -3,
        average_heartrate: 0,
      }),
    );
    expect(run).toMatchObject({ elevationGainM: null, averageHeartrate: null });
    expect(stravaProgressionRun("{oops")).toBeNull();
  });
});
