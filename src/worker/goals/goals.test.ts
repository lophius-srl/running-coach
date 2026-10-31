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
import type { Goal, GoalResponse } from "./rules";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const goal: Goal = {
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
  vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
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

async function getGoal(userId: number) {
  const response = await app.request(
    "https://coach.example/api/goal",
    { headers: { Cookie: await sessionCookie(userId) } },
    testEnv,
  );
  return response.json<GoalResponse>();
}

type Run = {
  id: number;
  startDate: string;
  distanceM: number;
  movingTimeS: number;
};

// 5 km en 23:00 il y a 10 jours : VDOT ≈ 42,6.
const fiveK: Run = {
  id: 501,
  startDate: "2026-10-20T07:00:00.000Z",
  distanceM: 5000,
  movingTimeS: 1380,
};

async function importRun(userId: number, run: Run, sportType = "Run") {
  await env.DB.prepare(
    `INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      run.id,
      run.startDate,
      sportType,
      run.distanceM,
      run.movingTimeS,
    )
    .run();
}

async function syncRun(userId: number, run: Run) {
  const payload = {
    id: run.id,
    sport_type: "Run",
    start_date: run.startDate,
    distance: run.distanceM,
    moving_time: run.movingTimeS,
  };
  await env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, ?, '2026-10-30T08:00:00.000Z')",
  )
    .bind(run.id, userId, JSON.stringify(payload))
    .run();
}

const basisOf = ({ startDate, distanceM, movingTimeS }: Run) => ({
  startDate,
  distanceM,
  movingTimeS,
});

// Objectif seul, pour comparer sans les allures.
async function getGoalOnly(userId: number) {
  const { goal } = await getGoal(userId);
  return { goal };
}

async function putGoal(userId: number, body: string) {
  return app.request(
    "https://coach.example/api/goal",
    {
      method: "PUT",
      headers: {
        Cookie: await sessionCookie(userId),
        "Content-Type": "application/json",
      },
      body,
    },
    testEnv,
  );
}

async function goalRows() {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id FROM goals ORDER BY id",
  ).all<{ id: number; user_id: number }>();
  return results;
}

describe("/api/goal", () => {
  it("requires a session", async () => {
    const get = await app.request(
      "https://coach.example/api/goal",
      {},
      testEnv,
    );
    const put = await app.request(
      "https://coach.example/api/goal",
      { method: "PUT", body: JSON.stringify(goal) },
      testEnv,
    );

    expect(get.status).toBe(401);
    expect(put.status).toBe(401);
  });

  it("returns null when no goal is saved", async () => {
    expect(await getGoalOnly(1)).toEqual({ goal: null });
  });

  it("saves a goal and returns it on the next load", async () => {
    const response = await putGoal(1, JSON.stringify(goal));

    expect(response.status).toBe(200);
    expect(await getGoalOnly(1)).toEqual({ goal });
  });

  it("replaces the active goal instead of adding one, keeping its plans", async () => {
    await putGoal(1, JSON.stringify(goal));
    const [{ id }] = await goalRows();
    await env.DB.prepare("INSERT INTO plans (goal_id) VALUES (?)")
      .bind(id)
      .run();

    const marathon = { ...goal, distanceM: 42195, targetTimeS: null };
    await putGoal(1, JSON.stringify(marathon));

    expect(await goalRows()).toEqual([{ id, user_id: 1 }]);
    expect(await getGoalOnly(1)).toEqual({ goal: marathon });
    const plans = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plans",
    ).first<{
      n: number;
    }>();
    expect(plans?.n).toBe(1);
  });

  it("keeps each user's goal separate", async () => {
    await putGoal(1, JSON.stringify(goal));
    await putGoal(2, JSON.stringify({ ...goal, distanceM: 5000 }));

    expect((await getGoal(1)).goal?.distanceM).toBe(10000);
    expect((await getGoal(2)).goal?.distanceM).toBe(5000);
  });

  it("rejects an invalid goal with per-field errors and saves nothing", async () => {
    const response = await putGoal(
      1,
      JSON.stringify({ ...goal, raceDate: "2026-10-29", availableDays: [1] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: {
        raceDate: "La date de course doit être dans le futur.",
        availableDays: "Coche au moins 2 jours disponibles.",
      },
    });
    expect(await goalRows()).toEqual([]);
  });

  it("saves a goal sent without targetTimeS as having no target", async () => {
    const withoutTarget: Partial<Goal> = { ...goal };
    delete withoutTarget.targetTimeS;

    const response = await putGoal(1, JSON.stringify(withoutTarget));

    expect(response.status).toBe(200);
    expect(await getGoalOnly(1)).toEqual({
      goal: { ...goal, targetTimeS: null },
    });
  });

  it("rejects a malformed JSON body", async () => {
    const response = await putGoal(1, "{oops");

    expect(response.status).toBe(400);
  });

  it.each(["null", "[]", '"goal"', ""])(
    "rejects the non-object body %j without saving",
    async (body) => {
      const response = await putGoal(1, body);

      expect(response.status).toBe(400);
      expect(await goalRows()).toEqual([]);
    },
  );

  it("saves the goal for the session user, ignoring a user id in the body", async () => {
    await putGoal(1, JSON.stringify({ ...goal, userId: 2, user_id: 2 }));

    expect(await goalRows()).toEqual([{ id: expect.any(Number), user_id: 1 }]);
    expect(await getGoalOnly(2)).toEqual({ goal: null });
  });

  it("returns the saved goal with its days sorted", async () => {
    const response = await putGoal(
      1,
      JSON.stringify({ ...goal, availableDays: [6, 2, 4] }),
    );

    expect(await response.json()).toMatchObject({ goal });
    expect((await getGoal(1)).goal?.availableDays).toEqual([2, 4, 6]);
  });

  it("keeps the previous goal when a replacement is invalid", async () => {
    await putGoal(1, JSON.stringify(goal));

    const response = await putGoal(
      1,
      JSON.stringify({ ...goal, availableDays: [] }),
    );

    expect(response.status).toBe(400);
    expect(await getGoalOnly(1)).toEqual({ goal });
  });

  it("touches updated_at but keeps created_at when replacing", async () => {
    await putGoal(1, JSON.stringify(goal));
    await env.DB.prepare(
      "UPDATE goals SET created_at = '2020-01-01T00:00:00.000Z', updated_at = '2020-01-01T00:00:00.000Z'",
    ).run();

    await putGoal(1, JSON.stringify({ ...goal, distanceM: 5000 }));

    const row = await env.DB.prepare(
      "SELECT created_at, updated_at FROM goals",
    ).first<{ created_at: string; updated_at: string }>();
    expect(row?.created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(row?.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("does not create two goals on concurrent saves", async () => {
    await Promise.all([
      putGoal(1, JSON.stringify(goal)),
      putGoal(1, JSON.stringify({ ...goal, distanceM: 5000 })),
    ]);

    expect(await goalRows()).toHaveLength(1);
  });

  it("accepts tomorrow until 23:59:59 UTC", async () => {
    vi.setSystemTime(new Date("2026-10-30T23:59:59.999Z"));

    const response = await putGoal(
      1,
      JSON.stringify({ ...goal, raceDate: "2026-10-31" }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects that date once it is today in UTC", async () => {
    vi.setSystemTime(new Date("2026-10-31T00:00:00.000Z"));

    const response = await putGoal(
      1,
      JSON.stringify({ ...goal, raceDate: "2026-10-31" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: { raceDate: "La date de course doit être dans le futur." },
    });
  });

  it("returns a goal saved before #13, without its legacy reference", async () => {
    await env.DB.prepare(
      "INSERT INTO goals (user_id, race_date, distance_m, available_days, reference_distance_m, reference_time_s) VALUES (1, '2027-04-11', 10000, '[1,3]', 5000, 1380)",
    ).run();

    expect(await getGoal(1)).toEqual({
      goal: {
        distanceM: 10000,
        raceDate: "2027-04-11",
        targetTimeS: null,
        availableDays: [1, 3],
      },
      paces: null,
      basis: null,
    });
  });

  // #46 : les colonnes restent en base (ADR 0002) mais ne sont plus écrites.
  it("neither writes nor clears the legacy reference columns", async () => {
    await putGoal(
      1,
      JSON.stringify({
        ...goal,
        referenceDistanceM: 5000,
        referenceTimeS: 1380,
      }),
    );
    const fresh = await env.DB.prepare(
      "SELECT reference_distance_m AS d, reference_time_s AS t FROM goals",
    ).first();
    await env.DB.prepare("UPDATE goals SET reference_distance_m = 5000").run();
    await putGoal(1, JSON.stringify(goal));
    const kept = await env.DB.prepare(
      "SELECT reference_distance_m AS d FROM goals",
    ).first();

    expect(fresh).toEqual({ d: null, t: null });
    expect(kept).toEqual({ d: 5000 });
  });

  it("completes a goal saved before #13 without duplicating it", async () => {
    await env.DB.prepare(
      "INSERT INTO goals (user_id, race_date, distance_m) VALUES (1, '2027-04-11', 10000)",
    ).run();
    const [{ id }] = await goalRows();

    await putGoal(1, JSON.stringify(goal));

    expect(await goalRows()).toEqual([{ id, user_id: 1 }]);
    expect(await getGoalOnly(1)).toEqual({ goal });
  });

  // Course 5 km en 23:00 (VDOT ≈ 42,6) → 10 km prédit en 47:42 ; visé 45:00 = 5,7 % plus rapide.
  it("returns the paces computed from the best recent run, with that run", async () => {
    await importRun(1, fiveK);
    const saved = await putGoal(1, JSON.stringify(goal));
    const loaded = await getGoal(1);

    expect(await saved.json()).toEqual(loaded);
    expect(loaded.basis).toEqual(basisOf(fiveK));
    expect(loaded.paces).toMatchObject({
      threshold: { fastSPerKm: 292, slowSPerKm: 298 },
      race: { fastSPerKm: 267, slowSPerKm: 273 },
      predictedTimeS: 2862,
      targetWarning:
        "Ton chrono visé est au moins 5 % plus rapide que ce que prédit ton niveau actuel. Un objectif réaliste serait autour de 47:42.",
    });
  });

  it("returns no paces without a usable run, even with a goal", async () => {
    await putGoal(1, JSON.stringify(goal));
    await importRun(1, { ...fiveK, id: 1, distanceM: 2000, movingTimeS: 600 });
    await importRun(1, { ...fiveK, id: 2 }, "Ride");
    await importRun(1, {
      ...fiveK,
      id: 3,
      startDate: "2026-09-03T09:59:59.000Z",
    });

    expect(await getGoal(1)).toEqual({ goal, paces: null, basis: null });
  });

  it("returns the basis but no paces without a goal", async () => {
    await importRun(1, fiveK);

    expect(await getGoal(1)).toEqual({
      goal: null,
      paces: null,
      basis: basisOf(fiveK),
    });
  });

  it("counts a run started exactly 8 weeks ago", async () => {
    const edge = { ...fiveK, startDate: "2026-09-04T10:00:00.000Z" };
    await importRun(1, edge);

    expect((await getGoal(1)).basis).toEqual(basisOf(edge));
  });

  it("keeps the best run among easy runs from both sources", async () => {
    const easy = {
      id: 7,
      startDate: "2026-10-29T07:00:00.000Z",
      distanceM: 10000,
      movingTimeS: 3600,
    };
    await putGoal(1, JSON.stringify(goal));
    await syncRun(1, easy);
    await importRun(1, fiveK);

    expect((await getGoal(1)).paces).toEqual(
      trainingPaces({ ...goal, vdot: vdot(5000, 1380) }),
    );
  });

  // ADR 0004 : la version API l'emporte sur la version importée.
  it("prefers the Strava API version of a run over its imported copy", async () => {
    const corrected = { ...fiveK, movingTimeS: 1500 };
    await importRun(1, fiveK);
    await syncRun(1, corrected);

    expect((await getGoal(1)).basis).toEqual(basisOf(corrected));
  });

  it("returns each user's own paces only", async () => {
    const marathon = { ...goal, distanceM: 42195, targetTimeS: null };
    await importRun(1, fiveK);
    await putGoal(1, JSON.stringify(goal));
    await putGoal(2, JSON.stringify(marathon));

    expect((await getGoal(2)).paces).toBeNull();

    await syncRun(2, { ...fiveK, id: 900, movingTimeS: 1200 });

    expect((await getGoal(1)).paces).toEqual(
      trainingPaces({ ...goal, vdot: vdot(5000, 1380) }),
    );
    expect((await getGoal(2)).paces).toEqual(
      trainingPaces({ ...marathon, vdot: vdot(5000, 1200) }),
    );
  });
});
