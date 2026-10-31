import {
  applyD1Migrations,
  createExecutionContext,
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
import { app } from "../index";
import type { Bindings } from "../env";
import { resetDatabase } from "../test-db";

const OWNER = 42;
const VERIFY_TOKEN = "verify-me";
const DAY_MS = 24 * 60 * 60 * 1000;
const testEnv: Bindings = {
  ...env,
  STRAVA_CLIENT_ID: "id",
  STRAVA_CLIENT_SECRET: "secret",
  STRAVA_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  SESSION_SECRET: "session-secret",
  OWNER_ATHLETE_ID: String(OWNER),
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

beforeEach(async () => {
  const recent = new Date(Date.now() - DAY_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
    ),
    env.DB.prepare(
      "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope) VALUES (1, 'token-1', 'r', 9999999999, 'read'), (2, 'token-2', 'r', 9999999999, 'read')",
    ),
    env.DB.prepare(
      "INSERT INTO strava_activities (id, user_id, payload, fetched_at) VALUES (10, 1, '{}', ?), (11, 1, '{}', ?), (20, 2, '{}', ?)",
    ).bind(recent, recent, recent),
    env.DB.prepare(
      "INSERT INTO goals (id, user_id, race_date, distance_m) VALUES (1, 1, '2027-04-01', 42195)",
    ),
    env.DB.prepare("INSERT INTO plans (id, goal_id) VALUES (1, 1)"),
    env.DB.prepare(
      "INSERT INTO imported_activities (user_id, id, start_date, sport_type, distance_m, moving_time_s) VALUES (1, 500, '2021-03-14T07:02:11Z', 'Run', 10000, 3000)",
    ),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const run = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  athlete: { id: OWNER },
  name: `run ${id}`,
  sport_type: "Run",
  type: "Run",
  start_date: new Date(Date.now() - DAY_MS).toISOString(),
  ...overrides,
});

const activityEvent = (
  aspect: "create" | "update" | "delete",
  objectId: number,
  ownerId = OWNER,
) => ({
  object_type: "activity",
  object_id: objectId,
  aspect_type: aspect,
  owner_id: ownerId,
  subscription_id: 1,
  event_time: 1761800000,
  updates: {},
});

const deauthorization = (ownerId = OWNER) => ({
  object_type: "athlete",
  object_id: ownerId,
  aspect_type: "update",
  owner_id: ownerId,
  subscription_id: 1,
  event_time: 1761800000,
  updates: { authorized: "false" },
});

// Simule l'API Strava : `routes` associe un chemin (/api/v3/...) à une réponse.
function mockStrava(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const respond = routes[url.pathname];
    return respond ? respond() : new Response("{}", { status: 404 });
  });
}

async function post(body: unknown, raw = false) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request("https://coach.example/api/strava/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? String(body) : JSON.stringify(body),
    }),
    testEnv,
    ctx,
  );
  return { response, done: () => waitOnExecutionContext(ctx) };
}

async function deliver(body: unknown, raw = false) {
  const { response, done } = await post(body, raw);
  await done();
  return response;
}

async function activities() {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, payload FROM strava_activities ORDER BY id",
  ).all<{ id: number; user_id: number; payload: string }>();
  return results;
}

async function count(table: string, userId: number) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n;
}

function verify(params: Record<string, string>) {
  const query = new URLSearchParams(params);
  return app.request(`/api/strava/webhook?${query}`, {}, testEnv);
}

describe("GET /api/strava/webhook (subscription validation)", () => {
  const valid = {
    "hub.mode": "subscribe",
    "hub.challenge": "15f7d1a91c1f40f8a748fd134752feb3",
    "hub.verify_token": VERIFY_TOKEN,
  };

  it("echoes the challenge as JSON", async () => {
    const response = await verify(valid);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      "hub.challenge": "15f7d1a91c1f40f8a748fd134752feb3",
    });
  });

  it("returns 403 with a wrong verify token", async () => {
    const response = await verify({ ...valid, "hub.verify_token": "nope" });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(valid["hub.challenge"]);
  });

  it("returns 403 when no verify token is configured", async () => {
    const query = new URLSearchParams({ ...valid, "hub.verify_token": "" });
    const response = await app.request(
      `/api/strava/webhook?${query}`,
      {},
      { ...testEnv, STRAVA_WEBHOOK_VERIFY_TOKEN: "" },
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 with a wrong mode", async () => {
    const response = await verify({ ...valid, "hub.mode": "unsubscribe" });

    expect(response.status).toBe(400);
  });

  it("does not reflect an unexpected challenge", async () => {
    const response = await verify({ ...valid, "hub.challenge": "<b>x</b>" });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("<b>");
  });
});

