import { applyD1Migrations, env } from "cloudflare:test";
import { resetDatabase } from "../test-db";
import { generateSignedCookie } from "hono/cookie";
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
import { STRAVA_SCOPE } from "./routes";

const OWNER_ID = 42;
const SESSION_SECRET = "test-session-secret";
const ORIGIN = "https://coach.example";
const testEnv: Bindings = {
  ...env,
  STRAVA_CLIENT_ID: "client-id",
  STRAVA_CLIENT_SECRET: "client-secret",
  SESSION_SECRET,
  OWNER_ATHLETE_ID: String(OWNER_ID),
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

afterEach(() => {
  vi.restoreAllMocks();
});

function request(path: string, init: RequestInit = {}, bindings = testEnv) {
  return app.request(`${ORIGIN}${path}`, init, bindings);
}

function cookiesOf(response: Response): Record<string, string> {
  return Object.fromEntries(
    response.headers.getAll("Set-Cookie").map((header) => {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      return [pair.slice(0, index), pair.slice(index + 1)];
    }),
  );
}

function sessionHeader(response: Response): string | undefined {
  return response.headers
    .getAll("Set-Cookie")
    .find((header) => header.startsWith("__Host-session="));
}

function mockStravaToken(athleteId: number) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://www.strava.com/oauth/token") {
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_at: 2_000_000_000,
        athlete: { id: athleteId },
      });
    }
    return new Response(null, { status: 200 });
  });
}

async function startOAuth(bindings = testEnv) {
  const response = await request("/api/auth/strava", {}, bindings);
  const location = response.headers.get("Location");
  const state = location ? new URL(location).searchParams.get("state") : null;
  return { response, state, stateCookie: cookiesOf(response).oauth_state };
}

function callback(
  state: string | null,
  stateCookie: string | undefined,
  bindings = testEnv,
) {
  const query = new URLSearchParams({ code: "the-code", scope: STRAVA_SCOPE });
  if (state) query.set("state", state);
  const headers: HeadersInit = stateCookie
    ? { Cookie: `oauth_state=${stateCookie}` }
    : {};
  return request(`/api/auth/strava/callback?${query}`, { headers }, bindings);
}

