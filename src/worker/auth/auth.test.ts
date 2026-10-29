import { applyD1Migrations, env } from "cloudflare:test";
import { generateSignedCookie } from "hono/cookie";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../index";
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
});