describe("POST /api/strava/webhook (activity events)", () => {
  it.each(["create", "update"] as const)(
    "stores the run fetched from Strava on %s",
    async (aspect) => {
      const fetchSpy = mockStrava({
        "/api/v3/activities/12": () => Response.json(run(12)),
      });

      const response = await deliver(activityEvent(aspect, 12));

      expect(response.status).toBe(200);
      const [, init] = fetchSpy.mock.calls[0];
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer token-1",
      );
      const stored = (await activities()).find((a) => a.id === 12);
      expect(stored?.user_id).toBe(1);
      expect(JSON.parse(stored?.payload ?? "{}").name).toBe("run 12");
    },
  );

  it("updates an already stored run", async () => {
    mockStrava({
      "/api/v3/activities/10": () =>
        Response.json(run(10, { name: "renamed" })),
    });

    await deliver(activityEvent("update", 10));

    const stored = (await activities()).find((a) => a.id === 10);
    expect(JSON.parse(stored?.payload ?? "{}").name).toBe("renamed");
  });

  it.each([
    ["became another sport", { sport_type: "Ride", type: "Ride" }],
    [
      "started more than 7 days ago",
      { start_date: new Date(Date.now() - 8 * DAY_MS).toISOString() },
    ],
  ])("removes a stored activity that %s", async (_label, overrides) => {
    mockStrava({
      "/api/v3/activities/10": () => Response.json(run(10, overrides)),
    });

    await deliver(activityEvent("update", 10));

    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  it("removes a stored activity that Strava no longer serves on update", async () => {
    mockStrava({});

    await deliver(activityEvent("update", 10));

    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  it("keeps stored data when Strava fails on update", async () => {
    mockStrava({
      "/api/v3/activities/10": () => new Response("{}", { status: 500 }),
    });

    await expect(deliver(activityEvent("update", 10))).rejects.toThrow();

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("does not store an old run on create", async () => {
    mockStrava({
      "/api/v3/activities/12": () =>
        Response.json(
          run(12, {
            start_date: new Date(Date.now() - 30 * DAY_MS).toISOString(),
          }),
        ),
    });

    await deliver(activityEvent("create", 12));

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("deletes the activity on delete", async () => {
    mockStrava({});

    await deliver(activityEvent("delete", 10));

    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  it("deletes the activity on delete even when Strava is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await deliver(activityEvent("delete", 10));

    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  it("keeps a run that Strava still serves despite a delete event (forged)", async () => {
    mockStrava({ "/api/v3/activities/10": () => Response.json(run(10)) });

    await deliver(activityEvent("delete", 10));

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("does not store an activity of another athlete fetched through a forged event", async () => {
    mockStrava({
      "/api/v3/activities/12": () =>
        Response.json(run(12, { athlete: { id: 99 } })),
    });

    await deliver(activityEvent("create", 12));

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("answers 200 before the deferred processing finishes", async () => {
    const strava: { release: (response: Response) => void } = {
      release: () => {},
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        () => new Promise((resolve) => (strava.release = resolve)),
      );

    const { response, done } = await post(activityEvent("create", 12));

    expect(response.status).toBe(200);
    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    strava.release(Response.json(run(12)));
    await done();
    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 12, 20]);
  });
});

describe("POST /api/strava/webhook (deauthorization)", () => {
  it("deletes tokens and Strava activities, keeps user-provided data", async () => {
    mockStrava({
      "/api/v3/athlete": () => new Response("{}", { status: 401 }),
    });

    const response = await deliver(deauthorization());

    expect(response.status).toBe(200);
    expect(await count("oauth_tokens", 1)).toBe(0);
    expect(await count("strava_activities", 1)).toBe(0);
    expect(await count("goals", 1)).toBe(1);
    expect(await count("imported_activities", 1)).toBe(1);
    const plans = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plans",
    ).first<{
      n: number;
    }>();
    expect(plans?.n).toBe(1);
    // L'autre utilisateur n'est pas touché.
    expect(await count("oauth_tokens", 2)).toBe(1);
    expect(await count("strava_activities", 2)).toBe(1);
  });

  it("deletes everything when Strava cannot be reached to confirm", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await deliver(deauthorization());

    expect(await count("oauth_tokens", 1)).toBe(0);
    expect(await count("strava_activities", 1)).toBe(0);
  });

  it("ignores a forged deauthorization while the token is still accepted", async () => {
    mockStrava({ "/api/v3/athlete": () => Response.json({ id: OWNER }) });

    await deliver(deauthorization());

    expect(await count("oauth_tokens", 1)).toBe(1);
    expect(await count("strava_activities", 1)).toBe(2);
  });
});

describe("POST /api/strava/webhook (ignored events)", () => {
  it("ignores events of another athlete", async () => {
    const fetchSpy = mockStrava({});

    for (const event of [
      deauthorization(43),
      activityEvent("delete", 20, 43),
    ]) {
      expect((await deliver(event)).status).toBe(200);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("oauth_tokens", 2)).toBe(1);
    expect(await count("strava_activities", 2)).toBe(1);
  });

  it.each([
    ["invalid JSON", "{not json", true],
    ["an unexpected shape", { hello: "world" }, false],
    ["a too large body", JSON.stringify({ pad: "x".repeat(5000) }), true],
  ])("answers 200 and ignores %s", async (_label, body, raw) => {
    const fetchSpy = mockStrava({});

    const response = await deliver(body, raw);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });
});
