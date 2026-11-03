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
        "imported_activities",
        "heart_rate_zones",
        "personal_tokens",
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

  // Compatibilité N-1 : le code précédent crée des plans et séances sans ces colonnes.
  it("add nullable plan detail columns", async () => {
    const planColumns = (await columns("plans")).filter((column) =>
      ["week_start", "phase"].includes(column.name),
    );
    const duration = (await columns("plan_sessions")).find(
      (column) => column.name === "duration_min",
    );

    expect(planColumns).toEqual([
      expect.objectContaining({ name: "week_start", notnull: 0 }),
      expect.objectContaining({ name: "phase", notnull: 0 }),
    ]);
    expect(duration?.notnull).toBe(0);
  });

  it("create heart_rate_zones with mandatory columns", async () => {
    expect(await columns("heart_rate_zones")).toEqual([
      expect.objectContaining({ name: "user_id" }),
      expect.objectContaining({ name: "resting_hr", notnull: 1 }),
      expect.objectContaining({ name: "max_hr", notnull: 1 }),
      expect.objectContaining({ name: "zones", notnull: 1 }),
      expect.objectContaining({ name: "updated_at", notnull: 1 }),
    ]);
  });

  // Compatibilité N-1 (ADR 0002) : 0005 ne fait qu'ajouter une table, le code précédent
  // (qui l'ignore) fonctionne donc sans changement sur la nouvelle base.
  it("add heart_rate_zones without altering existing tables", () => {
    const migration = env.TEST_MIGRATIONS.find((m) =>
      m.name.startsWith("0005_"),
    );
    expect(migration?.queries).toHaveLength(1);
    expect(migration?.queries[0]).toMatch(
      /^\s*(--[^\n]*\n\s*)*CREATE TABLE heart_rate_zones \(/,
    );
  });

  it("create personal_tokens with a mandatory, unique hash", async () => {
    expect(await columns("personal_tokens")).toEqual([
      expect.objectContaining({ name: "user_id" }),
      expect.objectContaining({ name: "token_sha256", notnull: 1 }),
      expect.objectContaining({ name: "created_at", notnull: 1 }),
      expect.objectContaining({ name: "last_used_at", notnull: 0 }),
    ]);
  });

  // Compatibilité N-1 (ADR 0002) : 0006 ne fait qu'ajouter une table.
  it("add personal_tokens without altering existing tables", () => {
    const migration = env.TEST_MIGRATIONS.find((m) =>
      m.name.startsWith("0006_"),
    );
    expect(migration?.queries).toHaveLength(1);
    expect(migration?.queries[0]).toMatch(
      /^\s*(--[^\n]*\n\s*)*CREATE TABLE personal_tokens \(/,
    );
  });

  it("are idempotent when applied twice", async () => {
    await expect(
      applyD1Migrations(env.DB, env.TEST_MIGRATIONS),
    ).resolves.toBeUndefined();
  });
});
