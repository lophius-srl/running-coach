// Fusion des séances montre (ADR 0005, issue #69) dans les routes de lecture : « Ma semaine »,
// progression et courses du niveau (loadRuns).
import { applyD1Migrations, env } from "cloudflare:test";
import { generateSignedCookie } from "hono/cookie";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ProgressionResponse } from "../../core/progression";
import type { Bindings } from "../env";
import { loadRuns } from "../goals/fitness";
import { app } from "../index";
import { resetDatabase } from "../test-db";
import type { RecentRuns } from "./recent";

const NOW = "2026-11-04T12:00:00.000Z";
const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await resetDatabase(env.DB);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
  ).run();
});
afterEach(() => vi.useRealTimers());

function syncRun(userId: number, id: number, fields: Record<string, unknown>) {
  const payload = {
    id,
    name: "Footing Strava",
    sport_type: "Run",
    distance: 10_050,
    moving_time: 3010,
    elapsed_time: 3100,
    average_heartrate: 151,
    average_cadence: 86,
    kudos_count: 3,
    total_elevation_gain: 40,
    start_date_local: "2026-11-03T08:00:00Z",
    ...fields,
  };
  return env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, JSON.stringify(payload), NOW)
    .run();
}

function watchRun(
  userId: number,
  startDate: string,
  sportType = "Run",
  distanceM = 10_000,
) {
  return env.DB.prepare(
    `INSERT INTO watch_activities (user_id, fit_sha256, start_date, sport_type, distance_m,
       moving_time_s, elapsed_time_s, elevation_gain_m, average_heartrate, max_heartrate)
     VALUES (?, ?, ?, ?, ?, 2990, 3200, 55, NULL, 182) RETURNING id`,
  )
    .bind(userId, `${userId}-${startDate}`, startDate, sportType, distanceM)
    .first<{ id: number }>();
}

async function get<T>(path: string, userId = 1): Promise<T> {
  const cookie = await generateSignedCookie(
    "session",
    `${userId}.9999999999`,
    testEnv.SESSION_SECRET,
    { prefix: "host", secure: true, path: "/" },
  );
  const response = await app.request(
    `https://coach.example${path}`,
    { headers: { Cookie: cookie.split(";")[0] } },
    testEnv,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

// Une sortie Strava rapprochée (2 min d'écart), une séance montre seule, un vélo montre, et une
// séance montre de l'utilisateur 2 au même moment que la sortie Strava de l'utilisateur 1.
async function seed() {
  await syncRun(1, 501, { start_date: "2026-11-03T07:00:00Z" });
  const matched = await watchRun(1, "2026-11-03T07:02:00Z");
  const alone = await watchRun(1, "2026-11-01T17:00:00Z", "TrailRun", 6000);
  await watchRun(1, "2026-11-02T10:00:00Z", "Ride", 40_000);
  await watchRun(2, "2026-11-03T07:00:00Z");
  return { matched: matched?.id ?? 0, alone: alone?.id ?? 0 };
}

describe("GET /api/activities : séances montre", () => {
  it("enrichit la carte Strava des mesures de la montre et garde ses champs riches", async () => {
    await seed();
    const { runs } = await get<RecentRuns>("/api/activities");
    expect(runs[0]).toMatchObject({
      id: 501,
      name: "Footing Strava",
      startDate: "2026-11-03T07:02:00Z",
      startDateLocal: "2026-11-03T08:02:00Z",
      distanceM: 10_000,
      movingTimeS: 2990,
      paceSPerKm: 299,
      elapsedTimeS: 3200,
      pauseS: 210,
      elevationGainM: 55,
      averageHeartrate: 151, // absente de la montre : celle de Strava
      maxHeartrate: 182,
      cadenceSpm: 172,
      kudosCount: 3,
    });
  });

  it("ajoute une carte pour la séance montre sans Strava, sans le vélo ni l'autre utilisateur", async () => {
    const { alone } = await seed();
    const { runs, total } = await get<RecentRuns>("/api/activities");
    expect(runs.map((run) => run.id)).toEqual([501, -alone]);
    expect(runs[1]).toMatchObject({
      name: "Séance Suunto",
      sportType: "TrailRun",
      surface: "trail",
      distanceM: 6000,
      averageHeartrate: null,
      cadenceSpm: null,
      kudosCount: null,
    });
    expect(total).toMatchObject({ count: 2, distanceM: 16_000 });
  });

  it("montre à l'utilisateur 2 sa seule séance montre", async () => {
    await seed();
    const { runs } = await get<RecentRuns>("/api/activities", 2);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ name: "Séance Suunto", distanceM: 10_000 });
    expect(runs[0].id).toBeLessThan(0);
  });
});

describe("loadRuns : séances montre", () => {
  it("fusionne sans doublon et isole les utilisateurs", async () => {
    const { alone } = await seed();
    const runs = await loadRuns(env.DB, 1, Date.parse(NOW));
    expect(runs.map((run) => [run.id, run.distanceM])).toEqual([
      [501, 10_000],
      [-alone, 6000],
    ]);
    const other = await loadRuns(env.DB, 2, Date.parse(NOW));
    expect(other.map((run) => run.distanceM)).toEqual([10_000]);
  });
});

describe("GET /api/progression : séances montre", () => {
  it("compte une fois la sortie rapprochée, avec les mesures de la montre", async () => {
    await seed();
    const data = await get<ProgressionResponse>(
      "/api/progression?period=3m&group=month",
    );
    const november = data.buckets.find((b) => b.start === "2026-11-01");
    expect(november).toMatchObject({
      count: 2,
      distanceM: 16_000,
      movingTimeS: 5980,
      elevationGainM: 110,
    });
    expect(data.lastRunDate).toBe("2026-11-03T07:02:00Z");
  });
});
