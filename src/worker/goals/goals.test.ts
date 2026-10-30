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
import type { Goal } from "./rules";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const goal: Goal = {
  distanceM: 10000,
  raceDate: "2027-04-11",
  targetTimeS: 2700,
  referenceDistanceM: 5000,
  referenceTimeS: 1380,
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
  return response.json<{ goal: Goal | null }>();
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
    expect(await getGoal(1)).toEqual({ goal: null });
  });

  it("saves a goal and returns it on the next load", async () => {
    const response = await putGoal(1, JSON.stringify(goal));

    expect(response.status).toBe(200);
    expect(await getGoal(1)).toEqual({ goal });
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
    expect(await getGoal(1)).toEqual({ goal: marathon });
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

  it("rejects a malformed JSON body", async () => {
    const response = await putGoal(1, "{oops");

    expect(response.status).toBe(400);
  });
});
