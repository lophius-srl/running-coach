import { applyD1Migrations, env } from "cloudflare:test";
import { resetDatabase } from "./test-db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// Contraintes du schéma initial (issue #9, ADR 0003).
// Chaque test repart d'une base vide (resetDatabase), puis du jeu de données de son beforeEach.

const DURABLE_TABLES = [
  "users",
  "oauth_tokens",
  "goals",
  "plans",
  "plan_sessions",
  "imported_activities",
  "heart_rate_zones",
  "personal_tokens",
  "watch_activities",
  "watch_imports",
];
const EPHEMERAL_TABLES = ["strava_activities"];
const ZONES = JSON.stringify(
  [120, 134, 148, 162, 176].map((low) => ({ low, high: low + 14 })),
);

function run(sql: string) {
  return env.DB.prepare(sql).run();
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

async function columnNames(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
  }>();
  return results.map((column) => column.name);
}

async function seedUserWithEverything() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)"),
    env.DB.prepare(
      "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope) VALUES (1, 'a', 'r', 0, 'read')",
    ),
    env.DB.prepare(
      "INSERT INTO goals (id, user_id, race_date, distance_m) VALUES (1, 1, '2027-04-11', 42195)",
    ),
    env.DB.prepare("INSERT INTO plans (id, goal_id) VALUES (1, 1)"),
    env.DB.prepare(
      "INSERT INTO plan_sessions (plan_id, scheduled_date, kind) VALUES (1, '2026-11-02', 'endurance')",
    ),
    env.DB.prepare(
      "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (100, 1, '{}', '2026-10-29T08:00:00.000Z')",
    ),
    env.DB.prepare(
      "INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s) VALUES (1, 100, '2021-03-14T07:02:11.000Z', 'Run', 10000, 3000)",
    ),
    env.DB.prepare(
      `INSERT INTO heart_rate_zones (user_id, resting_hr, max_hr, zones) VALUES (1, 50, 190, '${ZONES}')`,
    ),
    env.DB.prepare(
      `INSERT INTO personal_tokens (user_id, token_sha256) VALUES (1, '${"a".repeat(64)}')`,
    ),
    env.DB.prepare(
      `INSERT INTO watch_activities (id, user_id, fit_sha256, start_date, sport_type, distance_m, moving_time_s, elapsed_time_s) VALUES (1, 1, '${"b".repeat(64)}', '2026-10-23T10:05:58Z', 'Run', 13106, 6245, 6253)`,
    ),
    env.DB.prepare(
      "INSERT INTO watch_imports (user_id, status, activity_id) VALUES (1, 'imported', 1)",
    ),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

describe("Bindings", () => {
  it("expose the D1 database as DB", () => {
    expect(env.DB).toBeDefined();
    expect(typeof env.DB.prepare).toBe("function");
  });
});

describe("durable / ephemeral separation", () => {
  it("keep fetched_at only on ephemeral tables", async () => {
    for (const table of DURABLE_TABLES) {
      expect(await columnNames(table)).not.toContain("fetched_at");
    }
    for (const table of EPHEMERAL_TABLES) {
      expect(await columnNames(table)).toContain("fetched_at");
    }
  });

  it("keep raw Strava payloads out of durable tables", async () => {
    for (const table of DURABLE_TABLES) {
      expect(await columnNames(table)).not.toContain("payload");
    }
  });

  it("index strava_activities on fetched_at for the daily purge", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM pragma_index_list('strava_activities') AS idx WHERE EXISTS (SELECT 1 FROM pragma_index_info(idx.name) WHERE name = 'fetched_at')",
    ).all<{ name: string }>();

    expect(results).toHaveLength(1);
  });
});