async function login(): Promise<string> {
  mockStravaToken(OWNER_ID);
  const { state, stateCookie } = await startOAuth();
  const response = await callback(state, stateCookie);
  vi.restoreAllMocks();
  return `__Host-session=${cookiesOf(response)["__Host-session"]}`;
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe("GET /api/auth/strava", () => {
  it("redirects to Strava with the minimal scope and a state cookie", async () => {
    const { response, state, stateCookie } = await startOAuth();

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://www.strava.com/oauth/authorize",
    );
    expect(location.searchParams.get("scope")).toBe("read,activity:read_all");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/auth/strava/callback`,
    );
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(stateCookie).toBe(state);
    const header = response.headers.getAll("Set-Cookie")[0];
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Max-Age=600/);
  });

  it.each([undefined, "", "  ", "abc"])(
    "refuses to start when OWNER_ATHLETE_ID is %j",
    async (owner) => {
      const { response } = await startOAuth({
        ...testEnv,
        OWNER_ATHLETE_ID: owner,
      });
      expect(response.status).toBe(403);
    },
  );
});

describe("GET /api/auth/strava/callback", () => {
  it("stores the tokens and opens a session for the owner", async () => {
    mockStravaToken(OWNER_ID);
    const { state, stateCookie } = await startOAuth();

    const response = await callback(state, stateCookie);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    const tokens = await env.DB.prepare(
      "SELECT u.strava_athlete_id, t.access_token, t.refresh_token, t.expires_at, t.scope FROM oauth_tokens t JOIN users u ON u.id = t.user_id",
    ).all();
    expect(tokens.results).toEqual([
      {
        strava_athlete_id: OWNER_ID,
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_at: 2_000_000_000,
        scope: STRAVA_SCOPE,
      },
    ]);
    const session = sessionHeader(response);
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Max-Age=604800/);
  });

  it("updates the tokens on a second login", async () => {
    await login();
    await login();
    expect(await count("users")).toBe(1);
    expect(await count("oauth_tokens")).toBe(1);
  });

  it.each([
    ["absent state", null, "expected"],
    ["absent state cookie", "expected", undefined],
    ["mismatching state", "forged", "expected"],
  ])("rejects an %s without calling Strava", async (_label, state, cookie) => {
    const fetchSpy = mockStravaToken(OWNER_ID);

    const response = await callback(state, cookie);

    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("users")).toBe(0);
  });

  it("refuses another athlete with 403 and stores nothing", async () => {
    const fetchSpy = mockStravaToken(999);
    const { state, stateCookie } = await startOAuth();

    const response = await callback(state, stateCookie);

    expect(response.status).toBe(403);
    expect(sessionHeader(response)).toBeUndefined();
    expect(await count("users")).toBe(0);
    expect(await count("oauth_tokens")).toBe(0);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.strava.com/oauth/deauthorize",
      expect.anything(),
    );
  });

  it("refuses everyone when OWNER_ATHLETE_ID is missing", async () => {
    const fetchSpy = mockStravaToken(OWNER_ID);
    const bindings = { ...testEnv, OWNER_ATHLETE_ID: undefined };

    const response = await callback("s", "s", bindings);

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("users")).toBe(0);
  });
});

describe("session guard on /api/*", () => {
  it("returns 401 without session", async () => {
    const response = await request("/api/me");
    expect(response.status).toBe(401);
  });

  it("returns the athlete id with a valid session", async () => {
    const cookie = await login();

    const response = await request("/api/me", { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ athleteId: OWNER_ID });
  });

  it("returns 401 with a tampered cookie", async () => {
    const cookie = await login();
    const value = cookie.slice("__Host-session=".length);
    const tampered = `__Host-session=9${value.slice(1)}`;

    const response = await request("/api/me", {
      headers: { Cookie: tampered },
    });

    expect(response.status).toBe(401);
  });

  it.each([
    ["valid (control)", "1.9999999999", SESSION_SECRET, 200],
    ["signed with another secret", "1.9999999999", "another-secret", 401],
    ["expired", "1.1000000000", SESSION_SECRET, 401],
  ])("answers a cookie %s", async (_label, value, secret, status) => {
    await login();
    const forged = await generateSignedCookie("session", value, secret, {
      prefix: "host",
      secure: true,
      path: "/",
    });

    const response = await request("/api/me", {
      headers: { Cookie: forged.split(";")[0] },
    });

    expect(response.status).toBe(status);
  });

  it("leaves /health and the webhook path public", async () => {
    expect((await request("/health")).status).toBe(200);
    expect((await request("/api/strava/webhook")).status).not.toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie and keeps the tokens", async () => {
    const cookie = await login();

    const response = await request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(204);
    expect(sessionHeader(response)).toMatch(/Max-Age=0/);
    expect(await count("oauth_tokens")).toBe(1);
  });

  it("expires the session cookie with the attributes it was set with", async () => {
    const cookie = await login();

    const response = await request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    const header = sessionHeader(response);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/HttpOnly/);
  });

  it("is not reachable with GET", async () => {
    const response = await request("/api/auth/logout");
    expect(response.status).toBe(404);
  });
});

function mockTokenEndpoint(reply: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://www.strava.com/oauth/token") return reply();
    return new Response(null, { status: 200 });
  });
}

function tokenBody(athlete: unknown) {
  return Response.json({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: 2_000_000_000,
    athlete,
  });
}

function callbackWithQuery(params: Record<string, string>, stateCookie = "") {
  return request(`/api/auth/strava/callback?${new URLSearchParams(params)}`, {
    headers: { Cookie: `oauth_state=${stateCookie}` },
  });
}

async function expectNothingStored(response: Response) {
  expect(sessionHeader(response)).toBeUndefined();
  expect(await count("users")).toBe(0);
  expect(await count("oauth_tokens")).toBe(0);
}

describe("callback edge cases", () => {
  it("redirects home without calling Strava when the user denies access", async () => {
    const fetchSpy = mockStravaToken(OWNER_ID);
    const { state, stateCookie } = await startOAuth();

    const response = await callbackWithQuery(
      { state: state ?? "", error: "access_denied" },
      stateCookie,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectNothingStored(response);
  });

  it("rejects a callback without code with 400", async () => {
    const fetchSpy = mockStravaToken(OWNER_ID);
    const { state, stateCookie } = await startOAuth();

    const response = await callbackWithQuery(
      { state: state ?? "", scope: STRAVA_SCOPE },
      stateCookie,
    );

    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectNothingStored(response);
  });

  it("expires the state cookie after a successful login", async () => {
    mockStravaToken(OWNER_ID);
    const { state, stateCookie } = await startOAuth();

    const response = await callback(state, stateCookie);

    const stateHeader = response.headers
      .getAll("Set-Cookie")
      .find((header) => header.startsWith("oauth_state="));
    expect(stateHeader).toMatch(/Max-Age=0/);
    expect(stateHeader).toMatch(/Path=\/api\/auth\/strava\/callback/);
  });

  it("expires the state cookie even when the state is rejected", async () => {
    const response = await callback("forged", "expected");

    expect(response.status).toBe(400);
    expect(cookiesOf(response).oauth_state).toBe("");
  });

  it.each([
    ["a 4xx", () => new Response('{"message":"Bad"}', { status: 400 })],
    ["a 5xx", () => new Response("Unavailable", { status: 503 })],
    ["invalid JSON", () => new Response("<html>oops</html>")],
    ["a body without tokens", () => Response.json({ athlete: { id: 42 } })],
    ["a body without athlete", () => tokenBody(undefined)],
    ["an athlete id as a string", () => tokenBody({ id: String(OWNER_ID) })],
  ])(
    "answers 502 and stores nothing when Strava returns %s",
    async (_label, reply) => {
      mockTokenEndpoint(reply);
      const { state, stateCookie } = await startOAuth();

      const response = await callback(state, stateCookie);

      expect(response.status).toBe(502);
      await expectNothingStored(response);
    },
  );

  it("answers 502 and stores nothing when Strava is unreachable", async () => {
    mockTokenEndpoint(() => {
      throw new TypeError("Network connection lost");
    });
    const { state, stateCookie } = await startOAuth();

    const response = await callback(state, stateCookie);

    expect(response.status).toBe(502);
    await expectNothingStored(response);
  });

  it("accepts the owner when OWNER_ATHLETE_ID has surrounding spaces", async () => {
    mockStravaToken(OWNER_ID);
    const bindings = { ...testEnv, OWNER_ATHLETE_ID: ` ${OWNER_ID} ` };
    const { state, stateCookie } = await startOAuth(bindings);

    const response = await callback(state, stateCookie, bindings);

    expect(response.status).toBe(302);
    expect(sessionHeader(response)).toBeDefined();
  });

  it("refuses an athlete whose id only starts like the owner's", async () => {
    mockStravaToken(Number(`${OWNER_ID}0`));
    const { state, stateCookie } = await startOAuth();

    const response = await callback(state, stateCookie);

    expect(response.status).toBe(403);
    await expectNothingStored(response);
  });

  it("still answers 403 when the deauthorization call fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://www.strava.com/oauth/token") {
        return tokenBody({ id: 999 });
      }
      throw new TypeError("Network connection lost");
    });
    const { state, stateCookie } = await startOAuth();

    const response = await callback(state, stateCookie);

    expect(response.status).toBe(403);
    await expectNothingStored(response);
  });
});

describe("token confidentiality", () => {
  it("never exposes Strava tokens in responses or logs", async () => {
    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const fetchSpy = mockStravaToken(OWNER_ID);
    const { state, stateCookie } = await startOAuth();
    const loginResponse = await callback(state, stateCookie);
    fetchSpy.mockRestore();
    const session = cookiesOf(loginResponse)["__Host-session"];
    const meResponse = await request("/api/me", {
      headers: { Cookie: `__Host-session=${session}` },
    });

    for (const response of [loginResponse, meResponse]) {
      const dump = `${[...response.headers].join("\n")}\n${await response.text()}`;
      expect(dump).not.toMatch(/access-1|refresh-1/);
    }
    const logged = logSpies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    expect(logged).not.toMatch(/access-1|refresh-1/);
  });
});

describe("session guard bypass attempts", () => {
  it.each([
    "/api/me?x",
    "/api/me/",
    "/api/auth/../me",
    "/api/auth/%2e%2e/me",
    "/api/strava/webhook/../../me",
    "/api/auth",
    "/api/authx",
    "/api/authx/me",
    "/api/strava/webhooks",
    "/api/strava/webhook-admin",
    "/api/strava/webhookx/me",
  ])("answers 401 without session on %s", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(401);
  });

  it("does not serve /api/me under another letter case", async () => {
    const response = await request("/API/me");
    expect(response.status).toBe(404);
  });

  it("answers 401 for a valid session whose user no longer exists", async () => {
    const cookie = await login();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();

    const response = await request("/api/me", { headers: { Cookie: cookie } });

    expect(response.status).toBe(401);
  });

  it("answers 401 when SESSION_SECRET is not configured", async () => {
    const cookie = await login();

    const response = await request(
      "/api/me",
      { headers: { Cookie: cookie } },
      { ...testEnv, SESSION_SECRET: "" },
    );

    expect(response.status).toBe(401);
  });

  it.each([
    ["a non-numeric user id", "abc.9999999999"],
    ["a missing expiration", "1"],
    ["a negative user id", "-1.9999999999"],
  ])(
    "answers 401 for a correctly signed cookie with %s",
    async (_label, value) => {
      const forged = await generateSignedCookie(
        "session",
        value,
        SESSION_SECRET,
        { prefix: "host", secure: true, path: "/" },
      );

      const response = await request("/api/me", {
        headers: { Cookie: forged.split(";")[0] },
      });

      expect(response.status).toBe(401);
    },
  );

  it("ignores a session cookie without the __Host- prefix", async () => {
    const cookie = await login();

    const response = await request("/api/me", {
      headers: { Cookie: cookie.replace("__Host-session", "session") },
    });

    expect(response.status).toBe(401);
  });
});
