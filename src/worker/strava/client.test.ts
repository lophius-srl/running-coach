import { applyD1Migrations, env } from "cloudflare:test";
import { resetDatabase } from "../test-db";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  exchangeCode,
  getValidAccessToken,
  stravaApiFetch,
  StravaError,
} from "./client";

const credentials = { STRAVA_CLIENT_ID: "id", STRAVA_CLIENT_SECRET: "secret" };
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(() => resetDatabase(env.DB));

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42)",
  ).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function storeTokens(expiresAt: number) {
  return env.DB.prepare(
    "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope) VALUES (1, 'old-access', 'old-refresh', ?, 'read')",
  )
    .bind(expiresAt)
    .run();
}

function storedTokens() {
  return env.DB.prepare(
    "SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE user_id = 1",
  ).first();
}

function mockRefresh() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: NOW_S + 21_600,
    }),
  );
}

describe("getValidAccessToken", () => {
  it("returns the stored token while it is still valid", async () => {
    await storeTokens(NOW_S + 3600);
    const fetchSpy = mockRefresh();

    expect(await getValidAccessToken(env.DB, credentials, 1, NOW_MS)).toBe(
      "old-access",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", NOW_S - 10],
    ["about to expire", NOW_S + 60],
  ])("refreshes and persists an %s token", async (_label, expiresAt) => {
    await storeTokens(expiresAt);
    const fetchSpy = mockRefresh();

    expect(await getValidAccessToken(env.DB, credentials, 1, NOW_MS)).toBe(
      "new-access",
    );

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://www.strava.com/oauth/token");
    const body = new URLSearchParams(init?.body as URLSearchParams);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(body.get("client_secret")).toBe("secret");
    expect(await storedTokens()).toEqual({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: NOW_S + 21_600,
    });
  });

  it("keeps the stored tokens when Strava refuses the refresh", async () => {
    await storeTokens(NOW_S - 10);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 401 }),
    );

    await expect(
      getValidAccessToken(env.DB, credentials, 1, NOW_MS),
    ).rejects.toBeInstanceOf(StravaError);
    expect(await storedTokens()).toMatchObject({ access_token: "old-access" });
  });

  it("fails when the user has no tokens", async () => {
    await expect(
      getValidAccessToken(env.DB, credentials, 1, NOW_MS),
    ).rejects.toBeInstanceOf(StravaError);
  });
});

describe("stravaApiFetch", () => {
  it("calls the API with a bearer token", async () => {
    await storeTokens(Math.floor(Date.now() / 1000) + 3600);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: 42 }));

    await stravaApiFetch(env.DB, credentials, 1, "/athlete");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://www.strava.com/api/v3/athlete");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer old-access",
    );
  });
});

describe("token endpoint failures", () => {
  it("turns a non-JSON body into a StravaError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>oops</html>"),
    );

    await expect(exchangeCode(credentials, "code")).rejects.toBeInstanceOf(
      StravaError,
    );
  });

  it("turns a network failure into a StravaError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Network connection lost"),
    );

    await expect(exchangeCode(credentials, "code")).rejects.toBeInstanceOf(
      StravaError,
    );
  });

  it("keeps the stored tokens when the refresh answers invalid JSON", async () => {
    await storeTokens(NOW_S - 10);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json"));

    await expect(
      getValidAccessToken(env.DB, credentials, 1, NOW_MS),
    ).rejects.toBeInstanceOf(StravaError);
    expect(await storedTokens()).toMatchObject({ access_token: "old-access" });
  });
});
