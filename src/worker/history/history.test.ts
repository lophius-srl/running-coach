import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { app } from "../index";
import type { Bindings } from "../env";
import { resetDatabase } from "../test-db";
import { purgeExpiredActivities, runDailySync } from "../sync/sync";
import {
  readActivitiesCsv,
  toBatches,
  type ImportedRun,
} from "../../core/history-csv";
import { ACTIVITIES_SAMPLE_CSV } from "../../core/fixtures/activities-sample";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };

const run = (id: number, name = `run ${id}`): ImportedRun => ({
  id,
  startDate: "2021-03-14T07:02:11.000Z",
  sportType: "Run",
  name,
  distanceM: 10000,
  movingTimeS: 3000,
  elevationGainM: null,
  averageHeartrate: null,
});

function sampleRuns(): ImportedRun[] {
  const result = readActivitiesCsv(ACTIVITIES_SAMPLE_CSV);
  if (!result.ok) throw new Error("invalid fixture");
  return result.file.runs;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
  ).run();
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

async function postBody(body: string, userId: number | null = 1) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (userId !== null) headers.Cookie = await sessionCookie(userId);
  return app.request(
    "https://coach.example/api/history/import",
    { method: "POST", headers, body },
    testEnv,
  );
}

function postRows(rows: unknown[], userId = 1) {
  return postBody(JSON.stringify({ rows }), userId);
}

async function storedRows() {
  const { results } = await env.DB.prepare(
    "SELECT user_id, id, start_date, sport_type, name, distance_m, moving_time_s, elevation_gain_m, average_heartrate FROM imported_activities ORDER BY user_id, id",
  ).all();
  return results;
}

describe("POST /api/history/import", () => {
  it("requires a session", async () => {
    const response = await postBody(JSON.stringify({ rows: [run(1)] }), null);

    expect(response.status).toBe(401);
    expect(await storedRows()).toEqual([]);
  });

  it("stores the summary of each run for the session user", async () => {
    const response = await postRows([
      { ...run(7), elevationGainM: 87, averageHeartrate: 152.3, userId: 2 },
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inserted: 1, alreadyPresent: 0 });
    expect(await storedRows()).toEqual([
      {
        user_id: 1,
        id: 7,
        start_date: "2021-03-14T07:02:11.000Z",
        sport_type: "Run",
        name: "run 7",
        distance_m: 10000,
        moving_time_s: 3000,
        elevation_gain_m: 87,
        average_heartrate: 152.3,
      },
    ]);
  });

  it("imports the whole sample file batch by batch, then nothing twice", async () => {
    const runs = sampleRuns();
    const first = await postRows(runs);
    const again = await postRows(runs);

    expect(await first.json()).toEqual({ inserted: 4, alreadyPresent: 0 });
    expect(await again.json()).toEqual({ inserted: 0, alreadyPresent: 4 });
    expect(await storedRows()).toHaveLength(4);
  });

  it("finishes an interrupted import without duplicates", async () => {
    const runs = Array.from({ length: 450 }, (_, i) => run(i + 1));
    const batches = toBatches(runs);
    await postRows(batches[0]);

    const results = [];
    for (const batch of batches) {
      results.push(await (await postRows(batch)).json());
    }

    expect(results).toEqual([
      { inserted: 0, alreadyPresent: 200 },
      { inserted: 200, alreadyPresent: 0 },
      { inserted: 50, alreadyPresent: 0 },
    ]);
    expect(await storedRows()).toHaveLength(450);
  });

  it("updates a run imported again with corrections", async () => {
    await postRows([run(7, "avant")]);
    await postRows([{ ...run(7, "après"), sportType: "TrailRun" }]);

    expect(await storedRows()).toMatchObject([
      { id: 7, name: "après", sport_type: "TrailRun" },
    ]);
  });

  it("counts a run sent twice in the same batch once", async () => {
    const response = await postRows([run(7, "a"), run(7, "b")]);

    expect(await response.json()).toEqual({ inserted: 1, alreadyPresent: 0 });
    expect(await storedRows()).toMatchObject([{ id: 7, name: "b" }]);
  });

  it("keeps each user's history separate, even with the same activity id", async () => {
    await postRows([run(7)], 2);
    const response = await postRows([run(7)], 1);

    expect(await response.json()).toEqual({ inserted: 1, alreadyPresent: 0 });
    expect(await storedRows()).toMatchObject([
      { user_id: 1, id: 7 },
      { user_id: 2, id: 7 },
    ]);
  });

  it("refuses a batch of more than 200 rows with 413", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => run(i + 1));

    const response = await postRows(rows);

    expect(response.status).toBe(413);
    expect(await storedRows()).toEqual([]);
  });

  it("refuses an oversized body with 413", async () => {
    const response = await postBody(
      JSON.stringify({ rows: [], padding: "x".repeat(300_000) }),
    );

    expect(response.status).toBe(413);
  });

  it("refuses the whole batch when one row is invalid", async () => {
    const response = await postRows([
      run(1),
      { ...run(2), sportType: "Ride" },
      { ...run(3), movingTimeS: 60 },
    ]);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_rows",
      invalidRows: [1, 2],
    });
    expect(await storedRows()).toEqual([]);
  });

  it.each(["{oops", "null", "[]", '{"rows":{}}', ""])(
    "refuses the malformed body %j with 400",
    async (body) => {
      const response = await postBody(body);

      expect(response.status).toBe(400);
    },
  );

  it("accepts an empty batch", async () => {
    const response = await postRows([]);

    expect(await response.json()).toEqual({ inserted: 0, alreadyPresent: 0 });
  });

  it("never touches the ephemeral Strava activities", async () => {
    await env.DB.prepare(
      "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (7, 1, '{}', '2026-10-29T08:00:00.000Z')",
    ).run();

    await postRows([run(7)]);

    const strava = await env.DB.prepare(
      "SELECT id, payload FROM strava_activities",
    ).all();
    expect(strava.results).toEqual([{ id: 7, payload: "{}" }]);
  });
});

// ADR 0004 : la purge à 7 jours ne s'applique qu'à strava_activities.
describe("daily purge", () => {
  const NOW_MS = Date.parse("2026-10-30T04:00:00.000Z");

  it("keeps the imported history, however old", async () => {
    await postRows([
      run(1),
      { ...run(2), startDate: "2010-01-01T00:00:00.000Z" },
    ]);
    await env.DB.prepare(
      "UPDATE imported_activities SET imported_at = '2020-01-01T00:00:00.000Z'",
    ).run();

    await purgeExpiredActivities(env.DB, NOW_MS);
    await runDailySync(testEnv, NOW_MS);

    expect(await storedRows()).toHaveLength(2);
  });
});
