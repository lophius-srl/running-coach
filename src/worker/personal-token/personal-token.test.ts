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

  it("refuses the stored hash presented as a token", async () => {
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

describe("POST /api/personal-token for a deleted user", () => {
  it("answers 401 and stores nothing when the session user no longer exists", async () => {
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    const response = await call("POST", 1);
    expect(response.status).toBe(401);
    expect(await storedRows()).toEqual([]);
  });
});

describe("token format (QA #66)", () => {
  function decodeBase64Url(body: string): Uint8Array {
    const base64 = body.replace(/-/g, "+").replace(/_/g, "/") + "=";
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  }

  it("encode exactly 32 bytes after rc_, without padding", () => {
    for (let i = 0; i < 200; i++) {
      const token = generateToken();
      expect(token).not.toContain("=");
      expect(decodeBase64Url(token.slice(3))).toHaveLength(32);
    }
  });

  it("never repeat a token over many generations", () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));
    expect(tokens.size).toBe(1000);
  });

  it("use the whole base64url alphabet, - and _ included", () => {
    const chars = new Set(
      Array.from({ length: 500 }, () => generateToken().slice(3)).join(""),
    );
    expect(chars.has("-")).toBe(true);
    expect(chars.has("_")).toBe(true);
    expect(chars.has("+")).toBe(false);
    expect(chars.has("/")).toBe(false);
  });
});

describe("/api/personal-token edge cases (QA #66)", () => {
  it("send the new token with no-store and a JSON body", async () => {
    const response = await call("POST", 1);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
  });

  it("refuse the first token after two successive generations", async () => {
    const first = await generate(1);
    const second = await generate(1);
    expect(await userIdForBearer(env.DB, `Bearer ${first.token}`)).toBeNull();
    expect(await userIdForBearer(env.DB, `Bearer ${second.token}`)).toBe(1);
  });

  it("reset last_used_at and created_at when regenerating", async () => {
    const first = await generate(1);
    await env.DB.prepare(
      "UPDATE personal_tokens SET created_at = '2020-01-01T00:00:00.000Z', last_used_at = '2020-01-02T00:00:00.000Z'",
    ).run();
    const second = await generate(1);
    expect(second.createdAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(await status(1)).toEqual({
      exists: true,
      createdAt: second.createdAt,
      lastUsedAt: null,
    });
    expect(first.token).not.toBe(second.token);
  });

  it("do not record a use when the status is read", async () => {
    await generate(1);
    await call("GET", 1);
    await call("GET", 1);
    expect((await status(1)).lastUsedAt).toBeNull();
  });

  it("answer 204 to DELETE when there is no token", async () => {
    expect((await call("DELETE", 1)).status).toBe(204);
    expect((await status(1)).exists).toBe(false);
  });

  it("do not let a user read another user's token dates", async () => {
    await generate(2);
    expect(await status(1)).toEqual({
      exists: false,
      createdAt: null,
      lastUsedAt: null,
    });
  });

  it("do not let a user's POST replace another user's token", async () => {
    const other = await generate(2);
    await generate(1);
    expect(await userIdForBearer(env.DB, `Bearer ${other.token}`)).toBe(2);
  });

  it("refuse a bearer token on the token routes themselves", async () => {
    const { token } = await generate(1);
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await app.request(
        URL,
        { method, headers: { Authorization: `Bearer ${token}` } },
        testEnv,
      );
      expect(response.status).toBe(401);
    }
    expect(await userIdForBearer(env.DB, `Bearer ${token}`)).toBe(1);
  });

  it("delete the token with its user", async () => {
    const { token } = await generate(1);
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    expect(await storedRows()).toEqual([]);
    expect(await userIdForBearer(env.DB, `Bearer ${token}`)).toBeNull();
  });
});

describe("userIdForBearer header parsing (QA #66)", () => {
  it("accept several spaces between the scheme and the token", async () => {
    const { token } = await generate(1);
    expect(await userIdForBearer(env.DB, `Bearer    ${token}`)).toBe(1);
  });

  it("accept an upper-case scheme", async () => {
    const { token } = await generate(1);
    expect(await userIdForBearer(env.DB, `BEARER ${token}`)).toBe(1);
  });

  it.each([
    ["a suffix glued to the token", (t: string) => `Bearer ${t}x`],
    ["a tab instead of a space", (t: string) => `Bearer\t${t}`],
    ["no space after the scheme", (t: string) => `Bearer${t}`],
    ["the scheme repeated", (t: string) => `Bearer Bearer ${t}`],
    ["two tokens", (t: string) => `Bearer ${t},${t}`],
    ["a very long header", (t: string) => `Bearer ${t}${"A".repeat(100_000)}`],
    ["the token alone", (t: string) => t],
  ])("refuse %s", async (_label, build) => {
    const { token } = await generate(1);
    expect(await userIdForBearer(env.DB, build(token))).toBeNull();
    expect((await status(1)).lastUsedAt).toBeNull();
  });

  it("refuse a token whose case differs", async () => {
    const { token } = await generate(1);
    const swapped = `rc_${[...token.slice(3)]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("")}`;
    expect(await userIdForBearer(env.DB, `Bearer ${swapped}`)).toBeNull();
  });
});
