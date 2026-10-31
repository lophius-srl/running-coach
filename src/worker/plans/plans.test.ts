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
import { trainingPaces, vdot } from "../../core/paces";
import type { PlanResponse } from "./view";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const goal = {
  distanceM: 10000,
  raceDate: "2027-04-11",
  targetTimeS: 2700,
  availableDays: [2, 4, 6],
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(() => resetDatabase(env.DB));
beforeEach(async () => {
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
  ).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T10:00:00.000Z")); // un lundi
});
afterEach(() => {
  vi.useRealTimers();
});

async function cookie(userId: number) {
  const signed = await generateSignedCookie(
    "session",
    `${userId}.9999999999`,
    testEnv.SESSION_SECRET,
    { prefix: "host", secure: true, path: "/" },
  );
  return signed.split(";")[0];
}

async function callPlan(userId: number, method: "GET" | "POST" = "GET") {
  return app.request(
    "https://coach.example/api/plan",
    { method, headers: { Cookie: await cookie(userId) } },
    testEnv,
  );
}

async function saveGoal(userId: number, raceDate = goal.raceDate) {
  await env.DB.prepare(
    "INSERT INTO goals (user_id, race_date, distance_m, target_time_s, available_days) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(userId, raceDate, goal.distanceM, goal.targetTimeS, "[2,4,6]")
    .run();
}

// Course importée il y a 3 jours (13 jours avec `startDate`) : base du niveau (VDOT) et donc
// des allures ; dans les 7 derniers jours, elle évite la reprise en douceur (#16).
async function importRun(
  userId: number,
  id: number,
  movingTimeS: number,
  startDate = "2026-10-30T07:00:00.000Z",
) {
  await env.DB.prepare(
    `INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s)
     VALUES (?, ?, ?, 'Run', 5000, ?)`,
  )
    .bind(userId, id, startDate, movingTimeS)
    .run();
}

// Activité Strava API (purgée à 7 jours) partie hier.
async function syncRun(userId: number, id: number, movingTimeS: number) {
  const payload = {
    id,
    sport_type: "Run",
    start_date: "2026-11-01T07:00:00.000Z",
    distance: 30000,
    moving_time: movingTimeS,
  };
  await env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, ?, '2026-11-01T08:00:00.000Z')",
  )
    .bind(id, userId, JSON.stringify(payload))
    .run();
}

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

const storedSessions = async () =>
  (
    await env.DB.prepare(
      "SELECT kind, duration_min FROM plan_sessions ORDER BY scheduled_date",
    ).all()
  ).results;

const BASE_SESSIONS = [
  { kind: "vma", duration_min: 50 },
  { kind: "endurance", duration_min: 45 },
  { kind: "long", duration_min: 75 },
];

const pacesFor = (movingTimeS: number) =>
  trainingPaces({ ...goal, vdot: vdot(5000, movingTimeS) });

