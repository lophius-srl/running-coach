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
import { karvonenZones } from "../../core/heart-rate";
import { vdot } from "../../core/paces";
import { paceZone } from "../../core/run-insights";
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
    total_elevation_gain: 120,
    map: { summary_polyline: "secret" },
  };
  return env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, JSON.stringify(payload), new Date().toISOString())
    .run();
}

// Niveau tiré d'un 10 km en 40:00 de l'historique importé, et zones cardiaques de Karvonen.
async function insertLevelAndZones() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s)
       VALUES (1, 99, ?, 'Run', 10000, 2400)`,
    ).bind(daysAgo(10)),
    env.DB.prepare(
      "INSERT INTO heart_rate_zones (user_id, resting_hr, max_hr, zones) VALUES (1, 50, 190, ?)",
    ).bind(JSON.stringify(karvonenZones(50, 190))),
  ]);
}

// Contenu de toutes les tables applicatives, pour vérifier qu'une lecture n'écrit rien.
async function databaseContent(): Promise<Record<string, unknown[]>> {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  const content: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    content[name] = results;
  }
  return content;
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
    expect(body.runs[0]).toMatchObject({
      id: 11,
      name: "run 11",
      startDate: recent,
      distanceM: 8000,
      movingTimeS: 2400,
      paceSPerKm: 300,
      averageHeartrate: 150,
      elevationGainM: 120,
      elevationPerKm: 15,
      surface: "road",
      weekShare: 0.5,
    });
    expect(body.runs[0]).not.toHaveProperty("map");
    expect(body.total).toEqual({
      count: 2,
      distanceM: 16000,
      movingTimeS: 4800,
      elevationGainM: 240,
      elevationPerKm: 15,
    });
  });

  it("returns an empty list when nothing is synced", async () => {
    const response = await getActivities({ Cookie: await sessionCookie(1) });

    expect(await response.json()).toEqual({
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

  it("returns only the runs of the session user", async () => {
    await insertRun(10, 1, daysAgo(1));
    await insertRun(20, 2, daysAgo(1));

    const response = await getActivities({ Cookie: await sessionCookie(2) });

    const body = await response.json<{ runs: { id: number }[] }>();
    expect(body.runs.map((run) => run.id)).toEqual([20]);
  });

  it("skips a malformed payload instead of failing", async () => {
    await insertRun(10, 1, daysAgo(1));
    await env.DB.prepare(
      "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (11, 1, 'oops', ?)",
    )
      .bind(new Date().toISOString())
      .run();

    const response = await getActivities({ Cookie: await sessionCookie(1) });

    expect(response.status).toBe(200);
    const body = await response.json<{ runs: { id: number }[] }>();
    expect(body.runs.map((run) => run.id)).toEqual([10]);
  });

  it("returns an empty elevation gain for a run Strava sent without one", async () => {
    const payload = {
      id: 10,
      start_date: daysAgo(1),
      distance: 5000,
      moving_time: 1500,
    };
    await env.DB.prepare(
      "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, 1, ?, ?)",
    )
      .bind(10, JSON.stringify(payload), new Date().toISOString())
      .run();

    const response = await getActivities({ Cookie: await sessionCookie(1) });

    const body = await response.json<{
      runs: { elevationGainM: unknown; elevationPerKm: unknown }[];
      total: { elevationGainM: unknown; elevationPerKm: unknown };
    }>();
    expect(body.runs[0]).toMatchObject({
      elevationGainM: null,
      elevationPerKm: null,
    });
    expect(body.total).toMatchObject({
      elevationGainM: null,
      elevationPerKm: null,
    });
  });

  it("situates each run against the current level and heart rate zones", async () => {
    await insertLevelAndZones();
    await insertRun(10, 1, daysAgo(1));

    const response = await getActivities({ Cookie: await sessionCookie(1) });

    const body = await response.json<{ runs: Record<string, unknown>[] }>();
    expect(body.runs[0]).toMatchObject({
      paceZone: paceZone(300, vdot(10000, 2400)),
      heartRateZone: 3, // 150 bpm dans Z3 (148 – 162) de Karvonen 50 / 190
      metersPerBeat: 200 / 150,
      vdot: vdot(8000, 2400),
      weekShare: 1,
    });
  });

  it("computes every figure and zone on the fly without writing to the database", async () => {
    await insertLevelAndZones();
    await insertRun(10, 1, daysAgo(1));
    const before = await databaseContent();

    const response = await getActivities({ Cookie: await sessionCookie(1) });

    expect(response.status).toBe(200);
    const body = await response.json<{ runs: { paceZone: unknown }[] }>();
    expect(body.runs[0].paceZone).not.toBeNull();
    expect(await databaseContent()).toEqual(before);
  });

  describe("with a frozen clock", () => {
    const NOW = new Date("2026-10-30T04:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps a run started exactly 7 days ago and drops one a second older", async () => {
      await insertRun(10, 1, "2026-10-23T04:00:00.000Z");
      await insertRun(11, 1, "2026-10-23T03:59:59.000Z");

      const response = await getActivities({ Cookie: await sessionCookie(1) });

      const body = await response.json<{ runs: { id: number }[] }>();
      expect(body.runs.map((run) => run.id)).toEqual([10]);
    });
  });
});
