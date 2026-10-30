import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { app } from "../index";
import type { Bindings } from "../env";
import { resetDatabase } from "../test-db";

const DAY_MS = 24 * 60 * 60 * 1000;
const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
  ).run();
});

// La route filtre sur l'heure réelle : les dates de départ sont relatives à maintenant.
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function insertRun(id: number, userId: number, startDate: string) {
  const payload = {
    id,
    name: `run ${id}`,
    sport_type: "Run",
    start_date: startDate,
    distance: 8000,
    moving_time: 2400,
    average_heartrate: 150,
    map: { summary_polyline: "secret" },
  };
  return env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, JSON.stringify(payload), new Date().toISOString())
    .run();
}

async function sessionCookie(userId: number) {
  const cookie = await generateSignedCookie(
    "session",
    `${userId}.9999999999`,
    testEnv.SESSION_SECRET,
    { prefix: "host", secure: true, path: "/" },
  );
  return cookie.split(";")[0];
}

function getActivities(headers: HeadersInit = {}) {
  return app.request(
    "https://coach.example/api/activities",
    { headers },
    testEnv,
  );
}

describe("GET /api/activities", () => {
  it("requires a session", async () => {
    expect((await getActivities()).status).toBe(401);
  });

  it("returns the session user's runs of the last 7 days with totals", async () => {
    const recent = daysAgo(1);
    await insertRun(10, 1, daysAgo(3));
    await insertRun(11, 1, recent);
    await insertRun(12, 1, daysAgo(8));
    await insertRun(20, 2, daysAgo(1));

    const response = await getActivities({ Cookie: await sessionCookie(1) });

    expect(response.status).toBe(200);
    const body = await response.json<{
      runs: { id: number }[];
      total: unknown;
    }>();
    expect(body.runs.map((run) => run.id)).toEqual([11, 10]);
    expect(body.runs[0]).toEqual({
      id: 11,
      name: "run 11",
      startDate: recent,
      distanceM: 8000,
      movingTimeS: 2400,
      paceSPerKm: 300,
      averageHeartrate: 150,
    });
    expect(body.total).toEqual({
      count: 2,
      distanceM: 16000,
      movingTimeS: 4800,
    });
  });

  it("returns an empty list when nothing is synced", async () => {
    const response = await getActivities({ Cookie: await sessionCookie(1) });

    expect(await response.json()).toEqual({
      runs: [],
      total: { count: 0, distanceM: 0, movingTimeS: 0 },
    });
  });
});
