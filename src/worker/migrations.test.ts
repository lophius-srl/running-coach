import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

type ColumnInfo = { name: string; notnull: number };

async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

async function columns(table: string): Promise<ColumnInfo[]> {
  const { results } = await env.DB.prepare(
    `PRAGMA table_info(${table})`,
  ).all<ColumnInfo>();
  return results;
}

describe("D1 migrations", () => {
  beforeAll(async () => {
    expect(await tableNames()).toEqual([]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it("create the durable tables", async () => {
    expect(await tableNames()).toEqual(
      expect.arrayContaining([
        "users",
        "oauth_tokens",
        "goals",
        "plans",
        "plan_sessions",
      ]),
    );
  });

  it("create the ephemeral activities table with a mandatory fetched_at", async () => {
    const fetchedAt = (await columns("strava_activities")).find(
      (column) => column.name === "fetched_at",
    );

    expect(fetchedAt?.notnull).toBe(1);
  });

  it("reject an activity without fetched_at", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)",
    ).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO strava_activities (id, user_id, payload) VALUES (1, 1, '{}')",
      ).run(),
    ).rejects.toThrow(/NOT NULL/);
  });

  // Compatibilité N-1 (ADR 0002) : le code précédent insère des objectifs sans ces colonnes.
  it("add nullable reference columns to goals", async () => {
    const added = (await columns("goals")).filter((column) =>
      column.name.startsWith("reference_"),
    );

    expect(added).toEqual([
      expect.objectContaining({ name: "reference_distance_m", notnull: 0 }),
      expect.objectContaining({ name: "reference_time_s", notnull: 0 }),
    ]);
  });

  it("are idempotent when applied twice", async () => {
    await expect(
      applyD1Migrations(env.DB, env.TEST_MIGRATIONS),
    ).resolves.toBeUndefined();
  });
});
