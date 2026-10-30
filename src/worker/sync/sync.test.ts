import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
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
import worker, { app } from "../index";
import type { Bindings } from "../env";
import { StravaError } from "../strava/client";
import { resetDatabase } from "../test-db";
import {
  purgeExpiredActivities,
  runDailySync,
  syncUserActivities,
} from "./sync";

const NOW_MS = Date.parse("2026-10-30T04:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const testEnv: Bindings = {
  ...env,
  STRAVA_CLIENT_ID: "id",
  STRAVA_CLIENT_SECRET: "secret",
  SESSION_SECRET: "session-secret",
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
    ),
    env.DB.prepare(
      "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope) VALUES (1, 'token-1', 'r', 9999999999, 'read'), (2, 'token-2', 'r', 9999999999, 'read')",
    ),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const run = (id: number, name = `run ${id}`) => ({
  id,
  name,
  type: "Run",
  sport_type: "Run",
});
const ride = (id: number) => ({ id, type: "Ride", sport_type: "Ride" });

function tokenOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("Authorization");
}

// Répond `pages[n]` à la n-ième page demandée, quel que soit l'utilisateur.
function mockActivities(...pages: unknown[][]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const page = Number(url.searchParams.get("page"));
    return Response.json(pages[page - 1] ?? []);
  });
}

function insertActivity(id: number, userId: number, fetchedAt: string) {
  return env.DB.prepare(
    "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (?, ?, '{}', ?)",
  )
    .bind(id, userId, fetchedAt)
    .run();
}

async function storedActivities() {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, payload, fetched_at FROM strava_activities ORDER BY id",
  ).all<{ id: number; user_id: number; payload: string; fetched_at: string }>();
  return results;
}

