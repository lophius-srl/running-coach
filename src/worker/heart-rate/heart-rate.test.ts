import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { app } from "../index";
import type { Bindings } from "../env";
import { resetDatabase } from "../test-db";
import type { HeartRateResponse } from "../../core/heart-rate";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const settings = {
  restingHr: 50,
  maxHr: 190,
  zones: [
    { low: 120, high: 134 },
    { low: 134, high: 148 },
    { low: 148, high: 162 },
    { low: 162, high: 176 },
    { low: 176, high: 190 },
  ],
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(() => resetDatabase(env.DB));
beforeEach(async () => {
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
  ).run();
});

async function cookie(userId: number) {
  const signed = await generateSignedCookie(
    "session",
    `${userId}.9999999999`,
    testEnv.SESSION_SECRET,
    { prefix: "host", secure: true, path: "/" },
  );
  return signed.split(";")[0];
}

async function call(userId: number | null, body?: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (userId !== null) headers.Cookie = await cookie(userId);
  return app.request(
    "https://coach.example/api/heart-rate-zones",
    body === undefined
      ? { headers }
      : {
          method: "PUT",
          headers,
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
    testEnv,
  );
}

async function storedRows() {
  const { results } = await env.DB.prepare(
    "SELECT user_id, resting_hr, max_hr, zones FROM heart_rate_zones",
  ).all();
  return results;
}

describe("/api/heart-rate-zones", () => {
  it("requires a session", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call(null, settings)).status).toBe(401);
  });

  it("returns null before anything is saved", async () => {
    const response = await call(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ heartRate: null });
  });

  it("saves the zones, then returns them", async () => {
    const saved = await call(1, settings);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ heartRate: settings });

    const read = await call(1);
    expect(await read.json<HeartRateResponse>()).toEqual({
      heartRate: settings,
    });
    expect(await storedRows()).toEqual([
      {
        user_id: 1,
        resting_hr: 50,
        max_hr: 190,
        zones: JSON.stringify(settings.zones),
      },
    ]);
  });

  it("replaces the previous zones of the same user", async () => {
    await call(1, settings);
    const updated = {
      restingHr: 60,
      maxHr: 185,
      zones: [
        { low: 123, high: 135 },
        { low: 135, high: 148 },
        { low: 148, high: 160 },
        { low: 160, high: 173 },
        { low: 173, high: 185 },
      ],
    };
    await call(1, updated);

    expect(await (await call(1)).json()).toEqual({ heartRate: updated });
    expect(await storedRows()).toHaveLength(1);
  });

  it("keeps each user's zones separate", async () => {
    await call(1, settings);
    expect(await (await call(2)).json()).toEqual({ heartRate: null });
  });

  it("rejects invalid input with clear messages and stores nothing", async () => {
    const response = await call(1, {
      restingHr: 20,
      maxHr: 190,
      zones: settings.zones.map((zone, i) =>
        i === 1 ? { low: 136, high: 148 } : zone,
      ),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: {
        restingHr: "Saisis ta FC repos en bpm, entre 30 et 120.",
        zones:
          "Z2 : la borne basse doit être égale à la borne haute de Z1 (134 bpm), sans chevauchement ni trou.",
        zone: 2,
      },
    });
    expect(await storedRows()).toEqual([]);
  });

  it("rejects a resting heart rate not below the max", async () => {
    const response = await call(1, { ...settings, restingHr: 120, maxHr: 120 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errors: { maxHr: "Ta FC max doit être supérieure à ta FC repos." },
    });
  });

  it("does not touch another user's zones", async () => {
    await call(1, settings);
    const other = { ...settings, restingHr: 60 };
    await call(2, other);

    expect(await (await call(1)).json()).toEqual({ heartRate: settings });
    expect(await (await call(2)).json()).toEqual({ heartRate: other });
  });

  it("keeps the previous zones when an update is invalid", async () => {
    await call(1, settings);
    const response = await call(1, { ...settings, maxHr: 300 });

    expect(response.status).toBe(400);
    expect(await (await call(1)).json()).toEqual({ heartRate: settings });
  });

  it.each([
    ["a resting heart rate as a string", { ...settings, restingHr: "50" }],
    ["a null resting heart rate", { ...settings, restingHr: null }],
    ["a negative resting heart rate", { ...settings, restingHr: -50 }],
    ["a decimal max heart rate", { ...settings, maxHr: 189.5 }],
    ["null zones", { ...settings, zones: null }],
    ["four zones", { ...settings, zones: settings.zones.slice(0, 4) }],
    [
      "six zones",
      { ...settings, zones: [...settings.zones, { low: 190, high: 200 }] },
    ],
    [
      "a zone bound as a string",
      {
        ...settings,
        zones: settings.zones.map((zone, i) =>
          i === 0 ? { ...zone, low: "120" } : zone,
        ),
      },
    ],
    ["an array body", [settings]],
    ["a null body", null],
  ])("rejects %s and stores nothing", async (_label, body) => {
    const response = await call(1, body === null ? "null" : body);

    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("errors");
    expect(await storedRows()).toEqual([]);
  });

  it("returns null when the stored zones are no longer valid", async () => {
    await env.DB.prepare(
      "INSERT INTO heart_rate_zones (user_id, resting_hr, max_hr, zones) VALUES (1, 50, 190, ?)",
    )
      .bind(JSON.stringify([1, 2, 3, 4, 5]))
      .run();

    const response = await call(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ heartRate: null });
  });

  it("rejects a malformed body", async () => {
    const response = await call(1, "{not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errors: {
        restingHr: "Saisis ta FC repos en bpm, entre 30 et 120.",
        maxHr: "Saisis ta FC max en bpm, entre 120 et 230.",
        zones: "Renseigne les 5 zones.",
      },
    });
  });
});
