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
];
const EPHEMERAL_TABLES = ["strava_activities"];

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
