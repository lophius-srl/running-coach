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
  STRAVA_WEBHOOK_SUBSCRIPTION_ID: "1",
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
    const fetchSpy = mockStrava({});

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
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deletes without asking Strava, even if the API still accepts the token", async () => {
    const fetchSpy = mockStrava({
      "/api/v3/athlete": () => Response.json({ id: OWNER }),
    });

    await deliver(deauthorization());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("oauth_tokens", 1)).toBe(0);
    expect(await count("strava_activities", 1)).toBe(0);
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

// Corps envoyé au POST sans passer par JSON.stringify ni Content-Type automatique.
async function postRaw(
  body: string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) {
  const ctx = createExecutionContext();
  const waitUntil = vi.spyOn(ctx, "waitUntil");
  const response = await app.fetch(
    new Request("https://coach.example/api/strava/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, waitUntil };
}

async function postWith(body: unknown, bindings: Bindings = testEnv) {
  const ctx = createExecutionContext();
  const waitUntil = vi.spyOn(ctx, "waitUntil");
  const response = await app.fetch(
    new Request("https://coach.example/api/strava/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, waitUntil };
}

describe("GET /api/strava/webhook (edge cases)", () => {
  const valid = {
    "hub.mode": "subscribe",
    "hub.challenge": "abc",
    "hub.verify_token": VERIFY_TOKEN,
  };

  it("returns 403 when the verify token parameter is missing", async () => {
    const response = await verify({
      "hub.mode": "subscribe",
      "hub.challenge": "abc",
    });

    expect(response.status).toBe(403);
  });

  it.each([
    ["a prefix of the expected token", VERIFY_TOKEN.slice(0, -1)],
    ["the expected token with a suffix", `${VERIFY_TOKEN}x`],
    ["the expected token in another case", VERIFY_TOKEN.toUpperCase()],
    ["the expected token with spaces", ` ${VERIFY_TOKEN} `],
  ])("returns 403 for %s", async (_label, token) => {
    const response = await verify({ ...valid, "hub.verify_token": token });

    expect(response.status).toBe(403);
  });

  it("returns 403 when the verify token binding is absent", async () => {
    const query = new URLSearchParams(valid);
    const response = await app.request(
      `/api/strava/webhook?${query}`,
      {},
      { ...testEnv, STRAVA_WEBHOOK_VERIFY_TOKEN: undefined },
    );

    expect(response.status).toBe(403);
  });

  it("returns 403 before checking the mode when the token is wrong", async () => {
    const response = await verify({
      "hub.challenge": "abc",
      "hub.verify_token": "nope",
    });

    expect(response.status).toBe(403);
  });

  it("returns 400 when the mode is missing", async () => {
    const response = await verify({
      "hub.challenge": "abc",
      "hub.verify_token": VERIFY_TOKEN,
    });

    expect(response.status).toBe(400);
  });

  it("returns 400 when the challenge is missing", async () => {
    const response = await verify({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
    });

    expect(response.status).toBe(400);
  });

  it("echoes a challenge of the maximum accepted length", async () => {
    const challenge = "a".repeat(256);

    const response = await verify({ ...valid, "hub.challenge": challenge });

    expect(await response.json()).toEqual({ "hub.challenge": challenge });
  });
});

describe("POST /api/strava/webhook (ignored bodies and deferred work)", () => {
  it.each([
    [
      "an owner id sent as a string",
      { ...activityEvent("create", 12), owner_id: "42" },
    ],
    [
      "an object id sent as a string",
      { ...activityEvent("create", 12), object_id: "12" },
    ],
    [
      "a non integer object id",
      { ...activityEvent("create", 12), object_id: 12.5 },
    ],
    ["a zero object id", { ...activityEvent("create", 12), object_id: 0 }],
    [
      "an unknown aspect type",
      { ...activityEvent("create", 12), aspect_type: "archive" },
    ],
    [
      "a missing object type",
      { ...activityEvent("create", 12), object_type: undefined },
    ],
    ["a JSON array", [activityEvent("create", 12)]],
    ["a JSON null", null],
    [
      'an athlete event with authorized "true"',
      { ...deauthorization(), updates: { authorized: "true" } },
    ],
    [
      "an athlete event without updates.authorized",
      { ...deauthorization(), updates: {} },
    ],
    [
      "an athlete event without updates",
      { ...deauthorization(), updates: undefined },
    ],
  ])("answers 200 without deferred work for %s", async (_label, body) => {
    const fetchSpy = mockStrava({});

    const { response, waitUntil } = await postWith(body);

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("oauth_tokens", 1)).toBe(1);
    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("ignores every event when OWNER_ATHLETE_ID is not configured", async () => {
    const fetchSpy = mockStrava({});

    const { response, waitUntil } = await postWith(deauthorization(), {
      ...testEnv,
      OWNER_ATHLETE_ID: undefined,
    });

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("oauth_tokens", 1)).toBe(1);
  });

  it.each([
    ["not configured", undefined],
    ["empty", ""],
    ["different from the event's", "2"],
  ])(
    "ignores the event when STRAVA_WEBHOOK_SUBSCRIPTION_ID is %s",
    async (_label, subscriptionId) => {
      const fetchSpy = mockStrava({});

      const { response, waitUntil } = await postWith(deauthorization(), {
        ...testEnv,
        STRAVA_WEBHOOK_SUBSCRIPTION_ID: subscriptionId,
      });

      expect(response.status).toBe(200);
      expect(waitUntil).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await count("oauth_tokens", 1)).toBe(1);
    },
  );

  it("ignores an event without subscription_id", async () => {
    const { waitUntil } = await postWith({
      ...deauthorization(),
      subscription_id: undefined,
    });

    expect(waitUntil).not.toHaveBeenCalled();
    expect(await count("oauth_tokens", 1)).toBe(1);
  });

  it("still validates the subscription (GET) without a subscription id", async () => {
    const query = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.challenge": "abc",
      "hub.verify_token": VERIFY_TOKEN,
    });
    const response = await app.request(
      `/api/strava/webhook?${query}`,
      {},
      { ...testEnv, STRAVA_WEBHOOK_SUBSCRIPTION_ID: undefined },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ "hub.challenge": "abc" });
  });

  it("does not schedule work for another athlete's event", async () => {
    const { waitUntil } = await postWith(activityEvent("create", 12, 43));

    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("schedules the processing with waitUntil for an owner event", async () => {
    mockStrava({ "/api/v3/activities/12": () => Response.json(run(12)) });

    const { waitUntil } = await postWith(activityEvent("create", 12));

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("answers 200 with an empty body even when the deferred processing fails", async () => {
    mockStrava({
      "/api/v3/activities/12": () => new Response("{}", { status: 503 }),
    });

    const { response, done } = await post(activityEvent("create", 12));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await expect(done()).rejects.toThrow();
  });

  it("ignores a body whose declared length exceeds 4 KiB", async () => {
    const fetchSpy = mockStrava({});
    const body = JSON.stringify(activityEvent("delete", 10));

    const { waitUntil } = await postRaw(body, { "Content-Length": "4097" });

    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("accepts a valid event padded up to exactly 4 KiB", async () => {
    mockStrava({});
    const event = JSON.stringify(activityEvent("delete", 10));
    const body = event.replace(
      "{",
      `{"pad":"${"x".repeat(4096 - event.length - 9)}",`,
    );
    expect(body.length).toBe(4096);

    const { waitUntil } = await postRaw(body);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  // Événement valide (delete de l'activité 10) complété par `pad` jusqu'à la taille voulue.
  const paddedEvent = (pad: string) =>
    JSON.stringify({ pad, ...activityEvent("delete", 10) });

  function streamOf(text: string, chunkSize = 512) {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
  }

  it("ignores a chunked body over 4 KiB sent without Content-Length", async () => {
    const fetchSpy = mockStrava({});
    const body = paddedEvent("x".repeat(5000));

    const { response, waitUntil } = await postRaw(streamOf(body));

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("stops reading an endless chunked body", async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });

    const { response, waitUntil } = await postRaw(endless);

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(pulls).toBeLessThan(10);
  });

  it("processes a valid chunked body under 4 KiB", async () => {
    mockStrava({});

    const { waitUntil } = await postRaw(
      streamOf(paddedEvent("x".repeat(1000))),
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  it("counts bytes, not characters, for multi-byte bodies", async () => {
    const fetchSpy = mockStrava({});
    const body = paddedEvent("é".repeat(2100));
    expect(body.length).toBeLessThan(4096);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(4096);

    const { waitUntil } = await postRaw(streamOf(body));

    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a multi-byte body under 4 KiB", async () => {
    mockStrava({});

    const { waitUntil } = await postRaw(paddedEvent("é".repeat(1000)));

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("ignores an empty body", async () => {
    const { response, waitUntil } = await postRaw("");

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("POST /api/strava/webhook (activity edge cases)", () => {
  it("does nothing on delete of an unknown activity", async () => {
    mockStrava({});

    const response = await deliver(activityEvent("delete", 999));

    expect(response.status).toBe(200);
    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("stores nothing on create when Strava answers 404", async () => {
    mockStrava({});

    await deliver(activityEvent("create", 12));

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("does not store a ride on create", async () => {
    mockStrava({
      "/api/v3/activities/12": () =>
        Response.json(run(12, { sport_type: "Ride", type: "Ride" })),
    });

    await deliver(activityEvent("create", 12));

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("keeps stored data when Strava returns a body for another activity id", async () => {
    mockStrava({ "/api/v3/activities/10": () => Response.json(run(77)) });

    await expect(deliver(activityEvent("update", 10))).rejects.toThrow();

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("keeps stored data when Strava returns invalid JSON on update", async () => {
    mockStrava({ "/api/v3/activities/10": () => new Response("<html>") });

    await expect(deliver(activityEvent("update", 10))).rejects.toThrow();

    expect((await activities()).map((a) => a.id)).toEqual([10, 11, 20]);
  });

  it("deletes the activity on delete when Strava answers 5xx", async () => {
    mockStrava({
      "/api/v3/activities/10": () => new Response("{}", { status: 502 }),
    });

    await deliver(activityEvent("delete", 10));

    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  it("deletes the activity on delete when Strava still serves it as a ride", async () => {
    mockStrava({
      "/api/v3/activities/10": () =>
        Response.json(run(10, { sport_type: "Ride", type: "Ride" })),
    });

    await deliver(activityEvent("delete", 10));

    expect((await activities()).map((a) => a.id)).toEqual([11, 20]);
  });

  it("never overwrites another user's activity with the same id", async () => {
    mockStrava({ "/api/v3/activities/20": () => Response.json(run(20)) });

    await deliver(activityEvent("update", 20));

    const stored = (await activities()).find((a) => a.id === 20);
    expect(stored?.user_id).toBe(2);
    expect(stored?.payload).toBe("{}");
  });

  it("does not delete another user's activity with the same id", async () => {
    mockStrava({});

    await deliver(activityEvent("delete", 20));

    expect(await count("strava_activities", 2)).toBe(1);
  });

  it("refreshes an expired token before fetching the activity", async () => {
    await env.DB.prepare(
      "UPDATE oauth_tokens SET expires_at = 0 WHERE user_id = 1",
    ).run();
    const fetchSpy = mockStrava({
      "/oauth/token": () =>
        Response.json({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_at: 9999999999,
        }),
      "/api/v3/activities/12": () => Response.json(run(12)),
    });

    await deliver(activityEvent("create", 12));

    const [, init] = fetchSpy.mock.calls[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer fresh-access",
    );
    const token = await env.DB.prepare(
      "SELECT access_token FROM oauth_tokens WHERE user_id = 1",
    ).first<{ access_token: string }>();
    expect(token?.access_token).toBe("fresh-access");
    expect((await activities()).map((a) => a.id)).toContain(12);
  });

  it("deletes tokens and activities when the token refresh is refused on update", async () => {
    await env.DB.prepare(
      "UPDATE oauth_tokens SET expires_at = 0 WHERE user_id = 1",
    ).run();
    mockStrava({
      "/oauth/token": () => new Response("{}", { status: 400 }),
    });

    await deliver(activityEvent("update", 10));

    expect(await count("oauth_tokens", 1)).toBe(0);
    expect((await activities()).map((a) => a.id)).toEqual([20]);
  });

  it("deletes tokens and activities when the API answers 401 on create", async () => {
    mockStrava({
      "/api/v3/activities/12": () => new Response("{}", { status: 401 }),
    });

    await deliver(activityEvent("create", 12));

    expect(await count("oauth_tokens", 1)).toBe(0);
    expect((await activities()).map((a) => a.id)).toEqual([20]);
  });

  it("does nothing when the owner has not connected yet", async () => {
    await env.DB.prepare(
      "DELETE FROM strava_activities WHERE user_id = 1",
    ).run();
    await env.DB.prepare("DELETE FROM oauth_tokens WHERE user_id = 1").run();
    await env.DB.prepare("DELETE FROM imported_activities").run();
    await env.DB.prepare("DELETE FROM plans").run();
    await env.DB.prepare("DELETE FROM goals").run();
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    const fetchSpy = mockStrava({});

    const response = await deliver(activityEvent("create", 12));

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/strava/webhook (deauthorization edge cases)", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO plan_sessions (plan_id, scheduled_date, kind) VALUES (1, '2026-11-03', 'endurance')",
    ).run();
  });

  const revoked = () => mockStrava({});

  it("keeps the user row, goal, plan, plan sessions and imported history", async () => {
    revoked();

    await deliver(deauthorization());

    const user = await env.DB.prepare(
      "SELECT strava_athlete_id FROM users WHERE id = 1",
    ).first<{ strava_athlete_id: number }>();
    expect(user?.strava_athlete_id).toBe(OWNER);
    expect(await count("goals", 1)).toBe(1);
    expect(await count("imported_activities", 1)).toBe(1);
    const sessions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plan_sessions",
    ).first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it("accepts authorized sent as the boolean false", async () => {
    revoked();

    await deliver({ ...deauthorization(), updates: { authorized: false } });

    expect(await count("oauth_tokens", 1)).toBe(0);
    expect(await count("strava_activities", 1)).toBe(0);
  });

  it("deletes the activities even when the tokens are already gone", async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens WHERE user_id = 1").run();
    const fetchSpy = mockStrava({});

    await deliver(deauthorization());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("strava_activities", 1)).toBe(0);
  });

  it("leaves the other user untouched", async () => {
    revoked();

    await deliver(deauthorization());

    expect(await count("oauth_tokens", 2)).toBe(1);
    expect(await count("strava_activities", 2)).toBe(1);
  });
});
