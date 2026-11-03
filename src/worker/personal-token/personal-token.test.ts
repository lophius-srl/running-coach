import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSignedCookie } from "hono/cookie";
import { app } from "../index";
import type { Bindings } from "../env";
import { resetDatabase } from "../test-db";
import type { GeneratedPersonalToken, PersonalTokenStatus } from "./types";
import { generateToken, isWellFormedToken, tokenSha256 } from "./token";
import { userIdForBearer } from "./verify";

const testEnv: Bindings = { ...env, SESSION_SECRET: "session-secret" };
const URL = "https://coach.example/api/personal-token";

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

async function call(method: string, userId: number | null) {
  const headers: Record<string, string> = {};
  if (userId !== null) headers.Cookie = await cookie(userId);
  return app.request(URL, { method, headers }, testEnv);
}

async function generate(userId: number): Promise<GeneratedPersonalToken> {
  const response = await call("POST", userId);
  expect(response.status).toBe(201);
  return response.json();
}

async function status(userId: number): Promise<PersonalTokenStatus> {
  return (await call("GET", userId)).json();
}

async function storedRows() {
  const { results } = await env.DB.prepare(
    "SELECT user_id, token_sha256, last_used_at FROM personal_tokens ORDER BY user_id",
  ).all<{
    user_id: number;
    token_sha256: string;
    last_used_at: string | null;
  }>();
  return results;
}

describe("token helpers", () => {
  it("generate rc_ + 32 random bytes in base64url", () => {
    const token = generateToken();
    expect(token).toMatch(/^rc_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(token)).toBe(true);
    expect(generateToken()).not.toBe(token);
  });

  it("hash with SHA-256 in hex", async () => {
    // Vecteur de test connu : SHA-256("abc").
    expect(await tokenSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("/api/personal-token", () => {
  it("requires a session", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      expect((await call(method, null)).status).toBe(401);
    }
  });

  it("reports no token before any generation", async () => {
    expect(await status(1)).toEqual({
      exists: false,
      createdAt: null,
      lastUsedAt: null,
    });
  });

  it("returns the token once and stores only its SHA-256", async () => {
    const response = await call("POST", 1);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { token, createdAt } =
      (await response.json()) as GeneratedPersonalToken;

    expect(isWellFormedToken(token)).toBe(true);
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const rows = await storedRows();
    expect(rows).toEqual([
      {
        user_id: 1,
        token_sha256: await tokenSha256(token),
        last_used_at: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("exposes only the dates afterwards, never the token", async () => {
    const { token, createdAt } = await generate(1);
    const response = await call("GET", 1);
    const text = await response.text();

    expect(JSON.parse(text)).toEqual({
      exists: true,
      createdAt,
      lastUsedAt: null,
    });
    expect(text).not.toContain(token);
    expect(text).not.toContain(await tokenSha256(token));
  });

  it("replaces the previous token when regenerating", async () => {
    const first = await generate(1);
    await userIdForBearer(env.DB, `Bearer ${first.token}`);
    const second = await generate(1);

    expect(second.token).not.toBe(first.token);
    expect(await userIdForBearer(env.DB, `Bearer ${first.token}`)).toBeNull();
    expect(await storedRows()).toEqual([
      {
        user_id: 1,
        token_sha256: await tokenSha256(second.token),
        last_used_at: null,
      },
    ]);
  });

  it("revokes the token with DELETE", async () => {
    const { token } = await generate(1);

    const response = await call("DELETE", 1);

    expect(response.status).toBe(204);
    expect(await userIdForBearer(env.DB, `Bearer ${token}`)).toBeNull();
    expect((await status(1)).exists).toBe(false);
  });

  it("only touches the session user's token", async () => {
    await generate(1);
    const other = await generate(2);

    await call("DELETE", 1);

    expect(await userIdForBearer(env.DB, `Bearer ${other.token}`)).toBe(2);
  });

  it("is not an authentication method for the rest of the API", async () => {
    const { token } = await generate(1);
    const response = await app.request(
      "https://coach.example/api/me",
      { headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    );
    expect(response.status).toBe(401);
  });
});

describe("userIdForBearer", () => {
  it("returns the owner of a valid token and records its use", async () => {
    const { token } = await generate(1);

    expect(await userIdForBearer(env.DB, `Bearer ${token}`)).toBe(1);
    const { lastUsedAt } = await status(1);
    expect(lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("tells each user's token apart", async () => {
    const one = await generate(1);
    const two = await generate(2);

    expect(await userIdForBearer(env.DB, `Bearer ${one.token}`)).toBe(1);
    expect(await userIdForBearer(env.DB, `Bearer ${two.token}`)).toBe(2);
    expect((await status(1)).lastUsedAt).not.toBeNull();
  });

  it("refuses a revoked token", async () => {
    const { token } = await generate(1);
    await call("DELETE", 1);
    expect(await userIdForBearer(env.DB, `Bearer ${token}`)).toBeNull();
  });

  it("refuses a well-formed but unknown token", async () => {
    await generate(1);
    expect(
      await userIdForBearer(env.DB, `Bearer ${generateToken()}`),
    ).toBeNull();
    expect((await status(1)).lastUsedAt).toBeNull();
  });

  it("refuses a token sent in clear instead of its hash lookup", async () => {
    // Une empreinte stockée présentée comme jeton ne doit rien ouvrir.
    const { token } = await generate(1);
    const hash = await tokenSha256(token);
    expect(await userIdForBearer(env.DB, `Bearer ${hash}`)).toBeNull();
  });

  it("accepts the scheme in any case", async () => {
    const { token } = await generate(1);
    expect(await userIdForBearer(env.DB, `bearer ${token}`)).toBe(1);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["no Bearer scheme", "TOKEN"],
    ["another scheme", "Basic TOKEN"],
    ["a missing prefix", "Bearer TOKEN_WITHOUT_PREFIX"],
    ["a wrong length", "Bearer TOKEN_TRUNCATED"],
    ["invalid characters", "Bearer TOKEN_PLUS"],
    ["trailing data", "Bearer TOKEN extra"],
  ])("refuses %s", async (_label, template) => {
    const { token } = await generate(1);
    const header = template
      ?.replace("TOKEN_WITHOUT_PREFIX", token.slice(3))
      .replace("TOKEN_TRUNCATED", token.slice(0, -1))
      .replace("TOKEN_PLUS", `${token.slice(0, -1)}+`)
      .replace("TOKEN", token);

    expect(await userIdForBearer(env.DB, header)).toBeNull();
    expect((await status(1)).lastUsedAt).toBeNull();
  });
});
