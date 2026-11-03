// QA de l'issue #69 : séances montre fusionnées dans les lectures (D1), cas limites.
// Trois sources pour une même sortie (CSV, API, montre), fuseau, fenêtre de 8 semaines,
// niveau (#46), ajustement du plan (#16), « Ma semaine », et aucune écriture à la lecture.
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
import { vdot } from "../../core/paces";
import { adjustPlan } from "../../core/plan-adjust";
import type { WeekPlan } from "../../core/plan";
import type { ProgressionResponse } from "../../core/progression";
import type { Bindings } from "../env";
import { loadFitness, loadRuns } from "../goals/fitness";
import { APP_TIME_ZONE, localIsoDate, zonedMidnightMs } from "../goals/rules";
import { app } from "../index";
import { resetDatabase } from "../test-db";
import type { RecentRuns } from "./recent";

const NOW = "2026-11-04T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await resetDatabase(env.DB);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)",
  ).run();
});
afterEach(() => vi.useRealTimers());

function apiRun(id: number, fields: Record<string, unknown>) {
  const payload = {
    id,
    name: `Strava ${id}`,
    sport_type: "Run",
    distance: 10_050,
    moving_time: 3010,
    average_cadence: 86,
    kudos_count: 3,
    ...fields,
  };
  return env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, 1, ?, ?)",
  )
    .bind(id, JSON.stringify(payload), NOW)
    .run();
}

function csvRun(id: number, startDate: string, distanceM = 10_050) {
  return env.DB.prepare(
    `INSERT INTO imported_activities (user_id, id, start_date, sport_type, name, distance_m,
       moving_time_s) VALUES (1, ?, ?, 'Run', 'Footing CSV', ?, 3010)`,
  )
    .bind(id, startDate, distanceM)
    .run();
}