describe("syncUserActivities", () => {
  it("asks Strava for the activities of the last 7 days", async () => {
    const fetchSpy = mockActivities([]);

    await syncUserActivities(testEnv, 1, NOW_MS);

    const [input, init] = fetchSpy.mock.calls[0];
    const url = new URL(String(input));
    expect(url.pathname).toBe("/api/v3/athlete/activities");
    expect(url.searchParams.get("after")).toBe(
      String((NOW_MS - 7 * DAY_MS) / 1000),
    );
    expect(tokenOf(init)).toBe("Bearer token-1");
  });

  it("stores runs with their payload and fetch time", async () => {
    mockActivities([run(10), run(11)]);

    expect(await syncUserActivities(testEnv, 1, NOW_MS)).toEqual({
      imported: 2,
    });

    const stored = await storedActivities();
    expect(stored.map((a) => a.id)).toEqual([10, 11]);
    expect(stored[0]).toMatchObject({
      user_id: 1,
      fetched_at: "2026-10-30T04:00:00.000Z",
    });
    expect(JSON.parse(stored[0].payload)).toEqual(run(10));
  });

  it("updates an already imported activity instead of duplicating it", async () => {
    mockActivities([run(10, "before")]);
    await syncUserActivities(testEnv, 1, NOW_MS - DAY_MS);
    vi.restoreAllMocks();
    mockActivities([run(10, "after"), run(10, "after")]);

    await syncUserActivities(testEnv, 1, NOW_MS);

    const stored = await storedActivities();
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].payload).name).toBe("after");
    expect(stored[0].fetched_at).toBe("2026-10-30T04:00:00.000Z");
  });

  it("does not keep activities other than runs", async () => {
    mockActivities([run(10), ride(11), { id: 12, sport_type: "Walk" }]);

    await syncUserActivities(testEnv, 1, NOW_MS);

    expect((await storedActivities()).map((a) => a.id)).toEqual([10]);
  });

  it("removes a stored run that Strava now reports as another sport", async () => {
    await insertActivity(11, 1, "2026-10-29T04:00:00.000Z");
    mockActivities([ride(11)]);

    await syncUserActivities(testEnv, 1, NOW_MS);

    expect(await storedActivities()).toEqual([]);
  });

  it("follows pagination while pages are full", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => run(1000 + i));
    const fetchSpy = mockActivities(fullPage, [run(5000)]);

    expect(await syncUserActivities(testEnv, 1, NOW_MS)).toEqual({
      imported: 101,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops after 3 pages even when the third one is full", async () => {
    const fullPage = (start: number) =>
      Array.from({ length: 100 }, (_, i) => run(start + i));
    const fetchSpy = mockActivities(
      fullPage(1000),
      fullPage(2000),
      fullPage(3000),
      [run(9000)],
    );

    expect(await syncUserActivities(testEnv, 1, NOW_MS)).toEqual({
      imported: 300,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("stores nothing when a later page fails", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => run(1000 + i));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const page = new URL(String(input)).searchParams.get("page");
      return page === "1"
        ? Response.json(fullPage)
        : new Response("{}", { status: 500 });
    });

    await expect(syncUserActivities(testEnv, 1, NOW_MS)).rejects.toBeInstanceOf(
      StravaError,
    );
    expect(await storedActivities()).toEqual([]);
  });

  it.each([
    ["an object", Response.json({ message: "oops" })],
    ["invalid JSON", new Response("not json", { status: 200 })],
  ])(
    "keeps stored data and throws a StravaError when Strava returns %s",
    async (_label, response) => {
      await insertActivity(10, 1, "2026-10-29T04:00:00.000Z");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      await expect(
        syncUserActivities(testEnv, 1, NOW_MS),
      ).rejects.toBeInstanceOf(StravaError);
      expect(await storedActivities()).toHaveLength(1);
    },
  );

  it("skips malformed items and stores the valid runs", async () => {
    mockActivities([null, { sport_type: "Run" }, { id: "11" }, run(10)]);

    expect(await syncUserActivities(testEnv, 1, NOW_MS)).toEqual({
      imported: 1,
    });
    expect((await storedActivities()).map((a) => a.id)).toEqual([10]);
  });

  it("never overwrites an activity owned by another user", async () => {
    await insertActivity(10, 2, "2026-10-29T04:00:00.000Z");
    mockActivities([run(10)]);

    await syncUserActivities(testEnv, 1, NOW_MS);

    expect(await storedActivities()).toEqual([
      {
        id: 10,
        user_id: 2,
        payload: "{}",
        fetched_at: "2026-10-29T04:00:00.000Z",
      },
    ]);
  });

  it("never deletes an activity owned by another user", async () => {
    await insertActivity(11, 2, "2026-10-29T04:00:00.000Z");
    mockActivities([ride(11)]);

    await syncUserActivities(testEnv, 1, NOW_MS);

    expect((await storedActivities()).map((a) => [a.id, a.user_id])).toEqual([
      [11, 2],
    ]);
  });

  it("refreshes an expired token before fetching activities", async () => {
    await env.DB.prepare(
      "UPDATE oauth_tokens SET expires_at = 0 WHERE user_id = 1",
    ).run();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/oauth/token")
          ? Response.json({
              access_token: "fresh",
              refresh_token: "r2",
              expires_at: 9999999999,
            })
          : Response.json([run(10)]),
      );

    await syncUserActivities(testEnv, 1, NOW_MS);

    expect(tokenOf(fetchSpy.mock.calls[1][1])).toBe("Bearer fresh");
    expect((await storedActivities()).map((a) => a.id)).toEqual([10]);
  });

  it("throws a StravaError and keeps stored data when the token refresh fails", async () => {
    await env.DB.prepare(
      "UPDATE oauth_tokens SET expires_at = 0 WHERE user_id = 1",
    ).run();
    await insertActivity(10, 1, "2026-10-29T04:00:00.000Z");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 401 }),
    );

    await expect(syncUserActivities(testEnv, 1, NOW_MS)).rejects.toBeInstanceOf(
      StravaError,
    );
    expect(await storedActivities()).toHaveLength(1);
  });

  it("keeps stored data and throws a StravaError when Strava fails", async () => {
    await insertActivity(10, 1, "2026-10-29T04:00:00.000Z");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 429 }),
    );

    await expect(syncUserActivities(testEnv, 1, NOW_MS)).rejects.toBeInstanceOf(
      StravaError,
    );
    expect(await storedActivities()).toHaveLength(1);
  });
});