describe("/api/plan", () => {
  it("requires a session", async () => {
    for (const method of ["GET", "POST"]) {
      const response = await app.request(
        "https://coach.example/api/plan",
        { method },
        testEnv,
      );
      expect(response.status).toBe(401);
    }
  });

  it("returns null before any plan is generated", async () => {
    expect(await (await callPlan(1)).json()).toEqual({ plan: null });
  });

  it("refuses to generate without a goal", async () => {
    await importRun(1, 1, 1380);
    const response = await callPlan(1, "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_goal" });
  });

  it("refuses to generate without available days", async () => {
    await env.DB.prepare(
      "INSERT INTO goals (user_id, race_date, distance_m) VALUES (1, '2027-04-11', 10000)",
    ).run();
    await importRun(1, 1, 1380);
    const response = await callPlan(1, "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_days" });
  });

  it("refuses to generate without paces", async () => {
    await saveGoal(1);
    const response = await callPlan(1, "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_paces" });
  });

  it("refuses to generate once the race is past", async () => {
    await saveGoal(1, "2026-11-02");
    await importRun(1, 1, 1380);
    const response = await callPlan(1, "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "race_passed" });
  });

  it("generates one session per available day with its target pace, then returns it", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    const paces = pacesFor(1380);

    const response = await callPlan(1, "POST");
    expect(response.status).toBe(200);
    const { plan } = await response.json<PlanResponse>();
    expect(plan).toMatchObject({
      weekStart: "2026-11-02",
      phase: "development",
      sessions: [
        { date: "2026-11-03", kind: "vma", targetPace: paces.vma },
        { date: "2026-11-05", kind: "endurance", targetPace: paces.endurance },
        { date: "2026-11-07", kind: "long", targetPace: paces.endurance },
      ],
    });
    expect(await (await callPlan(1)).json()).toEqual({ plan });
  });

  it("stores the plan without target paces", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    await callPlan(1, "POST");
    const plans = await env.DB.prepare(
      "SELECT week_start, phase FROM plans",
    ).all();
    const sessions = await env.DB.prepare(
      "SELECT * FROM plan_sessions ORDER BY scheduled_date",
    ).all<Record<string, unknown>>();
    expect(plans.results).toEqual([
      { week_start: "2026-11-02", phase: "development" },
    ]);
    expect(sessions.results.map((row) => Object.keys(row).sort())).toEqual(
      Array(3).fill([
        "description",
        "duration_min",
        "id",
        "kind",
        "plan_id",
        "scheduled_date",
      ]),
    );
  });

  it("recomputes target paces from the current level when reading", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    await callPlan(1, "POST");
    await importRun(1, 2, 1260); // 5 km plus rapide : meilleur niveau
    const { plan } = await (await callPlan(1)).json<PlanResponse>();
    expect(plan?.sessions[0].targetPace).toEqual(pacesFor(1260).vma);

    vi.setSystemTime(new Date("2027-01-10T10:00:00.000Z")); // course hors des 8 semaines
    const later = await (await callPlan(1)).json<PlanResponse>();
    expect(later.plan?.sessions[0]).toMatchObject({
      kind: "vma",
      targetPace: null,
    });
  });

  it("is deterministic and returns the latest plan", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    const first = await (await callPlan(1, "POST")).json();
    const second = await (await callPlan(1, "POST")).json();
    expect(second).toEqual(first);

    vi.setSystemTime(new Date("2026-11-05T10:00:00.000Z"));
    const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
    expect(plan?.weekStart).toBe("2026-11-05");
    expect(await (await callPlan(1)).json()).toEqual({ plan });
  });

  it.each([
    ["2026-11-02T23:30:00.000Z", "2026-11-03"], // 00:30 à Paris (UTC+1)
    ["2026-07-01T22:30:00.000Z", "2026-07-02"], // 00:30 à Paris (UTC+2, heure d'été)
  ])("starts the week on the Paris date at %s", async (now, weekStart) => {
    vi.setSystemTime(new Date(now));
    await saveGoal(1);
    await env.DB.prepare(
      `INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s)
       VALUES (1, 1, ?, 'Run', 5000, 1380)`,
    )
      .bind(new Date(Date.parse(now) - 3 * 86_400_000).toISOString())
      .run();
    const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
    expect(plan?.weekStart).toBe(weekStart);
  });

  it("refuses to generate on race day from 00:30 Paris time", async () => {
    await saveGoal(1, "2026-11-03");
    await importRun(1, 1, 1380);
    vi.setSystemTime(new Date("2026-11-02T23:30:00.000Z"));
    const response = await callPlan(1, "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "race_passed" });
  });

  it("keeps each user's plan separate", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    await callPlan(1, "POST");
    expect(await (await callPlan(2)).json()).toEqual({ plan: null });
  });

  it("returns a plan without sessions when the race is tomorrow on a rest day", async () => {
    await env.DB.prepare(
      "INSERT INTO goals (user_id, race_date, distance_m, available_days) VALUES (1, '2026-11-03', 10000, '[4,6]')",
    ).run();
    await importRun(1, 1, 1380);
    const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
    expect(plan).toEqual({
      weekStart: "2026-11-02",
      phase: "taper",
      sessions: [],
      adjustment: null,
    });
    expect(await (await callPlan(1)).json()).toEqual({ plan });
  });

  it("returns each user's own plan when both have one", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    await env.DB.prepare(
      "INSERT INTO goals (user_id, race_date, distance_m, available_days) VALUES (2, '2027-04-11', 5000, '[1,7]')",
    ).run();
    await importRun(2, 2, 1380);
    const own = await (await callPlan(1, "POST")).json<PlanResponse>();
    await callPlan(2, "POST");

    expect(await (await callPlan(1)).json()).toEqual(own);
    const other = await (await callPlan(2)).json<PlanResponse>();
    expect(other.plan?.sessions.map((s) => s.date)).toEqual([
      "2026-11-02",
      "2026-11-08",
    ]);
  });

  it("keeps showing the saved plan after a goal change, until regenerated", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    const before = await (await callPlan(1, "POST")).json<PlanResponse>();

    await env.DB.prepare(
      "UPDATE goals SET available_days = '[1,7]' WHERE user_id = 1",
    ).run();
    expect(await (await callPlan(1)).json()).toEqual(before);

    const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
    expect(plan?.sessions.map(({ date, kind }) => [date, kind])).toEqual([
      ["2026-11-02", "recovery"],
      ["2026-11-08", "long"],
    ]);
    expect(await (await callPlan(1)).json()).toEqual({ plan });
  });

  // Compatibilité N-1 : un plan écrit par le code précédent n'a ni week_start ni duration_min.
  it("ignores plans created before the week plan existed", async () => {
    await saveGoal(1);
    await env.DB.prepare(
      "INSERT INTO plans (goal_id) SELECT id FROM goals",
    ).run();
    await env.DB.prepare(
      "INSERT INTO plan_sessions (plan_id, scheduled_date, kind) SELECT max(id), '2026-11-03', 'endurance' FROM plans",
    ).run();
    expect(await (await callPlan(1)).json()).toEqual({ plan: null });
  });

  it("refuses to generate when the only runs are older than the fitness window", async () => {
    await saveGoal(1);
    await importRun(1, 1, 1380);
    vi.setSystemTime(new Date("2027-01-10T10:00:00.000Z"));
    const response = await callPlan(1, "POST");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_paces" });
  });

  it("generates the plan for a race the day after tomorrow", async () => {
    await saveGoal(1, "2026-11-04");
    await importRun(1, 1, 1380);
    const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
    expect(plan?.phase).toBe("taper");
    expect(plan?.sessions).toEqual([
      expect.objectContaining({
        date: "2026-11-03",
        kind: "endurance",
        durationMin: 25,
      }),
    ]);
  });

  describe("adjustment to recent runs (#16)", () => {
    it("does not adjust when the recent volume matches the plan", async () => {
      await saveGoal(1);
      await importRun(1, 1, 1380);
      const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
      expect(plan?.adjustment).toBeNull();
      expect(plan?.sessions.map((s) => s.planned)).toEqual([null, null, null]);
    });

    it("reduces the week after a much higher volume, on POST and GET", async () => {
      await saveGoal(1);
      await importRun(1, 1, 1380); // 23 min
      await syncRun(1, 10, 200 * 60); // 223 min > 170 × 1,3
      const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
      expect(plan?.adjustment).toEqual({
        kind: "high_volume",
        reason: expect.stringMatching(
          /^Volume récent élevé \(223 min .* −15 %\.$/,
        ),
      });
      expect(plan?.sessions).toMatchObject([
        { kind: "vma", durationMin: 50, planned: null },
        { kind: "endurance", durationMin: 40, planned: { durationMin: 45 } },
        { kind: "long", durationMin: 65, planned: { durationMin: 75 } },
      ]);
      expect(await (await callPlan(1)).json()).toEqual({ plan });
      expect(await storedSessions()).toEqual(BASE_SESSIONS);
    });

    it("restarts gently after 7 days without running, with matching paces", async () => {
      await saveGoal(1);
      await importRun(1, 1, 1380, "2026-10-20T07:00:00.000Z");
      const { plan } = await (await callPlan(1, "POST")).json<PlanResponse>();
      expect(plan?.adjustment?.kind).toBe("restart");
      expect(plan?.sessions[0]).toMatchObject({
        kind: "endurance",
        durationMin: 35,
        targetPace: pacesFor(1380).endurance,
        planned: { kind: "vma", durationMin: 50 },
      });
      expect(await storedSessions()).toEqual(BASE_SESSIONS);
    });

    it("recomputes the adjustment on each read", async () => {
      await saveGoal(1);
      await importRun(1, 1, 1380);
      await callPlan(1, "POST");
      await syncRun(1, 10, 300 * 60);
      const high = await (await callPlan(1)).json<PlanResponse>();
      expect(high.plan?.adjustment?.reason).toMatch(/−25 %/);

      await env.DB.prepare("DELETE FROM strava_activities").run();
      const back = await (await callPlan(1)).json<PlanResponse>();
      expect(back.plan?.adjustment).toBeNull();
    });

    it("stores neither the adjusted durations nor the reason", async () => {
      await saveGoal(1);
      await importRun(1, 1, 1380);
      await syncRun(1, 10, 300 * 60);
      await callPlan(1, "POST");
      const before = await snapshot();

      await callPlan(1);
      expect(await snapshot()).toEqual(before);
      const stored = JSON.stringify([before.plans, before.plan_sessions]);
      expect(stored).not.toMatch(/volume|reprise|planned|adjust/i);
      expect(await storedSessions()).toEqual(BASE_SESSIONS);
    });
  });
});