async function watchRun(
  startDate: string,
  distanceM = 10_000,
  movingTimeS = 2990,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO watch_activities (user_id, fit_sha256, start_date, sport_type, distance_m,
       moving_time_s, elapsed_time_s) VALUES (1, ?, ?, 'Run', ?, ?, ?) RETURNING id`,
  )
    .bind(`sha-${startDate}`, startDate, distanceM, movingTimeS, movingTimeS)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

async function get<T>(path: string): Promise<T> {
  const cookie = await generateSignedCookie(
    "session",
    "1.9999999999",
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

const daysAgo = (days: number) =>
  new Date(NOW_MS - days * DAY_MS).toISOString();

describe("une même sortie dans le CSV, l'API et la montre", () => {
  beforeEach(async () => {
    await csvRun(501, "2026-11-03T07:00:00.000Z");
    await apiRun(501, { start_date: "2026-11-03T07:00:00Z" });
    await watchRun("2026-11-03T07:01:00.000Z");
  });

  it("n'en reste qu'une pour le niveau et le plan, avec les mesures de la montre", async () => {
    const runs = await loadRuns(env.DB, 1, NOW_MS);
    expect(runs).toEqual([
      expect.objectContaining({
        id: 501,
        distanceM: 10_000,
        movingTimeS: 2990,
      }),
    ]);
  });

  it("n'est comptée qu'une fois dans la progression", async () => {
    const data = await get<ProgressionResponse>(
      "/api/progression?period=all&group=month",
    );
    const total = data.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(1);
  });

  it("n'a qu'une carte dans « Ma semaine »", async () => {
    const { runs } = await get<RecentRuns>("/api/activities");
    expect(runs.map((run) => run.id)).toEqual([501]);
  });
});

describe("une sortie du CSV seul (hors des 7 jours de l'API) et sa séance montre", () => {
  it("ne font qu'une course, avec l'id Strava du CSV", async () => {
    await csvRun(400, daysAgo(20));
    await watchRun(new Date(NOW_MS - 20 * DAY_MS + 90_000).toISOString());
    const runs = await loadRuns(env.DB, 1, NOW_MS);
    expect(runs.map((run) => [run.id, run.distanceM])).toEqual([[400, 10_000]]);
  });
});

describe("fuseau horaire", () => {
  it("rapproche le départ UTC de la montre du start_date UTC de Strava, pas de l'heure locale", async () => {
    await apiRun(501, {
      start_date: "2026-11-03T07:00:00Z",
      start_date_local: "2026-11-03T08:00:00Z",
    });
    await watchRun("2026-11-03T07:03:30.000Z");
    const { runs } = await get<RecentRuns>("/api/activities");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 501,
      startDate: "2026-11-03T07:03:30.000Z",
      startDateLocal: "2026-11-03T08:03:30Z",
    });
  });
});

describe("séance montre de plus de 8 semaines", () => {
  beforeEach(async () => {
    await watchRun(daysAgo(70), 10_000, 2400);
  });

  it("est ignorée par le niveau", async () => {
    expect(await loadFitness(env.DB, 1, NOW_MS)).toBeNull();
  });

  it("apparaît dans la progression « tout »", async () => {
    const data = await get<ProgressionResponse>(
      "/api/progression?period=all&group=month",
    );
    const total = data.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(1);
    expect(data.lastRunDate).toBe(daysAgo(70));
  });
});

describe("séance montre seule et calculs du coaching", () => {
  it("donne le niveau (VDOT, #46)", async () => {
    const id = await watchRun(daysAgo(3), 10_000, 2400);
    const fitness = await loadFitness(env.DB, 1, NOW_MS);
    expect(fitness?.run.id).toBe(-id);
    expect(fitness?.vdot).toBeCloseTo(vdot(10_000, 2400), 6);
  });

  // 170 min prévues ; 240 min courues à la montre la semaine d'avant → volume élevé (> 130 %).
  const plan: WeekPlan = {
    weekStart: "2026-11-09",
    phase: "development",
    sessions: [
      { date: "2026-11-10", kind: "vma", durationMin: 50, description: "VMA" },
      {
        date: "2026-11-12",
        kind: "endurance",
        durationMin: 45,
        description: "F",
      },
      { date: "2026-11-14", kind: "long", durationMin: 75, description: "SL" },
    ],
  };
  const adjust = async () =>
    adjustPlan(
      plan,
      await loadRuns(env.DB, 1, NOW_MS),
      zonedMidnightMs(plan.weekStart, APP_TIME_ZONE),
      localIsoDate(NOW_MS, APP_TIME_ZONE),
    );

  it("compte dans le volume récent qui ajuste le plan (#16)", async () => {
    await watchRun("2026-11-03T07:00:00.000Z", 40_000, 240 * 60);
    expect((await adjust()).adjustment?.kind).toBe("high_volume");
  });

  it("évite la « reprise en douceur » quand c'est la seule course récente", async () => {
    await csvRun(300, daysAgo(20));
    expect((await adjust()).adjustment?.kind).toBe("restart");
    await watchRun("2026-11-03T07:00:00.000Z", 10_000, 50 * 60);
    expect((await adjust()).adjustment).toBeNull();
  });
});

describe("« Ma semaine » avec des séances montre", () => {
  async function seed() {
    await apiRun(601, { start_date: "2026-11-03T07:00:00Z", distance: 10_000 });
    await watchRun("2026-11-03T07:02:00.000Z", 10_100, 3000);
    const alone = await watchRun("2026-11-02T18:00:00.000Z", 6000, 1800);
    await apiRun(602, {
      start_date: "2026-11-01T07:00:00Z",
      distance: 8000,
      moving_time: 2400,
    });
    return alone;
  }

  it("trie les cartes de la plus récente à la plus ancienne, séance montre comprise", async () => {
    const alone = await seed();
    const { runs } = await get<RecentRuns>("/api/activities");
    expect(runs.map((run) => run.id)).toEqual([601, -alone, 602]);
  });

  it("compte chaque sortie une seule fois dans les totaux", async () => {
    await seed();
    const { total } = await get<RecentRuns>("/api/activities");
    expect(total).toMatchObject({
      count: 3,
      distanceM: 10_100 + 6000 + 8000,
      movingTimeS: 3000 + 1800 + 2400,
    });
  });

  it("calcule la part de la semaine de la séance montre seule", async () => {
    const alone = await seed();
    const { runs } = await get<RecentRuns>("/api/activities");
    const card = runs.find((run) => run.id === -alone);
    expect(card?.weekShare).toBeCloseTo(6000 / 24_100, 6);
  });
});

describe("rien de dérivé n'est stocké", () => {
  async function snapshot() {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();
    const tables: Record<string, unknown[]> = {};
    for (const { name } of results) {
      tables[name] = (
        await env.DB.prepare(`SELECT * FROM "${name}"`).all()
      ).results;
    }
    return tables;
  }

  it("les lectures fusionnées n'écrivent rien en base", async () => {
    await apiRun(601, { start_date: "2026-11-03T07:00:00Z" });
    await csvRun(400, daysAgo(20));
    await watchRun("2026-11-03T07:02:00.000Z");
    await watchRun(daysAgo(2));
    const before = await snapshot();

    await get("/api/activities");
    await get("/api/progression?period=all&group=week");
    await get("/api/plan");
    await loadFitness(env.DB, 1, NOW_MS);

    expect(await snapshot()).toEqual(before);
  });
});
