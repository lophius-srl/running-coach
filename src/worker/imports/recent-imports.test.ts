// GET /api/imports/fit : « Derniers imports » (issue #69, ADR 0005).
import { applyD1Migrations, env } from "cloudflare:test";
import { generateSignedCookie } from "hono/cookie";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../env";
import { app } from "../index";
import { generateToken, tokenSha256 } from "../personal-token/token";
import { resetDatabase } from "../test-db";
import { RECENT_IMPORTS_LIMIT } from "./routes";
import type { RecentImportsResponse } from "./types";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const URL = "https://coach.example/api/imports/fit";
let token: string;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await resetDatabase(env.DB);
  token = generateToken();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
    ),
    env.DB.prepare(
      "INSERT INTO personal_tokens (user_id, token_sha256) VALUES (1, ?)",
    ).bind(await tokenSha256(token)),
  ]);
});

async function sessionCookie(userId: number) {
  const signed = await generateSignedCookie(
    "session",
    `${userId}.9999999999`,
    testEnv.SESSION_SECRET,
    { prefix: "host", secure: true, path: "/" },
  );
  return signed.split(";")[0];
}

async function list(userId = 1) {
  const response = await app.request(
    URL,
    { headers: { Cookie: await sessionCookie(userId) } },
    testEnv,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as RecentImportsResponse).imports;
}

async function insertActivity(userId: number, startDate: string) {
  const row = await env.DB.prepare(
    `INSERT INTO watch_activities (user_id, fit_sha256, start_date, sport_type, distance_m,
       moving_time_s, elapsed_time_s) VALUES (?, ?, ?, 'TrailRun', 10200, 3130, 3200) RETURNING id`,
  )
    .bind(userId, `sha-${userId}-${startDate}`, startDate)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

function logImport(
  userId: number,
  receivedAt: string,
  status: string,
  activityId: number | null = null,
) {
  return env.DB.prepare(
    "INSERT INTO watch_imports (user_id, received_at, status, activity_id) VALUES (?, ?, ?, ?)",
  )
    .bind(userId, receivedAt, status, activityId)
    .run();
}

describe("GET /api/imports/fit", () => {
  it("refuse sans session", async () => {
    const response = await app.request(URL, {}, testEnv);
    expect(response.status).toBe(401);
  });

  it("refuse le jeton personnel, réservé à l'envoi", async () => {
    const response = await app.request(
      URL,
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );
    expect(response.status).toBe(401);
  });

  it("liste les envois du plus récent au plus ancien, avec la séance liée", async () => {
    const activityId = await insertActivity(1, "2026-11-03T07:30:00Z");
    await logImport(1, "2026-11-03T09:00:00.000Z", "imported", activityId);
    await logImport(1, "2026-11-03T09:05:00.000Z", "not_fit");
    await logImport(1, "2026-11-03T09:10:00.000Z", "duplicate", activityId);

    const activity = {
      startDate: "2026-11-03T07:30:00Z",
      sportType: "TrailRun",
      distanceM: 10200,
      movingTimeS: 3130,
    };
    expect(await list()).toMatchObject([
      { receivedAt: "2026-11-03T09:10:00.000Z", status: "duplicate", activity },
      {
        receivedAt: "2026-11-03T09:05:00.000Z",
        status: "not_fit",
        activity: null,
      },
      { receivedAt: "2026-11-03T09:00:00.000Z", status: "imported", activity },
    ]);
  });

  it(`se limite aux ${RECENT_IMPORTS_LIMIT} derniers envois`, async () => {
    for (let minute = 10; minute < 35; minute += 1) {
      await logImport(1, `2026-11-03T09:${minute}:00.000Z`, "invalid");
    }
    const imports = await list();
    expect(imports).toHaveLength(RECENT_IMPORTS_LIMIT);
    expect(imports[0].receivedAt).toBe("2026-11-03T09:34:00.000Z");
    expect(imports.at(-1)?.receivedAt).toBe("2026-11-03T09:15:00.000Z");
  });

  it("ne montre que les envois de l'utilisateur de la session", async () => {
    const otherActivity = await insertActivity(2, "2026-11-03T07:30:00Z");
    await logImport(2, "2026-11-03T09:00:00.000Z", "imported", otherActivity);
    expect(await list(1)).toEqual([]);
    expect(await list(2)).toHaveLength(1);
  });
});