describe("purgeExpiredActivities", () => {
  it("deletes activities fetched more than 7 days ago, and only those", async () => {
    await insertActivity(1, 1, "2026-10-22T04:00:00.000Z"); // 8 jours
    await insertActivity(2, 1, "2026-10-23T03:59:59.999Z"); // 7 jours + 1 ms
    await insertActivity(3, 1, "2026-10-23T04:00:00.000Z"); // pile 7 jours
    await insertActivity(4, 2, "2026-10-29T04:00:00.000Z"); // 1 jour

    expect(await purgeExpiredActivities(env.DB, NOW_MS)).toBe(2);
    expect((await storedActivities()).map((a) => a.id)).toEqual([3, 4]);
  });
});

describe("runDailySync", () => {
  it("purges expired activities and syncs every connected user", async () => {
    await insertActivity(1, 1, "2026-10-01T04:00:00.000Z");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) =>
        Response.json(
          tokenOf(init) === "Bearer token-1" ? [run(10)] : [run(20)],
        ),
      );

    await runDailySync(testEnv, NOW_MS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const stored = await storedActivities();
    expect(stored.map((a) => [a.id, a.user_id])).toEqual([
      [10, 1],
      [20, 2],
    ]);
  });

  it("still syncs other users when one fails, then reports the failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      tokenOf(init) === "Bearer token-1"
        ? new Response("{}", { status: 500 })
        : Response.json([run(20)]),
    );

    await expect(runDailySync(testEnv, NOW_MS)).rejects.toBeInstanceOf(
      StravaError,
    );
    expect((await storedActivities()).map((a) => a.id)).toEqual([20]);
  });

  it("only purges when no user is connected", async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await insertActivity(1, 1, "2026-10-01T04:00:00.000Z");
    await insertActivity(2, 1, "2026-10-29T04:00:00.000Z");
    const fetchSpy = mockActivities([run(10)]);

    await runDailySync(testEnv, NOW_MS);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await storedActivities()).map((a) => a.id)).toEqual([2]);
  });

  it("is wired to the scheduled handler", async () => {
    await insertActivity(1, 1, "2026-10-01T04:00:00.000Z");
    mockActivities([run(10)]);
    const ctx = createExecutionContext();

    await worker.scheduled(
      createScheduledController({ scheduledTime: NOW_MS, cron: "0 4 * * *" }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect((await storedActivities()).map((a) => a.id)).toEqual([10]);
  });
});

describe("POST /api/sync", () => {
  async function sessionCookie(userId: number) {
    const cookie = await generateSignedCookie(
      "session",
      `${userId}.9999999999`,
      testEnv.SESSION_SECRET,
      { prefix: "host", secure: true, path: "/" },
    );
    return cookie.split(";")[0];
  }

  function postSync(headers: HeadersInit = {}) {
    return app.request(
      "https://coach.example/api/sync",
      { method: "POST", headers },
      testEnv,
    );
  }

  it("requires a session", async () => {
    const fetchSpy = mockActivities([run(10)]);

    expect((await postSync()).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs the same sync for the session user", async () => {
    await insertActivity(1, 1, "2000-01-01T00:00:00.000Z");
    const fetchSpy = mockActivities([run(10), ride(11)]);

    const response = await postSync({ Cookie: await sessionCookie(2) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imported: 1 });
    expect(tokenOf(fetchSpy.mock.calls[0][1])).toBe("Bearer token-2");
    const stored = await storedActivities();
    expect(stored.map((a) => [a.id, a.user_id])).toEqual([[10, 2]]);
  });

  it("keeps fresh activities of other users", async () => {
    await insertActivity(20, 2, new Date(Date.now() - DAY_MS).toISOString());
    mockActivities([run(10)]);

    await postSync({ Cookie: await sessionCookie(1) });

    expect((await storedActivities()).map((a) => [a.id, a.user_id])).toEqual([
      [10, 1],
      [20, 2],
    ]);
  });

  it("does not sync on GET", async () => {
    const fetchSpy = mockActivities([run(10)]);

    const response = await app.request(
      "https://coach.example/api/sync",
      { headers: { Cookie: await sessionCookie(1) } },
      testEnv,
    );

    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 502 when Strava is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Network connection lost"),
    );

    const response = await postSync({ Cookie: await sessionCookie(1) });

    expect(response.status).toBe(502);
  });

  it("answers 502 when Strava fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 503 }),
    );

    const response = await postSync({ Cookie: await sessionCookie(1) });

    expect(response.status).toBe(502);
  });
});