describe("users", () => {
  it("reject two users with the same Strava athlete id", async () => {
    await run("INSERT INTO users (strava_athlete_id) VALUES (42)");

    await expect(
      run("INSERT INTO users (strava_athlete_id) VALUES (42)"),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("reject a user without Strava athlete id", async () => {
    await expect(run("INSERT INTO users DEFAULT VALUES")).rejects.toThrow(
      /NOT NULL/,
    );
  });

  it("fill created_at with an ISO 8601 UTC timestamp", async () => {
    await run("INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)");

    const user = await env.DB.prepare(
      "SELECT created_at FROM users WHERE id = 1",
    ).first<{ created_at: string }>();

    expect(user?.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("foreign keys", () => {
  it("reject tokens for an unknown user", async () => {
    await expect(
      run(
        "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope) VALUES (999, 'a', 'r', 0, 'read')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("reject an activity for an unknown user", async () => {
    await expect(
      run(
        "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (1, 999, '{}', '2026-10-29T08:00:00.000Z')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("reject a plan for an unknown goal", async () => {
    await expect(
      run("INSERT INTO plans (goal_id) VALUES (999)"),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("oauth_tokens", () => {
  beforeEach(async () => {
    await run("INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)");
  });

  it("allow a single token row per user", async () => {
    const insert =
      "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope) VALUES (1, 'a', 'r', 0, 'read')";
    await run(insert);

    await expect(run(insert)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("reject a token row without refresh_token", async () => {
    await expect(
      run(
        "INSERT INTO oauth_tokens (user_id, access_token, expires_at, scope) VALUES (1, 'a', 0, 'read')",
      ),
    ).rejects.toThrow(/NOT NULL/);
  });
});

describe("goals", () => {
  beforeEach(async () => {
    await run("INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)");
  });

  it("reject a non-positive distance", async () => {
    await expect(
      run(
        "INSERT INTO goals (user_id, race_date, distance_m) VALUES (1, '2027-04-11', 0)",
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("reject a non-positive target time", async () => {
    await expect(
      run(
        "INSERT INTO goals (user_id, race_date, distance_m, target_time_s) VALUES (1, '2027-04-11', 10000, -1)",
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("accept a goal without target time", async () => {
    await run(
      "INSERT INTO goals (user_id, race_date, distance_m) VALUES (1, '2027-04-11', 10000)",
    );

    expect(await count("goals")).toBe(1);
  });

  it("allow a single goal per user", async () => {
    const insert =
      "INSERT INTO goals (user_id, race_date, distance_m) VALUES (1, '2027-04-11', 10000)";
    await run(insert);

    await expect(run(insert)).rejects.toThrow(/UNIQUE/);
  });

  it("reject a non-positive reference distance or time", async () => {
    await expect(
      run(
        "INSERT INTO goals (user_id, race_date, distance_m, reference_distance_m) VALUES (1, '2027-04-11', 10000, 0)",
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(
        "INSERT INTO goals (user_id, race_date, distance_m, reference_time_s) VALUES (1, '2027-04-11', 10000, 0)",
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("default available_days to an empty JSON array", async () => {
    await run(
      "INSERT INTO goals (id, user_id, race_date, distance_m) VALUES (1, 1, '2027-04-11', 10000)",
    );

    const goal = await env.DB.prepare(
      "SELECT available_days FROM goals WHERE id = 1",
    ).first<{ available_days: string }>();

    expect(JSON.parse(goal?.available_days ?? "null")).toEqual([]);
  });
});

describe("heart_rate_zones", () => {
  beforeEach(async () => {
    await run("INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)");
  });

  function insertZones(restingHr: number, maxHr: number, zones = ZONES) {
    return env.DB.prepare(
      "INSERT INTO heart_rate_zones (user_id, resting_hr, max_hr, zones) VALUES (1, ?, ?, ?)",
    )
      .bind(restingHr, maxHr, zones)
      .run();
  }

  it("accept valid heart rates", async () => {
    await insertZones(30, 230);
    expect(await count("heart_rate_zones")).toBe(1);
  });

  it("allow a single row per user", async () => {
    await insertZones(50, 190);
    await expect(insertZones(50, 190)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it.each([
    ["resting heart rate too low", 29, 190],
    ["resting heart rate too high", 121, 190],
    ["max heart rate too low", 50, 119],
    ["max heart rate too high", 50, 231],
    ["resting heart rate not below the max", 120, 120],
  ])("reject a %s", async (_label, restingHr, maxHr) => {
    await expect(insertZones(restingHr, maxHr)).rejects.toThrow(/CHECK/);
  });

  it.each([
    ["invalid JSON", "not json"],
    ["four zones", JSON.stringify([1, 2, 3, 4])],
    ["an object", "{}"],
  ])("reject zones as %s", async (_label, zones) => {
    await expect(insertZones(50, 190, zones)).rejects.toThrow(/CHECK|JSON/);
  });
});

describe("personal_tokens", () => {
  beforeEach(async () => {
    await run(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
    );
  });

  function insertToken(userId: number, hash: string) {
    return env.DB.prepare(
      "INSERT INTO personal_tokens (user_id, token_sha256) VALUES (?, ?)",
    )
      .bind(userId, hash)
      .run();
  }

  it("allow a single token per user", async () => {
    await insertToken(1, "a".repeat(64));
    await expect(insertToken(1, "b".repeat(64))).rejects.toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
  });

  it("reject the same hash for two users", async () => {
    await insertToken(1, "a".repeat(64));
    await expect(insertToken(2, "a".repeat(64))).rejects.toThrow(/UNIQUE/);
  });

  it("reject a token without hash", async () => {
    await expect(
      run("INSERT INTO personal_tokens (user_id) VALUES (1)"),
    ).rejects.toThrow(/NOT NULL/);
  });

  it("reject a token of an unknown user", async () => {
    await expect(insertToken(3, "a".repeat(64))).rejects.toThrow(/FOREIGN KEY/);
  });

  it("fill created_at and leave last_used_at empty", async () => {
    await insertToken(1, "a".repeat(64));
    const row = await env.DB.prepare(
      "SELECT created_at, last_used_at FROM personal_tokens",
    ).first<{ created_at: string; last_used_at: string | null }>();
    expect(row?.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(row?.last_used_at).toBeNull();
  });
});

describe("watch_activities and watch_imports", () => {
  beforeEach(async () => {
    await run(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
    );
  });

  function insertActivity(
    userId: number,
    sha: string,
    startDate: string,
    distanceM = 10000,
  ) {
    return env.DB.prepare(
      "INSERT INTO watch_activities (user_id, fit_sha256, start_date, sport_type, distance_m, moving_time_s, elapsed_time_s) VALUES (?, ?, ?, 'Run', ?, 3000, 3100)",
    )
      .bind(userId, sha, startDate, distanceM)
      .run();
  }

  function insertImport(status: string, activityId: number | null = null) {
    return env.DB.prepare(
      "INSERT INTO watch_imports (user_id, status, activity_id) VALUES (1, ?, ?)",
    )
      .bind(status, activityId)
      .run();
  }

  it("reject the same file twice for a user, accept it for another user", async () => {
    await insertActivity(1, "a".repeat(64), "2026-10-23T10:05:58Z");
    await expect(
      insertActivity(1, "a".repeat(64), "2026-10-24T10:05:58Z"),
    ).rejects.toThrow(/UNIQUE/);
    await insertActivity(2, "a".repeat(64), "2026-10-23T10:05:58Z");
    expect(await count("watch_activities")).toBe(2);
  });

  it("reject two sessions starting at the same time for a user", async () => {
    await insertActivity(1, "a".repeat(64), "2026-10-23T10:05:58Z");
    await expect(
      insertActivity(1, "b".repeat(64), "2026-10-23T10:05:58Z"),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("reject a negative distance", async () => {
    await expect(
      insertActivity(1, "a".repeat(64), "2026-10-23T10:05:58Z", -1),
    ).rejects.toThrow(/CHECK/);
  });

  it("accept only the known import statuses", async () => {
    for (const status of [
      "imported",
      "duplicate",
      "not_fit",
      "invalid",
      "quota",
    ]) {
      await insertImport(status);
    }
    await expect(insertImport("too_large")).rejects.toThrow(/CHECK/);
    expect(await count("watch_imports")).toBe(5);
  });

  it("keep the import log when its activity is deleted", async () => {
    await insertActivity(1, "a".repeat(64), "2026-10-23T10:05:58Z");
    await insertImport("imported", 1);
    await run("DELETE FROM watch_activities");
    const row = await env.DB.prepare(
      "SELECT activity_id, received_at FROM watch_imports",
    ).first<{ activity_id: number | null; received_at: string }>();
    expect(row?.activity_id).toBeNull();
    expect(row?.received_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("user deletion (Strava §6.3)", () => {
  beforeEach(seedUserWithEverything);

  it("cascade to every table that references the user", async () => {
    await run("DELETE FROM users WHERE id = 1");

    for (const table of [...DURABLE_TABLES, ...EPHEMERAL_TABLES]) {
      expect(await count(table)).toBe(0);
    }
  });

  it("leave other users' data untouched", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, strava_athlete_id) VALUES (2, 43)",
      ),
      env.DB.prepare(
        "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (200, 2, '{}', '2026-10-29T08:00:00.000Z')",
      ),
    ]);

    await run("DELETE FROM users WHERE id = 1");

    expect(await count("users")).toBe(1);
    expect(await count("strava_activities")).toBe(1);
  });

  it("delete a plan's sessions when its goal is deleted", async () => {
    await run("DELETE FROM goals WHERE id = 1");

    expect(await count("plans")).toBe(0);
    expect(await count("plan_sessions")).toBe(0);
  });
});

describe("strava_activities.fetched_at", () => {
  beforeEach(async () => {
    await run("INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)");
  });

  function insertActivity(fetchedAt: string) {
    return env.DB.prepare(
      "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (1, 1, '{}', ?)",
    )
      .bind(fetchedAt)
      .run();
  }

  it("accept the Date.toISOString() format", async () => {
    await insertActivity(new Date("2026-10-29T08:00:00Z").toISOString());
    expect(await count("strava_activities")).toBe(1);
  });

  it.each([
    ["SQLite datetime() format", "2026-10-29 08:00:00"],
    ["missing milliseconds", "2026-10-29T08:00:00Z"],
    ["timezone offset", "2026-10-29T08:00:00.000+01:00"],
    ["date only", "2026-10-29"],
    ["epoch seconds", "1793260800"],
    ["empty string", ""],
    ["impossible date", "2026-13-45T08:00:00.000Z"],
  ])("reject %s", async (_label, fetchedAt) => {
    await expect(insertActivity(fetchedAt)).rejects.toThrow(/CHECK/);
  });
});
