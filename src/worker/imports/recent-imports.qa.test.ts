// QA de l'issue #69 : GET /api/imports/fit (« Derniers imports »), cas limites.
import { applyD1Migrations, env } from "cloudflare:test";
import { generateSignedCookie } from "hono/cookie";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../env";
import { app } from "../index";
import { generateToken, tokenSha256 } from "../personal-token/token";
import { resetDatabase } from "../test-db";
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

async function cookie(value: string, secret = testEnv.SESSION_SECRET) {
  const signed = await generateSignedCookie("session", value, secret, {
    prefix: "host",
    secure: true,
    path: "/",
  });
  return signed.split(";")[0];
}

async function request(headers: Record<string, string>) {
  return app.request(URL, { headers }, testEnv);
}

async function list() {
  const response = await request({ Cookie: await cookie("1.9999999999") });
  expect(response.status).toBe(200);
  return ((await response.json()) as RecentImportsResponse).imports;
}

async function insertActivity(userId: number) {
  const row = await env.DB.prepare(
    `INSERT INTO watch_activities (user_id, fit_sha256, start_date, sport_type, distance_m,
       moving_time_s, elapsed_time_s) VALUES (?, 'sha', '2026-11-03T07:30:00Z', 'Run', 5000,
       1500, 1500) RETURNING id`,
  )
    .bind(userId)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

function logImport(status: string, activityId: number | null = null) {
  return env.DB.prepare(
    "INSERT INTO watch_imports (user_id, status, activity_id) VALUES (1, ?, ?)",
  )
    .bind(status, activityId)
    .run();
}

describe("GET /api/imports/fit : authentification", () => {
  it("refuse une session expirée", async () => {
    const response = await request({ Cookie: await cookie("1.1000000000") });
    expect(response.status).toBe(401);
  });

  it("refuse une session signée avec un autre secret", async () => {
    const response = await request({
      Cookie: await cookie("1.9999999999", "autre-secret"),
    });
    expect(response.status).toBe(401);
  });

  it("refuse le jeton personnel même passé en cookie de session", async () => {
    const response = await request({ Cookie: `__Host-session=${token}` });
    expect(response.status).toBe(401);
  });

  it("répond par la session quand un Bearer l'accompagne (le jeton est ignoré)", async () => {
    await logImport("invalid");
    const response = await request({
      Cookie: await cookie("2.9999999999"),
      Authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RecentImportsResponse;
    expect(body.imports).toEqual([]); // envois de l'utilisateur 2, pas du titulaire du jeton
  });
});

describe("GET /api/imports/fit : contenu", () => {
  it("liste chaque statut d'erreur, sans séance", async () => {
    for (const status of ["not_fit", "invalid", "quota"])
      await logImport(status);
    const imports = await list();
    expect(imports.map((item) => [item.status, item.activity])).toEqual([
      ["quota", null],
      ["invalid", null],
      ["not_fit", null],
    ]);
  });

  it("garde la ligne d'un envoi dont la séance a été supprimée (activity_id NULL)", async () => {
    const activityId = await insertActivity(1);
    await logImport("imported", activityId);
    await env.DB.prepare("DELETE FROM watch_activities WHERE id = ?")
      .bind(activityId)
      .run();

    expect(await list()).toEqual([
      expect.objectContaining({ status: "imported", activity: null }),
    ]);
  });

  it("n'affiche pas la séance d'un autre utilisateur, même si le journal la référence", async () => {
    const otherActivity = await insertActivity(2);
    await logImport("imported", otherActivity);
    expect(await list()).toEqual([
      expect.objectContaining({ status: "imported", activity: null }),
    ]);
  });

  it("départage deux envois reçus au même instant par id décroissant", async () => {
    await env.DB.prepare(
      `INSERT INTO watch_imports (id, user_id, received_at, status) VALUES
         (5, 1, '2026-11-03T09:00:00.000Z', 'invalid'),
         (6, 1, '2026-11-03T09:00:00.000Z', 'not_fit')`,
    ).run();
    expect((await list()).map((item) => item.id)).toEqual([6, 5]);
  });

  it("répond une liste vide sans aucun envoi", async () => {
    expect(await list()).toEqual([]);
  });
});
