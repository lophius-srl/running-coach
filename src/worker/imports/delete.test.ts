// deleteWatchData (issue #69, réutilisée par #37) : D1 et R2, sans toucher aux autres utilisateurs.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../test-db";
import { deleteWatchData } from "./delete";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function emptyBucket() {
  const { objects } = await env.FIT_BUCKET.list();
  if (objects.length > 0) {
    await env.FIT_BUCKET.delete(objects.map((object) => object.key));
  }
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await emptyBucket();
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (10, 43)",
  ).run();
});

async function seedUser(userId: number, files: number) {
  for (let n = 0; n < files; n += 1) {
    const sha = `${userId}-${n}`;
    await env.FIT_BUCKET.put(`fit/${userId}/${sha}.fit`, new Uint8Array([n]));
    await env.DB.prepare(
      `INSERT INTO watch_activities (user_id, fit_sha256, start_date, sport_type, distance_m,
         moving_time_s, elapsed_time_s) VALUES (?, ?, ?, 'Run', 5000, 1500, 1500)`,
    )
      .bind(userId, sha, `2026-11-0${n + 1}T07:00:00Z`)
      .run();
    await env.DB.prepare(
      `INSERT INTO watch_imports (user_id, status, activity_id)
       SELECT user_id, 'imported', id FROM watch_activities WHERE fit_sha256 = ?`,
    )
      .bind(sha)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO watch_imports (user_id, status) VALUES (?, 'not_fit')",
  )
    .bind(userId)
    .run();
}

async function rowsOf(userId: number) {
  const count = (table: string) =>
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
      .bind(userId)
      .first<{ n: number }>()
      .then((row) => row?.n ?? 0);
  return {
    activities: await count("watch_activities"),
    imports: await count("watch_imports"),
  };
}

async function keys() {
  const { objects } = await env.FIT_BUCKET.list();
  return objects.map((object) => object.key).sort();
}

describe("deleteWatchData", () => {
  it("efface les séances, le journal et les FIT de l'utilisateur, page par page", async () => {
    await seedUser(1, 5);
    await seedUser(10, 2); // préfixe fit/10/ : ne commence pas par fit/1/

    await deleteWatchData(env, 1, 2);

    expect(await rowsOf(1)).toEqual({ activities: 0, imports: 0 });
    expect(await rowsOf(10)).toEqual({ activities: 2, imports: 3 });
    expect(await keys()).toEqual(["fit/10/10-0.fit", "fit/10/10-1.fit"]);
  });

  it("garde les autres données de l'utilisateur (Strava, historique importé)", async () => {
    await seedUser(1, 1);
    await env.DB.prepare(
      `INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s)
       VALUES (1, 99, '2026-10-01T07:00:00Z', 'Run', 10000, 3000)`,
    ).run();

    await deleteWatchData(env, 1);

    const imported = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM imported_activities",
    ).first<{ n: number }>();
    expect(imported?.n).toBe(1);
  });

  it("ne fait rien sans données et peut être relancée", async () => {
    await deleteWatchData(env, 1);
    await seedUser(1, 1);
    await deleteWatchData(env, 1);
    await deleteWatchData(env, 1);
    expect(await rowsOf(1)).toEqual({ activities: 0, imports: 0 });
    expect(await keys()).toEqual([]);
  });

  it("vide le préfixe R2 après la suppression du compte (cascade D1)", async () => {
    await seedUser(1, 2);
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    expect(await rowsOf(1)).toEqual({ activities: 0, imports: 0 });
    expect(await keys()).toHaveLength(2);

    await deleteWatchData(env, 1);

    expect(await keys()).toEqual([]);
  });
});
